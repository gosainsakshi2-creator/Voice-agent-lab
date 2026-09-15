/**
 * contraction-vocabulary-tests.ts — `npm run test:contractions`
 *
 * PHASE 1 §4.5 BATCH 1 — F1a / F1b.
 *
 * WHAT WAS WRONG. `normaliseText` reduces every non-letter to a single
 * space, so a caller's "don't" reaches the phrase tables as "don t",
 * "can't" as "can t" and "I'm" as "i m". Several entries were written
 * in the apostrophe-less spelling — "dont call", "dont want", "i cant",
 * "im busy" — and those can only ever match text that already has no
 * apostrophe, which speech-to-text does not produce. They were dead.
 *
 * The result was a classifier that understood a sentence or did not
 * depending only on whether the caller used a contraction:
 *
 *   "Do not call me again."  -> do_not_call / FINAL_NO, call ended
 *   "Don't call me again."   -> unclear / UNRESOLVED, kept pitching,
 *                               and redialled 30 minutes later
 *
 *   "I do not want it."      -> declined / FINAL_NO
 *   "I don't want it."       -> unclear / UNRESOLVED, redialled
 *
 * The Hindi and Devanagari halves of the same tables were unaffected
 * throughout, so the blind spot was English-only — the reverse of the
 * usual asymmetry, and invisible to a suite that tested the spelled-out
 * forms.
 *
 * WHAT THIS SUITE PINS, and the distinction is the whole point:
 *
 *   A/B  the contracted spelling now resolves the same way its own
 *        spelled-out equivalent already resolved. Both forms are
 *        asserted side by side in every case, so a future edit cannot
 *        fix or break one spelling alone.
 *
 *   C    the additions did NOT become generic keywords. "don't",
 *        "can't" and "busy" appear constantly in sentences that are
 *        not refusals, and every one of those must settle exactly
 *        where it settled before.
 *
 *   D    opt-out keeps its position above everything, including a yes
 *        at the gate, in both spellings.
 *
 *   E    confirmation binding is unchanged. A refusal that answers a
 *        DIFFERENT question still leaves the registration standing,
 *        whichever spelling it is written in — this is the property
 *        `confirmation-binding-tests` group A exists for, re-asserted
 *        here against the new vocabulary.
 *
 * Every case runs the REAL `classifyOutcome`, `dispositionFor`,
 * `isFinalYes`, `definitiveAnswerIn` and `planRetry`. Nothing is
 * mocked, stubbed or re-implemented.
 *
 * NOTHING HERE PLACES A CALL, TOUCHES A DATABASE, OR CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";

import { classifyOutcome } from "../outcome/classifier";
import { dispositionFor, isDefinitive } from "../outcome/disposition";
import { isFinalYes } from "../integrations/final-yes-sheet";
import { definitiveAnswerIn } from "../dispatch/call-runner";
import { planRetry } from "../dispatch/retry-planner";

import type { RetryConfig } from "../config/dispatch.config";
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

const OPENING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PITCH = "I'm calling to invite you to a free live workshop this Sunday at 11 AM.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
const ACK = "Understood.";

/**
 * The retry policy as it ships. Written out rather than read from the
 * environment so this suite asserts the POLICY and never the contents
 * of whatever `.env.local` happens to hold on the machine running it.
 */
const RETRY: RetryConfig = {
  maxAttempts: 3,
  noAnswerDelayMinutes: 30,
  busyDelayMinutes: 15,
  temporaryBackoffMinutes: [5, 15, 60],
  retryOnRejected: false,
  retryOnUserHangup: false,
  registrationMaxAttempts: 3,
  callbackDelayMinutes: 30,
  unresolvedDelayMinutes: 30,
  retryOnUnresolvedRegistration: true,
};

/** One call, read the four ways production reads it. */
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
  const retry = planRetry("COMPLETED", 1, RETRY, new Date(), {
    campaignType: "registration",
    disposition,
    outcomeType: classification.outcomeType,
  });
  return {
    outcomeType: classification.outcomeType,
    primaryReason: classification.primaryReason,
    disposition,
    sheet: isFinalYes(classification, disposition),
    live: definitiveAnswerIn(turns, "registration"),
    retry: retry.retry,
  };
}

/** The line said straight after the pitch, with the agent's reply spoken. */
const afterPitch = (line: string) => [agent(OPENING), agent(PITCH), caller(line), agent(ACK)];
/** ...and the same line said as the answer to the commitment question. */
const atGate = (line: string) => [agent(OPENING), agent(PITCH), agent(GATE), caller(line), agent(ACK)];

/**
 * The contracted spelling and its spelled-out equivalent must reach
 * the SAME outcome, disposition, sheet gate and retry decision.
 *
 * Asserted as a pair rather than against a hard-coded label on
 * purpose: the property being fixed is that an apostrophe changes
 * nothing, and a pair assertion keeps saying that even if the
 * underlying label for the phrase is revised later.
 */
function expectSameAsExpansion(
  build: (line: string) => ConversationTurn[],
  contracted: string,
  spelledOut: string,
): void {
  const a = settle(build(contracted));
  const b = settle(build(spelledOut));
  assert.equal(
    a.outcomeType,
    b.outcomeType,
    `"${contracted}" settled ${a.outcomeType} but "${spelledOut}" settled ${b.outcomeType}`,
  );
  assert.equal(a.disposition, b.disposition, `"${contracted}" vs "${spelledOut}" — disposition`);
  assert.equal(a.sheet, b.sheet, `"${contracted}" vs "${spelledOut}" — sheet gate`);
  assert.equal(a.retry, b.retry, `"${contracted}" vs "${spelledOut}" — retry decision`);
  assert.equal(a.live, b.live, `"${contracted}" vs "${spelledOut}" — live hangup`);
}

/** An opt-out, read all four ways, and never redialled. */
function expectOptOut(turns: readonly ConversationTurn[], why: string): void {
  const r = settle(turns);
  assert.equal(r.outcomeType, "do_not_call", `${why} (was ${r.outcomeType}/${r.primaryReason})`);
  assert.equal(r.primaryReason, "opt_out", why);
  assert.equal(r.disposition, "FINAL_NO", why);
  assert.ok(isDefinitive(r.disposition), "an opt-out must close the contact permanently");
  assert.equal(r.retry, false, "an opt-out must never schedule another attempt");
  assert.equal(r.sheet, false, "an opt-out must never write a registration row");
}

// ═════════════════════════════════════════════════════════════════
section("A. F1a — A DO-NOT-CALL REQUEST IS ONE IN BOTH SPELLINGS");

const OPT_OUT_PAIRS: readonly (readonly [string, string])[] = [
  ["Don't call me again.", "Do not call me again."],
  ["Don't call me.", "Do not call me."],
  ["Please don't call me again.", "Please do not call me again."],
  // The Hindi imperative. "karo" was already read; "karna" is the same
  // request in the form people actually use after "aage se".
  ["Aage se call mat karna.", "Aage se call mat karo."],
  ["Mujhe phone mat karna.", "Mujhe phone mat karo."],
];

for (const [contracted, spelledOut] of OPT_OUT_PAIRS) {
  test(`A. "${contracted}" is an opt-out, FINAL_NO, and never redialled`, () => {
    expectOptOut(afterPitch(contracted), "a do-not-call request must close the contact");
  });
  test(`A. "${contracted}" resolves exactly as "${spelledOut}"`, () => {
    expectSameAsExpansion(afterPitch, contracted, spelledOut);
  });
}

test("A. the opt-out is read wherever it is said, including at the gate", () => {
  for (const line of ["Don't call me again.", "Aage se call mat karna."]) {
    expectOptOut(atGate(line), `"${line}" said at the gate is still an opt-out`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. F1b — A REFUSAL READS THE SAME IN BOTH SPELLINGS");

/**
 * Left column contracted, right column spelled out. The assertion is
 * EQUALITY between the two, not a fixed label: "I don't have time." is
 * paired with "I do not have time." and both are correctly undecided
 * today, which is exactly as much as this batch claims to fix. What it
 * refuses to allow is the two disagreeing.
 */
const REFUSAL_PAIRS: readonly (readonly [string, string])[] = [
  ["I don't want it.", "I do not want it."],
  ["I don't want to.", "I do not want to."],
  // The exact pair `agent-hangup` A4's old fixture depended on: the
  // contracted form was invisible, so the call ended as an ordinary
  // sign-off while the spelled-out form ended as a refusal.
  ["No, I don't want to join.", "No, I do not want to join."],
  ["I can't attend.", "I cannot attend."],
  ["I'm busy.", "I am busy."],
  ["I'm not interested.", "I am not interested."],
  // Neither form is decisive today — "do not need" and "do not have
  // time" are in no table. Pinned so that a later batch which adds one
  // of them has to add both.
  ["I don't need it.", "I do not need it."],
  ["I don't have time.", "I do not have time."],
];

for (const [contracted, spelledOut] of REFUSAL_PAIRS) {
  test(`B. "${contracted}" resolves exactly as "${spelledOut}"`, () => {
    expectSameAsExpansion(atGate, contracted, spelledOut);
  });
}

test("B. the refusals that are decisive close the contact and stop the retries", () => {
  for (const line of ["I don't want it.", "I don't want to.", "I can't attend."]) {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, "declined", `"${line}" is a refusal (was ${r.outcomeType})`);
    assert.equal(r.disposition, "FINAL_NO", `"${line}" must close the contact`);
    assert.equal(r.retry, false, `"${line}" must not be redialled`);
    assert.equal(r.sheet, false, `"${line}" must never write a registration row`);
  }
});

test("B. a contracted refusal cuts the LIVE call short exactly as its twin does", () => {
  // `definitiveAnswerIn` is the live watchdog reading, and it is gated
  // on `hasExplicitRefusal` — a separate table from the one that
  // decides the post-call label. Both had the same dead spelling, so
  // both are asserted, or a fix to one would look complete while the
  // agent kept talking to somebody who had already refused.
  for (const [contracted, spelledOut] of [
    ["No, I don't want to join.", "No, I do not want to join."],
    ["I don't want it.", "I do not want it."],
  ] as const) {
    const a = settle(afterPitch(contracted));
    const b = settle(afterPitch(spelledOut));
    assert.equal(a.live, "FINAL_NO", `"${contracted}" must end the live call as a refusal`);
    assert.equal(a.live, b.live, `"${contracted}" vs "${spelledOut}" — live hangup must agree`);
    assert.equal(a.disposition, "FINAL_NO");
    assert.equal(a.retry, false, "a refusal is never redialled");
  }
});

test("B. \"I won't be able to attend.\" is a refusal, not an unresolved redial", () => {
  const r = settle(atGate("I won't be able to attend."));
  assert.equal(r.outcomeType, "declined", `was ${r.outcomeType}/${r.primaryReason}`);
  assert.equal(r.disposition, "FINAL_NO");
  assert.equal(r.retry, false);
});

test("B. \"I'm busy.\" stays a CALLBACK and never becomes a refusal or an opt-out", () => {
  const r = settle(atGate("I'm busy."));
  assert.equal(r.outcomeType, "callback_requested", `was ${r.outcomeType}`);
  assert.equal(r.disposition, "RETRYABLE", "a callback must not close a contact");
  assert.ok(!isDefinitive(r.disposition), "being busy is not a decision");
  assert.equal(r.retry, true, "a callback is exactly the case that IS redialled");
});

test("B. the three dispositions stay distinct on the contracted spellings", () => {
  assert.equal(settle(afterPitch("Don't call me again.")).outcomeType, "do_not_call");
  assert.equal(settle(atGate("I don't want it.")).outcomeType, "declined");
  assert.equal(settle(atGate("I'm busy.")).outcomeType, "callback_requested");
});

// ═════════════════════════════════════════════════════════════════
section("C. ADVERSARIAL — THE ADDITIONS ARE PHRASES, NOT KEYWORDS");

/**
 * Every line here contains "don't", "can't", "won't", "busy" or "mat
 * karna" and is NOT a refusal. Each is asserted against the outcome it
 * produced BEFORE the vocabulary was touched, which is what makes this
 * a regression fence rather than a restatement of the new behaviour.
 */
const UNCHANGED: readonly (readonly [string, string, string])[] = [
  ["I can't hear you.", "unclear", "a hearing complaint is not a refusal"],
  ["I don't know.", "unclear", "not knowing is not refusing"],
  ["Don't worry, I'll be there.", "unclear", "reassurance, in the shape of a negative"],
  ["Fikar mat karna, main aa jaunga.", "unclear", '"mat karna" unbound would make this an opt-out'],
  ["Der mat karna.", "unclear", "the same, with no call/phone in it"],
  ["I'm free on Sunday.", "unclear", "free, not busy"],
];

for (const [line, expected, why] of UNCHANGED) {
  test(`C. "${line}" is still ${expected} — ${why}`, () => {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, expected, `was ${r.outcomeType}/${r.primaryReason}`);
    assert.notEqual(r.disposition, "FINAL_NO", "an unrelated sentence must not close the contact");
  });
}

test("C. a QUESTION containing a contraction is never a refusal", () => {
  for (const line of ["Don't I need a laptop?", "I won't need a laptop, right?", "Can't I join later?"]) {
    const r = settle(atGate(line));
    assert.notEqual(r.disposition, "FINAL_NO", `"${line}" is a question, not a decision`);
    assert.notEqual(r.live, "FINAL_NO", `"${line}" must never cut the call short`);
  }
});

test("C. a YES at the gate is still a registration when the turn also carries a contraction", () => {
  // Deliberately NOT "Haan, main busy nahi hoon." — that carries a
  // Devanagari-script negation which out-positions the "haan", so it
  // settled `declined` long before this vocabulary existed and is a
  // different (pre-existing) question about positional ordering.
  for (const line of ["Yes, I don't mind at all.", "Haan, I'm free that day.", "Yes, I can't wait."]) {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, "registered_confirmed", `"${line}" is a yes (was ${r.outcomeType})`);
    assert.equal(r.sheet, true, "and it must still write a registration row");
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. OPT-OUT KEEPS ITS PRECEDENCE, IN BOTH SPELLINGS");

test("D. an opt-out still outranks a yes at the gate", () => {
  for (const line of ["Yes, but don't call me again.", "Haan, par mujhe phone mat karna."]) {
    const r = settle(atGate(line));
    assert.equal(r.outcomeType, "do_not_call", `"${line}" must remain an opt-out (was ${r.outcomeType})`);
    assert.equal(r.primaryReason, "opt_out");
    assert.equal(r.sheet, false, "a compliance signal must never write a registration row");
  }
});

test("D. an opt-out still outranks a callback said in the same turn", () => {
  const r = settle(afterPitch("I'm busy, and don't call me again."));
  assert.equal(r.outcomeType, "do_not_call", `was ${r.outcomeType}`);
  assert.equal(r.retry, false, "an opt-out is never redialled, whatever else the turn said");
});

test("D. the spelled-out opt-out is unchanged, so precedence did not move", () => {
  expectOptOut(atGate("Yes, but do not call me again."), "the pre-existing spelling is untouched");
});

// ═════════════════════════════════════════════════════════════════
section("E. CONFIRMATION BINDING IS UNCHANGED");

/**
 * The property `confirmation-binding-tests` group A pins: a refusal
 * that answers a DIFFERENT question does not take back a registration.
 * Re-asserted here with the newly-readable spellings, because the
 * binding is contextual — `retractsTheGate` returns false for
 * OTHER_QUESTION before any vocabulary is consulted — and that has to
 * stay true of vocabulary that did not previously match.
 */
const UNRELATED: readonly (readonly [string, string])[] = [
  ["Should I send you a newsletter as well?", "I don't want that."],
  ["Shall I also send it to your email?", "I can't check email."],
  ["Should I send a reminder SMS as well?", "No, I don't want it."],
  ["Have you attended one of our workshops before?", "No, I couldn't attend."],
];

for (const [question, line] of UNRELATED) {
  test(`E. "${line}" answering "${question}" keeps the registration`, () => {
    const r = settle([
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      agent(question),
      caller(line),
      agent("Sure, noted. Take care."),
    ]);
    assert.equal(r.outcomeType, "registered_confirmed", `was ${r.outcomeType}/${r.primaryReason}`);
    assert.equal(r.disposition, "FINAL_YES");
    assert.equal(r.sheet, true, "the sheet gate must agree with the disposition");
  });
}

test("E. a hearing complaint after the confirmation still leaves the registration standing", () => {
  // The bounded "i can t attend" was chosen over a bare "i can t"
  // precisely so this stays true: "I can't hear you." is the commonest
  // sentence containing that contraction and it decides nothing.
  const r = settle([
    agent(GATE),
    caller("Yes, reserve it."),
    agent(CONFIRMED),
    caller("I can't hear you."),
    agent("Can you hear me now?"),
  ]);
  assert.equal(r.outcomeType, "registered_confirmed", `was ${r.outcomeType}/${r.primaryReason}`);
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
