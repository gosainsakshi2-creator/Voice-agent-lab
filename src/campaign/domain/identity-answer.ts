/**
 * identity-answer.ts
 *
 * Did the person on the line say they are the person we called?
 *
 * WHY THIS EXISTS AT ALL
 *
 * Until this file, identity was not a thing the system knew. The agent
 * asked "Am I speaking with Sakshi?" because the prompt told it to, and
 * nothing anywhere recorded whether an answer ever came back. A real
 * call showed what that costs: the question was interrupted, the
 * hearing check that followed succeeded, the caller said "Haan ji", and
 * the agent went straight into the pitch — having confirmed only that
 * it could be heard.
 *
 * HEARING AND IDENTITY ARE DIFFERENT STATES. A successful hearing check
 * means "I can hear the caller". It does not mean "the caller said they
 * are Sakshi". This module is the one place that tells them apart, and
 * the distinction it draws is deliberately conservative: anything that
 * is not an unmistakable yes or an unmistakable no is `unclear`, and
 * `unclear` costs one re-ask rather than a wrong assumption.
 *
 * WHAT IT IS NOT. It is not a name matcher and it does not do speech
 * recognition of names — STT mangles Indian names often enough that
 * requiring the name back would fail honest callers. "Yes", "speaking",
 * "haan ji", "bol rahi hoon" are how people actually answer this
 * question, and they are what it reads.
 *
 * Pure, synchronous, no I/O. Read at exactly one place — the identity
 * gate in `ConversationPipeline` — and only while an identity question
 * is outstanding, which is what keeps a bare "haan" said at any other
 * moment in the call from meaning anything here.
 */

import { normaliseText } from "../outcome/conversation-events";

export type IdentityAnswer = "confirmed" | "denied" | "unclear";

/**
 * Phrases that answer a HEARING question, not an identity one.
 *
 * Checked FIRST and unconditionally, because this is the exact
 * confusion the defect was made of: after a hearing check the caller
 * says "yes, I can hear you", and every word of that is an
 * affirmation. It answers "can you hear me", and the identity question
 * is still unanswered.
 */
const HEARING_ANSWERS = [
  "can hear you", "can hear u", "i can hear", "hear you now", "hear you fine",
  "yes i can hear", "yeah i can hear", "loud and clear", "hearing you",
  "sunai de raha", "sunai de rahi", "sunai de raha", "aawaz aa rahi",
  "awaz aa rahi", "aawaaz aa rahi", "awaaz aa rahi", "aa rahi hai aawaz",
  "सुनाई दे रहा", "सुनाई दे रही", "आवाज़ आ रही", "आवाज आ रही",
];

/**
 * An unmistakable "yes, that is me".
 *
 * Bare affirmations are in here on purpose. This table is consulted
 * ONLY while the identity question is the last thing the agent asked
 * and the turn was not taken by the hearing path, so "haan" here is a
 * yes to that question and to nothing else — the same reasoning
 * `classifier.ts` uses for a yes at the commitment gate.
 */
/**
 * Saying, in words, that they are the person — as opposed to a bare
 * "yes". Read BEFORE the hearing exclusion, so a turn that answers both
 * questions at once is taken as answering both.
 */
const SELF_IDENTIFICATIONS = [
  "that is me", "thats me", "this is me", "this is her", "this is him",
  "speaking", "yes speaking", "im speaking", "you are speaking with",
  "bol raha hoon", "bol rahi hoon", "bol raha hu", "bol rahi hu",
  "bol raha", "bol rahi", "main hi hoon", "main hi hu", "wahi hoon",
  "बोल रही हूँ", "बोल रहा हूँ", "मैं ही हूँ",
];

const CONFIRMATIONS = [
  "yes", "yeah", "yep", "yup", "correct", "that is me", "thats me", "this is me",
  "this is her", "this is him", "speaking", "yes speaking", "im sakshi",
  "you are", "you have", "right", "of course", "sure",
  "haan", "han", "ha ji", "haan ji", "ji haan", "ji", "bilkul", "sahi",
  "bol raha hoon", "bol rahi hoon", "bol raha hu", "bol rahi hu",
  "bol raha", "bol rahi", "main hi hoon", "main hi hu", "wahi hoon",
  "हाँ", "हां", "जी", "जी हाँ", "बिल्कुल", "बोल रही हूँ", "बोल रहा हूँ", "मैं ही हूँ",
];

/**
 * The caller asking a question BACK, which answers nothing.
 *
 * Checked before the confirmations because "kaun bol raha hai?" — who
 * is speaking? — contains "bol raha", which is also how somebody says
 * "I am speaking". The question is the opposite of an answer, so it is
 * read first.
 */
const QUESTIONS_BACK = [
  "kaun", "kaun bol", "kaun hai", "kisse baat", "kis se baat", "kaun sa",
  "who is this", "whos this", "who is speaking", "who are you", "what is this",
  "kya chahiye", "kyun", "kis liye", "kaise",
  "कौन", "कौन बोल", "किससे", "क्या चाहिए", "क्यों",
];

/** An unmistakable "no, that is not me". */
const DENIALS = [
  "no", "nope", "not me", "wrong number", "wrong person", "you have the wrong",
  "she is not", "he is not", "not here", "does not live here", "doesnt live here",
  "nahi", "nahin", "galat number", "galat", "koi aur", "wo nahi", "main nahi",
  "नहीं", "गलत नंबर", "गलत", "कोई और",
];

/** Whole-word containment, on the same normalisation the classifier uses. */
function contains(haystack: string, needles: readonly string[]): boolean {
  const padded = ` ${haystack} `;
  return needles.some((needle) => padded.includes(` ${needle} `));
}

/**
 * Read one caller turn as an answer to "am I speaking with <name>?".
 *
 * `customerName` is optional and used only as an extra confirmation
 * signal — a caller who says their own name back has identified
 * themselves whatever else the turn contains.
 *
 * Order matters and is the whole design:
 *
 *   1. A hearing answer is never an identity answer. First, and
 *      unconditional.
 *   2. A denial beats a confirmation, so "no, this is not Sakshi"
 *      cannot be read as a yes because it contains no affirming word
 *      the table would have matched anyway. Stated explicitly so a
 *      future addition to CONFIRMATIONS cannot invert it.
 *   3. Then a confirmation.
 *   4. Everything else is `unclear` — including silence, "hello?",
 *      "kaun bol raha hai?" and any question put back to the agent.
 */
export function classifyIdentityAnswer(
  text: string,
  customerName?: string,
): IdentityAnswer {
  const normalised = normaliseText(text ?? "");
  if (normalised.trim().length === 0) return "unclear";

  // 1. A question put back to us is never an answer — and it is read
  //    first because "kaun bol raha hai?" (who is speaking?) contains
  //    "bol raha", which is also how somebody says "I am speaking".
  if (contains(normalised, QUESTIONS_BACK)) return "unclear";

  // 2. A denial wins outright, whatever else is in the turn.
  if (contains(normalised, DENIALS)) return "denied";

  // 3. Did they IDENTIFY THEMSELVES? Their own name back, or a phrase
  //    that says so in words. This is checked before the hearing
  //    exclusion below and not after, because one turn often carries
  //    both: "Yes, I can hear you, this is Sakshi" answers the hearing
  //    question AND the identity one, and reading only the first half
  //    of it would re-ask a question they have just answered.
  const name = normaliseText(customerName ?? "").trim();
  if (name.length > 1 && contains(normalised, [name])) return "confirmed";
  if (contains(normalised, SELF_IDENTIFICATIONS)) return "confirmed";

  // 4. Otherwise "yes, I can hear you" answers the wrong question. It
  //    has to come before the bare affirmations, because it contains
  //    one.
  if (contains(normalised, HEARING_ANSWERS)) return "unclear";

  // 5. ...and a bare yes to the question we actually asked.
  if (contains(normalised, CONFIRMATIONS)) return "confirmed";

  return "unclear";
}
