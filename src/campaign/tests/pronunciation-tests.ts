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

// ─────────────────────────────────────────────────────────────────
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
console.log("No telephony, TTS, STT, LLM or database request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
