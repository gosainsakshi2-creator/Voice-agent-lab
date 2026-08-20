/**
 * vad-segmenter.ts
 *
 * Transport-level concern, NOT orchestration logic.
 * Splits a continuous stream of 8 kHz G.711 μ-law frames into
 * utterance-sized chunks using simple energy-based VAD.
 */

import { mulawToPcm16 } from "./audio-codec";

export interface VadSegmenterOptions {
  /** RMS amplitude (0–32767) above which a frame counts as speech. */
  readonly speechThreshold?: number;

  /** Consecutive silence (ms) that ends an utterance. */
  readonly endSilenceMs?: number;

  /** Ignore utterances shorter than this. */
  readonly minUtteranceMs?: number;

  /** Hard cap to avoid buffering forever. */
  readonly maxUtteranceMs?: number;

  /**
   * Consecutive speech frames required before `onSpeechStart` fires.
   * 1 (the default) preserves the original behaviour. Bridges that use
   * `onSpeechStart` to trigger barge-in pass 2 so a single noisy frame
   * (a click, a cough, line noise) cannot cut off the assistant.
   */
  readonly speechStartFrames?: number;

  /**
   * ---------------- The LOUD (near-end) gate ----------------
   *
   * A SECOND, independent energy threshold, reported through
   * `onLoudSpeech`. Everything above stays exactly as it was — this
   * adds a strictly louder classification alongside it, and changes
   * nothing at all when `onLoudSpeech` is not supplied.
   *
   * WHY A SECOND THRESHOLD RATHER THAN A HIGHER ONE. `speechThreshold`
   * has to stay permissive, because the bridges use `onSpeechStart` as
   * the liveness signal that stops the campaign silence watchdog from
   * hanging up on a soft-spoken caller. But "loud enough to prove
   * somebody is on the line" and "loud enough to be the CALLER talking
   * over us, rather than a television, a second person across the room,
   * or the echo of our own audio out of their earpiece" are different
   * questions, and one threshold cannot answer both: the first wants to
   * be low, the second wants to be high.
   *
   * A phone microphone sits centimetres from the near-end speaker's
   * mouth and metres from anything else in the room, so background
   * voices arrive 15-25 dB down — a factor of ~6-18 in amplitude. That
   * gap is the only signal available at this layer that separates them,
   * and a transcript cannot substitute for it: Deepgram transcribes a
   * television perfectly happily. So the bridges gate barge-in on this
   * threshold rather than on `speechThreshold`.
   */
  readonly loudSpeechThreshold?: number;

  /** Consecutive loud frames before `onLoudSpeech` starts firing. */
  readonly loudSpeechFrames?: number;

  /**
   * Non-loud audio tolerated INSIDE one loud run before the run is
   * considered over. Speech dips below any fixed threshold between
   * syllables, so without this a run could never exceed ~100ms and the
   * sustained-energy measurement `onLoudSpeech` reports would be
   * meaningless.
   */
  readonly loudSpeechGapMs?: number;

  /**
   * Fired on every loud frame once the current run has reached
   * `loudSpeechFrames`, carrying the length of that run so far in ms
   * (gap-tolerant — see `loudSpeechGapMs`).
   *
   * Deliberately fired repeatedly rather than once per utterance,
   * because the bridges need two different facts from it: "loud speech
   * is happening RIGHT NOW" (a fresh timestamp, which the pipeline uses
   * to corroborate a transcript before treating it as an interruption)
   * and "loud speech has been going on for N ms" (their own last-resort
   * barge-in for when no transcript ever arrives). One callback
   * carrying the run length answers both.
   */
  readonly onLoudSpeech?: (consecutiveLoudMs: number) => void;
}

/** The numeric knobs, all defaulted — `onLoudSpeech` has no default. */
type VadSegmenterThresholds = Required<Omit<VadSegmenterOptions, "onLoudSpeech">>;

const DEFAULTS: VadSegmenterThresholds = {
  speechThreshold: 150,
  endSilenceMs: 400,
  minUtteranceMs: 200,
  maxUtteranceMs: 15_000,
  speechStartFrames: 1,
  // Disabled by default: with no `onLoudSpeech` supplied there is
  // nothing to report to, and an infinite threshold is never met, so a
  // caller that passes neither behaves byte-for-byte as before.
  loudSpeechThreshold: Number.POSITIVE_INFINITY,
  loudSpeechFrames: 4,
  loudSpeechGapMs: 120,
};

/** One μ-law frame from Plivo = 160 bytes = 20 ms @ 8 kHz */
const FRAME_MS = 20;

export class MulawVadSegmenter {
  private readonly opts: VadSegmenterThresholds;
  private readonly onLoudSpeech: ((consecutiveLoudMs: number) => void) | undefined;

  private buffered: Uint8Array[] = [];
  private bufferedMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private consecutiveSpeechFrames = 0;
  private speechStartNotified = false;
  /** Frames at or above `loudSpeechThreshold` in the current loud run. */
  private consecutiveLoudFrames = 0;
  /** Duration of the current loud run, tolerated gap frames included. */
  private loudRunMs = 0;
  /** Non-loud audio accumulated since the last loud frame of this run. */
  private loudGapMs = 0;

  constructor(
    private readonly onUtterance: (mulawBytes: Uint8Array) => void,
    private readonly onSpeechStart?: () => void,
    options: VadSegmenterOptions = {},
  ) {
    const { onLoudSpeech, ...thresholds } = options;
    this.opts = {
      ...DEFAULTS,
      ...thresholds,
    };
    this.onLoudSpeech = onLoudSpeech;
  }

  /**
   * Feed one μ-law frame.
   */
  push(mulawFrame: Uint8Array): void {
    const frameMs = (mulawFrame.length / 160) * FRAME_MS;
    // ONE decode per frame, compared against both thresholds, so the
    // loud gate below costs a comparison rather than another pass.
    const rms = this.frameRms(mulawFrame);
    const isSpeech = rms >= this.opts.speechThreshold;

    // Tracked over the raw frame stream, independently of the utterance
    // buffering below: the loud run is a statement about the audio, not
    // about where this segmenter thinks an utterance starts and stops.
    this.trackLoudRun(rms, frameMs);

    if (isSpeech) {
      this.speaking = true;
      this.consecutiveSpeechFrames += 1;

      // Fire once per utterance, as early as the debounce allows — this
      // is the real-time barge-in signal and must NOT wait for the
      // end-of-utterance silence flush below.
      if (
        !this.speechStartNotified &&
        this.consecutiveSpeechFrames >= this.opts.speechStartFrames
      ) {
        this.speechStartNotified = true;
        this.onSpeechStart?.();
      }

      this.silenceMs = 0;
      this.buffered.push(mulawFrame);
      this.bufferedMs += frameMs;
    } else if (this.speaking) {
      this.consecutiveSpeechFrames = 0;
      // Keep trailing silence so we don't clip word endings.
      this.buffered.push(mulawFrame);
      this.bufferedMs += frameMs;
      this.silenceMs += frameMs;

      if (this.silenceMs >= this.opts.endSilenceMs) {
        this.flush();
      }
    }

    if (this.bufferedMs >= this.opts.maxUtteranceMs) {
      this.flush();
    }
  }

  /**
   * Force-emit whatever is buffered.
   */
  flush(): void {
    if (this.buffered.length === 0) {
      this.reset();
      return;
    }

    if (this.bufferedMs >= this.opts.minUtteranceMs) {
      const totalBytes = this.buffered.reduce(
        (sum, frame) => sum + frame.length,
        0,
      );

      const merged = new Uint8Array(totalBytes);

      let offset = 0;

      for (const frame of this.buffered) {
        merged.set(frame, offset);
        offset += frame.length;
      }

      this.onUtterance(merged);
    }

    this.reset();
  }

  private reset(): void {
    this.buffered = [];
    this.bufferedMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.consecutiveSpeechFrames = 0;
    this.speechStartNotified = false;
    // The loud run belongs to the audio rather than to the utterance
    // buffer, but the only paths that reach here are `endSilenceMs` of
    // trailing silence (which has already broken any run) and the
    // `maxUtteranceMs` force-flush, so clearing it costs at most one
    // re-arm of a run that has been going for 15 seconds.
    this.consecutiveLoudFrames = 0;
    this.loudRunMs = 0;
    this.loudGapMs = 0;
  }

  /**
   * Maintains the current loud run and reports it. Gap-tolerant: a
   * short dip below the threshold (the pause between syllables)
   * extends the run rather than ending it, so `loudRunMs` measures how
   * long the caller has actually been talking loudly — but a non-loud
   * frame is never itself a reason to report.
   */
  private trackLoudRun(rms: number, frameMs: number): void {
    if (this.onLoudSpeech === undefined) return;

    if (rms >= this.opts.loudSpeechThreshold) {
      this.consecutiveLoudFrames += 1;
      this.loudRunMs += frameMs;
      this.loudGapMs = 0;
      if (this.consecutiveLoudFrames >= this.opts.loudSpeechFrames) {
        this.onLoudSpeech(this.loudRunMs);
      }
      return;
    }

    if (this.loudRunMs === 0) return;

    this.loudGapMs += frameMs;
    if (this.loudGapMs >= this.opts.loudSpeechGapMs) {
      this.consecutiveLoudFrames = 0;
      this.loudRunMs = 0;
      this.loudGapMs = 0;
      return;
    }
    this.loudRunMs += frameMs;
  }

  private frameRms(mulawFrame: Uint8Array): number {
    const pcm = mulawToPcm16(mulawFrame);

    let sumSquares = 0;

    for (let i = 0; i < pcm.length; i += 1) {
      const sample = pcm[i]!;
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / Math.max(1, pcm.length));
  }
}