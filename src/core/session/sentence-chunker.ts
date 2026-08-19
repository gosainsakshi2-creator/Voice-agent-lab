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
 * Four things matter for how a reply SOUNDS on a phone call:
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
 *  - EVERY chunk boundary is heard. A chunk is one independent TTS
 *    request, and every TTS engine renders a request as a complete
 *    utterance: falling intonation and its own trailing silence at the
 *    end, its own leading silence at the start of the next one, plus
 *    the round trip needed to fetch it. A cut that lands inside a
 *    phrase is therefore not merely a seam — it is an audible,
 *    unnatural pause in the middle of a sentence. So a cut is only
 *    placed where a speaker would actually breathe: a sentence end,
 *    or failing that a clause end. A bare word boundary is a last
 *    resort for genuine run-ons, never a routine cut point.
 *
 *  - A run-on reply with no sentence-final punctuation must still be
 *    cut somewhere, or the caller hears nothing until the whole reply
 *    has generated. `MAX_BUFFER_BEFORE_FORCED_CUT` bounds that.
 */

/**
 * Sentence-final punctuation, including the Devanagari danda.
 *
 * The trailing `\s+` is REQUIRED, and deliberately has no `|$`
 * alternative. While a stream is still arriving, "the buffer ends
 * here" is not evidence that the sentence ended — it only means the
 * next delta has not landed yet. Accepting end-of-buffer as a
 * boundary cut inside numbers and abbreviations whenever a delta
 * happened to break there: "...also get 1." / "5 lakh+ worth...",
 * "...join TODAY at 7." / "30 PM", "Rs." / "2999" — each side a
 * separate TTS request, so the caller heard a pause in the middle of
 * the figure. Waiting for the following whitespace costs one delta
 * (~30-80ms) and removes that whole class of mid-word splits. A reply
 * whose last sentence has no trailing whitespace is still spoken:
 * `flush()` returns the remainder once the stream ends.
 */
const SENTENCE_BOUNDARY = /([.!?।]+)(\s+)/u;
/** Clause-level boundary — only used to cut the first chunk sooner. */
const CLAUSE_BOUNDARY = /([,;:—–]|।)(\s+)/u;

/**
 * Minimum length of a NON-first chunk.
 *
 * 12 characters is two or three words, and a chunk is one whole TTS
 * request. For a provider with no streaming endpoint (Cartesia and
 * Smallest AI both expose only `synthesize()`), a two-word request
 * buys ~0.5s of audio for a full round trip of request latency — not
 * enough to keep the transport's outbound queue fed across the
 * boundary, so the caller hears a gap after every short sentence even
 * though the pipeline is already synthesizing the next one.
 *
 * 60 characters is a natural clause-to-sentence span (~10 words) and
 * merges runs of very short sentences ("Yes. No problem.") into one
 * continuous request. Sentence boundaries are still the only cut
 * points, so nothing is spliced mid-phrase and pronunciation is
 * unchanged; `MAX_BUFFER_BEFORE_FORCED_CUT` still bounds the wait.
 *
 * Time-to-first-audio is untouched — the first chunk uses
 * `MIN_FIRST_CHUNK_LENGTH` / `MIN_FIRST_CLAUSE_LENGTH` below.
 */
const MIN_CHUNK_LENGTH = 60;
/** The first chunk may be shorter: getting audio started beats chunk size. */
const MIN_FIRST_CHUNK_LENGTH = 8;
/**
 * Only cut the first chunk at a clause boundary once the clause is
 * long enough to pay for the cut.
 *
 * A clause cut buys latency but costs a seam, so it is only worth it
 * when the clip it produces outlasts the round trip needed to
 * synthesize what follows. At roughly 22 characters per second of
 * speech, 24 characters is ~1.1s of audio against a 0.8-2.5s batch
 * synthesis call — the transport ran dry every time, so the "cheap"
 * early cut paid for itself with a silence immediately afterwards.
 * 40 characters (~1.9s) covers a normal round trip; anything shorter
 * now simply waits for the sentence to finish, which is both smoother
 * and, once the gap it used to cause is counted, no slower.
 */
const MIN_FIRST_CLAUSE_LENGTH = 40;
/**
 * Beyond this, cut without waiting for a sentence to end.
 *
 * 160 was too tight: an ordinary merged two-sentence span in the
 * approved script measures ~156 characters, so a reply a few words
 * longer was force-cut at a bare word boundary — mid-phrase, and
 * therefore heard as a pause in the middle of a sentence. This is a
 * safety valve for genuine run-ons, not a routine cut point, so it
 * belongs well clear of normal sentence lengths. Audio is already
 * playing by the time a non-first chunk is buffering, so the extra
 * headroom costs the caller no latency at all.
 */
const MAX_BUFFER_BEFORE_FORCED_CUT = 240;
/**
 * The same safety valve for the first chunk, where the caller IS
 * waiting.
 *
 * 90 characters sat below the length of almost every sentence in the
 * approved script (88-160 characters), so the first chunk of nearly
 * every turn was guillotined at a bare word boundary — "...with
 * Saurabh Sir happening" / "TODAY at 7:30 PM." — and the seam between
 * those two TTS requests was heard as a long, unnatural pause between
 * two words of one phrase. 180 lets a normal sentence reach its full
 * stop and be synthesized as one continuous utterance. The clause
 * escape above still cuts a comma-led opening early, so
 * time-to-first-audio on the common conversational reply is unchanged.
 */
const MAX_FIRST_BUFFER_BEFORE_FORCED_CUT = 180;

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
    // it rather than let the caller wait for the entire reply to
    // finish generating — but land the cut on the most natural break
    // available, because this one WILL be heard: prefer the last
    // clause boundary inside the window, and fall back to a bare word
    // boundary only when the run-on carries no punctuation at all.
    const forcedCutAt = this.isFirstChunk
      ? MAX_FIRST_BUFFER_BEFORE_FORCED_CUT
      : MAX_BUFFER_BEFORE_FORCED_CUT;
    if (this.buffer.length >= forcedCutAt) {
      const lastClause = this.lastClauseEndWithin(forcedCutAt);
      if (lastClause !== null && lastClause > minLength) return lastClause;

      const lastSpace = this.buffer.lastIndexOf(" ", forcedCutAt);
      return lastSpace > minLength ? lastSpace + 1 : this.buffer.length;
    }

    return null;
  }

  /**
   * End index of the LAST clause boundary at or before `limit`, or
   * null when the window contains none. A fresh global regex is built
   * per scan so the shared `CLAUSE_BOUNDARY` literal never carries
   * `lastIndex` state between calls.
   */
  private lastClauseEndWithin(limit: number): number | null {
    const window = this.buffer.slice(0, limit);
    const scanner = new RegExp(CLAUSE_BOUNDARY.source, "gu");
    let end: number | null = null;
    for (;;) {
      const match = scanner.exec(window);
      if (match === null) break;
      end = match.index + match[0].length;
    }
    return end;
  }
}
