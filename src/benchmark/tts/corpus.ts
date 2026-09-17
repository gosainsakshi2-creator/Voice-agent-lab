/**
 * corpus.ts — the fixed, version-controlled text corpus for the TTS
 * evidence harness.
 *
 * PHASE 4, EVIDENCE STEP. This file is DATA. It constructs nothing,
 * reads no environment, touches no filesystem and calls no vendor.
 *
 * ── WHAT THIS CORPUS IS FOR ───────────────────────────────────────
 *
 * The Phase 4 audit established that Indian-name pronunciation has no
 * implementation at all, and that deterministic normalization covers
 * only clock times with a colon and rupee figures. Both findings are
 * statements about text. Neither has ever been heard.
 *
 * So this corpus exists to answer two questions per item, per
 * provider, and nothing else:
 *
 *   1. what exact text does the provider receive, and
 *   2. what exact audio does it hand back.
 *
 * ── WHAT `expectation` MEANS, AND WHAT IT DOES NOT ────────────────
 *
 * Every item declares whether TODAY'S code changes it on the way to
 * `synthesize` — `unchanged` or `transformed` — and nothing more.
 *
 * It is deliberately NOT a phonetic target. There is no "correct"
 * spelling of "Chhaya" recorded anywhere here, because inventing one
 * would be designing the pronunciation mechanism, which is the NEXT
 * phase and must be designed from this evidence rather than ahead of
 * it. An `unchanged` declaration on a name is therefore not an
 * approval of how that name sounds — it is the recorded fact that
 * nothing in the pipeline touches it.
 *
 * The declaration is checked against the real functions by
 * `transform.ts`, so an item whose behaviour drifts is reported as a
 * MISMATCH rather than silently re-baselined.
 *
 * ── THE CORPUS IS NOT EXHAUSTIVE ──────────────────────────────────
 *
 * It is a fixed sample chosen to cover the shapes the audit named. It
 * is not a survey of Indian names, not a statistical sample of any
 * contact list, and it proves nothing about coverage. Every name here
 * is synthetic or a public first name used illustratively; NO
 * PRODUCTION CONTACT, and no row of any imported CSV, reaches this
 * file or this harness.
 *
 * Bump `CORPUS_VERSION` whenever an item is added, removed or edited,
 * so two reports can never be compared across different corpora
 * without it being visible.
 */

import { SupportedLanguage } from "../../types/enums";

/**
 * Bump on ANY edit to `CORPUS` below.
 *
 * `-2`: no item was added, removed or re-worded. One DECLARATION moved
 * — `norm-symbol-slash-en` from `unchanged` to `transformed`, because
 * the rate-slash rule in `speech-pronunciation.ts` now rewrites it. The
 * version still moves, so a report from before that rule cannot be
 * compared against one from after it without the difference being
 * visible.
 */
export const CORPUS_VERSION = "phase4-evidence-2";

/**
 * What today's transformation path does to an item.
 *
 * `unchanged` — `formatForSpeech` then `pronounceForSpeech` return the
 *   source text byte for byte. For a NAME this is the norm and is the
 *   finding itself. For a NORMALIZATION case it is the recorded gap:
 *   the notation reaches the vendor exactly as written.
 *
 * `transformed` — one of the two passes rewrites it. The harness
 *   records what it became; it does not judge whether that is right.
 */
export type CorpusExpectation = "unchanged" | "transformed";

export type CorpusCategory =
  | "name-north-indian"
  | "name-ambiguous-english"
  | "name-devanagari"
  | "name-mixed-script"
  | "name-consonant-cluster"
  | "name-transliteration-ambiguity"
  | "name-in-context"
  | "script-v6-line"
  | "normalization-time"
  | "normalization-date"
  | "normalization-amount"
  | "normalization-contact"
  | "normalization-symbolic";

export interface CorpusItem {
  /** Stable, unique, filesystem-safe. Never reused for different text. */
  readonly id: string;
  readonly category: CorpusCategory;
  /** The text as it would reach the pipeline. */
  readonly sourceText: string;
  /** The conversation language the utterance is spoken in. */
  readonly language: SupportedLanguage;
  /** What CURRENT code does to it. See `CorpusExpectation`. */
  readonly expectation: CorpusExpectation;
  /** Why this item is in the corpus. One line, for the report. */
  readonly note: string;
}

const EN = SupportedLanguage.ENGLISH;
const HI = SupportedLanguage.HINDI;
const HINGLISH = SupportedLanguage.HINGLISH;

/**
 * SECTION A — Indian and mixed-script names.
 *
 * Bare names first, because a name is what the identity line and the
 * model's own sentences actually put in front of the vendor, and a
 * bare token is the cleanest way to hear how the engine's
 * grapheme-to-phoneme rules treat it.
 *
 * `name-in-context` items then place the same name inside the
 * pipeline-owned identity line, because an engine's reading of a word
 * can change with the sentence around it — and that line, unlike a
 * generated reply, is fixed text the pipeline speaks verbatim.
 */
const NAMES: readonly CorpusItem[] = [
  // ── Common North Indian names, male and female ─────────────────
  {
    id: "name-rahul-en",
    category: "name-north-indian",
    sourceText: "Rahul",
    language: EN,
    expectation: "unchanged",
    note: "Common male name, unambiguous spelling — the control case.",
  },
  {
    id: "name-priya-en",
    category: "name-north-indian",
    sourceText: "Priya",
    language: EN,
    expectation: "unchanged",
    note: "Common female name, unambiguous spelling — the control case.",
  },
  {
    id: "name-saurabh-en",
    category: "name-north-indian",
    sourceText: "Saurabh",
    language: EN,
    expectation: "unchanged",
    note: "Named in the approved script's FAQ copy as 'Saurabh Sir'; final -bh is aspirated.",
  },
  {
    id: "name-shubham-en",
    category: "name-north-indian",
    sourceText: "Shubham",
    language: EN,
    expectation: "unchanged",
    note: "Male name, aspirated -bh- medially.",
  },
  {
    id: "name-vaishnavi-en",
    category: "name-north-indian",
    sourceText: "Vaishnavi",
    language: EN,
    expectation: "unchanged",
    note: "Female name, four syllables, -sh- plus -vi ending.",
  },

  // ── Names an English reader mis-stresses or re-spells ──────────
  {
    id: "name-jyoti-en",
    category: "name-ambiguous-english",
    sourceText: "Jyoti",
    language: EN,
    expectation: "unchanged",
    note: "Initial Jy- cluster has no English analogue; commonly read as 'jee-oh-tee'.",
  },
  {
    id: "name-ruchi-en",
    category: "name-ambiguous-english",
    sourceText: "Ruchi",
    language: EN,
    expectation: "unchanged",
    note: "-ch- is ambiguous in English orthography (church vs. chord vs. machine).",
  },
  {
    id: "name-suman-en",
    category: "name-ambiguous-english",
    sourceText: "Suman",
    language: EN,
    expectation: "unchanged",
    note: "Reads as the English word 'Suman/summon'; also gender-ambiguous.",
  },
  {
    id: "name-sonia-en",
    category: "name-ambiguous-english",
    sourceText: "Sonia",
    language: EN,
    expectation: "unchanged",
    note: "Has an established but DIFFERENT English/European reading.",
  },

  // ── Devanagari ────────────────────────────────────────────────
  {
    id: "name-priya-devanagari-hi",
    category: "name-devanagari",
    sourceText: "प्रिया",
    language: HI,
    expectation: "unchanged",
    note: "Devanagari form of a name the corpus also carries in Latin — the two are directly comparable.",
  },
  {
    id: "name-rakesh-devanagari-hi",
    category: "name-devanagari",
    sourceText: "राकेश कुमार",
    language: HI,
    expectation: "unchanged",
    note: "Devanagari given name plus surname, with a matra and a conjunct.",
  },
  {
    id: "name-chhaya-devanagari-hi",
    category: "name-devanagari",
    sourceText: "छाया",
    language: HI,
    expectation: "unchanged",
    note: "Devanagari form of the aspirated-cluster name below.",
  },

  // ── Mixed Latin + Devanagari in ONE name ──────────────────────
  {
    id: "name-mixed-priya-sharma-hinglish",
    category: "name-mixed-script",
    sourceText: "Priya शर्मा",
    language: HINGLISH,
    expectation: "unchanged",
    note: "Latin given name, Devanagari surname — the shape a mixed-script CSV import produces.",
  },
  {
    id: "name-mixed-devanagari-latin-hinglish",
    category: "name-mixed-script",
    sourceText: "अमित Verma",
    language: HINGLISH,
    expectation: "unchanged",
    note: "The same collision in the other order.",
  },

  // ── Consonant clusters and aspirates ──────────────────────────
  {
    id: "name-chhaya-en",
    category: "name-consonant-cluster",
    sourceText: "Chhaya",
    language: EN,
    expectation: "unchanged",
    note: "Doubled Chh- aspirate; no English spelling convention covers it.",
  },
  {
    id: "name-dhruv-en",
    category: "name-consonant-cluster",
    sourceText: "Dhruv",
    language: EN,
    expectation: "unchanged",
    note: "Dhr- onset plus a final -v; three consonants, one vowel.",
  },
  {
    id: "name-prathamesh-en",
    category: "name-consonant-cluster",
    sourceText: "Prathamesh",
    language: EN,
    expectation: "unchanged",
    note: "Pr- onset plus a -th- that is dental, not the English fricative.",
  },
  {
    id: "name-thirunavukkarasu-en",
    category: "name-consonant-cluster",
    sourceText: "Thirunavukkarasu",
    language: EN,
    expectation: "unchanged",
    note: "Long South Indian name, geminate -kk-; length alone is a failure mode.",
  },

  // ── Known transliteration ambiguity ───────────────────────────
  {
    id: "name-lakshmi-en",
    category: "name-transliteration-ambiguity",
    sourceText: "Lakshmi",
    language: EN,
    expectation: "unchanged",
    note: "Also spelt Laxmi; -ksh- is one conjunct rendered as three Latin letters.",
  },
  {
    id: "name-gayatri-en",
    category: "name-transliteration-ambiguity",
    sourceText: "Gayatri",
    language: EN,
    expectation: "unchanged",
    note: "Also spelt Gaytri/Gayathri; the medial vowel is not recoverable from the spelling.",
  },
  {
    id: "name-krishnan-en",
    category: "name-transliteration-ambiguity",
    sourceText: "Sai Krishna Reddy",
    language: EN,
    expectation: "unchanged",
    note: "Three-part South Indian name; -shn- cluster plus two word boundaries.",
  },
  {
    id: "name-md-ashfaq-en",
    category: "name-transliteration-ambiguity",
    sourceText: "Md. Ashfaq",
    language: EN,
    expectation: "unchanged",
    note: "Abbreviated honorific 'Md.' — a full stop MID-NAME, which is also a chunker boundary shape.",
  },

  // ── The same names inside the line the pipeline actually speaks ─
  {
    id: "name-context-identity-saurabh-en",
    category: "name-in-context",
    sourceText: "Am I speaking with Saurabh?",
    language: EN,
    expectation: "unchanged",
    note: "The pipeline-owned identity line (campaign-context.ts IDENTITY_LINE_TEMPLATE), English.",
  },
  {
    id: "name-context-identity-chhaya-hinglish",
    category: "name-in-context",
    sourceText: "Am I speaking with Chhaya?",
    language: HINGLISH,
    expectation: "unchanged",
    note: "The same fixed line, Hinglish — ElevenLabs sends NO languageCode for Hinglish, the others force hi.",
  },
  {
    id: "name-context-identity-devanagari-hi",
    category: "name-in-context",
    sourceText: "Am I speaking with प्रिया शर्मा?",
    language: HI,
    expectation: "unchanged",
    note: "English carrier sentence around a Devanagari name — the mixed-script input the audit flagged.",
  },
  {
    id: "name-context-thanks-jyoti-en",
    category: "name-in-context",
    sourceText: "Thanks, Jyoti.",
    language: EN,
    expectation: "unchanged",
    note: "The say-it-back shape the conversation policy asks for, inside a two-word utterance.",
  },
];

/**
 * SECTION B — lines from the LIVE script.
 *
 * `registration.v6` is the registry default, so these are words a
 * caller hears today. Quoted from the shipping file; the harness does
 * not import the script, because importing it would pull the script
 * registry (and its hashing) into a text-only harness for no gain —
 * `tts-evidence-harness-tests.ts` asserts each of these strings is
 * still present in `registration.v6.ts` instead, so a re-worded script
 * fails a test rather than silently producing stale evidence.
 */
const SCRIPT_LINES: readonly CorpusItem[] = [
  {
    id: "v6-invite-date-en",
    category: "script-v6-line",
    sourceText:
      "I'm calling to invite you to a free live workshop on Sunday, 4th October at 11 AM.",
    language: EN,
    expectation: "unchanged",
    note: "LIVE script. Neither '4th October' nor the bare '11 AM' matches any rule in pronounceForSpeech.",
  },
  {
    id: "v6-invite-date-hinglish",
    category: "script-v6-line",
    sourceText:
      "I'm calling to invite you to a free live workshop on Sunday, 4th October at 11 AM.",
    language: HINGLISH,
    expectation: "unchanged",
    note: "The same live line on the Hinglish path, where the vendor is asked for a Hindi voice.",
  },
  {
    id: "v6-starts-sunday-en",
    category: "script-v6-line",
    sourceText: "The workshop starts Sunday at 11 AM.",
    language: EN,
    expectation: "unchanged",
    note: "LIVE script, the second place the time is said.",
  },
  {
    id: "v6-bonus-amount-en",
    category: "script-v6-line",
    sourceText:
      "And if you attend live, you'll also get the Launch-In-A-Day Starter Kit worth ₹1,50,000+, along with a live Q&A session and a special reveal at the end.",
    language: EN,
    expectation: "transformed",
    note: "LIVE script. The grouped rupee figure IS rewritten; the rest of the sentence must survive untouched.",
  },
  {
    id: "v6-bonus-amount-hi",
    category: "script-v6-line",
    sourceText:
      "And if you attend live, you'll also get the Launch-In-A-Day Starter Kit worth ₹1,50,000+, along with a live Q&A session and a special reveal at the end.",
    language: HI,
    expectation: "transformed",
    note: "The same figure on the Hindi path, which uses the Hindi scale words.",
  },
  {
    id: "v6-gate-en",
    category: "script-v6-line",
    sourceText: "You won't need any coding or design skills for this. Would you like me to reserve your free seat?",
    language: EN,
    expectation: "unchanged",
    note: "LIVE script gate line — carries the commit anchor, so it is the highest-consequence sentence on the call.",
  },
  {
    id: "v6-opening-en",
    category: "script-v6-line",
    sourceText: "Hello, this is Ishita from Team FlexiFunnels.",
    language: EN,
    expectation: "unchanged",
    note: "LIVE opening line, interpolated with the female-lane agent name.",
  },
];

/**
 * SECTION C — normalization edge cases.
 *
 * Fixed, synthetic, and chosen to sit either side of the boundary of
 * what `pronounceForSpeech` actually implements. Where the current
 * code does nothing, the item says so — that recorded `unchanged` IS
 * the evidence, and no invented target is supplied for it.
 *
 * The phone number and email are deliberately non-routable: the number
 * is in the UK Ofcom drama range prefixed to India's country code, and
 * the domain is RFC 2606's reserved `example.com`.
 */
const NORMALIZATION: readonly CorpusItem[] = [
  // ── Times ──────────────────────────────────────────────────────
  {
    id: "norm-time-colon-en",
    category: "normalization-time",
    sourceText: "Please join TODAY at 7:30 PM.",
    language: EN,
    expectation: "transformed",
    note: "The implemented case: a colon time with a meridiem.",
  },
  {
    id: "norm-time-colon-hi",
    category: "normalization-time",
    sourceText: "Please join TODAY at 7:30 PM.",
    language: HI,
    expectation: "transformed",
    note: "The same input on the Hindi path — a different reading is produced by design.",
  },
  {
    id: "norm-time-bare-meridiem-en",
    category: "normalization-time",
    sourceText: "The session starts at 11 AM.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: no colon, so CLOCK_TIME does not match. This is the live script's shape.",
  },
  {
    id: "norm-time-bare-meridiem-hi",
    category: "normalization-time",
    sourceText: "The session starts at 11 AM.",
    language: HI,
    expectation: "unchanged",
    note: "GAP, Hindi path: an untouched English meridiem is handed to a Hindi voice.",
  },
  {
    id: "norm-time-range-en",
    category: "normalization-time",
    sourceText: "It runs from 11 AM to 1 PM.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: two bare meridiem times in one sentence.",
  },

  // ── Dates ──────────────────────────────────────────────────────
  {
    id: "norm-date-ordinal-en",
    category: "normalization-date",
    sourceText: "It is on Sunday, 4th October.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: ordinal date, the live script's shape.",
  },
  {
    id: "norm-date-numeric-en",
    category: "normalization-date",
    sourceText: "Your slot is on 13/08/2026.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: numeric date. The system prompt instructs the MODEL to expand it; no code does.",
  },
  {
    id: "norm-date-numeric-hi",
    category: "normalization-date",
    sourceText: "Your slot is on 13/08/2026.",
    language: HI,
    expectation: "unchanged",
    note: "GAP, Hindi path.",
  },

  // ── Amounts ────────────────────────────────────────────────────
  {
    id: "norm-amount-grouped-en",
    category: "normalization-amount",
    sourceText: "worth ₹1,50,000+ in bonuses",
    language: EN,
    expectation: "transformed",
    note: "Implemented: Indian digit grouping.",
  },
  {
    id: "norm-amount-grouped-hi",
    category: "normalization-amount",
    sourceText: "worth ₹1,50,000+ in bonuses",
    language: HI,
    expectation: "transformed",
    note: "Implemented: the same figure with Hindi scale words.",
  },
  {
    id: "norm-amount-lakh-en",
    category: "normalization-amount",
    sourceText: "₹1.5 lakh+ worth of exclusive bonuses",
    language: EN,
    expectation: "transformed",
    note: "Implemented: scale word plus a half figure.",
  },
  {
    id: "norm-amount-lakh-hi",
    category: "normalization-amount",
    sourceText: "₹1.5 lakh+ worth of exclusive bonuses",
    language: HI,
    expectation: "transformed",
    note: "Implemented: 'dedh' rather than 'point five'.",
  },
  {
    id: "norm-amount-crore-en",
    category: "normalization-amount",
    sourceText: "The fund is ₹2 crore.",
    language: EN,
    expectation: "transformed",
    note: "Implemented: crore.",
  },
  {
    id: "norm-amount-plain-rupees-en",
    category: "normalization-amount",
    sourceText: "It costs ₹2,999 only.",
    language: EN,
    expectation: "transformed",
    note: "Implemented: plain rupee figure (Western grouping falls to PLAIN_RUPEES).",
  },
  {
    id: "norm-amount-percentage-en",
    category: "normalization-amount",
    sourceText: "You get 25% off today.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: percentages are prompt-only.",
  },
  {
    id: "norm-amount-decimal-en",
    category: "normalization-amount",
    sourceText: "It is 2.5 km from there.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: a decimal with no currency and no scale word.",
  },

  // ── Contact details ────────────────────────────────────────────
  {
    id: "norm-phone-en",
    category: "normalization-contact",
    sourceText: "Call us back on 917700900123.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: digit-by-digit reading is prompt-only. Non-routable drama-range number.",
  },
  {
    id: "norm-phone-hi",
    category: "normalization-contact",
    sourceText: "Call us back on 917700900123.",
    language: HI,
    expectation: "unchanged",
    note: "GAP, Hindi path.",
  },
  {
    id: "norm-email-en",
    category: "normalization-contact",
    sourceText: "Write to support_team@example.com for help.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: at/dot/underscore expansion is prompt-only. Reserved example.com domain.",
  },
  {
    id: "norm-url-en",
    category: "normalization-contact",
    sourceText: "Details are at https://example.com/live-workshop.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: URLs are prompt-only.",
  },
  {
    id: "norm-reference-code-en",
    category: "normalization-contact",
    sourceText: "Your reference code is FF-2026-A47.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: mixed alphanumeric reference code.",
  },
  {
    id: "norm-otp-en",
    category: "normalization-contact",
    sourceText: "The code is 482913.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: a six-digit code read as a quantity is the failure the prompt warns about.",
  },

  // ── Ranges and symbols ─────────────────────────────────────────
  {
    id: "norm-range-en",
    category: "normalization-symbolic",
    sourceText: "It takes 5–7 days.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: en-dash range.",
  },
  {
    id: "norm-symbol-approx-en",
    category: "normalization-symbolic",
    sourceText: "That is ~40 people per batch.",
    language: EN,
    expectation: "unchanged",
    note: "GAP: tilde as 'about'.",
  },
  {
    id: "norm-symbol-slash-en",
    category: "normalization-symbolic",
    sourceText: "It is 2 sessions/week.",
    language: EN,
    expectation: "transformed",
    note:
      "WAS a gap, now implemented: a rate denominator turns the slash into 'per'. " +
      "The audio under this id in run tts_2026-09-17T13-53-48-036Z predates that and was " +
      "synthesized from the raw slash.",
  },
  {
    id: "norm-ratio-not-a-time-en",
    category: "normalization-symbolic",
    sourceText: "The ratio is 3:1 in your favour.",
    language: EN,
    expectation: "unchanged",
    note: "Must stay unchanged: a ratio is deliberately NOT read as a clock time.",
  },
];

/** The corpus, in a fixed order. Never sorted at runtime. */
export const CORPUS: readonly CorpusItem[] = [...NAMES, ...SCRIPT_LINES, ...NORMALIZATION];

/**
 * A short, stable fingerprint of the corpus text.
 *
 * Same shape and same rolling hash as
 * `scenarios.ts::scenarioInputFingerprint`, so the two harnesses'
 * reports read alike. Ties a report to the exact bytes that produced
 * it without restating the corpus inside the report.
 */
export function corpusFingerprint(items: readonly CorpusItem[] = CORPUS): string {
  const totalChars = items.reduce((sum, item) => sum + item.sourceText.length, 0);
  let hash = 0;
  for (const item of items) {
    const material = `${item.id} ${item.language} ${item.sourceText}`;
    for (let i = 0; i < material.length; i += 1) {
      hash = (Math.imul(31, hash) + material.charCodeAt(i)) | 0;
    }
  }
  return `${items.length}i/${totalChars}c/${(hash >>> 0).toString(16)}`;
}

/** Corpus items grouped by category, in corpus order. For the report. */
export function countByCategory(
  items: readonly CorpusItem[] = CORPUS,
): ReadonlyMap<CorpusCategory, number> {
  const counts = new Map<CorpusCategory, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return counts;
}
