/**
 * registration-v15-tests.ts — `npm run test:registration-v15`
 *
 * v6's WORKSHOP, v14's SHAPE, AND NOW THE DEFAULT.
 *
 * `registration v15` is the first script since v6 that a campaign
 * created without naming one actually dials, so this suite asks two
 * questions of it rather than one:
 *
 *   - did the SHAPE arrive intact — identity-first opening, the first
 *     name after it, one Hinglish line per English line, no turn past
 *     three sentences, an "already registered" branch, and a sign-off
 *     short enough to be read as one (sections B and D);
 *   - did the FACTS survive the rewrite unchanged — every fact v6
 *     stated, no figure v6 did not state, and the gate and the
 *     discovery question word for word (sections C and E).
 *
 * v6 IS ASSERTED UNCHANGED, by hash. v15 exists precisely so that v6
 * did not have to be edited; this file existing must not move it.
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

const V15 = findScript("registration", "v15");
assert.ok(V15, "registration v15 must be registered before this suite can run");
const V6 = findScript("registration", "v6");
assert.ok(V6, "registration v6 must still be registered — v15 is its successor, not its editor");
const V14 = findScript("registration", "v14");
assert.ok(V14, "registration v14 must still be registered — v15 borrows its shape");

const APPENDIX = V15.systemPromptAppendix;
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");
const BODY = APPENDIX.slice(APPENDIX.indexOf("--- SCRIPT ---"));
const HEAD = APPENDIX.slice(0, APPENDIX.indexOf("--- SCRIPT ---"));

// ── The lines this campaign actually speaks ──────────────────────
const FULL_NAME = "Rahul Sharma";
const NAME = "Rahul";
const OPENING = `Hello, am I speaking with ${FULL_NAME}?`;
const FIRST_EN =
  `Hi ${NAME}, I'm Ishita from Team FlexiFunnels. I'm calling to invite you to a free live workshop ` +
  `on Sunday, 4th October at 11 AM. We'll build a complete online business live — the website, ` +
  `the product, checkout and payments — all from a phone. ` +
  `Have you tried putting something online before?`;
const FIRST_HI =
  `Hi ${NAME}, main Ishita, Team FlexiFunnels se. Sunday, 4th October ko 11 AM par humara ek free ` +
  `live workshop hai, jisme hum ek poora online business live banate hain — website, product, ` +
  `checkout aur payments — sab ek phone se. Aapne pehle kabhi kuch online daalne ki try ki hai?`;
const DISCOVERY_EN = "Have you tried putting something online before?";
const DISCOVERY_HI = "Aapne pehle kabhi kuch online daalne ki try ki hai?";
const DISCOVERY_DEV = "आपने पहले कभी कुछ online डालने की try की है?";
const BRIDGE_EN = "You won't need any coding or design skills for this.";
const BRIDGE_HI = "Iske liye koi coding ya design skill nahi chahiye.";
const GATE_EN = "Would you like me to reserve your free seat?";
const GATE_HI = "Toh kya main aapki free seat reserve kar du?";
const YES_EN =
  `Perfect, ${NAME} — your free seat is reserved for Sunday, 4th October at 11 AM, and the joining ` +
  `details will come to you on WhatsApp and email. If you join live you also get the ` +
  `Launch-In-A-Day Starter Kit worth ₹1,50,000+, a live Q&A session and a special reveal at the ` +
  `end. Hope to see you there!`;
const YES_HI =
  `Perfect, ${NAME} — aapki free seat Sunday, 4th October, 11 AM ke liye reserve ho gayi hai, aur ` +
  `joining details aapko WhatsApp aur email pe mil jaayengi. Live join karenge toh ` +
  `Launch-In-A-Day Starter Kit bhi milega, worth ₹1,50,000+, ek live Q&A session aur end mein ek ` +
  `special reveal. Hope to see you there!`;
const NO_BLOCK = `Okay, no problem at all. Thanks for your time, ${NAME}.`;
const ALREADY_EN =
  `Oh, that's great — then you're all set for Sunday, 4th October at 11 AM. Do join a few minutes early.`;
const GOODBYE = `Thanks for your time, ${NAME}.`;

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
section("A. REGISTERED, DATED, AND THE DEFAULT");

test("A1. v15 is a registration script, approved, name-requiring, dated, and listed first", () => {
  assert.equal(V15.version, "v15");
  assert.equal(V15.isPlaceholder, false, "a placeholder script may never be the default");
  assert.equal(V15.requiresName, true, "the identity opening needs the name");
  assert.equal(V15.eventAt, "2026-10-04T11:00:00+05:30", "v6's workshop, so v6's instant");
  assert.equal(V15.eventAt, V6.eventAt);
  assert.equal(defaultScriptFor("registration").version, "v15", "v15 IS the default");
  assert.equal(defaultScriptFor("reminder").version, "v2", "the reminder default is untouched");
  const registration = listScripts().filter((s) => s.campaignType === "registration").map((s) => s.version);
  // v16 sits directly under it — v15's successor, the same call with
  // its Hinglish written in Devanagari, registered but deliberately NOT
  // the default until somebody has heard it. v6 follows: the same
  // workshop, kept for the campaigns pinned to its hash.
  assert.deepEqual(registration.slice(0, 6), ["v15", "v16", "v6", "v13", "v14", "v12"]);
  assert.deepEqual(scriptVariables(V15), ["agent_name", "customer_name"]);
});

test("A2. v6 IS UNCHANGED — v15 exists so that it did not have to be edited", () => {
  assert.equal(hashScript(V6), "de8aede9568acfae24cf84762fc807eeef7362b659f2685c82a87ee58859cb3f");
  assert.equal(
    V6.openingLineTemplate,
    "Hello, this is {{agent_name}} from Team FlexiFunnels.",
    "v6's spoken opening must stay exactly as approved",
  );
  for (const other of listScripts()) {
    if (other !== V15) assert.notEqual(hashScript(other), hashScript(V15));
  }
});

test("A3. preflight dials up to the workshop and refuses once it has started", () => {
  assert.equal(validateCampaignScript(validationFor(V15, new Date("2026-09-23T10:00:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V15, new Date("2026-10-04T10:59:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V15, new Date("2026-10-04T11:01:00+05:30"))).ok, false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE SHAPE — IDENTITY FIRST, TWO EXCHANGES, TWO LANGUAGES");

test("B1. the opening ASKS who picked up — it does not introduce the agent", () => {
  // The same sentence `IDENTITY_LINE_TEMPLATE` produces, with "Hello, "
  // in front, so `openingLineAsksIdentity` sees it and the identity gate
  // is never asked a second time. v6 opened with the introduction, which
  // is how the question came to be asked twice on a live call.
  assert.equal(V15.openingLineTemplate, "Hello, am I speaking with {{customer_name}}?");
  assert.ok(BODY.startsWith("--- SCRIPT ---\n\nHello, am I speaking with {{customer_name}}?"));
  assert.ok(!V15.openingLineTemplate.includes("{{agent_name}}"), "the introduction waits for the first reply");
  assert.ok(FLAT.includes("never check who they are or ask their name"));
  assert.ok(FLAT.includes("introduce yourself once, there, and never again"));
});

test("B2. the body asks exactly one question before the seat question, in each rendering", () => {
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

test("B3. THE APPENDIX AND THE BODY AGREE — the drift that broke v12's own B1", () => {
  for (const line of [DISCOVERY_EN, DISCOVERY_HI, GATE_EN, GATE_HI, BRIDGE_EN, BRIDGE_HI]) {
    assert.ok(BODY.includes(line), `the body must speak "${line}"`);
    assert.ok(HEAD.replace(/\s+/gu, " ").includes(line), `the instruction must quote "${line}"`);
  }
  assert.ok(!FLAT.includes("daalne ka try kra hai"), "v12's hand-edited variant must not appear");
  assert.equal(FLAT.split("daalne ki try ki hai").length - 1, 2, "once in the instruction, once in the body");
});

test("B4. no long turns — every block is short, and the text says so", () => {
  assert.ok(FLAT.includes("every turn is at most three short sentences and one question"));
  assert.ok(FLAT.includes("never describe the whole workshop in one go"));
  const blocks = BODY.split("\n").filter(
    (l) => l.trim().length > 0 && !l.trim().startsWith("[") && !l.includes("--- SCRIPT ---"),
  );
  for (const block of blocks) {
    const spoken = block.replace(/^\s*In Hinglish:\s*/u, "");
    const sentences = spoken.split(/[.!?](?:\s|$)/u).filter((s) => s.trim().length > 0).length;
    assert.ok(sentences <= 4, `block runs to ${sentences} sentences: "${spoken.slice(0, 60)}…"`);
  }
});

test("B5. no interview questions, and the text forbids adding them back", () => {
  for (const dropped of [
    "are you already running a business", "what kind of business", "already have a website",
    "specific idea in mind", "kis type ka business", "koi website hai",
  ]) {
    assert.ok(!FLAT.includes(dropped), `v15 must not ask "${dropped}"`);
  }
  assert.ok(FLAT.includes("do not add questions the script does not ask"));
  assert.ok(FLAT.includes("you are inviting them, not interviewing them"));
});

test("B6. every fixed line survives the speech formatter unchanged", () => {
  for (const line of [
    OPENING, FIRST_EN, FIRST_HI, GATE_EN, GATE_HI, DISCOVERY_EN, DISCOVERY_HI,
    BRIDGE_EN, BRIDGE_HI, YES_EN, YES_HI, NO_BLOCK, ALREADY_EN, GOODBYE,
  ]) {
    assert.equal(formatForSpeech(line), line);
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
    assert.ok(!yesBlock.includes("?"), "the confirmation must not hand back a question");
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
  const atGate = [
    agent(OPENING), caller("Yes."), agent(FIRST_EN), caller("Not really."),
    agent(`${BRIDGE_EN} ${GATE_EN}`), caller("No, not interested."), agent(NO_BLOCK),
  ];
  assert.equal(definitiveAnswerIn(live(atGate), "registration"), "FINAL_NO");
  assert.equal(settle(atGate).disposition, "FINAL_NO");
  assert.ok(FLAT.includes("at any point in the call"), "the [NO] branch is not only the gate's");
});

test("D4. the sign-off is SHORT enough to be read as one — the cap v14 shortened for", () => {
  // `AGENT_CLOSING_MAX_WORDS` is 12. A longer goodbye is not recognised,
  // no AGENT_CLOSED verdict is produced, and the call hangs on the
  // silence window instead of closing.
  for (const spoken of [NAME, FULL_NAME]) {
    const closing = `Thanks for your time, ${spoken}.`;
    const t = [agent(OPENING), caller("Yes."), agent(ALREADY_EN), caller("Okay, thanks."), agent(closing)];
    assert.equal(agentClosedIn(live(t)), true, `"${closing}" must read as a closing`);
  }
  for (const block of [NO_BLOCK, GOODBYE]) {
    assert.ok(block.split(/\s+/u).length <= 12, `"${block}" is past the 12-word sign-off cap`);
  }
  assert.equal(agentClosedIn(live([agent(OPENING), caller("Yes."), agent(NO_BLOCK)])), true);
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
section("E. v6'S FACTS, ALL OF THEM, AND NOT ONE MORE");

test("E1. every fact v6 stated is still stated", () => {
  // The same list `event-date-tests` B4 holds v6 to. A rewrite that
  // quietly drops the bonus, the channels or the phone claim changes the
  // offer, not the wording.
  for (const required of [
    "free live workshop", "sunday", "11 am", "complete online business", "from a phone",
    "website", "product", "checkout", "payments", "coding", "design skills",
    "reserve your free seat", "whatsapp and email", "launch-in-a-day starter kit",
    "1,50,000", "live q&a session", "special reveal",
    "have you tried putting something online before",
    "registration is completely free",
  ]) {
    assert.ok(FLAT.includes(required.toLowerCase()), `v15 must still carry "${required}"`);
  }
});

test("E2. no figure v6 never stated, and only one event date", () => {
  const figures = (t: string) => new Set((t.match(/\d[\d.,:]*/gu) ?? []).map((f) => f.replace(/\D+/gu, "")));
  const v6Figures = figures(V6.systemPromptAppendix);
  for (const figure of figures(APPENDIX)) {
    assert.ok(v6Figures.has(figure), `v15 states a figure v6 never did: ${figure}`);
  }
  const dates = [
    ...APPENDIX.matchAll(
      /(\d{1,2})(?:st|nd|rd|th)? (January|February|March|April|May|June|July|August|September|October|November|December)/g,
    ),
  ];
  assert.ok(dates.length >= 2, "the date must appear in both the pitch and the facts");
  const unique = new Set(dates.map((m) => `${m[1]} ${m[2]}`));
  assert.equal(unique.size, 1, `v15 states more than one event date: ${[...unique].join(" / ")}`);
  assert.equal([...unique][0], "4 October");
});

test("E3. the gate and the discovery question are byte-identical to v6's", () => {
  for (const line of [GATE_EN, DISCOVERY_EN, BRIDGE_EN]) {
    assert.ok(V6.systemPromptAppendix.includes(line), `v6 baseline: "${line}"`);
    assert.ok(APPENDIX.includes(line), `v15 must not re-word: "${line}"`);
  }
  // And the branch lines the two exchanges hang on, carried from v6.
  for (const carried of [
    "So you know the fiddly part", "Then this is a good place to start",
    "take it as an answer",
  ]) {
    assert.ok(V6.systemPromptAppendix.includes(carried), `"${carried}" must come from v6`);
    assert.ok(APPENDIX.includes(carried), `"${carried}" must be in v15`);
  }
});

test("E4. the FAQ answers what v6's FAQ answered, and claims nothing about the company", () => {
  for (const asked of [
    "is it free", "do i need a laptop", "when is it", "i don't know coding",
    "how do i join", "do you need my email", "send me the details on whatsapp",
    "i'm busy right now", "i'm not interested", "i've already registered",
  ]) {
    assert.ok(FLAT.includes(asked), `the FAQ must handle "${asked}"`);
  }
  assert.ok(FLAT.includes("never name any individual"), "the live Q&A has no presenter named");
  assert.ok(FLAT.includes("do not describe the company beyond that"));
  // v14's session facts are a different event's and must not leak in.
  // NOTE: "funnel" is deliberately absent from this list — "flexifunnels"
  // contains it, so a flat substring ban would fail on the company name.
  for (const other of [
    "flexi genie", "170-plus", "implementation session", "ai income blueprint",
    "two-day", "8 pm", "seats are limited",
  ]) {
    assert.ok(!FLAT.includes(other), `"${other}" is another script's fact — it must not be in v15`);
  }
});

test("E5. INVITATION FRAMING — no manufactured history, and no invented extra", () => {
  for (const invented of [
    "shown interest", "you asked about", "you had asked", "still interested",
    "as discussed", "you signed up", "you registered earlier",
  ]) {
    assert.ok(!FLAT.includes(invented), `"${invented}" must not survive`);
  }
  assert.ok(FLAT.includes("it is an invitation, not a follow-up"));
  assert.ok(FLAT.includes("never say or imply that they signed up, showed interest or decided anything before this call"));
  assert.ok(FLAT.includes("i don't have that detail with me, so i'd rather not guess"));
});

test("E6. the bonus is promised WITHOUT the phrase that is itself a commit anchor", () => {
  // `COMMIT_ANCHORS.registration` carries "attend live". v6 says it in
  // the [YES] block only, after the gate has settled, so it cost nothing
  // there. Here the bonus is also a fact the agent may be asked for
  // BEFORE the gate, and the phrase would turn the next "haan" into a
  // registration for somebody who has been asked nothing.
  assert.ok(
    V6.systemPromptAppendix.toLowerCase().includes("attend live"),
    "v6 must still say it, or this test is asserting nothing",
  );
  assert.ok(!FLAT.includes("attend live"), "v15 must not carry the anchor phrase");
  assert.ok(FLAT.includes("if you join live you also get the launch-in-a-day starter kit"));
  // The whole [YES] block, spoken with no gate before it, registers nobody.
  for (const block of [YES_EN, YES_HI]) {
    const { outcome } = settle([agent(OPENING), caller("Yes."), agent(block), caller("Okay.")]);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `"${block.slice(0, 40)}…" is not a gate`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("F. THE NAME, THE PROMPT, AND NO LEAK");

test("F1. full name only in the opening and the identity sentences; [first name] everywhere after", () => {
  const afterConfirmation = BODY.slice(BODY.indexOf("[THEY CONFIRM"));
  assert.ok(!afterConfirmation.includes("{{customer_name}}"));
  assert.equal(APPENDIX.split("{{customer_name}}").length - 1, 5, "header, identity, rule (2), opening");
  assert.ok(APPENDIX.split("[first name]").length - 1 >= 8);
  assert.ok(FLAT.includes("the first word of {{customer_name}}"));
});

test("F2. interpolated with a two-word name, the full name never follows Hi, Perfect or Thanks", () => {
  const context = buildCampaignContext({
    script: V15, campaignId: "cmp_v15", campaignType: "registration",
    provider: "smallest-ai", customerName: FULL_NAME,
  });
  assert.equal(context.openingLine, OPENING);
  assert.equal(context.identityLine, `Am I speaking with ${FULL_NAME}?`);
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

test("F3. no internal machinery, tool or provider name is in the text", () => {
  for (const leak of [
    "classifier", "commit_anchors", "final_yes", "final_no", "pipeline", "tool call",
    "hangup", "watchdog", "disposition", "unresolved", "system prompt", "internal note",
    "vobiz", "plivo", "deepgram", "soniox", "sarvam", "cartesia", "smallest", "elevenlabs",
    "openai", "gpt", "gemma", "gemini",
    "zoom", "we guarantee", "is guaranteed", "guaranteed income",
  ]) {
    assert.ok(!FLAT.includes(leak), `the appendix must not contain "${leak}"`);
  }
  for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
    assert.ok(!FLAT.includes(banned));
  }
});

test("F4. a campaign pinned to v15 refuses to run if the words are edited, and a nameless contact cannot be called", () => {
  const edited: CampaignScript = { ...V15, systemPromptAppendix: `${V15.systemPromptAppendix} ` };
  assert.throws(
    () => buildCampaignContext({
      script: edited, campaignId: "c", campaignType: "registration",
      provider: "smallest-ai", customerName: NAME, expectedScriptHash: hashScript(V15),
    }),
    /has changed since this campaign was created/u,
  );
  assert.throws(
    () => buildCampaignContext({
      script: V15, campaignId: "c", campaignType: "registration",
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
