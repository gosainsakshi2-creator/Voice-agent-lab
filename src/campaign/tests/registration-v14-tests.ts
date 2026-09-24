/**
 * registration-v14-tests.ts — `npm run test:registration-v14`
 *
 * THE SAME SESSION AS v13, THE OPPOSITE AUDIENCE: NOT ATTENDEES.
 *
 * v14 is v13's sibling — same event, same gate, same shape — for people
 * who did not attend the two-day AI Income Blueprint event. So beyond
 * the checks every script of this family gets (the gate registers,
 * nothing before it does, every terminal branch ends the call, no leak,
 * no invented fact), this suite pins the FOUR things that separate it
 * from v13, each of which is a false statement about the person or the
 * offer if it decays:
 *
 *   - v13's attendance claim is GONE and forbidden by name (section E);
 *   - the 2-extra-days tool-access promise is GONE, because a
 *     non-attendee has no access to extend (section E);
 *   - eligibility is never asserted either way — it routes to "I don't
 *     have that detail" (section E);
 *   - the discovery question and bridge are v12's, and its Hinglish
 *     appears in ONE form in both the appendix and the body — the drift
 *     that has had v12's own B1 failing (section B).
 *
 * v13 IS ASSERTED UNCHANGED, by hash. It is the script a real campaign
 * runs; this file existing must not move it.
 *
 * Everything here is deterministic — the instruction and the real
 * readers. What the model says on a live call is a distribution and is
 * not asserted. NO NETWORK, NO DATABASE, NO VENDOR.
 */

import assert from "node:assert/strict";

const { findScript, hashScript, defaultScriptFor, listScripts, scriptVariables } = await import(
  "../script/script-registry"
);
const { buildCampaignContext } = await import("../domain/campaign-context");
const { CAMPAIGN_CONVERSATION_POLICY } = await import("../script/conversation-policy");
const { validateCampaignScript } = await import("../script/script-validation");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes } = await import("../integrations/final-yes-sheet");
const { definitiveAnswerIn, liveRegistrationReading, agentClosedIn } = await import(
  "../dispatch/call-runner"
);
const { formatForSpeech } = await import("../../utils/speech-formatter");

import type { TranscriptTurn } from "../outcome/transcript";
import type { CampaignScript } from "../script/script-types";
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
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`,
    );
  }
}

const section = (title: string) => console.log(`\n${title}`);

const V14 = findScript("registration", "v14");
assert.ok(V14, "registration v14 must be registered before this suite can run");
const V13 = findScript("registration", "v13");
assert.ok(V13, "registration v13 must still be registered — v14 is its sibling");
const V12 = findScript("registration", "v12");
assert.ok(V12, "registration v12 must still be registered — v14 restores its framing");

const APPENDIX = V14.systemPromptAppendix;
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");
const BODY = APPENDIX.slice(APPENDIX.indexOf("--- SCRIPT ---"));
const HEAD = APPENDIX.slice(0, APPENDIX.indexOf("--- SCRIPT ---"));

// ── The lines this campaign actually speaks ──────────────────────
const FULL_NAME = "Rahul Sharma";
const NAME = "Rahul";
const OPENING = `Hello, am I speaking with ${FULL_NAME}?`;
const FIRST_EN =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. We're doing a free live session tonight at 8 where we set up ` +
  `your pages, your funnel and your payments with you — live, on your own screen. ` +
  `Have you tried putting something online before?`;
const FIRST_HI =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. Aaj raat 8 baje humara ek free live session hai, jisme hum ` +
  `aapke pages, funnel aur payments aapke saath set up karte hain — live, aapki hi screen pe. ` +
  `Aapne pehle kabhi kuch online daalne ki try ki hai?`;
const DISCOVERY_EN = "Have you tried putting something online before?";
const DISCOVERY_HI = "Aapne pehle kabhi kuch online daalne ki try ki hai?";
const DISCOVERY_DEV = "आपने पहले कभी कुछ online डालने की try की है?";
const BRIDGE_EN = "You won't need any coding or design skills for this.";
const BRIDGE_HI = "Iske liye koi coding ya design skill nahi chahiye.";
const GATE_EN = "Would you like me to reserve your free seat?";
const GATE_HI = "Toh kya main aapki free seat reserve kar du?";
const YES_EN = `Perfect, ${NAME} — your free seat is reserved for tonight at 8 PM. Do join a few minutes early. Hope to see you there!`;
const YES_HI = `Perfect, ${NAME} — aapki free seat confirm ho gayi hai, aaj raat 8 baje ke liye. Thoda pehle join kar lena. Hope to see you there!`;
const NO_BLOCK = `Okay, no problem at all. Thanks for your time, ${NAME}. Have a great day!`;
const ALREADY_EN = "Oh, that's great — then you're all set for tonight at 8 PM. Do join a few minutes early.";
const GOODBYE = `Thanks for your time, ${NAME}. Have a great day!`;

const turn = (role: TranscriptTurn["role"], text: string): TranscriptTurn =>
  ({ role, text }) as TranscriptTurn;
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

function settle(transcript: readonly TranscriptTurn[]) {
  const outcome = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
  });
  const { disposition } = dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" });
  return { outcome, disposition };
}

const live = (transcript: readonly TranscriptTurn[]): ConversationTurn[] =>
  transcript.map(
    (t) => ({ role: t.role, content: t.text, timestamp: new Date() }) as unknown as ConversationTurn,
  );

const validationFor = (script: CampaignScript, now: Date) => ({
  campaignType: script.campaignType,
  scriptId: script.id,
  scriptVersion: script.version,
  scriptHash: hashScript(script),
  allocatedProviders: ["cartesia"] as const,
  contactsMissingName: 0,
  now,
});

/** The whole happy path, as the agent would actually speak it. */
const happyPath = (first: string, said: string, bridge: string, gate: string, yes: string, yesBlock: string) => [
  agent(OPENING), caller("Yes."),
  agent(first), caller(said),
  agent(`${bridge} ${gate}`), caller(yes),
  agent(yesBlock),
];

// ═════════════════════════════════════════════════════════════════
section("A. REGISTERED, SELECTABLE, NOT THE DEFAULT, AND DATED");

test("A1. v14 is a registration script, approved, name-requiring, dated, and listed under v13", () => {
  assert.equal(V14.version, "v14");
  assert.equal(V14.isPlaceholder, false);
  assert.equal(V14.requiresName, true);
  assert.equal(V14.eventAt, "2026-09-22T20:00:00+05:30", "the same session as v13, so the same instant");
  assert.equal(V14.eventAt, V13.eventAt);
  assert.equal(defaultScriptFor("registration").version, "v15", "v14 must not become the default");
  const registration = listScripts().filter((s) => s.campaignType === "registration").map((s) => s.version);
  // v13 stays AHEAD of v14: v13 is the script a real campaign runs.
  // `registration v15` — v6's workshop in the later conversation shape —
  // took the first place, so both sit one lower than when v14 shipped.
  // `registration v16` — v15's call with its Hinglish written in
  // Devanagari — sits directly under v15 since 2026-09-24, registered
  // but deliberately not the default, so everything below moved once more.
  assert.deepEqual(registration.slice(0, 6), ["v15", "v16", "v6", "v13", "v14", "v12"]);
  assert.deepEqual(scriptVariables(V14), ["agent_name", "customer_name"]);
});

test("A2. v13 IS UNCHANGED — this file existing must not move the attendee script", () => {
  assert.equal(hashScript(V13), "6ab781f667a11b78102da4ed1bb047facb2335f6e923af14cd1635359b0ec91f");
  assert.equal(hashScript(V12), "cdb8d78c2f3acf8b98fabaf35afd3780e1dca4f72c7e7af4278c88427c731bb9");
  for (const other of listScripts()) {
    if (other !== V14) assert.notEqual(hashScript(other), hashScript(V14));
  }
});

test("A3. preflight dials through the day of the 22nd and refuses after 8 PM", () => {
  assert.equal(validateCampaignScript(validationFor(V14, new Date("2026-09-22T10:00:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V14, new Date("2026-09-22T19:45:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V14, new Date("2026-09-22T20:01:00+05:30"))).ok, false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE SHAPE — v12'S, AND ITS HINGLISH AGREES WITH ITSELF");

test("B1. the body asks exactly one question before the seat question, in each rendering", () => {
  const beforeYes = BODY.slice(0, BODY.indexOf("[YES]"));
  const questions = beforeYes.match(/[^\n]*\?/gu) ?? [];
  // opening, first reply EN, first reply HI, gate EN, gate HI — five lines end in "?"
  assert.equal(questions.length, 5, `expected 5 question lines before [YES], found ${questions.length}`);
  assert.ok(beforeYes.includes(DISCOVERY_EN));
  assert.ok(beforeYes.includes(DISCOVERY_HI));
  assert.ok(beforeYes.includes(GATE_EN));
  assert.ok(beforeYes.includes(GATE_HI));
  assert.ok(BODY.includes(`${BRIDGE_EN} ${GATE_EN}`), "the bridge runs straight into the gate");
  assert.ok(BODY.includes(`${BRIDGE_HI} ${GATE_HI}`));
});

test("B2. THE APPENDIX AND THE BODY AGREE — the drift that broke v12's own B1", () => {
  // v12's body was hand-edited to "daalne ka try kra hai?" after its
  // appendix and its tests had pinned "daalne ki try ki hai?", and v12's
  // B1 has failed ever since. Here there is ONE form, in both places.
  for (const line of [DISCOVERY_EN, DISCOVERY_HI, GATE_EN, GATE_HI, BRIDGE_EN, BRIDGE_HI]) {
    assert.ok(BODY.includes(line), `the body must speak "${line}"`);
    assert.ok(HEAD.replace(/\s+/gu, " ").includes(line), `the instruction must quote "${line}"`);
  }
  assert.ok(!FLAT.includes("daalne ka try kra hai"), "v12's hand-edited variant must not appear");
  assert.equal(FLAT.split("daalne ki try ki hai").length - 1, 2, "once in the instruction, once in the body");
});

test("B3. no interview questions, and the text forbids adding them back", () => {
  for (const dropped of [
    "are you already running a business", "what kind of business", "already have a website",
    "specific idea in mind", "kis type ka business", "koi website hai", "kuch specific idea",
  ]) {
    assert.ok(!FLAT.includes(dropped), `v14 must not ask "${dropped}"`);
  }
  assert.ok(FLAT.includes("do not add questions the script does not ask"));
  assert.ok(FLAT.includes("you are inviting them, not interviewing them"));
});

test("B4. no long turns — every block is short, and the text says so", () => {
  assert.ok(FLAT.includes("every turn is at most three short sentences and one question"));
  assert.ok(FLAT.includes("never describe the whole session in one go"));
  const blocks = BODY.split("\n").filter(
    (l) => l.trim().length > 0 && !l.trim().startsWith("[") && !l.includes("--- SCRIPT ---"),
  );
  for (const block of blocks) {
    const spoken = block.replace(/^\s*In Hinglish:\s*/u, "");
    const sentences = spoken.split(/[.!?](?:\s|$)/u).filter((s) => s.trim().length > 0).length;
    assert.ok(sentences <= 4, `block runs to ${sentences} sentences: "${spoken.slice(0, 60)}…"`);
  }
});

test("B5. the discovery question, the bridge and the branch lines are v12's, word for word", () => {
  for (const carried of [
    DISCOVERY_EN, BRIDGE_EN, GATE_EN, "take it as an answer, say",
    "So you know the fiddly part", "Then this is a good place to start",
    "Okay, no problem at all.", "Do join a few minutes early.",
  ]) {
    assert.ok(V12.systemPromptAppendix.includes(carried), `"${carried}" must come from v12`);
    assert.ok(APPENDIX.includes(carried), `"${carried}" must be in v14`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. THE GATE REGISTERS, NOTHING BEFORE IT DOES");

test("C1. a yes at the gate is confirmed_at_gate, FINAL_YES and sheet-eligible, in both renderings", () => {
  for (const [first, said, bridge, gate, yes, yesBlock] of [
    [FIRST_EN, "Yes, I tried once.", BRIDGE_EN, GATE_EN, "Yes please.", YES_EN],
    [FIRST_EN, "No, never.", BRIDGE_EN, GATE_EN, "Sure.", YES_EN],
    [FIRST_HI, "Nahi, kabhi nahi.", BRIDGE_HI, GATE_HI, "Haan ji.", YES_HI],
    [FIRST_HI, "Haan, ek baar try kiya tha.", BRIDGE_HI, GATE_HI, "Bilkul, kar do.", YES_HI],
  ] as const) {
    const { outcome, disposition } = settle(happyPath(first, said, bridge, gate, yes, yesBlock));
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" then "${yes}" must register`);
    assert.equal(disposition, "FINAL_YES");
    assert.equal(isFinalYes(outcome, disposition), true);
  }
});

test("C2. a no at the gate is not a registration", () => {
  for (const said of ["No.", "Nahi.", "No, not right now.", "Abhi nahi."]) {
    const { outcome, disposition } = settle([
      agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Yes, a bit."),
      agent(`${BRIDGE_EN} ${GATE_EN}`), caller(said),
    ]);
    assert.notEqual(disposition, "FINAL_YES");
    assert.equal(isFinalYes(outcome, disposition), false);
  }
});

test("C3. YES or NO to the discovery question registers nobody and declines nobody", () => {
  for (const first of [FIRST_EN, FIRST_HI, `Hi ${NAME}. ${DISCOVERY_DEV}`]) {
    for (const said of ["Yes.", "Haan.", "Haan ji.", "Yes, I have a website already.", "Bilkul.", "हाँ।"]) {
      const { outcome, disposition } = settle([agent(OPENING), caller("Yes."), agent(first), caller(said)]);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" to the discovery question must not register`);
      assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
    }
    for (const said of ["No.", "Nahi.", "No, nothing yet.", "Nahi, kabhi nahi."]) {
      const { outcome } = settle([agent(OPENING), caller("Yes."), agent(first), caller(said)]);
      assert.notEqual(outcome.primaryReason, "declined_at_gate", `"${said}" answers a question about THEM`);
    }
  }
});

test("C4. the identity answer is not a registration either", () => {
  for (const said of ["Yes.", "Haan ji.", "Speaking."]) {
    const { disposition } = settle([agent(OPENING), caller(said)]);
    assert.notEqual(disposition, "FINAL_YES");
  }
});

test("C5. the forbidden early forms really would register — which is why the text forbids them", () => {
  const { disposition } = settle([
    agent(OPENING), caller("Yes."), agent(`Hi ${NAME}. Would you like to attend?`), caller("Yes."),
  ]);
  assert.equal(disposition, "FINAL_YES");
  assert.ok(FLAT.includes("not \"would you like to attend\", not \"do you want to attend\""));
  assert.ok(FLAT.includes("not \"will you join us live\""));
  assert.ok(FLAT.includes("never bring it forward into the first reply"));
});

test("C6. every fixed line survives the speech formatter unchanged", () => {
  for (const line of [
    GATE_EN, GATE_HI, DISCOVERY_EN, DISCOVERY_HI, BRIDGE_EN, BRIDGE_HI,
    YES_EN, YES_HI, NO_BLOCK, ALREADY_EN, GOODBYE, OPENING,
  ]) {
    assert.equal(formatForSpeech(line), line);
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. EVERY TERMINAL BRANCH ENDS THE CALL");

test("D1. YES: the registration commits at the yes, and the confirmation leaves FINAL_YES standing", () => {
  for (const [gate, yesBlock] of [[GATE_EN, YES_EN], [GATE_HI, YES_HI]] as const) {
    const t = [
      agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Yes."),
      agent(`${BRIDGE_EN} ${gate}`), caller("Yes, go ahead."),
    ];
    assert.equal(liveRegistrationReading(live(t), "registration").registrationConfirmed, true);
    const after = liveRegistrationReading(live([...t, agent(yesBlock)]), "registration");
    assert.equal(after.verdict, "FINAL_YES");
    assert.equal(after.awaitingClosingResponse, true);
    assert.ok(!yesBlock.includes("?"));
  }
});

test("D2. the confirmation is not itself a gate", () => {
  for (const block of [YES_EN, YES_HI, ALREADY_EN]) {
    const { outcome } = settle([agent(OPENING), caller("Yes."), agent(block), caller("Okay.")]);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

test("D3. NOT INTERESTED ends the call as FINAL_NO — at the discovery question and at the gate", () => {
  const early = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("No, I'm not interested."), agent(NO_BLOCK),
  ];
  assert.equal(definitiveAnswerIn(live(early), "registration"), "FINAL_NO");
  const hindi = [
    agent(OPENING), caller("Yes."), agent(FIRST_HI), caller("Nahi, mujhe interest nahi hai."),
    agent(`Okay, koi baat nahi. Thanks for your time, ${NAME}. Have a great day!`),
  ];
  assert.equal(definitiveAnswerIn(live(hindi), "registration"), "FINAL_NO");
  const atGate = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Not really."),
    agent(`${BRIDGE_EN} ${GATE_EN}`), caller("No, not interested."), agent(NO_BLOCK),
  ];
  assert.equal(definitiveAnswerIn(live(atGate), "registration"), "FINAL_NO");
  assert.equal(settle(atGate).disposition, "FINAL_NO");
});

test("D4. the goodbye is a recognised closing, with a first name or a full name after it", () => {
  for (const spoken of [NAME, FULL_NAME]) {
    const t = [
      agent(OPENING), caller("Yes."), agent(ALREADY_EN), caller("Okay, thanks."),
      agent(`Thanks for your time, ${spoken}. Have a great day!`),
    ];
    assert.equal(agentClosedIn(live(t)), true);
  }
});

test("D5. ALREADY REGISTERED: no gate, no new registration, no refusal — settles UNRESOLVED", () => {
  const t = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("I've already registered for it."),
    agent(ALREADY_EN), caller("Okay."), agent(GOODBYE),
  ];
  const { outcome, disposition } = settle(t);
  assert.equal(disposition, "UNRESOLVED");
  assert.equal(isFinalYes(outcome, disposition), false);
  assert.equal(agentClosedIn(live(t)), true);
  assert.ok(FLAT.includes("do not ask the seat question and do not take them through a registration again"));
});

// ═════════════════════════════════════════════════════════════════
section("E. THE FOUR THINGS THAT SEPARATE v14 FROM v13");

/**
 * A phrase v14 must never SAY, though the text may name it once in order
 * to forbid it.
 *
 * A flat `!includes` cannot tell a claim from its own prohibition — it
 * reads "never say they came to the two days" as saying it — so each
 * phrase is counted instead, and its sole occurrence must sit inside the
 * sentence that bans it. Same idiom as v12's "i'll send" check, and the
 * reason both of these read as counts rather than bans.
 */
const bannedExceptInProhibition = (phrase: string, prohibition: string) => {
  assert.ok(FLAT.includes(prohibition), `the prohibition itself is missing: "${prohibition}"`);
  assert.ok(prohibition.includes(phrase), `"${prohibition}" does not contain "${phrase}"`);
  assert.equal(
    FLAT.split(phrase).length - 1,
    1,
    `"${phrase}" must appear exactly once in v14, inside its own prohibition`,
  );
};

const NO_ATTENDANCE =
  "never say they were at our two-day event, came to the two days, or attended anything";
const NO_BONUS =
  "never offer extra days of tool access, a discount, a recording or a bonus of any kind";

test("E1. v13's ATTENDANCE CLAIM is gone, and forbidden by name", () => {
  // The one thing v13 was allowed to say. Here it would be an invention
  // about the person, so it appears only in the sentence banning it.
  for (const never of [
    "you were at our two-day", "who came to the two days", "attended the two-day",
    "do din wale event mein the", "aap humare do din", "this person attended",
    "everyone who came",
  ]) {
    assert.ok(!FLAT.includes(never), `v14 must not say "${never}"`);
  }
  bannedExceptInProhibition("came to the two days", NO_ATTENDANCE);
  // The sanity half: v13 really does make the claim this one drops.
  assert.ok(
    V13.systemPromptAppendix.toLowerCase().includes("you were at our two-day event"),
    "v13 must still carry the attendance claim, or this test is asserting nothing",
  );
  assert.ok(FLAT.includes("this person has no history with this session"));
});

test("E2. the 2-EXTRA-DAYS PROMISE is gone — there is no access to extend", () => {
  for (const never of [
    "2 more days", "two more days", "two extra days", "do din aur", "do extra din",
    "extend your free tool access", "extends your free tool access", "gets the two extra",
  ]) {
    assert.ok(!FLAT.includes(never), `v14 must not promise "${never}"`);
  }
  bannedExceptInProhibition("tool access", NO_BONUS);
  // The sanity half: v13 really does make the promise this one drops.
  assert.ok(
    V13.systemPromptAppendix.includes("two more days"),
    "v13 must still carry the tool-access promise, or this test is asserting nothing",
  );
  assert.ok(FLAT.includes("there is no such offer on this call"));
});

test("E3. ELIGIBILITY is never asserted, in either direction", () => {
  assert.ok(FLAT.includes("do i need to have attended anything?"));
  assert.ok(FLAT.includes("never tell them they are eligible, never tell them they are not, and never invent a condition"));
  assert.ok(FLAT.includes("whether they need to have attended anything"), "it is in the do-not-guess list too");
  // "Attendees only" is the page's term and is NOT claimed either way here.
  for (const claimed of ["attendees only", "only for attendees", "you are eligible", "you qualify"]) {
    assert.ok(!FLAT.includes(claimed), `v14 must not state "${claimed}"`);
  }
});

test("E4. INVITATION FRAMING is restored from v12 — no manufactured history", () => {
  for (const invented of [
    "shown interest", "interest show kiya", "you asked about", "you had asked",
    "still planning", "still want", "abhi bhi attend", "still interested", "as discussed",
  ]) {
    assert.ok(!FLAT.includes(invented), `"${invented}" must not survive`);
  }
  assert.ok(FLAT.includes("it is an invitation, not a follow-up"));
  assert.ok(FLAT.includes("never say or imply that they signed up, showed interest or decided anything before this call"));
});

// ═════════════════════════════════════════════════════════════════
section("F. THE NAME, THE FACTS, THE FAQ, AND NO LEAK");

test("F1. full name only in the opening and the identity sentences; [first name] everywhere after", () => {
  const afterConfirmation = BODY.slice(BODY.indexOf("[THEY CONFIRM"));
  assert.ok(BODY.startsWith("--- SCRIPT ---\n\nHello, am I speaking with {{customer_name}}?"));
  assert.ok(!afterConfirmation.includes("{{customer_name}}"));
  assert.equal(APPENDIX.split("{{customer_name}}").length - 1, 5, "header, identity, rule (2), opening");
  assert.ok(APPENDIX.split("[first name]").length - 1 >= 8);
  assert.ok(FLAT.includes("the first word of {{customer_name}}"));
});

test("F2. interpolated with a two-word name, the full name never follows Hi, Perfect or Thanks", () => {
  const context = buildCampaignContext({
    script: V14, campaignId: "cmp_v14", campaignType: "registration",
    provider: "smallest-ai", customerName: FULL_NAME,
  });
  assert.equal(context.openingLine, OPENING);
  const appendix = context.systemPromptAppendix.slice(
    0, context.systemPromptAppendix.indexOf("# HOW TO RUN THIS SCRIPT"),
  );
  assert.equal(appendix.split(FULL_NAME).length - 1, 5);
  for (const bad of [`Hi ${FULL_NAME}`, `Perfect, ${FULL_NAME}`, `Thanks for your time, ${FULL_NAME}`]) {
    assert.ok(!appendix.includes(bad), `the prompt must not carry "${bad}"`);
  }
  assert.ok(!/\{\{/u.test(context.systemPromptAppendix));
  assert.ok(context.systemPromptAppendix.endsWith(CAMPAIGN_CONVERSATION_POLICY));
});

test("F3. the session facts are the page's, and the unstated ones route to 'I don't know'", () => {
  for (const sourced of [
    "8 pm ist", "tuesday 22nd september", "live and online", "completely free",
    "170-plus actions inside flexi genie", "seats are limited", "live q&a",
    "lead forms that capture leads and checkouts that take payments",
    "nothing moves on until theirs works too",
  ]) {
    assert.ok(FLAT.includes(sourced), `the sourced fact "${sourced}" must be in the text`);
  }
  assert.ok(FLAT.includes("how long the session runs, which platform it is on, who is presenting, whether there is a recording"));
  for (const unstated of ["90 minute", "60 minute", "two hour", "recording will", "replay will"]) {
    assert.ok(!FLAT.includes(unstated), `"${unstated}" is not on the page — it must not be asserted`);
  }
});

test("F4. the FAQ answers what a cold contact actually asks", () => {
  for (const asked of [
    "what is this session about", "who are you", "i don't know flexifunnels",
    "do i need to have attended anything", "i'm not sure yet", "is it free",
    "i don't know coding", "what is flexi genie", "do i need a laptop",
    "do you need my email", "send me the details on whatsapp", "i'm busy",
    "i'm not interested", "i've already registered", "how much can i make",
  ]) {
    assert.ok(FLAT.includes(asked), `the FAQ must handle "${asked}"`);
  }
  assert.ok(FLAT.includes("registration complete hone ke baad session ki details aapko whatsapp pe mil jaayengi."));
  assert.equal(FLAT.split("i'll send").length - 1, 1, "only inside its own prohibition");
  assert.ok(FLAT.includes("never ask them for an email address"));
  // v13's attendee-only FAQs are meaningless here and must be gone.
  for (const dropped of ["how is it different from the two days", "i missed the event"]) {
    assert.ok(!FLAT.includes(dropped), `"${dropped}" is v13's — it must not be in v14`);
  }
});

test("F5. no internal machinery, tool or provider name, and no invented fact, is in the text", () => {
  for (const leak of [
    "classifier", "commit_anchors", "final_yes", "final_no", "pipeline", "tool call",
    "hangup", "watchdog", "disposition", "unresolved", "system prompt", "internal note",
    "vobiz", "plivo", "deepgram", "soniox", "sarvam", "cartesia", "smallest", "elevenlabs",
    "openai", "gpt", "gemma", "gemini", "google",
    "zoom", "₹", "lakh", "worth", "we guarantee", "is guaranteed", "i will send",
    "hum bhej", "whatsapp pe bhej", "flexiagent",
  ]) {
    assert.ok(!FLAT.includes(leak), `the appendix must not contain "${leak}"`);
  }
  for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
    assert.ok(!FLAT.includes(banned));
  }
});

test("F6. a campaign pinned to v14 refuses to run if the words are edited, and a nameless contact cannot be called", () => {
  const edited: CampaignScript = { ...V14, systemPromptAppendix: `${V14.systemPromptAppendix} ` };
  assert.throws(
    () => buildCampaignContext({
      script: edited, campaignId: "c", campaignType: "registration",
      provider: "smallest-ai", customerName: NAME, expectedScriptHash: hashScript(V14),
    }),
    /has changed since this campaign was created/u,
  );
  assert.throws(
    () => buildCampaignContext({
      script: V14, campaignId: "c", campaignType: "registration",
      provider: "smallest-ai", customerName: "  ",
    }),
    /needs the contact's name/u,
  );
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
