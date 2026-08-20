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
 * ---------------- Two energy gates, two questions ----------------
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
 * LIVENESS (`onSpeechStart`) answers "is somebody on this line?". It
 * has to stay permissive: it is the one signal that survives an STT
 * outage, and the campaign silence watchdog hangs up on a caller it
 * cannot hear. RMS 700 over 120ms, unchanged.
 *
 * NEAR-END SPEECH (`onLoudSpeech`) answers the different and much
 * harder question "is the CALLER talking over us, rather than a
 * television, a second person across the room, or our own audio
 * echoing back?". Real near-end phone speech sits around RMS
 * 2000-8000; anything metres from the handset arrives 15-25 dB down,
 * i.e. RMS ~110-1300. 1600 sits above that band and below the caller.
 * This gate no longer decides a barge-in by itself — it corroborates
 * the pipeline's Deepgram-transcript-confirmed path, which is what
 * stops a transcribed background voice from cutting the assistant off.
 */
const LIVENESS_SPEECH_THRESHOLD_RMS = 700;
/** 6 frames = 120ms of continuous speech energy. */
const LIVENESS_SPEECH_START_FRAMES = 6;
/** See above: loud enough to be the near-end speaker, not the room. */
const NEAR_END_SPEECH_THRESHOLD_RMS = 1600;
/** 4 frames = 80ms, so corroboration is available before any transcript. */
const NEAR_END_SPEECH_FRAMES = 4;
/**
 * Continuous near-end speech that barges in with NO transcript at all.
 *
 * The last resort for a dead or lagging STT socket, which would
 * otherwise leave the assistant uninterruptible. 700ms of sustained
 * loud near-end energy is a caller talking, not a cough (~200-300ms), a
 * door, or the intermittent bursts a background conversation produces.
 */
const ENERGY_ONLY_BARGE_IN_MS = 700;

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
  // "media" case below) and the segmenter's only job is to report
  // energy the instant the caller opens their mouth, through the two
  // callbacks below.
  const segmenter = new MulawVadSegmenter(
    (mulawBytes) => {
      utteranceCount += 1;
      void mulawBytes;
    },
    () => onCallerSpeechStart(),
    // Two gates, two questions — see the constants above.
    {
      speechStartFrames: LIVENESS_SPEECH_START_FRAMES,
      speechThreshold: LIVENESS_SPEECH_THRESHOLD_RMS,
      loudSpeechThreshold: NEAR_END_SPEECH_THRESHOLD_RMS,
      loudSpeechFrames: NEAR_END_SPEECH_FRAMES,
      onLoudSpeech: (loudMs) => onCallerNearEndSpeech(loudMs),
    },
  );

  /**
   * The transport's own energy VAD has heard the caller's voice —
   * liveness, at the permissive threshold. Inbound frames keep
   * streaming to Deepgram throughout, so nothing they say is swallowed
   * whatever this decides.
   */
  function onCallerSpeechStart(): void {
    // LIVENESS ONLY, and deliberately so. RMS >= 700 for 120ms proves
    // somebody is on the line — nothing more. It is the one signal that
    // survives an STT outage, and without it the campaign silence
    // watchdog can read a talking caller as a silent line and hang up on
    // them; comfort noise and a quiet line never reach it, so genuine
    // silence still ends the call at exactly the same deadline.
    //
    // It no longer triggers a barge-in. At this threshold it cannot tell
    // the caller apart from a television, a second person in the room,
    // or our own audio out of their earpiece, and cutting the assistant
    // off for any of those is the reported "a background voice
    // interrupts it and it goes quiet" behaviour. That decision now
    // belongs to `onCallerNearEndSpeech` below and to the pipeline,
    // which requires BOTH loud near-end energy and words from Deepgram
    // to agree before anything is interrupted.
    try {
      manager.noteCallerSpeech(sessionId);
    } catch {
      // Session already ended — nothing to stamp.
    }
  }

  /**
   * The transport is hearing LOUD, near-end speech right now — see
   * NEAR_END_SPEECH_* above. Fired repeatedly for as long as it lasts,
   * carrying the length of the current run.
   *
   * Two jobs, and the first is the important one:
   *
   *   1. Stamp the session so the pipeline can CORROBORATE a Deepgram
   *      transcript before treating it as the caller talking over the
   *      assistant. Neither signal is sufficient alone: energy with no
   *      words is a door or a cough, words with no energy are the room.
   *   2. Barge in directly once the run is long enough to need no
   *      transcript at all — the last resort for a dead STT socket,
   *      which would otherwise leave the assistant uninterruptible.
   */
  function onCallerNearEndSpeech(loudMs: number): void {
    try {
      manager.noteCallerEnergy(sessionId);
    } catch {
      // Session already ended — nothing to stamp.
    }

    if (loudMs < ENERGY_ONLY_BARGE_IN_MS) return;
    if (!wasSpeaking && outboundQueue.length === 0) return;

    // eslint-disable-next-line no-console
    console.log(
      `[vobiz-bridge:${sessionId}] BARGE-IN: ${loudMs}ms of sustained near-end speech over assistant audio, with no transcript (queue=${outboundQueue.length} frames)`,
    );
    try {
      // Clear playback only if the pipeline ACCEPTED the barge-in: it
      // declines while the fixed opening line is still playing, and
      // dropping the queue anyway would leave the caller in silence with
      // nothing left to play and no reply on the way.
      if (manager.signalBargeIn(sessionId)) clearOutboundPlayback();
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