/**
 * sentence-chunker.ts
 *
 * Splits an incoming stream of LLM token deltas into sentence-sized
 * chunks as soon as each one is complete, so the pipeline can start
 * TTS synthesis on the first sentence while the model is still
 * generating the rest of the reply — the mechanism behind
 * overlapping "LLM streaming -> TTS streaming" rather than waiting
 * for a full completion before any audio is produced.
 *
 * A minimum chunk length avoids firing on stray punctuation (e.g.
 * "Mr." or a lone "...") producing unnaturally tiny, choppy audio
 * clips.
 */

const SENTENCE_BOUNDARY = /([.!?]+)(\s+|$)/;
const MIN_CHUNK_LENGTH = 12;

export class SentenceChunker {
  private buffer = "";

  /** Feed a new token delta; returns any newly-completed sentence chunks. */
  push(delta: string): string[] {
    this.buffer += delta;
    const completed: string[] = [];

    for (;;) {
      const match = SENTENCE_BOUNDARY.exec(this.buffer);
      if (!match || match.index === undefined) break;

      const boundaryEnd = match.index + match[0].length;
      const candidate = this.buffer.slice(0, boundaryEnd).trim();

      if (candidate.length < MIN_CHUNK_LENGTH) {
        // Too short to be worth a separate synthesis call yet — wait
        // for more tokens to accumulate before cutting a chunk here.
        break;
      }

      completed.push(candidate);
      this.buffer = this.buffer.slice(boundaryEnd);
    }

    return completed;
  }

  /** Call once the LLM stream has ended; returns any trailing partial sentence, if non-empty. */
  flush(): string | undefined {
    const remainder = this.buffer.trim();
    this.buffer = "";
    return remainder.length > 0 ? remainder : undefined;
  }
}
