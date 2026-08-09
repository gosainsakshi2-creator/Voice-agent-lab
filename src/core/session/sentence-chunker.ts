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
 * Three things matter for how a reply SOUNDS on a phone call:
 *
 *  - The FIRST chunk decides time-to-first-audio, i.e. how long the
 *    caller sits in silence after finishing their sentence. It is cut
 *    eagerly: a shorter minimum length, and a clause boundary (comma,
 *    dash, Hindi danda) counts as a cut point once there is enough
 *    text to sound natural. Later chunks use the stricter
 *    sentence-only rule, since by then audio is already playing and
 *    smoothness matters more than latency.
 *
 *  - A minimum chunk length avoids firing on stray punctuation (e.g.
 *    "Mr." or a lone "...") producing unnaturally tiny, choppy clips.
 *
 *  - A run-on reply with no sentence-final punctuation must still be
 *    cut somewhere, or the caller hears nothing until the whole reply
 *    has generated. `MAX_BUFFER_BEFORE_FORCED_CUT` bounds that.
 */

/** Sentence-final punctuation, including the Devanagari danda. */
const SENTENCE_BOUNDARY = /([.!?।]+)(\s+|$)/u;
/** Clause-level boundary — only used to cut the first chunk sooner. */
const CLAUSE_BOUNDARY = /([,;:—–]|।)(\s+)/u;

/**
 * Minimum length of a NON-first chunk.
 *
 * 12 characters is two or three words, and a chunk is one whole TTS
 * request. For a provider with no streaming endpoint (Cartesia, Sarvam,
 * Smallest AI all expose only `synthesize()`), a two-word request buys
 * ~0.5s of audio for a full round trip of request latency — not enough
 * to keep the transport's outbound queue fed across the boundary, so
 * the caller hears a gap after every short sentence even though the
 * pipeline is already synthesizing the next one.
 *
 * 60 characters is a natural clause-to-sentence span (~10 words) and
 * merges runs of very short sentences ("Yes. No problem.") into one
 * continuous request. Sentence boundaries are still the only cut
 * points, so nothing is spliced mid-phrase and pronunciation is
 * unchanged; `MAX_BUFFER_BEFORE_FORCED_CUT` still bounds the wait.
 *
 * Time-to-first-audio is untouched — the first chunk uses
 * `MIN_FIRST_CHUNK_LENGTH` / `MIN_FIRST_CLAUSE_LENGTH` below, which
 * are deliberately left as they were.
 */
const MIN_CHUNK_LENGTH = 60;
/** The first chunk may be shorter: getting audio started beats chunk size. */
const MIN_FIRST_CHUNK_LENGTH = 8;
/** Only cut the first chunk at a clause boundary once it reads as a real phrase. */
const MIN_FIRST_CLAUSE_LENGTH = 24;
/** Beyond this, cut at the last word boundary rather than keep buffering. */
const MAX_BUFFER_BEFORE_FORCED_CUT = 160;
/**
 * Tighter cap for the first chunk. 160 unpunctuated characters is ~10
 * seconds of speech the caller would spend in silence waiting for the
 * reply to start.
 */
const MAX_FIRST_BUFFER_BEFORE_FORCED_CUT = 90;

export class SentenceChunker {
  private buffer = "";
  private isFirstChunk = true;

  /** Feed a new token delta; returns any newly-completed sentence chunks. */
  push(delta: string): string[] {
    this.buffer += delta;
    const completed: string[] = [];

    for (;;) {
      const cut = this.nextCutIndex();
      if (cut === null) break;

      const candidate = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);

      if (candidate.length === 0) continue;

      completed.push(candidate);
      this.isFirstChunk = false;
    }

    return completed;
  }

  /** Call once the LLM stream has ended; returns any trailing partial sentence, if non-empty. */
  flush(): string | undefined {
    const remainder = this.buffer.trim();
    this.buffer = "";
    this.isFirstChunk = true;
    return remainder.length > 0 ? remainder : undefined;
  }

  /**
   * Index the buffer should be cut at, or null to keep buffering.
   */
  private nextCutIndex(): number | null {
    const minLength = this.isFirstChunk ? MIN_FIRST_CHUNK_LENGTH : MIN_CHUNK_LENGTH;

    const sentence = SENTENCE_BOUNDARY.exec(this.buffer);
    if (sentence) {
      const end = sentence.index + sentence[0].length;
      // Long enough to be worth its own synthesis call — cut here.
      if (this.buffer.slice(0, end).trim().length >= minLength) return end;
      // Otherwise fall through: this was an abbreviation or stray
      // punctuation, so keep accumulating (unless we're over the cap).
    }

    // Latency guard for the very first chunk: a clause boundary is a
    // natural enough place to breathe, and it gets audio to the caller
    // a full sentence sooner.
    if (this.isFirstChunk) {
      const clause = CLAUSE_BOUNDARY.exec(this.buffer);
      if (clause) {
        const end = clause.index + clause[0].length;
        if (this.buffer.slice(0, end).trim().length >= MIN_FIRST_CLAUSE_LENGTH) return end;
      }
    }

    // The model is producing a run-on with no usable punctuation. Cut
    // at the last word boundary rather than let the caller wait for
    // the entire reply to finish generating.
    const forcedCutAt = this.isFirstChunk
      ? MAX_FIRST_BUFFER_BEFORE_FORCED_CUT
      : MAX_BUFFER_BEFORE_FORCED_CUT;
    if (this.buffer.length >= forcedCutAt) {
      const lastSpace = this.buffer.lastIndexOf(" ", forcedCutAt);
      return lastSpace > minLength ? lastSpace + 1 : this.buffer.length;
    }

    return null;
  }
}
