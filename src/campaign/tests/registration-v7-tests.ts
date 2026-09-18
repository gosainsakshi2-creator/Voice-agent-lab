/**
 * registration-v7-tests.ts — `npm run test:registration-v7`
 *
 * THE 2-DAY AI INCOME BLUEPRINT CAMPAIGN SCRIPT, registration v7.
 *
 * v7 invites people to a DIFFERENT event from every version before it —
 * two days, two sessions a day, on Zoom — so this suite is not a diff
 * against v6. It asserts the four things that can silently break a
 * campaign, and one thing that can silently break every OTHER campaign:
 *
 *   A  v7 is registered, is NOT the default, and v6 still is. A new
 *      script must not become what a campaign created without naming
 *      one quietly runs.
 *
 *   B  v1-v6 are byte-identical, hashes included. Publishing a version
 *      must not touch a pinned one.
 *
 *   C  THE GATE. "Would you like me to reserve your free seat?" is a
 *      `COMMIT_ANCHORS.registration` phrase, and a yes to it settles
 *      FINAL_YES — which is what the registrations sheet mirror and the
 *      end-of-call hangup both read. A re-worded gate matches no anchor
 *      and stops both, silently, on a campaign that otherwise looks
 *      like it ran.
 *
 *   D  THE DISCOVERY QUESTION IS NOT THE GATE, in BOTH directions. A
 *      yes to it must not register anybody, and a no to it must not
 *      stop a real yes at the gate later. This is the load-bearing
 *      section: a discovery question phrased around attending would hit
 *      "like to attend" / "want to attend" / "interested to attend" and
 *      register people one exchange before they had been told what the
 *      event was, which is indistinguishable afterwards from a real
 *      registration.
 *
 *   E  the verified event facts are present, and the things this
 *      campaign is not allowed to say are absent.
 *
 *   F  it survives composition into a real session's system prompt.
 *
 * Every module here is the real one and every input is a literal.
 * NOTHING HERE PLACES A CALL, TOUCHES A DATABASE, OR CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";

import { findScript, defaultScriptFor, hashScript, scriptVariables } from "../script/script-registry";
import { validateCampaignScript } from "../script/script-validation";
import { SUPPORTED_SCRIPT_VARIABLES } from "../script/variables";
import { buildCampaignContext } from "../domain/campaign-context";
import { classifyOutcome } from "../outcome/classifier";
import { dispositionFor } from "../outcome/disposition";
import { isFinalYes } from "../integrations/final-yes-sheet";
import { buildSystemPrompt } from "../../core/session/system-prompt";
import { SupportedLanguage } from "../../types/enums";
import type { TranscriptTurn } from "../outcome/transcript";
import type { CampaignScript } from "../script/script-types";

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

const V7 = findScript("registration", "v7");
assert.ok(V7, "registration v7 must be registered before this suite can run");

const APPENDIX = V7.systemPromptAppendix;

/**
 * The appendix with every run of whitespace collapsed, lowercased.
 *
 * The text is written as an array of hard-wrapped lines, so a phrase
 * that reads as one sentence can be split across two of them. Asserting
 * against the wrapped form would make a re-wrap look like a missing
 * fact; asserting against this makes the WORDS the subject of the test,
 * which is what these assertions are actually about.
 */
const FLAT = APPENDIX.toLowerCase().replace(/\s+/gu, " ");

// ── The lines this campaign actually speaks ──────────────────────
const GREETING = "Hello, this is Ishita from Team FlexiFunnels.";
const PITCH =
  "I'm calling to invite you to a free two-day event we're running on the 19th and 20th of " +
  "September — the AI Income Blueprint. It's live on Zoom, and it's about using AI to build " +
  "an online income, from working out what to sell right through to getting customers.";
/** The two discovery questions the script licenses, read as written. */
const DISCOVERY_A = "Are you currently running a business, or are you looking to start something online?";
const DISCOVERY_B = "Are you already doing something online, or are you exploring an idea right now?";
const BRIDGE =
  "It's built around you building alongside the sessions rather than just watching, and " +
  "there's no coding or technical background needed.";
const GATE = "Would you like me to reserve your free seat?";
const YES_BLOCK =
  "Perfect, I'll get your free seat reserved. It runs on Saturday the 19th and Sunday the " +
  "20th, ten to twelve in the morning and one to three in the afternoon, both days, live on Zoom.";

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

// ═════════════════════════════════════════════════════════════════
section("A. REGISTERED, SELECTABLE, AND DELIBERATELY NOT THE DEFAULT");

test("A1. v7 is registered as a registration script, approved and name-requiring", () => {
  assert.equal(V7.id, "registration", "script id and campaign type must agree");
  assert.equal(V7.campaignType, "registration");
  assert.equal(V7.version, "v7");
  assert.equal(V7.isPlaceholder, false, "a placeholder script may never be dialed");
  assert.equal(V7.requiresName, true, "the greeting and the identity gate both need the name");
  assert.ok(V7.openingLineTemplate.trim().length > 0, "the opening line is spoken verbatim");
});

test("A2. v6 is STILL the default — v7 is a different event, not a newer revision", () => {
  // The whole reason v7 sits below v6 in the registry. A campaign
  // created without naming a script must keep running the workshop
  // invite it has always run.
  assert.equal(
    defaultScriptFor("registration").version,
    "v6",
    "publishing v7 must not change what an unspecified campaign dials",
  );
  assert.equal(defaultScriptFor("reminder").version, "v2", "the reminder default is untouched too");
});

test("A3. v7 uses ONLY variables the campaign layer can supply", () => {
  const used = scriptVariables(V7);
  for (const name of used) {
    assert.ok(
      (SUPPORTED_SCRIPT_VARIABLES as readonly string[]).includes(name),
      `v7 uses {{${name}}}, which the campaign layer cannot supply`,
    );
  }
  assert.deepEqual([...used].sort(), ["agent_name", "customer_name"]);
  // The fields the brief asked for that do not exist. Each one would
  // throw at module load; asserting them here names WHY they are absent.
  for (const absent of ["first_name", "email", "last_digits", "phone", "event_date"]) {
    assert.ok(
      !APPENDIX.includes(`{{${absent}}}`) && !V7.openingLineTemplate.includes(`{{${absent}}}`),
      `{{${absent}}} is not a supported script variable`,
    );
  }
});

test("A4. v7 declares NO eventAt, so the clock cannot block it in either direction", () => {
  // A two-day event and a single-instant field. Declaring the 19th
  // would refuse every day-two call; declaring the 20th would assert a
  // date the prose does not lead with. Absence means "not checked",
  // exactly as for v1-v5.
  assert.equal(V7.eventAt, undefined);
  for (const now of [new Date("2026-01-01T00:00:00+05:30"), new Date("2027-01-01T00:00:00+05:30")]) {
    const result = validateCampaignScript(validationFor(V7, now));
    assert.equal(result.ok, true, `unexpected blockers at ${now.toISOString()}: ${result.blockers.join(" | ")}`);
  }
});

test("A5. v6 keeps its declared date — v7 did not take it away", () => {
  assert.equal(findScript("registration", "v6")?.eventAt, "2026-10-04T11:00:00+05:30");
});

// ═════════════════════════════════════════════════════════════════
section("B. EVERY EARLIER VERSION IS BYTE-IDENTICAL");

test("B1. v1-v6 and both reminder scripts hash exactly as they did", () => {
  // Literals, not re-derived: a test that re-hashes the file proves
  // only that the file hashes to whatever it currently is.
  const pinned: Readonly<Record<string, string>> = {
    "registration v6": "de8aede9568acfae24cf84762fc807eeef7362b659f2685c82a87ee58859cb3f",
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

test("B2. v7's own hash is stable and distinct from every other script's", () => {
  const seen = new Map<string, string>();
  for (const key of ["v1", "v2", "v3", "v4", "v5", "v6", "v7"]) {
    const script = findScript("registration", key);
    assert.ok(script, `registration ${key} must be registered`);
    const h = hashScript(script);
    assert.ok(!seen.has(h), `registration ${key} collides with ${seen.get(h)}`);
    seen.set(h, `registration ${key}`);
  }
  assert.equal(hashScript(V7), hashScript(V7), "same input, same hash");
});

// ═════════════════════════════════════════════════════════════════
section("C. THE GATE IS THE APPROVED ANCHOR, AND IT SETTLES FINAL_YES");

test("C1. the approved gate line is in the script, verbatim", () => {
  // Twice: once in the instructions, once in the script body. The
  // wrapped copy is why this reads the flattened text.
  const occurrences = FLAT.split(GATE.toLowerCase()).length - 1;
  assert.ok(occurrences >= 2, `the gate must appear in the instructions AND the body (found ${occurrences})`);
  // The anchor phrase itself. `COMMIT_ANCHORS.registration` carries
  // "reserve your free seat" and is NOT touched by this campaign.
  assert.ok(GATE.toLowerCase().includes("reserve your free seat"));
});

test("C2. a yes at the gate is confirmed_at_gate, FINAL_YES, and sheet-eligible", () => {
  for (const said of ["Yes.", "Yes, please.", "Haan.", "Haan ji, kar dijiye.", "Okay, sure."]) {
    const { outcome, disposition } = settle([
      agent(GREETING),
      agent(`${PITCH} ${DISCOVERY_A}`),
      caller("I'm just starting out, nothing online yet."),
      agent(`${BRIDGE} ${GATE}`),
      caller(said),
      agent(YES_BLOCK),
    ]);
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" must settle at the gate`);
    assert.equal(disposition, "FINAL_YES", `"${said}" must be FINAL_YES`);
    assert.equal(isFinalYes(outcome, disposition), true, `"${said}" must reach the sheet`);
  }
});

test("C3. a no at the gate is not a registration", () => {
  for (const said of ["No, thanks.", "Nahi, mujhe interest nahi hai.", "No, I'm not interested."]) {
    const { outcome, disposition } = settle([
      agent(GREETING),
      agent(`${PITCH} ${DISCOVERY_A}`),
      caller("Yes, I run a small business."),
      agent(`${BRIDGE} ${GATE}`),
      caller(said),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${said}" must never register`);
    assert.equal(isFinalYes(outcome, disposition), false, `"${said}" must not reach the sheet`);
  }
});

test("C4. no block OTHER than the gate is a gate", () => {
  // The gate must be the only line on this call that can register
  // somebody. If the bridge or the [YES] close carried an anchor
  // phrase, a "yes" said after either of them would settle
  // `confirmed_at_gate` — a registration nobody was asked for.
  //
  // Read behaviourally, through the real classifier, rather than by
  // re-listing `COMMIT_ANCHORS` here: this suite must not own a second
  // copy of a table it does not control.
  for (const [label, block] of [
    ["the bridge", BRIDGE],
    ["the [YES] close", YES_BLOCK],
  ] as const) {
    const { outcome, disposition } = settle([agent(GREETING), agent(block), caller("Yes.")]);
    assert.equal(
      outcome.primaryReason,
      "affirmative_not_at_gate",
      `${label} must not read as the commitment question`,
    );
    assert.notEqual(disposition, "FINAL_YES", `a yes after ${label} must not register anybody`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. THE DISCOVERY QUESTION IS NOT THE GATE — BOTH DIRECTIONS");

test("D1. YES to either discovery question registers nobody", () => {
  for (const question of [DISCOVERY_A, DISCOVERY_B]) {
    for (const said of ["Yes.", "Haan.", "Haan ji.", "Yes, I have a business.", "Okay."]) {
      const { outcome, disposition } = settle([
        agent(GREETING),
        agent(`${PITCH} ${question}`),
        caller(said),
      ]);
      assert.notEqual(
        disposition,
        "FINAL_YES",
        `"${said}" to a discovery question must not register anybody`,
      );
      assert.notEqual(
        outcome.primaryReason,
        "confirmed_at_gate",
        `"${said}" to a discovery question must not settle at the gate`,
      );
      assert.equal(isFinalYes(outcome, disposition), false);
    }
  }
});

test("D2. NO to either discovery question does not end the call as a refusal at the gate", () => {
  for (const question of [DISCOVERY_A, DISCOVERY_B]) {
    for (const said of ["No.", "Nahi.", "No, nothing online yet."]) {
      const { outcome } = settle([agent(GREETING), agent(`${PITCH} ${question}`), caller(said)]);
      assert.notEqual(
        outcome.primaryReason,
        "declined_at_gate",
        `"${said}" answers a question about THEM, not the seat`,
      );
    }
  }
});

test("D3. a NO at discovery followed by a YES at the gate still registers", () => {
  // The whole point of asking about them first: "no, I haven't started
  // anything" is the answer this script is written to hear, and it must
  // not poison the yes that comes one exchange later.
  for (const said of ["No, nothing yet.", "Nahi, abhi kuch nahi kiya."]) {
    const { outcome, disposition } = settle([
      agent(GREETING),
      agent(`${PITCH} ${DISCOVERY_A}`),
      caller(said),
      agent(`${BRIDGE} ${GATE}`),
      caller("Yes, go ahead."),
      agent(YES_BLOCK),
    ]);
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `"${said}" then yes must still register`);
    assert.equal(disposition, "FINAL_YES");
  }
});

test("D4. a YES at discovery followed by a NO at the gate does NOT register", () => {
  // The mirror of D3, and the failure that matters more: an early yes
  // must never be reused as the answer to the seat question.
  const { outcome, disposition } = settle([
    agent(GREETING),
    agent(`${PITCH} ${DISCOVERY_A}`),
    caller("Yes, I run a business."),
    agent(`${BRIDGE} ${GATE}`),
    caller("No, not right now."),
  ]);
  assert.notEqual(disposition, "FINAL_YES", "an early yes is not an answer to the gate");
  assert.equal(isFinalYes(outcome, disposition), false);
});

test("D5. the script forbids the unsafe early questions in as many words", () => {
  assert.ok(
    FLAT.includes("never bring it forward into the first exchange"),
    "the gate must be barred from the first exchange",
  );
  assert.ok(
    FLAT.includes("early version of the seat question"),
    "and the script must name the family of questions that must not be asked early",
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. THE VERIFIED FACTS, AND ONLY THEM");

test("E1. every verified event fact is in the text", () => {
  for (const fact of [
    "ai income blueprint",
    "two-day",
    "19th and 20th of september",
    "saturday 19th and sunday 20th september 2026",
    "ten in the morning to twelve noon",
    "one to three in the afternoon",
    "ist",
    "live online, on zoom",
    "completely free",
    "no card is needed",
    "choosing a niche",
    "creating an offer or product",
    "understanding the",
    "getting traffic",
    "getting local clients",
    "improving conversion",
    "automating with ai",
    "scaling revenue",
    "ai business-building tool used during the",
    "free for the event",
    "a website",
    "checkout and collecting",
    "lead forms",
    "follow-ups and automation",
    "from a phone",
    "no coding or technical expertise",
    "saurabh bhatnagar",
    "karthik ramani",
    "co-founder and ceo",
    "co-founder and cto",
  ]) {
    assert.ok(FLAT.includes(fact), `v7 must carry the verified fact "${fact}"`);
  }
});

test("E2. the two-day shape is stated, not implied", () => {
  assert.ok(FLAT.includes("both days"), "both days must be explicit");
  assert.ok(
    FLAT.includes("four scheduled hours on each day") || FLAT.includes("four hours of scheduled live"),
    "the daily length must be stated",
  );
  assert.ok(
    FLAT.includes("two-day journey") && FLAT.includes("build on each other"),
    "the one-day question must be answered without forbidding one-day attendance",
  );
  // The script may not invent a rule barring one-day attendance — and
  // it says so in as many words, which is why the assertion is on the
  // instruction rather than on the absence of a phrase.
  assert.ok(
    FLAT.includes("do not tell them one day is not allowed. you do not know that"),
    "the script must forbid inventing a one-day-attendance rule",
  );
});

test("E3. nothing this campaign is not allowed to say is in the text", () => {
  for (const forbidden of [
    "crore", // company transaction figures
    "19,500", // customer-count figure
    "whatsapp", // no messaging integration exists
    "zoom.us", // no link exists
    "https://", // nor any other URL
    "registration id",
    "guaranteed business",
    "guaranteed revenue",
    "once-in-a-lifetime",
    "act now",
    "you will make money",
  ]) {
    assert.ok(!FLAT.includes(forbidden), `v7 must not contain "${forbidden}"`);
  }
  // The earnings answer exists, and it is a refusal to predict.
  assert.ok(
    FLAT.includes("there isn't a guaranteed income amount"),
    "the earnings answer must be the approved refusal",
  );
  assert.ok(
    FLAT.includes("results depend on the person's market, offer, experience and"),
    "...including why there is no number",
  );
  // "financial freedom" and its family appear exactly once each, inside
  // the sentence that bans them. Asserting the ban rather than the
  // absence is the honest test: the words have to be nameable for the
  // instruction to mean anything.
  assert.ok(
    FLAT.includes(
      "never promise income, clients, revenue, a business, replacing a salary or financial freedom",
    ),
    "the prohibition must name what may not be promised",
  );
});

test("E4. the script promises no delivery, because the system sends nothing", () => {
  assert.ok(
    FLAT.includes("you cannot send anything"),
    "the script must state plainly that the agent sends nothing",
  );
  assert.ok(
    FLAT.includes("do not offer to send anything yourself"),
    "...and must forbid offering to",
  );
  for (const promise of ["i'll send", "i will send", "we'll send", "we will send", "sent to you on"]) {
    assert.ok(!FLAT.includes(promise), `v7 must not promise delivery ("${promise}")`);
  }
});

test("E5. the don't-know answer exists and names what is not known", () => {
  assert.ok(FLAT.includes("i don't want to give you incorrect information"));
  assert.ok(FLAT.includes("do not guess"));
  for (const unknown of ["replay", "what the tool is called", "costs afterwards"]) {
    assert.ok(FLAT.includes(unknown), `the unknowns must name "${unknown}"`);
  }
});

test("E6. v7 constrains no language — the master prompt owns that entirely", () => {
  // The same invariant phase3a test 17 asserts across every script.
  const text = `${APPENDIX} ${V7.openingLineTemplate}`.toLowerCase().replace(/\s+/gu, " ");
  for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
    assert.ok(!text.includes(banned), `v7 must not constrain language: "${banned}"`);
  }
});

test("E7. v7 does not recreate the identity question the pipeline owns", () => {
  assert.ok(
    !FLAT.includes("am i speaking with"),
    "who picked up is asked by handleIdentityGate, before the model is called",
  );
  assert.ok(
    FLAT.includes("do not ask for their name"),
    "and the script must say so, so the model does not ask again",
  );
});

// ═════════════════════════════════════════════════════════════════
section("F. IT COMPOSES INTO A REAL SESSION'S PROMPT");

test("F1. the context interpolates, and leaves no placeholder behind", () => {
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script: V7,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(V7),
  });
  assert.equal(context.scriptVersion, "v7");
  assert.equal(context.openingLine, "Hello, this is Ishita from Team FlexiFunnels.");
  assert.equal(context.identityLine, "Am I speaking with Priya?", "the pipeline's line, not the script's");
  assert.ok(!context.systemPromptAppendix.includes("{{"), "no placeholder may survive");
  assert.ok(context.systemPromptAppendix.includes("Priya"), "the customer name must be interpolated");
  assert.ok(context.systemPromptAppendix.includes("Ishita"), "and the agent name");
});

test("F2. the gate reaches the system prompt, and the policy still follows the script", () => {
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script: V7,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(V7),
  });
  const prompt = buildSystemPrompt(SupportedLanguage.HINGLISH, "female", context.systemPromptAppendix);
  assert.ok(prompt.includes(GATE), "the approved gate must be in the prompt bytes");
  assert.ok(prompt.includes("2-Day AI Income Blueprint Event"), "and the event it invites people to");
  assert.ok(
    prompt.indexOf("--- SCRIPT ---") < prompt.indexOf("WHEN THERE IS A LOT TO SAY"),
    "the conversation policy must still come after the script",
  );
  assert.ok(!prompt.includes("{{"), "no placeholder may survive into the prompt");
});

test("F3. a campaign pinned to v7 refuses to run if the words are edited", () => {
  assert.throws(
    () =>
      buildCampaignContext({
        campaignId: "c1",
        campaignType: "registration",
        script: V7,
        provider: "smallest-ai",
        customerName: "Priya",
        expectedScriptHash: "0".repeat(64),
      }),
    /has changed since this campaign was created/,
  );
});

test("F4. a contact with no name cannot be called on this script", () => {
  assert.throws(
    () =>
      buildCampaignContext({
        campaignId: "c1",
        campaignType: "registration",
        script: V7,
        provider: "smallest-ai",
        customerName: null,
        expectedScriptHash: hashScript(V7),
      }),
    /needs the contact's name/,
  );
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  FAILED: ${name}`);
  process.exitCode = 1;
}
