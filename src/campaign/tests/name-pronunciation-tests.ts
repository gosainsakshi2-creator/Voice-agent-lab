/**
 * name-pronunciation-tests.ts — `npm run test:name-pronunciation`
 *
 * The contact's own name, said the way a person says it.
 *
 * Three things have to hold at once, and they pull against each other,
 * which is why they are asserted together:
 *
 *   A. IT WORKS — the contact's name, and each part of it, is spoken in
 *      Devanagari, in every language, in the lines that actually carry
 *      a name: the campaign opening, the identity line, and model prose.
 *   B. IT IS BOUNDED — ONLY this call's contact name. A table entry can
 *      never fire inside an unrelated word, on somebody else's name, or
 *      on a company or product name.
 *   C. IT COSTS NOTHING AT CALL TIME — the Devanagari is resolved
 *      offline and committed; no lookup, model or network is reachable
 *      from the per-utterance path.
 *
 * NO NETWORK, NO DATABASE, NO VENDOR, NO MODEL.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { spokenNameSubstitutions, lookupSpokenName, applySpokenNames } = await import(
  "../../utils/name-pronunciation"
);
const { pronounceForSpeech } = await import("../../utils/speech-pronunciation");
const { SupportedLanguage } = await import("../../types/enums");
const { VERIFIED_NAMES, GENERATED_NAMES } = await import("../../utils/name-pronunciations.generated");

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

const EN = SupportedLanguage.ENGLISH;
const HI = SupportedLanguage.HINDI;
const HINGLISH = SupportedLanguage.HINGLISH;
const ALL_LANGUAGES = [EN, HI, HINGLISH] as const;

const REPO_ROOT = process.cwd();

/** What actually reaches `synthesize` for one contact, one line. */
const spoken = (line: string, contactName: string, language = HINGLISH) =>
  pronounceForSpeech(line, language, spokenNameSubstitutions(contactName));

// ═════════════════════════════════════════════════════════════════
section("A. THE CONTACT'S NAME IS SPOKEN IN DEVANAGARI");
// ═════════════════════════════════════════════════════════════════

test("A1. the campaign opening — the ONE line that reads out a full name", () => {
  for (const language of ALL_LANGUAGES) {
    assert.equal(
      spoken("Hello, am I speaking with Rahul Sharma?", "Rahul Sharma", language),
      "Hello, am I speaking with राहुल शर्मा?",
      `language ${language}`,
    );
  }
});

test("A2. the pipeline's own identity line", () => {
  assert.equal(
    spoken("Am I speaking with Priya Verma?", "Priya Verma"),
    "Am I speaking with प्रिया वर्मा?",
  );
});

test("A3. the FIRST name in model prose, which is every other mention", () => {
  assert.equal(
    spoken("Hi Rahul, मैं Ishita, Team FlexiFunnels से।", "Rahul Sharma"),
    "Hi राहुल, मैं Ishita, Team FlexiFunnels से।",
  );
  assert.equal(spoken("Thanks for your time, Priya.", "Priya Verma"), "Thanks for your time, प्रिया.");
});

test("A4. the FULL name wins over its parts — no half-Devanagari name", () => {
  // Order matters: if "Rahul" were applied first, the surname would be
  // left in Latin beside a Devanagari given name.
  const line = "Am I speaking with Rahul Sharma?";
  assert.ok(!spoken(line, "Rahul Sharma").includes("Sharma"), "surname left in Latin");
  assert.ok(!spoken(line, "Rahul Sharma").includes("Rahul"), "given name left in Latin");
});

test("A5. casing and spacing in the contact list do not matter", () => {
  for (const asImported of ["Rahul Sharma", "RAHUL SHARMA", "  rahul   sharma  ", "rahul Sharma"]) {
    assert.equal(
      spoken("Am I speaking with Rahul Sharma?", asImported),
      "Am I speaking with राहुल शर्मा?",
      `contact name "${asImported}"`,
    );
  }
});

test("A6. a name with no spelling on file keeps today's behaviour exactly", () => {
  // A miss is never an error and never blocks a call.
  const line = "Am I speaking with Zebediah Quill?";
  assert.equal(spoken(line, "Zebediah Quill"), line);
  assert.deepEqual(spokenNameSubstitutions("Zebediah Quill"), []);
});

test("A7. a contact with no name at all costs nothing and changes nothing", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepEqual(spokenNameSubstitutions(empty), [], `name ${JSON.stringify(empty)}`);
  }
  assert.equal(spoken("Hello there.", ""), "Hello there.");
});

test("A8. applying twice changes nothing — the patterns are Latin-only", () => {
  const subs = spokenNameSubstitutions("Rahul Sharma");
  const once = applySpokenNames("Am I speaking with Rahul Sharma?", subs);
  assert.equal(applySpokenNames(once, subs), once);
});

// ═════════════════════════════════════════════════════════════════
section("B. ONLY THIS CALL'S CONTACT — NOTHING ELSE IS REACHABLE");
// ═════════════════════════════════════════════════════════════════

test("B1. another person's name in the same sentence is untouched", () => {
  assert.equal(
    spoken("Rahul, this is about Priya's booking.", "Rahul Sharma"),
    "राहुल, this is about Priya's booking.",
  );
});

test("B2. a name that is a substring of another word is NOT rewritten", () => {
  // The bound that makes a table safe to grow. Without it, a contact
  // called "Aman" would rewrite the middle of "Amanda" and "permanent".
  const subs = spokenNameSubstitutions("Rahul Sharma");
  for (const line of ["Rahulkumar called.", "xRahul", "Rahuls"]) {
    assert.equal(applySpokenNames(line, subs), line, line);
  }
  // ...and it still fires when the name is a whole word next to
  // punctuation or Devanagari, which JavaScript's \b cannot do.
  assert.equal(applySpokenNames("(Rahul)", subs), "(राहुल)");
  assert.equal(applySpokenNames("तो Rahul जी", subs), "तो राहुल जी");
});

test("B3. company and product names can never be reached", () => {
  // They are not contact names, so no substitution is ever built for
  // them. This is the structural reason, asserted rather than assumed.
  const line = "FlexiFunnels ka free live workshop hai, WhatsApp pe details aayengi.";
  for (const contact of ["Rahul Sharma", "Priya Verma", ""]) {
    assert.equal(spoken(line, contact), line, `contact ${contact}`);
  }
});

test("B4. an initial is skipped — it carries no pronunciation", () => {
  const subs = spokenNameSubstitutions("R. Sharma");
  assert.ok(!subs.some((s) => s.pattern.source.includes("R")), "a one-letter part must not match");
  assert.equal(applySpokenNames("R. Sharma", subs), "R. शर्मा");
});

test("B5. the numeric rules are unaffected by any of this", () => {
  assert.equal(
    spoken("The webinar starts at 7:30 PM.", "Rahul Sharma", HI),
    "The webinar starts at seven thirty PM.",
    "an English sentence on a Hindi call keeps the English number register",
  );
  assert.equal(
    spoken("Rahul, सेशन 7:30 PM पर है।", "Rahul Sharma", HI),
    "राहुल, सेशन saadhe saat baje shaam ko पर है।",
  );
});

// ═════════════════════════════════════════════════════════════════
section("C. NOTHING IN THE CALL PATH COSTS A LOOKUP, A MODEL OR A NETWORK");
// ═════════════════════════════════════════════════════════════════

test("C1. the spellings are committed DATA, not computed at runtime", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/utils/name-pronunciations.generated.ts"),
    "utf8",
  );
  for (const forbidden of ["import ", "require(", "fetch(", "async ", "function "]) {
    assert.ok(!source.includes(forbidden), `the generated table must contain no ${forbidden.trim()}`);
  }
  assert.ok(Object.keys(GENERATED_NAMES).length > 0, "the table must not be empty");
  assert.ok(Object.keys(VERIFIED_NAMES).length > 0, "the hand-verified entries must survive");
});

test("C2. the per-utterance path reads no table — the substitutions are passed in", () => {
  // `pronounceForSpeech` takes the substitutions as an argument, so the
  // table is touched once per SESSION, not once per utterance. If this
  // ever became a lookup, this is where it would be noticed.
  const source = readFileSync(path.join(REPO_ROOT, "src/utils/speech-pronunciation.ts"), "utf8");
  assert.ok(
    !source.includes("lookupSpokenName"),
    "speech-pronunciation must not look names up — they are resolved once per session",
  );
  assert.ok(
    /names: readonly SpokenNameSubstitution\[\] = \[\]/u.test(source),
    "the substitutions must arrive as a parameter, and default to none",
  );
});

test("C3. the pipeline resolves them ONCE, in the constructor", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/core/session/conversation-pipeline.ts"),
    "utf8",
  );
  const calls = source.match(/spokenNameSubstitutions\(/gu) ?? [];
  assert.equal(calls.length, 1, `resolved ${calls.length} times — it must be exactly once per session`);
  assert.ok(
    source.includes("this.spokenNames = spokenNameSubstitutions(record.request.campaign?.customer.name)"),
    "it must be built from the contact name, in the constructor",
  );
  assert.ok(
    source.includes("pronounceForSpeech(text, language, this.spokenNames)"),
    "the synthesize path must pass the pre-resolved substitutions",
  );
});

test("C4. the name modules reach no model and no database", () => {
  // Scoped to the NAME path on purpose. The pipeline imports a language
  // model because running a conversation is its job — asserting
  // otherwise would be asserting nothing about names. What must hold is
  // that the two modules the name path is made of are inert data and
  // pure string work, and that the generator is never imported at all.
  for (const relative of [
    "src/utils/name-pronunciation.ts",
    "src/utils/name-pronunciations.generated.ts",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    assert.ok(!source.includes("language-model"), `${relative}: no model`);
    assert.ok(!source.includes("db/client"), `${relative}: no database`);
    assert.ok(!source.includes("fetch("), `${relative}: no network`);
    assert.ok(!source.includes("node:fs"), `${relative}: no filesystem`);
  }
  const pipeline = readFileSync(
    path.join(REPO_ROOT, "src/core/session/conversation-pipeline.ts"),
    "utf8",
  );
  assert.ok(
    !pipeline.includes("generate-name-pronunciations"),
    "the generator must never be reachable from a live call",
  );
});

test("C5. every table key is already normalized, so no key needs work at call time", () => {
  for (const key of [...Object.keys(VERIFIED_NAMES), ...Object.keys(GENERATED_NAMES)]) {
    assert.equal(key, key.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase(), `key "${key}"`);
    assert.ok(lookupSpokenName(key) !== undefined, `"${key}" must resolve`);
  }
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
