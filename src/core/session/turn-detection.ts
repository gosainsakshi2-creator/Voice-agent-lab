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
 * ---------------- Evidence-gated release (PHASE 2) ----------------
 *
 * `CONFIRMATION_WINDOW_MS` above is charged when a turn's completeness
 * has to be INFERRED — the caller went quiet and stayed quiet, so
 * `emitTurnEnd` waits `CONFIRMATION_WINDOW_MS` on the chance more
 * speech is already in flight. But two call sites — `feed`'s fast
 * path and `noteEndOfSpeech`'s release — already hold something
 * stronger than that inference: the provider's OWN endpointer has
 * just this moment declared the caller finished
 * (`lastFinalWasEndpoint`), AND the accumulated text independently
 * reads as a finished thought (`isReleasableThought`). Two agreeing
 * signals, not a guess.
 *
 * Before this, both call sites armed `CONFIRMATION_WINDOW_MS` and then
 * left `stage` at `"silence"` — so when that timer fired, `emitTurnEnd`
 * read it as "the silence window just expired" and ran the INFERENCE
 * confirmation a SECOND time on the same text. For a short turn the
 * second pass returns 0 (harmless). For anything longer than
 * `SHORT_COMPLETE_TURN_MAX_WORDS` it returns another
 * `CONFIRMATION_WINDOW_MS` — so a long, cleanly-endpointed sentence
 * paid the confirmation window TWICE (~600ms) for evidence that was
 * already conclusive after the first ~300ms. That double payment,
 * not the window's size, was the remaining gap between this detector
 * and the ~150–250ms an evidenced release can safely target.
 *
 * The fix is not a second, shorter timeout bolted on top: it is
 * marking `stage = "confirming"` at the SAME two call sites before
 * arming the (now single) window, so `emitTurnEnd` recognises its own
 * fast-lane timer on the way back in and releases directly instead of
 * re-deriving a confirmation it already granted. Word count still
 * tiers the ONE window that remains — short/short-question keeps the
 * least possible hold, everything else gets a little more — exactly
 * as `confirmationWindowMs` already tiers the inference-based window.
 *
 * Every OTHER hold in this file — the adaptive silence window, both
 * continuation graces, the hold-phrase grace, the chunk-boundary
 * grace, the pending-interim re-wait, and `CONFIRMATION_WINDOW_MS`
 * itself for text that reaches confirmation WITHOUT this fresh
 * evidence — is untouched. This only ever shortens the SINGLE class
 * both call sites already required: complete, endpointed, no
 * outstanding interim.
 */
const EVIDENCED_CONFIRMATION_SHORT_MS = 150;
/** The longer of the two evidence-gated tiers — see the block above. */
const EVIDENCED_CONFIRMATION_LONG_MS = 250;
/**
 * ---------------- Evidence outranks punctuation (PHASE 3) ----------
 *
 * The evidence-gated tier for text that carries NO sentence-final
 * punctuation. Before this tier existed, the two evidence call sites
 * required `TERMINAL_PUNCTUATION` (via the old `isCompleteThought`),
 * so an endpointed-but-unpunctuated turn DISCARDED the endpoint claim
 * and fell back to inference: the full adaptive silence window
 * (1100–1600ms) plus the 550ms open-ended confirmation — ~1.7–2.1s of
 * self-inflicted wait, and the single largest avoidable span in the
 * live `stt-to-release` traces (2.9–5.0s once Deepgram's own delivery
 * lag on a noisy line is added). Deepgram in `multi` language mode
 * routinely declines to punctuate Hinglish finals, so this was the
 * COMMON case on real calls, not a corner.
 *
 * The detector's own tables already treat punctuation as a formatting
 * decision, not a judgement that the caller finished (`looksIncomplete`
 * tests the HARD set ahead of a full stop for exactly that reason).
 * Its absence is equally weak evidence. What actually protects a
 * mid-thought pause is `looksIncomplete` — dangling conjunctions,
 * fragment punctuation, hold phrases — and every one of those guards
 * still holds the turn exactly as before (see `isReleasableThought`).
 *
 * 300ms rather than the punctuated tiers' 150/250ms: with punctuation
 * evidence absent, the in-flight-speech cancellation window is the one
 * safety net left, so it gets the largest bounded hold of the three.
 * Combined with the 400ms of real silence Deepgram's endpointer has
 * already measured before making the claim, release requires ~700ms of
 * observed quiet — exactly `MIN_SILENCE_TIMEOUT_MS`, the shortest pause
 * this file already deems plausibly an end of turn.
 */
const EVIDENCED_CONFIRMATION_OPEN_MS = 300;
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
  /**
   * True while the CHUNK-BOUNDARY GRACE is the currently-armed window —
   * as opposed to the adaptive silence window, a continuation grace, a
   * hold grace, or the post-speech confirmation.
   *
   * A dedicated flag rather than a third `stage` value, for two reasons.
   * `stage` is read by `emitTurnEnd` to decide whether the post-speech
   * confirmation is still owed, so adding a value there would silently
   * change the timing of turns that have nothing to do with this. And
   * inferring it from `chunkBoundaryGraces > 0` would be wrong the
   * moment `emitTurnEnd`'s branch order changed — a continuation grace
   * armed after a chunk-boundary grace would be indistinguishable from
   * the grace itself, and `noteEndOfSpeech` would then cut off a caller
   * who is mid-thought. See the collapse site in `noteEndOfSpeech`.
   *
   * Set only where the grace is armed; cleared by `rearmTimer` (so any
   * other window clears it by construction) and by `reset`.
   */
  private chunkBoundaryGraceArmed = false;
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
  /**
   * OBSERVERS of the evidenced confirmation window — see `onTurnPending`.
   * Notified, never consulted: nothing in this detector reads them or
   * changes a decision because one is present.
   */
  private readonly pendingListeners = new Set<(text: string) => void>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly immediateOnFinal = false,
  ) {}

  /**
   * OBSERVATION ONLY: the detector has just armed a window it expects
   * to release `text` at the end of, and nothing more is owed for that
   * text except — at one of the four sites — the provider's endpoint
   * claim. Unless new speech arrives inside that window, `onTurnEnd`
   * will fire with exactly this text when it expires.
   *
   * It is NOT a release and must not be treated as one: `onTurnEnd` is
   * still the only release. New speech of any kind cancels the pending
   * turn exactly as before (`feed` resets `stage`), and no notification
   * is sent for that — a subscriber sees the cancellation as the fed
   * segment itself, or as `onTurnEnd` delivering different text.
   *
   * FOUR call sites fire it, and they split into two classes:
   *
   *   EVIDENCED — the provider's OWN endpointer has explicitly declared
   *   end of speech (`speech_final: true` on the words, or the
   *   standalone marker). `feed`'s fast path, `noteEndOfSpeech`, and
   *   `emitTurnEnd`'s confirmation branch (reached only by the
   *   chunk-boundary-grace collapse). Predicate:
   *   `lastFinalWasEndpoint && !pendingInterim && isReleasableThought()`.
   *
   *   QUIET — `emitTurnEnd`'s chunk-boundary-grace branch. No endpoint
   *   claim has arrived; the grace armed there exists to wait for one.
   *   What stands in its place is the full adaptive silence window
   *   having already expired with no segment of any kind, plus the
   *   filler / hold-phrase / mid-thought guards `emitTurnEnd` runs
   *   above that branch. Predicate: the same one minus
   *   `lastFinalWasEndpoint`, which is `false` by construction there.
   *   It exists because that is the earliest instant a turn's text is
   *   both known and quiet, and therefore the earliest a speculative
   *   request can be built at all.
   *
   * Deliberately NOT fired for: an interim, an `is_final` chunk boundary
   * on arrival (the QUIET site fires a full silence window later, not
   * on the segment), a continuation or hold grace, the pending-interim
   * re-wait, or a provider that reports no endpoint claim at all
   * (`isSpeechFinal` absent — such a provider never reaches the
   * chunk-boundary branch, since `lastFinalWasEndpoint` defaults true).
   *
   * Arms no timer, consumes nothing, clears nothing and touches no
   * threshold — every window in this file is byte-for-byte what it was,
   * and every release lands at the instant it always did.
   */
  onTurnPending(listener: (text: string) => void): () => void {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  }

  private notifyTurnPending(): void {
    if (this.pendingListeners.size === 0) return;
    const text = this.pendingFinalText.trim();
    if (text.length === 0) return;
    for (const listener of this.pendingListeners) listener(text);
  }

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
      //     conjunction, comma, "yes, but…"), a hesitation sound, or a
      //     request for a moment.
      //
      // So a caller pausing mid-thought is held for the full window
      // exactly as before; only a thought Deepgram and the text BOTH
      // agree is finished is released on the confirmation window alone.
      //
      // PHASE 2: `stage` is set to `"confirming"` here, not left at
      // `"silence"`. Two agreeing signals — the provider's own
      // endpointer AND the text reading as finished — are already
      // conclusive, so the window armed below is the ONE confirmation
      // this turn pays. Leaving `stage` at `"silence"` was what made
      // `emitTurnEnd` mistake this timer's own expiry for "the silence
      // window just expired" and re-run the inference confirmation on
      // top of it — see the block above `EVIDENCED_CONFIRMATION_SHORT_MS`.
      //
      // PHASE 3: the gate is `isReleasableThought`, not the old
      // terminal-punctuation test — see the block above
      // `EVIDENCED_CONFIRMATION_OPEN_MS`. Deepgram's endpointer firing
      // ON the words is its strongest end-of-speech claim, and its
      // formatter declining to add a full stop is not counter-evidence.
      // Unpunctuated text pays the largest of the three evidenced
      // tiers; anything that affirmatively reads as unfinished still
      // takes the full inference path below.
      if (this.lastFinalWasEndpoint && !this.pendingInterim && this.isReleasableThought()) {
        this.stage = "confirming";
        this.rearmTimer(this.evidencedConfirmationWindowMs(this.pendingFinalText));
        // Observers are told only when the endpoint claim is EXPLICIT
        // (`speech_final: true` on this very final). A provider that
        // reports nothing (`isSpeechFinal` absent) takes this fast path
        // by default and is not evidence — see `onTurnPending`.
        if (segment.isSpeechFinal === true) this.notifyTurnPending();
        return;
      }
    }

    this.rearmTimer();
  }

  /**
   * The held text may be released on FRESH endpoint evidence: it is a
   * non-hesitation, non-hold thought that does not affirmatively read
   * as unfinished.
   *
   * This is the successor to `isCompleteThought`, minus its
   * terminal-punctuation requirement (PHASE 3 — see the block above
   * `EVIDENCED_CONFIRMATION_OPEN_MS`). Two earlier passes already
   * removed the word-count cap for the same reason this removes the
   * punctuation test: neither is evidence about whether a thought
   * finished. `looksIncomplete` is what actually separates "main kal
   * join karungi" from "...and I was going to", and it — plus the
   * filler and hold-phrase tables — is the whole of this gate.
   * Punctuation still decides how LONG the evidenced confirmation runs
   * (see `evidencedConfirmationWindowMs`), which is where a formatting
   * signal belongs.
   *
   * Only ever consulted when the provider's endpointer has declared
   * end of speech (`lastFinalWasEndpoint`, or the marker arriving in
   * `noteEndOfSpeech`). Text with no such claim never reaches it and
   * keeps the full inference path.
   */
  private isReleasableThought(): boolean {
    const text = this.pendingFinalText.trim();
    if (text.length === 0 || FILLER_ONLY.test(text) || HOLD_PHRASE_ONLY.test(text)) return false;
    return !looksIncomplete(text);
  }

  /**
   * The provider's endpointer has declared END OF SPEECH for words it
   * has ALREADY delivered — see `TranscriptSegment.isEndOfSpeechMarker`
   * and the Deepgram adapter that produces it.
   *
   * This is NOT a segment and must never be fed as one: it carries no
   * text, no word timings and no confidence. It makes exactly one claim
   * — "the caller has stopped talking" — about the text this detector
   * is already holding, so it:
   *
   *   - records that the last final WAS an endpoint, which is what
   *     drops the chunk-boundary grace this turn would otherwise pay
   *     for a claim Deepgram never actually made;
   *   - does NOT touch `pendingFinalText`, `lastFinalEndedAtMs`,
   *     `turnStartedAtMs` or `lastSegmentAtMs`. Appending nothing must
   *     not restart the turn clock, and `endedAtMs` of `0` would
   *     otherwise be measured as an enormous inter-final gap and push
   *     the adaptive threshold to its ceiling for the rest of the call;
   *   - only ever SHORTENS the armed wait, and only for the exact class
   *     `feed` already releases on the confirmation window alone: an
   *     endpointed, interim-free, complete thought. Every other class —
   *     mid-thought, unpunctuated, filler, hold phrase, outstanding
   *     interim — keeps the window it is already waiting out.
   *
   * A provider that never sends such a marker never calls this, so its
   * behaviour is byte-for-byte unchanged.
   */
  noteEndOfSpeech(): void {
    // Nothing is being held, so there is no turn for this to be about.
    if (this.timer === null || this.pendingFinalText.trim().length === 0) return;

    this.lastFinalWasEndpoint = true;

    // Guarded to the long adaptive window only. Shortening a
    // confirmation window that is already running would cut the
    // in-flight-speech check this detector exists to apply, and there
    // is nothing to gain: it is 300ms.
    if (this.stage !== "silence") return;

    // ── A LATE claim, arriving inside the chunk-boundary grace ───────
    //
    // That grace exists for exactly one reason, stated where it is
    // spent: Deepgram had NOT declared end-of-speech for the words we
    // hold, so the grace buys one bounded window for the declaration to
    // arrive. This call IS the declaration arriving. Sitting out the
    // remainder waits for something already in hand.
    //
    // Measured, and this is why the branch is not merely tidiness: on a
    // telephone line carrying comfort noise, Deepgram withholds
    // `speech_final` from the words and delivers the endpoint 2.3-2.4s
    // later in its own message — which lands mid-grace or later. Before
    // this branch, an endpointed turn on a noisy line still paid the
    // whole 700ms, and a MID-THOUGHT one paid it for nothing at all:
    // `isReleasableThought()` is false there, so the lines below
    // returned without touching the armed timer.
    //
    // `rearmTimer(0)` rather than a shortened window, deliberately: it
    // hands the decision straight back to `emitTurnEnd`, which then runs
    // every guard it runs today — filler, mid-thought continuation, hold
    // phrase, the outstanding-interim re-wait — and applies the
    // post-speech confirmation window for this text. So a caller who is
    // actually mid-thought is still held (their text fails
    // `looksIncomplete` and takes a continuation grace instead), and the
    // in-flight-speech check is still applied. Only the dead wait is
    // removed. `lastFinalWasEndpoint`, set above, is what stops
    // `emitTurnEnd` taking a SECOND grace on the way through.
    if (this.chunkBoundaryGraceArmed) {
      this.rearmTimer(0);
      return;
    }

    if (this.pendingInterim || !this.isReleasableThought()) return;
    // PHASE 2: same reasoning as the `feed` fast path above — the
    // marker just arriving IS the endpoint claim, and the text already
    // reads as finished, so `stage` is marked `"confirming"` rather
    // than left at `"silence"`. Without it `emitTurnEnd` would treat
    // this timer's own expiry as a fresh silence-window timeout and
    // re-run `confirmationWindowMs` on top of the window armed here.
    //
    // PHASE 3: gated on `isReleasableThought`, same as `feed` — an
    // `UtteranceEnd` is Deepgram's word-timing claim that the caller
    // stopped 1000ms ago, and discarding it because the formatter
    // withheld a full stop left the turn to wait out the entire
    // remaining silence window plus the open-ended confirmation. The
    // unpunctuated tier below is what such a turn is granted instead.
    this.stage = "confirming";
    this.rearmTimer(this.evidencedConfirmationWindowMs(this.pendingFinalText));
    // The marker IS the explicit endpoint claim — see `onTurnPending`.
    this.notifyTurnPending();
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
    this.chunkBoundaryGraceArmed = false;
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

  /**
   * READ-ONLY. The TEXT of the completed turn being held for the next
   * subscriber, or `""` when nothing is held.
   *
   * The companion to `hasBufferedTurn()` above, and it exists for one
   * reason: a boolean cannot be filtered. `drainPlayback` may cut a
   * generated reply short so a waiting turn is answered sooner, but it
   * must NOT do that for a buffered "okay" or "hello" — cancelling a
   * reply for one restarts the block the acknowledgement was agreeing
   * with. Judging that needs the words, so they are exposed here and
   * the existing `BARE_GREETING_ONLY` / `isBareAcknowledgement` /
   * `isAttentionCheck` predicates decide.
   *
   * Pure observation, exactly like `hasBufferedTurn()`: it does not
   * consume `pendingEvent`, does not clear it, arms no timer, touches
   * no window or threshold, and changes nothing about `feed`,
   * `emitTurnEnd`, `onTurnEnd` or endpointing. The buffered turn is
   * still delivered, whole, to whoever subscribes next — including the
   * merge `emitTurnEnd` performs when a second turn endpoints before
   * anyone has subscribed, so the text returned here is the same text
   * that subscriber will receive.
   *
   * It must never be used as a substitute for subscribing:
   * `emitTurnEnd` buffers only while `listeners.size === 0`, so an
   * extra subscriber would consume the event and the main loop would
   * never see it.
   */
  bufferedTurnText(): string {
    return this.pendingEvent?.text ?? "";
  }

  private rearmTimer(delayMs: number = this.silenceTimeoutMs): void {
    this.clearTimer();
    // Whatever window is being armed, it is not the chunk-boundary grace
    // unless the grace site says so immediately after this returns. Doing
    // it here rather than at each call site means a future window added
    // to `emitTurnEnd` cannot accidentally inherit the flag.
    this.chunkBoundaryGraceArmed = false;
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
        // Marks THIS window as the grace, so a late endpoint claim can
        // abandon it (see `noteEndOfSpeech`). Must follow `rearmTimer`,
        // which clears the flag.
        this.chunkBoundaryGraceArmed = true;
        // ── The one announcement NOT gated on an endpoint claim ──────
        //
        // Everything above waits for the provider to say "they stopped".
        // Here it has not said so — and the grace exists precisely to
        // give that claim time to arrive. But the claim is the ONLY
        // thing still missing: the full adaptive silence window has
        // already expired with no segment of any kind, and `emitTurnEnd`
        // has already run FILLER_ONLY, HOLD_PHRASE_ONLY and
        // `looksIncomplete` ABOVE this branch. What is held is a
        // complete thought the caller stopped speaking 1100ms ago.
        //
        // So this is the earliest point in the call at which the turn's
        // TEXT is both known and quiet — and it is the earliest signal a
        // speculative request can be built from at all. Earlier ones
        // carry no text: the transport's energy VAD fires ~400ms after
        // the caller stops, when `pendingFinalText` is still empty and
        // there is nothing to open a request for.
        //
        // ANNOUNCEMENT ONLY, and the distinction is the whole safety
        // case. `onTurnPending` returns nothing, no code in this file
        // reads `pendingListeners`, and this line arms no timer,
        // consumes nothing, clears nothing and touches no threshold.
        // The grace armed above is the same 700ms it always was and
        // expires at the same instant; release is still `onTurnEnd`,
        // from this method, on that timer. A caller who turns out to be
        // mid-utterance cancels the pending turn exactly as before —
        // the fed segment abandons the pre-opened request through the
        // pipeline's existing `caller resumed speaking` path — and the
        // merged turn then gets its own request, as it does today.
        //
        // The gate is the other three call sites' predicate minus
        // `lastFinalWasEndpoint`, which is `false` by construction in
        // this branch. It is not redundant with the guards above: a
        // mid-thought turn that has EXHAUSTED both continuation graces
        // falls through to here, and `isReleasableThought()` is what
        // still declines it.
        if (!this.pendingInterim && this.isReleasableThought()) {
          this.notifyTurnPending();
        }
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
          // ── The THIRD route into an evidenced confirmation window ──
          //
          // `feed` and `noteEndOfSpeech` both announce the window they
          // arm (see `onTurnPending`). This branch could arm the SAME
          // window on the SAME evidence and announce nothing, so an
          // observer that exists to overlap work with it got nothing to
          // overlap — and the turn paid the window anyway.
          //
          // The route is the chunk-boundary-grace COLLAPSE. Deepgram
          // withheld `speech_final` from the words, the grace below was
          // armed for the claim to arrive, the claim then arrived inside
          // it, and `noteEndOfSpeech` handed the decision straight back
          // here with `rearmTimer(0)` rather than deciding itself —
          // deliberately, so every guard in this method still runs. It
          // therefore returns BEFORE its own `notifyTurnPending()`, and
          // the window `confirmationWindowMs` grants a moment later (the
          // `lastFinalWasEndpoint` tiers, i.e. `evidencedConfirmationWindowMs`
          // or `EVIDENCED_CONFIRMATION_OPEN_MS`) is announced by nobody.
          //
          // The gate is the two existing call sites' predicate, verbatim
          // and unwidened — the provider's own endpoint claim, no
          // outstanding interim, and text that reads as finished — so
          // this announces exactly the class `onTurnPending` documents
          // and nothing else. In particular it cannot announce a
          // mid-thought turn that merely exhausted its continuation
          // graces: `isReleasableThought()` is false for that text, and
          // it is false for a hesitation sound or a hold phrase, which
          // is the same reason `feed`'s fast path declines them.
          //
          // Observation only, exactly like the other two: it arms no
          // timer (the window above is already armed and is not touched),
          // consumes nothing, clears nothing, and reads no threshold.
          // Release is still this method, on the timer set above, at the
          // same instant it fired before.
          if (this.lastFinalWasEndpoint && !this.pendingInterim && this.isReleasableThought()) {
            this.notifyTurnPending();
          }
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
    // PHASE 3: with an endpoint claim in hand the unpunctuated hold is
    // the evidenced 300ms tier, not the inferred 550ms one — the same
    // evidence/no-evidence split the fully-punctuated branch below has
    // always made. No claim, no shortening: the inferred window stands.
    if (!endsCompletely) {
      return this.lastFinalWasEndpoint
        ? EVIDENCED_CONFIRMATION_OPEN_MS
        : OPEN_ENDED_CONFIRMATION_WINDOW_MS;
    }
    // PHASE 2: this is the chunk-boundary-grace COLLAPSE path (see
    // `noteEndOfSpeech`'s `chunkBoundaryGraceArmed` branch) landing on
    // a long, complete turn — `lastFinalWasEndpoint` is only true here
    // because the provider's endpoint claim just arrived, the same
    // fresh evidence the two direct call sites act on. Reuse their
    // tiering rather than the plain inferred wait. When no such claim
    // has EVER arrived for this turn (chunk-boundary graces exhausted,
    // background noise, no marker) `lastFinalWasEndpoint` is still
    // false and the original inferred `CONFIRMATION_WINDOW_MS` stands —
    // unchanged, because there is no fresh evidence to act on.
    return this.lastFinalWasEndpoint
      ? this.evidencedConfirmationWindowMs(text)
      : CONFIRMATION_WINDOW_MS;
  }

  /**
   * The SINGLE confirmation window for a turn whose releasability AND
   * end-of-speech are BOTH freshly evidenced — see the blocks above
   * `EVIDENCED_CONFIRMATION_SHORT_MS` and
   * `EVIDENCED_CONFIRMATION_OPEN_MS`. Both call sites already require
   * `isReleasableThought()` and `!pendingInterim` before reaching this;
   * punctuation and word count here only tune how much of that
   * already-qualified window is granted, exactly as
   * `confirmationWindowMs` tiers its own inferred window.
   *
   * Text with no sentence-final punctuation gets the largest tier:
   * the formatter's silence is weak evidence either way, so the
   * in-flight-speech cancellation window is kept widest exactly where
   * the corroborating signal is missing.
   */
  private evidencedConfirmationWindowMs(text: string): number {
    if (!TERMINAL_PUNCTUATION.test(text)) return EVIDENCED_CONFIRMATION_OPEN_MS;
    const wordCount = text.split(/\s+/).length;
    const shortComplete = wordCount <= SHORT_COMPLETE_TURN_MAX_WORDS;
    const shortQuestion = QUESTION_ENDING.test(text) && wordCount <= SHORT_QUESTION_MAX_WORDS;
    return shortComplete || shortQuestion
      ? EVIDENCED_CONFIRMATION_SHORT_MS
      : EVIDENCED_CONFIRMATION_LONG_MS;
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
