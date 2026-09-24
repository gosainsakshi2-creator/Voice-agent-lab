/**
 * registration-v16-tests.ts — `npm run test:registration-v16`
 *
 * v15'S CALL, SPELLED THE WAY IT IS SPOKEN.
 *
 * `registration v16` changes exactly one thing about v15: the Hinglish
 * twin of every line is written with its Hindi words in DEVANAGARI and
 * its English terms in LATIN, instead of being romanized end to end.
 * The event, the facts, the two questions, the gate, the branches and
 * every English line are v15's, word for word.
 *
 * This suite does NOT re-run v15's suite against v16. That file already
 * asserts the shape and the facts, and duplicating it would say nothing
 * new. What this one asks is the three questions the RESPELLING makes
 * answerable, and only those:
 *
 *   B. did the spelling rule actually get applied — Devanagari where
 *      Hindi is spoken, Latin where the business terms are, and the
 *      gate's own English nouns left alone;
 *   C. does a "haan" still REGISTER — not only to v16's gate as
 *      written, but to every mixed-script spelling the model can
 *      produce instead, because the model writes the prose and not the
 *      script file. This is the section that matters: the failure it
 *      guards is silent, and costs a real registration;
 *   D. do v16's Devanagari lines reach TTS unchanged, or does a
 *      last-mile rule quietly rewrite one of them.
 *
 * A asserts what v16 IS in the registry — registered, dated, and
 * deliberately NOT the default — and that v15 was not edited to make
 * room for it.
 *
 * Everything here is deterministic. What the model says on a live call
 * is a distribution and is not asserted. NO NETWORK, NO DATABASE, NO
 * VENDOR.
 */

import assert from "node:assert/strict";

const { findScript, hashScript, defaultScriptFor, listScripts, scriptVariables } = await import(
  "../script/script-registry"
);
const { validateCampaignScript } = await import("../script/script-validation");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { formatForSpeech } = await import("../../utils/speech-formatter");
const { pronounceForSpeech } = await import("../../utils/speech-pronunciation");
const { SupportedLanguage } = await import("../../types/enums");

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

const V16 = findScript("registration", "v16");
assert.ok(V16, "registration v16 must be registered before this suite can run");
const V15 = findScript("registration", "v15");
assert.ok(V15, "registration v15 must still be registered — v16 is its successor, not its editor");

const APPENDIX = V16.systemPromptAppendix;
const BODY = APPENDIX.slice(APPENDIX.indexOf("--- SCRIPT ---"));

const NAME = "Rahul";
const FULL_NAME = "Rahul Sharma";
const OPENING = `Hello, am I speaking with ${FULL_NAME}?`;

/** v16's Hinglish lines, as the script file writes them. */
const FIRST_HI =
  `Hi ${NAME}, मैं Ishita, Team FlexiFunnels से। Sunday, 4th October को 11 AM पर हमारा एक free ` +
  `live workshop है, जिसमें हम एक पूरा online business live बनाते हैं — website, product, ` +
  `checkout और payments — सब एक phone से। आपने पहले कभी कुछ online डालने की try की है?`;
const DISCOVERY_HI = "आपने पहले कभी कुछ online डालने की try की है?";
const BRIDGE_HI = "इसके लिए कोई coding या design skill नहीं चाहिए।";
const GATE_HI = "तो क्या मैं आपकी free seat reserve कर दूँ?";
const YES_HI =
  `Perfect, ${NAME} — आपकी free seat Sunday, 4th October, 11 AM के लिए reserve हो गयी है, और ` +
  `joining details आपको WhatsApp और email पे मिल जाएँगी। Live join करेंगे तो Launch-In-A-Day ` +
  `Starter Kit भी मिलेगा, worth ₹1,50,000+, एक live Q&A session और end में एक special reveal. ` +
  `Hope to see you there!`;
const ALREADY_HI =
  `अरे वाह, बढ़िया — तो आप Sunday, 4th October, 11 AM के लिए all set हैं। थोड़ा पहले join कर लेना।`;
const DONT_KNOW_HI = "वो detail मेरे पास नहीं है, तो guess करना ठीक नहीं होगा।";

/** v15's English lines, which v16 must carry verbatim. */
const GATE_EN = "Would you like me to reserve your free seat?";
const DISCOVERY_EN = "Have you tried putting something online before?";
const BRIDGE_EN = "You won't need any coding or design skills for this.";
const NO_BLOCK = `Okay, no problem at all. Thanks for your time, ${NAME}.`;

const DEVANAGARI = /[ऀ-ॿ]/u;

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

/** The agent asks `gate`, the caller says yes. */
const gateExchange = (gate: string) => [
  agent(OPENING), caller("Haan ji, bol raha hoon."),
  agent(gate), caller("Haan, kar dijiye."),
];

const validationFor = (script: CampaignScript, now: Date) => ({
  campaignType: script.campaignType,
  scriptId: script.id,
  scriptVersion: script.version,
  scriptHash: hashScript(script),
  allocatedProviders: ["cartesia"] as const,
  contactsMissingName: 0,
  now,
});

/** What actually reaches `synthesize` for one spoken line. */
const asSpoken = (line: string) =>
  pronounceForSpeech(formatForSpeech(line), SupportedLanguage.HINGLISH);

// ═════════════════════════════════════════════════════════════════
section("A. REGISTERED, DATED, AND DELIBERATELY NOT THE DEFAULT");
// ═════════════════════════════════════════════════════════════════

test("A1. v16 is registered and listed second — v15 is still what an unnamed campaign dials", () => {
  assert.equal(V16.version, "v16");
  assert.equal(V16.campaignType, "registration");
  assert.equal(V16.isPlaceholder, false);
  assert.equal(V16.requiresName, true, "the identity opening needs the name");
  assert.equal(V16.eventAt, V15.eventAt, "same workshop as v15, so the same instant");
  assert.deepEqual(scriptVariables(V16), ["agent_name", "customer_name"]);
  // The whole point of leaving it second: nobody has HEARD it yet, and
  // a default runs without anyone choosing it. Promoting it is one move
  // in the registry, and this assertion is what makes that move visible.
  assert.equal(
    defaultScriptFor("registration").version,
    "v15",
    "v16 must NOT be the default until somebody has listened to it",
  );
  const registration = listScripts().filter((s) => s.campaignType === "registration").map((s) => s.version);
  assert.deepEqual(registration.slice(0, 3), ["v15", "v16", "v6"]);
});

test("A2. v15 IS UNCHANGED — v16 exists so that it did not have to be edited", () => {
  assert.equal(
    V15.openingLineTemplate,
    "Hello, am I speaking with {{customer_name}}?",
    "v15's opening must stay exactly as approved",
  );
  assert.equal(V16.openingLineTemplate, V15.openingLineTemplate, "v16 keeps v15's opening");
  for (const other of listScripts()) {
    if (other !== V16) assert.notEqual(hashScript(other), hashScript(V16), "v16 must be its own script");
  }
});

test("A3. preflight dials up to the workshop and refuses once it has started", () => {
  assert.equal(validateCampaignScript(validationFor(V16, new Date("2026-09-24T10:00:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V16, new Date("2026-10-04T10:59:00+05:30"))).ok, true);
  assert.equal(validateCampaignScript(validationFor(V16, new Date("2026-10-04T11:01:00+05:30"))).ok, false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE SPELLING RULE — DEVANAGARI FOR HINDI, LATIN FOR THE TERMS");
// ═════════════════════════════════════════════════════════════════

test("B1. every Hinglish line in the script body is written in Devanagari", () => {
  const hinglishLines = BODY.split("\n").filter((line) => line.includes("In Hinglish:"));
  assert.ok(hinglishLines.length >= 4, `expected v15's four Hinglish twins, found ${hinglishLines.length}`);
  for (const line of hinglishLines) {
    assert.ok(DEVANAGARI.test(line), `still romanized: ${line.trim().slice(0, 70)}`);
  }
});

test("B2. the romanized spellings v15 used are GONE from the Hinglish lines", () => {
  // The exact tokens v15's twins were built from. One of these surviving
  // means a line was half-converted, which is the state that looks
  // finished and is not.
  const ROMANIZED = ["nahi chahiye", "kar du?", "aapki free seat", "ho gayi hai", "mil jaayengi",
    "ke liye all set", "kar lena", "mere paas nahi hai", "banate hain", "try ki hai"];
  const hinglish = BODY.split("\n").filter((line) => line.includes("In Hinglish:")).join("\n");
  for (const token of ROMANIZED) {
    assert.ok(!hinglish.includes(token), `v15's romanized "${token}" is still in a v16 Hinglish line`);
  }
});

test("B3. the English business terms stay in Latin — this is Hinglish, not translated Hindi", () => {
  // Translating these is the textbook Hindi the script forbids, and it
  // is also what breaks the gate. Asserted on the lines that carry them.
  for (const term of ["free", "live", "workshop", "online", "business", "website", "product",
    "checkout", "payments", "phone", "try"]) {
    assert.ok(FIRST_HI.includes(term), `the first reply must keep "${term}" in English`);
  }
  for (const term of ["coding", "design", "skill", "free seat reserve"]) {
    assert.ok(`${BRIDGE_HI} ${GATE_HI}`.includes(term), `the bridge and gate must keep "${term}" in English`);
  }
  for (const term of ["WhatsApp", "email", "joining details", "session"]) {
    assert.ok(YES_HI.includes(term), `the [YES] block must keep "${term}" in English`);
  }
  // Devanagari transliterations of the same terms, which B1 would pass.
  for (const wrong of ["वेबसाइट", "बिज़नेस", "वर्कशॉप", "कोडिंग", "डिज़ाइन", "ईमेल", "मुफ़्त", "सीट"]) {
    assert.ok(!BODY.includes(wrong), `"${wrong}" is a transliterated English term — keep it in Latin`);
  }
});

test("B4. the appendix TELLS the model the spelling rule, and names the gate's English words", () => {
  const head = APPENDIX.slice(0, APPENDIX.indexOf("--- SCRIPT ---"));
  assert.ok(
    /WRITE THE HINDI WORDS IN DEVANAGARI/u.test(head),
    "the model writes the prose, so the rule has to be in the instruction, not only in the lines",
  );
  assert.ok(
    head.includes("free seat reserve"),
    "the appendix must name the three words that must stay in English letters",
  );
  // v15's own ban on textbook Hindi survives — the new rule must not be
  // read as licence to translate.
  assert.ok(/[Nn]ever textbook\s+Hindi/u.test(head.replace(/\s+/gu, " ")));
});

test("B5. v15's English lines are carried verbatim — only the spelling of the Hinglish moved", () => {
  for (const line of [GATE_EN, DISCOVERY_EN, BRIDGE_EN, NO_BLOCK.replace(`, ${NAME}.`, ", [first name].")]) {
    assert.ok(APPENDIX.includes(line) || BODY.includes(line), `English line missing from v16: ${line}`);
  }
  // The [NO] block and the goodbye stay English-only, exactly as v15 —
  // a decline closes through a different reader than a confirmation,
  // and giving them a Devanagari twin is a separate, measured change.
  const noBlock = BODY.slice(BODY.indexOf("[NO"), BODY.indexOf("[ALREADY REGISTERED]"));
  assert.ok(!DEVANAGARI.test(noBlock), "the [NO] block must stay English-only in v16");
});

// ═════════════════════════════════════════════════════════════════
section("C. A YES STILL REGISTERS — IN EVERY SPELLING THE MODEL CAN PRODUCE");
// ═════════════════════════════════════════════════════════════════

test("C1. v16's gate, as written, settles confirmed_at_gate and FINAL_YES", () => {
  const { outcome, disposition } = settle(gateExchange(`${BRIDGE_HI} ${GATE_HI}`));
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(outcome.succeeded, true);
  assert.equal(disposition, "FINAL_YES");
});

test("C2. the gate survives the model spelling it differently — the silent failure this guards", () => {
  // v16 keeps "free seat reserve" in Latin, but the MODEL writes the
  // prose. Before the mixed-script entries were added to COMMIT_ANCHORS
  // and GATE_ACTIONS, every one of these settled affirmative_not_at_gate
  // — a person who said yes, recorded as merely interested, with no
  // sheet row, no FINAL_YES, no hangup and no error anywhere.
  const DRIFT = [
    "तो क्या मैं आपकी free सीट reserve कर दूँ?",
    "तो क्या मैं आपकी free seat रिज़र्व कर दूँ?",
    "तो क्या मैं आपकी free seat पक्की कर दूँ?",
    "तो क्या मैं आपकी मुफ़्त सीट आरक्षित कर दूँ?",
    "तो क्या मैं आपको register कर दूँ?",
    "तो क्या मैं आपकी सीट बुक कर दूँ?",
  ];
  for (const gate of DRIFT) {
    const { outcome, disposition } = settle(gateExchange(gate));
    assert.equal(outcome.primaryReason, "confirmed_at_gate", `not a registration: ${gate}`);
    assert.equal(disposition, "FINAL_YES", `no sheet row: ${gate}`);
  }
});

test("C3. v15's romanized gate still registers — v16 must not cost v15 anything", () => {
  const { outcome, disposition } = settle(gateExchange("Toh kya main aapki free seat reserve kar du?"));
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
});

test("C4. NOTHING before the gate registers, in Devanagari either", () => {
  // The discovery question asks about THEM and offers nothing; the
  // first reply offers nothing either. A "haan" to either one is not a
  // registration, and the new anchors must not have made it one.
  for (const line of [DISCOVERY_HI, FIRST_HI, `Hi ${NAME}. ${DISCOVERY_HI}`]) {
    for (const said of ["Haan.", "हाँ।", "Haan ji.", "Yes.", "बिल्कुल।"]) {
      const { outcome, disposition } = settle([
        agent(OPENING), caller("Haan ji."),
        agent(line), caller(said),
      ]);
      assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `"${said}" to a pre-gate line registered`);
      assert.notEqual(disposition, "FINAL_YES", `"${said}" to a pre-gate line reached the sheet`);
    }
  }
});

test("C5. the post-gate blocks are not themselves gates", () => {
  // The [YES] block says "free seat ... reserve हो गयी है" and the
  // already-registered block says "all set" — neither asks anything, so
  // neither may register somebody on the next "haan". The anchors added
  // for v16 are verb-bound precisely so this stays true.
  for (const line of [YES_HI, ALREADY_HI]) {
    const { outcome } = settle([
      agent(OPENING), caller("Haan ji."),
      agent(line), caller("Haan."),
    ]);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate", `a closing block registered: ${line.slice(0, 40)}`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. THE DEVANAGARI REACHES TTS AS WRITTEN");
// ═════════════════════════════════════════════════════════════════

test("D1. the spoken Hinglish lines survive formatForSpeech + pronounceForSpeech byte for byte", () => {
  // `formatForSpeech` rewrites some Devanagari outright — धन्यवाद becomes
  // "Thank you", निश्चित रूप से becomes "Bilkul". A v16 line that
  // reached for one of those would be silently re-worded on the way to
  // the vendor, and nothing downstream would say so.
  for (const line of [FIRST_HI, `${BRIDGE_HI} ${GATE_HI}`, ALREADY_HI, DONT_KNOW_HI]) {
    assert.equal(asSpoken(line), line, `rewritten on the way to TTS: ${line.slice(0, 50)}`);
  }
});

test("D2. the [YES] block changes ONLY where the rupee figure is spoken out", () => {
  // `pronounceForSpeech` turns "₹1,50,000+" into the words a Hindi
  // speaker says, which is its job and is v15's behaviour too. Nothing
  // else in the block may move.
  const spoken = asSpoken(YES_HI);
  assert.notEqual(spoken, YES_HI, "the rupee figure is expected to be spoken out");
  assert.ok(!spoken.includes("₹"), "the rupee sign must not reach the vendor");
  assert.equal(
    spoken.replace("1 lakh 50 hazaar rupaye plus", "₹1,50,000+"),
    YES_HI,
    "only the amount may differ",
  );
});

test("D3. the gate's English words are still English AFTER the transform", () => {
  // This is the one that ties D back to C: whatever the last-mile
  // rewrite does, "free seat reserve" has to survive it, or the anchor
  // matches the script but not the audio's transcript.
  assert.ok(asSpoken(`${BRIDGE_HI} ${GATE_HI}`).includes("free seat reserve"));
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
