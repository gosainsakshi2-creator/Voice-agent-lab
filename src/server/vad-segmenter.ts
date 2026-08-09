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
}

const DEFAULTS: Required<VadSegmenterOptions> = {
  speechThreshold: 150,
  endSilenceMs: 400,
  minUtteranceMs: 200,
  maxUtteranceMs: 15_000,
  speechStartFrames: 1,
};

/** One μ-law frame from Plivo = 160 bytes = 20 ms @ 8 kHz */
const FRAME_MS = 20;

export class MulawVadSegmenter {
  private readonly opts: Required<VadSegmenterOptions>;

  private buffered: Uint8Array[] = [];
  private bufferedMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private consecutiveSpeechFrames = 0;
  private speechStartNotified = false;

  constructor(
    private readonly onUtterance: (mulawBytes: Uint8Array) => void,
    private readonly onSpeechStart?: () => void,
    options: VadSegmenterOptions = {},
  ) {
    this.opts = {
      ...DEFAULTS,
      ...options,
    };
  }

  /**
   * Feed one μ-law frame.
   */
  push(mulawFrame: Uint8Array): void {
    const frameMs = (mulawFrame.length / 160) * FRAME_MS;
    const isSpeech = this.frameHasSpeech(mulawFrame);

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
  }

  private frameHasSpeech(mulawFrame: Uint8Array): boolean {
    const pcm = mulawToPcm16(mulawFrame);

    let sumSquares = 0;

    for (let i = 0; i < pcm.length; i += 1) {
      const sample = pcm[i]!;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, pcm.length));

    return rms >= this.opts.speechThreshold;
  }
}