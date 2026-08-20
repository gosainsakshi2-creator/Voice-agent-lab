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
import { createOutboundMulawEncoder, createOutboundMulawFramer } from "./audio-codec";

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
/**
 * Frames buffered before the pump sends its first one. The pump paces
 * strictly at real time, so with zero pre-roll the far end's playout
 * buffer never builds a cushion and the very first jitter event — the
 * TTS/LLM streams are at their busiest exactly then — is heard as a
 * clipped or broken opening. 5 frames = 100ms: enough to absorb a
 * startup stall, far too little to be perceived as latency.
 */
const PREROLL_FRAMES = 5;
/** Never hold the pre-roll longer than this (short utterances may never reach PREROLL_FRAMES). */
const PREROLL_MAX_WAIT_MS = 120;
/**
 * Barge-in onset gate. These only affect `onSpeechStart` (the VAD's
 * utterance callback here is diagnostic-only), i.e. they decide what
 * counts as "the caller started talking over us".
 *
 * The segmenter's default threshold of RMS 150 is ~-47 dBFS — inside
 * the band occupied by G.711 comfort noise, mobile background noise,
 * and the acoustic echo of our own audio out of the caller's earpiece.
 * Combined with a 40ms onset it meant any stray noise burst during a
 * reply fired a barge-in, which clears the whole outbound queue. Since
 * streaming TTS enqueues far faster than real time, that queue holds
 * most of the remaining reply — so a single blip truncated the
 * assistant mid-sentence even though nobody had interrupted.
 *
 * Real speech on a phone line sits around RMS 2000-8000 and lasts far
 * longer than 120ms, so genuine barge-in still fires promptly. Soft or
 * marginal interruptions are still caught by the pipeline's
 * independent, Deepgram-transcript-confirmed barge-in path.
 */
const BARGE_IN_SPEECH_THRESHOLD_RMS = 700;
/** 6 frames = 120ms of continuous speech energy. */
const BARGE_IN_SPEECH_START_FRAMES = 6;

export function attachVobizMediaBridge(
  socket: BridgeSocket,
  sessionId: SessionId,
  manager: DefaultVoiceSessionManager,
): void {
  let unsubscribeOutbound: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let outboundQueue: Uint8Array[] = [];
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let prerollTimer: ReturnType<typeof setTimeout> | undefined;
  let wasSpeaking = false;
  let closed = false;

  /** Vobiz's stream identifier — required in outbound events. */
  let vobizStreamId: string | undefined;

  let inboundFrameCount = 0;
  let utteranceCount = 0;

  // Inbound: we configure the answer-URL XML with
  // contentType="audio/x-mulaw;rate=8000", so Vobiz sends mulaw
  // at 8 kHz — same format the MulawVadSegmenter expects.
  //
  // The segmenter is now a DETECTOR ONLY. It used to buffer the whole
  // utterance and forward it to Deepgram after 400ms of trailing
  // silence, which meant Deepgram saw nothing until the caller had
  // already stopped talking — making real-time barge-in structurally
  // impossible and adding (utterance duration + 400ms) of latency to
  // every turn. Inbound frames now go straight to the manager (see the
  // "media" case below) and the segmenter's only job is to fire
  // `onSpeechStart` the instant the caller opens their mouth.
  const segmenter = new MulawVadSegmenter(
    (mulawBytes) => {
      utteranceCount += 1;
      void mulawBytes;
    },
    () => onCallerSpeechStart(),
    // See BARGE_IN_* above: the onset must look like actual speech, not
    // a noise/echo blip, or it truncates the assistant mid-reply.
    {
      speechStartFrames: BARGE_IN_SPEECH_START_FRAMES,
      speechThreshold: BARGE_IN_SPEECH_THRESHOLD_RMS,
    },
  );

  /**
   * Real-time barge-in. Fires ~40ms after the caller starts speaking,
   * not after they finish. Clears our own queue and Vobiz's playback
   * buffer immediately, then tells the pipeline to abort the in-flight
   * LLM/TTS work. The caller's speech is NOT swallowed: inbound frames
   * keep streaming to Deepgram throughout, so whatever they said while
   * interrupting becomes the next user turn.
   */
  function onCallerSpeechStart(): void {
    // The caller is audibly speaking, on the transport's own energy VAD
    // (RMS >= 700 for 120ms — see BARGE_IN_* above), independent of
    // Deepgram. Stamped BEFORE the barge-in early-return below, because
    // this is true whether or not the assistant happened to be talking:
    // it is the one liveness signal that survives an STT outage, and
    // without it the campaign silence watchdog can read a talking
    // caller as a silent line and hang up on them. Comfort noise and a
    // quiet line never reach this threshold, so genuine silence still
    // ends the call at exactly the same deadline.
    try {
      manager.noteCallerSpeech(sessionId);
    } catch {
      // Session already ended — nothing to stamp.
    }

    if (!wasSpeaking && outboundQueue.length === 0) return;

    // eslint-disable-next-line no-console
    console.log(
      `[vobiz-bridge:${sessionId}] BARGE-IN: caller speech detected while assistant audio was active (queue=${outboundQueue.length} frames)`,
    );
    clearOutboundPlayback();
    try {
      manager.signalBargeIn(sessionId);
    } catch {
      // Session already ended — nothing left to interrupt.
    }
  }

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
  /** Cleared once the first frame of the call has actually gone out, so the greeting-startup logs fire exactly once. */
  let awaitingFirstFrame = true;
  // One encoder instance for this call's whole outbound stream — see
  // audio-codec.ts: it crossfades each chunk's seam against the
  // previous chunk, so it must persist for the life of the call.
  const mulawEncoder = createOutboundMulawEncoder();
  // Carries the sub-frame remainder between streamed TTS chunks so the
  // queue only ever holds whole 160-byte / 20ms frames.
  const framer = createOutboundMulawFramer(OUTBOUND_FRAME_BYTES);

  function enqueueOutbound(chunk: AudioPayload): void {
    outboundChunkCount += 1;

    if (chunk.encoding !== "PCM_16") {
      // eslint-disable-next-line no-console
      console.warn(
        `[vobiz-bridge:${sessionId}] WARNING: received encoding="${chunk.encoding}" but expected PCM_16 — audio may be corrupted`,
      );
    }

    // Pipeline: identical to the Plivo bridge's proven outbound path.
    // The encoder handles resampling (any TTS rate → 8kHz), mu-law
    // encoding, and seam-crossfading in one step. Result is 1 byte per sample.
    const mulawBytes = mulawEncoder.encode(chunk.data, chunk.sampleRateHz);

    // Whole frames only. Any 1..159-byte tail is carried into the next
    // chunk instead of being queued as a runt frame — the pump spends a
    // full 20ms slot on every frame it sends, so a short frame starves
    // the far end by the difference and is heard as a click.
    const frames = framer.push(mulawBytes);
    if (awaitingFirstFrame && outboundChunkCount === 1) {
      // eslint-disable-next-line no-console
      console.log(`[Vobiz] greeting queued (${frames.length} frames, streamId=${vobizStreamId ?? "none"})`);
    }
    outboundFrameTotal += frames.length;
    for (const frame of frames) outboundQueue.push(frame);
    startPump();
  }

  /** Emit the carried remainder, silence-padded, once an utterance truly ends. */
  function flushOutboundRemainder(): void {
    const tail = framer.flush();
    if (!tail) return;
    outboundFrameTotal += 1;
    outboundQueue.push(tail);
    startPump();
  }

  function startPump(): void {
    if (pumpTimer) return;

    // Fill a small startup buffer before the first send so the far end
    // has a cushion. A short utterance may never reach PREROLL_FRAMES,
    // so a timer guarantees playback always begins.
    if (outboundQueue.length < PREROLL_FRAMES) {
      if (!prerollTimer) {
        prerollTimer = setTimeout(() => {
          prerollTimer = undefined;
          if (!pumpTimer && outboundQueue.length > 0) beginPump();
        }, PREROLL_MAX_WAIT_MS);
      }
      return;
    }
    if (prerollTimer) {
      clearTimeout(prerollTimer);
      prerollTimer = undefined;
    }
    beginPump();
  }

  function beginPump(): void {
    if (pumpTimer) return;
    if (awaitingFirstFrame) {
      // eslint-disable-next-line no-console
      console.log(`[Vobiz] greeting pump started`);
    }
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
          clearInterval(pumpTimer);
          pumpTimer = undefined;
          return;
        }
        framesSent += 1;
        if (awaitingFirstFrame) {
          awaitingFirstFrame = false;
          // eslint-disable-next-line no-console
          console.log(`[Vobiz] greeting first frame sent`);
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
    framer.reset();
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = undefined;
    }
    if (prerollTimer) {
      clearTimeout(prerollTimer);
      prerollTimer = undefined;
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
        // Utterance genuinely finished — emit the carried remainder
        // once, silence-padded, so the tail is not left unspoken.
        flushOutboundRemainder();
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
        console.log(`[Vobiz] stream ready (streamId=${vobizStreamId ?? "none"})`);
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
        const frame = new Uint8Array(Buffer.from(b64, "base64"));

        // 1) Detection first, so barge-in fires with the least possible
        //    delay. The segmenter no longer forwards audio anywhere.
        segmenter.push(frame);

        // 2) Stream every frame straight through to the manager (and so
        //    to Deepgram's live socket). Continuous 20ms frames are what
        //    a streaming STT expects; buffering whole utterances here
        //    was adding (utterance + 400ms) before Deepgram saw a byte.
        //    This is the ONLY path that forwards inbound audio — no
        //    frame is delivered twice.
        try {
          const payload: AudioPayload = {
            data: frame,
            encoding: "MULAW",
            sampleRateHz: 8000,
          };
          manager.pushInboundAudio(sessionId, payload);
        } catch {
          // Session not started yet or already ended — drop the frame.
        }
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
    if (prerollTimer) clearTimeout(prerollTimer);
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