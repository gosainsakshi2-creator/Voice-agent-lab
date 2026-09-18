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
 * Clock times, together with the words a Hindi sentence ALREADY puts
 * around them. The minute is always two digits, so ratios and scores
 * ("3:1", "1:2") never match.
 *
 * The three optional groups exist because the LLM writes the time the
 * way a person says it — "रात को 7:30 बजे", "आज शाम साढ़े 7:30 बजे" —
 * and this rewrite then emitted its OWN "baje" and its own part-of-day
 * on top of them. That is the reported malformation: a doubled unit
 * word and a doubled fraction ("...साढ़े saadhe saat baje बजे").
 *
 * So the redundant words are MATCHED and consumed rather than left
 * behind, and one clean reading is produced in their place. Only words
 * this function would otherwise duplicate are listed — nothing else in
 * the sentence is touched.
 */
/** Part-of-day words, Devanagari and romanized, with an optional "को". */
const DAYPART_PREFIX = "(?:सुबह|शाम|दोपहर|रात|subah|shaam|sham|dopahar|raat)(?:\\s*(?:को|ko))?";
/** Fraction words this function re-emits itself: saadhe / sawa / paune. */
const FRACTION_PREFIX = "(?:साढ़े|सवा|पौने|साढे|saadhe|sadhe|sawa|paune)";
/** The "o'clock" unit word this function re-emits itself. */
const CLOCK_UNIT = "(?:बजे|baje)";

const CLOCK_TIME = new RegExp(
  `(?:(${DAYPART_PREFIX})\\s*)?(?:${FRACTION_PREFIX}\\s*)?\\b(\\d{1,2}):([0-5]\\d)(?:\\s*(AM|PM))?(?:\\s*${CLOCK_UNIT})?`,
  "giu",
);

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

/**
 * ── A SLASH THAT MEANS "PER" ──────────────────────────────────────
 *
 * Heard in the Phase 4 audio review: "two sessions/week" read out as
 * "two sessions slash week".
 *
 * A slash is not one thing, which is why this rule is keyed on the
 * DENOMINATOR rather than on the slash. The same character builds URLs
 * (`example.com/live-workshop`), file paths (`C:/Users/report.pdf`),
 * dates (`13/08/2026`), ratios (`24/7`), identifiers (`FF-2026/A47`)
 * and alternatives (`and/or`) — in every one of those the slash is
 * either meaningful or is already read correctly, and a global
 * slash -> "per" rewrite would corrupt all of them. So only a fixed
 * allow-list of unit words can close the match, and each one is a word
 * that in ordinary speech can follow "per" and essentially nothing
 * else.
 *
 * Two guards do the rest:
 *
 *   - the left-hand word must START the text or follow whitespace or an
 *     opening bracket. That is what keeps `example.com/week` and
 *     `/docs/week` out: their left-hand token is preceded by "." or
 *     "/", so the group never matches.
 *   - the unit must not be followed by "/", ":" or "-", so a longer
 *     path or compound is not clipped at its first unit-looking
 *     segment. A following full stop IS allowed, because that is a
 *     sentence ending.
 *
 * Deliberately conservative: an unlisted denominator ("km/h",
 * "units/batch") is left exactly as it is spoken today. A miss costs
 * nothing; a false positive changes a URL a caller is meant to act on.
 *
 * Not language-gated. "per" is the word used in Indian English and in
 * Hinglish alike, and the Hindi alternative would be inventing
 * vocabulary this module has no evidence for.
 */
const RATE_DENOMINATOR = "(?:second|minute|hour|day|week|month|year|person)";

const RATE_SLASH = new RegExp(
  `(^|[\\s(\\[])([A-Za-z0-9]+)\\s*/\\s*(${RATE_DENOMINATOR})\\b(?![:/-])`,
  "giu",
);

/**
 * ── WHICH REGISTER AN UTTERANCE IS READ IN ────────────────────────
 *
 * The `language` this module is handed is the CALL's language —
 * `memory.currentLanguage`, which the language lock fixes for the whole
 * call. It is not, and never was, the language of the sentence being
 * spoken; nothing in the codebase carries one. So a Hindi- or
 * Hinglish-locked call substituted Hindi words into sentences written
 * entirely in English:
 *
 *   "The webinar will start at 7:30 PM."
 *     -> "The webinar will start at saadhe saat baje shaam ko."
 *
 * The rule below separates the two concerns for THIS transformation
 * only. It is deliberately one-directional: a non-English call may fall
 * back to the English register when the utterance is clearly English.
 * An English call is never pushed the other way, the `language`
 * argument is not modified, and nothing here reaches the value handed
 * to the TTS provider — that stays the locked language, which is the
 * lock's entire job.
 *
 * WHY NOT `detectLanguage`. It was measured against these fixtures
 * before this was written and it reports "7:30 PM", "₹500", "2.5 lakh"
 * and "11:15 AM" as English, on basis `default-english`, with
 * `isLockGradeEvidence` true. That is correct for what it is for — a
 * CALLER's bare utterance carries the previous language forward — and
 * wrong here, where a bare notation carries no language at all.
 * Adopting it would have un-Hindi'd every short utterance on a Hindi
 * call. It also lives in `core/session`; this module is pure and has
 * only ever imported the enum.
 *
 * SO THE TEST IS FOR POSITIVE EVIDENCE OF ENGLISH, and everything else
 * keeps today's behaviour rather than guessing. Three gates, cheapest
 * first, all three required:
 *
 *   1. no Devanagari anywhere — one Devanagari letter and this is not
 *      an English sentence, whatever else is in it;
 *   2. no romanized Hindi function word — this is what makes Hinglish
 *      Hinglish. English CONTENT words are not evidence of English:
 *      "LIVE attendees ko ₹1.5 lakh+ ke bonuses milenge" is a Hindi
 *      sentence with English nouns in it, and `ko`/`ke` are what say so;
 *   3. at least two distinct English function words. One can appear in
 *      a romanized Hindi sentence by accident, and a bare "7:30 PM" has
 *      none at all — which is the case this threshold exists to refuse.
 *
 * KNOWN LIMIT, recorded rather than hidden: this runs per streamed
 * chunk, so a long English sentence split by the chunker is judged one
 * piece at a time. The chunker's minimums (40 characters for the first
 * chunk, 60 for the rest) put several function words in a normal chunk,
 * but a short fragment can fall below the threshold and keep the call's
 * register. That errs toward today's behaviour, which is the safe
 * direction.
 */

/** One Devanagari letter is enough to settle it. */
const DEVANAGARI = /[ऀ-ॿ]/u;

/**
 * Romanized Hindi function words. Deliberately EXCLUDES every spelling
 * that is also an ordinary English word — `is`, `us`, `the`, `me`,
 * `to`, `hi`, `no`, `so` — because a false positive here reads an
 * English sentence as Hindi, which is the bug this is fixing. Missing a
 * marker only costs the fallback, which is today's behaviour.
 */
const HINDI_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "aap", "aapka", "aapke", "aapki", "aapko", "main", "mera", "meri", "mere",
  "hum", "humara", "hamara", "tum", "tumhara", "yeh", "ye", "woh", "wo",
  "kya", "kyun", "kyon", "kaise", "kahan", "kab", "kaun", "kitna", "kitne", "kitni",
  "hai", "hain", "tha", "thi", "thay", "hoga", "hogi", "honge", "hota", "hoti", "hote",
  "karna", "karne", "karta", "karti", "karte", "kar", "kiya", "kiye", "karo", "kijiye",
  "nahi", "nahin", "haan", "han", "haanji", "hanji", "ji", "bhi",
  "ka", "ke", "ki", "ko", "se", "ne", "par", "pe", "mein",
  "aur", "lekin", "magar", "phir", "abhi", "aaj", "kal", "subah", "shaam", "sham",
  "raat", "dopahar", "baje", "liye", "sakta", "sakte", "sakti", "chahiye",
  "milega", "milegi", "milenge", "raha", "rahi", "rahe", "gaya", "gayi",
  "bahut", "thoda", "accha", "achha", "theek", "thik", "bilkul", "zaroor", "jaroor",
  "apna", "apne", "apni", "sab", "kuch", "kuchh", "koi", "jo", "jis", "jab",
  "shuru", "judiye", "dekhiye", "suniye", "batao", "bataye", "hoke", "wala", "wali", "wale",
]);

/**
 * English function words. Content words are deliberately absent: a
 * Hinglish sentence is full of English nouns, and counting them would
 * read it as English.
 */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "will", "would", "can", "could", "shall", "should", "may", "might", "must",
  "have", "has", "had", "do", "does", "did", "get", "got",
  "of", "to", "in", "on", "at", "for", "with", "from", "by", "into", "about",
  "over", "under", "after", "before", "during", "between",
  "this", "that", "these", "those", "there", "here",
  "it", "its", "you", "your", "yours", "we", "our", "us", "they", "them", "their",
  "he", "she", "his", "her", "my", "me", "i",
  "not", "no", "so", "also", "only", "just", "very", "too",
  "what", "which", "who", "when", "where", "how", "why",
  "please", "thanks", "thank", "sorry", "yes",
]);

/** Minimum distinct English function words before the register is overridden. */
const MIN_ENGLISH_EVIDENCE = 2;

/**
 * Splits into comparable word tokens.
 *
 * `\p{M}` is in the class on purpose: Devanagari matras and the virama
 * are COMBINING MARKS, not letters, so a class of `\p{L}` alone shatters
 * every Devanagari word into single consonants. Nothing here matches a
 * Devanagari token — the script gate above has already settled those —
 * but a tokenizer that quietly destroys one script is a trap for the
 * next person to use it. Same class and same NFC normalization the
 * phrase matchers elsewhere in the codebase use.
 */
function wordsOf(text: string): readonly string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Is this utterance clearly English, on its own evidence?
 *
 * Answers only that one question. It is not a language detector and
 * must not become one: "not clearly English" is not a claim that the
 * text is Hindi, only that there is no reason to override the call's
 * register.
 */
export function isClearlyEnglishUtterance(text: string): boolean {
  if (DEVANAGARI.test(text)) return false;

  const words = wordsOf(text);
  const englishHits = new Set<string>();
  for (const word of words) {
    if (HINDI_FUNCTION_WORDS.has(word)) return false;
    if (ENGLISH_FUNCTION_WORDS.has(word)) englishHits.add(word);
  }
  return englishHits.size >= MIN_ENGLISH_EVIDENCE;
}

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
/**
 * @param dayStated The sentence already names the part of day (it is
 *   re-emitted verbatim by the caller), so this must not append one of
 *   its own — that is what produced "शाम ... shaam ko".
 */
function pronounceTime(
  hour: number,
  minute: number,
  meridiem: string | undefined,
  hindi: boolean,
  dayStated = false,
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

  return dayKnown && !dayStated ? `${clock} ${hindiDaypart(hour24)} ko` : clock;
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
 * VERIFIED PROPER-NAME PRONUNCIATIONS, spoken form only.
 *
 * A CLOSED LIST, NOT A TRANSLITERATOR. Every entry is one full name a
 * human has checked, matched as a whole phrase. There is deliberately
 * no rule that turns an arbitrary Indian-looking word into Devanagari:
 * a general transliterator would reach every proper noun in every
 * script — company names, product names, a caller's own name read back
 * — and each one of those would be a guess spoken aloud with total
 * confidence. Adding a name here is a decision somebody makes once.
 *
 * ONLY ON A HINDI/HINGLISH UTTERANCE, and that bound is the safety
 * case. Devanagari already reaches all four TTS vendors on every Hindi
 * call — `hindiOpeningLine()` in `system-prompt.ts` is Devanagari and
 * is spoken through this same path — so this adds no new class of input
 * to any provider. An ENGLISH call is a different matter: `language`
 * there is sent to the vendor as an explicit tag (Cartesia `en`, Sarvam
 * `en-IN`, ElevenLabs `languageCode: "en"`, which its own adapter notes
 * is "honored by models that support explicit language enforcement"),
 * and Devanagari under a forced English tag is UNVERIFIED on all four.
 * Nobody has run it, so it is not done: an English call keeps the
 * canonical spelling and today's behaviour exactly.
 *
 * Extending this to English calls is a measurement, not an edit — the
 * TTS evidence harness (`npm run bench:tts`) is what would settle it.
 *
 * IDEMPOTENT BY CONSTRUCTION: each pattern matches only the Latin
 * spelling, so a second pass over already-Devanagari output finds
 * nothing. Asserted in the pronunciation tests.
 */
const VERIFIED_NAME_PRONUNCIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // FlexiFunnels co-founder and CEO. Named in the registration v7
  // script; an English TTS voice reads "Saurabh" as "Sore-ab".
  [/\bSaurabh\s+Bhatnagar\b/giu, "सौरभ भटनागर"],
];

/**
 * Rewrites numeric notation in `text` into the words the given
 * conversation language is spoken in. Meaning is never changed — only
 * how a value is read aloud. Safe on a full reply or on a single
 * streamed sentence chunk.
 */
export function pronounceForSpeech(text: string, language: SupportedLanguage): string {
  if (text.trim().length === 0) return text;

  // The call's language decides the register, EXCEPT where the
  // utterance itself is clearly English — see the long note above
  // `isClearlyEnglishUtterance`. One-directional: `language` is read,
  // never rewritten, and an English call is unaffected by this clause.
  const hindi = language !== SupportedLanguage.ENGLISH && !isClearlyEnglishUtterance(text);
  const lex = hindi ? HINDI_LEXICON : ENGLISH_LEXICON;

  let spoken = text.replace(DOTTED_MERIDIEM, (_match, ap: string) => `${ap.toUpperCase()}M`);

  // Verified proper names, spoken form only, and only where Devanagari
  // is already the norm for this utterance. Reuses the same `hindi`
  // flag as the numeric rules rather than testing `language` directly:
  // an English sentence spoken on a Hindi call is exactly the
  // mixed-script case no vendor has been measured on.
  if (hindi) {
    for (const [pattern, spokenName] of VERIFIED_NAME_PRONUNCIATIONS) {
      spoken = spoken.replace(pattern, spokenName);
    }
  }

  // A part-of-day the sentence already stated is kept verbatim and the
  // reading is built without one, so neither it nor the unit word nor
  // the fraction word is ever said twice.
  spoken = spoken.replace(
    CLOCK_TIME,
    (match, daypart: string | undefined, h: string, m: string, mer?: string) => {
      const reading = pronounceTime(Number(h), Number(m), mer, hindi, daypart !== undefined);
      if (reading === undefined) return match;
      return daypart !== undefined ? `${daypart} ${reading}` : reading;
    },
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

  // LAST, and that ordering is load-bearing: "₹500/month" has to become
  // "500 rupees" before this sees it, so the word on the left of the
  // slash is the currency word rather than the "₹" the amount rules
  // consume. Both sides are re-emitted exactly as written; only the
  // slash itself is replaced.
  spoken = spoken.replace(
    RATE_SLASH,
    (_match, lead: string, numerator: string, unit: string) => `${lead}${numerator} per ${unit}`,
  );

  return spoken.replace(/[ \t]{2,}/gu, " ");
}

function join(...parts: ReadonlyArray<string>): string {
  return parts.filter((part) => part.length > 0).join(" ");
}
