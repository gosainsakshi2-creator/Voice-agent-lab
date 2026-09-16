/**
 * stale-final-no-tests.ts — `npm run test:stale-final-no`
 *
 * REGRESSION GUARD for the stale FINAL_NO termination bug.
 *
 * `definitiveAnswerIn`'s FINAL_YES branch has always carried two
 * conversation-safety guards: it withdraws the early hangup when the
 * agent's newest turn is itself a question, and when the caller still
 * has a question open. The FINAL_NO branch carried neither, so a
 * refusal-shaped phrase anywhere in the conversation could end the call
 * the moment the agent committed any reply — including a reply that was
 * a question the person had not answered yet.
 *
 * Production `sess_mu3ueajc_1` is the reproduction. The person said
 * "I do not want to listen to your pitch" — declining the PITCH, not
 * the offer — while asking which company was calling and what it sells.
 * The classifier matched "do not want" and settled `explicit_no`. The
 * agent answered, then asked whether to send the details on WhatsApp,
 * and 795ms later the watchdog hung up on that stale refusal.
 *
 * These tests read `definitiveAnswerIn` directly — the same function
 * the dispatch watchdog calls at call-runner.ts:522 — so they assert
 * the live hangup decision itself, not a proxy for it.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, OR
 * TOUCHES THE DATABASE.
 */

import assert from "node:assert/strict";

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
    console.log(`  [FAIL] ${name}`);
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);

const turn = (role: "assistant" | "user", text: string): ConversationTurn => ({
  role,
  content: text,
  timestamp: new Date(),
});
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PITCH = "We are running a free live workshop this Sunday at 11 AM.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
/** A statement. Asks nothing. */
const SIGN_OFF = "No problem at all, thanks for your time.";

const read = (turns: readonly ConversationTurn[]) => definitiveAnswerIn(turns, "registration");

// ═════════════════════════════════════════════════════════════════
section("A. A genuine FINAL_NO, with the agent asking nothing, still ends the call");

await test("A1 — plain refusal + statement sign-off still returns FINAL_NO", () => {
  assert.equal(
    read([agent(GREETING), agent(GATE), caller("No, I'm not interested."), agent(SIGN_OFF)]),
    "FINAL_NO",
    "the guards must not disable genuine refusals — this is the behaviour being preserved",
  );
});

await test("A2 — 'No thanks, I don't want it.' still returns FINAL_NO", () => {
  assert.equal(
    read([agent(GREETING), agent(GATE), caller("No thanks, I don't want it."), agent(SIGN_OFF)]),
    "FINAL_NO",
  );
});

await test("A3 — an opt-out with no open question still returns FINAL_NO", () => {
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("No, please don't contact me again. Remove my number."),
      agent("Understood, I'll remove you."),
    ]),
    "FINAL_NO",
    "a compliance signal must still end the call when nothing is left open",
  );
});

// ═════════════════════════════════════════════════════════════════
section("B. A FINAL_NO verdict must NOT close while the AGENT is asking");

await test("B1 — refusal, but the agent's newest turn is a question -> undefined", () => {
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("No, I'm not interested."),
      agent("Understood. Before I go, may I ask what put you off?"),
    ]),
    undefined,
    "the person has been asked something and has not answered — hanging up now cuts them off",
  );
});

await test("B2 — the identical transcript WITHOUT the question mark still returns FINAL_NO", () => {
  // The paired control: it is the open question that withdraws the
  // hangup, not the refusal having been weakened.
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("No, I'm not interested."),
      agent("Understood. I'll leave you to it."),
    ]),
    "FINAL_NO",
  );
});

await test("B3 — an opt-out is held too while the agent's own question is open", () => {
  // The caller line here is verified to classify as `opt_out` /
  // `do_not_call`, not merely `explicit_no` — otherwise this would pass
  // for the wrong reason and never exercise the opt-out path at all.
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("Remove my number and do not call again."),
      agent("Understood. Would you like me to remove this number from the list as well?"),
    ]),
    undefined,
    "compliance is settled by finalize either way; it never requires cutting somebody off mid-question",
  );
});

// ═════════════════════════════════════════════════════════════════
section("C. A FINAL_NO verdict must NOT close while the CALLER has a question open");

await test("C1 — refusal followed by a caller question -> undefined", () => {
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("No, I don't want to join. But who are you calling from?"),
      agent("We're FlexiFunnels, an online tool company."),
    ]),
    undefined,
    "the caller asked something and has just been answered — the next turn is theirs",
  );
});

await test("C2 — refusal with an ANNOUNCED but unasked question -> undefined", () => {
  assert.equal(
    read([
      agent(GREETING),
      agent(GATE),
      caller("No, I'm not interested. Actually, I have a question."),
      agent("Of course, go ahead."),
    ]),
    undefined,
    "a question named but not yet put still holds the line",
  );
});

// ═════════════════════════════════════════════════════════════════
section("D. The production reproduction — sess_mu3ueajc_1");

/** Turns 12-16 of the real call, verbatim from the stored transcript. */
const PRODUCTION_TAIL: readonly ConversationTurn[] = [
  agent(
    "Hi Rakshi. Main Rohan bol raha hoon Team FlexiFunnels se — main aapko ek free live workshop ke liye invite kar raha tha. Yeh Sunday, 4th October ko 11 AM par hai. Aapne kabhi pehle kuch online daalne ki koshish ki hai, jaise koi product ya service?",
  ),
  caller("No, I haven't tried."),
  agent("Then this is a good place to start — you won't need any coding or design skills for this. Would you like me to reserve your free seat?"),
  caller(
    "I will think about it. Like, you know, I am currently planning to do any kind of online business but I do not know about your service or from the company you are and what your services actually. So I do not about that. So I just wanted to know that from which company you are and what service do you provide. I do not want to listen to your pitch because I already listen to it so yeah.",
  ),
  agent(
    "Yeah, that makes sense, thanks for saying it clearly. I'm from a company called FlexiFunnels. We make an online tool that helps people create websites, sales pages and checkouts to sell their products or services online. Right now I'm only inviting you to this one free workshop, not selling you anything. Since you're still thinking about starting an online business, would you like me to just send the workshop details on WhatsApp so you can check them later and decide on your own?",
  ),
];

await test("D1 — the real call must stay open instead of hanging up", () => {
  assert.equal(
    read([agent(GREETING), caller("Yes."), ...PRODUCTION_TAIL]),
    undefined,
    "this is the exact transcript that produced agent_hangup:final_no 795ms after the agent's question",
  );
});

await test("D2 — 'I don't want to hear the pitch again' is not permission to end the call", () => {
  assert.equal(
    read([
      agent(GREETING),
      agent(PITCH),
      caller("I don't want to hear the pitch again, but what does your company actually do?"),
      agent("We build an online tool for selling products. Shall I send you the details?"),
    ]),
    undefined,
  );
});

await test("D3 — 'No, I haven't tried that before' is not a refusal of the offer", () => {
  // Answering a question about past experience. On the real call this
  // was turn 13, and it was recorded as a negation signal.
  assert.equal(
    read([
      agent(GREETING),
      agent("Have you ever tried selling something online before?"),
      caller("No, I haven't tried that before."),
      agent("Then this is a good place to start. Shall I reserve your seat?"),
    ]),
    undefined,
    "a factual 'no' about past experience must never close the call",
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. Genuine final refusals are still available");

await test("E1 — every unmistakable refusal still reads FINAL_NO when nothing is open", () => {
  const refusals = [
    "No, I'm not interested.",
    "No thanks, I don't want it.",
    "No, I do not want to join.",
    "I am not interested, please don't call again.",
  ];
  for (const line of refusals) {
    assert.equal(
      read([agent(GREETING), agent(GATE), caller(line), agent(SIGN_OFF)]),
      "FINAL_NO",
      `"${line}" must still end the call`,
    );
  }
});

await test("E2 — FINAL_YES behaviour is untouched", () => {
  assert.equal(
    read([agent(GREETING), agent(GATE), caller("Yes, reserve it."), agent("Done, your seat is reserved.")]),
    "FINAL_YES",
    "the yes path must be byte-for-byte unaffected by this change",
  );
  assert.equal(
    read([agent(GREETING), agent(GATE), caller("Yes, reserve it."), agent("Done. Anything else you'd like to know?")]),
    undefined,
    "and its own question guard must still hold",
  );
});

await test("E3 — a non-definitive conversation still produces no verdict", () => {
  assert.equal(
    read([agent(GREETING), agent(GATE), caller("Let me think about it."), agent(SIGN_OFF)]),
    undefined,
  );
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
