/**
 * vad-segmenter.ts
 *
 * Transport-level concern, NOT orchestration logic. The registered
 * Speech-To-Text provider (Deepgram) implements only the batch
 * `transcribe(one whole AudioPayload)` contract — none of the four
 * provider adapters implement the optional `transcribeStream`
 * member (verified in the Provider Layer; see integration report).
 * `ConversationPipeline.acquireBatchTurn` therefore expects exactly
 * one `AudioPayload` per caller utterance from the inbound audio
 * source.
 *
 * A live phone call obviously doesn't arrive pre-split into
 * utterances — Plivo streams ~20ms mu-law frames continuously. This
 * module's only job is turning that continuous frame stream into
 * discrete utterance-sized `AudioPayload`s using simple
 * energy-based endpointing, then handing each one to
 * `pushInboundAudio`. It does not detect language, transcribe
 * anything, manage session state, or decide when the assistant
 * should speak — all of that remains exactly where it already lived
 * (`AdaptiveTurnDetector`, `ConversationPipeline`, unchanged).
 */

import { mulawToPcm16 } from "./audio-codec";

export interface VadSegmenterOptions {
  /** RMS amplitude (0-32767 scale) above which a frame counts as speech. */
  readonly speechThreshold?: number;
  /** Consecutive silence duration (ms) that ends the current utterance. */
  readonly endSilenceMs?: number;
  /** Minimum utterance length (ms) worth flushing at all. */
  readonly minUtteranceMs?: number;
  /** Hard cap (ms) so a stuck-open mic can't buffer forever. */
  readonly maxUtteranceMs?: number;
}

const DEFAULTS: Required<VadSegmenterOptions> = {
  speechThreshold: 150,
  endSilenceMs: 600,
  minUtteranceMs: 250,
  maxUtteranceMs: 20_000,
};

/** One 20ms mu-law frame is 160 bytes at 8kHz. */
const FRAME_MS = 20;

export class MulawVadSegmenter {
  private readonly opts: Required<VadSegmenterOptions>;
  private buffered: Uint8Array[] = [];
  private bufferedMs = 0;
  private silenceMs = 0;
  private speaking = false;

  constructor(
    private readonly onUtterance: (mulawBytes: Uint8Array) => void,
    options: VadSegmenterOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Feed one raw mu-law frame (any length; Plivo sends ~20ms/160-byte frames). */
  push(mulawFrame: Uint8Array): void {
    const frameMs = (mulawFrame.length / 160) * FRAME_MS;
    const isSpeech = this.frameHasSpeech(mulawFrame);

    if (isSpeech) {
      this.speaking = true;
      this.silenceMs = 0;
      this.buffered.push(mulawFrame);
      this.bufferedMs += frameMs;
    } else if (this.speaking) {
      // Keep trailing silence in the buffer (natural word endings)
      // until it's long enough to declare the utterance over.
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

  /** Force-emit whatever is buffered (e.g. on call end). */
  flush(): void {
    if (this.buffered.length === 0) {
      this.reset();
      return;
    }
    if (this.bufferedMs >= this.opts.minUtteranceMs) {
      const total = this.buffered.reduce((sum, frame) => sum + frame.length, 0);
      const merged = new Uint8Array(total);
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