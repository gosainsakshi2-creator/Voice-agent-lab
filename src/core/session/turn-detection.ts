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
 */

import type { TranscriptSegment } from "../../types/provider.types";

const DEFAULT_SILENCE_TIMEOUT_MS = 650;
const MIN_SILENCE_TIMEOUT_MS = 400;
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
const CONTINUATION_GRACE_MS = 550;
/**
 * Hard cap on consecutive grace windows. Without it, a caller who
 * trails off on "and..." and then goes quiet would never get a reply.
 */
const MAX_CONTINUATION_GRACES = 2;

/**
 * Words that cannot end a finished thought — conjunctions, particles,
 * determiners, and dangling subjects/possessives, in English, Hindi,
 * and Hinglish transliteration.
 *
 * Deliberately EXCLUDES words that legitimately end an Indian-English
 * or Hinglish utterance ("hai", "hain", "theek hai", "haan", "nahi"),
 * which would otherwise add grace latency to every short confirmation.
 */
const CONTINUATION_WORDS = [
  // English
  "and", "but", "so", "or", "because", "that", "if", "which", "while",
  "the", "a", "an", "to", "of", "for", "with", "about",
  "my", "our", "your", "i", "we", "you",
  "is", "are", "was", "were", "like", "means", "maybe",
  "want", "need", "think",
  // Hinglish (transliterated)
  "aur", "ya", "toh", "par", "lekin", "kyunki", "kyonki", "matlab",
  "agar", "jo", "jab", "tab", "ki", "ke", "ka",
  "mera", "meri", "mere", "mujhe", "hamara", "apna", "apne",
  "main", "hum", "woh", "yeh", "ye", "bas", "phir", "fir",
  "karke", "liye",
  // Devanagari
  "और", "या", "तो", "पर", "लेकिन", "क्योंकि", "मतलब", "अगर",
  "कि", "जो", "जब", "तब", "मेरा", "मेरी", "मुझे", "मैं", "हम",
  "फिर", "बस", "लिये", "लिए",
];

/** Matches a trailing continuation word at the very end of the text. */
const TRAILING_CONTINUATION = new RegExp(
  `(?:^|[\\s,;:-])(?:${CONTINUATION_WORDS.join("|")})\\s*$`,
  "iu",
);

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
 */
function looksIncomplete(text: string): boolean {
  if (TERMINAL_PUNCTUATION.test(text)) return false;
  return TRAILING_CONTINUATION.test(text);
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
  }

  getCurrentSilenceTimeoutMs(): number {
    return this.silenceTimeoutMs;
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
        this.rearmTimer();
        return;
      }

      // Mid-thought pause — give the caller room to finish.
      if (looksIncomplete(text) && this.continuationGraces < MAX_CONTINUATION_GRACES) {
        this.continuationGraces += 1;
        this.rearmTimer(CONTINUATION_GRACE_MS);
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
