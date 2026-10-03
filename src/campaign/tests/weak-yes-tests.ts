/**
 * weak-yes-tests.ts — `npm run test:weak-yes`
 *
 * A bare "Okay." to the seat question is just as often a person about to
 * speak as a person agreeing. Test call a9d40a12 (2026-10-01): "Would you
 * like me to reserve your free seat?" -> "Okay." -> "first, first, can you
 * please tell me one thing: that why are you interrupting me?" — the call
 * registered and hung up as FINAL_YES. A gate answer made only of weak
 * affirmations ("ok", "okay", "ओके", "alright", "fine", "theek hai", "ठीक
 * है", "ji", "जी") now registers once the agent has confirmed the seat on
 * it; "yes", "haan", "sure", "kar dijiye" are unchanged.
 */

import assert from "node:assert/strict";

const { liveRegistrationReading, definitiveAnswerIn } = await import("../dispatch/call-runner");

import type { ConversationTurn } from "../../types/provider.types";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}\n         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`);
  }
}

const t = (role: "user" | "assistant", content: string): ConversationTurn => ({ role, content, timestamp: new Date() });
const GATE = "Nice, then this is a good place to start — you won't need any coding or design skills for this. Would you like me to reserve your free seat?";
const registered = (turns: ConversationTurn[]) => liveRegistrationReading(turns, "registration").registrationConfirmed;

await test("A1. call a9d40a12: \"Okay.\" then a complaint, the agent never confirms — not a registration", () => {
  const turns = [
    t("assistant", GATE),
    t("user", "Okay."),
    t("user", "first, first, can you please tell me one thing: that why are you interrupting me?"),
    t("assistant", "You're right, I cut in there. Go ahead and tell me what you wanted to say."),
    t("user", "ठीक है।"),
    t("user", "Bye."),
    t("assistant", "Okay, no problem. Thanks for your time, Sakshi."),
  ];
  assert.equal(registered(turns), false);
  assert.notEqual(definitiveAnswerIn(turns, "registration"), "FINAL_YES");
});

await test("A2. real call 33d97c5c's shape: \"ओके।\" and the agent confirms the seat — a registration", () => {
  const turns = [t("assistant", GATE), t("user", "ओके।"), t("assistant", "Great, your free seat is reserved for Sunday at 11 AM. See you there!")];
  assert.equal(registered(turns), true);
});

await test("A3. \"Okay\" and \"ठीक है\" alone are held until the agent confirms", () => {
  for (const said of ["Okay.", "ok", "ठीक है।", "Theek hai.", "Ji.", "Alright."]) {
    assert.equal(registered([t("assistant", GATE), t("user", said)]), false, `"${said}" with no confirmation yet`);
    assert.equal(
      registered([t("assistant", GATE), t("user", said), t("assistant", "Done — your seat is reserved.")]),
      true,
      `"${said}" once the seat is confirmed`,
    );
  }
});

await test("A4. a clear yes is unchanged: it registers with or without the confirmation", () => {
  for (const said of ["Yes.", "Haan.", "Sure, reserve it.", "हाँ, कर दीजिए।", "Yes, please book it."]) {
    assert.equal(registered([t("assistant", GATE), t("user", said)]), true, `"${said}"`);
  }
});

await test("A5. \"Okay, yes\" carries a clear yes, so it does not wait", () => {
  assert.equal(registered([t("assistant", GATE), t("user", "Okay, yes.")]), true);
});

await test("A6. call b568b5e1: \"Right, you can reserve it.\" registers; \"don't\" / \"can't\" / \"please don't\" do not", () => {
  for (const said of ["Right, you can reserve it.", "Yes, you can book it.", "Please reserve it.", "Go ahead and reserve it."]) {
    assert.equal(registered([t("assistant", GATE), t("user", said)]), true, said);
  }
  for (const said of ["Don't reserve it.", "No, you can't reserve it.", "Please don't reserve it."]) {
    assert.equal(registered([t("assistant", GATE), t("user", said)]), false, said);
  }
});

await test("A7. call 7f3df5c1: a conditional \"I will\" the agent answered with \"I'll skip reserving\" is not a registration", () => {
  const turns = [
    t("assistant", GATE),
    t("user", "Uh, actually, I'm—can we talk later? Right now I'm busy somewhere."),
    t("user", "Somewhere out, and I'm running right now, so— So if I get some time, I will surely join the webinar on Sunday."),
    t("user", "Sure. Otherwise, we can skip it for now, actually."),
    t("user", "Okay. Somewhere I'm busy."),
    t("assistant", "No worries at all, I understand you're busy. I'll skip reserving the seat for now. Thanks for your time, Hardik."),
    t("user", "Yes, sir."),
  ];
  assert.equal(registered(turns), false);
  assert.notEqual(definitiveAnswerIn(turns, "registration"), "FINAL_YES");
});

await test("A8. the agent's \"not reserving\" is overridden when it then confirms the seat, and never fires on the seat question", () => {
  assert.equal(
    registered([
      t("assistant", GATE),
      t("user", "Yes."),
      t("assistant", "Okay, I won't reserve it then?"),
      t("user", "No no, please reserve it."),
      t("assistant", "Done — your seat is reserved."),
    ]),
    true,
  );
  assert.equal(registered([t("assistant", GATE), t("user", "Yes, please.")]), true);
  assert.equal(registered([t("assistant", GATE), t("user", "Yes."), t("assistant", "Great, your free seat is reserved for Sunday.")]), true);
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
