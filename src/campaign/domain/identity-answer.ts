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
  // ── The split spelling, and the nominative pronouns ─────────────
  //
  // `normaliseText` reduces every non-letter to a space, so "That's
  // me." reaches this table as " that s me " and "thats me" above
  // matches nothing a caller ever says. It is the commonest English
  // answer to "Am I speaking with Priya?" and it read as `unclear`,
  // which costs a re-ask — and three unclear answers end the call on
  // the right person (`MAX_IDENTITY_REASKS`).
  //
  // "this is she" / "this is he" are the nominative forms of the two
  // entries already here. Both are ordinary on an Indian English call
  // and neither was covered.
  //
  // SAFE AGAINST THE DENIAL IT CONTAINS: "That's not me." stays
  // `denied`, because `DENIALS` is checked BEFORE this table and
  // carries "not me". That ordering is the existing design and is not
  // touched — it is asserted from both sides in the identity tests.
  "that s me", "this is she", "this is he",
  "speaking", "yes speaking", "im speaking", "you are speaking with",
  "bol raha hoon", "bol rahi hoon", "bol raha hu", "bol rahi hu",
  "bol raha", "bol rahi", "main hi hoon", "main hi hu", "wahi hoon",
  "बोल रही हूँ", "बोल रहा हूँ", "मैं ही हूँ",
];

const CONFIRMATIONS = [
  "yes", "yeah", "yep", "yup", "correct", "that is me", "thats me", "this is me",
  // Kept in step with `SELF_IDENTIFICATIONS` above, which already
  // duplicates "thats me" / "this is me" / "this is her" / "this is
  // him" into this table. A spelling that identifies the speaker in one
  // list and not the other is how the two drift apart.
  "that s me", "this is she", "this is he",
  "this is her", "this is him", "speaking", "yes speaking", "im sakshi",
  "you are", "you have", "right", "of course", "sure",
  "haan", "han", "ha ji", "haan ji", "ji haan", "ji", "bilkul", "sahi",
  // ── THE UNSPACED SPELLING OF THE ENTRY ABOVE ────────────────────
  //
  // Deepgram writes this word as one token as often as two, and
  // `contains` is whole-word containment over `normaliseText`, so
  // " haanji " matched neither " haan ji " nor " haan ". The commonest
  // Hinglish answer to "Am I speaking with Sakshi?" therefore read as
  // `unclear` in half its renderings: the caller confirmed, the gate
  // re-asked "Sorry — am I speaking with…?", and a caller who answers
  // the same way twice more is given up on by `MAX_IDENTITY_REASKS` —
  // the call ended on the RIGHT person (read-only audit 2026-09-23,
  // M11 follow-up).
  //
  // NOT NEW VOCABULARY, AND NOT A NEW DEVICE. `classifier.ts` already
  // carries these two spellings for this exact reason, with the same
  // note; this is the same repair `SELF_IDENTIFICATIONS` carries for
  // "that s me" and `QUESTIONS_BACK` for "who s this" — a rendering of
  // a phrase this table already accepts, so nothing the gate rejects
  // today becomes acceptable.
  //
  // SAFE AGAINST THE ORDER ABOVE IT. `QUESTIONS_BACK` and `DENIALS`
  // are both read BEFORE this table, so neither is affected, and the
  // hearing exclusion is decided before the gate ever calls this
  // function (`turnAnsweredHearingCheckOnly`) — so a "haanji" that
  // answered "can you hear me okay?" still cannot confirm identity.
  // Nothing in the attention, hearing or pickup vocabulary is touched:
  // `BARE_GREETING_ONLY`, `HEARING_CONFIRMATION_ONLY` and
  // `PICKUP_GREETING_ONLY` already carry their own spellings and are
  // not read from here.
  "haanji", "hanji",
  "bol raha hoon", "bol rahi hoon", "bol raha hu", "bol rahi hu",
  "bol raha", "bol rahi", "main hi hoon", "main hi hu", "wahi hoon",
  "हाँ", "हां", "जी", "जी हाँ", "बिल्कुल", "बोल रही हूँ", "बोल रहा हूँ", "मैं ही हूँ",
  // English "yes" as Soniox writes it in Devanagari. Real call 9636aa69
  // (2026-09-24): "यस।" twice read `unclear`, drew two re-asks, and the
  // caller had to repeat themselves in Hindi before the gate opened.
  "यस", "येस", "यप",
  // ...and "right" / "correct" / "speaking", entries above, the same way.
  // Real call 6d25ea34 (2026-09-26): "राइट।" read `unclear` and cost a re-ask.
  "राइट", "करेक्ट", "स्पीकिंग",
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
  // ── THE SPLIT SPELLING OF THE ENTRY ABOVE ───────────────────────
  //
  // `normaliseText` reduces every non-letter to a space, so "Who's
  // this?" reaches this table as " who s this " — which matches
  // neither "who is this" nor "whos this", the two spellings already
  // here. The question therefore answered nothing and fell through to
  // `CONFIRMATIONS`, where "right" is an entry, so "Right, who's
  // this?" CONFIRMED the caller's identity and the pitch was spoken to
  // somebody who had just asked who was calling (read-only audit
  // 2026-09-22, M10; reproduced through the harness).
  //
  // A spelling of a phrase already in this table, not new vocabulary —
  // the same repair `SELF_IDENTIFICATIONS` below carries for "that s
  // me", and the whole of the safety case for it.
  "who s this",
  "kya chahiye", "kyun", "kis liye", "kaise",
  "कौन", "कौन बोल", "किससे", "क्या चाहिए", "क्यों",
];

/**
 * A yes that still stands when the same turn asks who is calling.
 *
 * Real call 124b3316 (2026-09-24): "Yeah, you're speaking with me. Who
 * is this?" read as `unclear` because `QUESTIONS_BACK` vetoed the whole
 * turn, three such answers spent `MAX_IDENTITY_REASKS`, and the call was
 * closed on the right person. "Yes, who is this?" answers the question
 * AND asks one back; the gate confirms and the first reply introduces
 * the agent, which is the answer to theirs.
 *
 * Deliberately NOT the whole of `CONFIRMATIONS` / `SELF_IDENTIFICATIONS`:
 * "right", "sure", "ji" are filler in "Right, who's this?" (A8), and
 * "speaking" / "bol raha" occur inside the questions themselves ("who
 * is speaking", "kaun bol raha hai"). Only an explicit yes, or a phrase
 * that cannot be part of the question, is read here.
 */
const AFFIRMATIONS_BESIDE_A_QUESTION = [
  "yes", "yeah", "yep", "yup", "haan", "haan ji", "haanji", "hanji", "ji haan",
  "that is me", "that s me", "this is me", "you are speaking with me", "you re speaking with me",
  "हाँ", "हां", "जी हाँ", "यस", "येस",
];

/** An unmistakable "no, that is not me". */
const DENIALS = [
  "no", "nope", "not me", "wrong number", "wrong person", "you have the wrong",
  "she is not", "he is not", "not here", "does not live here", "doesnt live here",
  "nahi", "nahin", "galat number", "galat", "koi aur", "wo nahi", "main nahi",
  "नहीं", "गलत नंबर", "गलत", "कोई और",
];

/**
 * Phrases that CONTAIN a denial token but are not a denial.
 *
 * "Yes, no problem." is a yes. "Haan, koi problem nahi" is a yes. Both
 * carry "no" / "nahi", `DENIALS` is whole-word containment, and a
 * denial wins outright — so both settled `denied`, and the right person
 * was told we had the wrong number and the call was closed on them
 * (read-only audit 2026-09-22, H3; reproduced through the harness for
 * "Yes, no problem." and "Yes no problem bol rahi hoon.").
 *
 * THE DEVICE IS NOT NEW AND NEITHER IS THE LIST. `classifier.ts` has
 * carried `NEGATION_EXCEPTIONS` for exactly this, for exactly these
 * words, since the day a "no problem" could end a call that was going
 * well; this is that table, verbatim, applied the same way — the phrase
 * is REMOVED from the text before the denials are matched, so it cannot
 * mask itself and cannot be matched twice. Nothing is added to it here:
 * inventing identity-specific vocabulary is how two tables that should
 * agree start to drift.
 *
 * WHAT STILL DENIES. Everything that denies today. A bare "No.", a
 * bare "Nahi.", "No, this isn't Sakshi.", "wrong number", "she is not
 * here", "No, I'm busy." — none of them contains one of these phrases,
 * so none of them is touched. Only the positive constructions are, and
 * only the ones the outcome classifier already treats this way.
 */
const DENIAL_EXCEPTIONS = [
  "no problem", "no issue", "no issues", "no doubt", "no worries",
  "koi baat nahi", "koi dikkat nahi", "koi problem nahi",
];

/**
 * The text with those phrases taken out, so a denial token inside one
 * of them cannot be read as a denial.
 *
 * Operates on the output of `normaliseText`, which is already padded
 * with a space at each end, so a phrase at the very start or the very
 * end is removed exactly as one in the middle is.
 */
function withoutDenialExceptions(normalised: string): string {
  let text = normalised;
  for (const exception of DENIAL_EXCEPTIONS) {
    text = text.split(` ${exception} `).join(" ");
  }
  return text;
}

/** Whole-word containment, on the same normalisation the classifier uses. */
function contains(haystack: string, needles: readonly string[]): boolean {
  const padded = ` ${haystack} `;
  return needles.some((needle) => padded.includes(` ${needle} `));
}

/**
 * The turn without the clauses that ask a question back: "Right. Who's
 * this?" → "Right". Clauses are split on sentence and clause punctuation
 * (dashes included, which is how Soniox marks a cut-off). Returns "" when
 * every clause asks the question.
 */
function answerClausesOf(text: string): string {
  return (text ?? "")
    .split(/[.,?!।;:—–]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !contains(normaliseText(clause), QUESTIONS_BACK))
    .join(". ");
}

/**
 * Did the caller ask who is calling? Read by the gate only, to put the
 * agent's own name in front of the re-ask (`identityReAskFor`).
 */
export function asksWhoIsCalling(text: string): boolean {
  return contains(normaliseText(text ?? ""), QUESTIONS_BACK);
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
  //    ...unless the same turn also says yes, and says no "no": see
  //    `AFFIRMATIONS_BESIDE_A_QUESTION`.
  if (contains(normalised, QUESTIONS_BACK)) {
    const deniesToo = contains(withoutDenialExceptions(normalised), DENIALS);
    const name = normaliseText(customerName ?? "").trim();
    const firstName = name.split(" ")[0] ?? "";
    const saysYes =
      contains(normalised, AFFIRMATIONS_BESIDE_A_QUESTION) ||
      (name.length > 1 && contains(normalised, [name])) ||
      (firstName.length > 2 && contains(normalised, [firstName]));
    if (deniesToo) return "unclear";
    if (saysYes) return "confirmed";
    // ...and whatever confirms ON ITS OWN confirms beside a question too.
    // Real call dcd398b4 (2026-09-26): "Right. Who's this?" twice read
    // `unclear` while "Right." alone confirms, and the call was closed on
    // the right person. The clauses that ask the question are dropped and
    // the rest is read by this same function, so one vocabulary decides
    // both and no second table can drift from `CONFIRMATIONS`. A turn that
    // is nothing but the question leaves no remainder and stays `unclear`.
    const answer = answerClausesOf(text);
    return answer.length > 0 && classifyIdentityAnswer(answer, customerName) === "confirmed"
      ? "confirmed"
      : "unclear";
  }

  // 2. A denial wins outright, whatever else is in the turn — but a
  //    "no" inside "no problem" is not one of them. See
  //    `DENIAL_EXCEPTIONS`; only this test reads the reduced text, so
  //    every table below still sees the turn as the caller said it.
  if (contains(withoutDenialExceptions(normalised), DENIALS)) return "denied";

  // 3. Did they IDENTIFY THEMSELVES? Their own name back, or a phrase
  //    that says so in words. This is checked before the hearing
  //    exclusion below and not after, because one turn often carries
  //    both: "Yes, I can hear you, this is Sakshi" answers the hearing
  //    question AND the identity one, and reading only the first half
  //    of it would re-ask a question they have just answered.
  const name = normaliseText(customerName ?? "").trim();
  if (name.length > 1 && contains(normalised, [name])) return "confirmed";
  // The first name alone: "I am Shivangi" for "Shivangi Silswal".
  const firstName = name.split(" ")[0] ?? "";
  if (firstName.length > 2 && contains(normalised, [firstName])) return "confirmed";
  if (contains(normalised, SELF_IDENTIFICATIONS)) return "confirmed";

  // 4. Otherwise "yes, I can hear you" answers the wrong question. It
  //    has to come before the bare affirmations, because it contains
  //    one.
  if (contains(normalised, HEARING_ANSWERS)) return "unclear";

  // 5. ...and a bare yes to the question we actually asked.
  if (contains(normalised, CONFIRMATIONS)) return "confirmed";

  return "unclear";
}
