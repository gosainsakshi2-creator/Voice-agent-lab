/**
 * pronunciation-tests.ts — `npm run test:pronunciation`
 *
 * ONE unit under test: `pronounceForSpeech`, the language-aware
 * rewrite applied to the text handed to `synthesize`. Nothing here
 * contacts a vendor, opens a socket, places a call or touches the
 * database.
 *
 * The cases are taken from the approved registration and reminder
 * scripts verbatim — "TODAY at 7:30 PM", "₹1.5 lakh+ worth of
 * exclusive bonuses", "₹1,50,000+" — because those are the exact
 * strings a caller hears mispronounced today.
 *
 * Two properties matter as much as the renderings themselves:
 *
 *  - the SAME input produces a different, correct reading per
 *    language, since one text buffer is spoken by whichever provider
 *    the campaign allocated; and
 *
 *  - ordinary sentences pass through byte-identical. This pass runs on
 *    every utterance of every call, so anything it touches that it had
 *    no business touching is a regression in approved copy.
 */

import assert from "node:assert/strict";

const { pronounceForSpeech } = await import("../../utils/speech-pronunciation");
const { SupportedLanguage } = await import("../../types/enums");

import type { SupportedLanguage as Language } from "../../types/enums";

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
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n         ")}`);
  }
}

const EN = SupportedLanguage.ENGLISH;
const HI = SupportedLanguage.HINDI;
const HINGLISH = SupportedLanguage.HINGLISH;

function speaks(text: string, language: Language, expected: string): void {
  const actual = pronounceForSpeech(text, language);
  assert.equal(actual, expected, `${language}: ${JSON.stringify(text)}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

// ── SECTION A — the reported bug: 7:30 PM ────────────────────────
console.log("\nSECTION A — clock times");

test("English says 7:30 PM as a person does, not digit by digit", () => {
  speaks("Please join TODAY at 7:30 PM.", EN, "Please join TODAY at seven thirty PM.");
});

test("English is case-insensitive about the meridiem and accepts dots", () => {
  speaks("today at 7:30 pm", EN, "today at seven thirty PM");
  speaks("today at 7:30 p.m.", EN, "today at seven thirty PM");
});

test("Hindi says 7:30 PM as saadhe saat baje shaam ko", () => {
  speaks("Aaj 7:30 PM par judiye.", HI, "Aaj saadhe saat baje shaam ko par judiye.");
});

test("Hinglish is read the Hindi way, not the English way", () => {
  speaks("7:30 PM", HINGLISH, "saadhe saat baje shaam ko");
  assert.notEqual(pronounceForSpeech("7:30 PM", HINGLISH), pronounceForSpeech("7:30 PM", EN));
});

test("quarter, half and three-quarter hours use the colloquial Hindi words", () => {
  speaks("11:15 AM", HI, "sawa gyarah baje subah ko");
  speaks("7:45 PM", HI, "paune aath baje shaam ko");
  speaks("1:30 PM", HI, "dedh baje dopahar ko");   // never "saadhe ek"
  speaks("2:30 PM", HI, "dhaai baje dopahar ko");  // never "saadhe do"
});

test("an odd minute falls back to bajkar, with the digits the voice reads itself", () => {
  speaks("7:20 PM", HI, "saat bajkar 20 minute shaam ko");
  speaks("7:20 PM", EN, "seven twenty PM");
});

test("on the hour drops the minutes in both languages", () => {
  speaks("8:00 PM", EN, "eight PM");
  speaks("8:00 PM", HI, "aath baje raat ko");
});

test("single-digit minutes are read as oh-five in English", () => {
  speaks("7:05 PM", EN, "seven oh five PM");
});

test("with no AM/PM the part of day is not invented", () => {
  speaks("7:30", HI, "saadhe saat baje");
  speaks("7:30", EN, "seven thirty");
});

test("a 24-hour time resolves its own part of day", () => {
  speaks("19:30", HI, "saadhe saat baje shaam ko");
  speaks("19:30", EN, "seven thirty PM");
});

test("a ratio or score is not a time and is left alone", () => {
  for (const text of ["a 3:1 ratio", "Section 1:2", "at 7:60 PM"]) {
    speaks(text, EN, text);
    speaks(text, HI, text);
  }
});

// ── SECTION B — amounts from the approved scripts ────────────────
console.log("\nSECTION B — amounts");

test("₹1.5 lakh+ is read naturally in each language", () => {
  speaks(
    "LIVE attendees will also get ₹1.5 lakh+ worth of exclusive bonuses.",
    EN,
    "LIVE attendees will also get 1.5 lakh rupees plus worth of exclusive bonuses.",
  );
  speaks(
    "LIVE attendees ko ₹1.5 lakh+ ke bonuses milenge.",
    HI,
    "LIVE attendees ko dedh lakh rupaye plus ke bonuses milenge.",
  );
});

test("Indian digit grouping is broken into the units it is spoken in", () => {
  speaks("a bonus bundle worth ₹1,50,000+", EN, "a bonus bundle worth 1 lakh 50 thousand rupees plus");
  speaks("bonus bundle ₹1,50,000+ ka hai", HI, "bonus bundle 1 lakh 50 hazaar rupaye plus ka hai");
});

test("other half-figures use dhaai and saadhe in Hindi, plain digits in English", () => {
  speaks("2.5 lakh", HI, "dhaai lakh");
  speaks("3.5 crore", HI, "saadhe teen crore");
  speaks("2.5 lakh", EN, "2.5 lakh");
});

test("a plain rupee figure still gets its currency word", () => {
  speaks("₹500", EN, "500 rupees");
  speaks("₹500", HI, "500 rupaye");
});

test("no ₹ means no currency word invented", () => {
  speaks("1.5 lakh people", EN, "1.5 lakh people");
  speaks("1.5 lakh log", HI, "dedh lakh log");
});

// ── SECTION C — everything it must NOT touch ─────────────────────
console.log("\nSECTION C — passthrough");

test("approved copy with no numeric notation is byte-identical", () => {
  for (const text of [
    "Hi Rahul, this is Priya calling from the FlexiFunnels team.",
    "Actually, I'm calling to invite you to a special LIVE session with Saurabh Sir.",
    "So, would you like me to register you for this special LIVE session?",
    "Awesome! I've registered you for the session.",
    "Aap 5 minutes pehle join kar lijiye.",
  ]) {
    speaks(text, EN, text);
    speaks(text, HI, text);
  }
});

test("bare integers, minutes and version numbers are left as digits", () => {
  for (const text of [
    "within 10 min",
    "preferably 5 minutes before the session",
    "Lightning v3.1",
    "sonic 2 point 0",
  ]) {
    speaks(text, EN, text);
    speaks(text, HI, text);
  }
});

test("empty and whitespace-only text passes straight through", () => {
  speaks("", EN, "");
  speaks("   ", HI, "   ");
});

test("the rewrite is idempotent — a second pass changes nothing", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    for (const text of [
      "See you today at 7:30 PM.",
      "worth ₹1,50,000+ in bonuses",
      "₹1.5 lakh+ worth of exclusive bonuses",
    ]) {
      const once = pronounceForSpeech(text, language);
      assert.equal(pronounceForSpeech(once, language), once, `${language}: ${JSON.stringify(once)}`);
    }
  }
});

test("every sentence of the approved v2 script survives one pass in both languages", () => {
  const script = [
    "Hi Rahul, this is Priya calling from the FlexiFunnels team.",
    "Actually, I'm calling to invite you to a special LIVE session with Saurabh Sir happening TODAY at 7:30 PM.",
    "It's a FREE LIVE session, and LIVE attendees will also get ₹1.5 lakh+ worth of exclusive bonuses.",
    "You'll receive the joining link on your Email and on WhatsApp within 10 min.",
    "Alright? Thank you so much! See you today at 7:30 PM.",
  ];
  for (const language of [EN, HI, HINGLISH] as const) {
    for (const line of script) {
      const spoken = pronounceForSpeech(line, language);
      assert.ok(spoken.length > 0, "no line may be emptied");
      assert.ok(!/[₹:]|\d,\d/u.test(spoken), `unspoken notation left in: ${JSON.stringify(spoken)}`);
    }
  }
});

// ── SECTION D — the utterance decides the numeric register ───────
//
// THE BUG THIS SECTION EXISTS FOR.
//
// `pronounceForSpeech` is handed `memory.currentLanguage` — the CALL's
// language, which the Phase 1.3 lock fixes for the whole call. It was
// never the language of the sentence being spoken, and nothing else in
// the codebase carries one. So on a Hindi- or Hinglish-locked call, an
// assistant sentence written entirely in English had Hindi words
// substituted into it:
//
//   "The webinar will start at 7:30 PM."
//     -> "The webinar will start at saadhe saat baje shaam ko."
//
// The fix is one-directional and lives entirely inside
// `speech-pronunciation.ts`: a NON-English call language may fall back
// to the English register when the utterance itself is clearly English.
// An English call language is never pushed the other way, the `language`
// argument is unchanged, and the value handed to the TTS provider is
// untouched — that is the language lock's job and it keeps it.
//
// WHAT "CLEARLY ENGLISH" HAS TO MEAN, AND WHY IT IS NARROW.
//
// `detectLanguage` was measured against these exact fixtures before
// this was written, and it is NOT usable here: it reports "7:30 PM",
// "₹500", "2.5 lakh" and "11:15 AM" as English on basis
// `default-english` with `isLockGradeEvidence` true. Adopting it would
// have flipped every bare-fragment case in sections A and B — including
// the Hinglish assertion this suite already pins. It is tuned for
// CALLER speech, where a bare fragment carries the previous language
// forward; here a bare fragment carries no evidence at all.
//
// So the rule requires POSITIVE evidence of English and preserves
// today's behaviour otherwise. A4/A5 below pin that: an utterance with
// numerals and nothing else stays Hindi on a Hindi call.

console.log("\nSECTION D — utterance-aware numeric register");

/** The Hindi renderings that must NOT appear in a clearly-English utterance. */
const HINDI_NUMERIC_WORDS =
  /\b(saadhe|sawa|paune|dedh|dhaai|baje|bajkar|shaam|subah|dopahar|raat|hazaar|rupaye|sau)\b/iu;

function speaksEnglishNumerals(text: string, language: Language, mustContain: string): void {
  const spoken = pronounceForSpeech(text, language);
  assert.ok(
    spoken.includes(mustContain),
    `${language}: ${JSON.stringify(text)}\n  expected to contain: ${JSON.stringify(mustContain)}\n  actual: ${JSON.stringify(spoken)}`,
  );
  assert.ok(
    !HINDI_NUMERIC_WORDS.test(spoken),
    `${language}: a clearly English sentence must not receive Hindi numeric wording\n  actual: ${JSON.stringify(spoken)}`,
  );
}

// ── D-A. English numeric pronunciation, in EVERY call language ──

test("A1 — a clearly English sentence reads 7:30 PM the English way in en, hi and hi-en", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaksEnglishNumerals("The webinar will start at 7:30 PM.", language, "seven thirty");
  }
  // The exact English string, so this is not satisfied by some third rendering.
  speaks("The webinar will start at 7:30 PM.", HI, "The webinar will start at seven thirty PM.");
  speaks("The webinar will start at 7:30 PM.", HINGLISH, "The webinar will start at seven thirty PM.");
});

test("A2 — a grouped rupee figure in a clearly English sentence uses English scale words", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaksEnglishNumerals("It is worth ₹1,50,000+ in bonuses.", language, "1 lakh 50 thousand rupees plus");
  }
  speaks("It is worth ₹1,50,000+ in bonuses.", HI, "It is worth 1 lakh 50 thousand rupees plus in bonuses.");
});

test("A3 — a half-lakh figure in a clearly English sentence is not read as dedh", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaksEnglishNumerals("It is worth ₹1.5 lakh+ in bonuses.", language, "1.5 lakh rupees plus");
  }
  speaks("It is worth ₹1.5 lakh+ in bonuses.", HINGLISH, "It is worth 1.5 lakh rupees plus in bonuses.");
});

test("A4 — a bare figure carries NO English evidence, so a Hindi call keeps the Hindi reading", () => {
  // The whole safety property in one test. "7:30 PM" is not an English
  // sentence; it is a notation with no language in it. Treating it as
  // English would be the aggressive guess this fix refuses to make, and
  // would silently un-Hindi every short utterance on a Hindi call.
  speaks("7:30 PM", HI, "saadhe saat baje shaam ko");
  speaks("7:30 PM", HINGLISH, "saadhe saat baje shaam ko");
  speaks("₹500", HI, "500 rupaye");
  speaks("2.5 lakh", HI, "dhaai lakh");
  speaks("11:15 AM", HI, "sawa gyarah baje subah ko");
});

test("A5 — one English word is not enough; the evidence threshold is real", () => {
  // A single function word can appear inside a romanized Hindi sentence
  // by accident. The rule needs more than one before it overrides a
  // locked call's register.
  speaks("at 7:30 PM", HI, "at saadhe saat baje shaam ko");
});

// ── D-B. Pinned behaviour that must not move ────────────────────

test("B1 — 11 AM is untouched in every call language, English sentence or not", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaks("The webinar will start at 11 AM.", language, "The webinar will start at 11 AM.");
    speaks("The session starts at 11 AM.", language, "The session starts at 11 AM.");
  }
});

test("B2 — a spelled-out lakh is untouched in every call language", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaks("It costs one lakh rupees.", language, "It costs one lakh rupees.");
    speaks("You get 1 lakh bonuses.", language, "You get 1 lakh bonuses.");
  }
});

test("B3 — the established ₹2,999 reading is preserved", () => {
  speaks("It is ₹2,999 only.", EN, "It is 2999 rupees only.");
  speaks("It is ₹2,999 only.", HI, "It is 2999 rupees only.");   // clearly English sentence
  speaks("₹2,999", HI, "2999 rupaye");                            // bare figure, Hindi call
});

test("B4 — dates are untouched in every call language", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    speaks("Your slot is on 13/08/2026.", language, "Your slot is on 13/08/2026.");
    speaks("It is on Sunday, 4th October.", language, "It is on Sunday, 4th October.");
  }
});

// ── D-C. Hindi and Hinglish must not regress ────────────────────

test("C1 — a Devanagari sentence still receives the Hindi reading", () => {
  speaks(
    "वेबिनार कल शाम 7:30 बजे शुरू होगा।",
    HI,
    "वेबिनार कल शाम saadhe saat baje शुरू होगा।",
  );
  speaks(
    "वेबिनार कल शाम 7:30 बजे शुरू होगा।",
    HINGLISH,
    "वेबिनार कल शाम saadhe saat baje शुरू होगा।",
  );
});

test("C2 — a romanized Hindi sentence still receives the Hindi reading", () => {
  speaks("Aaj 7:30 PM par judiye.", HI, "Aaj saadhe saat baje shaam ko par judiye.");
  speaks("Aaj 7:30 PM par judiye.", HINGLISH, "Aaj saadhe saat baje shaam ko par judiye.");
});

test("C3 — genuinely code-mixed sentences keep the Hindi reading, English words and all", () => {
  // These carry English CONTENT words ("attendees", "bonuses", "bonus
  // bundle") but romanized Hindi function words, which is exactly what
  // Hinglish is. The rule must not read the English nouns as evidence.
  speaks(
    "LIVE attendees ko ₹1.5 lakh+ ke bonuses milenge.",
    HINGLISH,
    "LIVE attendees ko dedh lakh rupaye plus ke bonuses milenge.",
  );
  speaks("bonus bundle ₹1,50,000+ ka hai", HINGLISH, "bonus bundle 1 lakh 50 hazaar rupaye plus ka hai");
  speaks("1.5 lakh log", HINGLISH, "dedh lakh log");
  speaks("Session 7:30 PM par shuru hoga.", HINGLISH, "Session saadhe saat baje shaam ko par shuru hoga.");
});

test("C4 — the English register is never forced ONTO a Hindi-worded utterance on an English call", () => {
  // One-directional by design: an English call language is left exactly
  // as it was, whatever the utterance looks like. This pins that the fix
  // did not become a two-way rewrite.
  speaks("Aaj 7:30 PM par judiye.", EN, "Aaj seven thirty PM par judiye.");
});

test("C5 — idempotent in every call language, including the overridden path", () => {
  for (const language of [EN, HI, HINGLISH] as const) {
    for (const text of [
      "The webinar will start at 7:30 PM.",
      "It is worth ₹1,50,000+ in bonuses.",
      "Aaj 7:30 PM par judiye.",
      "7:30 PM",
    ]) {
      const once = pronounceForSpeech(text, language);
      assert.equal(pronounceForSpeech(once, language), once, `${language}: ${JSON.stringify(once)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
console.log("No telephony, TTS, STT, LLM or database request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
