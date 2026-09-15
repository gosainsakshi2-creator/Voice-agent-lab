/**
 * confirmation-binding-tests.ts — `npm run test:confirmation-binding`
 *
 * WHICH "NO" TAKES BACK A REGISTRATION, AND WHICH ONE DOES NOT.
 *
 * This binding has now been wrong in three different directions, each
 * one expensive and each one invisible to the suite that existed at the
 * time. The history is the specification:
 *
 *   1. ANY later negation invalidated a yes at the gate. A registered
 *      person who answered "No." to "have you attended one before?" was
 *      classified `declined`, hung up on as FINAL_NO, and never written
 *      to the registrations sheet. Group A is that defect.
 *
 *   2. Binding the refusal to the question it answered fixed that, and
 *      left `hasExplicitRefusal` as the only thing that could retract.
 *      That table is shared with the live hangup in `call-runner.ts`
 *      and is deliberately context-free, so it carries "not interested"
 *      and "no need" and carries none of the ways people actually take
 *      a registration back: "Actually no.", "No, forget it.", "Main
 *      nahi aaunga." A caller who cancelled stayed `registered_
 *      confirmed` and reached the sheet. Group B is that defect.
 *
 *   3. The look-back stepped over an assistant acknowledgement as
 *      filler. Once the agent had said "Understood.", a cancellation
 *      said afterwards was bound to the unrelated question two
 *      exchanges back and could not retract anything. Group E is that
 *      defect.
 *
 * Every case runs the REAL paths and asserts all three readings of the
 * same call together — the contact disposition, the sheet gate
 * `isFinalYes`, and the live hangup `definitiveAnswerIn`. A fix that
 * moves one of them without the others is how a call hangs up as a
 * refusal while a registration row is withheld, so they are never
 * asserted apart.
 *
 * NOTHING HERE PLACES A CALL, TOUCHES A DATABASE, OR CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";

import { classifyOutcome } from "../outcome/classifier";
import { dispositionFor } from "../outcome/disposition";
import { isFinalYes } from "../integrations/final-yes-sheet";
import { definitiveAnswerIn } from "../dispatch/call-runner";

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
const RESERVING = "Great, I'll reserve that for you.";
const CLOSING = "No problem at all, thanks for your time. Have a good day.";

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
    disposition,
    sheet: isFinalYes(classification, disposition),
    live: definitiveAnswerIn(turns, "registration"),
  };
}

/**
 * Asserts the disposition AND the sheet gate. The live hangup is
 * deliberately not asserted here: it is narrowed on purpose — a
 * FINAL_NO only cuts a call short when the person's own last words
 * match the shared refusal table — so "Actually no." settles as
 * FINAL_NO afterwards and correctly does not hang up mid-call. What
 * must always hold is that the sheet never disagrees with the label.
 */
function expect(turns: readonly ConversationTurn[], disposition: "FINAL_YES" | "FINAL_NO", why: string): void {
  const result = settle(turns);
  assert.equal(result.disposition, disposition, `${why} (outcome was ${result.outcomeType})`);
  assert.equal(result.sheet, disposition === "FINAL_YES", "the sheet gate must agree with the disposition");
  if (disposition === "FINAL_YES") {
    assert.equal(result.live, "FINAL_YES", "and a registration must still end the call as one");
  } else {
    assert.notEqual(result.live, "FINAL_YES", "a retracted registration must never hang up as a yes");
  }
}

/** Gate yes, then an unrelated question, then the line under test. */
const afterUnrelatedQuestion = (question: string, line: string) => [
  agent(GATE),
  caller("Yes, reserve it."),
  agent(CONFIRMED),
  agent(question),
  caller(line),
  agent("Sure, noted. Take care."),
];

/** Gate yes, then an assistant STATEMENT, then the line under test. */
const afterStatement = (line: string) => [
  agent(GATE),
  caller("Yes, reserve it."),
  agent(RESERVING),
  caller(line),
  agent(CLOSING),
];

// ═════════════════════════════════════════════════════════════════
section("A. A REFUSAL THAT ANSWERS A DIFFERENT QUESTION KEEPS THE REGISTRATION");

const UNRELATED: readonly (readonly [string, string, string])[] = [
  ["Have you attended one of our workshops before?", "No.", "a bare no about something else"],
  ["Shall I also send it to your email?", "Nahi, WhatsApp theek hai.", "a delivery preference"],
  ["Should I send you a newsletter as well?", "No, I do not want that.", "an explicit refusal of an offer"],
  ["Should I send a reminder SMS as well?", "No need, WhatsApp is fine.", '"no need" is in the shared table'],
  ["Should I send you a newsletter as well?", "That is not for me.", '"not for me" is a negation phrase'],
  ["Shall I also send it to your email?", "Nahi, mujhe email nahi chahiye.", "the same, in Hinglish"],
  ["Should I send a reminder SMS as well?", "Uski zaroorat nahi.", '"zaroorat nahi" is in the shared table'],
];

for (const [question, line, why] of UNRELATED) {
  test(`A. "${line}" answering "${question}" is not a retraction`, () => {
    expect(afterUnrelatedQuestion(question, line), "FINAL_YES", why);
  });
}

// ═════════════════════════════════════════════════════════════════
section("B. A DECISIVE NEGATION VOLUNTEERED AFTER A STATEMENT DOES RETRACT");

const RETRACTIONS = [
  "Actually no.",
  "No, do not reserve it.",
  "No, I changed my mind.",
  "No, remove my registration please.",
  "No, forget it.",
  // Carries no phrase from the negation table at all.
  "I changed my mind. Please do not reserve it.",
  // The same sentence twice: `normaliseText` splits "don't" into
  // "don t", so the contraction and the expansion must both retract or
  // the classifier understands only one of the two ways people say it.
  "I don't want to join anymore.",
  "I do not want to join anymore.",
  // "kar dijiye" is an affirmation phrase and sits AFTER the negation
  // in this turn, so the positional no-after-yes rule cannot see it.
  "Actually nahi, cancel kar dijiye.",
  "Ab nahi karna hai.",
  "Main nahi aaunga.",
  "Mujhe nahi karna.",
];

for (const line of RETRACTIONS) {
  test(`B. "${line}" takes the registration back`, () => {
    expect(afterStatement(line), "FINAL_NO", "a decisive no after a statement retracts");
  });
}

// ═════════════════════════════════════════════════════════════════
section("B2. THE WITHDRAWAL THAT NAMES NO ACTION (§4.5 F1c)");

/**
 * Every phrase in group B cancels something by name — "cancel it",
 * "forget it", "do not reserve it". A person who has already been
 * confirmed usually does not say any of those. They say they cannot
 * come, and that shape was invisible: measured after a gate yes and the
 * [YES] block, each of these stayed `registered_confirmed` and wrote a
 * registrations row for somebody who had just withdrawn, while
 * "Actually I cannot make it." — the same sentence, spelled out —
 * retracted correctly.
 */
const WITHDRAWALS = [
  "Actually I can't make it.",
  "Actually I cannot make it.",
  "I can't make it.",
  "Sorry, I won't make it.",
  "I will not make it.",
  "Actually I won't be able to attend.",
  "Actually I will not be able to attend.",
  "I'm not going to be able to attend.",
  "I am not able to attend.",
  "I'm not able to attend.",
  "I'm not going to make it.",
];

for (const line of WITHDRAWALS) {
  test(`B2. "${line}" takes the registration back`, () => {
    expect(afterStatement(line), "FINAL_NO", "a withdrawal after the confirmation retracts");
  });
}

test("B2. ...and the same words answering a DIFFERENT question do NOT", () => {
  // The other half, and the half that carries the safety. These are
  // group A's property restated against the new vocabulary: the binding
  // is CONTEXTUAL — `retractsTheGate` returns false for OTHER_QUESTION
  // before any phrase table is consulted — so widening the table cannot
  // reach them.
  for (const [question, line] of [
    ["Can you make it a bit earlier?", "I can't make it earlier."],
    ["Would you be able to attend the follow-up session too?", "I won't be able to attend that one."],
    ["Are you able to join from a laptop?", "I am not able to attend from a laptop."],
    ["Shall I send a calendar invite as well?", "I'm not able to open calendar invites."],
  ] as const) {
    expect(
      afterUnrelatedQuestion(question, line),
      "FINAL_YES",
      `"${line}" answers "${question}" and must leave the registration standing`,
    );
  }
});

test("B2. ...and a call that never reached the gate is unchanged", () => {
  // `GATE_RETRACTIONS` feeds no negation signal, so it can only ever
  // take back a yes that was actually given. A withdrawal with no
  // registration behind it stays exactly as undecided as it was.
  for (const line of ["I can't make it.", "I am not able to attend."]) {
    const r = settle([
      agent("We are running a free workshop on Sunday."),
      caller(line),
      agent("Understood."),
    ]);
    assert.equal(
      r.outcomeType,
      "unclear",
      `"${line}" with no gate behind it must stay undecided (was ${r.outcomeType})`,
    );
  }
});

test("B2. a QUESTION containing a withdrawal phrase retracts nothing", () => {
  for (const line of ["What if I can't make it?", "Can I still watch it if I'm not able to attend?"]) {
    expect(afterStatement(line), "FINAL_YES", `"${line}" asks, it does not withdraw`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. THE RETRACTIONS THAT ALWAYS WORKED STILL WORK");

for (const line of [
  "Actually no, cancel it, I am not interested.",
  "Sorry, I am not interested after all.",
  "Actually, cancel it.",
]) {
  test(`C. "${line}" is still FINAL_NO`, () => {
    expect(afterStatement(line), "FINAL_NO", "an explicit refusal after a statement retracts");
  });
}

// ═════════════════════════════════════════════════════════════════
section("D. A NO AT THE GATE ITSELF");

for (const line of ["No.", "Nahi."]) {
  test(`D. "${line}" at the commitment question is a refusal`, () => {
    expect([agent(GATE), caller(line), agent(CLOSING)], "FINAL_NO", "the gate was answered no");
  });
}

// ═════════════════════════════════════════════════════════════════
section("E. AN ACKNOWLEDGEMENT CLOSES THE EXCHANGE IT ENDS");

test("E. a cancellation after the agent acknowledged is bound to nothing earlier", () => {
  // The reported defect, verbatim. "Understood." was stepped over as
  // filler, the walk reached "Email bhi bhej du?" and the cancellation
  // was read as an answer to the email question.
  expect(
    [
      agent(GATE),
      caller("Yes, reserve it."),
      agent("Email bhi bhej du?"),
      caller("No need."),
      agent("Understood."),
      caller("Actually, cancel it."),
      agent(CLOSING),
    ],
    "FINAL_NO",
    "the acknowledgement ended the email exchange",
  );
});

for (const acknowledgement of ["Got it.", "Okay.", "Okay, understood.", "Sure.", "Alright."]) {
  test(`E. "${acknowledgement}" is a response boundary the walk may not cross`, () => {
    expect(
      [
        agent(GATE),
        caller("Yes, reserve it."),
        agent("Should I send a reminder SMS as well?"),
        caller("No need."),
        agent(acknowledgement),
        caller("Actually no."),
        agent(CLOSING),
      ],
      "FINAL_NO",
      "a new exchange started after the acknowledgement",
    );
  });
}

test("E. an agent that asks and then acknowledges NOTHING is still asking", () => {
  // Both halves of the boundary are required. Without the answered-in-
  // between half, an assistant turn that asks and is immediately
  // followed by a filler would close an exchange nobody had responded
  // to, and the answer to the question would retract the registration.
  expect(
    [
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      agent("Should I send a reminder SMS as well?"),
      agent("Sure."),
      caller("No need."),
      agent("Take care."),
    ],
    "FINAL_YES",
    "nothing had been answered, so the person is still answering the SMS question",
  );
});

test("E. an acknowledgement before the GATE is still stepped over", () => {
  expect(
    [agent(GATE), agent("Okay."), caller("No."), agent(CLOSING)],
    "FINAL_NO",
    "the boundary only stops the walk reaching an older UNRELATED question",
  );
});

test("E. an acknowledgement spoken AFTER the refusal changes nothing", () => {
  // The boundary is only ever read backwards from the turn being
  // judged. A refusal that answered the question is still answering it,
  // whatever the agent says next.
  expect(
    [
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      agent("Should I send a reminder SMS as well?"),
      caller("No need, WhatsApp is fine."),
      agent("Understood."),
      agent("Have a good day."),
    ],
    "FINAL_YES",
    "the SMS was refused, not the event",
  );
});

// ═════════════════════════════════════════════════════════════════
section("G. A COURTESY SIGN-OFF DECIDES NOTHING IN EITHER DIRECTION");

// A no already given must survive the "okay, thanks" that ends the
// call. Read as keywords that trailing "okay" is the last positive
// thing said, out-positions the refusal, and turns `declined` into
// `interested_not_confirmed` — UNRESOLVED, so the person who just said
// no goes back in the retry queue.
for (const close of ["Okay, thanks.", "Alright, thanks.", "Okay, that's all.", "Theek hai, dhanyavaad."]) {
  test(`G. a refusal survives the sign-off "${close}"`, () => {
    expect(
      [agent(GATE), caller("No."), agent(CLOSING), caller(close), agent("Have a good day.")],
      "FINAL_NO",
      "the sign-off is courtesy, not a change of mind",
    );
  });
}

test("G. a refusal survives a sign-off even when the agent asked on the way out", () => {
  expect(
    [
      agent(GATE),
      caller("No."),
      agent("No problem. Anything else I can do for you?"),
      caller("Okay, thanks."),
      agent("Have a good day."),
    ],
    "FINAL_NO",
    "a courtesy affirmation is never the yes, whatever preceded it",
  );
});

// ...and a registration already given must survive the "no thanks"
// that ends the call.
for (const close of [
  "No thanks, that's all.",
  "No thanks, I'm good.",
  "No, that's all.",
  "No, I'm good.",
  "No need, that's all.",
  "Nahi, bas itna hi.",
  "No thanks.",
]) {
  test(`G. a registration survives the sign-off "${close}"`, () => {
    expect(afterStatement(close), "FINAL_YES", "the sign-off ends the call, not the registration");
  });
}

// The distinction the whole rule rests on: courtesy WRAPPED AROUND
// content is not a sign-off. One word outside the allow-list — "cancel",
// "mind", "interested" — and the turn is read exactly as before.
for (const line of [
  "Thanks, but I changed my mind.",
  "No thanks, cancel it.",
  "Thanks, but I'm not interested.",
  "Okay thanks, but don't reserve it.",
  "No thanks, not for me.",
  "Please cancel my registration.",
  "Nahi shukriya, mujhe nahi karna.",
]) {
  test(`G. "${line}" is a cancellation, not a sign-off`, () => {
    expect(afterStatement(line), "FINAL_NO", "the turn says something beyond closing courtesy");
  });
}

test("G. at the gate itself, courtesy still decides — in both directions", () => {
  // The suppression must never reach the commitment question. "Okay,
  // thanks." there is the single most common way a registration is
  // given, and "No thanks." there is a refusal of the gate.
  for (const yes of ["Okay, thanks.", "Theek hai, dhanyavaad.", "Bilkul, shukriya.", "Yes, thanks!"]) {
    expect([agent(GATE), caller(yes), agent(CONFIRMED)], "FINAL_YES", `"${yes}" at the gate is a yes`);
  }
  expect([agent(GATE), caller("No thanks."), agent(CLOSING)], "FINAL_NO", '"No thanks." at the gate is a refusal');
  expect(
    [agent(GATE), agent("Sure."), caller("Okay, thanks."), agent(CONFIRMED)],
    "FINAL_YES",
    "a beat late is still at the gate",
  );
});

test("G. a call that never reached the gate keeps its refusal", () => {
  // The half of the rule that is deliberately NOT symmetric. Said to a
  // pitch, "No thanks, that's all." IS the refusal — silencing it would
  // put a person who declined back in the retry queue — so a courtesy
  // close loses only the power to RETRACT, never the power to decline.
  for (const turns of [
    [agent("It is a live reveal of the Funnel Builder Agent."), caller("No thanks, that's all."), agent(CLOSING)],
    [agent("Are you interested?"), caller("No thanks."), agent(CLOSING)],
    [agent("It is a live reveal of the Funnel Builder Agent."), caller("No, I'm good, thanks."), agent(CLOSING)],
  ]) {
    assert.equal(settle(turns).disposition, "FINAL_NO", "a refusal with no gate behind it still declines");
  }
});

test("G. compliance and routing signals are never silenced by courtesy", () => {
  assert.equal(
    settle([agent(GATE), caller("Yes, reserve it."), agent(CONFIRMED), caller("Thanks, but remove my number."), agent("Understood.")])
      .outcomeType,
    "do_not_call",
    "an opt-out outranks everything, politely phrased or not",
  );
  assert.equal(
    settle([agent(GATE), caller("No thanks, wrong number."), agent(CLOSING)]).outcomeType,
    "wrong_number",
  );
});

test("G. a retraction followed by a sign-off still closes as NO", () => {
  expect(
    [
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      caller("Actually, cancel it."),
      agent("Okay, cancelled."),
      caller("Okay, thanks."),
      agent("Bye."),
    ],
    "FINAL_NO",
    "the sign-off must not reopen the cancellation either",
  );
  expect(
    [
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      caller("No thanks, that's all."),
      agent("Understood."),
      caller("Actually, cancel it."),
      agent("Bye."),
    ],
    "FINAL_NO",
    "a sign-off does not immunise the registration against a later real cancellation",
  );
});

// ═════════════════════════════════════════════════════════════════
section("H. THE GATE IS RECOGNISED WHEN THE AGENT PARAPHRASES IT");

// `COMMIT_ANCHORS` lists the wordings the approved scripts use. The
// agent paraphrases anyway, and a "Yes." to a paraphrase landed as
// `affirmative_not_at_gate` — one label short of FINAL_YES, so neither
// the sheet mirror nor the end-of-call check ever saw the registration.
const PARAPHRASED_GATES = [
  "Would you like me to put you down for it?",
  "Should I go ahead and reserve this for you?",
  "Can I get you registered for this?",
  "Would you like me to book your place?",
  "Would you like me to reserve your spot?",
  "Shall I go ahead and book your place?",
  "Can I sign you up for it?",
  "Do you want me to save your seat?",
  "Can I confirm your spot for tomorrow?",
  // Hinglish. Bound to the VERB, never to the possessive — see
  // `GATE_ACTIONS` for why "aapka naam" on its own cannot be a gate.
  "Kya main aapki seat reserve kar du?",
  "Main aapka naam likh du?",
  "Aapko register kar du?",
  "Kya main aapki jagah book kar du?",
];

for (const gate of PARAPHRASED_GATES) {
  test(`H. "${gate}" + yes is a registration`, () => {
    expect([agent(gate), caller("Yes."), agent(CONFIRMED)], "FINAL_YES", "the paraphrase is the gate");
    expect([agent(gate), caller("Haan ji, kar dijiye."), agent(CONFIRMED)], "FINAL_YES", "and in Hinglish");
  });
  test(`H. "${gate}" + no is a refusal`, () => {
    expect([agent(gate), caller("No."), agent(CLOSING)], "FINAL_NO", "a no at the paraphrased gate refuses it");
    expect([agent(gate), caller("Nahi."), agent(CLOSING)], "FINAL_NO", "and in Hinglish");
  });
}

// The safety half. Every one of these is an ordinary question that
// mentions booking, reserving, registering or joining, and a yes to any
// of them must stay exactly as unresolved as it was.
const NOT_GATES = [
  "Can I tell you in 20 seconds why I think you should attend?",
  "Have you attended one of our workshops before?",
  "Shall I also send it to your email?",
  "Shall I send the link on WhatsApp?",
  "Should I send a reminder SMS as well?",
  "The registration is completely free. Is that okay?",
  "No problem. Anything else I can do for you?",
  "Can I tell you about the registration process?",
  "Should I explain how to book a seat?",
  "Do you want me to send the booking link?",
  "Should I register your complaint?",
  "Should I register your interest for later?",
  "Did you register for the last one?",
  "Would you like to join our newsletter?",
  "Can I take your name please?",
  "Can I confirm your email address?",
  "Should I check your registration status?",
  "Do you want me to send your seat confirmation?",
  "Kya main aapko details bhej du?",
  "Kya main aapka naam sahi bol raha hoon?",
  "Kya main aapki seat number bata du?",
  "Kya main aapka registration status check kar du?",
];

for (const question of NOT_GATES) {
  test(`H. "${question}" is an ordinary question, not a gate`, () => {
    const result = settle([agent(question), caller("Yes."), agent("Thanks.")]);
    assert.notEqual(result.disposition, "FINAL_YES", "a courtesy yes to this must not register anybody");
    assert.equal(result.sheet, false, "and nothing may be written");
  });
}

test("H. an agent STATEMENT naming the action is never the gate", () => {
  // The question requirement is what keeps the agent's own confirmation
  // out. Reading "Great, I'll reserve that for you." as the gate would
  // make the next "Yes." a registration and bind every later refusal to
  // it.
  for (const statement of [
    "Great, I'll reserve that for you.",
    "I'll go ahead and book your place.",
    "I am registering you now.",
    "Let me put you down for it.",
    // ...and a statement does not become one by ending in a tag question.
    "I'll reserve that for you, okay?",
    "I'll go ahead and book your place, is that alright?",
  ]) {
    const result = settle([agent(statement), caller("Yes."), agent("Done.")]);
    assert.notEqual(result.disposition, "FINAL_YES", `"${statement}" is a statement, not the gate`);
  }
});

test("H. a bare yes with no gate anywhere registers nobody", () => {
  assert.notEqual(
    settle([agent("Hi Priya, this is Ishita from Team FlexiFunnels."), caller("Yes."), agent("Great.")]).disposition,
    "FINAL_YES",
  );
});

test("H. the confirmation binding works the same behind a paraphrased gate", () => {
  const gate = "Would you like me to book your place?";
  // Courtesy sign-off keeps it, an unrelated no keeps it, a real
  // cancellation takes it back, and a re-asked gate answered no retracts.
  expect([agent(gate), caller("Yes."), agent(CONFIRMED), caller("No thanks, that's all."), agent("Bye.")], "FINAL_YES", "sign-off");
  expect(
    [agent(gate), caller("Yes."), agent(CONFIRMED), agent("Shall I also send it to your email?"), caller("No."), agent("Bye.")],
    "FINAL_YES",
    "unrelated no",
  );
  expect([agent(gate), caller("Yes."), agent(CONFIRMED), caller("Actually, cancel it."), agent("Bye.")], "FINAL_NO", "cancellation");
  expect(
    [agent(gate), caller("Yes."), agent(CONFIRMED), agent("Can I get you registered for this?"), caller("No."), agent("Understood.")],
    "FINAL_NO",
    "a re-asked gate answered no",
  );
});

test("H. opt-out still outranks a paraphrased gate", () => {
  assert.equal(
    settle([
      agent("Would you like me to book your place?"),
      caller("Yes."),
      agent(CONFIRMED),
      caller("Actually, remove my number and do not call again."),
      agent("Understood."),
    ]).outcomeType,
    "do_not_call",
  );
});

// ═════════════════════════════════════════════════════════════════
section("F. AND THE GATE ITSELF IS UNTOUCHED");

test("F. a plain registration is still a registration", () => {
  expect([agent(GATE), caller("Yes, reserve it."), agent(CONFIRMED)], "FINAL_YES", "nothing was retracted");
});

test("F. a yes a beat late, across an assistant filler, still binds to the gate", () => {
  expect(
    [agent(GATE), agent("Sure."), caller("Haan ji, kar dijiye."), agent(CONFIRMED)],
    "FINAL_YES",
    "the filler is stepped over when LOOKING FOR the gate",
  );
});

test("F. a no BEFORE the gate does not pre-empt the yes after it", () => {
  expect(
    [
      agent("Have you heard about the FlexiFunnels live event?"),
      caller("No."),
      agent("It is a live reveal of the Funnel Builder Agent."),
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
    ],
    "FINAL_YES",
    "the registration came after the no",
  );
});

test("F. a courtesy yes to a non-anchor question is still not a registration", () => {
  const result = settle([
    agent(GATE),
    agent("The event is completely free. Is that okay?"),
    caller("Yes."),
    agent(CONFIRMED),
  ]);
  assert.equal(result.outcomeType, "interested_not_confirmed");
  assert.equal(result.disposition, "UNRESOLVED");
  assert.equal(result.sheet, false);
});

test("F. a callback and a question are still neither a yes nor a no", () => {
  assert.equal(
    settle([agent(GATE), caller("I am busy right now, call me later."), agent(CLOSING)]).disposition,
    "RETRYABLE",
  );
  assert.equal(
    settle([agent(GATE), caller("Okay, and how long is it?"), agent("About 90 minutes.")]).disposition,
    "UNRESOLVED",
  );
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
