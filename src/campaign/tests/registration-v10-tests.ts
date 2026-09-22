/**
 * registration-v10-tests.ts — `npm run test:registration-v10`
 *
 * THE "LAUNCH YOUR BUSINESS ONLINE IN 10 MINUTES" WEBINAR SCRIPT,
 * HELD AGAINST THE REAL READERS.
 *
 * ── What this suite proves ───────────────────────────────────────
 *
 * v10 asks more questions before the seat question than any script
 * before it — is this still on, do you run a business, what kind, is
 * there a website, is there an idea — and the whole safety argument for
 * that is that NONE of them is a gate. Section D therefore runs every
 * one of them, in both renderings, through the real `classifyOutcome`
 * in BOTH directions: a yes registers nobody, a no declines nobody.
 *
 * Section C is the opposite half: the gate, in English and in the
 * approved Hinglish, must settle `confirmed_at_gate` / FINAL_YES /
 * sheet-eligible, or the campaign records no registrations at all.
 *
 * Section E is the ending: every terminal branch must actually end the
 * call, through the live readers the watchdog uses — `definitiveAnswerIn`
 * / `liveRegistrationReading` for a yes or an explicit no, and
 * `agentClosedIn` for the goodbye — and the confirmation after a yes must
 * not read as a second gate.
 *
 * ── What it cannot prove ─────────────────────────────────────────
 *
 * What a language model chooses to say on a live call. Every assertion
 * here is about the INSTRUCTION and the READERS, which are deterministic.
 * The branch wording the model will actually produce is a distribution;
 * one sample would prove nothing (see the A/B note in
 * `conversation-policy.ts`).
 *
 * NO NETWORK, NO DATABASE, NO VENDOR. Every module is the real one. The
 * call-runner import reaches no provider and dials nothing — it is the
 * same pure reader the agent-hangup and post-registration suites use.
 */

import assert from "node:assert/strict";

const { findScript, hashScript, defaultScriptFor, listScripts, scriptVariables } = await import(
  "../script/script-registry"
);
const { buildCampaignContext } = await import("../domain/campaign-context");
const { CAMPAIGN_CONVERSATION_POLICY } = await import("../script/conversation-policy");
const { validateCampaignScript, eventDateBlocker } = await import("../script/script-validation");
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

const V10 = findScript("registration", "v10");
assert.ok(V10, "registration v10 must be registered before this suite can run");

const APPENDIX = V10.systemPromptAppendix;
/** Whitespace-collapsed, lowercased: the WORDS are the subject, not the wrapping. */
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");

// ── The lines this campaign actually speaks, with a real name in ──
const NAME = "Sakshi";
const OPENING = `Hello, am I speaking with ${NAME}?`;
const INTRO_EN =
  `Hi ${NAME}, I'm Ishita, calling from FlexiFunnels. Actually, you'd shown interest in our ` +
  `upcoming webinar, "Launch Your Business Online in 10 Minutes". It's on 22nd September at 7:30 PM.`;
const INTRO_HI =
  `Hi ${NAME}, I'm Ishita, calling from FlexiFunnels. Actually, aapne hamare upcoming webinar, ` +
  `"Launch Your Business Online in 10 Minutes", mein interest show kiya tha. Webinar 22nd September ko 7:30 PM pe hai.`;
const INTEREST_EN = "I just wanted to confirm — are you still planning to join?";
const INTEREST_HI = "Bas main confirm karna chahti thi — kya aap abhi bhi attend karne mein interested hain?";
const INTEREST_DEV = "बस मैं confirm करना चाहती थी — क्या आप अभी भी attend करने में interested हैं?";
const BUSINESS_EN = "Are you already running a business, or planning to start something?";
const BUSINESS_HI = "Aap already koi business run kar rahe hain, ya abhi kuch start karne ka plan hai?";
const KIND_EN = "Oh nice. What kind of business is it?";
const KIND_HI = "Achha, nice. Aapka kis type ka business hai?";
const WEBSITE_EN = "And does your business already have a website?";
const WEBSITE_HI = "Aur kya aapke business ki already koi website hai?";
const IDEA_EN = "Do you have a specific idea in mind, or are you still exploring?";
const IDEA_HI = "Kuch specific idea hai mind mein, ya abhi explore kar rahe hain?";
const NO_WEBSITE_EN =
  "That's exactly what this webinar is for — taking your business online, setting up the website and taking payments, all shown live, step by step.";
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
  const { disposition } = dispositionFor({
    outcomeType: outcome.outcomeType,
    failureClass: "COMPLETED",
  });
  return { outcome, disposition };
}

/** The same transcript in the shape the live watchdog reads. */
const live = (transcript: readonly TranscriptTurn[]): ConversationTurn[] =>
  transcript.map(
    (t) => ({ role: t.role, content: t.text, timestamp: new Date() }) as unknown as ConversationTurn,
  );

/** A validation input valid in every respect except what a test varies. */
const validationFor = (script: CampaignScript, now: Date) => ({
  campaignType: script.campaignType,
  scriptId: script.id,
  scriptVersion: script.version,
  scriptHash: hashScript(script),
  allocatedProviders: ["cartesia"] as const,
  contactsMissingName: 0,
  now,
});

const BEFORE_EVENT = new Date("2026-09-22T10:00:00+05:30");
const AFTER_EVENT = new Date("2026-09-22T19:31:00+05:30");

// ═════════════════════════════════════════════════════════════════
section("A. REGISTERED, SELECTABLE, AND DELIBERATELY NOT THE DEFAULT");

test("A1. v10 is a registration script, approved, name-requiring, and dated", () => {
  assert.equal(V10.id, "registration");
  assert.equal(V10.version, "v10");
  assert.equal(V10.campaignType, "registration");
  assert.equal(V10.isPlaceholder, false, "the approved wording is installed");
  assert.equal(V10.requiresName, true, "the opening line names the person");
  assert.equal(V10.eventAt, "2026-09-22T19:30:00+05:30");
  assert.ok(V10.label.includes("Launch Your Business Online in 10 Minutes"));
  assert.ok(V10.label.includes("22 September"));
});

test("A2. v6 is STILL the default — v10 is a different event from v6, and a newer revision of v9", () => {
  assert.equal(defaultScriptFor("registration").version, "v6");
  assert.equal(defaultScriptFor("reminder").version, "v2");
  // ...but it is selectable, listed right after v6 and ahead of v9,
  // exactly as v8 sits ahead of v7.
  const registration = listScripts().filter((s) => s.campaignType === "registration");
  assert.equal(registration[0]?.version, "v6");
  // `registration v13` — the implementation session — was registered
  // under v6 on 2026-09-22 as the then-current campaign's script, just
  // as v12 had been. Every version below it shifted one place down;
  // position is read by nothing but `defaultScriptFor`, which still
  // takes v6.
  assert.equal(registration[1]?.version, "v13");
  // `registration v14` is v13's sibling — the same session for people who
  // did NOT attend the two-day event — registered under it on 2026-09-22.
  assert.equal(registration[2]?.version, "v14");
  assert.equal(registration[3]?.version, "v12");
  assert.equal(registration[4]?.version, "v11");
  assert.equal(registration[5]?.version, "v10");
  assert.equal(registration[6]?.version, "v9");
});

test("A3. v10 uses ONLY variables the campaign layer can supply", () => {
  assert.deepEqual(scriptVariables(V10), ["agent_name", "customer_name"]);
  // The brief wrote {{first_name}}, {{phone_number}} and {{email}}; the
  // layer supplies exactly two variables and the registry refuses any
  // other at import. `customer_name` IS the imported name column, which
  // the campaign's CSVs carry as a first name.
  for (const banned of ["{{first_name}}", "{{phone_number}}", "{{email}}"]) {
    assert.ok(!APPENDIX.includes(banned), `v10 must not ask for ${banned}`);
    assert.ok(!V10.openingLineTemplate.includes(banned));
  }
});

test("A4. v10's hash is stable and distinct from every other script's", () => {
  const hash = hashScript(V10);
  assert.equal(hash, hashScript(V10), "hashing is deterministic");
  for (const other of listScripts()) {
    if (other === V10) continue;
    assert.notEqual(hashScript(other), hash, `${other.id}/${other.version} must not collide`);
  }
});

test("A5. the revisions before it are byte-identical to when they shipped", () => {
  assert.equal(
    hashScript(findScript("registration", "v9")!),
    "db4da125d8f6ced980032d602a61a5450355bd644e710cdfce86f66f9a8be282",
  );
  assert.equal(
    hashScript(findScript("registration", "v8")!),
    "9ce4e6c7e18aa65227f8340f2db6435667fc22ea1e57b545916af119c3ee5b36",
  );
  assert.equal(
    hashScript(findScript("registration", "v7")!),
    "ed1c1e81d9a3493eab4474ffc7cf840520a000baec325f94923e92430fc76926",
  );
  assert.equal(
    hashScript(findScript("registration", "v6")!),
    "de8aede9568acfae24cf84762fc807eeef7362b659f2685c82a87ee58859cb3f",
  );
});

// ═════════════════════════════════════════════════════════════════
section("B. THE DATE IS DECLARED, AND THE CLOCK HOLDS IT TO IT");

test("B1. the declared instant parses, and matches the prose", () => {
  assert.equal(eventDateBlocker(V10, BEFORE_EVENT), undefined);
  assert.ok(FLAT.includes("22nd september"), "the date is in the text");
  assert.ok(FLAT.includes("7:30 pm"), "the time is in the text");
  assert.ok(V10.openingLineTemplate.trim().length > 0);
});

test("B2. preflight validates on the morning of the 22nd", () => {
  const result = validateCampaignScript(validationFor(V10, BEFORE_EVENT));
  assert.equal(result.ok, true, `unexpected blockers: ${result.blockers.join(" | ")}`);
});

test("B3. preflight REFUSES once the webinar has started", () => {
  const result = validateCampaignScript(validationFor(V10, AFTER_EVENT));
  assert.equal(result.ok, false, "a call after 7:30 PM invites people to an event that has begun");
  assert.ok(result.blockers.some((b) => b.toLowerCase().includes("passed") || b.toLowerCase().includes("date")));
});

// ═════════════════════════════════════════════════════════════════
section("C. THE GATE IS THE APPROVED ANCHOR, AND IT SETTLES FINAL_YES");

test("C1. both renderings of the gate are in the script, verbatim", () => {
  assert.ok(APPENDIX.includes(GATE_EN), "the English gate must be the v4-v8 anchor line");
  assert.ok(APPENDIX.includes(GATE_HI), "the approved Hinglish gate must be present");
});

test("C2. a yes at the English gate is confirmed_at_gate, FINAL_YES, and sheet-eligible", () => {
  for (const said of ["Yes.", "Haan ji.", "Yes please, go ahead.", "Sure."]) {
    const { outcome, disposition } = settle([
      agent(OPENING), caller("Yes."),
      agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
      agent(BUSINESS_EN), caller("I run a small bakery."),
      agent(KIND_EN), caller("Cakes and desserts, from home."),
      agent(WEBSITE_EN), caller("No, not yet."),
      agent(`${NO_WEBSITE_EN} ${GATE_EN}`), caller(said),
    ]);
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" must settle at the gate`);
    assert.equal(disposition, "FINAL_YES");
    assert.equal(isFinalYes(outcome, disposition), true);
  }
});

test("C3. a yes at the HINGLISH gate registers exactly the same way", () => {
  for (const said of ["Haan ji.", "Haan, kar do.", "Bilkul.", "जी हाँ।", "Yes."]) {
    const { outcome, disposition } = settle([
      agent(OPENING), caller("Haan, bol raha hoon."),
      agent(`${INTRO_HI} ${INTEREST_HI}`), caller("Haan."),
      agent(BUSINESS_HI), caller("Abhi kuch start karne ka plan hai."),
      agent(IDEA_HI), caller("Ek clothing brand ka idea hai."),
      agent(`Achha, nice. Toh webinar mein exactly yahi dikhaya jaata hai — website, product aur payments, live. ${GATE_HI}`),
      caller(said),
    ]);
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" to the Hinglish gate must register`);
    assert.equal(disposition, "FINAL_YES");
    assert.equal(isFinalYes(outcome, disposition), true);
  }
});

test("C4. a no at the gate is not a registration", () => {
  for (const gate of [GATE_EN, GATE_HI]) {
    for (const said of ["No.", "Nahi.", "No, not right now.", "Nahi, abhi nahi."]) {
      const { outcome, disposition } = settle([
        agent(OPENING), caller("Yes."),
        agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
        agent(BUSINESS_EN), caller("Planning to start."),
        agent(`${IDEA_EN}`), caller("Still exploring."),
        agent(gate), caller(said),
      ]);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" must not register`);
      assert.equal(isFinalYes(outcome, disposition), false);
    }
  }
});

test("C5. the gate survives the speech formatter, so what is spoken is what is anchored", () => {
  for (const line of [GATE_EN, GATE_HI, INTEREST_EN, INTEREST_HI, BUSINESS_HI, GOODBYE]) {
    assert.equal(formatForSpeech(line), line, `the formatter must not re-word "${line}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. EVERY QUESTION BEFORE THE GATE — BOTH DIRECTIONS");

const PRE_GATE_QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ["interest check (EN)", `${INTRO_EN} ${INTEREST_EN}`],
  ["interest check (Hinglish)", `${INTRO_HI} ${INTEREST_HI}`],
  ["interest check (Devanagari)", `${INTRO_HI} ${INTEREST_DEV}`],
  ["business question (EN)", BUSINESS_EN],
  ["business question (Hinglish)", BUSINESS_HI],
  ["kind of business (EN)", KIND_EN],
  ["kind of business (Hinglish)", KIND_HI],
  ["website question (EN)", WEBSITE_EN],
  ["website question (Hinglish)", WEBSITE_HI],
  ["idea question (EN)", IDEA_EN],
  ["idea question (Hinglish)", IDEA_HI],
];

test("D1. YES to any pre-gate question registers nobody", () => {
  for (const [label, question] of PRE_GATE_QUESTIONS) {
    for (const said of ["Yes.", "Haan.", "Haan ji.", "Yes, I do.", "Okay.", "हाँ।", "Bilkul."]) {
      const { outcome, disposition } = settle([agent(OPENING), caller("Yes."), agent(question), caller(said)]);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" to the ${label} must not register anybody`);
      assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `"${said}" to the ${label} must not settle at the gate`);
      assert.equal(isFinalYes(outcome, disposition), false);
    }
  }
});

test("D2. NO to any pre-gate question does not read as a refusal at the gate", () => {
  for (const [label, question] of PRE_GATE_QUESTIONS) {
    for (const said of ["No.", "Nahi.", "No, nothing yet.", "Nahi, abhi nahi."]) {
      const { outcome } = settle([agent(OPENING), caller("Yes."), agent(question), caller(said)]);
      assert.notEqual(outcome.primaryReason, "declined_at_gate", `"${said}" to the ${label} answers a question about THEM`);
    }
  }
});

test("D3. the English interest check is NOT the anchored phrasing, and the text forbids it", () => {
  // "interested in attending" / "interested to attend" / "like to attend"
  // / "want to attend" are `COMMIT_ANCHORS`. The check must be worded
  // around none of them, and must tell the model so.
  for (const anchored of ["interested in attending", "interested to attend", "like to attend", "want to attend"]) {
    assert.ok(!INTEREST_EN.toLowerCase().includes(anchored));
  }
  assert.ok(FLAT.includes("are you still planning to join?"), "the safe form is in the text");
  assert.ok(FLAT.includes("do not turn it into \"are you still interested in attending\""), "the unsafe forms are named");
  // And the anchored phrasing really would register — which is why it is forbidden.
  const { disposition } = settle([
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_EN} Are you still interested in attending?`), caller("Yes."),
  ]);
  assert.equal(disposition, "FINAL_YES", "this is the failure the wording exists to avoid");
});

test("D4. a NO early, then a YES at the gate, still registers", () => {
  for (const said of ["No, nothing online yet.", "Nahi, website nahi hai."]) {
    const { outcome, disposition } = settle([
      agent(OPENING), caller("Yes."),
      agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
      agent(BUSINESS_EN), caller("I have a tuition centre."),
      agent(KIND_EN), caller("Maths coaching for school students."),
      agent(WEBSITE_EN), caller(said),
      agent(`${NO_WEBSITE_EN} ${GATE_EN}`), caller("Yes, go ahead."),
      agent(YES_EN),
    ]);
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" then yes must still register`);
    assert.equal(disposition, "FINAL_YES");
  }
});

test("D5. a YES early, then a NO at the gate, does NOT register", () => {
  const { outcome, disposition } = settle([
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
    agent(BUSINESS_EN), caller("Yes, I run a business."),
    agent(KIND_EN), caller("A salon."),
    agent(WEBSITE_EN), caller("Yes, we have one."),
    agent(`Great. Then the webinar shows the products and payments side of it online, live. ${GATE_EN}`),
    caller("No, not right now."),
  ]);
  assert.notEqual(disposition, "FINAL_YES", "an early yes is not an answer to the gate");
  assert.equal(isFinalYes(outcome, disposition), false);
});

test("D6. the text keeps the seat question in its own place, in as many words", () => {
  for (const required of [
    "ask it once, in those words, in its own place",
    "never bring it forward",
    "never ask a smaller version of it earlier",
  ]) {
    assert.ok(FLAT.includes(required), `the script must say "${required}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. EVERY TERMINAL BRANCH ACTUALLY ENDS THE CALL");

test("E1. YES: the confirmation commits the registration and the watchdog sees FINAL_YES", () => {
  for (const [gate, yesBlock, said] of [
    [GATE_EN, YES_EN, "Yes, please."],
    [GATE_HI, YES_HI, "Haan ji, kar do."],
  ] as const) {
    const transcript = [
      agent(OPENING), caller("Yes."),
      agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
      agent(BUSINESS_EN), caller("Planning to start something."),
      agent(IDEA_EN), caller("Still exploring."),
      agent(gate), caller(said),
    ];
    // From the yes, before the agent replies: the registration is
    // committed, so the pipeline can ready its goodbye.
    const atYes = liveRegistrationReading(live(transcript), "registration");
    assert.equal(atYes.registrationConfirmed, true);
    // After the confirmation has been spoken: the verdict is FINAL_YES,
    // and the call is held only for the person's closing word.
    const afterBlock = liveRegistrationReading(live([...transcript, agent(yesBlock)]), "registration");
    assert.equal(afterBlock.verdict, "FINAL_YES", `the [YES] block must not withdraw the verdict (${yesBlock})`);
    assert.equal(afterBlock.awaitingClosingResponse, true);
    assert.ok(!yesBlock.includes("?"), "the confirmation asks nothing, so it cannot hold the line open");
  }
});

test("E2. the confirmation is NOT itself a gate, so nothing after it re-registers or retracts", () => {
  // "seat reserve" is a literal anchor; the confirmations avoid it in a
  // statement. A stray "okay" after them must not read as a yes AT the
  // confirmation, and the settled outcome is still the one yes.
  for (const block of [YES_EN, YES_HI, ALREADY_EN]) {
    const { outcome } = settle([agent(OPENING), caller("Yes."), agent(block), caller("Okay.")]);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `"${block}" must not be read as the gate`);
  }
});

test("E3. NOT INTERESTED: the [NO] block ends the call as FINAL_NO, in English and in Hinglish", () => {
  for (const [refusal, close] of [
    ["No, I'm not interested.", NO_BLOCK],
    ["Not interested, thanks.", NO_BLOCK],
    ["Nahi, mujhe interest nahi hai.", `Okay, koi baat nahi. Aapke time ke liye thank you, ${NAME}. Have a great day!`],
  ] as const) {
    const transcript = [agent(OPENING), caller("Yes."), agent(`${INTRO_EN} ${INTEREST_EN}`), caller(refusal), agent(close)];
    assert.equal(definitiveAnswerIn(live(transcript), "registration"), "FINAL_NO", `"${refusal}" must end the call`);
    const { disposition } = settle(transcript);
    assert.equal(disposition, "FINAL_NO");
  }
});

test("E4. the refusal is honoured wherever it happens — at the gate too", () => {
  const transcript = [
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Yes."),
    agent(BUSINESS_EN), caller("I have a shop."),
    agent(KIND_EN), caller("Mobile accessories."),
    agent(WEBSITE_EN), caller("No."),
    agent(`${NO_WEBSITE_EN} ${GATE_EN}`), caller("No, I'm not interested."),
    agent(NO_BLOCK),
  ];
  assert.equal(definitiveAnswerIn(live(transcript), "registration"), "FINAL_NO");
});

test("E5. the goodbye line is a recognised closing, so a soft close hangs up too", () => {
  // "I'll think about it" and "already registered" end with neither a
  // yes nor an explicit no, so the hangup rides on the agent's own
  // sign-off: at most 12 words, ending on a closing phrase.
  for (const closing of [GOODBYE, `Thanks for your time, ${NAME}. Have a great day!`, `Aapka din shubh ho, ${NAME}. Bye!`]) {
    const transcript = [agent(OPENING), caller("Yes."), agent(ALREADY_EN), caller("Okay, thanks."), agent(closing)];
    assert.equal(agentClosedIn(live(transcript)), true, `"${closing}" must be read as the agent closing`);
  }
});

test("E6. the [NO] block itself is over the closing word cap — recorded, not hidden", () => {
  // The approved [NO] wording, with a one-word name, is 13 words: one
  // over `AGENT_CLOSING_MAX_WORDS`. It ends an explicit refusal through
  // FINAL_NO (E3/E4), never through `agentClosedIn`. That is why the
  // script gives every SOFT close a separate 8-word goodbye (E5).
  const transcript = [agent(OPENING), caller("Yes."), agent(`${INTRO_EN} ${INTEREST_EN}`), caller("I'll think about it."), agent(NO_BLOCK)];
  assert.equal(agentClosedIn(live(transcript)), false);
  assert.equal(definitiveAnswerIn(live(transcript), "registration"), undefined);
});

test("E7. ALREADY REGISTERED: no gate, no registration, no refusal — and the text says so", () => {
  const transcript = [
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_EN} ${INTEREST_EN}`), caller("I have already registered for it."),
    agent(ALREADY_EN), caller("Okay, sure."),
    agent(GOODBYE),
  ];
  const { outcome, disposition } = settle(transcript);
  assert.notEqual(disposition, "FINAL_YES", "an existing registrant must not become a new sheet row");
  assert.notEqual(disposition, "FINAL_NO", "...and has not refused anything");
  assert.equal(isFinalYes(outcome, disposition), false);
  assert.equal(agentClosedIn(live(transcript)), true, "the goodbye ends the call");
  assert.ok(FLAT.includes("do not ask the seat question and do not take them through a registration again"));
  // Stated cost, in the header and here: this settles UNRESOLVED.
  assert.equal(disposition, "UNRESOLVED");
});

// ═════════════════════════════════════════════════════════════════
section("F. THE BRANCHES AND THE FAQ ARE ALL THERE, AND NOTHING ELSE IS");

test("F1. every approved Hinglish line is in the text, verbatim", () => {
  for (const line of [
    "Actually, aapne hamare upcoming webinar, 'Launch Your Business Online in 10 Minutes', mein interest show kiya tha.",
    "Webinar 22nd September ko 7:30 PM pe hai.",
    "kya aap abhi bhi attend karne mein interested hain?",
    "Aap already koi business run kar rahe hain, ya abhi kuch start karne ka plan hai?",
    "Achha, nice. Aapka kis type ka business hai?",
    "Aur kya aapke business ki already koi website hai?",
    "Kuch specific idea hai mind mein, ya abhi explore kar rahe hain?",
    "Okay, no problem at all. Thanks for your time, {{customer_name}}. Have a great day!",
  ]) {
    assert.ok(APPENDIX.replace(/\s+/gu, " ").includes(line), `missing approved line: "${line}"`);
  }
});

test("F2. every question the brief lists has a handling in the text", () => {
  for (const asked of [
    "what is the webinar about",
    "i don't remember",
    "i'm not sure yet",
    "is it free",
    "do i need a laptop",
    "i don't know coding",
    "how long is it",
    "send me the details on whatsapp",
    "i'm busy",
    "i'm not interested",
    "i've already registered",
    "how much can i make",
  ]) {
    assert.ok(FLAT.includes(asked), `the FAQ must handle "${asked}"`);
  }
});

test("F3. the not-interested rule is absolute and the wording is the approved one", () => {
  assert.ok(FLAT.includes("at any point in the call"), "not-interested ends the call wherever it happens");
  assert.ok(FLAT.includes("no second attempt, no reframing, no selling past a no"));
});

test("F4. the conversational shape is stated: short turn, listen, relevant reply, next question", () => {
  for (const required of [
    "short turn, then listen",
    "you are not reading an advertisement",
    "do not describe the whole webinar in one go",
    "respond to the actual point they made",
    "do not restart the script",
  ]) {
    assert.ok(FLAT.includes(required), `the script must say "${required}"`);
  }
});

test("F5. the language rule is the brief's, and it constrains no language in the master prompt's terms", () => {
  assert.ok(FLAT.includes("someone answering in english is spoken to in english"));
  assert.ok(FLAT.includes("natural, conversational hinglish"));
  assert.ok(FLAT.includes("never textbook or formal hindi"));
  for (const term of ["business", "website", "online", "webinar", "registration", "product", "payment", "whatsapp", "email"]) {
    assert.ok(FLAT.includes(term), `the preserved term "${term}" must be named`);
  }
  // The same four phrases phase3a test 17 bans in every script.
  for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
    assert.ok(!FLAT.includes(banned), `must not constrain language with "${banned}"`);
  }
});

test("F6. no internal machinery is exposed to the model, and none can be spoken", () => {
  // "their tools" (the things the script must not ask about) is ordinary
  // prose; a tool NAME or a tool CALL is what must never appear.
  for (const leak of [
    "classifier", "commit_anchors", "anchor", "final_yes", "final_no", "sheet", "pipeline",
    "tool name", "tool call", "function", "hangup", "watchdog", "disposition", "unresolved",
    "campaign_events", "system prompt", "internal note",
    // Provider and vendor names: none of them is the caller's business.
    "vobiz", "plivo", "deepgram", "soniox", "sarvam", "cartesia", "smallest", "elevenlabs",
    "openai", "gpt", "gemma", "gemini", "google", "zoom",
  ]) {
    assert.ok(!FLAT.includes(leak), `the appendix must not mention "${leak}"`);
  }
});

test("F7. no invented fact, promise or figure is in the text", () => {
  for (const banned of [
    "zoom", "₹", "lakh", "worth", "recording will", "we guarantee", "is guaranteed",
    "saurabh", "karthik", "i will send", "whatsapp pe bhej",
  ]) {
    assert.ok(!FLAT.includes(banned), `the text must not carry "${banned}"`);
  }
  // "I'll send" and "main bhej dunga" appear exactly once each — inside
  // the sentence that forbids them. Anywhere else they would be a claim.
  for (const quoted of ["i'll send", "main bhej"]) {
    assert.equal(FLAT.split(quoted).length - 1, 1, `"${quoted}" may appear only where it is forbidden`);
  }
  assert.ok(FLAT.includes("so never say \"i'll send\" or \"main bhej dunga\""));
  // "bonus" and "replay" are allowed in exactly one place each: the list
  // of things never to invent. Anywhere else they would be a claim.
  for (const word of ["bonus", "replay"]) {
    assert.equal(FLAT.split(word).length - 1, 1, `"${word}" may appear only in the never-invent list`);
  }
  assert.ok(FLAT.includes("a price, a bonus, a platform"));
  assert.ok(FLAT.includes("a replay policy or a claim about"));
  assert.ok(FLAT.includes("you do not send anything yourself"));
  // v9's honest-unknown is GONE — the duration is now a sourced fact.
  assert.ok(!FLAT.includes("you do not have the exact duration"));
  assert.ok(!FLAT.includes("a duration"), "duration is no longer something to refuse to invent");
});

// ═════════════════════════════════════════════════════════════════
section("G. IT COMPOSES INTO A REAL SESSION'S PROMPT");

test("G1. the context interpolates, and leaves no placeholder behind", () => {
  const context = buildCampaignContext({
    script: V10,
    campaignId: "cmp_v10",
    campaignType: "registration",
    provider: "smallest-ai",
    customerName: NAME,
    expectedScriptHash: hashScript(V10),
  });
  assert.equal(context.openingLine, OPENING);
  assert.ok(!/\{\{/u.test(context.systemPromptAppendix), "no unresolved placeholder");
  assert.ok(!/\{\{/u.test(context.openingLine));
  assert.ok(context.systemPromptAppendix.includes(`You are Ishita from FlexiFunnels, calling ${NAME}`));
  assert.ok(context.systemPromptAppendix.includes(`Hi ${NAME}, I'm Ishita, calling from FlexiFunnels.`));
  assert.ok(context.systemPromptAppendix.includes(`Thanks for your time, ${NAME}. Have a great day!`));
});

test("G2. the opening IS the pipeline's identity question, so it is never asked twice", () => {
  const context = buildCampaignContext({
    script: V10,
    campaignId: "cmp_v10",
    campaignType: "registration",
    provider: "cartesia",
    customerName: NAME,
  });
  assert.ok(context.identityLine, "a name-requiring script carries the identity line");
  // The pipeline's `openingLineAsksIdentity` compares letters and digits
  // only, case-folded — so "Hello, am I speaking with…" contains "Am I
  // speaking with…" and the gate is marked OUTSTANDING, not re-asked.
  const flatten = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
  assert.ok(
    flatten(context.openingLine).includes(flatten(context.identityLine)),
    "the opening must contain the identity question the way the pipeline reads it",
  );
  assert.equal(context.openingLine, "Hello, am I speaking with Sakshi?");
  assert.equal(context.agent.name, "Rohan", "cartesia is a male voice, so the agent is Rohan");
});

test("G3. the gate reaches the system prompt, and the policy still follows the script", () => {
  const context = buildCampaignContext({
    script: V10,
    campaignId: "cmp_v10",
    campaignType: "registration",
    provider: "smallest-ai",
    customerName: NAME,
  });
  const appendix = context.systemPromptAppendix;
  assert.ok(appendix.includes(GATE_EN));
  assert.ok(appendix.includes(GATE_HI));
  assert.ok(appendix.endsWith(CAMPAIGN_CONVERSATION_POLICY), "the policy is appended last");
  assert.ok(appendix.indexOf("--- SCRIPT ---") < appendix.indexOf("# HOW TO RUN THIS SCRIPT ON A LIVE CALL"));
});

test("G4. a campaign pinned to v10 refuses to run if the words are edited", () => {
  const edited: CampaignScript = { ...V10, systemPromptAppendix: `${V10.systemPromptAppendix} ` };
  assert.throws(
    () =>
      buildCampaignContext({
        script: edited,
        campaignId: "cmp_v10",
        campaignType: "registration",
        provider: "smallest-ai",
        customerName: NAME,
        expectedScriptHash: hashScript(V10),
      }),
    /has changed since this campaign was created/u,
  );
});

test("G5. a contact with no name cannot be called on this script", () => {
  assert.throws(
    () =>
      buildCampaignContext({
        script: V10,
        campaignId: "cmp_v10",
        campaignType: "registration",
        provider: "smallest-ai",
        customerName: "   ",
      }),
    /needs the contact's name/u,
  );
});

// ═════════════════════════════════════════════════════════════════
section("H. WHAT CHANGED FROM v9 — THE TWO SOURCED ANSWERS, AND NOTHING ELSE");

const V9 = findScript("registration", "v9");
assert.ok(V9, "registration v9 must still be registered — v10 is measured against it");

/** A line-level diff of the two appendices, order-insensitive. */
function appendixDiff(): { readonly onlyInV9: string[]; readonly onlyInV10: string[] } {
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const v9Lines = new Set(lines(V9!.systemPromptAppendix));
  const v10Lines = new Set(lines(V10!.systemPromptAppendix));
  return {
    onlyInV9: [...v9Lines].filter((l) => !v10Lines.has(l)),
    onlyInV10: [...v10Lines].filter((l) => !v9Lines.has(l)),
  };
}

/** Every line allowed to differ is about the duration, WhatsApp, or the two "unknown" lists. */
const ALLOWED_DIFF = /duration|how long|90 minutes|whatsapp|send|live session|session hai|starting at 7:30|you do have|contact details|seat if they would like one|come to them|mil jaayengi|acknowledge their interest|registration is done|registration complete|seat question, if you have not|they say yes to it|ask something outside them|which platform it is on|costs afterwards|never invent a date|guarantee, a registration number|platform, a guarantee|^flexifunnels\.$/iu;

test("H1. the script BODY — opening, every branch, gate, confirmation, closings — is byte-identical to v9", () => {
  const body = (s: CampaignScript) => s.systemPromptAppendix.slice(s.systemPromptAppendix.indexOf("--- SCRIPT ---"));
  assert.equal(body(V10), body(V9!), "nothing below --- SCRIPT --- may differ from v9");
  assert.equal(V10.openingLineTemplate, V9!.openingLineTemplate);
  assert.equal(V10.eventAt, V9!.eventAt);
  assert.equal(V10.requiresName, V9!.requiresName);
});

test("H2. the ONLY appendix lines that differ from v9 are the duration and WhatsApp lines", () => {
  const { onlyInV9, onlyInV10 } = appendixDiff();
  for (const line of [...onlyInV9, ...onlyInV10]) {
    assert.match(line, ALLOWED_DIFF, `an unexpected line differs from v9: "${line}"`);
  }
  assert.ok(onlyInV10.length >= 3, "the duration fact, the duration answer and the WhatsApp answer are new");
  assert.ok(onlyInV9.length >= 3, "v9's two unknown answers and its 'how long it runs' clause are gone");
});

test("H3. the interest questions are untouched — the safe English form and the approved Hinglish form", () => {
  assert.ok(FLAT.includes("i just wanted to confirm — are you still planning to join?"));
  assert.ok(FLAT.includes("kya aap abhi bhi attend karne mein interested hain?"));
  assert.ok(!INTEREST_EN.toLowerCase().includes("interested in attending"));
  assert.ok(FLAT.includes("do not turn it into \"are you still interested in attending\""));
});

test("H4. DURATION: approximately 90 minutes, in both renderings, as a fact and as the answer", () => {
  assert.ok(FLAT.includes("- how long: approximately 90 minutes."), "the fact is in the facts list");
  assert.ok(FLAT.includes("\"how long is it?\" — approximately 90 minutes."), "the answer is the sourced one");
  assert.ok(FLAT.includes("approximately 90 minutes ka session hai."), "the sourced Hinglish line is verbatim");
  assert.ok(!FLAT.includes("exact duration"), "the old unknown answer is gone");
  assert.ok(!FLAT.includes("how long it runs"), "...and duration is no longer in the do-not-know list");
});

test("H5. WHATSAPP: the sourced behaviour, in words that are true of this system", () => {
  // Sourced: acknowledge interest; registration will be completed; details on WhatsApp.
  assert.ok(FLAT.includes("acknowledge their interest"));
  assert.ok(FLAT.includes("once their registration is done, the webinar details will come to them on whatsapp"));
  assert.ok(FLAT.includes("registration complete hone ke baad webinar ki details aapko whatsapp pe mil jaayengi."));
  // True of this system: nothing here sends anything.
  assert.ok(FLAT.includes("you do not send anything yourself"));
  for (const claim of ["i'll send you", "i will send", "we'll send", "we will send", "hum bhej", "whatsapp pe bhej", "within", "shortly", "right away"]) {
    assert.ok(!FLAT.includes(claim), `the text must not claim "${claim}"`);
  }
  // The two quoted forbidden phrases live only inside their prohibition (see F7).
  assert.equal(FLAT.split("main bhej").length - 1, 1);
  // The request is not a yes, and the registration only exists after the gate.
  assert.ok(FLAT.includes("that is a request, not a yes"));
  assert.ok(FLAT.includes("then ask the seat question, if you have not asked it yet"));
});

test("H6. the WhatsApp answer is NOT a gate — a 'haan' to it registers nobody", () => {
  const whatsappEn = "Sure. Once your registration is done, the webinar details will come to you on WhatsApp.";
  const whatsappHi = "Ji, bilkul. Registration complete hone ke baad webinar ki details aapko WhatsApp pe mil jaayengi.";
  for (const answer of [whatsappEn, whatsappHi]) {
    for (const said of ["Okay.", "Haan, theek hai.", "Yes.", "Achha."]) {
      const { outcome, disposition } = settle([
        agent(OPENING), caller("Yes."),
        agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Send me the details on WhatsApp."),
        agent(answer), caller(said),
      ]);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" to the WhatsApp answer must not register`);
      assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
      assert.equal(isFinalYes(outcome, disposition), false);
    }
  }
});

test("H7. ...and the gate asked right after it still registers, and a no still declines", () => {
  const whatsappHi = "Ji, bilkul. Registration complete hone ke baad webinar ki details aapko WhatsApp pe mil jaayengi.";
  const yes = settle([
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_HI} ${INTEREST_HI}`), caller("WhatsApp pe details bhej do."),
    agent(`${whatsappHi} ${GATE_HI}`), caller("Haan ji."),
    agent(YES_HI),
  ]);
  assert.equal(yes.outcome.primaryReason, "confirmed_at_gate");
  assert.equal(yes.disposition, "FINAL_YES");
  const no = settle([
    agent(OPENING), caller("Yes."),
    agent(`${INTRO_EN} ${INTEREST_EN}`), caller("Just send me the details on WhatsApp."),
    agent(`Sure. Once your registration is done, the webinar details will come to you on WhatsApp. ${GATE_EN}`),
    caller("No, not right now."),
  ]);
  assert.notEqual(no.disposition, "FINAL_YES");
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
