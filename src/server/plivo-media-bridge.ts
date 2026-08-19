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
import { createOutboundMulawEncoder, createOutboundMulawFramer } from "./audio-codec";

/** Minimal shape both `ws`'s WebSocket and the DOM WebSocket satisfy, kept narrow for testability. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}

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
/**
 * Frames buffered before the pump sends its first one. The pump paces
 * strictly at real time, so with zero pre-roll Plivo's playout buffer
 * never builds a cushion and the very first jitter event — the TTS/LLM
 * streams are at their busiest exactly then — is heard as a clipped or
 * broken opening. 5 frames = 100ms.
 */
const PREROLL_FRAMES = 5;
/** Never hold the pre-roll longer than this (short utterances may never reach PREROLL_FRAMES). */
const PREROLL_MAX_WAIT_MS = 120;
/**
 * Outbound queue backpressure.
 *
 * A streaming TTS provider hands us a whole reply at ~25x real time
 * while the pump releases it at exactly 1x, so without a bound the
 * queue grows to the FULL length of the utterance (measured: 412
 * frames / 8.2s for a 156-character reply). Everything in that queue
 * lives only in this process, and is discarded unplayed by
 * `clearOutboundPlayback` on barge-in and by `cleanup` on socket
 * close — which is why a single blip, or a dropped WebSocket, cost
 * the caller eight seconds of an already-generated reply.
 *
 * Once the queue reaches the high-water mark `enqueueOutbound`
 * returns a promise instead of `void`, which the pipeline awaits
 * before reading the next TTS chunk (TCP backpressure then propagates
 * to the provider). The pump releases the waiters as it drains past
 * the low-water mark, so the queue oscillates between the two marks
 * instead of climbing to 8s+.
 *
 * This changes NOTHING about pump timing, frame size, barge-in
 * decisions, or the order bytes are sent in — only how far ahead of
 * the pump the producer is allowed to run. The first chunk is never
 * delayed: the queue is empty at the start of an utterance, so the
 * gate does not engage until the low-water cushion is already buffered.
 *
 * ── Why the low-water mark is 2.2s and not 0.8s ──────────────────
 *
 * The low-water mark IS the pipeline's lead time. `synthesizeAndPlay`
 * is awaited once per sentence chunk, so the next TTS request only
 * starts when the pump has drained back to this mark — the queue then
 * holds exactly this much audio to cover that request's round trip.
 * Two of the three campaign TTS providers (Cartesia, Smallest AI)
 * expose only `synthesize()`, whose time-to-first-audio is the FULL
 * synthesis of the sentence: 0.8-2.5s for the 60-160 character chunks
 * the chunker emits. Against an 0.8s cushion the pump therefore ran
 * dry at essentially every sentence boundary, and the caller heard the
 * shortfall as silence between sentences.
 *
 * 2.2s covers a slow batch synthesis outright. The cost is bounded and
 * one-sided: barge-in and socket close still discard the queue
 * instantly (`clearOutboundPlayback` / `cleanup`), so the only thing
 * risked by holding more is already-paid TTS characters, never
 * responsiveness — `clearAudio` goes out on the same tick regardless
 * of queue depth.
 */
const OUTBOUND_HIGH_WATER_FRAMES = 140; // 2800ms
const OUTBOUND_LOW_WATER_FRAMES = 110; // 2200ms
/**
 * Safety net so a wedged pump can never deadlock the pipeline (and
 * therefore `end()`, which awaits the loop promise). Comfortably longer
 * than the ~600ms it takes the pump to drain high-water down to
 * low-water, so it never fires in normal operation.
 */
const OUTBOUND_BACKPRESSURE_TIMEOUT_MS = 5000;
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

export function attachPlivoMediaBridge(
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
  /** Plivo's stream identifier — required in `clearAudio` events. */
  let plivoStreamId: string | undefined;

  let inboundFrameCount = 0;
  let utteranceCount = 0;

  // The segmenter is a DETECTOR ONLY. It previously buffered the whole
  // utterance and forwarded it to Deepgram after 400ms of trailing
  // silence, so Deepgram saw nothing until the caller had already
  // stopped speaking — real-time barge-in was impossible and every turn
  // carried (utterance duration + 400ms) of dead latency. Inbound
  // frames now stream straight through (see the "media" case below);
  // the segmenter's only job is to fire `onSpeechStart` immediately.
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
   * not after they finish. Clears our own queue and Plivo's playback
   * buffer immediately, then tells the pipeline to abort the in-flight
   * LLM/TTS work. The caller's speech is NOT swallowed: inbound frames
   * keep streaming to Deepgram throughout, so whatever they said while
   * interrupting becomes the next user turn.
   */
  function onCallerSpeechStart(): void {
    if (!wasSpeaking && outboundQueue.length === 0) return;

    // eslint-disable-next-line no-console
    console.log(
      `[plivo-bridge:${sessionId}] BARGE-IN: caller speech detected while assistant audio was active (queue=${outboundQueue.length} frames)`,
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
  // Carries the sub-frame remainder between streamed TTS chunks so the
  // queue only ever holds whole 160-byte / 20ms frames.
  const framer = createOutboundMulawFramer(OUTBOUND_FRAME_BYTES);

  /** Producers parked until the queue drains back to the low-water mark. */
  let backpressureWaiters: Array<() => void> = [];

  /** Wake every parked producer. Safe to call when none are parked. */
  function releaseBackpressure(): void {
    if (backpressureWaiters.length === 0) return;
    const waiters = backpressureWaiters;
    backpressureWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Returns a promise while the queue is over the high-water mark, or
   * `undefined` (the original synchronous contract) when there is room.
   */
  function awaitQueueRoom(): Promise<void> | undefined {
    if (closed) return undefined;
    if (outboundQueue.length < OUTBOUND_HIGH_WATER_FRAMES) return undefined;

    return new Promise<void>((resolve) => {
      let settled = false;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn(
          `[plivo-bridge:${sessionId}] backpressure wait timed out after ${OUTBOUND_BACKPRESSURE_TIMEOUT_MS}ms (queue=${outboundQueue.length}) — releasing producer`,
        );
        wake();
      }, OUTBOUND_BACKPRESSURE_TIMEOUT_MS);
      backpressureWaiters.push(wake);
    });
  }

  function enqueueOutbound(chunk: AudioPayload): void | Promise<void> {
    outboundChunkCount += 1;

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

    // Whole frames only. Any 1..159-byte tail is carried into the next
    // chunk instead of being queued as a runt frame — the pump spends a
    // full 20ms slot on every frame it sends, so a short frame starves
    // the far end by the difference and is heard as a click.
    const frames = framer.push(mulawBytes);
    outboundFrameTotal += frames.length;
    for (const frame of frames) outboundQueue.push(frame);
    startPump();
    return awaitQueueRoom();
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

    // Fill a small startup buffer before the first send so Plivo has a
    // cushion. A short utterance may never reach PREROLL_FRAMES, so a
    // timer guarantees playback always begins.
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
    const startedAt = Date.now();
    let framesSent = 0;
    pumpTimer = setInterval(() => {
      // Drift correction with burst cap: after event-loop starvation
      // (e.g. TTS streaming holding the microtask queue for >1s),
      // uncapped drift correction would dump dozens of frames in one
      // tick, overwhelming Plivo's playback buffer. Cap to
      // MAX_FRAMES_PER_TICK so catch-up is gradual (~60ms per tick
      // at cap=3) instead of a single burst.
      const rawDue = Math.floor((Date.now() - startedAt) / OUTBOUND_FRAME_MS) - framesSent;
      const framesDue = Math.min(rawDue, MAX_FRAMES_PER_TICK);
      if (rawDue > MAX_FRAMES_PER_TICK && framesSent === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[plivo-bridge:${sessionId}] pump burst capped: ${rawDue} frames due, sending ${framesDue} (event loop was starved ~${rawDue * OUTBOUND_FRAME_MS}ms)`,
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
        if (outboundQueue.length <= OUTBOUND_LOW_WATER_FRAMES) releaseBackpressure();
        sendJson({
          event: "playAudio",
          // `streamId` is a TOP-LEVEL sibling of `event`/`media` — not
          // inside `media`. Plivo's own reference serializer includes
          // it on every playAudio event.
          ...(plivoStreamId ? { streamId: plivoStreamId } : {}),
          media: {
            // ── CRITICAL: BARE MIME TYPE, NO ";rate=" SUFFIX ──
            //
            // The `;rate=8000` parameter belongs ONLY on the
            // `<Stream contentType="...">` XML attribute (which
            // configures the INBOUND direction). Inside a `playAudio`
            // WebSocket event the rate must be carried by the separate
            // `sampleRate` field and the contentType must be bare.
            //
            // Plivo's own examples repo lists
            //   contentType: "audio/x-mulaw;rate=8000"
            // as a known common mistake ("wrong - rate must be
            // separate") that triggers an `incorrectPayload` error.
            //
            // When Plivo cannot parse the contentType it falls back to
            // its stream default of L16, so our G.711 mu-law bytes get
            // reinterpreted as 16-bit signed PCM. That mis-decode is
            // what produced the loud crackly/robotic/noisy voice that
            // still carried the rhythm of speech — and why no amount of
            // frame padding, pump retiming, endianness swapping or
            // codec substitution ever changed it. The bytes we sent
            // were always correct; the receiver was told the wrong
            // format to decode them with.
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
    // The queue is gone, so anyone parked waiting for room must be woken
    // — otherwise a barge-in would leave the TTS read loop blocked and
    // it could never observe its own abort signal.
    releaseBackpressure();
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = undefined;
    }
    if (prerollTimer) {
      clearTimeout(prerollTimer);
      prerollTimer = undefined;
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
        // Utterance genuinely finished — emit the carried remainder
        // once, silence-padded, so the tail is not left unspoken.
        flushOutboundRemainder();
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
    // Nothing will drain the queue again, so release any parked producer
    // before tearing down — `manager.end()` below awaits the pipeline's
    // loop promise, which cannot settle while it is blocked here.
    releaseBackpressure();
    segmenter.flush();
    unsubscribeOutbound?.();
    unsubscribeState?.();
    if (pumpTimer) clearInterval(pumpTimer);
    if (prerollTimer) clearTimeout(prerollTimer);
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