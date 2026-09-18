/**
 * hindi-register-tests.ts — `npm run test:hindi-register`
 *
 * WHAT "IN THE WORDS IT IS WRITTEN" MEANS WHEN THE CALL IS IN HINDI.
 *
 * ── The defect ───────────────────────────────────────────────────
 *
 * The approved scripts are written in English. `conversation-policy.ts`
 * told the model to follow the script "in the words it is written", and
 * `system-prompt.ts` separately told it never to translate literally.
 * On an English call those two never meet. On a Hindi call they collide
 * — and the script wins, because it is authoritative by design and the
 * policy is read last — so the English sentence came across word by
 * word into formal Hindi.
 *
 * ── Why it is a correctness bug and not a style complaint ────────
 *
 * Section B is the whole argument, and it is a measurement rather than
 * an opinion: the literally-translated gate matches NO entry in
 * `COMMIT_ANCHORS` / `GATE_ACTIONS`, so a Hindi caller's "haan ji" to
 * it settles `affirmative_not_at_gate` / UNRESOLVED. No FINAL_YES, no
 * registrations-sheet row, no auto-hangup. The naturally-spoken gate
 * matches and settles `confirmed_at_gate` / FINAL_YES.
 *
 * Speaking naturally is therefore the SAFER behaviour here, and that is
 * what makes a prompt-layer fix worth making: the classifier is not
 * touched, and the change moves Hindi calls from "silently lost" to
 * "recorded exactly like an English one".
 *
 * ── What this suite can and cannot prove ─────────────────────────
 *
 * It asserts the INSTRUCTION and the READERS, which are deterministic.
 * It does not assert what a language model chooses to say — that is a
 * distribution, not a fact, and one sample would prove nothing (see the
 * A/B note in `conversation-policy.ts`). Section D is the honest
 * boundary: everything the fix must NOT have moved.
 *
 * NO NETWORK, NO DATABASE, NO VENDOR. Every module is the real one.
 */

import assert from "node:assert/strict";

const { CAMPAIGN_CONVERSATION_POLICY, CONVERSATION_POLICY_ID } = await import(
  "../script/conversation-policy"
);
const { buildCampaignContext } = await import("../domain/campaign-context");
const { findScript, hashScript, defaultScriptFor } = await import("../script/script-registry");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes } = await import("../integrations/final-yes-sheet");
const { buildSystemPrompt } = await import("../../core/session/system-prompt");
const { SupportedLanguage } = await import("../../types/enums");

import type { TranscriptTurn } from "../outcome/transcript";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 5).join("\n         ")}`,
    );
  }
}

const section = (title: string) => console.log(`\n${title}`);

const POLICY = CAMPAIGN_CONVERSATION_POLICY.toLowerCase().replace(/\s+/gu, " ");
const turn = (role: TranscriptTurn["role"], text: string): TranscriptTurn =>
  ({ role, text }) as TranscriptTurn;
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

const GREETING = "Hello, this is Ishita from Team FlexiFunnels.";

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

/** A gate asked in `gate`, answered `yes`. Did it register? */
function registersWith(gate: string, yes: string): boolean {
  const { outcome, disposition } = settle([agent(GREETING), agent(gate), caller(yes)]);
  return (
    outcome.primaryReason === "confirmed_at_gate" &&
    disposition === "FINAL_YES" &&
    isFinalYes(outcome, disposition)
  );
}

// ═════════════════════════════════════════════════════════════════
section("A. THE INSTRUCTION EXISTS, AND IT IS SCOPED TO A NON-ENGLISH CALL");

test("A1. the policy says what 'in the words it is written' means in Hindi", () => {
  assert.ok(POLICY.includes("if the call is not in english"), "the section must exist");
  assert.ok(
    POLICY.includes("the script's meaning, its facts and its questions"),
    "it must fix meaning, facts and questions as the invariant",
  );
  assert.ok(
    POLICY.includes("not mean the english sentence carried across word by word"),
    "...and name the failure it is correcting",
  );
});

test("A2. it is explicitly conditional — English is never addressed by it", () => {
  // The heading itself carries the condition, which is what keeps an
  // English call from reading any of this as applying to it.
  assert.ok(POLICY.includes("if the call is not in english"));
  assert.ok(
    POLICY.includes("when you are speaking hindi or a natural hindi-english mix"),
    "the rule must state the condition in its own sentence too",
  );
});

test("A3. it changes HOW the words are said and nothing else", () => {
  for (const required of [
    "every fact stays the fact",
    "every question stays the question",
    "you still ask one thing at a time",
    "the steps keep their order",
    "you invent nothing",
    "never about which words they are",
  ]) {
    assert.ok(POLICY.includes(required), `the policy must still hold "${required}"`);
  }
});

test("A4. the commitment question is called out and its action words protected", () => {
  assert.ok(
    POLICY.includes("keep the plain words for the thing you are offering to do"),
    "the gate's action words must be protected explicitly",
  );
  assert.ok(POLICY.includes("reserve, book, seat"), "...and named");
  assert.ok(
    POLICY.includes("how this call is recorded as a yes"),
    "...with the reason, so it is not edited away as decoration",
  );
});

test("A5. the policy id was bumped, so a call can be attributed to it", () => {
  assert.equal(CONVERSATION_POLICY_ID, "script-faithful.v5");
});

// ═════════════════════════════════════════════════════════════════
section("B. THE MEASUREMENT — WHY THIS IS A CORRECTNESS FIX");

/** The English gate, verbatim from the approved scripts. `COMMIT_ANCHORS` carries it. */
const GATE_EN = "Would you like me to reserve your free seat?";
/** The same question, translated literally. This is the reported production behaviour. */
const GATE_TRANSLATED =
  "क्या आप चाहेंगे कि मैं आपके लिए इस कार्यक्रम के लिए आपकी मुफ़्त सीट आरक्षित कर दूँ?";
/** The same question, said the way a person says it. This is the desired behaviour. */
const GATE_NATURAL = "क्या मैं आपके लिए एक free seat reserve कर दूँ?";

test("B1. the English gate registers — the baseline, unchanged", () => {
  for (const yes of ["Yes.", "Haan ji.", "Okay, sure."]) {
    assert.equal(registersWith(GATE_EN, yes), true, `"${yes}" must register`);
  }
});

test("B2. THE DEFECT — the literally translated gate LOSES the registration", () => {
  // Pinned as the reason this change exists. "आरक्षित" is in no
  // `GATE_ACTIONS` entry, because it is not a word anybody says on a
  // phone. A real yes to this sentence reaches neither the sheet nor
  // the auto-hangup.
  for (const yes of ["Haan ji.", "Yes.", "जी हाँ."]) {
    const { outcome, disposition } = settle([agent(GREETING), agent(GATE_TRANSLATED), caller(yes)]);
    assert.equal(registersWith(GATE_TRANSLATED, yes), false, `"${yes}" is lost today`);
    assert.equal(outcome.primaryReason, "affirmative_not_at_gate");
    assert.notEqual(disposition, "FINAL_YES");
  }
});

test("B3. THE FIX'S DIRECTION — the naturally spoken gate registers correctly", () => {
  for (const yes of ["Haan ji.", "Yes.", "जी हाँ.", "Bilkul."]) {
    assert.equal(registersWith(GATE_NATURAL, yes), true, `"${yes}" must register`);
  }
});

test("B4. the other natural Hindi phrasings the policy licenses also register", () => {
  for (const gate of [
    "क्या मैं आपकी सीट बुक कर दूँ?",
    "Kya main aapke liye ek free seat reserve kar du?",
    "Main aapki free seat reserve kar du?",
  ]) {
    assert.equal(registersWith(gate, "Haan ji."), true, `must register: ${gate}`);
  }
});

test("B5. a NO to a naturally spoken gate is still a refusal, not a registration", () => {
  for (const no of ["Nahi.", "नहीं, मुझे नहीं चाहिए.", "No, thanks."]) {
    const { outcome, disposition } = settle([agent(GREETING), agent(GATE_NATURAL), caller(no)]);
    assert.notEqual(disposition, "FINAL_YES", `"${no}" must never register`);
    assert.equal(isFinalYes(outcome, disposition), false);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. THE INSTRUCTION REACHES A REAL SESSION'S PROMPT");

test("C1. a campaign session carries the policy, after the script", () => {
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(script),
  });
  assert.equal(context.conversationPolicyId, "script-faithful.v5");
  const prompt = buildSystemPrompt(SupportedLanguage.HINDI, "female", context.systemPromptAppendix);
  assert.ok(prompt.includes("IF THE CALL IS NOT IN ENGLISH"), "the section must be in the bytes");
  assert.ok(
    prompt.indexOf("--- SCRIPT ---") < prompt.indexOf("IF THE CALL IS NOT IN ENGLISH"),
    "the policy must still come after the script",
  );
  assert.ok(!prompt.includes("{{"), "no placeholder may survive");
});

test("C2. it reaches an English session's prompt too, and says nothing to it", () => {
  // The section is present in every call's bytes — the policy is one
  // string — and is self-limiting by its own condition. Asserted so
  // nobody "fixes" this by branching the policy per language, which
  // would make the prompt differ per call and be far harder to reason
  // about than a conditional sentence.
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: hashScript(script),
  });
  const en = buildSystemPrompt(SupportedLanguage.ENGLISH, "female", context.systemPromptAppendix);
  const hi = buildSystemPrompt(SupportedLanguage.HINDI, "female", context.systemPromptAppendix);
  assert.ok(en.includes("IF THE CALL IS NOT IN ENGLISH"));
  assert.equal(
    en.slice(en.indexOf("# HOW TO RUN THIS SCRIPT ON A LIVE CALL")),
    hi.slice(hi.indexOf("# HOW TO RUN THIS SCRIPT ON A LIVE CALL")),
    "the policy text must be identical for every language",
  );
});

// ═════════════════════════════════════════════════════════════════
section("D. NOTHING ELSE MOVED");

test("D1. no approved script hash changed — the policy is outside the hash", () => {
  const pinned: Readonly<Record<string, string>> = {
    "registration v7": "ed1c1e81d9a3493eab4474ffc7cf840520a000baec325f94923e92430fc76926",
    "registration v6": "de8aede9568acfae24cf84762fc807eeef7362b659f2685c82a87ee58859cb3f",
    "registration v5": "86cd439509f902097656b0ec9093458279b920ad20562a4ed59aa111e5c9fc2b",
    "registration v4": "e87faaccb3a9064d112fb173abbbed4c8bccb6dd5aeec3f22995b6f9a8ad4358",
    "registration v3": "8e65a82ebec46e2b42668bb09bca508bec5fdcd89a9357b0d12724d2b103b3c2",
    "registration v2": "5760453b3d7ece12d2472a21c4b4a4bec6fb90f238be4f8cdb515b7b4617001b",
    "registration v1": "058b3b70ba733bb950e887cf67178dfe36756bb2bdfcbb80c12825dd341adcc3",
    "reminder v2": "e6095467a29c3cd20411b3c726b763ad264a0a4122d472eca85140897441bf01",
    "reminder v1": "44da949d883bb4be02001ded51d5dc2255b0661587822a12f1bf27fb05cf0a4e",
  };
  for (const [key, expected] of Object.entries(pinned)) {
    const [id, version] = key.split(" ") as [string, string];
    const script = findScript(id, version);
    assert.ok(script, `${key} must still be registered`);
    assert.equal(hashScript(script), expected, `${key} changed`);
  }
});

test("D2. the approved English gate is still the anchor, word for word", () => {
  const shipping = defaultScriptFor("registration");
  assert.ok(shipping.systemPromptAppendix.includes(GATE_EN), "the shipping gate must not move");
  assert.ok(findScript("registration", "v7")!.systemPromptAppendix.includes(GATE_EN));
});

test("D3. the policy did not gain a step, a question or a claim", () => {
  for (const banned of [
    "what is your budget",
    "how many employees",
    "your monthly revenue",
    "guaranteed",
  ]) {
    assert.ok(!POLICY.includes(banned), `the policy must not introduce "${banned}"`);
  }
  // The rules the new section must not have displaced.
  for (const required of [
    "you do not invent questions",
    "never repeat the opening line",
    "a question is not an answer",
    "when there is a lot to say",
    "before the pitch, know who you are talking to",
    "do not oversell",
  ]) {
    assert.ok(POLICY.includes(required), `the policy must still address "${required}"`);
  }
});

test("D4. the identity line is untouched and still commits nobody", () => {
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Sakshi",
    expectedScriptHash: hashScript(script),
  });
  assert.equal(context.identityLine, "Am I speaking with Sakshi?");
  for (const said of ["Haan ji.", "Yes.", "जी हाँ."]) {
    const { outcome, disposition } = settle([
      agent(GREETING),
      agent("Am I speaking with Sakshi?"),
      caller(said),
    ]);
    assert.notEqual(disposition, "FINAL_YES", `"${said}" to the identity line must not register`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
console.log("No telephony, TTS, STT, LLM or database request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  FAILED: ${name}`);
  process.exitCode = 1;
}
