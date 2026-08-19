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
 *   opt-out  >  wrong number  >  suspected voicemail  >  confirmation
 *            at the gate  >  callback  >  refusal
 *            >  positive-but-not-at-the-gate  >  unclear
 *
 * Opt-out outranks everything because "take me off your list" said
 * after a yes is still an opt-out, and a compliance signal that can be
 * overwritten by an earlier pleasantry is not a compliance signal.
 *
 * One rule sits UNDER all of that and is what `rules.v2` adds: a phrase
 * only decides anything if the turn it was said in was an answer. On a
 * real call people say "okay, and how long is it?", "theek hai, par ye
 * kis time hai?", "yes I'm interested, but I wanted to know—". Every
 * one of those contains an affirmation token, and not one of them is a
 * registration: two are questions and one is a sentence that was cut
 * off. `conversation-events.ts` reports the speech act; this file
 * refuses to read a verdict into anything that was not an answer, and
 * says so on the signal it stored.
 *
 * A question is therefore never a yes, never a no, and never a reason
 * to close a contact. It is a conversational event, counted in
 * `detail.conversation` so the report can see it, and the call stays
 * exactly as unresolved as it actually was.
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
import {
  answerReadability,
  findPhrases,
  isQuestionTurn,
  normaliseText,
  summariseConversation,
  type ConversationEvents,
} from "./conversation-events";
import { checkScriptAdherence, type ScriptAdherenceReport } from "./script-adherence";
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

/**
 * Phrases that begin with an affirmation token but commit to nothing.
 *
 * The mirror of NEGATION_EXCEPTIONS, and needed for the same reason.
 * "i will" is in the table above because "I will attend" is a real yes;
 * it also matches "I will see how the day goes", which is a hedge. At
 * the commitment question the difference is the whole outcome, so these
 * are removed before affirmations are matched.
 */
const AFFIRMATION_EXCEPTIONS = [
  "i will see", "i will try", "i will check", "i will think", "i will let you know",
  "i will decide", "i will confirm later", "i will get back",
  "dekhta hu", "dekhti hu", "dekhenge", "soch kar", "sochkar", "try karunga", "try karungi",
  "देखता हूँ", "देखती हूँ", "देखेंगे", "सोचकर",
];

const CALLBACK = [
  "call me later", "call later", "call me back", "call back", "callback",
  "ring me later", "some other time", "another time", "later please",
  "i am busy", "im busy", "busy right now", "in a meeting", "driving",
  // "Can you call me tomorrow?" is the single most common way a person
  // asks for a callback, and it was not in this table: it fell through
  // to `unclear`. Same reading, but the label now says what the person
  // actually asked for, and the callback wait applies instead of the
  // generic unresolved one.
  "call me tomorrow", "call tomorrow", "call me in the evening",
  "call me after", "call after", "try me later", "later in the day",
  "baad me", "baad mein", "abhi busy", "abhi vyast", "phir call", "baad me call",
  "baad mein call", "baad me call karna", "baad mein call karna",
  "thodi der baad", "thodi der bad", "kal call", "kal phone", "kal baat",
  "abhi time nahi", "abhi samay nahi",
  "बाद में", "अभी व्यस्त", "कल कॉल", "थोड़ी देर बाद",
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
 * Phrases only an answering machine says.
 *
 * This is a TRANSCRIPT HEURISTIC and nothing more. The platform has no
 * answering-machine detection: the media stream opening looks identical
 * for a human, a machine and an IVR, and no carrier verdict is
 * received (external-limits.ts records this as unavailable). Matching
 * one of these phrases is therefore evidence that we reached a machine,
 * never proof — and failing to match one is not evidence of a human.
 *
 * It exists for one reason: a greeting is transcribed as customer
 * speech, so without it a machine can supply the tokens the
 * affirmation rules read. A voicemail must never become a
 * registration.
 */
const VOICEMAIL_MARKERS = [
  "has been forwarded to voicemail", "forwarded to voicemail", "to voicemail",
  "leave a message after", "leave a message", "record your message",
  "after the tone", "after the beep", "at the tone", "not available right now",
  "is not answering your call", "is currently unavailable", "please try again later",
  "the person you are calling", "the number you are calling",
  "voice mail", "voicemail",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "abhi uplabdh nahi", "sandesh record", "sandesh chhod", "message chhod dijiye",
  "beep ke baad", "tone ke baad", "jis vyakti ko aap",
  "उपलब्ध नहीं", "संदेश रिकॉर्ड", "संदेश छोड़", "वॉइस मेल", "वॉइसमेल",
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
    // The approved reminder script's actual commitment question is
    // "will you be joining us live?". Without these three the anchor
    // list matched a paraphrase of that line but not the line itself,
    // so a real "yes, I'll join" landed as acknowledged-but-not-
    // confirmed and a reminder could never record a confirmation.
    "will you be joining", "joining us live", "join us live",
    "confirm your attendance", "can i confirm", "count on you", "attend live",
    "aap aayenge", "join karenge",
  ],
};

// ── Normalisation ─────────────────────────────────────────────────
// `normaliseText` and `findPhrases` live in `conversation-events.ts` so
// that the speech-act reader and the phrase tables below can never
// disagree about what a word is. Behaviour is unchanged: same casing,
// same handling of Devanagari combining marks, same whole-word matching
// through the padded needle.

const normalise = normaliseText;

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
  /**
   * ADDITIVE, OPTIONAL. The approved script's text, used only to check
   * that the AGENT stayed on it (see `script-adherence.ts`). It never
   * changes the outcome: with it absent, every label this function
   * produces is identical.
   */
  readonly scriptText?: string;
}

// ── The classifier ────────────────────────────────────────────────

export function classifyOutcome(input: ClassifyOutcomeInput): OutcomeClassification {
  const vocabulary = outcomeVocabulary(input.campaignType);

  // What kind of conversation this was, and whether the agent stayed on
  // the script. Both are DIAGNOSTIC: they are attached to every row
  // below and read by the report, and neither one is consulted by a
  // single decision rule.
  const conversation = summariseConversation(input.transcript);
  const adherence =
    input.scriptText !== undefined && input.scriptText.trim().length > 0
      ? checkScriptAdherence({ scriptText: input.scriptText, transcript: input.transcript })
      : undefined;
  const diagnostics = { conversation, ...(adherence ? { adherence } : {}) };

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
      ...diagnostics,
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
      ...diagnostics,
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
    // ...and "I will see how the day goes" must not read as a yes.
    let forAffirmations = raw;
    for (const exception of AFFIRMATION_EXCEPTIONS) {
      forAffirmations = forAffirmations.split(` ${exception} `).join(" ");
    }

    const atGate = answersACommitQuestion(input.transcript, turnIndex, anchors);

    // Was this turn an ANSWER at all? A question and a sentence that was
    // cut off are conversational events, not verdicts — the phrases in
    // them are still recorded, for audit, but marked non-decisive so no
    // rule below can close a contact on one.
    const readability = answerReadability(turn.text, raw);

    const record = (
      kind: OutcomeSignal["kind"],
      hits: { phrase: string; offset: number }[],
      decisive = true,
    ) => {
      for (const hit of hits) {
        const signal: OutcomeSignal = {
          kind,
          phrase: hit.phrase,
          turnIndex,
          // A phrase that may not be read as an answer is not at the
          // gate either, whatever question preceded it.
          atGate: kind === "affirmation" ? atGate && decisive : false,
          ...(decisive ? {} : { decisive: false }),
        };
        signals.push(signal);
        positions.set(signal, positionOf(turnIndex, hit.offset));
      }
    };

    const voicemailHits = findPhrases(raw, VOICEMAIL_MARKERS);

    record("opt_out", findPhrases(raw, OPT_OUT));
    record("wrong_number", findPhrases(raw, WRONG_NUMBER));
    record("voicemail", voicemailHits);
    record("callback", findPhrases(raw, CALLBACK));
    // A turn that a machine spoke contributes NO affirmation. Bare
    // tokens such as "ok" or "ji" occur inside greetings, and one of
    // them landing after the commitment question would otherwise read
    // as a high-confidence registration.
    if (voicemailHits.length === 0) {
      record("affirmation", findPhrases(forAffirmations, AFFIRMATIONS), readability.affirmationDecisive);
    }
    record("negation", findPhrases(forNegations, NEGATIONS), readability.negationDecisive);
  });

  const positionFor = (signal: OutcomeSignal) => positions.get(signal) ?? 0;
  const of = (kind: OutcomeSignal["kind"]) => signals.filter((signal) => signal.kind === kind);

  const shared = {
    campaignType: input.campaignType,
    customerTurns: customerTurns.length,
    assistantTurns: assistantTurns.length,
    signals,
    ...diagnostics,
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

  // ── 3b. A machine, as far as the words can tell ─────────────────
  // Placed before every decision rule: if the words we have are a
  // greeting, the call decided nothing, and the honest label is "no
  // engagement" rather than any reading of what a machine said.
  const voicemails = of("voicemail");
  if (voicemails.length > 0) {
    return build({
      ...shared,
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "suspected_voicemail",
      confidence: "low",
      suspectedVoicemail: true,
      explanation:
        `The transcript contains a voicemail greeting ("${voicemails[0]?.phrase}"), so this call most ` +
        `likely reached a machine. This is a transcript heuristic only — the platform has no ` +
        `answering-machine detection, so it is not confirmed and no registration is inferred from it.`,
    });
  }

  // ── 4. A yes at the gate, not retracted afterwards ──────────────
  // Only DECISIVE phrases decide. A "yes" inside a question and a "no"
  // inside an unfinished sentence stay on the row as evidence of what
  // was said, and are excluded from every rule from here down.
  const isDecisive = (signal: OutcomeSignal) => signal.decisive !== false;
  const affirmations = of("affirmation").filter(isDecisive);
  const negations = of("negation").filter(isDecisive);
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
        "so this is engagement rather than a confirmation." +
        questionSuffix(conversation),
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
      "The person spoke, but nothing in the conversation was decisive enough to call this a yes or a no." +
      questionSuffix(conversation),
  });
}

/**
 * The sentence that keeps a question-led call from reading as apathy.
 *
 * A person who asked four things and never got to a decision looks
 * identical to silence in a count of successes, and is the opposite of
 * it in reality. The label stays honestly unresolved either way — this
 * only makes the row say which kind of unresolved it was.
 */
function questionSuffix(conversation: ConversationEvents): string {
  const parts: string[] = [];
  if (conversation.customerQuestions > 0) {
    parts.push(
      `They asked ${conversation.customerQuestions} question(s) during the call, which is engagement ` +
        `rather than an answer either way.`,
    );
  }
  if (conversation.objections > 0) {
    parts.push(`They raised ${conversation.objections} objection(s) or hesitation(s).`);
  }
  if (conversation.endedOnCustomerQuestion) {
    parts.push(
      `The call ended while they were still asking, so this conversation was interrupted rather than ` +
        `concluded.`,
    );
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * Whether a customer turn is answering a question that commits them.
 *
 * Looks back to the nearest assistant turn, and one further if the
 * nearest is a short filler such as "sure" or "right" — a person who
 * answers a beat late is still answering the question that was asked.
 *
 * The look-back STOPS at any other question the agent asked. That is
 * the fix for the most expensive false positive available here:
 *
 *   Agent:    "...should I reserve your free seat?"
 *   Agent:    "The event is completely free. Is that okay?"
 *   Customer: "Yes."
 *
 * The yes belongs to "is that okay", which commits to nothing. Walking
 * past it to the seat question turns a courtesy into a registration and
 * closes the contact for good, so a non-anchor question ends the search
 * rather than being skipped as filler.
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
    // The agent asked something else. The person is answering THAT.
    if (isQuestionTurn(turn.text)) return false;
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
  suspectedVoicemail?: boolean;
  conversation?: ConversationEvents;
  adherence?: ScriptAdherenceReport;
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
      ...(input.suspectedVoicemail ? { suspectedVoicemail: true } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.adherence ? { adherence: input.adherence } : {}),
    },
  };
}
