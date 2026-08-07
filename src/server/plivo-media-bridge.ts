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
 *   inbound:  {"event":"start", start:{streamId, callId, mediaFormat:{...}}}
 *             {"event":"media", media:{track, payload: base64 audio}}
 *             {"event":"dtmf", dtmf:{digit}}
 *             {"event":"stop"}
 *   outbound: {"event":"playAudio", streamId, media:{contentType:"audio/x-mulaw", sampleRate:8000, payload}}
 *             NOTE: contentType here is BARE (no ";rate=" suffix) — the
 *             rate travels in the separate `sampleRate` field. The
 *             ";rate=8000" form is only valid on the <Stream> XML attribute.
 *             {"event":"clearAudio", streamId}  <- stops in-flight playback (barge-in)
 */

import type { SessionId } from "../types/session.types";
import type { AudioPayload } from "../types/provider.types";
import { SessionState } from "../types/enums";
import type { DefaultVoiceSessionManager } from "../core/session/voice-session-manager.impl";
import { MulawVadSegmenter } from "./vad-segmenter";
import { createOutboundMulawEncoder } from "./audio-codec";

/** Minimal shape both `ws`'s WebSocket and the DOM WebSocket satisfy, kept narrow for testability. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}
const MAX_QUEUE_FRAMES = 100;
const OPEN_STATE = 1;
/**
 * Plivo's recommended outbound format for Voice AI is
 * `audio/x-mulaw;rate=8000` (G.711 mu-law). Each sample is 1 byte,
 * so 20 ms of audio = 160 samples × 1 byte = 160 bytes per frame.
 */
const OUTBOUND_FRAME_BYTES = 160; // 20ms @ 8kHz mulaw (8-bit)
const OUTBOUND_FRAME_MS = 20;
/** Maximum frames the pump may send in a single tick to prevent
 *  burst-flooding the WebSocket after event-loop starvation. */
const MAX_FRAMES_PER_TICK = 3;

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
  /** Plivo's stream identifier — required in `clearAudio` events. */
  let plivoStreamId: string | undefined;

  let inboundFrameCount = 0;
  let utteranceCount = 0;

  const segmenter = new MulawVadSegmenter((mulawBytes) => {
    utteranceCount += 1;
    const durationMs = Math.round((mulawBytes.length / 160) * 20);
    // eslint-disable-next-line no-console
    console.log(
      `[plivo-bridge:${sessionId}] VAD utterance #${utteranceCount}: ${mulawBytes.length} bytes (~${durationMs}ms), pushing to manager`,
    );
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

  let outboundChunkCount = 0;
  let outboundFrameTotal = 0;
  // One encoder instance for this call's whole outbound stream — its
  // internal seam-crossfade state only makes sense within a single
  // continuous conversation, never shared across sessions.
  const mulawEncoder = createOutboundMulawEncoder();

  function enqueueOutbound(chunk: AudioPayload): void {
    outboundChunkCount += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[plivo-bridge:${sessionId}] enqueueOutbound #${outboundChunkCount}: encoding=${chunk.encoding} sampleRate=${chunk.sampleRateHz} bytes=${chunk.data.byteLength}`,
    );

    if (chunk.encoding !== "PCM_16") {
      // eslint-disable-next-line no-console
      console.warn(
        `[plivo-bridge:${sessionId}] WARNING: enqueueOutbound received encoding="${chunk.encoding}" but expected PCM_16 — audio may be corrupted`,
      );
    }

    // TTS providers emit PCM_16 at their own configured sample rate.
    // Plivo's recommended outbound format for Voice AI is G.711 mu-law
    // at 8 kHz — the encoder handles resampling + mu-law encoding, and
    // (see audio-codec.ts) smooths the seam against the previous chunk
    // since each streamed TTS chunk is otherwise resampled in isolation.
    const mulawBytes = mulawEncoder.encode(chunk.data, chunk.sampleRateHz);
    const frameCount = Math.ceil(mulawBytes.length / OUTBOUND_FRAME_BYTES);
    outboundFrameTotal += frameCount;
for (
    let offset = 0;
    offset < mulawBytes.length;
    offset += OUTBOUND_FRAME_BYTES
) {

    while (outboundQueue.length >= MAX_QUEUE_FRAMES) {
        outboundQueue.shift();
    }

    outboundQueue.push(
        mulawBytes.subarray(
            offset,
            offset + OUTBOUND_FRAME_BYTES,
        ),
    );
}
    // eslint-disable-next-line no-console
    console.log(
      `[plivo-bridge:${sessionId}] enqueued ${frameCount} frames (${frameCount * OUTBOUND_FRAME_MS}ms), queue depth=${outboundQueue.length}, lifetime frames=${outboundFrameTotal}`,
    );
    startPump();
  }

function startPump(): void {
  if (pumpTimer) return;

  // eslint-disable-next-line no-console
  console.log(`[plivo-bridge:${sessionId}] pump started`);

  let framesSent = 0;

  pumpTimer = setInterval(() => {
    const frame = outboundQueue.shift();

    if (!frame) {
      // eslint-disable-next-line no-console
      console.log(
        `[plivo-bridge:${sessionId}] pump exhausted after ${framesSent} frames (${framesSent * OUTBOUND_FRAME_MS}ms of audio)`
      );

      clearInterval(pumpTimer!);
      pumpTimer = undefined;
      return;
    }

    framesSent++;

    if (framesSent === 1 || framesSent % 50 === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[plivo-bridge:${sessionId}] pump sending frame #${framesSent}, remaining=${outboundQueue.length}`
      );
    }

    sendJson({
      event: "playAudio",
      ...(plivoStreamId ? { streamId: plivoStreamId } : {}),
      media: {
        contentType: "audio/x-mulaw",
        sampleRate: 8000,
        payload: Buffer.from(frame).toString("base64"),
      },
    });
  }, OUTBOUND_FRAME_MS);
}

  function clearOutboundPlayback(): void {
    const droppedFrames = outboundQueue.length;
    outboundQueue = [];
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = undefined;
    }
    // eslint-disable-next-line no-console
    console.log(`[plivo-bridge:${sessionId}] clearOutboundPlayback: dropped ${droppedFrames} queued frames, sending clearAudio (streamId=${plivoStreamId ?? "unknown"})`);
    sendJson({ event: "clearAudio", ...(plivoStreamId ? { streamId: plivoStreamId } : {}) });
  }

  unsubscribeOutbound = manager.onOutboundAudio(sessionId, enqueueOutbound);
  // eslint-disable-next-line no-console
  console.log(`[plivo-bridge:${sessionId}] outbound audio listener registered`);

  // Full-duplex barge-in: when the pipeline leaves SPEAKING because
  // the user interrupted (barge-in), clear the outbound queue AND
  // send Plivo a `clearAudio` so stale assistant audio stops
  // immediately. On a NORMAL turn completion (the assistant finished
  // speaking), do NOT clear — the pump is still draining the last
  // few frames and Plivo still has audio in its playback buffer.
  // Sending `clearAudio` on every SPEAKING → LISTENING transition
  // was silencing the tail of every utterance.
  unsubscribeState = manager.onStateChange((eventSessionId, transition) => {
    if (eventSessionId !== sessionId) return;
    if (transition.to === SessionState.SPEAKING) {
      wasSpeaking = true;
    } else if (wasSpeaking && transition.to === SessionState.LISTENING) {
      wasSpeaking = false;
      // Only clear on barge-in (user interrupted). Normal turn
      // completion uses reasons like "awaiting user speech".
      const isBargeIn = transition.reason != null && /barge.?in/i.test(transition.reason);
      if (isBargeIn) {
        clearOutboundPlayback();
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[plivo-bridge:${sessionId}] SPEAKING->LISTENING (normal completion, reason="${transition.reason}") — letting pump drain naturally, queue=${outboundQueue.length}`,
        );
      }
    }
  });

  function handleMessage(raw: string): void {
    let event: {
      event?: string;
      start?: { streamId?: string };
      media?: { payload?: string; track?: string };
      stop?: unknown;
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.event) {
      case "start":
        plivoStreamId = event.start?.streamId;
        // eslint-disable-next-line no-console
        console.log(`[plivo-bridge:${sessionId}] "start" event received -> streamId=${plivoStreamId ?? "none"}, confirming call answered`);
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
        inboundFrameCount += 1;
        if (inboundFrameCount === 1 || inboundFrameCount % 100 === 0) {
          // eslint-disable-next-line no-console
          console.log(`[plivo-bridge:${sessionId}] inbound media frame #${inboundFrameCount}`);
        }
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