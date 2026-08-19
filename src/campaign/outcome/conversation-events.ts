/**
 * conversation-events.ts
 *
 * What KIND of thing the person said, before anything decides what they
 * MEANT.
 *
 * The classifier reads phrases: "yes", "nahi", "call me later". That is
 * enough when a turn is an answer, and wrong when it is not. Real calls
 * are full of turns that contain a yes-shaped word while committing to
 * nothing:
 *
 *   "Is it free? Okay, and how long is it?"
 *   "Yes, I am interested, but I wanted to know—"
 *   "Theek hai, par ye event kis time hai?"
 *
 * Read as keywords, every one of those is a registration. Read as
 * speech, none of them is: two are questions and one is a sentence that
 * was cut off. This module is the difference — it reports whether a
 * turn ASKS, whether it was left unfinished, and whether it contains an
 * unambiguous commitment or an unambiguous refusal, so the classifier
 * can decline to read a verdict into a question.
 *
 * It decides nothing on its own. Nothing here maps to an outcome, a
 * disposition or a retry: those remain exactly where they were, in
 * `classifier.ts` and `disposition.ts`. This is evidence, and it is
 * deliberately conservative — when a turn is genuinely an answer it
 * says so, and every existing reading is preserved.
 *
 * The text helpers live here too, and `classifier.ts` imports them
 * rather than keeping its own copies. One normaliser means a phrase
 * that matches for the classifier matches for this module as well.
 */

import type { TranscriptTurn } from "./transcript";

/**
 * Lower-cases and reduces everything that is not a letter, digit or
 * COMBINING MARK to a single space, then pads the result. Punctuation,
 * emphasis and line breaks therefore cannot hide a phrase, and every
 * match is on whole words because both the text and the phrase are
 * space-delimited.
 *
 * `\p{M}` is not optional. Devanagari vowel signs and the chandrabindu
 * are marks, not letters: dropping them turns "हाँ" into "ह" and makes
 * every Hindi phrase unmatchable — a classifier that silently
 * understood only English while claiming to read Hindi.
 */
export function normaliseText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim()} `;
}

/** All occurrences of any phrase, with where each one was found. */
export function findPhrases(
  haystack: string,
  phrases: readonly string[],
): { phrase: string; offset: number }[] {
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

/** True when any phrase occurs in the already-normalised text. */
export function containsPhrase(normalised: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    if (normalised.includes(` ${phrase} `)) return true;
  }
  return false;
}

/**
 * Words that open a question, in English and in Hindi/Hinglish.
 *
 * Matched anywhere in the turn rather than only at the start, because
 * transcribed speech rarely starts where the question does — "achha
 * toh ye kitne din ka hai" asks something from the fourth word on.
 */
const QUESTION_MARKERS = [
  "what", "why", "how", "when", "where", "which", "who", "whom", "whose",
  "is it", "is this", "is that", "is there", "are you", "are they", "are there",
  "can i", "can you", "can we", "could you", "would you", "will you", "will it",
  "will there", "do you", "do i", "does it", "did you", "should i", "shall i",
  "what about", "how much", "how long", "how many",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "kya", "kyaa", "kaise", "kaisa", "kaisi", "kab", "kahan", "kaha", "kitna",
  "kitne", "kitni", "kyun", "kyu", "kaun", "kaunsa", "konsa", "matlab",
  "batao", "bataiye", "bata dijiye", "sach me", "sach mein",
  "क्या", "कैसे", "कैसा", "कब", "कहाँ", "कहां", "कितना", "कितने", "कितनी",
  "क्यों", "क्यूँ", "कौन", "कौनसा", "मतलब", "बताओ", "बताइए",
];

/**
 * A turn that ASKS something.
 *
 * The question mark is checked on the RAW text — `normaliseText` strips
 * punctuation, so by the time a phrase table sees a turn the strongest
 * available signal is already gone. Speech-to-text does emit question
 * marks, and when it does not the marker words above carry it.
 */
export function isQuestionTurn(rawText: string): boolean {
  if (rawText.includes("?") || rawText.includes("？")) return true;
  return containsPhrase(normaliseText(rawText), QUESTION_MARKERS);
}

/** A sentence that was still going when the turn ended. */
const UNFINISHED_MARKERS = [
  "i wanted to know", "i wanted to ask", "i want to ask", "i want to know",
  "i just wanted to ask", "i had a question", "one question", "quick question",
  "ek question", "ek baat", "poochna tha", "puchna tha", "poochna hai", "puchna hai",
  "पूछना था", "पूछना है", "एक सवाल",
];

/** Words a turn does not end on unless it was cut off. */
const DANGLING_TAIL_WORDS = [
  "but", "and", "because", "actually", "however", "so", "if", "that",
  "aur", "lekin", "par", "kyunki", "ki", "to", "toh", "matlab", "bas",
  "और", "लेकिन", "पर", "क्योंकि", "कि",
];

/**
 * True when the person was mid-thought: an explicit "I wanted to ask",
 * a trailing dash or ellipsis, or a turn that ends on a conjunction.
 *
 * This is what stands between "the caller was interrupted" and "the
 * caller agreed". A call that drops on "yes, but I wanted to know—" is
 * a call we still owe someone, and Phase 7 already routes unresolved
 * registration calls back into the queue. All that was missing was
 * noticing.
 */
export function isUnfinishedTurn(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (/[-—–]$/.test(trimmed) || /\.{2,}$/.test(trimmed) || trimmed.endsWith("…")) return true;
  const normalised = normaliseText(trimmed);
  if (containsPhrase(normalised, UNFINISHED_MARKERS)) return true;
  const words = normalised.trim().split(" ");
  const last = words[words.length - 1];
  // A one-word turn ("but") is a fragment, not a dangling tail; the
  // classifier reads nothing into it either way.
  return words.length > 1 && last !== undefined && DANGLING_TAIL_WORDS.includes(last);
}

/**
 * An unmistakable instruction to go ahead and do it.
 *
 * Used only to RESCUE a turn the rules above would otherwise refuse to
 * read as an answer. "Okay, and how do I register?" is a question;
 * "Yes, register me — how do I join?" is a registration with a question
 * attached, and the difference is a phrase that cannot mean anything
 * else. Deliberately narrow: bare "yes", "ok", "haan" and "ji" are not
 * here, because those are exactly the tokens that appear inside
 * questions.
 */
const EXPLICIT_COMMITMENTS = [
  "register me", "please register", "register kar", "registration kar",
  "reserve it", "reserve my seat", "reserve a seat", "reserve kar", "reserve karo",
  "book it", "book my seat", "book kar", "book karo",
  "sign me up", "count me in", "i am in", "go ahead", "please do", "please go ahead",
  "kar dijiye", "kar do", "kar dena", "kara dijiye", "karwa dijiye",
  "i will attend", "i will join", "i will be there", "i will come",
  "join karunga", "join karungi", "aa jaunga", "aa jaungi", "attend karunga", "attend karungi",
  "कर दीजिए", "कर दो", "कर दीजिये", "रजिस्टर कर", "बुक कर",
];

export function hasExplicitCommitment(normalised: string): boolean {
  return containsPhrase(normalised, EXPLICIT_COMMITMENTS);
}

/**
 * An unmistakable refusal, as opposed to the bare "no" that turns up
 * inside a question ("no? so it isn't recorded?").
 *
 * Same asymmetry as above and for the same reason: a refusal that the
 * person clearly stated must survive being phrased alongside a
 * question, and one the rules merely inferred from a stray token must
 * not.
 */
const EXPLICIT_REFUSALS = [
  "not interested", "i am not interested", "no thanks", "no thank you",
  "dont want", "do not want", "not for me", "leave it", "cancel it",
  "i will not", "never", "no need", "not required",
  "mujhe nahi chahiye", "interest nahi", "nahi chahiye", "zaroorat nahi",
  "मुझे नहीं चाहिए", "नहीं चाहिए", "ज़रूरत नहीं", "जरूरत नहीं",
];

export function hasExplicitRefusal(normalised: string): boolean {
  return containsPhrase(normalised, EXPLICIT_REFUSALS);
}

/**
 * Hesitation and push-back: the person is neither agreeing nor
 * refusing, they are raising something.
 *
 * Counted for the report, never for the verdict. An objection is the
 * most common thing between "hello" and a registration, and a campaign
 * that cannot see how often it happens cannot tell a script problem
 * from a list problem.
 */
const OBJECTIONS = [
  "too expensive", "no time", "dont have time", "do not have time", "busy schedule",
  "not sure", "i am not sure", "need to think", "let me think", "think about it",
  "i will decide", "decide later", "check my schedule", "check and tell",
  "send me the details", "send the details", "send details", "send me details",
  "whatsapp me", "share the details", "message me the details",
  "how did you get my number", "is this genuine", "is this real", "sounds like spam",
  "already tried", "not useful", "waste of time", "i dont trust", "do not trust",
  "soch kar", "sochkar", "soch ke", "dekhta hu", "dekhti hu", "dekhenge", "dekh kar",
  "pata nahi", "shayad", "confirm nahi", "abhi decide", "details bhej",
  "time nahi", "samay nahi", "bharosa nahi",
  "सोचकर", "सोच कर", "देखता हूँ", "देखती हूँ", "देखेंगे", "पता नहीं", "समय नहीं", "भरोसा नहीं",
];

/** Per-call counts of the conversational events the report distinguishes. */
export interface ConversationEvents {
  /** Customer turns that asked something. */
  readonly customerQuestions: number;
  /** Customer turns that raised a hesitation or a push-back. */
  readonly objections: number;
  /** Customer turns left unfinished — cut off, or trailing into a question. */
  readonly unfinishedTurns: number;
  /**
   * True when the LAST thing on the call was the customer asking
   * something the agent never answered. An interrupted conversation,
   * not a decision.
   */
  readonly endedOnCustomerQuestion: boolean;
  /** Assistant turns. Kept here so the report can see a one-sided call. */
  readonly agentTurns: number;
}

/** Counts the conversational events in a finished call. Reads only. */
export function summariseConversation(
  transcript: readonly TranscriptTurn[],
): ConversationEvents {
  let customerQuestions = 0;
  let objections = 0;
  let unfinishedTurns = 0;
  let agentTurns = 0;
  let lastCustomerIndex = -1;
  let lastCustomerPending = false;
  let lastSpokenIndex = -1;

  transcript.forEach((turn, index) => {
    if (turn.text.trim().length === 0) return;
    lastSpokenIndex = index;
    if (turn.role === "assistant") {
      agentTurns += 1;
      return;
    }
    const question = isQuestionTurn(turn.text);
    const unfinished = isUnfinishedTurn(turn.text);
    if (question) customerQuestions += 1;
    if (unfinished) unfinishedTurns += 1;
    if (containsPhrase(normaliseText(turn.text), OBJECTIONS)) objections += 1;
    lastCustomerIndex = index;
    lastCustomerPending = question || unfinished;
  });

  return {
    customerQuestions,
    objections,
    unfinishedTurns,
    // Only when nobody spoke after it: an answered question is a
    // handled question, and the agent's reply is the proof.
    endedOnCustomerQuestion: lastCustomerPending && lastCustomerIndex === lastSpokenIndex,
    agentTurns,
  };
}

/** How much of a customer turn may be read as an answer. */
export interface AnswerReadability {
  /** The turn asks something, or was cut off mid-thought. */
  readonly pending: boolean;
  /** An affirmation in this turn may be read as agreement. */
  readonly affirmationDecisive: boolean;
  /** A negation in this turn may be read as a refusal. */
  readonly negationDecisive: boolean;
}

/**
 * Whether this customer turn may be read as an answer at all.
 *
 * A question or an unfinished sentence may not — unless it also says
 * something that cannot be anything but an answer, which is what the
 * two explicit tables above are for. The two directions are decided
 * SEPARATELY on purpose: "okay, but I'm not interested — why did you
 * call?" contains a clear refusal and a courtesy token, and reading the
 * courtesy token as agreement because the refusal happened to be clear
 * would be the same bug in a new place.
 */
export function answerReadability(rawText: string, normalised: string): AnswerReadability {
  const pending = isQuestionTurn(rawText) || isUnfinishedTurn(rawText);
  if (!pending) {
    return { pending: false, affirmationDecisive: true, negationDecisive: true };
  }
  return {
    pending: true,
    affirmationDecisive: hasExplicitCommitment(normalised),
    negationDecisive: hasExplicitRefusal(normalised),
  };
}
