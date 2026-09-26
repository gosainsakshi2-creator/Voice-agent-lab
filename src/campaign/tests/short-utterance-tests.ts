/**
 * short-utterance-tests.ts — `npm run test:short-utterance`
 *
 * PHASE 1 — SHORT-UTTERANCE RELIABILITY.
 *
 * The whole of a caller's answer is often one word: "yes", "no",
 * "okay", "haan", "haan ji", "nahi". Everything downstream of the
 * transcript — the disposition, the registrations sheet, the live
 * hangup — hangs on that one word being read the way the pipeline
 * already read it, and two defects were found where it was not.
 *
 * DEFECT 1 — A RECOGNISED YES, LOST AT THE LAST STEP. Deepgram returns
 * "haan ji" as one token as often as two ("haanji", "hanji"), and the
 * pipeline has always known that: `ACKNOWLEDGEMENT_TOKENS` and
 * `BARE_GREETING_ONLY` in `core/session` carry the unspaced spellings,
 * and the barge-in and silence-recovery suites feed "Haanji." as a
 * literal. `AFFIRMATIONS` in the classifier did not, and phrase
 * matching is WHOLE-WORD, so " haanji " matched neither " haan " nor
 * " ji ". STT succeeded, turn detection succeeded, the model answered
 * — and the call settled `unclear` / `no_decisive_signal`: no
 * `confirmed_at_gate`, no FINAL_YES, no sheet row, no auto-hangup.
 *
 * DEFECT 2 — A REFUSAL WRITTEN AS A REGISTRATION. "ji" is an
 * affirmation on its own ("Ji." at the gate is a real yes) and it also
 * sits inside "nahi ji", the commonest polite Hinglish no. The gate
 * rule runs before the refusal rule and short-circuits, so:
 *
 *     gate -> "Ji nahi."  -> declined              (correct)
 *     gate -> "Nahi ji."  -> registered_confirmed  (WRONG)
 *
 * The two differ only in which token lands last. A person who declined
 * was written to the registrations sheet and hung up on with FINAL_YES.
 *
 * NEITHER IS AN STT DEFECT, and this suite asserts that boundary
 * directly: group F pins the invariant that the classifier reads every
 * spelling the pipeline already accepts. Deepgram keyword boosting was
 * evaluated and deliberately NOT applied — Deepgram's own keyterm
 * guidance is to avoid "generic common words" and "overly broad terms",
 * which is exactly what this vocabulary is.
 *
 * Every case asserts all three readings of the same call together — the
 * contact disposition, the sheet gate `isFinalYes`, and the live hangup
 * `definitiveAnswerIn` — for the reason `confirmation-binding-tests.ts`
 * gives: a fix that moves one without the others is how a call hangs up
 * as a refusal while a registration row is withheld.
 *
 * SECTIONS
 *   A  English short yes at the gate
 *   B  Hinglish short yes at the gate, every spelling
 *   C  English and Hinglish short no at the gate — incl. the "nahi ji" family
 *   D  bare short utterances WITHOUT sufficient context decide nothing
 *   E  a short answer to an agent question that commits nothing
 *   F  the pipeline/classifier spelling invariant
 *   G  confirmation binding is unchanged by the new spellings
 *   H  the paraphrased gate accepts the short spellings too
 *
 * NOTHING HERE PLACES A CALL, TOUCHES A DATABASE, OR CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";

import { classifyOutcome } from "../outcome/classifier";
import { dispositionFor } from "../outcome/disposition";
import { isFinalYes } from "../integrations/final-yes-sheet";
import { definitiveAnswerIn } from "../dispatch/call-runner";
import { isBareAcknowledgement } from "../../core/session/turn-detection";

import type { ConversationTurn } from "../../types/provider.types";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
  }
}

const section = (title: string) => console.log(`\n${title}`);

const turn = (role: "assistant" | "user", text: string): ConversationTurn => ({
  role,
  content: text,
  timestamp: new Date(),
});
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
const CLOSING = "No problem at all, thanks for your time. Have a good day.";
const STATEMENT = "The workshop is on Saturday at 11 am and it runs for 90 minutes.";
const PERMISSION = "Can I tell you in 20 seconds why I think you should attend?";

/** One call, read the three ways production reads it. */
function settle(turns: readonly ConversationTurn[]) {
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns.map((t) => ({ role: t.role as "user" | "assistant", text: t.content, at: null })),
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return {
    outcomeType: classification.outcomeType,
    primaryReason: classification.primaryReason,
    disposition,
    sheet: isFinalYes(classification, disposition),
    live: definitiveAnswerIn(turns, "registration"),
  };
}

/** The gate, answered with `line`, with the agent's reply already spoken. */
const atGate = (line: string, reply = CONFIRMED) => [
  agent("Hi Priya, this is Ishita from Team FlexiFunnels."),
  agent(GATE),
  caller(line),
  agent(reply),
];

/** A short yes at the gate must settle as a registration, all three ways. */
function expectRegistration(line: string, why: string): void {
  const r = settle(atGate(line));
  assert.equal(r.outcomeType, "registered_confirmed", `${why} (was ${r.outcomeType}/${r.primaryReason})`);
  assert.equal(r.primaryReason, "confirmed_at_gate", why);
  assert.equal(r.disposition, "FINAL_YES", why);
  assert.equal(r.sheet, true, "a registration must write a sheet row");
  assert.equal(r.live, "FINAL_YES", "and must end the call as one");
}

/** A short no at the gate must settle as a refusal and never reach the sheet. */
function expectRefusal(line: string, why: string): void {
  const r = settle(atGate(line, CLOSING));
  assert.equal(r.outcomeType, "declined", `${why} (was ${r.outcomeType}/${r.primaryReason})`);
  assert.equal(r.primaryReason, "explicit_no", why);
  assert.equal(r.disposition, "FINAL_NO", why);
  assert.equal(r.sheet, false, "a refusal must never write a sheet row");
  assert.notEqual(r.live, "FINAL_YES", "and must never hang up as a yes");
}

/** Whatever else it is, it is not a registration and writes nothing. */
function expectNotARegistration(turns: readonly ConversationTurn[], why: string): void {
  const r = settle(turns);
  assert.notEqual(r.outcomeType, "registered_confirmed", `${why} (was ${r.outcomeType}/${r.primaryReason})`);
  assert.notEqual(r.disposition, "FINAL_YES", why);
  assert.equal(r.sheet, false, "nothing may be written to the sheet");
  assert.notEqual(r.live, "FINAL_YES", "and nothing may hang up as a yes");
}

// ═════════════════════════════════════════════════════════════════
section("A. ENGLISH — a one-word yes at the gate is a registration");

const ENGLISH_YES = ["Yes.", "Yes", "Yeah.", "Yep.", "Yup.", "Okay.", "OK.", "Sure.", "Alright."];
for (const line of ENGLISH_YES) {
  test(`A — "${line}" at the gate`, () => expectRegistration(line, `"${line}" is a yes at the gate`));
}

// ═════════════════════════════════════════════════════════════════
section("B. HINGLISH — every spelling of the one-word yes, spaced and unspaced");

const HINGLISH_YES = [
  ["Haan.", "the bare affirmative"],
  ["Haa.", "the elongated form"],
  ["Haan ji.", "the polite form, spaced"],
  ["Haanji.", "the polite form as ONE token — Deepgram returns this"],
  ["Hanji.", "the short unspaced form — Deepgram returns this too"],
  ["Han ji.", "the short spaced form"],
  ["Han.", "the short bare form"],
  ["Ji.", "the bare honorific, which alone is a yes"],
  ["Ji haan.", "honorific first"],
  ["हाँ", "Devanagari"],
  ["हां जी", "Devanagari, polite"],
  ["Theek hai.", "agreement rather than affirmation"],
] as const;
for (const [line, why] of HINGLISH_YES) {
  test(`B — "${line}" at the gate (${why})`, () => expectRegistration(line, `"${line}" is a yes at the gate`));
}

// ═════════════════════════════════════════════════════════════════
section("C. A one-word no at the gate is a refusal — including the \"nahi ji\" family");

const SHORT_NO = [
  ["No.", "English"],
  ["Nope.", "English"],
  ["Nahi.", "Hinglish"],
  ["Nahin.", "Hinglish"],
  ["Nai.", "Hinglish"],
  ["Ji nahi.", "honorific FIRST — this one was always correct"],
  ["नहीं", "Devanagari"],
] as const;
for (const [line, why] of SHORT_NO) {
  test(`C — "${line}" at the gate (${why})`, () => expectRefusal(line, `"${line}" is a refusal at the gate`));
}

// DEFECT 2. These carry an affirmation token AFTER the negation, which
// is the only thing that separated them from "Ji nahi." above.
const POLITE_NO = ["Nahi ji.", "Nahin ji.", "Nai ji.", "No ji."];
for (const line of POLITE_NO) {
  test(`C — "${line}" is a POLITE REFUSAL, not the "ji" hiding inside it`, () =>
    expectRefusal(line, `"${line}" must never read as a registration`));
}

test('C — "Nahi ji" and "Ji nahi" settle identically', () => {
  const a = settle(atGate("Nahi ji.", CLOSING));
  const b = settle(atGate("Ji nahi.", CLOSING));
  assert.equal(a.outcomeType, b.outcomeType, "word order must not flip the verdict");
  assert.equal(a.disposition, b.disposition);
  assert.equal(a.sheet, b.sheet);
});

test('C — a polite refusal with its reason attached is still a refusal', () => {
  expectRefusal("Nahi ji, mujhe nahi chahiye.", "the long form was already correct and stays correct");
});

/**
 * THE WHOLE CROSS-PRODUCT, because an incomplete one is what the defect
 * was — and what the FIRST attempt at the fix still was.
 *
 * A hand-written list of the romanized pairs ("nahi ji", "nahin ji",
 * "nai ji", "no ji") left EIGHT of the twelve combinations settling as
 * `registered_confirmed`: every pair whose honorific was Devanagari
 * ("nahi जी"), and every pair whose negation was ("नहीं ji", "नहीं जी").
 * Deepgram runs in `multi` mode and can return either half in either
 * script, mixed included, so the product is the only complete
 * statement of the rule.
 *
 * The reverse order is asserted alongside it: "ji nahi" was never
 * broken, and must not become broken by a fix aimed at the other order.
 */
const REFUSAL_NEGATIONS = ["nahi", "nahin", "nai", "no", "नहीं", "नही"];
const REFUSAL_HONORIFICS = ["ji", "जी"];

test("C — EVERY <no> x <ji> spelling, in both scripts and both orders, is a refusal", () => {
  for (const negation of REFUSAL_NEGATIONS) {
    for (const honorific of REFUSAL_HONORIFICS) {
      for (const line of [`${negation} ${honorific}`, `${honorific} ${negation}`]) {
        const r = settle(atGate(`${line}.`, CLOSING));
        assert.equal(
          r.outcomeType,
          "declined",
          `"${line}" settled ${r.outcomeType}/${r.primaryReason} — a refusal read as a registration`,
        );
        assert.equal(r.sheet, false, `"${line}" must never write a sheet row`);
        assert.notEqual(r.live, "FINAL_YES", `"${line}" must never hang up as a yes`);
      }
    }
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. A bare short utterance WITHOUT sufficient context decides nothing");

test("D1 — a short yes with no question before it at all is not a registration", () => {
  for (const line of ["Haanji.", "Hanji.", "Han.", "Haan.", "Yes.", "Okay."]) {
    expectNotARegistration(
      [agent("Hi Priya, this is Ishita."), agent(STATEMENT), caller(line), agent("Right.")],
      `"${line}" answers no committing question`,
    );
  }
});

test("D2 — a short yes to the PERMISSION question is engagement, not a confirmation", () => {
  for (const line of ["Haanji.", "Hanji.", "Han.", "Yes.", "Sure."]) {
    const r = settle([agent(PERMISSION), caller(line), agent("Great, so here is the thing.")]);
    assert.equal(r.outcomeType, "interested_not_confirmed", `"${line}" must not commit anything`);
    assert.equal(r.primaryReason, "affirmative_not_at_gate");
    assert.equal(r.sheet, false);
    assert.notEqual(r.live, "FINAL_YES");
  }
});

test("D3 — the caller saying nothing but a greeting decides nothing", () => {
  for (const line of ["Hello?", "Hello.", "Hi."]) {
    expectNotARegistration(
      [agent("Hi Priya, this is Ishita."), agent(GATE), caller(line), agent("Can you hear me okay?")],
      `"${line}" is not an answer`,
    );
  }
});

test("D4 — a short yes inside a QUESTION is not an answer", () => {
  expectNotARegistration(
    [agent(GATE), caller("Haanji, but what is the fee?"), agent("It is completely free.")],
    "a question carrying an affirmation token commits nothing on its own",
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. A short answer to an agent question that commits nothing");

test("E1 — a short no to an unrelated agent question keeps a registration already given", () => {
  const r = settle([
    agent(GATE),
    caller("Haanji."),
    agent(CONFIRMED),
    agent("Have you attended one of our workshops before?"),
    caller("Nahi."),
    agent("No problem at all, see you Saturday."),
  ]);
  assert.equal(r.outcomeType, "registered_confirmed", "a no about something else retracts nothing");
  assert.equal(r.disposition, "FINAL_YES");
  assert.equal(r.sheet, true);
});

test("E2 — a short POLITE no to an unrelated agent question also retracts nothing", () => {
  const r = settle([
    agent(GATE),
    caller("Haan ji."),
    agent(CONFIRMED),
    agent("Shall I also send it to your email?"),
    caller("Nahi ji."),
    agent("Sure, WhatsApp only. See you Saturday."),
  ]);
  assert.equal(r.outcomeType, "registered_confirmed", "a delivery preference is not a retraction");
  assert.equal(r.sheet, true);
});

// ═════════════════════════════════════════════════════════════════
section("F. THE INVARIANT — the classifier reads every spelling the pipeline accepts");

/**
 * The yes-family tokens the PIPELINE already treats as a bare
 * acknowledgement. Listed here rather than imported because the
 * pipeline's table is deliberately wider than this one — it also holds
 * "right", "fine", "good", "achha", which are NOT affirmations at a
 * commitment question and must never become them. This is the
 * yes-family subset, and the point of the group is that no spelling of
 * a word already in the classifier's table may be missing from it.
 */
const YES_FAMILY_SPELLINGS = [
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure",
  "haan", "haa", "han", "hanji", "han ji", "haan ji", "haanji", "ji", "ji haan",
  "हाँ", "हां", "जी", "जी हाँ",
];

test("F1 — every yes-family spelling the pipeline accepts also settles at the gate", () => {
  for (const token of YES_FAMILY_SPELLINGS) {
    const r = settle(atGate(`${token}.`));
    assert.equal(
      r.outcomeType,
      "registered_confirmed",
      `the pipeline accepts "${token}" but the classifier settled ${r.outcomeType}/${r.primaryReason}`,
    );
  }
});

test("F2 — and the pipeline really does accept all of them (both halves of the invariant)", () => {
  for (const token of YES_FAMILY_SPELLINGS) {
    assert.equal(isBareAcknowledgement(token), true, `the pipeline no longer accepts "${token}"`);
  }
});

test("F3 — the unspaced spellings settle EXACTLY as the spaced ones do", () => {
  const spaced = settle(atGate("Haan ji."));
  for (const token of ["Haanji.", "Hanji."]) {
    const r = settle(atGate(token));
    assert.equal(r.outcomeType, spaced.outcomeType, `"${token}" must match "Haan ji."`);
    assert.equal(r.disposition, spaced.disposition);
    assert.equal(r.sheet, spaced.sheet);
    assert.equal(r.live, spaced.live);
  }
});

test("F4 — bare \"ha\" is deliberately NOT an affirmation (it collides with laughter)", () => {
  expectNotARegistration(atGate("Ha.", "Sorry, could you say that again?"), '"ha" is not in the table');
});

/**
 * The DELIBERATE half of the alignment, and the reason F1 lists a
 * subset rather than importing the pipeline's table wholesale.
 *
 * The roadmap's own audit (§B2) names these as "not consistently
 * treated as affirmative gate answers". That is true, and it stays
 * true: the pipeline's table answers "may the assistant keep talking
 * through this?", which is a far weaker question than "did this person
 * agree to be registered?". "Hmm." to a commitment question is not
 * consent, and promoting it would write a sheet row and hang up on
 * somebody who said nothing of the kind — the exact false-positive
 * class the alignment is supposed to REMOVE.
 *
 * Aligning the two tables therefore means aligning the SPELLINGS of
 * words that are already affirmations, not merging the vocabularies.
 * This test is that boundary, asserted from both sides.
 */
test("F5 — the pipeline's wider acknowledgement vocabulary is NOT promoted to a yes", () => {
  const NOT_AFFIRMATIONS = [
    "right", "fine", "correct", "good", "nice", "cool", "great",
    "achha", "acha", "accha", "hmm", "sahi", "theek", "samajh gaya", "got it", "i see",
  ];
  for (const token of NOT_AFFIRMATIONS) {
    assert.equal(isBareAcknowledgement(token), true, `precondition: the pipeline accepts "${token}"`);
    expectNotARegistration(
      atGate(`${token}.`, "Sorry, is that a yes?"),
      `"${token}" must not become a registration`,
    );
  }
});

test('F6 — "theek hai" IS a yes and bare "theek" is not — the distinction is kept', () => {
  expectRegistration("Theek hai.", '"theek hai" is agreement');
  expectNotARegistration(atGate("Theek.", "Sorry, is that a yes?"), '"theek" alone is not');
});

// ═════════════════════════════════════════════════════════════════
section("G. CONFIRMATION BINDING is unchanged by the new spellings");

test("G1 — a short yes at the gate, then a retraction, is declined", () => {
  for (const yes of ["Haan ji.", "Haanji.", "Hanji.", "Yes.", "Han."]) {
    for (const back of ["Actually nahi, cancel kar dijiye.", "Actually no, cancel it.", "Main nahi aaunga."]) {
      const r = settle([agent(GATE), caller(yes), agent("Great, done."), caller(back), agent(CLOSING)]);
      assert.equal(r.outcomeType, "declined", `"${yes}" then "${back}" must retract`);
      assert.equal(r.sheet, false, "a retracted registration must never reach the sheet");
      assert.notEqual(r.live, "FINAL_YES");
    }
  }
});

test("G2 — a courtesy sign-off after a no is still a no, whichever spelling it uses", () => {
  for (const tail of ["Haan ji, thanks.", "Haanji, thanks.", "Hanji, thanks.", "Okay, thanks.", "Han, thanks."]) {
    const r = settle([agent(GATE), caller("No."), agent(CLOSING), caller(tail), agent("Take care.")]);
    assert.equal(r.outcomeType, "declined", `"${tail}" is courtesy, not a change of mind`);
    assert.equal(r.sheet, false);
  }
});

test("G3 — a yes is not acted on while the agent's latest turn is itself a question", () => {
  const r = settle([agent(GATE), caller("Haanji."), agent("Sorry, shall I reserve the seat then?")]);
  assert.equal(r.live, undefined, "the person is about to answer the re-asked question");
});

// ═════════════════════════════════════════════════════════════════
section("H. THE PARAPHRASED GATE accepts the short spellings too");

const PARAPHRASED = [
  "Would you like me to put you down for it?",
  "Should I go ahead and reserve this for you?",
  "Can I get you registered for this?",
];
test("H1 — a one-word yes to a paraphrased gate is a registration", () => {
  for (const gate of PARAPHRASED) {
    for (const yes of ["Yes.", "Haanji.", "Hanji.", "Haan ji.", "Han."]) {
      const r = settle([agent(gate), caller(yes), agent(CONFIRMED)]);
      assert.equal(
        r.outcomeType,
        "registered_confirmed",
        `"${yes}" to "${gate}" settled ${r.outcomeType}/${r.primaryReason}`,
      );
      assert.equal(r.sheet, true);
    }
  }
});

test("H2 — and a one-word POLITE no to a paraphrased gate is a refusal", () => {
  for (const gate of PARAPHRASED) {
    for (const no of ["No.", "Nahi.", "Nahi ji.", "Ji nahi."]) {
      const r = settle([agent(gate), caller(no), agent(CLOSING)]);
      assert.equal(r.outcomeType, "declined", `"${no}" to "${gate}" settled ${r.outcomeType}`);
      assert.equal(r.sheet, false);
    }
  }
});

// ═════════════════════════════════════════════════════════════════
section("J. \"hello\" — a greeting decides nothing, in either direction");

/**
 * "hello" is on the Phase 1 short-utterance list but is NOT a verdict
 * token, and this group pins both halves of that.
 *
 * It must never become an affirmation or a negation at the gate — it is
 * the caller checking the line, not answering. And the pipeline side
 * must stay exactly as it is: `isBareAcknowledgement` deliberately
 * EXCLUDES "hello" (over a playing reply it means the line has gone
 * bad and it must interrupt), while `isAttentionCheck` accepts it. This
 * pass changed neither, and asserting them here is what makes that
 * visible if a later vocabulary edit reaches for the wrong table.
 *
 * Roadmap §4.2 also requires that a single casual "hello" not become an
 * unnecessary hearing-check episode. That decision lives in the
 * pipeline (`handleAttentionCheck` opens an episode only with a held
 * remainder, or on the STRICT `isHearingCheck` / `isEmphaticHearingCheck`
 * vocabulary) and is covered by `test:attention` and
 * `test:silence-recovery`; nothing in this pass touches it.
 */
test("J1 — \"hello\" at the gate is neither a yes nor a no", () => {
  for (const line of ["Hello.", "Hello?", "Hello hello?", "Hi.", "Hey."]) {
    const r = settle(atGate(line, "Yes, I can hear you. Shall I reserve it?"));
    expectNotARegistration(atGate(line, "Yes, I can hear you."), `"${line}" is not a yes`);
    assert.notEqual(r.outcomeType, "declined", `"${line}" is not a no either`);
  }
});

test("J2 — a greeting does not cancel a registration already given", () => {
  const r = settle([
    agent(GATE),
    caller("Haanji."),
    agent(CONFIRMED),
    caller("Hello? Are you there?"),
    agent("Yes, I am here. See you Saturday."),
  ]);
  assert.equal(r.outcomeType, "registered_confirmed", "a line check retracts nothing");
  assert.equal(r.sheet, true);
});

test("J3 — the pipeline's reading of \"hello\" is untouched by this pass", () => {
  // "hello" is NOT an acknowledgement: over a playing reply it must
  // still interrupt. This is the pipeline's judgement, asserted here
  // only so a vocabulary change in the classifier cannot quietly
  // assume otherwise.
  assert.equal(isBareAcknowledgement("hello"), false, '"hello" must not be a bare acknowledgement');
  assert.equal(isBareAcknowledgement("hello hello"), false);
  // ...and the new Hinglish spellings did not leak into that table.
  for (const token of ["haanji", "hanji", "haan ji"]) {
    assert.equal(isBareAcknowledgement(token), true, `"${token}" is still an acknowledgement`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("K. A short yes at the END of an agent question is still a real answer");

/**
 * Roadmap §4.1: "a short yes/yeah/okay/haan near the end of an agent
 * question must remain eligible as a real answer." The timing half of
 * that lives in the pipeline and is covered by `test:barge-in` and
 * `test:ack-continuity`. The half this file owns is that once such an
 * answer HAS reached the transcript, the classifier reads it as the
 * answer to that question — in every spelling.
 */
test("K1 — every short yes is eligible as the answer to the gate", () => {
  for (const line of ["Yes.", "Yeah.", "Okay.", "Haan.", "Haan ji.", "Haanji.", "Hanji."]) {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, "registered_confirmed", `"${line}" must answer the gate`);
    assert.equal(r.live, "FINAL_YES", `"${line}" must be actionable live`);
  }
});

test("K2 — and is bound to the LATEST question, not an earlier one", () => {
  // An affirmation said BEFORE the gate can never be reused as the
  // answer to it — the existing backward-only binding. Asserted in the
  // new spellings so the fix cannot have widened it.
  const r = settle([
    agent("Can I tell you in 20 seconds why I think you should attend?"),
    caller("Haanji."),
    agent("Great — it is a free 90-minute live workshop on Saturday."),
    agent(GATE),
    agent("Sorry, I did not catch that — shall I reserve it?"),
  ]);
  assert.notEqual(r.outcomeType, "registered_confirmed", "an early yes is not an answer to a later gate");
  assert.equal(r.sheet, false);
  assert.notEqual(r.live, "FINAL_YES");
});

// ═════════════════════════════════════════════════════════════════
section("I. ADVERSARIAL — a new spelling may not behave differently from the old one");

/**
 * The guard that matters most, and the one this pass was nearly caught
 * by. Adding a spelling to a phrase table is only safe if it lands in
 * EXACTLY the same place as the word it spells — otherwise it is new
 * vocabulary wearing a spelling's clothes.
 *
 * Every pair below is one line written the new way and the same line
 * written a way the table already carried. Some of these settle as a
 * registration and arguably should not ("Mera naam Han Lee hai." is a
 * NAME, not a yes) — but they did so before this change too, because
 * any name containing "haan", "ji" or "yes" does. That is a property of
 * whole-word phrase matching and is deliberately NOT addressed here:
 * the assertion is parity, not perfection, and a pass that quietly
 * changed it would be changing the gate binding under cover of a
 * spelling fix.
 */
const SPELLING_PAIRS: readonly (readonly [string, string])[] = [
  ["Mera naam Han Lee hai.", "Mera naam Haan Lee hai."],
  ["Han, lekin mujhe pehle price jaanna hai.", "Haan, lekin mujhe pehle price jaanna hai."],
  ["Haanji but I am not sure yet.", "Haan ji but I am not sure yet."],
  ["Hanji, pata nahi abhi.", "Haan ji, pata nahi abhi."],
  ["Haanji, mujhe nahi chahiye.", "Haan ji, mujhe nahi chahiye."],
  ["Haanji, thanks.", "Haan ji, thanks."],
  ["Nahi ji.", "Ji nahi."],
  // The polite-refusal strip removes "<no> ji" and nothing else, so a
  // mixed-sentiment turn must read exactly as the same turn without the
  // honorific. Both settle `unclear`: the Hinglish "matlab" turns are
  // marked non-decisive by the unfinished-turn reader, which is
  // pre-existing, is not short-utterance-specific (the English "No, I
  // mean yes, I will come." is decisive and registers), and is not
  // touched here.
  ["Nahi ji, matlab haan main aaunga.", "Nahi, matlab haan main aaunga."],
  ["Nahi ji koi dikkat nahi, kar dijiye.", "Nahi koi dikkat nahi, kar dijiye."],
];
test("I1 — each new spelling settles exactly where its existing equivalent does", () => {
  for (const [fresh, existing] of SPELLING_PAIRS) {
    const A = settle(atGate(fresh, "Understood."));
    const B = settle(atGate(existing, "Understood."));
    assert.equal(A.outcomeType, B.outcomeType, `"${fresh}" vs "${existing}"`);
    assert.equal(A.disposition, B.disposition, `"${fresh}" vs "${existing}"`);
    assert.equal(A.sheet, B.sheet, `"${fresh}" vs "${existing}"`);
    assert.equal(A.live, B.live, `"${fresh}" vs "${existing}"`);
  }
});

test("I1b — the Devanagari yes is unaffected by the polite-refusal strip", () => {
  // The strip removes "<no> ji" only. A Devanagari yes, with or without
  // the honorific, must be untouched by it.
  for (const line of ["हाँ", "हां", "जी", "हाँ जी", "जी हाँ", "हां जी"]) {
    const r = settle(atGate(`${line}`));
    assert.equal(r.outcomeType, "registered_confirmed", `"${line}" is a yes and must stay one`);
  }
});

test("I2 — opt-out still outranks a short yes, in either spelling", () => {
  for (const line of ["Haanji, but take me off your list.", "Nahi ji, do not call me again."]) {
    const r = settle(atGate(line, "Understood, removing you."));
    assert.equal(r.outcomeType, "do_not_call", `"${line}" must remain an opt-out`);
    assert.equal(r.primaryReason, "opt_out");
    assert.equal(r.sheet, false);
  }
});

test("I3 — a machine's greeting still contributes no affirmation", () => {
  const r = settle([
    agent("Hi Priya, this is Ishita."),
    caller("Ji, aap jis vyakti ko call kar rahe hain abhi uplabdh nahi hai. Sandesh record kijiye."),
    agent("..."),
  ]);
  assert.equal(r.outcomeType, "no_engagement");
  assert.equal(r.primaryReason, "suspected_voicemail");
  assert.equal(r.sheet, false);
});

/**
 * A hedge attached to a short yes reads the same way whichever spelling
 * the yes uses — which is all this pass is entitled to assert.
 *
 * `AFFIRMATION_EXCEPTIONS` strips the hedge ("dekhta hu", "i will see")
 * and nothing else, so a SEPARATE affirmation token in the same turn
 * still affirms: "Haanji, dekhta hu." settles `registered_confirmed`,
 * and so does the plain English "Yes, I will see." That is arguably
 * wrong — it is a person saying they will think about it — but it is
 * PRE-EXISTING, it is not short-utterance-specific, and correcting it
 * means changing how the exception list interacts with the gate rule,
 * i.e. the confirmation binding this pass is not permitted to touch.
 * Recorded here as parity so the behaviour is visible and so a future
 * pass that does fix it cannot fix it for one spelling only.
 */
test("I4 — a hedge attached to a short yes reads the same in every spelling", () => {
  const HEDGES: readonly (readonly [string, string])[] = [
    ["Hanji, pata nahi abhi.", "Haan ji, pata nahi abhi."],
    ["Haanji, dekhta hu.", "Haan ji, dekhta hu."],
    ["Han, sochkar batata hu.", "Haan, sochkar batata hu."],
  ];
  for (const [fresh, existing] of HEDGES) {
    const A = settle(atGate(fresh, "Sure, take your time."));
    const B = settle(atGate(existing, "Sure, take your time."));
    assert.equal(A.outcomeType, B.outcomeType, `"${fresh}" vs "${existing}"`);
    assert.equal(A.sheet, B.sheet, `"${fresh}" vs "${existing}"`);
  }
  // The half that IS a fix: a hedge with no second affirmation token in
  // it settles as no registration, in the new spellings as in the old.
  expectNotARegistration(atGate("Hanji, pata nahi abhi.", "Sure."), "the hedge table still bites");
});

// ═════════════════════════════════════════════════════════════════
section("L. Soniox's dash forms of a bare acknowledgement (Issue 2, call 6c76c123)");

/**
 * Soniox writes a cut-off word as "Yeah—". The acknowledgement check
 * now treats em- and en-dashes as separators; content after one still
 * disqualifies the whole utterance.
 */
test("L1 — plain and dash forms of \"yeah\" are bare acknowledgements", () => {
  for (const line of ["Yeah", "Yeah.", "Yeah!", "Yeah—", "Yeah –", "Yeah, yeah—", "Okay–"]) {
    assert.equal(isBareAcknowledgement(line), true, `"${line}" must be a bare acknowledgement`);
  }
});

test("L2 — an acknowledgement WITH content is never bare, dash or not", () => {
  for (const line of [
    "Yeah, but what's the price?",
    "Yeah— but what's the price?",
    "Yeah – but what's the price?",
    "Yeah, I have a question.",
    "Yes, I'm—",
    "No—",
    "Hello—",
  ]) {
    assert.equal(isBareAcknowledgement(line), false, `"${line}" must NOT be a bare acknowledgement`);
  }
});

test("L3 — plain yes answers at the gate still register (FINAL_YES, sheet) — the classifier's caller path does not read this predicate", () => {
  for (const line of ["Yeah.", "Yes.", "Haan ji."]) {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, "registered_confirmed", `"${line}"`);
    assert.equal(r.live, "FINAL_YES", `"${line}"`);
    assert.equal(r.sheet, true, `"${line}"`);
  }
});

test("L4 — an assistant \"Sure—\" is stepped over in the gate look-back exactly like \"Sure.\"", () => {
  const withTurn = (ack: string) =>
    settle([agent("Hi Priya, this is Ishita from Team FlexiFunnels."), agent(GATE), agent(ack), caller("Yes."), agent(CONFIRMED)]);
  const A = withTurn("Sure—");
  const B = withTurn("Sure.");
  assert.equal(A.outcomeType, B.outcomeType);
  assert.equal(A.sheet, B.sheet);
  assert.equal(A.live, B.live);
});

test("L8 — Soniox's Devanagari 'okay' is a bare acknowledgement, like 'Okay.'", () => {
  for (const line of ["ओके।", "ओके, ओके।", "ओके—"]) {
    assert.equal(isBareAcknowledgement(line), true, `"${line}" must be a bare acknowledgement`);
  }
});

test("L9 — ...but content, a greeting, and the Hindi 'go on' (which must still move the language) are not", () => {
  for (const line of [
    "ओके, price kya hai?", "बताइए, कितने का है?", "हेलो।", "Sir?",
    "Ji boliye", "हाँ, बताइए।", "नहीं।",
  ]) {
    assert.equal(isBareAcknowledgement(line), false, `"${line}" must NOT be a bare acknowledgement`);
  }
});

test('L6 — "ओके।" at the gate is a yes, like "Okay." (real call 33d97c5c)', () => {
  const plain = settle(atGate("Okay."));
  const devanagari = settle(atGate("ओके।"));
  assert.equal(devanagari.outcomeType, "registered_confirmed");
  assert.equal(devanagari.live, plain.live);
  assert.equal(devanagari.sheet, plain.sheet);
});

test('L7 — the real call: "नहीं, नहीं" to the discovery question, then "ओके।" at the gate, registers', () => {
  const r = settle([
    agent("Hi Shabanabanu, मैं Ishita, Team FlexiFunnels से।"),
    caller("ओके।"),
    agent("Sunday, 4th October को 11 AM पर हमारा एक free live workshop है। आपने पहले कभी कुछ online डालने की try की है?"),
    caller("नहीं, नहीं।"),
    agent("ठीक है, कोई बात नहीं। इसके लिए कोई coding या design skill नहीं चाहिए। तो क्या मैं आपकी free seat reserve कर दूँ?"),
    caller("ओके।"),
    agent("Perfect, Shabanabanu — आपकी free seat webinar के लिए reserve हो गयी है।"),
  ]);
  assert.equal(r.outcomeType, "registered_confirmed", `${r.outcomeType}/${r.primaryReason}`);
  assert.equal(r.live, "FINAL_YES");
  assert.equal(r.sheet, true);
});

// ═════════════════════════════════════════════════════════════════
console.log(
  failures.length === 0
    ? `\nALL PASSED — ${passed} passed, 0 failed`
    : `\nFAILURES — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("\nNo telephony, TTS, STT, LLM or database request was made. No call was placed.");
process.exit(failures.length === 0 ? 0 : 1);
