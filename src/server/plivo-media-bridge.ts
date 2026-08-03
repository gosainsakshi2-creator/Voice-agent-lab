/**
 * plivo-media-bridge.ts
 *
 * The transport glue between a raw Plivo Media Stream WebSocket
 * connection and the existing, unmodified `DefaultVoiceSessionManager`.
 * Everything this file does was already anticipated by Phase 1's
 * three extra (non-interface) public methods:
 *
 *   pushInboundAudio(sessionId, chunk)         <- inbound audio in
 *   onOutboundAudio(sessionId, listener)       -> outbound audio out
 *   signalBargeIn(sessionId)                   -> fast transport-side barge-in
 *
 * No orchestration, turn-detection, interruption, or conversation
 * logic lives here — this module only moves bytes between Plivo's
 * WebSocket JSON protocol and the shapes the VoiceSessionManager
 * already understands (`AudioPayload`).
 *
 * Plivo Media Stream JSON protocol (documented, vendor-fixed):
 *   inbound:  {"event":"start", start:{mediaFormat:{...}}}
 *             {"event":"media", media:{track, payload: base64 mu-law}}
 *             {"event":"dtmf", dtmf:{digit}}
 *             {"event":"stop"}
 *   outbound: {"event":"playAudio", media:{contentType, sampleRate, payload}}
 *             {"event":"clearAudio"}   <- stops in-flight playback (barge-in)
 */

import type { SessionId } from "../types/session.types";
import type { AudioPayload } from "../types/provider.types";
import { SessionState } from "../types/enums";
import type { DefaultVoiceSessionManager } from "../core/session/voice-session-manager.impl";
import { MulawVadSegmenter } from "./vad-segmenter";
import { pcm16ToMulaw8k } from "./audio-codec";

/** Minimal shape both `ws`'s WebSocket and the DOM WebSocket satisfy, kept narrow for testability. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}

const OPEN_STATE = 1;
const OUTBOUND_FRAME_BYTES = 160; // 20ms @ 8kHz mu-law
const OUTBOUND_FRAME_MS = 20;

export function attachPlivoMediaBridge(
  socket: BridgeSocket,
  sessionId: SessionId,
  manager: DefaultVoiceSessionManager,
): void {
  let unsubscribeOutbound: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let outboundQueue: Uint8Array[] = [];
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let wasSpeaking = false;
  let closed = false;

  const segmenter = new MulawVadSegmenter((mulawBytes) => {
    const payload: AudioPayload = {
      data: mulawBytes,
      encoding: "MULAW",
      sampleRateHz: 8000,
    };
    manager.pushInboundAudio(sessionId, payload);
  });

  function sendJson(obj: unknown): void {
    if (closed || socket.readyState !== OPEN_STATE) return;
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      // Socket dropped mid-send — the close handler below will
      // observe it and clean up; nothing further to do here.
    }
  }

  function enqueueOutbound(chunk: AudioPayload): void {
    // TTS providers emit PCM_16 at their own configured sample
    // rate; Plivo's playAudio channel is fixed at 8kHz mu-law.
    const mulaw8k = pcm16ToMulaw8k(chunk.data, chunk.sampleRateHz);
    for (let offset = 0; offset < mulaw8k.length; offset += OUTBOUND_FRAME_BYTES) {
      outboundQueue.push(mulaw8k.subarray(offset, offset + OUTBOUND_FRAME_BYTES));
    }
    startPump();
  }

  function startPump(): void {
    if (pumpTimer) return;
    const startedAt = Date.now();
    let framesSent = 0;
    pumpTimer = setInterval(() => {
      // Drift correction: a delayed tick (Node's event loop was busy
      // with something else — an STT/LLM/TTS call, GC, etc.) must
      // not permanently lose real-time pacing. Send however many
      // 20ms frames are actually due by wall-clock time, not just
      // one per tick, so playback catches back up instead of
      // trailing further and further behind.
      const framesDue = Math.floor((Date.now() - startedAt) / OUTBOUND_FRAME_MS) - framesSent;
      for (let i = 0; i < framesDue; i += 1) {
        const frame = outboundQueue.shift();
        if (!frame) {
          clearInterval(pumpTimer);
          pumpTimer = undefined;
          return;
        }
        framesSent += 1;
        sendJson({
          event: "playAudio",
          media: {
            contentType: "audio/x-mulaw",
            sampleRate: 8000,
            payload: Buffer.from(frame).toString("base64"),
          },
        });
      }
    }, OUTBOUND_FRAME_MS);
  }

  function clearOutboundPlayback(): void {
    outboundQueue = [];
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = undefined;
    }
    sendJson({ event: "clearAudio" });
  }

  unsubscribeOutbound = manager.onOutboundAudio(sessionId, enqueueOutbound);

  // Full-duplex barge-in: the moment the pipeline leaves SPEAKING
  // (either a normal turn finish or a barge-in abort) while we still
  // have queued/playing audio on the wire, tell Plivo to drop it
  // immediately rather than let stale audio keep playing.
  unsubscribeState = manager.onStateChange((eventSessionId, transition) => {
    if (eventSessionId !== sessionId) return;
    if (transition.to === SessionState.SPEAKING) {
      wasSpeaking = true;
    } else if (wasSpeaking && transition.to === SessionState.LISTENING) {
      wasSpeaking = false;
      clearOutboundPlayback();
    }
  });

  function handleMessage(raw: string): void {
    let event: { event?: string; media?: { payload?: string; track?: string }; stop?: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.event) {
      case "start":
        // eslint-disable-next-line no-console
        console.log(`[plivo-bridge:${sessionId}] "start" event received -> confirming call answered`);
        manager.confirmCallAnswered(sessionId);
        return;
      case "media": {
        // Plivo's bidirectional stream echoes back our own outbound
        // audio as track:"outbound" in addition to the caller's real
        // speech as track:"inbound". Only the caller's audio belongs
        // in the turn-detection pipeline — feeding our own assistant
        // audio back in here would make the pipeline think the
        // caller said whatever we just spoke.
        if (event.media?.track && event.media.track !== "inbound") return;
        const b64 = event.media?.payload;
        if (!b64) return;
        segmenter.push(new Uint8Array(Buffer.from(b64, "base64")));
        return;
      }
      case "stop":
        // eslint-disable-next-line no-console
        console.log(`[plivo-bridge:${sessionId}] "stop" event received (Plivo ending the stream normally)`);
        cleanup();
        return;
      default:
        return;
    }
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    segmenter.flush();
    unsubscribeOutbound?.();
    unsubscribeState?.();
    if (pumpTimer) clearInterval(pumpTimer);
    // Plivo closes this socket when the call itself ends (including
    // a remote hangup, which has no other webhook telling us the
    // call is over) — make sure the session's state machine (and the
    // Dashboard's SSE subscription to it) finds out. Already-ended
    // sessions no-op safely.
    void manager.end(sessionId).catch(() => undefined);
  }

  // eslint-disable-next-line no-console
  console.log(`[plivo-bridge:${sessionId}] bridge attached, socket.readyState=${socket.readyState}`);

  if (typeof socket.on === "function") {
    socket.on("message", (data: unknown) => handleMessage(String(data)));
    socket.on("close", (...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.log(`[plivo-bridge:${sessionId}] socket "close" event, args=${JSON.stringify(args)}`);
      cleanup();
    });
    socket.on("error", (...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.log(`[plivo-bridge:${sessionId}] socket "error" event, args=${JSON.stringify(args)}`);
      cleanup();
    });
  } else if (typeof socket.addEventListener === "function") {
    socket.addEventListener("message", (evt: unknown) => {
      const data = (evt as { data?: unknown }).data;
      handleMessage(String(data));
    });
    socket.addEventListener("close", () => {
      // eslint-disable-next-line no-console
      console.log(`[plivo-bridge:${sessionId}] socket "close" event (addEventListener path)`);
      cleanup();
    });
    socket.addEventListener("error", () => {
      // eslint-disable-next-line no-console
      console.log(`[plivo-bridge:${sessionId}] socket "error" event (addEventListener path)`);
      cleanup();
    });
  }
}