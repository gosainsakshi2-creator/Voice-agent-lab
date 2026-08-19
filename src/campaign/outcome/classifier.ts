/**
 * classifier.ts
 *
 * Reads a finished call and says what it meant.
 *
 * Rule-based and deterministic on purpose. The same transcript
 * produces the same label on every run, on every machine, with no
 * network call, no cost per call and no model version drifting
 * underneath a comparison whose whole point is that the only thing
 * differing between two calls is the TTS provider. A model-based
 * classifier can be added later as a second `classifier` id and
 * back-filled over the stored transcripts; it must not be the thing
 * that decides whether Cartesia beat Sarvam this week.
 *
 * The rules are honest about what they are. They match phrases people
 * actually say, in English and in Hindi/Hinglish, and they refuse to
 * guess: a call with no decisive signal is labelled `unclear` with
 * `succeeded = NULL`, not quietly counted as a failure. Every matched
 * phrase is stored on the row, so a disputed label can be checked
 * against the words that produced it.
 *
 * Precedence is deliberate and is not the order a naive reading would
 * choose:
 *
 *   opt-out  >  wrong number  >  confirmation at the gate  >  callback
 *            >  refusal  >  positive-but-not-at-the-gate  >  unclear
 *
 * Opt-out outranks everything because "take me off your list" said
 * after a yes is still an opt-out, and a compliance signal that can be
 * overwritten by an earlier pleasantry is not a compliance signal.
 */

import type { CallStatus, FailureClass } from "../domain/call-status";
import {
  outcomeVocabulary,
  RULES_CLASSIFIER_ID,
  OUTCOME_SCHEMA_VERSION,
  type OutcomeClassification,
  type OutcomeConfidence,
  type OutcomeSignal,
  type PrimaryReason,
} from "./outcome-types";
import type { TranscriptTurn } from "./transcript";

// ── Phrase tables ─────────────────────────────────────────────────
// Matched against normalised text with spaces around every phrase, so
// "no" matches "no thanks" and never "know" or "number".

const AFFIRMATIONS = [
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright", "definitely",
  "absolutely", "of course", "certainly", "please do", "go ahead", "sounds good",
  "i will", "i am in", "count me in", "do it", "book it", "register me",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "haan", "haa", "han ji", "ji haan", "ji", "bilkul", "zaroor", "jarur",
  "theek hai", "thik hai", "kar dijiye", "kar do", "kara dijiye", "pakka",
  "हाँ", "हां", "जी", "जी हाँ", "बिल्कुल", "ज़रूर", "जरूर", "ठीक है", "पक्का",
];

const NEGATIONS = [
  "no", "nope", "nah", "not interested", "no thanks", "no thank you",
  "i am not interested", "not now", "dont want", "do not want", "not for me",
  "leave it", "cancel it", "i cant", "i cannot", "i will not",
  "nahi", "nahin", "nai", "mujhe nahi chahiye", "interest nahi",
  "नहीं", "नही", "मुझे नहीं चाहिए",
];

/**
 * Phrases that contain a negation token but are not a refusal. Removed
 * from the text before negations are matched, so "no problem" does not
 * end a call that was going well.
 */
const NEGATION_EXCEPTIONS = [
  "no problem", "no issue", "no issues", "no doubt", "no worries",
  "koi baat nahi", "koi dikkat nahi", "koi problem nahi",
];

const CALLBACK = [
  "call me later", "call later", "call me back", "call back", "callback",
  "ring me later", "some other time", "another time", "later please",
  "i am busy", "im busy", "busy right now", "in a meeting", "driving",
  "baad me", "baad mein", "abhi busy", "abhi vyast", "phir call", "baad me call",
  "बाद में", "अभी व्यस्त",
];

const WRONG_NUMBER = [
  "wrong number", "wrong person", "no such person", "you have the wrong",
  "he does not live here", "she does not live here", "this is not",
  "galat number", "galat", "koi aur hai",
  "गलत नंबर", "गलत",
];

const OPT_OUT = [
  "do not call", "dont call", "stop calling", "never call", "remove my number",
  "remove me", "unsubscribe", "take me off", "report you", "harassing",
  "call mat karo", "phone mat karo", "number hata do", "mat call",
  "कॉल मत", "नंबर हटा",
];

/**
 * Assistant questions where a "yes" is a COMMITMENT rather than
 * politeness. A yes to "can I tell you in 20 seconds" is interest; a
 * yes to "should I reserve your free seat" is a registration, and only
 * the second one may be counted as a success.
 *
 * Patterns rather than exact script text: a campaign may run a
 * shortened or re-worded script, and this must degrade to "positive
 * but not at the gate" rather than to a false success.
 */
const COMMIT_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  registration: [
    "reserve your free seat", "reserve your seat", "reserve a seat", "should i reserve",
    "reserve karu", "seat reserve", "book your seat",
    "your registration done", "register you", "registration done", "shall i register",
    "count on you to attend", "attend live", "mark you as confirmed",
  ],
  reminder: [
    "will you attend", "are you attending", "will you join", "are you joining",
    "confirm your attendance", "can i confirm", "count on you", "attend live",
    "aap aayenge", "join karenge",
  ],
};

// ── Normalisation ─────────────────────────────────────────────────

/**
 * Lower-cases and reduces everything that is not a letter, digit or
 * COMBINING MARK to a single space, then pads the result. Punctuation,
 * emphasis and line breaks therefore cannot hide a phrase, and every
 * match is on whole words because both the text and the phrase are
 * space-delimited.
 *
 * `\p{M}` is not optional. Devanagari vowel signs and the chandrabindu
 * are marks, not letters: dropping them turns "हाँ" into "ह" and makes
 * every Hindi phrase in the tables above unmatchable — a classifier
 * that silently understood only English while claiming to read Hindi.
 */
function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim()} `;
}

/** All occurrences of any phrase, with where each one was found. */
function findPhrases(haystack: string, phrases: readonly string[]): { phrase: string; offset: number }[] {
  const found: { phrase: string; offset: number }[] = [];
  for (const phrase of phrases) {
    const needle = ` ${phrase} `;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      found.push({ phrase, offset: at });
      from = at + 1;
    }
  }
  return found;
}

/** Ordering key that respects position WITHIN a turn as well as across turns. */
const positionOf = (turnIndex: number, offset: number) => turnIndex * 1_000_000 + offset;

// ── Input ─────────────────────────────────────────────────────────

export interface ClassifyOutcomeInput {
  readonly campaignType: string;
  /** Final attempt status, as written to `call_attempts`. */
  readonly status: CallStatus;
  readonly failureClass: FailureClass;
  /** True only when the telephony provider confirmed the callee picked up. */
  readonly answered: boolean;
  readonly transcript: readonly TranscriptTurn[];
  /** Recorded verbatim in the explanation when the call never connected. */
  readonly failureReason?: string | null;
}

// ── The classifier ────────────────────────────────────────────────

export function classifyOutcome(input: ClassifyOutcomeInput): OutcomeClassification {
  const vocabulary = outcomeVocabulary(input.campaignType);

  // ── 1. Calls that never became conversations ────────────────────
  if (!input.answered) {
    const reason = notConnectedReason(input);
    return build({
      outcomeType: "not_connected",
      succeeded: false,
      primaryReason: reason,
      confidence: input.failureClass === "NO_ANSWER" || input.failureClass === "BUSY" ? "high" : "medium",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: 0,
      signals: [],
      explanation:
        input.failureReason?.trim() ||
        `The call ended as ${input.status} without being answered, so there is nothing to classify.`,
    });
  }

  const customerTurns = input.transcript.filter((turn) => turn.role === "user" && turn.text.length > 0);
  const assistantTurns = input.transcript.filter((turn) => turn.role === "assistant" && turn.text.length > 0);

  if (input.transcript.length === 0) {
    return build({
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "no_transcript",
      confidence: "low",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: 0,
      signals: [],
      explanation:
        "The call was answered but no transcript was captured, so the outcome is unknown rather than negative.",
    });
  }

  if (customerTurns.length === 0) {
    return build({
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "no_customer_speech",
      confidence: "high",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: assistantTurns.length,
      signals: [],
      explanation: "The call connected and the agent spoke, but the person said nothing that was heard.",
    });
  }

  // ── 2. Every phrase that matters, with its position ─────────────
  const signals: OutcomeSignal[] = [];
  const positions = new Map<OutcomeSignal, number>();
  const anchors = COMMIT_ANCHORS[input.campaignType] ?? COMMIT_ANCHORS["registration"] ?? [];

  input.transcript.forEach((turn, turnIndex) => {
    if (turn.role !== "user" || turn.text.length === 0) return;

    const raw = normalise(turn.text);
    // "no problem" must not read as a refusal.
    let forNegations = raw;
    for (const exception of NEGATION_EXCEPTIONS) {
      forNegations = forNegations.split(` ${exception} `).join(" ");
    }

    const atGate = answersACommitQuestion(input.transcript, turnIndex, anchors);

    const record = (kind: OutcomeSignal["kind"], hits: { phrase: string; offset: number }[]) => {
      for (const hit of hits) {
        const signal: OutcomeSignal = {
          kind,
          phrase: hit.phrase,
          turnIndex,
          atGate: kind === "affirmation" ? atGate : false,
        };
        signals.push(signal);
        positions.set(signal, positionOf(turnIndex, hit.offset));
      }
    };

    record("opt_out", findPhrases(raw, OPT_OUT));
    record("wrong_number", findPhrases(raw, WRONG_NUMBER));
    record("callback", findPhrases(raw, CALLBACK));
    record("affirmation", findPhrases(raw, AFFIRMATIONS));
    record("negation", findPhrases(forNegations, NEGATIONS));
  });

  const positionFor = (signal: OutcomeSignal) => positions.get(signal) ?? 0;
  const of = (kind: OutcomeSignal["kind"]) => signals.filter((signal) => signal.kind === kind);

  const shared = {
    campaignType: input.campaignType,
    customerTurns: customerTurns.length,
    assistantTurns: assistantTurns.length,
    signals,
  };

  // ── 3. Compliance first ─────────────────────────────────────────
  const optOuts = of("opt_out");
  if (optOuts.length > 0) {
    return build({
      ...shared,
      outcomeType: "do_not_call",
      succeeded: false,
      primaryReason: "opt_out",
      confidence: "high",
      explanation: `The person asked not to be contacted again ("${optOuts[0]?.phrase}"). Do not retry this number.`,
    });
  }

  const wrongNumbers = of("wrong_number");
  if (wrongNumbers.length > 0) {
    return build({
      ...shared,
      outcomeType: "wrong_number",
      succeeded: false,
      primaryReason: "wrong_person",
      confidence: "medium",
      explanation: `The person indicated we reached the wrong number ("${wrongNumbers[0]?.phrase}").`,
    });
  }

  // ── 4. A yes at the gate, not retracted afterwards ──────────────
  const affirmations = of("affirmation");
  const negations = of("negation");
  const callbacks = of("callback");

  const lastNegationPosition = negations.reduce(
    (latest, signal) => Math.max(latest, positionFor(signal)),
    -1,
  );
  const gateAffirmations = affirmations.filter(
    (signal) => signal.atGate && positionFor(signal) > lastNegationPosition,
  );

  if (gateAffirmations.length > 0) {
    return build({
      ...shared,
      outcomeType: vocabulary.success,
      succeeded: true,
      primaryReason: "confirmed_at_gate",
      confidence: "high",
      explanation:
        `The person agreed ("${gateAffirmations[0]?.phrase}") in answer to the question that commits them, ` +
        `and did not take it back afterwards.`,
    });
  }

  // ── 5. Asked to be called another time ──────────────────────────
  if (callbacks.length > 0) {
    return build({
      ...shared,
      outcomeType: "callback_requested",
      succeeded: false,
      primaryReason: "callback_requested",
      confidence: "medium",
      explanation: `The person asked to be contacted at another time ("${callbacks[0]?.phrase}").`,
    });
  }

  // ── 6. A no that nothing positive followed ──────────────────────
  const lastAffirmationPosition = affirmations.reduce(
    (latest, signal) => Math.max(latest, positionFor(signal)),
    -1,
  );
  if (negations.length > 0 && lastNegationPosition > lastAffirmationPosition) {
    return build({
      ...shared,
      outcomeType: "declined",
      succeeded: false,
      primaryReason: "explicit_no",
      confidence: "high",
      explanation: `The person declined ("${negations[negations.length - 1]?.phrase}") and said nothing positive after it.`,
    });
  }

  // ── 7. Positive, but never at the gate ──────────────────────────
  if (affirmations.length > 0) {
    return build({
      ...shared,
      outcomeType: vocabulary.partial,
      succeeded: false,
      primaryReason: "affirmative_not_at_gate",
      confidence: affirmations.length > 1 ? "medium" : "low",
      explanation:
        "The person was positive but never agreed at the question that commits them, " +
        "so this is engagement rather than a confirmation.",
    });
  }

  // ── 8. Nothing decisive. Say so. ────────────────────────────────
  return build({
    ...shared,
    outcomeType: "unclear",
    succeeded: null,
    primaryReason: "no_decisive_signal",
    confidence: "low",
    explanation:
      "The person spoke, but nothing in the conversation was decisive enough to call this a yes or a no.",
  });
}

/**
 * Whether a customer turn is answering a question that commits them.
 *
 * Looks back to the nearest assistant turn, and one further if the
 * nearest is a short filler such as "sure" or "right" — a person who
 * answers a beat late is still answering the question that was asked.
 */
function answersACommitQuestion(
  transcript: readonly TranscriptTurn[],
  customerTurnIndex: number,
  anchors: readonly string[],
): boolean {
  if (anchors.length === 0) return false;
  let checked = 0;
  for (let index = customerTurnIndex - 1; index >= 0 && checked < 2; index -= 1) {
    const turn = transcript[index];
    if (!turn || turn.role !== "assistant" || turn.text.trim().length === 0) continue;
    const text = normalise(turn.text);
    if (findPhrases(text, anchors).length > 0) return true;
    checked += 1;
    // A substantial assistant turn that contained no anchor ends the
    // look-back: the person is answering that, not something earlier.
    if (text.trim().length > 40) break;
  }
  return false;
}

function notConnectedReason(input: ClassifyOutcomeInput): PrimaryReason {
  if (input.failureReason?.includes("CAMPAIGN_DIALING_ENABLED")) return "dialing_disabled";
  switch (input.status) {
    case "NO_ANSWER":
      return "no_answer";
    case "BUSY":
      return "busy";
    case "CANCELLED":
      return "cancelled";
    default:
      return input.failureClass === "SYSTEM" ? "system_error" : "failed";
  }
}

function build(input: {
  outcomeType: OutcomeClassification["outcomeType"];
  succeeded: boolean | null;
  primaryReason: PrimaryReason;
  confidence: OutcomeConfidence;
  campaignType: string;
  customerTurns: number;
  assistantTurns: number;
  signals: readonly OutcomeSignal[];
  explanation: string;
}): OutcomeClassification {
  return {
    outcomeType: input.outcomeType,
    succeeded: input.succeeded,
    primaryReason: input.primaryReason,
    classifier: RULES_CLASSIFIER_ID,
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    detail: {
      confidence: input.confidence,
      campaignType: input.campaignType,
      customerTurns: input.customerTurns,
      assistantTurns: input.assistantTurns,
      signals: input.signals,
      explanation: input.explanation,
    },
  };
}
