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
  "aapki", "mera", "meri", "mujhe", "mujhko", "hum", "humein", "accha",
  "acha", "theek", "thik", "bhai", "yaar", "kar", "kro", "karo", "karna",
  "raha", "rahi", "rahe", "matlab", "abhi", "bahut", "bohot", "thoda",
  "zyada", "jyada", "bilkul", "chaliye", "chalo", "sahi", "galat", "bata",
  "batao", "suno", "dekho", "pata", "samajh", "samjha", "samjhi",
]);

export interface LanguageDetectionResult {
  readonly language: SupportedLanguage;
  readonly confidence: number;
  readonly script: "devanagari" | "latin" | "mixed";
}

/**
 * Detect the language of a single utterance. `previous`, when
 * provided, is used only as the fallback for empty/unintelligible
 * input — every non-empty utterance is re-evaluated independently
 * so the session can switch languages freely turn to turn.
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

  if (hasDevanagari && hasLatin) {
    return { language: SupportedLanguage.HINGLISH, confidence: 0.85, script: "mixed" };
  }
  if (hasDevanagari) {
    return { language: SupportedLanguage.HINDI, confidence: 0.9, script: "devanagari" };
  }

  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z]/g, ""))
    .filter((word) => word.length > 0);

  const hindiHits = words.filter((word) => ROMAN_HINDI_MARKERS.has(word)).length;
  const hindiRatio = words.length > 0 ? hindiHits / words.length : 0;

  if (hindiRatio >= 0.34) {
    return {
      language: SupportedLanguage.HINGLISH,
      confidence: Math.min(0.6 + hindiRatio * 0.3, 0.95),
      script: "latin",
    };
  }
  if (hindiHits > 0) {
    // A romanized Hindi word appeared, but not enough of them to
    // call this fully mixed — still worth flagging as Hinglish
    // rather than forcing a false-confidence English classification.
    return { language: SupportedLanguage.HINGLISH, confidence: 0.5, script: "latin" };
  }

  return { language: SupportedLanguage.ENGLISH, confidence: 0.75, script: "latin" };
}
