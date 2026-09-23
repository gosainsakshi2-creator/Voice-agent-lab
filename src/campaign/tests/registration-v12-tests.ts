/**
 * registration-v12-tests.ts — `npm run test:registration-v12`
 *
 * THE v5-SHAPED WEBINAR SCRIPT: ONE QUESTION ABOUT THEM, THEN THE SEAT.
 *
 * v12 exists because v9-v11 asked too many questions. So beyond the
 * checks every webinar script gets — the gate registers, nothing before
 * it does, every terminal branch ends the call, no leak, no invented fact
 * — this suite pins the SHAPE: the body asks exactly one question about
 * the person before the seat question, and the appendix forbids adding
 * more. The facts and the two sourced answers are asserted identical to
 * v11, character for character.
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

const V12 = findScript("registration", "v12");
assert.ok(V12, "registration v12 must be registered before this suite can run");
const V11 = findScript("registration", "v11");
assert.ok(V11, "registration v11 must still be registered — v12 keeps its facts");

const APPENDIX = V12.systemPromptAppendix;
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");
const BODY = APPENDIX.slice(APPENDIX.indexOf("--- SCRIPT ---"));

// ── The lines this campaign actually speaks ──────────────────────
const FULL_NAME = "Rahul Sharma";
const NAME = "Rahul";
const OPENING = `Hello, am I speaking with ${FULL_NAME}?`;
const FIRST_EN =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. I'm calling to invite you to our free live webinar on 22nd September at 7:30 PM — ` +
  `"Launch Your Business Online in 10 Minutes" — where we show how to take a business online: the website, ` +
  `the products and the payments, all from a phone. Have you tried putting something online before?`;
const FIRST_HI =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. 22nd September ko 7:30 PM pe humara ek free live webinar hai — ` +
  `"Launch Your Business Online in 10 Minutes" — jisme hum dikhate hain business ko online kaise lete hain: ` +
  `website, products aur payments, sab phone se. Aapne pehle kabhi kuch online daalne ki try ki hai?`;
const DISCOVERY_EN = "Have you tried putting something online before?";
const DISCOVERY_HI = "Aapne pehle kabhi kuch online daalne ki try ki hai?";
const DISCOVERY_DEV = "आपने पहले कभी कुछ online डालने की try की है?";
const BRIDGE_EN = "You won't need any coding or design skills for this.";
const BRIDGE_HI = "Iske liye koi coding ya design skill nahi chahiye.";
const GATE_EN = "Would you like me to reserve your free seat?";
const GATE_HI = "Toh kya main aapki free seat reserve kar du?";
const YES_EN = `Perfect, ${NAME} — your free seat is reserved for 22nd September at 7:30 PM. Do join a few minutes early. Hope to see you there!`;
const YES_HI = `Perfect, ${NAME} — aapki free seat confirm ho gayi hai, 22nd September, 7:30 PM ke liye. Thoda pehle join kar lena. Hope to see you there!`;
const NO_BLOCK = `Okay, no problem at all. Thanks for your time, ${NAME}. Have a great day!`;
const ALREADY_EN = "Oh, that's great — then you're all set for 22nd September at 7:30 PM. Do join a few minutes early.";
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

test("A1. v12 is a registration script, approved, name-requiring, dated, and first after v6", () => {
  assert.equal(V12.version, "v12");
  assert.equal(V12.isPlaceholder, false);
  assert.equal(V12.requiresName, true);
  assert.equal(V12.eventAt, "2026-09-22T19:30:00+05:30");
  assert.equal(defaultScriptFor("registration").version, "v15", "v12 must not become the default");
  const registration = listScripts().filter((s) => s.campaignType === "registration").map((s) => s.version);
  // `registration v13` (the implementation session) and its sibling `v14`
  // (the same session for people who did NOT attend the two-day event)
  // were registered under v6 on 2026-09-22, exactly as v12 had been.
  // v12 moved two places down; nothing else about it changed. `v15` —
  // v6's workshop in the later conversation shape — then took the first
  // place, and everything below it moved down one more.
  assert.deepEqual(registration.slice(0, 6), ["v15", "v6", "v13", "v14", "v12", "v11"]);
  assert.deepEqual(scriptVariables(V12), ["agent_name", "customer_name"]);
});

test("A2. every earlier revision of this webinar is byte-identical to when it shipped", () => {
  // v11 was hand-edited on 2026-09-21 (first reply re-worded to "I am
  // calling to invite you", one Hinglish branch line) before any campaign
  // was pinned to it; this is the hash of the text as it now stands.
  assert.equal(hashScript(V11), "7e2694d3903d0c2cbff85ee326c8170032eaf533e8c5f711386ed7ef0dd80dd0");
  assert.equal(hashScript(findScript("registration", "v10")!), "156fe8b03462658372f3a695a56f28dc054d963e0e4c187ca030b77b340d4a8d");
  assert.equal(hashScript(findScript("registration", "v9")!), "db4da125d8f6ced980032d602a61a5450355bd644e710cdfce86f66f9a8be282");
  assert.equal(hashScript(findScript("registration", "v5")!), "86cd439509f902097656b0ec9093458279b920ad20562a4ed59aa111e5c9fc2b");
  for (const other of listScripts()) {
    if (other !== V12) assert.notEqual(hashScript(other), hashScript(V12));
  }
});

test("A3. preflight dials on the morning of the 22nd and refuses after 7:30 PM", () => {
  assert.equal(validateCampaignScript(validationFor(V12, new Date("2026-09-22T10:00:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V12, new Date("2026-09-22T19:31:00+05:30"))).ok, false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE SHAPE — ONE QUESTION ABOUT THEM, THEN THE SEAT, AND NOTHING ELSE");

test("B1. the body asks exactly one question before the seat question, in each rendering", () => {
  const beforeYes = BODY.slice(0, BODY.indexOf("[YES]"));
  const questions = beforeYes.match(/[^\n]*\?/gu) ?? [];
  // opening, first reply EN, first reply HI, gate EN, gate HI — five lines end in "?"
  assert.equal(questions.length, 5, `expected 5 question lines before [YES], found ${questions.length}`);
  assert.ok(beforeYes.includes(DISCOVERY_EN));
  assert.ok(beforeYes.includes(DISCOVERY_HI));
  assert.ok(beforeYes.includes(GATE_EN));
  assert.ok(beforeYes.includes(GATE_HI));
  // ...and the discovery and gate sit in the SAME two blocks v5 used.
  assert.ok(BODY.includes(`${BRIDGE_EN} ${GATE_EN}`), "the bridge runs straight into the gate, as in v5");
  assert.ok(BODY.includes(`${BRIDGE_HI} ${GATE_HI}`));
});

test("B2. the v9-v11 interview questions are gone, and the text forbids adding them back", () => {
  for (const dropped of [
    "are you already running a business", "what kind of business", "already have a website",
    "specific idea in mind", "kis type ka business", "koi website hai", "kuch specific idea",
    "planning to start something", "start karne ka plan",
  ]) {
    assert.ok(!FLAT.includes(dropped), `v12 must not ask "${dropped}"`);
  }
  assert.ok(FLAT.includes("do not add questions the script does not ask"));
  assert.ok(FLAT.includes("not what business they run, not whether they have a website, not what their idea is"));
  assert.ok(FLAT.includes("you are inviting them, not interviewing them"));
});

test("B3. no long turns — every block is short, and the text says so", () => {
  assert.ok(FLAT.includes("every turn is at most three short sentences and one question"));
  assert.ok(FLAT.includes("never describe the whole webinar in one go"));
  // The longest spoken block in the body, by sentence count.
  const blocks = BODY.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("[") && !l.includes("--- SCRIPT ---"));
  for (const block of blocks) {
    const spoken = block.replace(/^\s*In Hinglish:\s*/u, "");
    const sentences = spoken.split(/[.!?](?:\s|$)/u).filter((s) => s.trim().length > 0).length;
    assert.ok(sentences <= 4, `block runs to ${sentences} sentences: "${spoken.slice(0, 60)}…"`);
  }
});

test("B4. the discovery question is v5's, and the bridge and gate are v5's", () => {
  const v5 = findScript("registration", "v5")!;
  for (const carried of [DISCOVERY_EN, BRIDGE_EN, GATE_EN, "take it as an answer, say", "So you know the fiddly part", "Then this is a good place to start"]) {
    assert.ok(v5.systemPromptAppendix.includes(carried), `"${carried}" must come from v5`);
    assert.ok(APPENDIX.includes(carried), `"${carried}" must be in v12`);
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
      agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Yes, a bit."), agent(`${BRIDGE_EN} ${GATE_EN}`), caller(said),
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
  const { disposition } = settle([agent(OPENING), caller("Yes."), agent(`Hi ${NAME}. Would you like to attend?`), caller("Yes.")]);
  assert.equal(disposition, "FINAL_YES");
  assert.ok(FLAT.includes("not \"would you like to attend\", not \"do you want to attend\""));
  assert.ok(FLAT.includes("never bring it forward into the first reply"));
});

test("C6. the gate and the discovery question survive the speech formatter", () => {
  for (const line of [GATE_EN, GATE_HI, DISCOVERY_EN, DISCOVERY_HI, GOODBYE]) {
    assert.equal(formatForSpeech(line), line);
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. EVERY TERMINAL BRANCH ENDS THE CALL");

test("D1. YES: the registration commits at the yes, and the confirmation leaves FINAL_YES standing", () => {
  for (const [gate, yesBlock] of [[GATE_EN, YES_EN], [GATE_HI, YES_HI]] as const) {
    const t = [agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Yes."), agent(`${BRIDGE_EN} ${gate}`), caller("Yes, go ahead.")];
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
  const early = [agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("No, I'm not interested."), agent(NO_BLOCK)];
  assert.equal(definitiveAnswerIn(live(early), "registration"), "FINAL_NO");
  const hindi = [agent(OPENING), caller("Yes."), agent(FIRST_HI), caller("Nahi, mujhe interest nahi hai."), agent(`Okay, koi baat nahi. Thanks for your time, ${NAME}. Have a great day!`)];
  assert.equal(definitiveAnswerIn(live(hindi), "registration"), "FINAL_NO");
  const atGate = [agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Not really."), agent(`${BRIDGE_EN} ${GATE_EN}`), caller("No, not interested."), agent(NO_BLOCK)];
  assert.equal(definitiveAnswerIn(live(atGate), "registration"), "FINAL_NO");
  assert.equal(settle(atGate).disposition, "FINAL_NO");
});

test("D4. the goodbye is a recognised closing, with a first name or a full name after it", () => {
  for (const spoken of [NAME, FULL_NAME]) {
    const t = [agent(OPENING), caller("Yes."), agent(ALREADY_EN), caller("Okay, thanks."), agent(`Thanks for your time, ${spoken}. Have a great day!`)];
    assert.equal(agentClosedIn(live(t)), true);
  }
});

test("D5. ALREADY REGISTERED: no gate, no new registration, no refusal — settles UNRESOLVED", () => {
  const t = [agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("I've already registered for it."), agent(ALREADY_EN), caller("Okay."), agent(GOODBYE)];
  const { outcome, disposition } = settle(t);
  assert.equal(disposition, "UNRESOLVED");
  assert.equal(isFinalYes(outcome, disposition), false);
  assert.equal(agentClosedIn(live(t)), true);
  assert.ok(FLAT.includes("do not ask the seat question and do not take them through a registration again"));
});

// ═════════════════════════════════════════════════════════════════
section("E. THE NAME, THE FRAMING, THE FACTS");

test("E1. full name only in the opening and the identity sentences; [first name] everywhere after", () => {
  const afterConfirmation = BODY.slice(BODY.indexOf("[THEY CONFIRM"));
  assert.ok(BODY.startsWith("--- SCRIPT ---\n\nHello, am I speaking with {{customer_name}}?"));
  assert.ok(!afterConfirmation.includes("{{customer_name}}"));
  assert.equal(APPENDIX.split("{{customer_name}}").length - 1, 5, "header, identity, rule (2), opening");
  assert.ok(APPENDIX.split("[first name]").length - 1 >= 8);
  assert.ok(FLAT.includes("the first word of {{customer_name}}"));
});

test("E2. interpolated with a two-word name, the full name never follows Hi, Perfect or Thanks", () => {
  const context = buildCampaignContext({ script: V12, campaignId: "cmp_v12", campaignType: "registration", provider: "smallest-ai", customerName: FULL_NAME });
  assert.equal(context.openingLine, OPENING);
  const appendix = context.systemPromptAppendix.slice(0, context.systemPromptAppendix.indexOf("# HOW TO RUN THIS SCRIPT"));
  assert.equal(appendix.split(FULL_NAME).length - 1, 5);
  for (const bad of [`Hi ${FULL_NAME}`, `Perfect, ${FULL_NAME}`, `Thanks for your time, ${FULL_NAME}`]) {
    assert.ok(!appendix.includes(bad), `the prompt must not carry "${bad}"`);
  }
  assert.ok(!/\{\{/u.test(context.systemPromptAppendix));
  assert.ok(context.systemPromptAppendix.endsWith(CAMPAIGN_CONVERSATION_POLICY));
});

test("E3. invitation framing, never a reminder", () => {
  for (const reminder of ["shown interest", "interest show kiya", "still planning", "still want", "abhi bhi attend", "still interested", "signing up"]) {
    assert.ok(!FLAT.includes(reminder), `"${reminder}" must not survive`);
  }
  assert.ok(FLAT.includes("it is an invitation, not a follow-up"));
  assert.ok(FLAT.includes("never say or imply that they signed up, showed interest or decided anything before this call"));
});

test("E4. the facts, the 90-minute answer and the WhatsApp answer are v11's, character for character", () => {
  const slice = (s: CampaignScript, from: string, to: string) => {
    const t = s.systemPromptAppendix;
    return t.slice(t.indexOf(from), t.indexOf(to));
  };
  assert.equal(slice(V12, "- What it is: a free live webinar", "# THE THINGS PEOPLE ASK"), slice(V11, "- What it is: a free live webinar", "# THE THINGS PEOPLE ASK"));
  assert.equal(slice(V12, "- \"How long is it?\"", "- \"I'm busy right now.\""), slice(V11, "- \"How long is it?\"", "- \"I'm busy right now.\""));
  assert.ok(FLAT.includes("approximately 90 minutes ka session hai."));
  assert.ok(FLAT.includes("registration complete hone ke baad webinar ki details aapko whatsapp pe mil jaayengi."));
  assert.equal(FLAT.split("i'll send").length - 1, 1, "only inside its own prohibition");
});

test("E5. every FAQ the brief listed is still handled", () => {
  for (const asked of ["what is the webinar about", "i don't remember", "i'm not sure yet", "is it free", "do i need a laptop", "i don't know coding", "how long is it", "send me the details on whatsapp", "i'm busy", "i'm not interested", "i've already registered", "how much can i make"]) {
    assert.ok(FLAT.includes(asked), `the FAQ must handle "${asked}"`);
  }
});

test("E6. no internal machinery, tool or provider name, and no invented fact, is in the text", () => {
  for (const leak of [
    "classifier", "commit_anchors", "anchor", "final_yes", "final_no", "sheet", "pipeline", "tool name", "tool call",
    "function", "hangup", "watchdog", "disposition", "unresolved", "system prompt", "internal note",
    "vobiz", "plivo", "deepgram", "soniox", "sarvam", "cartesia", "smallest", "elevenlabs", "openai", "gpt", "gemma", "gemini", "google",
    "zoom", "₹", "lakh", "worth", "we guarantee", "is guaranteed", "saurabh", "karthik", "i will send", "hum bhej", "whatsapp pe bhej",
  ]) {
    assert.ok(!FLAT.includes(leak), `the appendix must not contain "${leak}"`);
  }
  for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
    assert.ok(!FLAT.includes(banned));
  }
});

test("E7. a campaign pinned to v12 refuses to run if the words are edited, and a nameless contact cannot be called", () => {
  const edited: CampaignScript = { ...V12, systemPromptAppendix: `${V12.systemPromptAppendix} ` };
  assert.throws(
    () => buildCampaignContext({ script: edited, campaignId: "c", campaignType: "registration", provider: "smallest-ai", customerName: NAME, expectedScriptHash: hashScript(V12) }),
    /has changed since this campaign was created/u,
  );
  assert.throws(
    () => buildCampaignContext({ script: V12, campaignId: "c", campaignType: "registration", provider: "smallest-ai", customerName: "  " }),
    /needs the contact's name/u,
  );
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
