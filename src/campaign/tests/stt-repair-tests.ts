/**
 * stt-repair-tests.ts — `npm run test:stt-repair`
 *
 * "know" written as "no" turned a question into a refusal (call e92a6b5a,
 * 2026-10-01): "Actually, first I want to— No more about the services."
 * after the seat question, and the call was closed as declined.
 *
 *   SECTION A  the repair: what it restores, and every real "no" it must
 *              leave alone.
 *   SECTION B  the readings that end a call: the repaired turn is not a
 *              refusal to `definitiveAnswerIn` / the classifier, and a
 *              real refusal still is.
 */

import assert from "node:assert/strict";

const { repairSttHomophones } = await import("../../core/session/stt-repair");
const { definitiveAnswerIn } = await import("../dispatch/call-runner");

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
const section = (t: string) => console.log(`\n${t}`);

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the repair");
// ═════════════════════════════════════════════════════════════════

await test("A1. call e92a6b5a: \"I want to— No more about the services\" is \"know more\"", () => {
  assert.equal(
    repairSttHomophones("Actually, first I want to— No more about the services."),
    "Actually, first I want to— Know more about the services.",
  );
});

await test("A2. the other shapes in which \"no\" cannot be a refusal", () => {
  const cases: Array<[string, string]> = [
    ["No more about the workshop, please.", "Know more about the workshop, please."],
    ["I'd like to no what time it is.", "I'd like to know what time it is."],
    ["I need to no about the fees.", "I need to know about the fees."],
    ["I wanted to no, how does it work?", "I wanted to know, how does it work?"],
    ["I don't no.", "I don't know."],
    ["I do not no what this is.", "I do not know what this is."],
  ];
  for (const [said, repaired] of cases) assert.equal(repairSttHomophones(said), repaired, said);
});

await test("A3. every real \"no\" is left exactly as said", () => {
  for (const said of [
    "No.",
    "No, thank you.",
    "No no, I am not interested.",
    "No more calls please.",
    "No, I don't want to.",
    "I want to say no.",
    "I have to say no to this.",
    "No, nahi chahiye.",
    "Nahi, no thanks.",
    "I know.",
    "I want to know more.",
    "",
  ]) {
    assert.equal(repairSttHomophones(said), said, said);
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — what ends the call");
// ═════════════════════════════════════════════════════════════════

const t = (role: "user" | "assistant", content: string): ConversationTurn => ({ role, content, timestamp: new Date() });
const GATE = "Okay, then this is a good place to start — you won't need any coding or design skills for this. Would you like me to reserve your free seat?";
const ANSWER = "Sure. FlexiFunnels helps you build your online business from your phone. Would you like me to reserve your free seat?";

// In e92a6b5a the classifier did NOT read the raw turn as a refusal either
// (checked: definitiveAnswerIn → undefined). The MODEL did: it read "No more
// about the services" as a no and spoke the decline close, and the call
// ended on the agent's goodbye. The repair fixes what the model is sent;
// these two pin that it creates no refusal and removes no real one.
await test("B1. the repaired turn, answered, is not a refusal", () => {
  const repaired = repairSttHomophones("Actually, first I want to— No more about the services.");
  assert.notEqual(definitiveAnswerIn([t("assistant", GATE), t("user", repaired), t("assistant", ANSWER)], "registration"), "FINAL_NO");
});

await test("B2. a real \"No, thank you.\" at the seat question still ends as a refusal", () => {
  const said = repairSttHomophones("No, thank you.");
  assert.equal(
    definitiveAnswerIn([t("assistant", GATE), t("user", said), t("assistant", "Okay, no problem at all. Thanks for your time.")], "registration"),
    "FINAL_NO",
  );
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
