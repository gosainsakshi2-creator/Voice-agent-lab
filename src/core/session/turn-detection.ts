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
/** Same fast path for a short, explicitly-marked question. */
const SHORT_QUESTION_MAX_WORDS = 8;
/**
 * Bounded re-waits while Deepgram still owes a final for words it has
 * already shown as interim. Without the bound, an interim that never
 * finalises (dropped socket, noise) would hold the turn forever.
 */
const MAX_INTERIM_CONFIRMATIONS = 2;

/**
 * ---------------- Chunk-boundary finals ----------------
 *
 * `is_final` and `speech_final` are different claims. Deepgram sets
 * `is_final` the moment it will no longer revise a run of words — a
 * CHUNK BOUNDARY, emitted repeatedly while the caller is still
 * talking. It sets `speech_final` only when its own endpointer decides
 * speech has actually stopped.
 *
 * Treating the two alike is what let "I'm going to..." be released as
 * a finished turn: a chunk boundary landed, the silence window ran,
 * and the caller's next breath arrived to find their thought already
 * answered. So a final that is NOT endpointed does not release a turn;
 * it buys one more bounded window for the endpointed final to arrive.
 *
 * This costs a genuinely finished turn NOTHING, because a finished
 * turn ends with `speech_final: true` and never reaches this branch.
 * The bound covers the pathological case — constant background noise
 * or a dropped socket, where the endpointer may never fire — so the
 * caller still gets a reply, just one window later.
 */
const CHUNK_BOUNDARY_GRACE_MS = 700;
/** Deliberately ONE: caps added latency when `speech_final` never comes. */
const MAX_CHUNK_BOUNDARY_GRACES = 1;

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
  // Subordinators that open a clause the caller has not closed yet.
  // "Can you tell me whether..." is the canonical one: it reads as a
  // finished sentence to a silence timer and is obviously not.
  "whether", "unless", "until", "till", "although", "though",
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

/**
 * Phrases that are a caller ASKING FOR TIME, not taking a turn.
 *
 * "Wait", "actually", "hold on", "let me think" spoken on their own are
 * the caller announcing that more is coming — replying to one of them
 * is the most literal possible way to talk over someone. Matched only
 * when the phrase is the WHOLE pending turn: "Actually, will there be
 * any charges?" is a complete question and must still get a fast reply.
 *
 * They also get a longer grace than an ordinary dangling word, because
 * the caller has explicitly said they need a moment.
 */
const HOLD_PHRASES = [
  "wait", "wait a (?:second|minute|sec|moment)", "hold on", "hang on",
  "one (?:second|minute|sec|moment)", "just a (?:second|minute|sec|moment)",
  "give me a (?:second|minute|sec|moment)",
  "let me think", "let me check", "let me see", "i mean", "actually",
  "the thing is", "so basically", "how do i say (?:it|this)",
  // Hinglish / Devanagari
  "ruko", "ruk(?:iye|o) zara", "thoda ruko", "ek (?:minute|second|sec|min)",
  "sochne do", "matlab ki",
  "रुको", "रुकिए", "एक मिनट", "एक सेकंड", "मतलब",
];

/** The whole pending turn is one of `HOLD_PHRASES`. */
const HOLD_PHRASE_ONLY = new RegExp(
  `^(?:${HOLD_PHRASES.join("|")})[\\s,.!?…।-]*$`,
  "iu",
);

/** Extra wait granted when the caller has asked for a moment. */
const HOLD_GRACE_MS = 1200;

/**
 * Punctuation that ends a FRAGMENT rather than a sentence. Deepgram
 * emits these when the caller trailed off or is still listing details
 * ("The transaction happened around,"), and a comma is never the end of
 * a thought.
 */
const MID_THOUGHT_PUNCTUATION = /(?:[,;:]|\.\.\.|…|[-–—])["')\]]?$/u;

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

/** A finished question — stronger completion evidence than a full stop. */
const QUESTION_ENDING = /\?["')\]]?$/u;

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
 *
 * A QUESTION MARK is the exception to all of that, and it is the same
 * exception `confirmationWindowMs` already makes for the same reason: a
 * full stop is a formatting decision Deepgram sprinkles on mid-thought
 * chunks, but a question mark is a claim about the shape of the whole
 * utterance, and a finished question is a finished thought. Without
 * this, English and Hinglish questions that legitimately END on a word
 * in the HARD set — "What is this event about?", "Who is it for?",
 * "Kitne baje se hai on?" — were read as mid-sentence pauses and spent
 * the full silence window plus both continuation graces before
 * releasing: ~2.7s to answer a six-word question, measured. Ending a
 * question on a preposition is ordinary speech, not a trailing off.
 */
function looksIncomplete(text: string): boolean {
  // A comma, a dash or a trailing ellipsis ends a fragment, never a
  // thought — the caller is still adding to it. Still checked first, so
  // fragment punctuation keeps precedence over everything below it.
  if (MID_THOUGHT_PUNCTUATION.test(text)) return true;
  // A finished question is a finished thought, whatever word it landed
  // on. See the note above.
  if (QUESTION_ENDING.test(text)) return false;
  const lastWordText = text.replace(TRAILING_NOISE, "");
  if (HARD_TRAILING.test(lastWordText)) return true;
  if (TERMINAL_PUNCTUATION.test(text)) return false;
  return SOFT_TRAILING.test(lastWordText);
}

/**
 * Bare acknowledgements — the sounds a listener makes to show they are
 * still there.
 *
 * These are not turns. Said on their own WHILE the agent is still
 * speaking they are backchannel: "carry on", not "stop, I have
 * something to say". The pipeline uses this to tell that apart from a
 * real interruption (see `ConversationPipeline.startContinuousStt`);
 * this file only owns the vocabulary, because the utterance-shape
 * tables it belongs with — `FILLER_ONLY`, `HOLD_PHRASE_ONLY`,
 * `looksIncomplete` — already live here.
 *
 * Deliberately narrow, and every exclusion is load-bearing:
 *
 *   - No negation. "No", "nahi", "nahin" is an objection and must
 *     interrupt, whatever else is being said.
 *   - No "hello". Mid-reply that means the line has gone bad, and it
 *     must interrupt.
 *   - Nothing with content. Anything beyond the bare token — "ok but",
 *     "haan, kitna hai" — is a real turn and is matched by nothing
 *     here, so it interrupts exactly as it does today.
 *
 * "Yes"/"haan" ARE included, and the pipeline is what makes that safe:
 * it only treats them as backchannel while the agent still has several
 * seconds of its own reply left to speak. An answer to the script's
 * commitment question arrives at or after the end of that reply, and is
 * therefore never matched here.
 */
const ACKNOWLEDGEMENT_TOKENS = [
  // Hesitation sounds, so a stacked backchannel ("hmm okay", "haan
  // hmm") matches as one. `FILLER_ONLY` covers them on their own.
  "hmm", "hm", "mhm", "mhmm", "uh huh", "uh-huh", "mm hmm", "mmhmm",
  // English
  "ok", "okay", "okey", "k", "kk", "right", "alright", "all right",
  "sure", "fine", "correct", "true", "good", "nice", "great", "cool",
  "yes", "yeah", "yep", "yup", "yah", "ya",
  "got it", "i see", "i understand", "understood", "makes sense",
  "carry on", "go on", "go ahead",
  // Hinglish (transliterated)
  "haan", "haa", "ha", "han", "hanji", "han ji", "haan ji", "ji", "ji haan",
  "theek", "theek hai", "thik hai", "sahi", "sahi hai", "achha", "acha",
  "accha", "bilkul", "samajh gaya", "samajh gayi", "samjha", "hmm ji",
  // Devanagari
  "हाँ", "हां", "जी", "जी हाँ", "ठीक", "ठीक है", "अच्छा", "सही",
  "बिल्कुल", "समझ गया", "समझ गई",
];

/**
 * The WHOLE utterance is one bare acknowledgement, optionally repeated
 * ("ok ok", "haan haan") and optionally stacked with a hesitation sound
 * ("hmm okay") — both of which are how people actually backchannel.
 *
 * `FILLER_ONLY` still covers a pure hesitation on its own, so the two
 * tables do not need to duplicate each other.
 */
const ACKNOWLEDGEMENT_ONLY = new RegExp(
  `^(?:(?:${ACKNOWLEDGEMENT_TOKENS.join("|")})[\\s,.!?…।-]*)+$`,
  "iu",
);

/**
 * True when `text` is nothing but acknowledgement — no question, no
 * objection, no content of its own.
 *
 * Says nothing about what should be DONE with it: whether an
 * acknowledgement is backchannel or a real answer depends on when it
 * was said, which only the pipeline knows.
 */
export function isBareAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return ACKNOWLEDGEMENT_ONLY.test(trimmed) || FILLER_ONLY.test(trimmed);
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
  /**
   * Whether the most recent final was Deepgram's endpointer reporting
   * end-of-speech, or merely a chunk boundary mid-utterance.
   *
   * Starts `true` so a provider that reports no such signal behaves
   * exactly as this detector always has.
   */
  private lastFinalWasEndpoint = true;
  /** Consecutive waits spent on a chunk-boundary final for this turn. */
  private chunkBoundaryGraces = 0;
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
      this.chunkBoundaryGraces = 0;
      // Absent means "assume endpointed", so batch STT and providers
      // with no equivalent signal keep their existing behaviour.
      this.lastFinalWasEndpoint = segment.isSpeechFinal ?? true;

      // Deepgram already decides when the user has finished speaking.
      // Don't wait for another full silence window — but still let
      // `emitTurnEnd` hold the turn open if the text is mid-thought.
      if (this.immediateOnFinal) {
        this.clearTimer();
        this.emitTurnEnd();
        return;
      }

      // A fully-punctuated, finished thought that Deepgram's OWN
      // endpointer has closed ("Yes.", "Haan.", "I would like to join
      // the session today.") does not need a full adaptive silence
      // window on top of that decision. Deepgram has already waited
      // out its own `endpointing` window before sending this final, so
      // re-measuring the same silence here counts it twice — and the
      // detector's clock only starts when the final ARRIVES, so the
      // delivery lag is added on top of the double count. That is the
      // single largest avoidable span between the caller's last word
      // and the reply they wait for: ~1.1s by default, up to 1.6s once
      // the threshold has adapted upward, on every completed turn.
      //
      // Only the redundant WAIT is removed. `emitTurnEnd` still runs
      // every release guard it runs today — filler, mid-thought
      // continuation, hold phrases, chunk-boundary grace, the
      // pending-interim re-wait — and it still applies the post-speech
      // confirmation window for this text, so speech already in flight
      // gets a window to arrive and cancel the turn (see `feed`).
      //
      // What is DELIBERATELY excluded keeps exactly the timing it has
      // today, because for these the silence window is not redundant:
      //
      //   - a final Deepgram did NOT endpoint (`speech_final` absent) —
      //     a chunk boundary mid-utterance, which claims nothing about
      //     the caller having stopped;
      //   - text with an outstanding interim — Deepgram has recognised
      //     more of this turn than we hold;
      //   - text that reads as unfinished (`looksIncomplete`: dangling
      //     conjunction, comma, no sentence-final punctuation, "yes,
      //     but…"), a hesitation sound, or a request for a moment.
      //
      // So a caller pausing mid-thought is held for the full window
      // exactly as before; only a thought Deepgram and the text BOTH
      // agree is finished is released on the confirmation window alone.
      if (this.lastFinalWasEndpoint && !this.pendingInterim && this.isCompleteThought()) {
        this.rearmTimer(CONFIRMATION_WINDOW_MS);
        return;
      }
    }

    this.rearmTimer();
  }

  /**
   * The held text is a sentence-final, non-hesitation, finished
   * thought — the same test as before minus the word-count cap.
   *
   * The cap was the reason a completed turn of five words or more still
   * paid a full adaptive silence window it could not learn anything
   * from. Length is not evidence about whether a thought finished:
   * "Yes." and "I would like to join the session today." are both
   * complete, and `looksIncomplete` is what actually separates either
   * of them from "...and I was going to". Word count still decides how
   * long the post-speech CONFIRMATION runs (see `confirmationWindowMs`),
   * which is where it belongs.
   */
  private isCompleteThought(): boolean {
    const text = this.pendingFinalText.trim();
    if (text.length === 0 || FILLER_ONLY.test(text) || HOLD_PHRASE_ONLY.test(text)) return false;
    return TERMINAL_PUNCTUATION.test(text) && !looksIncomplete(text);
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
    this.chunkBoundaryGraces = 0;
    // Back to the permissive default: the next turn has produced no
    // finals yet, so nothing is known about its endpointing.
    this.lastFinalWasEndpoint = true;
  }

  getCurrentSilenceTimeoutMs(): number {
    return this.silenceTimeoutMs;
  }

  /**
   * READ-ONLY: the final segments accumulated for the turn still in
   * progress, so a caller whose utterance spans several Deepgram finals
   * can be shown as the one growing utterance it is.
   *
   * Pure observation — it arms no timer, consumes nothing, clears
   * nothing and touches no threshold. It does NOT decide when a turn
   * ends; the words it returns are still released by `emitTurnEnd`
   * under exactly the guards they always were.
   *
   * Read by the dashboard preview, by
   * `ConversationPipeline.isBackchannel` (which needs the whole
   * utterance, not just the latest segment, to tell an acknowledgement
   * from a real interruption) and by
   * `ConversationPipeline.newerUserTurnWaiting` (non-empty means the
   * caller has resumed speaking, so a reply to the PREVIOUS turn that
   * has not been spoken yet is already stale).
   */
  getPendingTurnText(): string {
    return this.pendingFinalText;
  }

  /**
   * READ-ONLY. True when a COMPLETED turn is already being held for
   * the next subscriber (see `pendingEvent`) — i.e. the caller has
   * finished saying something newer than whatever the pipeline is
   * currently working on.
   *
   * Pure observation. It arms no timer, consumes nothing, clears
   * nothing and touches no threshold: `feed`, `emitTurnEnd`,
   * `adaptTimeout` and every window above are byte-for-byte what they
   * were. The buffered turn is still delivered to whoever subscribes
   * next, exactly as before.
   */
  hasBufferedTurn(): boolean {
    return this.pendingEvent !== null;
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

      // Mid-thought pause — give the caller room to finish. A caller
      // who has explicitly asked for a moment ("wait", "let me think")
      // gets the longer of the two windows.
      const askedForAMoment = HOLD_PHRASE_ONLY.test(text);
      if (
        (askedForAMoment || looksIncomplete(text)) &&
        this.continuationGraces < MAX_CONTINUATION_GRACES
      ) {
        this.continuationGraces += 1;
        this.rearmTimer(askedForAMoment ? HOLD_GRACE_MS : CONTINUATION_GRACE_MS);
        return;
      }

      // Deepgram never declared end-of-speech for the words we hold.
      // The last final it sent was a CHUNK BOUNDARY (`speech_final`
      // absent) — a claim about not revising those words, emitted
      // while the caller is still talking, not a claim that they
      // stopped. Releasing here is precisely how "I'm going to..."
      // becomes a turn of its own and gets answered before "...Manali
      // last week" has been said.
      //
      // A genuinely finished turn ends with `speech_final: true` and
      // never reaches this branch, so finished turns keep exactly the
      // latency they have today. Bounded, so a caller whose endpointer
      // never fires (background noise, dropped socket) still gets a
      // reply one window later rather than never.
      if (
        !this.lastFinalWasEndpoint &&
        this.chunkBoundaryGraces < MAX_CHUNK_BOUNDARY_GRACES
      ) {
        this.chunkBoundaryGraces += 1;
        this.stage = "silence";
        this.rearmTimer(CHUNK_BOUNDARY_GRACE_MS);
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
      // A second turn endpointing before anyone subscribed is the same
      // caller still talking, so it is MERGED into the buffered one
      // rather than replacing it — otherwise the first half of what
      // they said is dropped and the reply answers half a thought.
      this.pendingEvent =
        this.pendingEvent === null
          ? event
          : {
              text: `${this.pendingEvent.text} ${event.text}`.trim(),
              turnDurationMs: this.pendingEvent.turnDurationMs + turnDurationMs,
            };
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
    const endsCompletely = TERMINAL_PUNCTUATION.test(text);

    // A turn that already spent a continuation grace has had its extra
    // listening time (and then some); don't stack another window on it
    // — UNLESS the text still has no sentence-final punctuation. That
    // case is the one that most needs the hold and was the only one
    // being denied it: the caller paused mid-thought (hence the
    // grace), resumed, and stopped again on words Deepgram's own
    // formatter declined to close a sentence on. Releasing there
    // answers a fragment. Still just one short window, so a turn that
    // really did end open-ended is only marginally slower.
    if (this.continuationGraces > 0) {
      return endsCompletely ? 0 : CONFIRMATION_WINDOW_MS;
    }

    const wordCount = text.split(/\s+/).length;
    // Genuinely completed short turns — "Haan.", "Yes, that's right." —
    // are released with no added latency, as before.
    if (endsCompletely && wordCount <= SHORT_COMPLETE_TURN_MAX_WORDS) return 0;
    // A question mark is much stronger evidence than the full stop
    // Deepgram sprinkles on mid-thought chunks: a short question really
    // is a finished question. "What should I do now?" answers at the
    // same speed it always has.
    if (QUESTION_ENDING.test(text) && wordCount <= SHORT_QUESTION_MAX_WORDS) return 0;
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
