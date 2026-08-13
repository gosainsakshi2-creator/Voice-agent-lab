/**
 * turn-detection.ts
 *
 * Adaptive end-of-turn ("endpointing") detection for the streaming
 * pipeline. The platform's `TranscriptSegment` shape only exposes
 * per-segment timing (`startedAtMs`/`endedAtMs`) and an `isFinal`
 * flag — there is no raw audio-energy/VAD signal in this
 * architecture (see `AudioPayload`, which is deliberately opaque
 * bytes). This detector works with the signal that IS available:
 * the gap between successive transcript segments.
 *
 * A fixed silence timeout either cuts off slow, thoughtful speakers
 * or feels sluggish for fast, clipped speakers. This detector starts
 * at a sensible default and nudges its threshold toward the user's
 * own observed inter-utterance pause length as the call progresses,
 * within safe bounds — the "adaptive turn detection" requirement.
 *
 * On top of the silence timer it also looks at WHAT was said, not
 * just how long the caller has been quiet. A short pause after
 * "...aur mujhe" or "...because" is a caller mid-thought, not a
 * finished turn, and replying there is the most common way a voice
 * agent ends up talking over the user. Those pauses get a bounded
 * extra grace window; a pause after a complete clause endpoints at
 * the normal threshold, so finished turns still get a fast reply.
 *
 * Finalisation itself is two-stage. The silence window expiring is
 * evidence the caller finished, not proof: transcripts trail the audio,
 * so the caller may already have resumed speaking when it expires. The
 * turn is therefore held for a short confirmation window before it is
 * released to the LLM, and any segment arriving in that window cancels
 * the release and returns to listening. Nothing in this file is part of
 * barge-in — that path only exists once the assistant is SPEAKING, and
 * is untouched by everything here.
 */

import type { TranscriptSegment } from "../../types/provider.types";

const DEFAULT_SILENCE_TIMEOUT_MS = 1100;
/**
 * Floor for the adaptive threshold.
 *
 * `adaptTimeout` only ever eases DOWN toward a gap the caller paused
 * for and then talked through, but a run of short chunk-boundary gaps
 * still dragged the threshold toward this floor over the course of a
 * call — and a 400ms threshold cuts off anyone drawing breath in the
 * middle of a sentence. 700ms is the shortest pause that is still
 * plausibly an end of turn rather than a breath; the post-speech
 * confirmation window below covers the rest.
 */
const MIN_SILENCE_TIMEOUT_MS = 700;
const MAX_SILENCE_TIMEOUT_MS = 1600;
/** How strongly a single observed gap nudges the running estimate DOWN (0..1). */
const ADAPTATION_RATE = 0.25;
/**
 * Smallest gap between two finals that can plausibly be a PAUSE.
 *
 * Deepgram emits several `is_final` chunks inside one continuous
 * utterance — it finalises words once it will no longer revise them,
 * which happens at chunk boundaries, not only at endpoints. The gap
 * across such a boundary is near zero: the caller never stopped
 * talking. Feeding those boundaries to `adaptTimeout` made every long
 * sentence look like a rapid-fire series of tiny pauses and dragged
 * the threshold down toward its floor WHILE the caller was still
 * speaking, so the longer the sentence the sooner it was cut off.
 * Anything below this is speech, not silence, and teaches us nothing.
 */
const MIN_OBSERVABLE_PAUSE_MS = 300;
/**
 * Head-room kept above the caller's observed pause length. A gap only
 * reaches `adaptTimeout` if the caller paused and then CARRIED ON, so
 * the threshold must sit comfortably above it — landing exactly on it
 * means the next pause of the same length ends the turn mid-sentence.
 */
const PAUSE_SAFETY_MARGIN_MS = 250;
/** Extra wait granted when the pending text is clearly an unfinished thought. */
const CONTINUATION_GRACE_MS = 800;
/**
 * Hard cap on consecutive grace windows. Without it, a caller who
 * trails off on "and..." and then goes quiet would never get a reply.
 */
const MAX_CONTINUATION_GRACES = 2;

/**
 * ---------------- Post-speech confirmation ----------------
 *
 * The silence window expiring is EVIDENCE that the caller finished,
 * not proof of it. Transcripts trail the audio by a few hundred ms, so
 * at the moment the window expires the caller may already have resumed
 * speaking and Deepgram simply hasn't reported it yet — which is
 * exactly how a reply lands on top of "...ask the necessary".
 *
 * So finalisation is two-stage: the silence window expires, then the
 * turn is held for one short confirmation window before it is released
 * to the LLM. Any segment arriving in that window — interim or final —
 * cancels the pending finalisation and returns to plain listening (see
 * `feed`). Nothing here touches barge-in: this stage only runs while
 * the caller has the turn, and the assistant is not speaking.
 */
const CONFIRMATION_WINDOW_MS = 300;
/**
 * A turn with no sentence-final punctuation is the likelier mid-thought
 * pause, so it gets the longer hold. Still bounded — this is a
 * confirmation, not another silence window.
 */
const OPEN_ENDED_CONFIRMATION_WINDOW_MS = 550;
/**
 * A short, fully-punctuated utterance ("Haan.", "Yes, that's right.")
 * is released with NO confirmation hold, so quick confirmations keep
 * exactly the latency they have today.
 */
const SHORT_COMPLETE_TURN_MAX_WORDS = 4;
/**
 * Bounded re-waits while Deepgram still owes a final for words it has
 * already shown as interim. Without the bound, an interim that never
 * finalises (dropped socket, noise) would hold the turn forever.
 */
const MAX_INTERIM_CONFIRMATIONS = 2;

/**
 * Words that cannot end a finished thought — conjunctions, particles,
 * prepositions, determiners, and dangling possessives, in English,
 * Hindi, and Hinglish transliteration.
 *
 * Split into HARD and SOFT because Deepgram is asked for `punctuate`
 * + `smart_format`, and it routinely closes a mid-thought `is_final`
 * chunk with a full stop ("...it was something around."). Terminal
 * punctuation therefore is NOT evidence the caller finished, so the
 * HARD set is checked ahead of it; only the ambiguous SOFT set defers
 * to punctuation.
 *
 * Both sets deliberately EXCLUDE words that legitimately end an
 * Indian-English or Hinglish utterance ("hai", "hain", "theek hai",
 * "haan", "nahi"), which would otherwise add grace latency to every
 * short confirmation.
 */

/**
 * Closed-class words that essentially never end a spoken utterance.
 * A trailing one of these means the caller is mid-thought whatever the
 * punctuation says.
 */
const HARD_CONTINUATION_WORDS = [
  // English — conjunctions, prepositions, determiners, possessives
  "and", "but", "so", "or", "because", "if",
  "the", "a", "an", "to", "of", "for", "with",
  "about", "around", "at", "on", "from", "into", "than", "like",
  "such as", "kind of", "sort of",
  "my", "our", "your", "their",
  // Hinglish (transliterated)
  "aur", "ya", "toh", "par", "lekin", "kyunki", "kyonki", "matlab",
  "agar", "jo", "jab", "ki", "ke", "ka",
  "mera", "meri", "mere", "mujhe", "hamara", "apna", "apne",
  "karke", "liye",
  // Devanagari
  "और", "या", "तो", "पर", "लेकिन", "क्योंकि", "मतलब", "अगर",
  "कि", "जो", "जब", "मेरा", "मेरी", "मुझे", "लिये", "लिए",
];

/**
 * Words that USUALLY dangle but can legitimately close an utterance
 * ("I already told you that.", "Tell me when.", "Yes, I think so."),
 * so these only signal an unfinished thought when the recognized text
 * carries no sentence-final punctuation.
 */
const SOFT_CONTINUATION_WORDS = [
  // English
  "that", "which", "while", "when",
  "i", "we", "you", "is", "are", "was", "were",
  "means", "maybe", "want", "need", "think",
  // Hinglish (transliterated)
  "main", "hum", "woh", "yeh", "ye", "bas", "phir", "fir", "tab",
  // Devanagari
  "तब", "मैं", "हम", "फिर", "बस",
];

/** Characters that may sit between the last word and the end of the text. */
const TRAILING_NOISE = /[\s.,;:!?…।"'’)\]\-—–]+$/u;

/** Builds a matcher for "the final word of the text is one of these". */
function trailingWordMatcher(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[\\s,;:"'’(\\[\\-—–])(?:${words.join("|")})$`, "iu");
}

const HARD_TRAILING = trailingWordMatcher(HARD_CONTINUATION_WORDS);
const SOFT_TRAILING = trailingWordMatcher(SOFT_CONTINUATION_WORDS);

/** Non-lexical hesitation sounds — never a complete turn on their own. */
const FILLER_ONLY = new RegExp(
  `^(?:(?:u+m+h?|u+h+|h+m+|m+h*|e+r+m?|a+h+|a+a+|हम्म|अं|उम्म)[\\s,.!?…।-]*)+$`,
  "iu",
);

/** Sentence-final punctuation (Latin + Devanagari danda) marks a complete thought. */
const TERMINAL_PUNCTUATION = /[.!?।]["')\]]?$/u;

/**
 * True when the accumulated turn text reads as a thought still in
 * progress, so the detector should keep listening a little longer.
 *
 * Order matters. The HARD set is tested FIRST, on the text with its
 * trailing punctuation stripped, because Deepgram's punctuation is a
 * formatting decision about the chunk it just finalised — not a
 * judgement that the caller is done. "...it was something around."
 * arrives fully punctuated and is still obviously mid-sentence.
 * Punctuation only gets the final say for the ambiguous SOFT set,
 * where a full stop really does distinguish "I told you that." from
 * "the transaction that".
 */
function looksIncomplete(text: string): boolean {
  const lastWordText = text.replace(TRAILING_NOISE, "");
  if (HARD_TRAILING.test(lastWordText)) return true;
  if (TERMINAL_PUNCTUATION.test(text)) return false;
  return SOFT_TRAILING.test(lastWordText);
}

export interface TurnDetectionEvent {
  /** The accumulated final transcript text for the completed turn. */
  readonly text: string;
  /** Wall-clock ms from the first segment of this turn to endpointing. */
  readonly turnDurationMs: number;
}

/**
 * Feed transcript segments in as they arrive (partial or final);
 * receive an `onTurnEnd` callback exactly once per detected user
 * turn. Callers own the timer clock via `now()` injection so this
 * class is trivially testable without real wall-clock delays.
 */
export class AdaptiveTurnDetector {
  private silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS;
  private pendingFinalText = "";
  private turnStartedAtMs: number | null = null;
  private lastSegmentAtMs: number | null = null;
  private lastFinalEndedAtMs: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive continuation graces spent on the current turn. */
  private continuationGraces = 0;
  /**
   * Which window the armed timer belongs to: the adaptive silence
   * window, or the short post-speech confirmation that follows it.
   */
  private stage: "silence" | "confirming" = "silence";
  /**
   * True while Deepgram has shown interim words it has not finalised
   * yet. Those words belong to this turn — a turn is NEVER built from
   * interim text, so finalising with one outstanding would drop them
   * and reply to half a sentence.
   */
  private pendingInterim = false;
  /** Consecutive confirmation re-waits spent on an outstanding interim. */
  private interimConfirmations = 0;
  private readonly listeners = new Set<(event: TurnDetectionEvent) => void>();
  /**
   * A turn that ended while nobody was subscribed. The pipeline only
   * subscribes for the duration of `acquireNextUserTurn`, so a turn
   * that endpoints during the barge-in unwind (aborting the LLM/TTS
   * streams, recording the assistant turn) would otherwise be emitted
   * into an empty listener set and silently dropped — losing exactly
   * the words the caller interrupted with. Hold it until someone
   * subscribes instead.
   */
  private pendingEvent: TurnDetectionEvent | null = null;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly immediateOnFinal = false,
  ) {}

  onTurnEnd(listener: (event: TurnDetectionEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.pendingEvent !== null) {
      const buffered = this.pendingEvent;
      this.pendingEvent = null;
      // Deliver on a microtask, never synchronously during subscribe —
      // callers assign the returned unsubscribe function *after* this
      // call returns and invoke it from inside the listener.
      queueMicrotask(() => listener(buffered));
    }
    return () => this.listeners.delete(listener);
  }

  /** Feed a new transcript segment (partial or final) into the detector. */
  feed(segment: TranscriptSegment): void {
    const nowMs = this.now();

    if (this.turnStartedAtMs === null) {
      this.turnStartedAtMs = nowMs;
    }
    this.lastSegmentAtMs = nowMs;

    // New speech — of ANY kind — cancels a pending turn-finalisation
    // and puts the detector back to plain listening. This is the whole
    // point of the confirmation stage: the caller carried on, so the
    // turn that was about to be released is not a turn.
    this.stage = "silence";
    this.interimConfirmations = 0;
    // A final covers every interim that preceded it; an interim means
    // Deepgram now owes us one.
    this.pendingInterim = !segment.isFinal;

    if (segment.isFinal) {
      this.pendingFinalText =
        this.pendingFinalText.length > 0
          ? `${this.pendingFinalText} ${segment.text}`.trim()
          : segment.text;

      if (this.lastFinalEndedAtMs !== null) {
        const observedGapMs = segment.startedAtMs - this.lastFinalEndedAtMs;
        // Only real silences count. A sub-threshold gap is Deepgram
        // closing a chunk mid-sentence while the caller talks straight
        // through it — treating that as a pause is what made the
        // threshold collapse over the course of a long utterance.
        if (observedGapMs >= MIN_OBSERVABLE_PAUSE_MS) {
          this.adaptTimeout(observedGapMs);
        }
      }

      this.lastFinalEndedAtMs = segment.endedAtMs;
      // The thought is still progressing, so previously-spent graces
      // shouldn't count against the words that come next.
      this.continuationGraces = 0;

      // Deepgram already decides when the user has finished speaking.
      // Don't wait for another full silence window — but still let
      // `emitTurnEnd` hold the turn open if the text is mid-thought.
      if (this.immediateOnFinal) {
        this.clearTimer();
        this.emitTurnEnd();
        return;
      }
    }

    this.rearmTimer();
  }

  /** Force an immediate end-of-turn (e.g. the caller detected hard silence via another signal). */
  forceEndTurn(): void {
    this.clearTimer();
    this.emitTurnEnd(true);
  }

  /** Discards any in-progress turn without emitting — used when a session ends mid-utterance. */
  reset(): void {
    this.clearTimer();
    this.pendingFinalText = "";
    this.turnStartedAtMs = null;
    this.lastSegmentAtMs = null;
    // Must be cleared with the rest of the turn. Left set, the first
    // final of the NEXT turn measures its gap back to the previous
    // turn — a span that contains the assistant's entire reply — and
    // adapts as if the caller had paused for that whole time.
    this.lastFinalEndedAtMs = null;
    this.continuationGraces = 0;
    this.stage = "silence";
    this.pendingInterim = false;
    this.interimConfirmations = 0;
  }

  getCurrentSilenceTimeoutMs(): number {
    return this.silenceTimeoutMs;
  }

  /**
   * DISPLAY ONLY: the final segments accumulated for the turn still in
   * progress, so a caller whose utterance spans several Deepgram finals
   * can be shown as the one growing utterance it is. Read by nothing
   * that makes a turn, barge-in or LLM decision.
   */
  getPendingTurnText(): string {
    return this.pendingFinalText;
  }

  private rearmTimer(delayMs: number = this.silenceTimeoutMs): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.emitTurnEnd(), delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * @param force Skip the "is this thought finished?" check — used by
   *   `forceEndTurn`, where an external signal has already decided.
   */
  private emitTurnEnd(force = false): void {
    const text = this.pendingFinalText.trim();

    if (text.length === 0) {
      this.reset();
      return;
    }

    if (!force) {
      // A hesitation sound is not a turn. Drop it and keep listening;
      // if the caller stays silent the next timer fires with empty
      // text and the turn is discarded, so this can't hang.
      if (FILLER_ONLY.test(text)) {
        this.pendingFinalText = "";
        this.stage = "silence";
        this.rearmTimer();
        return;
      }

      // Mid-thought pause — give the caller room to finish.
      if (looksIncomplete(text) && this.continuationGraces < MAX_CONTINUATION_GRACES) {
        this.continuationGraces += 1;
        this.rearmTimer(CONTINUATION_GRACE_MS);
        return;
      }

      // Post-speech confirmation. The silence window says the caller
      // stopped; hold the turn for one short window before releasing it
      // so speech already in flight can still arrive and cancel it (see
      // `feed`). `confirmationWindowMs` returns 0 for the cases that
      // should keep today's latency, and one expired window releases the
      // turn — this is a confirmation, not a second silence window.
      if (this.stage === "silence") {
        const confirmationMs = this.confirmationWindowMs(text);
        if (confirmationMs > 0) {
          this.stage = "confirming";
          this.rearmTimer(confirmationMs);
          return;
        }
      } else if (this.pendingInterim && this.interimConfirmations < MAX_INTERIM_CONFIRMATIONS) {
        // The confirmation window passed quietly, but Deepgram still
        // owes a final for words it has already shown as interim — it
        // has recognized more of this turn than we hold. Wait for it
        // rather than sending a partial turn to the LLM.
        this.interimConfirmations += 1;
        this.rearmTimer(CONFIRMATION_WINDOW_MS);
        return;
      }
    }

    const turnDurationMs =
      this.turnStartedAtMs !== null && this.lastSegmentAtMs !== null
        ? this.lastSegmentAtMs - this.turnStartedAtMs
        : 0;

    const event: TurnDetectionEvent = { text, turnDurationMs };
    this.reset();
    if (this.listeners.size === 0) {
      this.pendingEvent = event;
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  /**
   * How long to hold a turn the silence window has already declared
   * over. `0` releases it immediately — i.e. exactly the behaviour
   * this detector had before the confirmation stage existed.
   */
  private confirmationWindowMs(text: string): number {
    // Words the caller has already spoken are still awaiting their
    // final. Always wait — this is never a finished turn.
    if (this.pendingInterim) return CONFIRMATION_WINDOW_MS;
    // A turn that already spent a continuation grace has had its extra
    // listening time (and then some); don't stack another window on it.
    if (this.continuationGraces > 0) return 0;

    const endsCompletely = TERMINAL_PUNCTUATION.test(text);
    const wordCount = text.split(/\s+/).length;
    // Genuinely completed short turns — "Haan.", "Yes, that's right." —
    // are released with no added latency, as before.
    if (endsCompletely && wordCount <= SHORT_COMPLETE_TURN_MAX_WORDS) return 0;
    return endsCompletely ? CONFIRMATION_WINDOW_MS : OPEN_ENDED_CONFIRMATION_WINDOW_MS;
  }

  /**
   * @param observedGapMs A silence the caller paused for and then kept
   *   talking through — i.e. proof this pause length must NOT end a turn.
   */
  private adaptTimeout(observedGapMs: number): void {
    const target = Math.min(
      Math.max(observedGapMs + PAUSE_SAFETY_MARGIN_MS, MIN_SILENCE_TIMEOUT_MS),
      MAX_SILENCE_TIMEOUT_MS,
    );
    // Asymmetric on purpose. Raise on the FIRST such pause: easing up
    // by a fraction of the gap leaves the threshold below the pause we
    // just watched the caller take, so their very next one cuts them
    // off mid-sentence. Come back down gradually, so one thoughtful
    // pause doesn't make the rest of the call feel sluggish.
    const next =
      target > this.silenceTimeoutMs
        ? target
        : this.silenceTimeoutMs + (target - this.silenceTimeoutMs) * ADAPTATION_RATE;
    this.silenceTimeoutMs = Math.min(Math.max(next, MIN_SILENCE_TIMEOUT_MS), MAX_SILENCE_TIMEOUT_MS);
  }
}
