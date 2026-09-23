/**
 * long-monologue-tests.ts — `npm run test:long-monologue`
 *
 * ROADMAP 4.4. A long webinar explanation must not go out as one
 * uninterrupted turn. The fix is in `conversation-policy.ts`: past two
 * or three sentences the rest goes in a second turn, broken at a
 * finished thought and handed over with a short check.
 *
 * A prompt change can only be asserted at two honest levels, and this
 * file uses both — neither one is a claim about what a model felt like
 * doing:
 *
 *   A. WHAT THE MODEL IS TOLD. The policy text, and the bytes of the
 *      system prompt a real campaign session is constructed with. Same
 *      level as phase 7B's A2/A3 and the continuity suite's sections A
 *      and B.
 *
 *   B. WHAT THE READERS DO WITH THE RESULT. A check-in is a NEW agent
 *      question mid-pitch, and two existing modules read agent
 *      questions. `classifier.ts` decides whether the caller's "haan"
 *      to it is a registration — and the naive wording of roadmap 4.4,
 *      "ask a confirmation/interest question", produces one that is.
 *      `script-adherence.ts` decides whether a two-part delivery looks
 *      like an agent that lost its place and started over.
 *
 * Section B is the load-bearing half. If the check-in reads as the
 * commitment gate, this change silently registers people who agreed
 * only to keep listening, writes them to the registrations sheet and
 * hangs up on them mid-pitch. Those tests are why the policy spends a
 * paragraph on what the question may not be.
 *
 * NO NETWORK, NO DATABASE, NO VENDOR. Every module here is the real
 * one and every input is a literal.
 */

import assert from "node:assert/strict";

const { CAMPAIGN_CONVERSATION_POLICY, CONVERSATION_POLICY_ID, composeCampaignAppendix } =
  await import("../script/conversation-policy");
const { findScript, hashScript, defaultScriptFor } = await import("../script/script-registry");
const { buildCampaignContext } = await import("../domain/campaign-context");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { checkScriptAdherence } = await import("../outcome/script-adherence");
const { definitiveAnswerIn } = await import("../dispatch/call-runner");
const { buildSystemPrompt } = await import("../../core/session/system-prompt");
const { detectLanguage, isLockGradeEvidence } = await import(
  "../../core/session/language-detector"
);
const { isAttentionCheck, isHearingCheck, isRepeatedGreeting, bufferedTurnTakesTheFloor } =
  await import("../../core/session/conversation-pipeline");
const { SupportedLanguage } = await import("../../types/enums");

import type { TranscriptTurn } from "../outcome/transcript";
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

// ── Fixtures: the approved registration v4 call, delivered in two ──
// parts instead of one.
const GREETING = "Hello, this is Ishita from Team FlexiFunnels.";
const PART_ONE =
  "I'm calling to invite you to a free live workshop this Sunday, 6th September at 11 AM. " +
  "We'll build a complete online business live — the website, the product, checkout and " +
  "payments — all from a phone.";
const PART_TWO =
  "Then this is a good place to start — you won't need any coding or design skills.";
const GATE = "Would you like me to reserve your free seat?";
const YES_BLOCK =
  "Perfect! I'll get your registration confirmed and send the joining details to you on " +
  "WhatsApp and email.";

/**
 * The middle question, as registration v5 actually asks it, plus the two
 * other natural shapes the policy licenses. NOT checkpoints: v5 replaced
 * "Are you with me?" with a question whose answer changes the next line.
 */
const LICENSED_CHECKS = [
  "Have you tried putting something online before?",
  "Where are you with that at the moment?",
  "Is that something you've looked at before?",
];
const FORBIDDEN_CHECKS = [
  "Would you like to attend?",
  "Shall I reserve your seat?",
  "Should I register you for it?",
  "Are you interested in attending?",
];

const turn = (role: TranscriptTurn["role"], text: string): TranscriptTurn =>
  ({ role, text }) as TranscriptTurn;

function settle(transcript: readonly TranscriptTurn[]) {
  const outcome = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
  });
  const { disposition } = dispositionFor({
    outcomeType: outcome.outcomeType,
    failureClass: "COMPLETED",
  });
  return { outcome, disposition };
}

/** The same turns, in the shape the mid-call hangup check reads. */
const asConversation = (transcript: readonly TranscriptTurn[]): ConversationTurn[] =>
  transcript.map((t) => ({
    role: t.role,
    content: t.text,
    timestamp: new Date(),
  })) as ConversationTurn[];

// ═════════════════════════════════════════════════════════════════
section("A. THE POLICY SAYS TO SEGMENT, AND SAYS WHAT MAY NOT BE ASKED");

const policy = CAMPAIGN_CONVERSATION_POLICY.toLowerCase().replace(/\s+/g, " ");

await test("A1. the rule exists: past a few sentences it goes out in two turns", () => {
  for (const required of [
    "when there is a lot to say",
    "two turns instead of one",
    "stop where the thought is finished",
    "hand it to them with a question",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("A1b. the break is a real question, and manufactured checkpoints are banned", () => {
  // The whole point of v5. A stop that asks permission to keep talking
  // is a worse defect than the monologue it replaced, so the policy has
  // to name those four shapes and refuse them.
  for (const required of [
    "the one you actually want the answer to",
    "what they say next depends on the person",
    "do not manufacture a checkpoint",
    "ask permission to keep talking",
    "a turn that stops because you want to hear from them is a conversation",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
  // ...by name, so a future edit cannot quietly reintroduce them.
  for (const banned of [
    "are you with me?",
    "shall i carry on?",
    "does that make sense so far?",
    "is that clear?",
  ]) {
    assert.ok(
      policy.includes(banned),
      `the policy must name "${banned}" as a shape it refuses`,
    );
  }
  assert.ok(
    policy.indexOf("do not manufacture a checkpoint") < policy.indexOf("are you with me?"),
    "those phrases must appear as things NOT to say, not as examples to copy",
  );
});

await test("A2. the break is semantic, not a word count", () => {
  assert.ok(
    policy.includes("never at a place chosen by length alone"),
    "the boundary must be the meaning, with length only as the trigger",
  );
  assert.ok(
    policy.includes("the break goes where the meaning already ends"),
    "the policy must name the boundary mechanism",
  );
  // And it must not have become a counter.
  for (const banned of ["word limit", "maximum of", "no more than 40 words", "character limit"]) {
    assert.ok(!policy.includes(banned), `the policy must not impose "${banned}"`);
  }
});

await test("A3. the check may not be the commitment question, in the words it must", () => {
  for (const required of [
    "it is not the script's own question",
    "never bring that question forward",
    "reserve, book, register, save a seat, sign them up",
    "it adds no fact and no step either",
    "may not introduce a claim, an offer, a price or a promise",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("A4. their answer is a turn: continue with the NEXT part, never the last one", () => {
  for (const required of [
    "carry on with the next part",
    "not the part they just heard",
    "an answer to the call, not to the check",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("A5. segmenting may never drop or duplicate required content", () => {
  for (const required of [
    "the rest of the script is still owed",
    "every point the script gives you is still given",
    "the commitment question is still asked in its own words",
    "not permission to leave any of it out",
    "never a reason to say any of it twice",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("A6. the anti-micro-turn protection that v2 earned is still there", () => {
  // registration.v3.ts records what "a few sentences at a time" cost:
  // 1-2 sentence turns with a full round trip of dead air between them.
  for (const required of [
    "do not deliver a paragraph a sentence at a time",
    "do not answer with two or three words and wait",
    "do not end a turn in the middle of a thought",
    "a turn that simply stops is the call breaking",
  ]) {
    assert.ok(policy.includes(required), `the policy must still say "${required}"`);
  }
});

await test("A7. the policy still forbids everything it forbade before", () => {
  // Exactly phase 7B's A3 list, re-asserted here so a future edit to
  // this section cannot quietly delete one of them.
  for (const required of [
    "never invent a price",
    "you do not add steps",
    "you do not invent questions",
    "never repeat the opening line",
    "please answer yes or no",
    "a question is not an answer",
  ]) {
    assert.ok(policy.includes(required), `the policy must still address "${required}"`);
  }
  for (const banned of ["what is your budget", "how many employees", "your monthly revenue"]) {
    assert.ok(!policy.includes(banned), `the policy must not introduce "${banned}"`);
  }
});

await test("A8. the policy moved, so a call can be attributed to it", () => {
  assert.notEqual(CONVERSATION_POLICY_ID, "script-faithful.v2", "the id must be bumped");
  // v4 is the post-registration continuation paragraph — see
  // `callerQuestionPending` in call-runner.ts. The v2 assertion above is
  // kept: each bump is additive here, so no earlier id can come back.
  assert.notEqual(CONVERSATION_POLICY_ID, "script-faithful.v3", "the id must be bumped");
  // v5 is the not-in-English section — what "in the words it is
  // written" means when the call is in Hindi. Same additive rule as
  // above: no earlier id may come back.
  assert.notEqual(CONVERSATION_POLICY_ID, "script-faithful.v4", "the id must be bumped");
  assert.equal(CONVERSATION_POLICY_ID, "script-faithful.v5");
});

// ═════════════════════════════════════════════════════════════════
section("B. NO APPROVED SCRIPT MOVED");

await test("B1. every pinned script hash is byte-for-byte what it was", () => {
  // Captured before the policy change. The policy is appended AFTER
  // interpolation and is not part of `hashScript`, so a change to it
  // must be invisible here — which is the entire reason the fix lives
  // in the policy and not in a script.
  const pinned: Record<string, string> = {
    "registration v5": "86cd439509f902097656b0ec9093458279b920ad20562a4ed59aa111e5c9fc2b",
    "registration v4": "e87faaccb3a9064d112fb173abbbed4c8bccb6dd5aeec3f22995b6f9a8ad4358",
    "registration v3": "8e65a82ebec46e2b42668bb09bca508bec5fdcd89a9357b0d12724d2b103b3c2",
    "registration v2": "5760453b3d7ece12d2472a21c4b4a4bec6fb90f238be4f8cdb515b7b4617001b",
    "registration v1": "058b3b70ba733bb950e887cf67178dfe36756bb2bdfcbb80c12825dd341adcc3",
    "registration v1-short": "ae9b73f8a216aa1bf217abb0fac21433e167327a3459e2a8a431b604763ed665",
    "reminder v2": "e6095467a29c3cd20411b3c726b763ad264a0a4122d472eca85140897441bf01",
    "reminder v1": "44da949d883bb4be02001ded51d5dc2255b0661587822a12f1bf27fb05cf0a4e",
  };
  for (const [key, expected] of Object.entries(pinned)) {
    const [id, version] = key.split(" ") as [string, string];
    const script = findScript(id, version);
    assert.ok(script, `script ${key} must still be registered`);
    assert.equal(hashScript(script), expected, `script ${key} changed`);
  }
});

await test("B2. the segmentation rule reaches a real campaign session's system prompt", () => {
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(script),
  });
  assert.equal(context.conversationPolicyId, CONVERSATION_POLICY_ID);

  const prompt = buildSystemPrompt(
    SupportedLanguage.HINGLISH,
    "female",
    context.systemPromptAppendix,
  );
  assert.ok(prompt.includes("WHEN THERE IS A LOT TO SAY"), "the rule must be in the prompt bytes");
  assert.ok(prompt.includes(GATE), "and the approved gate must still be there, unchanged");
  assert.ok(!prompt.includes("{{"), "no placeholder may survive");
  // Order is the point: the script first, the rules about it last.
  assert.ok(
    prompt.indexOf("--- SCRIPT ---") < prompt.indexOf("WHEN THERE IS A LOT TO SAY"),
    "the policy must still come after the script",
  );
  assert.ok(
    composeCampaignAppendix("SCRIPT").endsWith(CAMPAIGN_CONVERSATION_POLICY),
    "the policy is still appended, not interleaved",
  );
});

// ═════════════════════════════════════════════════════════════════
section("C. A CHECK-IN IS NOT A REGISTRATION");

for (const check of LICENSED_CHECKS) {
  await test(`C1. "${check}" mid-pitch: a "haan" to it is not a confirmed registration`, () => {
    const { outcome, disposition } = settle([
      turn("assistant", GREETING),
      turn("user", "Haan boliye."),
      turn("assistant", `${PART_ONE} ${check}`),
      turn("user", "Haan, theek hai."),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${check}" must not read as the commitment gate`);
    assert.notEqual(outcome.outcomeType, "registered_confirmed");
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
    // The "haan" is still recorded — as evidence, marked not-at-gate.
    const affirmation = outcome.detail.signals.find((s) => s.kind === "affirmation");
    assert.ok(affirmation, "the caller's answer must not be discarded");
    assert.equal(affirmation.atGate, false);
  });
}

for (const check of FORBIDDEN_CHECKS) {
  await test(`C2. "${check}" WOULD register them — which is why the policy bans it`, () => {
    const { disposition } = settle([
      turn("assistant", GREETING),
      turn("user", "Haan boliye."),
      turn("assistant", `${PART_ONE} ${check}`),
      turn("user", "Haan, theek hai."),
    ]);
    assert.equal(
      disposition,
      "FINAL_YES",
      `"${check}" is gate-shaped; if this ever stops being true the ban can be relaxed, ` +
        `but until then the policy's paragraph on what the check may not be is load-bearing`,
    );
  });
}

await test("C3. the caller is never hung up on at a check-in", () => {
  // `definitiveAnswerIn` is what ends a call early. The agent's own
  // last turn being a question already guards it; assert the whole
  // two-part delivery, turn by turn, never yields an answer.
  const script: TranscriptTurn[] = [
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Haan."),
    turn("assistant", `${PART_TWO} ${GATE}`),
  ];
  for (let i = 1; i <= script.length; i += 1) {
    assert.equal(
      definitiveAnswerIn(asConversation(script.slice(0, i)), "registration"),
      undefined,
      `the call must still be live after turn ${i}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. THE REAL GATE STILL WORKS, AFTER A SEGMENTED PITCH");

await test("D1. a yes at the gate after two parts and a check-in is still FINAL_YES", () => {
  const { outcome, disposition } = settle([
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Haan."),
    turn("assistant", `${PART_TWO} ${GATE}`),
    turn("user", "Yes, please reserve it."),
  ]);
  assert.equal(outcome.outcomeType, "registered_confirmed");
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
});

await test("D2. ...and the call then ends on the confirmation, exactly as today", () => {
  const full: TranscriptTurn[] = [
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[1]!}`),
    turn("user", "Ji, boliye."),
    turn("assistant", `${PART_TWO} ${GATE}`),
    turn("user", "Haan, kar dijiye."),
    turn("assistant", YES_BLOCK),
  ];
  assert.equal(definitiveAnswerIn(asConversation(full), "registration"), "FINAL_YES");
});

await test("D3. a refusal AT the check-in is still a refusal, not a reason to keep pitching", () => {
  const { outcome, disposition } = settle([
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Nahi, mujhe interest nahi hai."),
  ]);
  assert.equal(disposition, "FINAL_NO");
  assert.equal(outcome.outcomeType, "declined");
  assert.equal(outcome.primaryReason, "explicit_no");
});

await test("D4. a question at the check-in is a question, not an answer to anything", () => {
  const { outcome, disposition } = settle([
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Ye free hai kya?"),
  ]);
  assert.equal(outcome.detail.conversation?.customerQuestions, 1, "the question must be counted");
  assert.notEqual(disposition, "FINAL_YES");
  assert.notEqual(disposition, "FINAL_NO");
});

await test("D5. an unrelated aside at the check-in does not close the contact", () => {
  // "I'm driving" is a call-me-later, and the existing callback rule
  // already ranks it RETRYABLE. What matters here is only that the
  // check-in did not turn it into a decision either way.
  const { disposition } = settle([
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Ek second, main driving kar raha hoon."),
  ]);
  assert.notEqual(disposition, "FINAL_YES");
  assert.notEqual(disposition, "FINAL_NO");

  // ...and a genuinely off-topic aside leaves the contact undecided.
  const aside = settle([
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Aap Bangalore se bol rahe ho?"),
  ]);
  assert.equal(aside.disposition, "UNRESOLVED");
});

await test("D6. the caller saying NOTHING at a check-in decides nothing", () => {
  // The fix adds a handover point, and a handover point is a place a
  // caller can go quiet. That must reach the existing silence recovery
  // untouched, which means: no verdict, and no early hangup. The agent's
  // last turn being a question is what `definitiveAnswerIn` already
  // guards on, and the check-in is a question.
  const upToCheckIn: TranscriptTurn[] = [
    turn("assistant", GREETING),
    turn("user", "Haan boliye."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
  ];
  const { disposition } = settle(upToCheckIn);
  assert.notEqual(disposition, "FINAL_YES");
  assert.notEqual(disposition, "FINAL_NO");
  assert.equal(definitiveAnswerIn(asConversation(upToCheckIn), "registration"), undefined);
});

await test("D7. 'continue' at a check-in is not a verdict either way", () => {
  for (const said of ["Continue kijiye.", "Go on.", "Carry on.", "Haan aage boliye."]) {
    const { outcome, disposition } = settle([
      turn("assistant", GREETING),
      turn("user", "Haan boliye."),
      turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[1]!}`),
      turn("user", said),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${said}" must not register anyone`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. TWO PARTS IS NOT A RESTART, AND NOT A REPEAT");

const scriptText = findScript("registration", "v5")!.systemPromptAppendix;

await test("E1. a correctly segmented pitch raises no restart and no repeat", () => {
  const report = checkScriptAdherence({
    scriptText,
    transcript: [
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
      turn("assistant", `${PART_TWO} ${GATE}`),
      turn("assistant", YES_BLOCK),
    ],
  });
  assert.equal(report.restartedScript, false, "continuing is not starting over");
  assert.equal(report.repeatedScriptLines, 0, "nothing was said twice");
  assert.deepEqual(report.unsupportedFigures, [], "segmenting invents no figure");
});

await test("E2. re-saying part one after the check-in IS caught", () => {
  // The failure mode the policy's "not the part they just heard" line
  // exists to prevent. If this ever stops being detected, the guard
  // below is the only thing left holding it.
  const report = checkScriptAdherence({
    scriptText,
    transcript: [
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
      turn("assistant", `${PART_ONE} ${PART_TWO} ${GATE}`),
    ],
  });
  assert.ok(report.repeatedScriptLines > 0, "a re-delivered part must show up in the audit");
  assert.equal(report.clean, false);
});

await test("E3. re-introducing itself after the check-in is still a restart", () => {
  const report = checkScriptAdherence({
    scriptText,
    transcript: [
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
      turn("assistant", `${GREETING} ${PART_TWO} ${GATE}`),
    ],
  });
  assert.equal(report.restartedScript, true);
});

await test("E4. splitting the pitch loses no required campaign point", () => {
  // The rule the policy states — "two turns instead of one changes WHERE
  // you stop, never WHAT gets said". Asserted against the approved v4
  // pitch block's own content, so a future edit that shortens turns by
  // dropping a fact fails here rather than on a call.
  const spokenAcrossBothTurns = `${PART_ONE} ${PART_TWO} ${GATE}`.toLowerCase();
  for (const required of [
    "free live workshop",
    "sunday",
    "6th september",
    "11 am",
    "complete online business",
    "from a phone",
    "checkout",
    "website",
    "product",
    "checkout",
    "payments",
    "coding",
    "design skills",
    "reserve your free seat",
  ]) {
    assert.ok(
      spokenAcrossBothTurns.includes(required),
      `the two parts together must still carry "${required}"`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("F. THE REMINDER CALL IS NOT TURNED INTO A PITCH");

await test("F1. the reminder's one question still settles a confirmation", () => {
  const outcome = classifyOutcome({
    campaignType: "reminder",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: [
      turn("assistant", "Hi Priya, this is Ishita from Team FlexiFunnels."),
      turn("user", "Haan."),
      turn(
        "assistant",
        "You had registered for our session today at 11 AM. Will you be joining us tomorrow at 11 AM?",
      ),
      turn("user", "Haan, main aaunga."),
    ],
  });
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(
    dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" }).disposition,
    "FINAL_YES",
  );
});

await test("F2. a check-in on a reminder call is not an attendance confirmation either", () => {
  const outcome = classifyOutcome({
    campaignType: "reminder",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: [
      turn("assistant", "Hi Priya, this is Ishita from Team FlexiFunnels."),
      turn("user", "Haan."),
      turn("assistant", `It's the live session on launching from your phone. ${LICENSED_CHECKS[0]!}`),
      turn("user", "Haan."),
    ],
  });
  assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  assert.notEqual(
    dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" }).disposition,
    "FINAL_YES",
  );
});

// ═════════════════════════════════════════════════════════════════
section("G. THE NAME STEP COMES BEFORE THE PITCH, AND COMMITS NOBODY");

/** What the policy licenses for finding out who picked up. */
const NAME_ASKS = [
  "May I know your name?",
  "Aapka naam kya hai?",
  "And you are?",
  "Am I speaking with Priya?",
];
/**
 * ...and the family it forbids. Every one of these asks permission to
 * WRITE THE NAME DOWN, which is the wording this call already uses for
 * registering somebody. Asserted to BE gates, so the ban stays evidently
 * necessary rather than decorative.
 */
const FORBIDDEN_NAME_ASKS = [
  "Kya main aapka naam likh lun?",
  "Can I put your name down?",
  "Main aapka naam add kar du?",
];

await test("G1. the policy puts the name step before the explanation, and bounds it", () => {
  for (const required of [
    "before the pitch, know who you are talking to",
    "before you explain anything",
    "ask at most once",
    "then it is not a name",
    "do not ask a second time",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("G2. the policy forbids asking permission to write the name down", () => {
  for (const required of [
    "never ask whether you may write it down",
    "kya main aapka naam likh lun",
    "can i put your name down",
    "main aapka naam add kar du",
    "ask what their name is. never ask for permission to do something with it",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("G3. the policy says the name is not an answer, and not a refusal", () => {
  for (const required of [
    "their name is not their answer",
    "not a yes, not a no, not a confirmation and not a cancellation",
    "that is who you are talking to and not a refusal",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

await test("G4. the policy preserves the name as given, and does not overuse it", () => {
  for (const required of [
    "exactly as they said it",
    "do not anglicise it",
    "a hindi name said in hindi is the name",
    "a name in every sentence is worse than no name at all",
  ]) {
    assert.ok(policy.includes(required), `the policy must say "${required}"`);
  }
});

for (const ask of NAME_ASKS) {
  await test(`G5. "${ask}" is not the registration gate`, () => {
    const { outcome, disposition } = settle([
      turn("assistant", GREETING),
      turn("assistant", ask),
      turn("user", "Haan."),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${ask}" must not register anyone`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  });
}

for (const ask of FORBIDDEN_NAME_ASKS) {
  await test(`G6. "${ask}" WOULD register them — which is why the policy bans it`, () => {
    const { disposition } = settle([
      turn("assistant", GREETING),
      turn("assistant", ask),
      turn("user", "Haan."),
    ]);
    assert.equal(
      disposition,
      "FINAL_YES",
      `"${ask}" names a GATE_ACTION verb; the ban on it is load-bearing while this holds`,
    );
  });
}

/** Greeting, the name step, the answer. */
const afterName = (said: string): TranscriptTurn[] => [
  turn("assistant", GREETING),
  turn("assistant", NAME_ASKS[0]!),
  turn("user", said),
];

await test("G7. an ENGLISH name settles nothing", () => {
  for (const said of ["Priya.", "My name is Rajesh Kumar.", "This is Anita speaking."]) {
    const { outcome, disposition } = settle(afterName(said));
    assert.notEqual(disposition, "FINAL_YES", `"${said}" is not a registration`);
    assert.notEqual(disposition, "FINAL_NO", `"${said}" is not a refusal`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

await test("G8. a HINDI / HINGLISH name settles nothing", () => {
  for (const said of [
    "Mera naam Priya hai.",
    "Ji, Priya bol rahi hoon.",
    "मेरा नाम प्रिया है।",
    "Main Rajesh Kumar.",
  ]) {
    const { outcome, disposition } = settle(afterName(said));
    assert.notEqual(disposition, "FINAL_YES", `"${said}" is not a registration`);
    assert.notEqual(disposition, "FINAL_NO", `"${said}" is not a refusal`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

await test("G9. a name followed by YES is still not a registration", () => {
  // The most dangerous shape: the caller answers the name step and
  // volunteers a "haan" in the same breath, long before the gate.
  for (const said of ["Haan, Priya.", "Priya, haan boliye.", "Yes, this is Priya."]) {
    const { outcome, disposition } = settle(afterName(said));
    assert.notEqual(disposition, "FINAL_YES", `"${said}" must not register anyone`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
    // The "haan" is kept as evidence, and marked as not at the gate.
    const affirmation = outcome.detail.signals.find((s) => s.kind === "affirmation");
    if (affirmation) assert.equal(affirmation.atGate, false);
  }
});

await test("G10. a name followed by NO is a refusal of the CALL, never of the gate", () => {
  const { outcome, disposition } = settle([
    ...afterName("Priya."),
    turn("assistant", `${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Nahi, mujhe interest nahi hai."),
  ]);
  assert.equal(disposition, "FINAL_NO");
  assert.equal(outcome.outcomeType, "declined");
  assert.equal(outcome.primaryReason, "explicit_no");
  // The refusal is bound to the pitch. Giving a name contributed nothing
  // to it: nothing from the name turn is at the gate.
  const atGate = outcome.detail.signals.filter((s) => s.kind === "affirmation" && s.atGate);
  assert.deepEqual(atGate, []);
});

await test("G11. an UNCLEAR or MISSING name settles nothing and closes nothing", () => {
  for (const said of ["Haan ji.", "Hmm.", "Kaun bol raha hai?", "Kya chahiye?", "Hello?"]) {
    const { outcome, disposition } = settle(afterName(said));
    assert.notEqual(disposition, "FINAL_YES", `"${said}" is not a registration`);
    assert.notEqual(disposition, "FINAL_NO", `"${said}" must not close the contact`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

await test("G12. the caller is never hung up on during the name step", () => {
  const upTo: TranscriptTurn[] = [
    turn("assistant", GREETING),
    turn("assistant", NAME_ASKS[0]!),
    turn("user", "Priya."),
  ];
  for (let i = 1; i <= upTo.length; i += 1) {
    assert.equal(
      definitiveAnswerIn(asConversation(upTo.slice(0, i)), "registration"),
      undefined,
      `the call must still be live after turn ${i}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("H. THE NAME STEP DISTURBS NOTHING THAT ALREADY WORKS");

await test("H1. CONFIRMATION BINDING — the gate still binds through a full named call", () => {
  const { outcome, disposition } = settle([
    turn("assistant", GREETING),
    turn("assistant", NAME_ASKS[0]!),
    turn("user", "Mera naam Priya hai."),
    turn("assistant", `Thanks, Priya. ${PART_ONE} ${LICENSED_CHECKS[0]!}`),
    turn("user", "Haan."),
    turn("assistant", `${PART_TWO} ${GATE}`),
    turn("user", "Haan, kar dijiye."),
  ]);
  assert.equal(outcome.outcomeType, "registered_confirmed");
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  // EVERY affirmation that binds is in the LAST user turn — the answer
  // to the script's own question. Neither the name turn (index 2) nor
  // the check-in (index 4) contributes one. Asserted by turn rather
  // than by count because one answer can carry two affirming phrases
  // ("Haan, kar dijiye." is "haan" and "kar dijiye"), and that has
  // always been true of the gate turn.
  const lastUserTurn = 6;
  const atGate = outcome.detail.signals.filter((s) => s.kind === "affirmation" && s.atGate);
  assert.ok(atGate.length > 0, "the answer to the gate must still bind");
  for (const signal of atGate) {
    assert.equal(
      signal.turnIndex,
      lastUserTurn,
      `only the script's own question binds — "${signal.phrase}" bound at turn ${signal.turnIndex}`,
    );
  }
  // ...and the name turn and the check-in are on the row, not deciding.
  const notAtGate = outcome.detail.signals.filter((s) => s.kind === "affirmation" && !s.atGate);
  for (const signal of notAtGate) {
    assert.notEqual(signal.turnIndex, lastUserTurn);
  }
});

await test("H2. LANGUAGE LOCK — a bare name is not lock-grade, a real sentence still is", () => {
  // The lock needs an utterance that takes the floor AND carries at
  // least four words (LANGUAGE_LOCK_MIN_WORDS). A one-word name clears
  // neither bar, so answering the name step cannot fix the call's
  // language on a single token — the next real turn does it instead.
  const wordsIn = (t: string) => t.trim().split(/[ ]+/u).filter((w) => w.length > 0).length;
  for (const bare of ["Priya", "Rajesh", "Anita."]) {
    assert.ok(wordsIn(bare) < 4, `"${bare}" is too short to lock, by word count`);
    assert.equal(isAttentionCheck(bare), false, `"${bare}" is not an attention check`);
    assert.equal(isHearingCheck(bare), false, `"${bare}" is not a hearing check`);
    assert.equal(isRepeatedGreeting(bare), false, `"${bare}" is not a repeated greeting`);
    assert.equal(bufferedTurnTakesTheFloor(bare), true, `"${bare}" must not be dropped as noise`);
  }
  // A full sentence still locks, exactly as it does today, and it still
  // lands in the language it was actually spoken in: "Mera naam Priya
  // hai" is romanized Hindi with no English in it, so it is HINDI, not
  // Hinglish. Mixing one English word into it is what makes it Hinglish.
  const hindi = detectLanguage("Mera naam Priya hai");
  assert.equal(hindi.language, SupportedLanguage.HINDI);
  assert.ok(isLockGradeEvidence(hindi), "a real Hindi sentence is still lock-grade");
  const hinglish = detectLanguage("Mera naam Priya hai, main interested hoon");
  assert.equal(hinglish.language, SupportedLanguage.HINGLISH);
  assert.ok(isLockGradeEvidence(hinglish), "a genuinely mixed sentence is still Hinglish");
  const english = detectLanguage("My name is Rajesh Kumar");
  assert.equal(english.language, SupportedLanguage.ENGLISH);
  assert.ok(isLockGradeEvidence(english), "a real English sentence is still lock-grade");
  const devanagari = detectLanguage("मेरा नाम प्रिया है");
  assert.equal(devanagari.language, SupportedLanguage.HINDI, "a Devanagari name sentence is Hindi");
});

await test("H3. an acknowledgement is never mistaken for a name by the pipeline", () => {
  // "Haan ji" / "Hello?" take no floor and read as attention checks, so
  // they reach the name step as what they are and nothing downstream
  // can record them as somebody's name.
  for (const noise of ["Haan ji", "Hello?"]) {
    assert.equal(isAttentionCheck(noise), true, `"${noise}" is an attention check`);
    assert.equal(bufferedTurnTakesTheFloor(noise), false, `"${noise}" takes no floor`);
  }
});

await test("H4. the name step reaches the prompt, ahead of the long-block rule", () => {
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(script),
  });
  const prompt = buildSystemPrompt(
    SupportedLanguage.HINGLISH,
    "female",
    context.systemPromptAppendix,
  );
  assert.ok(prompt.includes("BEFORE THE PITCH, KNOW WHO YOU ARE TALKING TO"));
  assert.ok(
    prompt.indexOf("BEFORE THE PITCH, KNOW WHO YOU ARE TALKING TO") <
      prompt.indexOf("WHEN THERE IS A LOT TO SAY"),
    "who-you-are-talking-to comes before the how-to-split-a-long-block rule",
  );
  assert.ok(prompt.includes(GATE), "and the approved gate is still there, unchanged");
});

// ════════════════════════════════════════════════════════════════
section("I. REGISTRATION V5 — THE PITCH IS TWO EXCHANGES, AND THE MIDDLE ONE IS SAFE");

const V5 = findScript("registration", "v5")!;
/** v5's middle question, read out of the approved script itself. */
const V5_MIDDLE = "Have you tried putting something online before?";
const V5_GATE = "Would you like me to reserve your free seat?";

await test("I1. v5 is registered, still shipping in v15, and carries both questions verbatim", () => {
  // `registration v15` is now the default: v6's workshop — which was v5
  // with the event date corrected — in the conversation shape v8-v14
  // converged on. This section is about the PITCH SHAPE v5 introduced,
  // so it keeps reading v5 — and asserts that the shape survived into
  // the version that actually ships, which is the thing that would
  // matter if a later version quietly dropped it.
  assert.equal(defaultScriptFor("registration").version, "v15");
  const shipping = defaultScriptFor("registration");
  assert.ok(shipping.systemPromptAppendix.includes(V5_MIDDLE), "the shipping script keeps the middle question");
  assert.ok(shipping.systemPromptAppendix.includes(V5_GATE), "...and the gate, unchanged");
  assert.ok(V5.systemPromptAppendix.includes(V5_MIDDLE), "the middle question must be in the script");
  assert.ok(V5.systemPromptAppendix.includes(V5_GATE), "the gate must be in the script, unchanged");
  assert.equal(V5.requiresName, true);
  // v4 stays exactly as it was, for campaigns pinned to it.
  const v4 = findScript("registration", "v4");
  assert.ok(v4, "v4 must stay registered");
  assert.equal(
    hashScript(v4),
    "e87faaccb3a9064d112fb173abbbed4c8bccb6dd5aeec3f22995b6f9a8ad4358",
    "publishing v5 must not touch v4",
  );
});

await test("I2. v5 keeps every campaign fact v4 stated, and adds none", () => {
  const text = V5.systemPromptAppendix.toLowerCase();
  for (const required of [
    "free live workshop",
    "sunday",
    "6th september",
    "11 am",
    "complete online business",
    "from a phone",
    "website",
    "product",
    "checkout",
    "payments",
    "coding",
    "design skills",
    "reserve your free seat",
    "whatsapp and email",
    "launch-in-a-day starter kit",
    "1,50,000",
    "live q&a session",
    "special reveal",
  ]) {
    assert.ok(text.includes(required.toLowerCase()), `v5 must still carry "${required}"`);
  }
  // Every FIGURE in v5 must already exist in v4 — the cheapest proof
  // that restructuring invented no price, date, time or count.
  const figures = (t: string) => new Set((t.match(/\d[\d.,:]*/gu) ?? []).map((f) => f.replace(/\D+/gu, "")));
  const v4Figures = figures(findScript("registration", "v4")!.systemPromptAppendix);
  for (const figure of figures(V5.systemPromptAppendix)) {
    assert.ok(v4Figures.has(figure), `v5 states a figure v4 never did: ${figure}`);
  }
});

await test("I3. the middle question is not the gate — yes, haan, haan ji, okay", () => {
  for (const said of [
    "Haan.",
    "Haan ji.",
    "Yes.",
    "Okay.",
    "Ji haan.",
    "Haan, kiya tha.",
    "Yes, I have.",
    "Haan thoda bahut.",
  ]) {
    const { outcome, disposition } = settle([
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${V5_MIDDLE}`),
      turn("user", said),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${said}" to the middle question must not register`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `"${said}" must not bind at a gate`);
    // ...and no affirmation anywhere in the call is marked at the gate.
    const atGate = outcome.detail.signals.filter((sig) => sig.kind === "affirmation" && sig.atGate);
    assert.deepEqual(atGate, [], `"${said}" must contribute no gate-bound signal`);
  }
});

await test("I4. ...and the live call is never cut short on that yes", () => {
  for (const said of ["Haan.", "Haan ji.", "Yes.", "Okay."]) {
    const live = [
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${V5_MIDDLE}`),
      turn("user", said),
    ];
    assert.equal(
      definitiveAnswerIn(asConversation(live), "registration"),
      undefined,
      `"${said}" must not end the call`,
    );
  }
});

await test("I5. a NO at the middle question is not the end — the gate still decides", () => {
  // "No, I haven't tried that" is a willing prospect describing their
  // situation. It must not out-rank the answer they give at the gate.
  for (const said of ["Nahi.", "No.", "Nahi, kabhi nahi kiya.", "No, I haven't.", "Abhi kuch nahi hai."]) {
    const { outcome, disposition } = settle([
      turn("assistant", GREETING),
      turn("assistant", `${PART_ONE} ${V5_MIDDLE}`),
      turn("user", said),
      turn("assistant", `${PART_TWO} ${V5_GATE}`),
      turn("user", "Haan, kar dijiye."),
      turn("assistant", YES_BLOCK),
    ]);
    assert.equal(disposition, "FINAL_YES", `"${said}" mid-pitch must not lose the later yes`);
    assert.equal(outcome.primaryReason, "confirmed_at_gate");
  }
});

await test("I6. a real refusal at the gate is still a refusal", () => {
  const { outcome, disposition } = settle([
    turn("assistant", GREETING),
    turn("assistant", `${PART_ONE} ${V5_MIDDLE}`),
    turn("user", "Haan, kiya tha."),
    turn("assistant", `${PART_TWO} ${V5_GATE}`),
    turn("user", "Nahi, mujhe interest nahi hai."),
  ]);
  assert.equal(disposition, "FINAL_NO");
  assert.equal(outcome.outcomeType, "declined");
});

await test("I7. changing their mind AT the gate is honoured", () => {
  const { disposition } = settle([
    turn("assistant", GREETING),
    turn("assistant", `${PART_ONE} ${V5_MIDDLE}`),
    turn("user", "Haan."),
    turn("assistant", `${PART_TWO} ${V5_GATE}`),
    turn("user", "Haan, kar dijiye."),
    turn("assistant", YES_BLOCK),
    turn("user", "Actually nahi, rehne dijiye. Please do not reserve it."),
  ]);
  assert.notEqual(disposition, "FINAL_YES", "a retraction after the gate must not stay a registration");
});

await test("I8. the middle question is not a qualification question", () => {
  // `conversation-policy.ts` bans qualifying this person. v5's question
  // asks about the thing the pitch is ABOUT, not about their money,
  // their team or their tools.
  const middle = V5_MIDDLE.toLowerCase();
  for (const banned of ["budget", "revenue", "earn", "team", "employees", "turnover", "salary", "invest"]) {
    assert.ok(!middle.includes(banned), `the middle question must not ask about "${banned}"`);
  }
  // And it is not an offer to do anything for them.
  for (const banned of ["reserve", "register", "book", "sign you up", "put your name", "naam likh"]) {
    assert.ok(!middle.includes(banned), `the middle question must not offer to "${banned}"`);
  }
});

await test("I9. v5's two exchanges are each shorter than v4's single block", () => {
  // The defect this version exists to fix, measured on the approved text
  // rather than on a model's output: v4 asked the caller for nothing
  // until the commitment question, so its whole invitation was one turn.
  const wordsIn = (t: string) => t.trim().split(/[ \n]+/u).filter((w) => w.length > 0).length;
  const v4Block =
    "I'm calling to personally invite you to a free live workshop we're hosting on Sunday, 6th " +
    "September at 11 AM. We'll actually build a complete online business live, directly from a " +
    "phone — including the website, product, checkout and payments. And you don't need any coding " +
    "or design skills. Would you like me to reserve your free seat?";
  const first = `${PART_ONE} ${V5_MIDDLE}`;
  const second = `${PART_TWO} ${V5_GATE}`;
  assert.ok(wordsIn(first) < wordsIn(v4Block), "the first exchange must be shorter than v4's block");
  assert.ok(wordsIn(second) < wordsIn(v4Block), "and so must the second");
  // ...but not clipped into a robotic stub. A real turn still has
  // something in it; this is the guard against over-optimising for
  // shortness.
  assert.ok(wordsIn(first) >= 25, "the first exchange must still be worth hearing");
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
