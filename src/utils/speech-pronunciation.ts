/**
 * speech-pronunciation.ts
 *
 * Language-aware pronunciation of numeric expressions, applied to the
 * text handed to TTS — and to nothing else.
 *
 * The approved campaign scripts are written for the eye, not the ear:
 * "TODAY at 7:30 PM", "₹1.5 lakh+", "₹1,50,000+". Every TTS engine
 * reads those literally, and every engine gets them wrong in its own
 * way — a Hindi voice renders "7:30" digit-by-digit, an English voice
 * reads the Indian digit grouping "1,50,000" as three separate
 * numbers. The script text is pinned by content hash and MUST NOT be
 * edited to fix this, and the transcript, the classifier and the sheet
 * must keep seeing the original wording. So the rewrite happens at the
 * last possible moment: on the string passed to `synthesize`, per
 * utterance, in the language the caller is currently spoken to in.
 *
 * Two renderings of the same value, chosen by conversation language:
 *
 *   "7:30 PM"    en -> "seven thirty PM"
 *                hi -> "saadhe saat baje shaam ko"
 *   "₹1.5 lakh+" en -> "1.5 lakh rupees plus"
 *                hi -> "dedh lakh rupaye plus"
 *   "₹1,50,000+" en -> "1 lakh 50 thousand rupees plus"
 *                hi -> "1 lakh 50 hazaar rupaye plus"
 *
 * Bare integers are deliberately left as digits. Every engine already
 * reads "50" correctly IN ITS OWN LANGUAGE ("fifty" / "pachaas"), so
 * spelling them out would need a large number-to-words table whose
 * only achievement is to throw that away. What actually breaks TTS is
 * the NOTATION — the colon in a clock time, the Indian comma grouping,
 * the "₹" and "+" symbols, and the ".5" that a Hindi voice says as
 * "point paanch" where a person says "dedh". Those, and only those,
 * are rewritten.
 *
 * Pure and provider-agnostic: Cartesia, Smallest AI, Sarvam and
 * ElevenLabs all receive already-pronounced text, so no vendor adapter
 * needs to know this exists.
 */

import { SupportedLanguage } from "../types/enums";

/**
 * Hindi/Hinglish cardinals, romanized to match how the rest of the
 * spoken text is written — the campaign scripts and
 * `speech-formatter`'s substitutions are romanized Hinglish, not
 * Devanagari. Indexed by value; 0-20 is all this module needs: clock
 * hours, and the whole part of a "X.5 lakh" figure.
 */
const HINDI_CARDINALS = [
  "shunya", "ek", "do", "teen", "chaar", "paanch", "chhe", "saat", "aath",
  "nau", "das", "gyarah", "barah", "terah", "chaudah", "pandrah", "solah",
  "satrah", "atharah", "unnees", "bees",
] as const;

const ENGLISH_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
] as const;

const ENGLISH_TENS = ["", "", "twenty", "thirty", "forty", "fifty"] as const;

/** "12" is the hour word for both noon and midnight. */
function hindiHour(hour12: number): string {
  return HINDI_CARDINALS[hour12 === 0 ? 12 : hour12] ?? String(hour12);
}

function englishHour(hour12: number): string {
  return ENGLISH_ONES[hour12 === 0 ? 12 : hour12] ?? String(hour12);
}

function englishBelowHundred(value: number): string {
  if (value < 20) return ENGLISH_ONES[value] ?? String(value);
  const tens = ENGLISH_TENS[Math.floor(value / 10)] ?? String(value);
  const ones = value % 10;
  return ones === 0 ? tens : `${tens} ${ENGLISH_ONES[ones]}`;
}

/**
 * The part of day a Hindi speaker names a time with. Only used when
 * AM/PM is actually known — inventing "shaam" for a bare "7:30" would
 * be adding information the text did not carry.
 */
function hindiDaypart(hour24: number): string {
  if (hour24 >= 4 && hour24 <= 11) return "subah";
  if (hour24 >= 12 && hour24 <= 15) return "dopahar";
  if (hour24 >= 16 && hour24 <= 19) return "shaam";
  return "raat";
}

/**
 * Clock times. The minute is always two digits, so ratios and scores
 * ("3:1", "1:2") never match.
 */
const CLOCK_TIME = /\b(\d{1,2}):([0-5]\d)(?:\s*(AM|PM))?/giu;

/** "7:30 p.m." / "7:30 P.M." — folded before the clock rule runs. */
const DOTTED_MERIDIEM = /\b([ap])\.\s?m\./giu;

/**
 * A figure carrying an Indian scale word: "₹1.5 lakh+", "2 crore".
 * The scale word stays a word in both languages — Indian English says
 * "lakh", not "hundred thousand".
 */
const SCALED_AMOUNT =
  /(₹\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr)\b(\s*\+)?/giu;

/** Indian digit grouping: "1,50,000", "₹1,50,000+", "₹12,34,56,789". */
const GROUPED_AMOUNT = /(₹\s*)?\b(\d{1,2}(?:,\d{2})+,\d{3})\b(\s*\+)?/giu;

/** Any remaining rupee figure: "₹500", "₹2,000+". */
const PLAIN_RUPEES = /₹\s*(\d[\d,]*(?:\.\d+)?)(\s*\+)?/giu;

interface Lexicon {
  readonly rupees: string;
  readonly thousand: string;
  readonly hundred: string;
}

const HINDI_LEXICON: Lexicon = { rupees: "rupaye", thousand: "hazaar", hundred: "sau" };
const ENGLISH_LEXICON: Lexicon = { rupees: "rupees", thousand: "thousand", hundred: "hundred" };

/**
 * Reads a clock time the way a person says it in each language.
 *
 * English keeps the familiar "seven thirty PM" (and "seven oh five",
 * "seven PM" on the hour). Hindi uses the colloquial fraction words a
 * caller expects — sawa / saadhe / paune, including the irregular
 * "dedh" (1:30) and "dhaai" (2:30).
 */
function pronounceTime(
  hour: number,
  minute: number,
  meridiem: string | undefined,
  hindi: boolean,
): string | undefined {
  if (hour > 23) return undefined;

  const upper = meridiem?.toUpperCase();
  let hour24 = hour;
  if (upper === "PM" && hour < 12) hour24 = hour + 12;
  else if (upper === "AM" && hour === 12) hour24 = 0;

  const hour12 = hour24 % 12;
  // Known only from an explicit AM/PM, or from a 24-hour reading.
  const dayKnown = upper !== undefined || hour > 12;

  if (!hindi) {
    const hourWord = englishHour(hour12);
    const suffix = dayKnown ? ` ${hour24 < 12 ? "AM" : "PM"}` : "";
    if (minute === 0) return dayKnown ? `${hourWord}${suffix}` : `${hourWord} o'clock`;
    if (minute < 10) return `${hourWord} oh ${ENGLISH_ONES[minute]}${suffix}`;
    return `${hourWord} ${englishBelowHundred(minute)}${suffix}`;
  }

  let clock: string;
  if (minute === 0) {
    clock = `${hindiHour(hour12)} baje`;
  } else if (minute === 15) {
    clock = `sawa ${hindiHour(hour12)} baje`;
  } else if (minute === 30) {
    // 1:30 and 2:30 have their own words; "saadhe ek" is not said.
    if (hour12 === 1) clock = "dedh baje";
    else if (hour12 === 2) clock = "dhaai baje";
    else clock = `saadhe ${hindiHour(hour12)} baje`;
  } else if (minute === 45) {
    clock = `paune ${hindiHour((hour12 + 1) % 12)} baje`;
  } else {
    // Digits, not words: the Hindi voice reads "20" as "bees" itself,
    // and the irregular 21-59 cardinals are not worth a table here.
    clock = `${hindiHour(hour12)} bajkar ${minute} minute`;
  }

  return dayKnown ? `${clock} ${hindiDaypart(hour24)} ko` : clock;
}

/**
 * "1.5" -> "dedh", "2.5" -> "dhaai", "3.5" -> "saadhe teen". Anything
 * else keeps its digits, which every engine reads correctly.
 */
function pronounceHalves(figure: string, hindi: boolean): string {
  if (!hindi) return figure;
  const half = /^(\d+)\.5$/u.exec(figure);
  if (!half) return figure;

  const whole = Number(half[1]);
  if (whole === 1) return "dedh";
  if (whole === 2) return "dhaai";
  if (whole >= 3 && whole < HINDI_CARDINALS.length) return `saadhe ${HINDI_CARDINALS[whole]}`;
  return figure;
}

/** Indian scale word, normalized to its singular spoken form. */
function scaleWord(raw: string): string {
  if (/^cr/iu.test(raw)) return "crore";
  if (/^la[kc]/iu.test(raw)) return "lakh";
  return raw.toLowerCase();
}

/**
 * Breaks an Indian-grouped integer into the units it is actually
 * spoken in. Component counts stay as digits — see the file header.
 */
function pronounceGrouped(digits: string, lex: Lexicon): string {
  const value = Number(digits.replace(/,/gu, ""));
  if (!Number.isFinite(value)) return digits;

  const scales: ReadonlyArray<readonly [number, string]> = [
    [10_000_000, "crore"],
    [100_000, "lakh"],
    [1_000, lex.thousand],
    [100, lex.hundred],
  ];

  const parts: string[] = [];
  let rest = value;
  for (const [divisor, word] of scales) {
    const count = Math.floor(rest / divisor);
    if (count > 0) {
      parts.push(`${count} ${word}`);
      rest -= count * divisor;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(String(rest));

  return parts.join(" ");
}

/**
 * Rewrites numeric notation in `text` into the words the given
 * conversation language is spoken in. Meaning is never changed — only
 * how a value is read aloud. Safe on a full reply or on a single
 * streamed sentence chunk.
 */
export function pronounceForSpeech(text: string, language: SupportedLanguage): string {
  if (text.trim().length === 0) return text;

  const hindi = language !== SupportedLanguage.ENGLISH;
  const lex = hindi ? HINDI_LEXICON : ENGLISH_LEXICON;

  let spoken = text.replace(DOTTED_MERIDIEM, (_match, ap: string) => `${ap.toUpperCase()}M`);

  spoken = spoken.replace(CLOCK_TIME, (match, h: string, m: string, mer?: string) =>
    pronounceTime(Number(h), Number(m), mer, hindi) ?? match,
  );

  spoken = spoken.replace(
    SCALED_AMOUNT,
    (_match, rupee: string | undefined, figure: string, scale: string, plus: string | undefined) =>
      join(
        pronounceHalves(figure, hindi),
        scaleWord(scale),
        rupee ? lex.rupees : "",
        plus ? "plus" : "",
      ),
  );

  spoken = spoken.replace(
    GROUPED_AMOUNT,
    (_match, rupee: string | undefined, digits: string, plus: string | undefined) =>
      join(pronounceGrouped(digits, lex), rupee ? lex.rupees : "", plus ? "plus" : ""),
  );

  spoken = spoken.replace(
    PLAIN_RUPEES,
    (_match, figure: string, plus: string | undefined) =>
      join(pronounceHalves(figure.replace(/,/gu, ""), hindi), lex.rupees, plus ? "plus" : ""),
  );

  return spoken.replace(/[ \t]{2,}/gu, " ");
}

function join(...parts: ReadonlyArray<string>): string {
  return parts.filter((part) => part.length > 0).join(" ");
}
