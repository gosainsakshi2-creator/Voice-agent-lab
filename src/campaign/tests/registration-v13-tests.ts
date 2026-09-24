/**
 * registration-v13-tests.ts — `npm run test:registration-v13`
 *
 * THE IMPLEMENTATION SESSION SCRIPT: ATTENDEES ONLY, v12'S SHAPE.
 *
 * v13 invites the people who attended the two-day AI Income Blueprint
 * event to its implementation session, tonight at 8 PM. It reuses v12's
 * two-exchange shape wholesale, so beyond the checks every script of this
 * family gets — the gate registers, nothing before it does, every
 * terminal branch ends the call, no leak, no invented fact — this suite
 * pins the three things that are NEW and could therefore go wrong:
 *
 *   - the discovery question is not v12's and had to be re-proved safe in
 *     both directions and both renderings (section C);
 *   - "you were at our two-day event" is allowed while "you'd shown
 *     interest" is still forbidden — a distinction one careless edit
 *     collapses (section E);
 *   - the session is attendees-only, so "I didn't attend" must not
 *     register anyone (section D).
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

const V13 = findScript("registration", "v13");
assert.ok(V13, "registration v13 must be registered before this suite can run");
const V12 = findScript("registration", "v12");
assert.ok(V12, "registration v12 must still be registered — v13 keeps its shape");

const APPENDIX = V13.systemPromptAppendix;
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");
const BODY = APPENDIX.slice(APPENDIX.indexOf("--- SCRIPT ---"));

// ── The lines this campaign actually speaks ──────────────────────
const FULL_NAME = "Rahul Sharma";
const NAME = "Rahul";
const OPENING = `Hello, am I speaking with ${FULL_NAME}?`;
const FIRST_EN =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. You were at our two-day AI Income Blueprint event, and tonight ` +
  `at 8 we're doing the implementation session — where we set your funnel up live, on your own screen. ` +
  `Have you had a chance to start setting anything up since the event?`;
const FIRST_HI =
  `Hi ${NAME}, I'm Ishita from FlexiFunnels. Aap humare do din ke AI Income Blueprint event mein the — aaj ` +
  `raat 8 baje uska implementation session hai, jisme hum aapka funnel live set up karte hain, aapki hi ` +
  `screen pe. Event ke baad aapne kuch setup karna shuru kiya hai?`;
const DISCOVERY_EN = "Have you had a chance to start setting anything up since the event?";
const DISCOVERY_HI = "Event ke baad aapne kuch setup karna shuru kiya hai?";
const DISCOVERY_DEV = "इवेंट के बाद आपने कुछ setup करना शुरू किया है?";
const BRIDGE_EN =
  "It's free for everyone who came to the two days, and reserving also extends your free tool access by two more days.";
const BRIDGE_HI =
  "Jo log do din wale event mein the, unke liye ye free hai, aur reserve karne pe free tool access do din aur badh jaata hai.";
const GATE_EN = "Would you like me to reserve your free seat?";
const GATE_HI = "Toh kya main aapki free seat reserve kar du?";
const YES_EN =
  `Perfect, ${NAME} — your free seat is reserved for tonight at 8 PM, and your free tool access gets the ` +
  `two extra days. Do join a few minutes early. Hope to see you there!`;
const YES_HI =
  `Perfect, ${NAME} — aapki free seat confirm ho gayi hai, aaj raat 8 baje ke liye, aur tool access ke do ` +
  `extra din bhi. Thoda pehle join kar lena. Hope to see you there!`;
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

test("A1. v13 is a registration script, approved, name-requiring, dated, and first after v6", () => {
  assert.equal(V13.version, "v13");
  assert.equal(V13.isPlaceholder, false);
  assert.equal(V13.requiresName, true);
  assert.equal(V13.eventAt, "2026-09-22T20:00:00+05:30");
  assert.equal(defaultScriptFor("registration").version, "v15", "v13 must not become the default");
  const registration = listScripts().filter((s) => s.campaignType === "registration").map((s) => s.version);
  // `registration v15` — v6's workshop in the later conversation shape —
  // took the first place, so v13 sits one lower than when it shipped.
  // `registration v16` — v15's call with its Hinglish written in
  // Devanagari — sits directly under v15 since 2026-09-24, registered
  // but deliberately not the default, so everything below moved once more.
  assert.deepEqual(registration.slice(0, 6), ["v15", "v16", "v6", "v13", "v14", "v12"]);
  assert.deepEqual(scriptVariables(V13), ["agent_name", "customer_name"]);
});

test("A2. v13 is a new version — every earlier one keeps its hash", () => {
  assert.equal(hashScript(V12), "cdb8d78c2f3acf8b98fabaf35afd3780e1dca4f72c7e7af4278c88427c731bb9");
  for (const other of listScripts()) {
    if (other !== V13) assert.notEqual(hashScript(other), hashScript(V13));
  }
});

test("A3. preflight dials through the day of the 22nd and refuses after 8 PM", () => {
  assert.equal(validateCampaignScript(validationFor(V13, new Date("2026-09-22T10:00:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V13, new Date("2026-09-22T19:45:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V13, new Date("2026-09-22T20:01:00+05:30"))).ok, false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE SHAPE — v12'S, AND NO LONG TURNS");

test("B1. the body asks exactly one question before the seat question, in each rendering", () => {
  const beforeYes = BODY.slice(0, BODY.indexOf("[YES]"));
  const questions = beforeYes.match(/[^\n]*\?/gu) ?? [];
  // opening, first reply EN, first reply HI, gate EN, gate HI — five lines end in "?"
  assert.equal(questions.length, 5, `expected 5 question lines before [YES], found ${questions.length}`);
  assert.ok(beforeYes.includes(DISCOVERY_EN));
  assert.ok(beforeYes.includes(DISCOVERY_HI));
  assert.ok(beforeYes.includes(GATE_EN));
  assert.ok(beforeYes.includes(GATE_HI));
  // ...and the bridge runs straight into the gate, as in v5 and v12.
  assert.ok(BODY.includes(`${BRIDGE_EN} ${GATE_EN}`), "the bridge runs straight into the gate");
  assert.ok(BODY.includes(`${BRIDGE_HI} ${GATE_HI}`));
});

test("B2. no interview questions, and the text forbids adding them back", () => {
  for (const dropped of [
    "are you already running a business", "what kind of business", "already have a website",
    "specific idea in mind", "kis type ka business", "koi website hai", "kuch specific idea",
    "which day did you", "kaunse din aaye", "did you attend day",
  ]) {
    assert.ok(!FLAT.includes(dropped), `v13 must not ask "${dropped}"`);
  }
  assert.ok(FLAT.includes("do not add questions the script does not ask"));
  assert.ok(FLAT.includes("not which day of the event they came to"));
  assert.ok(FLAT.includes("you are inviting them, not interviewing them"));
});

test("B3. no long turns — every block is short, and the text says so", () => {
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

test("B4. the gate, the [NO] block and the two-turn goodbye are v12's, word for word", () => {
  for (const carried of [
    GATE_EN, GATE_HI, "Okay, no problem at all.", "Do join a few minutes early.",
    "take it as an answer, say", "Add nothing to it. Do not invent a benefit",
  ]) {
    assert.ok(V12.systemPromptAppendix.includes(carried), `"${carried}" must come from v12`);
    assert.ok(APPENDIX.includes(carried), `"${carried}" must be in v13`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. THE GATE REGISTERS, THE NEW DISCOVERY QUESTION DOES NOT");

test("C1. a yes at the gate is confirmed_at_gate, FINAL_YES and sheet-eligible, in both renderings", () => {
  for (const [first, said, bridge, gate, yes, yesBlock] of [
    [FIRST_EN, "Yes, I made a page already.", BRIDGE_EN, GATE_EN, "Yes please.", YES_EN],
    [FIRST_EN, "No, not yet.", BRIDGE_EN, GATE_EN, "Sure.", YES_EN],
    [FIRST_HI, "Nahi, abhi tak nahi.", BRIDGE_HI, GATE_HI, "Haan ji.", YES_HI],
    [FIRST_HI, "Haan, ek page bana liya tha.", BRIDGE_HI, GATE_HI, "Bilkul, kar do.", YES_HI],
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
      agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("A little bit."),
      agent(`${BRIDGE_EN} ${GATE_EN}`), caller(said),
    ]);
    assert.notEqual(disposition, "FINAL_YES");
    assert.equal(isFinalYes(outcome, disposition), false);
  }
});

test("C3. YES or NO to the new discovery question registers nobody and declines nobody", () => {
  for (const first of [FIRST_EN, FIRST_HI, `Hi ${NAME}. ${DISCOVERY_DEV}`]) {
    for (const said of ["Yes.", "Haan.", "Haan ji.", "Yes, I built one page.", "Bilkul.", "हाँ।"]) {
      const { outcome, disposition } = settle([agent(OPENING), caller("Yes."), agent(first), caller(said)]);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" to the discovery question must not register`);
      assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
    }
    for (const said of ["No.", "Nahi.", "No, nothing yet.", "Nahi, time hi nahi mila."]) {
      const { outcome } = settle([agent(OPENING), caller("Yes."), agent(first), caller(said)]);
      assert.notEqual(outcome.primaryReason, "declined_at_gate", `"${said}" answers a question about THEM`);
    }
  }
});

test("C4. the bridge alone — the tool-access sentence — commits nobody", () => {
  for (const said of ["Yes.", "Haan.", "Okay.", "Achha."]) {
    const { outcome, disposition } = settle([
      agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Not yet."), agent(BRIDGE_EN), caller(said),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${said}" to the bridge alone must not register`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

test("C5. the identity answer is not a registration either", () => {
  for (const said of ["Yes.", "Haan ji.", "Speaking."]) {
    const { disposition } = settle([agent(OPENING), caller(said)]);
    assert.notEqual(disposition, "FINAL_YES");
  }
});

test("C6. the forbidden early forms really would register — which is why the text forbids them", () => {
  const { disposition } = settle([
    agent(OPENING), caller("Yes."), agent(`Hi ${NAME}. Would you like to attend?`), caller("Yes."),
  ]);
  assert.equal(disposition, "FINAL_YES");
  assert.ok(FLAT.includes("not \"would you like to attend\", not \"do you want to attend\""));
  assert.ok(FLAT.includes("not \"will you join us live\""));
  assert.ok(FLAT.includes("never bring it forward into the first reply"));
});

test("C7. every fixed line survives the speech formatter unchanged", () => {
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
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Not yet."),
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

test("D6. ATTENDEES ONLY: 'I didn't attend' is never taken through a registration", () => {
  assert.ok(FLAT.includes("i didn't attend the two days."));
  assert.ok(
    FLAT.includes("do not ask the seat question and do not register them"),
    "the non-attendee branch must forbid the gate outright",
  );
  assert.ok(FLAT.includes("i'd rather not promise you a seat on it"));
  // ...and coming to only part of it still counts as attending.
  assert.ok(FLAT.includes("they attended: carry on with the script as normal"));

  // THE GOODBYE IS ITS OWN TURN, and the branch says so because it has
  // to be. `agentClosedIn` caps a closing at 12 words, so the honest
  // sentence and the sign-off run together — "…so I'd rather not promise
  // you a seat on it. Thanks for your time, Rahul. Have a great day!" —
  // is 28 words and reads as mid-conversation: the line then stays open
  // until the silence watchdog ends it. Split, the same words hang up.
  const honest = "Ah, this one is for the people who were at the two days, so I'd rather not promise you a seat on it.";
  const together = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("I didn't attend the event actually."),
    agent(`${honest} ${GOODBYE}`),
  ];
  assert.equal(agentClosedIn(live(together)), false, "one long turn is not a recognised closing");
  assert.ok(FLAT.includes("never run the honest sentence and the goodbye together into one long turn"));

  const split = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("I didn't attend the event actually."),
    agent(honest), caller("Oh, okay."), agent(GOODBYE),
  ];
  assert.equal(agentClosedIn(live(split)), true);
  assert.notEqual(settle(split).disposition, "FINAL_YES");
  assert.equal(isFinalYes(settle(split).outcome, settle(split).disposition), false);
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
  const context = buildCampaignContext({
    script: V13, campaignId: "cmp_v13", campaignType: "registration",
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

test("E3. the two days may be referred to; manufactured interest may not", () => {
  // THE ONE THING v13 is allowed to say that v12 forbade.
  assert.ok(FLAT.includes("you were at our two-day event"));
  assert.ok(FLAT.includes("this person attended the two-day ai income blueprint event"));
  for (const invented of [
    "shown interest", "interest show kiya", "you asked about", "you had asked",
    "still planning", "still want", "abhi bhi attend", "still interested", "as discussed",
  ]) {
    assert.ok(!FLAT.includes(invented), `"${invented}" must not survive`);
  }
  assert.ok(
    FLAT.includes(
      "never say or imply that they asked about this session, showed interest in it, signed up for it, or decided anything about it before this call",
    ),
  );
});

test("E4. every fact in the text is on the landing page, and the unstated ones route to 'I don't know'", () => {
  for (const sourced of [
    "8 pm ist", "tuesday 22nd september", "live and online", "completely free, for the people who attended",
    "170-plus actions inside flexi genie", "extends their free tool access by 2 more days",
    "seats are limited", "flexi genie and the flexifunnels mcp", "live q&a",
    "lead forms that capture leads and checkouts that take payments",
    "nothing moves on until theirs works too",
  ]) {
    assert.ok(FLAT.includes(sourced), `the sourced fact "${sourced}" must be in the text`);
  }
  // The page states none of these, so the script must not either.
  assert.ok(FLAT.includes("how long the session runs, which platform it is on, who is presenting, whether there is a recording"));
  for (const unstated of ["90 minute", "60 minute", "two hour", "recording will", "replay will"]) {
    assert.ok(!FLAT.includes(unstated), `"${unstated}" is not on the page — it must not be asserted`);
  }
});

test("E5. the FAQ answers what this audience actually asks", () => {
  for (const asked of [
    "what is this session about", "how is it different from the two days", "i don't remember this",
    "i'm not sure yet", "is it free", "i didn't attend the two days", "what is flexi genie",
    "what is the mcp", "do i need a laptop", "do you need my email",
    "send me the details on whatsapp", "i'm busy", "i'm not interested",
    "i've already registered", "how much can i make",
  ]) {
    assert.ok(FLAT.includes(asked), `the FAQ must handle "${asked}"`);
  }
  assert.ok(FLAT.includes("registration complete hone ke baad session ki details aapko whatsapp pe mil jaayengi."));
  assert.equal(FLAT.split("i'll send").length - 1, 1, "only inside its own prohibition");
  assert.ok(FLAT.includes("never ask them for an email address"));
});

test("E6. no internal machinery, tool or provider name, and no invented fact, is in the text", () => {
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

test("E7. a campaign pinned to v13 refuses to run if the words are edited, and a nameless contact cannot be called", () => {
  const edited: CampaignScript = { ...V13, systemPromptAppendix: `${V13.systemPromptAppendix} ` };
  assert.throws(
    () => buildCampaignContext({
      script: edited, campaignId: "c", campaignType: "registration",
      provider: "smallest-ai", customerName: NAME, expectedScriptHash: hashScript(V13),
    }),
    /has changed since this campaign was created/u,
  );
  assert.throws(
    () => buildCampaignContext({
      script: V13, campaignId: "c", campaignType: "registration",
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
