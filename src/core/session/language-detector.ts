/**
 * language-detector.ts
 *
 * Turn-by-turn language detection for the conversation pipeline.
 * Detects whether the user's utterance is English, Hindi, or a
 * natural code-mixed Hinglish, so the VoiceSessionManager can steer
 * the Language Model's reply language turn-by-turn instead of
 * locking a session to whatever language it started in.
 *
 * This is a lightweight, dependency-free heuristic (script
 * detection + a marker-word list for romanized Hindi) rather than a
 * statistical model — appropriate for a real-time, per-turn signal
 * where a full language-ID model would itself add latency to the
 * < 1s response budget.
 */

import { SupportedLanguage } from "../../types/enums";

const DEVANAGARI_RANGE = /[\u0900-\u097F]/;
const LATIN_LETTERS = /[a-zA-Z]/;

/**
 * Common romanized Hindi/Hinglish function words and particles.
 * Not exhaustive — it only needs to be indicative enough to catch
 * genuine code-mixing, not to serve as a full lexicon.
 */
const ROMAN_HINDI_MARKERS = new Set([
  "hai", "hain", "haan", "nahi", "nahin", "kya", "kyu", "kyun", "kaise",
  "kaisa", "kaisi", "tum", "tumhe", "tumhara", "tumhari", "aap", "aapka",
  "aapki", "mera", "meri", "mujhe", "mujhko", "mujhse", "hum", "humein",
  "accha", "acha", "theek", "thik", "bhai", "yaar", "kar", "kro", "karo",
  "karna", "raha", "rahi", "rahe", "matlab", "abhi", "bahut", "bohot",
  "thoda", "zyada", "jyada", "bilkul", "chaliye", "chalo", "sahi", "galat",
  "bata", "batao", "suno", "dekho", "pata", "samajh", "samjha", "samjhi",
  "bol", "bolo", "boliye", "baat", "kripya", "kripayaa", "ji",
  // Everyday verbs, particles and question words. The list had to grow
  // when the rule became a RATIO rather than "one hit is enough":
  // "mujhe loan chahiye kitna interest lagega" only had one recognized
  // word in it and would have scored as English.
  "chahiye", "chahta", "chahti", "chahte", "kitna", "kitni", "kitne",
  "hoga", "hogi", "honge", "hota", "hoti", "hote", "hua", "hui", "huye",
  "lagega", "lagegi", "lagta", "lagti", "sakta", "sakti", "sakte",
  "karenge", "karunga", "karungi", "kariye", "kijiye", "karein", "kiya",
  "milega", "milegi", "milta", "dijiye", "dena", "lena", "diya", "liya",
  "bataiye", "batana", "samajhna", "dekhna", "lijiye",
  "mein", "mera", "mere", "aapko", "aapse", "unka", "uska", "iska",
  "kuch", "sab", "sabhi", "kaun", "kab", "kahan", "kahaan", "kyunki",
  "lekin", "magar", "phir", "fir", "jab", "agar", "toh", "aur", "ya",
  "tha", "thi", "thay", "hoon", "hun", "aaj", "kal", "jaldi",
  "zaroor", "jarur", "zaroorat", "jarurat", "paisa", "paise", "rupaye",
  "wala", "wali", "waale", "aisa", "aise", "aisi", "nahin", "haa",
  "ka", "ke", "ki", "ko", "se", "ne", "par",
  // Deliberately NOT markers: anything that is also an ordinary English
  // word — "the", "hi", "main", "is", "to", "so", "me", "car" — would
  // score English sentences as Hindi. Nor: "hindi", "english", "language", "switch",
  // "change". They are ordinary English words, and any one of them was
  // enough to classify a plain English sentence as Hindi — "Can you
  // switch to English?" and "I want to change my language" both came
  // back as Hindi, which is precisely the "stuck in the wrong language"
  // symptom. An explicit language request is handled by the model from
  // the sentence itself, not by this heuristic.
]);

/**
 * Share of romanized-Hindi marker words at which a Latin-script
 * utterance stops being "English with a stray Hindi word" and becomes
 * genuine code-mixing, and the higher share at which it is simply
 * Hindi typed in Latin script.
 *
 * Below the lower bound the turn is English. This is the fix for the
 * old `hindiHits > 0 -> Hindi` rule, under which one marker word
 * anywhere in a long English sentence flipped the whole turn — and,
 * because the result is fed back as the per-turn language hint, kept
 * the agent answering in Hindi after the caller had switched back.
 */
const HINGLISH_MARKER_RATIO = 0.2;
const HINDI_MARKER_RATIO = 0.5;

/**
 * Share of Latin-script words at which a Devanagari utterance counts as
 * genuine mixing rather than normal Indian speech. A Hindi sentence
 * carrying an English term or two ("मेरा EMI कितना है") is Hindi, not a
 * language switch — the same rule the system prompt states.
 */
const HINGLISH_LATIN_WORD_RATIO = 0.3;

/**
 * Bare acknowledgements that carry no language signal at all. Said on
 * their own they are not evidence of a switch — "okay" in the middle of
 * a Hindi call is still a Hindi call — so the language already in play
 * is kept rather than flipping the reply to English for one token and
 * back again on the next turn.
 *
 * Deliberately tiny and acknowledgement-only: anything with actual
 * content, including "speak english", is judged on its own words.
 */
const LANGUAGE_NEUTRAL_TOKENS = new Set([
  "ok", "okay", "hmm", "hm", "mm", "uh", "um", "yeah", "yep", "yes", "no",
  "right", "sure", "correct", "fine", "thanks", "hello", "hi", "hey",
]);

export interface LanguageDetectionResult {
  readonly language: SupportedLanguage;
  readonly confidence: number;
  readonly script: "devanagari" | "latin" | "mixed";
}

/**
 * Detect the language of a single utterance. `previous`, when
 * provided, is used only where the current utterance carries no
 * language signal at all — empty/unintelligible input, or a bare
 * acknowledgement. Every utterance with actual content is re-evaluated
 * independently, so the session switches languages freely turn to turn
 * and never keeps answering in the previous turn's language.
 */
export function detectLanguage(
  text: string,
  previous?: SupportedLanguage,
): LanguageDetectionResult {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { language: previous ?? SupportedLanguage.ENGLISH, confidence: 0, script: "latin" };
  }

  const hasDevanagari = DEVANAGARI_RANGE.test(trimmed);
  const hasLatin = LATIN_LETTERS.test(trimmed);

  if (hasDevanagari) {
    if (!hasLatin) {
      return { language: SupportedLanguage.HINDI, confidence: 0.9, script: "devanagari" };
    }
    // Both scripts present. How much Latin decides whether this is a
    // Hindi sentence keeping the English terms Indian professionals
    // actually use (Hindi), or the caller genuinely code-mixing
    // (Hinglish) — the two get different replies, so they can no
    // longer both report Hindi.
    const scriptWords = trimmed.split(/\s+/).filter((word) => /[\p{L}]/u.test(word));
    const latinWords = scriptWords.filter(
      (word) => LATIN_LETTERS.test(word) && !DEVANAGARI_RANGE.test(word),
    ).length;
    const latinRatio = scriptWords.length > 0 ? latinWords / scriptWords.length : 0;
    return latinRatio >= HINGLISH_LATIN_WORD_RATIO
      ? { language: SupportedLanguage.HINGLISH, confidence: 0.85, script: "mixed" }
      : { language: SupportedLanguage.HINDI, confidence: 0.85, script: "mixed" };
  }

  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z]/g, ""))
    .filter((word) => word.length > 0);

  const hindiHits = words.filter((word) => ROMAN_HINDI_MARKERS.has(word)).length;
  const hindiRatio = words.length > 0 ? hindiHits / words.length : 0;

  // Mostly romanized Hindi.
  if (hindiRatio >= HINDI_MARKER_RATIO) {
    return {
      language: SupportedLanguage.HINDI,
      confidence: Math.min(0.7 + hindiRatio * 0.25, 0.95),
      script: "latin",
    };
  }

  // Real code-mixing: enough Hindi to be deliberate, enough English
  // that replying in pure Hindi would not match how they spoke.
  if (hindiRatio >= HINGLISH_MARKER_RATIO) {
    return {
      language: SupportedLanguage.HINGLISH,
      confidence: 0.75,
      script: "latin",
    };
  }

  // A bare acknowledgement says nothing about language — keep the one
  // already in play instead of reporting a switch that didn't happen.
  //
  // There is deliberately no length cap here. The test already requires
  // EVERY word to be language-neutral, so a longer utterance is not more
  // evidence of a switch — it is the same non-evidence repeated. A cap
  // meant "hello hello" kept the call's language while "hello hello
  // hello" flipped a Hindi call to English, and a caller repeating
  // themselves into a silence is exactly when that happens.
  if (
    previous !== undefined &&
    words.length > 0 &&
    words.every((word) => LANGUAGE_NEUTRAL_TOKENS.has(word))
  ) {
    return { language: previous, confidence: 0.5, script: "latin" };
  }

  // Everything else — including an English sentence with one stray
  // Hindi word in it — is English.
  return {
    language: SupportedLanguage.ENGLISH,
    confidence: 0.75,
    script: "latin",
  };
}