/**
 * vobiz-media-bridge.ts
 *
 * Transport glue between a Vobiz Audio Stream WebSocket connection
 * and the existing, unmodified `DefaultVoiceSessionManager`.
 * Mirrors the role `plivo-media-bridge.ts` fills for Plivo calls —
 * same three manager hooks are used:
 *
 *   pushInboundAudio(sessionId, chunk)         <- inbound audio in
 *   onOutboundAudio(sessionId, listener)       -> outbound audio out
 *   signalBargeIn(sessionId)                   -> fast transport-side barge-in
 *
 * No orchestration, turn-detection, interruption, or conversation
 * logic lives here — this module only moves bytes between Vobiz's
 * WebSocket JSON protocol and the shapes the VoiceSessionManager
 * already understands (`AudioPayload`).
 *
 * ---------------------------------------------------------------
 * KEY PROTOCOL DIFFERENCES FROM PLIVO (per Vobiz docs):
 * ---------------------------------------------------------------
 *
 *   1. `playAudio` carries `streamId` at the top level:
 *        {event:"playAudio", streamId, media:{contentType, sampleRate, payload}}
 *
 *   2. Outbound audio now uses G.711 μ-law at 8 kHz — the same
 *      proven codec the Plivo bridge sends. This avoids endianness
 *      ambiguity (mulaw is single-byte) and server-side transcoding
 *      (8 kHz mulaw is the native PSTN format).
 *
 *   3. Vobiz sends `clearedAudio` confirmation (informational; no action needed).
 *
 *   4. App can send `checkpoint` / receive `playedStream` for
 *      playback-progress tracking (not used yet — extensible).
 *
 *   5. No `stop` event from Vobiz — WebSocket close = end-of-stream.
 *
 *   6. Inbound contentType is reported in `start.mediaFormat`
 *      (encoding + sampleRate). We request `audio/x-mulaw;rate=8000`
 *      via the answer-URL XML so the same MulawVadSegmenter works.
 *
 * Vobiz WebSocket JSON protocol (documented):
 *   from platform: {"event":"start", start:{callId, streamId, tracks, mediaFormat:{encoding, sampleRate}}}
 *                  {"event":"media", media:{track, payload}}
 *                  {"event":"playedStream", ...}        (checkpoint ack)
 *                  {"event":"clearedAudio", ...}        (clear ack)
 *                  (WebSocket close = stream end)
 *   to platform:   {"event":"playAudio", streamId, media:{contentType:"audio/x-mulaw", sampleRate:8000, payload}}
 *                  NOTE: bare contentType (no ";rate=" suffix) — the rate
 *                  travels in `sampleRate`. ";rate=8000" is only valid on
 *                  the <Stream> XML attribute.
 *                  {"event":"clearAudio", streamId}
 *                  {"event":"checkpoint", streamId, name}
 *                  {"event":"stop", streamId}
 */

import type { SessionId } from "../types/session.types";
import type { AudioPayload } from "../types/provider.types";
import { SessionState } from "../types/enums";
import type { DefaultVoiceSessionManager } from "../core/session/voice-session-manager.impl";
import { MulawVadSegmenter } from "./vad-segmenter";
import { pcm16ToMulaw8k } from "./audio-codec";

// Re-use the same BridgeSocket interface shape for testability.
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}

const OPEN_STATE = 1;

/**
 * Outbound format: G.711 μ-law at 8 kHz — the native PSTN codec.
 * Matches the Plivo bridge's proven outbound path: each sample is
 * 1 byte, so 20 ms = 160 samples × 1 byte = 160 bytes per frame.
 * Resampling + mu-law encoding are handled by `pcm16ToMulaw8k()`
 * from audio-codec.ts (the same helper the Plivo bridge uses).
 */
const OUTBOUND_FRAME_BYTES = 160; // 20ms @ 8kHz mulaw (8-bit)
const OUTBOUND_FRAME_MS = 20;
/** Maximum frames the pump may send in a single tick to prevent
 *  burst-flooding the WebSocket after event-loop starvation. */
const MAX_FRAMES_PER_TICK = 3;

export function attachVobizMediaBridge(
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

  /** Vobiz's stream identifier — required in outbound events. */
  let vobizStreamId: string | undefined;

  let inboundFrameCount = 0;
  let utteranceCount = 0;

  // Inbound: we configure the answer-URL XML with
  // contentType="audio/x-mulaw;rate=8000", so Vobiz sends mulaw
  // at 8 kHz — same format the MulawVadSegmenter expects.
  const segmenter = new MulawVadSegmenter((mulawBytes) => {
    utteranceCount += 1;
    const durationMs = Math.round((mulawBytes.length / 160) * 20);
    // eslint-disable-next-line no-console
    console.log(
      `[vobiz-bridge:${sessionId}] VAD utterance #${utteranceCount}: ${mulawBytes.length} bytes (~${durationMs}ms), pushing to manager`,
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
      // Socket dropped mid-send — the close handler will clean up.
    }
  }

  let outboundChunkCount = 0;
  let outboundFrameTotal = 0;

  function enqueueOutbound(chunk: AudioPayload): void {
    outboundChunkCount += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[vobiz-bridge:${sessionId}] enqueueOutbound #${outboundChunkCount}: encoding=${chunk.encoding} sampleRate=${chunk.sampleRateHz} bytes=${chunk.data.byteLength}`,
    );

    if (chunk.encoding !== "PCM_16") {
      // eslint-disable-next-line no-console
      console.warn(
        `[vobiz-bridge:${sessionId}] WARNING: received encoding="${chunk.encoding}" but expected PCM_16 — audio may be corrupted`,
      );
    }

    // Pipeline: identical to the Plivo bridge's proven outbound path.
    // pcm16ToMulaw8k handles resampling (any TTS rate → 8kHz) and
    // mu-law encoding in one step. Result is 1 byte per sample.
    const mulawBytes = pcm16ToMulaw8k(chunk.data, chunk.sampleRateHz);

    const frameCount = Math.ceil(mulawBytes.length / OUTBOUND_FRAME_BYTES);
    outboundFrameTotal += frameCount;
    for (let offset = 0; offset < mulawBytes.length; offset += OUTBOUND_FRAME_BYTES) {
      outboundQueue.push(mulawBytes.subarray(offset, offset + OUTBOUND_FRAME_BYTES));
    }
    // eslint-disable-next-line no-console
    console.log(
      `[vobiz-bridge:${sessionId}] enqueued ${frameCount} mulaw frames (${frameCount * OUTBOUND_FRAME_MS}ms), queue depth=${outboundQueue.length}, lifetime frames=${outboundFrameTotal}`,
    );
    startPump();
  }

  function startPump(): void {
    if (pumpTimer) return;
    // eslint-disable-next-line no-console
    console.log(`[vobiz-bridge:${sessionId}] pump started`);
    const startedAt = Date.now();
    let framesSent = 0;
    pumpTimer = setInterval(() => {
      // Drift correction with burst cap — identical rationale to the
      // Plivo bridge: after event-loop starvation, uncapped drift
      // correction would dump dozens of frames in one tick.
      const rawDue = Math.floor((Date.now() - startedAt) / OUTBOUND_FRAME_MS) - framesSent;
      const framesDue = Math.min(rawDue, MAX_FRAMES_PER_TICK);
      if (rawDue > MAX_FRAMES_PER_TICK && framesSent === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[vobiz-bridge:${sessionId}] pump burst capped: ${rawDue} frames due, sending ${framesDue} (event loop starved ~${rawDue * OUTBOUND_FRAME_MS}ms)`,
        );
      }
      for (let i = 0; i < framesDue; i += 1) {
        const frame = outboundQueue.shift();
        if (!frame) {
          // eslint-disable-next-line no-console
          console.log(`[vobiz-bridge:${sessionId}] pump exhausted after ${framesSent} frames (${framesSent * OUTBOUND_FRAME_MS}ms of audio)`);
          clearInterval(pumpTimer);
          pumpTimer = undefined;
          return;
        }
        framesSent += 1;
        if (framesSent === 1 || framesSent % 50 === 0) {
          // eslint-disable-next-line no-console
          console.log(`[vobiz-bridge:${sessionId}] pump sending frame #${framesSent}, remaining=${outboundQueue.length}`);
        }
        sendJson({
          event: "playAudio",
          // Vobiz requires streamId at the top level of playAudio
          ...(vobizStreamId ? { streamId: vobizStreamId } : {}),
          media: {
            // ── CRITICAL: BARE MIME TYPE, NO ";rate=" SUFFIX ──
            // The ";rate=8000" parameter is valid ONLY on the
            // <Stream contentType="..."> XML attribute (inbound
            // direction). Inside a playAudio event the rate must be
            // carried by the separate `sampleRate` field and the
            // contentType must be bare, or the platform fails to parse
            // it and falls back to decoding our mu-law bytes as L16 —
            // which is exactly the crackly/robotic/distorted voice.
            contentType: "audio/x-mulaw",
            sampleRate: 8000,
            payload: Buffer.from(frame).toString("base64"),
          },
        });
      }
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
    console.log(`[vobiz-bridge:${sessionId}] clearOutboundPlayback: dropped ${droppedFrames} queued frames, sending clearAudio (streamId=${vobizStreamId ?? "unknown"})`);
    sendJson({ event: "clearAudio", ...(vobizStreamId ? { streamId: vobizStreamId } : {}) });
  }

  unsubscribeOutbound = manager.onOutboundAudio(sessionId, enqueueOutbound);
  // eslint-disable-next-line no-console
  console.log(`[vobiz-bridge:${sessionId}] outbound audio listener registered`);

  // Full-duplex barge-in: identical logic to the Plivo bridge.
  // On SPEAKING -> LISTENING due to barge-in, clear the outbound
  // queue and tell Vobiz to stop playback. On normal completion,
  // let the pump drain naturally.
  unsubscribeState = manager.onStateChange((eventSessionId, transition) => {
    if (eventSessionId !== sessionId) return;
    if (transition.to === SessionState.SPEAKING) {
      wasSpeaking = true;
    } else if (wasSpeaking && transition.to === SessionState.LISTENING) {
      wasSpeaking = false;
      const isBargeIn = transition.reason != null && /barge.?in/i.test(transition.reason);
      if (isBargeIn) {
        clearOutboundPlayback();
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[vobiz-bridge:${sessionId}] SPEAKING->LISTENING (normal completion, reason="${transition.reason}") — letting pump drain, queue=${outboundQueue.length}`,
        );
      }
    }
  });

  function handleMessage(raw: string): void {
    let event: {
      event?: string;
      start?: {
        callId?: string;
        streamId?: string;
        tracks?: string[];
        mediaFormat?: { encoding?: string; sampleRate?: number };
      };
      media?: { payload?: string; track?: string };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.event) {
      case "start":
        vobizStreamId = event.start?.streamId;
        // eslint-disable-next-line no-console
        console.log(
          `[vobiz-bridge:${sessionId}] "start" event: streamId=${vobizStreamId ?? "none"} callId=${event.start?.callId ?? "none"} mediaFormat=${JSON.stringify(event.start?.mediaFormat)}, confirming call answered`,
        );
        manager.confirmCallAnswered(sessionId);
        return;

      case "media": {
        // Vobiz's bidirectional stream may echo outbound audio as
        // track:"outbound". Only forward the caller's real speech.
        if (event.media?.track && event.media.track !== "inbound") return;
        const b64 = event.media?.payload;
        if (!b64) return;
        inboundFrameCount += 1;
        if (inboundFrameCount === 1 || inboundFrameCount % 100 === 0) {
          // eslint-disable-next-line no-console
          console.log(`[vobiz-bridge:${sessionId}] inbound media frame #${inboundFrameCount}`);
        }
        segmenter.push(new Uint8Array(Buffer.from(b64, "base64")));
        return;
      }

      // Vobiz confirmations — log for diagnostics, no action needed.
      case "playedStream":
        // eslint-disable-next-line no-console
        console.log(`[vobiz-bridge:${sessionId}] "playedStream" checkpoint ack received`);
        return;
      case "clearedAudio":
        // eslint-disable-next-line no-console
        console.log(`[vobiz-bridge:${sessionId}] "clearedAudio" confirmation received`);
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
    // Vobiz closes the WebSocket when the call ends — make sure
    // the session state machine and Dashboard's SSE subscription
    // find out. Already-ended sessions no-op safely.
    void manager.end(sessionId).catch(() => undefined);
  }

  // eslint-disable-next-line no-console
  console.log(`[vobiz-bridge:${sessionId}] bridge attached, socket.readyState=${socket.readyState}`);

  if (typeof socket.on === "function") {
    socket.on("message", (data: unknown) => handleMessage(String(data)));
    socket.on("close", (...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.log(`[vobiz-bridge:${sessionId}] socket "close" event, args=${JSON.stringify(args)}`);
      cleanup();
    });
    socket.on("error", (...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.log(`[vobiz-bridge:${sessionId}] socket "error" event, args=${JSON.stringify(args)}`);
      cleanup();
    });
  } else if (typeof socket.addEventListener === "function") {
    socket.addEventListener("message", (evt: unknown) => {
      const data = (evt as { data?: unknown }).data;
      handleMessage(String(data));
    });
    socket.addEventListener("close", () => {
      // eslint-disable-next-line no-console
      console.log(`[vobiz-bridge:${sessionId}] socket "close" event (addEventListener path)`);
      cleanup();
    });
    socket.addEventListener("error", () => {
      // eslint-disable-next-line no-console
      console.log(`[vobiz-bridge:${sessionId}] socket "error" event (addEventListener path)`);
      cleanup();
    });
  }
}