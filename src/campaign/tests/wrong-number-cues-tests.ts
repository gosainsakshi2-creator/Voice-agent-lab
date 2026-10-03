/**
 * wrong-number-cues-tests.ts
 *
 * `WRONG_NUMBER` in `classifier.ts` used to carry the bare phrases
 * "this is not", "galat" and "गलत". Real call 449a04fd (2026-10-03): a
 * live lead said "this is not the right way" and "ये सबसे गलत चीज़ है"
 * about the agent's manners, and the call was stored `wrong_number` —
 * a disposition that is never redialled. These pin the narrowing: the
 * shapes that name nobody still classify, ordinary sentences with those
 * words in them do not, and a denial at the identity gate still arrives
 * through `identityDenied`.
 *
 * Pure: `classifyOutcome` only. No provider, no network.
 */
import assert from "node:assert/strict";
import type { TranscriptTurn } from "../outcome/transcript";

const { classifyOutcome } = await import("../outcome/classifier");

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
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n         ")}`);
  }
}

const turn = (role: TranscriptTurn["role"], text: string): TranscriptTurn => ({ role, text }) as TranscriptTurn;
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);
const PITCH = "Hi, I'm Ishita from FlexiFunnels. We have a free live workshop on Sunday at 11 AM. Have you tried putting something online before?";

function outcomeOf(transcript: readonly TranscriptTurn[], identityDenied = false) {
  return classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
    ...(identityDenied ? { identityDenied: true } : {}),
  });
}

console.log("\nA. ORDINARY SENTENCES WITH THE OLD BARE WORDS ARE NOT A WRONG NUMBER");

test("A1. \"this is not the right way\" about the agent's manners (real call 449a04fd)", () => {
  const o = outcomeOf([
    agent("Hello, am I speaking with Sakshi Gosain?"), caller("Yeah."), agent(PITCH),
    caller("Wait, wait, wait. You just dropped off the introduction. So this is not right way. I think so."),
    agent("I'm sorry about that."), caller("Bye."),
  ]);
  assert.notEqual(o.outcomeType, "wrong_number", `got ${o.outcomeType} / ${o.primaryReason}`);
});

test("A2. \"ये सबसे गलत चीज़ है\" about the agent not listening (the same call)", () => {
  const o = outcomeOf([
    agent("Hello, am I speaking with Sakshi Gosain?"), caller("हाँ।"), agent(PITCH),
    caller("तू बात नहीं सुन रही है user की, अपनी pitch रख रही है, ये सबसे गलत चीज़ है।"),
    agent("जी, बोलिए।"), caller("Bye."),
  ]);
  assert.notEqual(o.outcomeType, "wrong_number", `got ${o.outcomeType} / ${o.primaryReason}`);
});

test("A3. \"this is not what I asked\" and \"galat baat hai\" are complaints, not wrong numbers", () => {
  for (const line of ["This is not what I asked.", "Yeh galat baat hai yaar.", "That's not right, this is not fair."]) {
    const o = outcomeOf([agent("Hello, am I speaking with Rahul?"), caller("Yes."), agent(PITCH), caller(line), agent("Sorry."), caller("Bye.")]);
    assert.notEqual(o.outcomeType, "wrong_number", `"${line}" -> ${o.outcomeType}`);
  }
});

console.log("\nB. THE SHAPES THAT NAME NOBODY STILL CLASSIFY");

test("B1. \"wrong number\", \"galat number\", \"गलत नंबर\", \"this is not him\", \"koi aur hai\"", () => {
  for (const line of ["Wrong number, no Priya here.", "Ye galat number hai.", "नहीं, गलत नंबर है।", "No, this is not him.", "Koi aur hai, main nahi.", "Number galat hai bhai."]) {
    const o = outcomeOf([agent("Hello, am I speaking with Priya?"), caller(line)]);
    assert.equal(o.outcomeType, "wrong_number", `"${line}" -> ${o.outcomeType} / ${o.primaryReason}`);
  }
});

test("B2. a denial at the identity gate still arrives as identityDenied, whatever its words", () => {
  const o = outcomeOf([
    agent("Hello, am I speaking with Sakshi?"), caller("No, this isn't Sakshi."),
    agent("Would you like me to reserve your free seat?"), caller("Yes."),
  ], true);
  assert.equal(o.outcomeType, "wrong_number");
  assert.notEqual(o.primaryReason, "confirmed_at_gate");
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
if (failures.length > 0) process.exitCode = 1;
