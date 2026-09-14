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
 * ---------------- THE CALLER TALKING *ABOUT* LANGUAGE ----------------
 *
 * Words that name a language rather than being spoken in one.
 *
 * The marker table above deliberately EXCLUDES these (see its closing
 * comment): "Can you switch to English?" is an English sentence, and
 * scoring it as Hindi is what left the agent stuck in the wrong
 * language. That reasoning is about the per-turn HINT and is unchanged
 * — `detectLanguage` still reports exactly what it always reported for
 * these utterances.
 *
 * A LOCK is a different question, and for it the same observation cuts
 * the other way. "Please speak in Hindi" is four clean English words
 * with no Hindi marker in them, so it is lock-grade English by every
 * other rule here — and locking a call to English because the caller
 * asked for HINDI is the worst outcome this feature can produce. It is
 * unrecoverable in a way the old per-turn behaviour was not: the hint,
 * the synthesis language and every fixed line would contradict the
 * request for the rest of the call.
 *
 * So an utterance that NAMES a language is REFUSED as lock evidence.
 * It is a request about language, not the caller choosing one by
 * speaking it, and the request is answered where it always was — by
 * the model, from the caller's own words, with the call still unlocked
 * so their NEXT turn (spoken in whatever they actually wanted) takes
 * the lock.
 *
 * Refusing costs nothing: an unlocked turn behaves exactly as it does
 * today. So this list only has to be right about what it DOES contain,
 * and a false positive ("I read about it on the English website")
 * merely delays the lock by one turn.
 */
const LANGUAGE_NAME_WORDS = new Set([
  "hindi", "hindee", "english", "angrezi", "angreji", "angrezee",
  "hinglish", "language", "bhasha", "bhaasha",
  "हिंदी", "हिन्दी", "अंग्रेजी", "अंग्रेज़ी", "इंग्लिश", "भाषा",
]);

/**
 * Does this utterance NAME a language? Whole-word, both scripts.
 *
 * Read only by `isLockGradeEvidence`. It changes no detection result —
 * `detectLanguage` reports the same `language`, `confidence` and
 * `script` it always did for these utterances.
 */
function mentionsALanguage(text: string): boolean {
  // The `\p{M}` in that class is not optional. Devanagari matras and
  // the virama are COMBINING MARKS, not letters, so splitting on
  // `[^\p{L}]` shatters a Hindi word into single consonants and the
  // table can never match — the same `\p{L}\p{N}\p{M}` class
  // `normaliseForPhraseMatch` uses, for the same reason. NFC first so a
  // precomposed nukta letter and its decomposed form are one token.
  for (const raw of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (raw.length > 0 && LANGUAGE_NAME_WORDS.has(raw)) return true;
  }
  return false;
}

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

/**
 * WHICH RULE PRODUCED THE RESULT. Additive and read-only — nothing about
 * `language`, `confidence` or `script` changed when this was added, and
 * a consumer that ignores it sees exactly the behaviour it always saw.
 *
 * It exists because "the detector said English" is two very different
 * claims depending on how it got there:
 *
 *   `devanagari` / `mixed-script` — the SCRIPT settled it. Latin cannot
 *      be Devanagari, so this is the one kind of evidence that cannot be
 *      a coincidence of vocabulary.
 *   `roman-markers`  — enough romanized Hindi function words to clear
 *      `HINGLISH_MARKER_RATIO`. Positive evidence, from the utterance.
 *   `default-english` — NOT positive evidence of English. It is the
 *      absence of enough Hindi evidence, which is exactly the
 *      "ambiguous romanized Hindi falls through to English" case the
 *      audit records. `hindiMarkerHits` says whether the fall-through
 *      was clean (no Hindi word at all) or contradictory.
 *   `neutral` / `empty` — the utterance carried NO language signal and
 *      `previous` was kept. Not a statement about this utterance.
 */
export type LanguageDetectionBasis =
  | "devanagari"
  | "mixed-script"
  | "roman-markers"
  | "default-english"
  | "neutral"
  | "empty";

export interface LanguageDetectionResult {
  readonly language: SupportedLanguage;
  readonly confidence: number;
  readonly script: "devanagari" | "latin" | "mixed";
  /** Which rule produced `language`. See `LanguageDetectionBasis`. */
  readonly basis: LanguageDetectionBasis;
  /**
   * How many romanized-Hindi marker words were found. `0` on every
   * Devanagari, neutral and empty path, where no marker scan is run.
   */
  readonly hindiMarkerHits: number;
  /**
   * The utterance NAMES a language ("speak in Hindi"). See
   * `LANGUAGE_NAME_WORDS` — it is a request about language, not the
   * caller choosing one by speaking it, and it is refused as lock
   * evidence.
   */
  readonly mentionsLanguage: boolean;
}

/**
 * Is this result strong enough to fix a call's language for the rest of
 * the call, as opposed to merely steering one reply?
 *
 * A per-turn hint is cheap to get wrong — the next turn re-decides. A
 * LOCK is not: it holds until the call ends. So this is deliberately
 * stricter than `detectLanguage` itself, and the difference is entirely
 * in what it refuses:
 *
 *   - `neutral` / `empty` carry no evidence at all. They report
 *     `previous`, which is the language already in play, so locking on
 *     one would freeze the call into its CONFIGURED opening language on
 *     the strength of the caller saying "okay".
 *   - `default-english` with one or more Hindi markers in it is the
 *     detector's documented weak spot: below `HINGLISH_MARKER_RATIO`
 *     but not clean English either ("aap tell me about the workshop" —
 *     one marker in six words). One reply in English there is
 *     recoverable on the next turn; a locked call is not.
 *
 * A clean `default-english` — four or more words and NOT ONE of ~150
 * common Hindi function words among them — is accepted. That is the
 * only positive evidence of English this detector can produce, and
 * refusing it would mean English calls never lock at all.
 *
 * Says nothing about whether the utterance is worth locking on
 * CONVERSATIONALLY (is it a backchannel, an echo, a hearing check, long
 * enough?). That is the pipeline's question and is answered there.
 */
export function isLockGradeEvidence(result: LanguageDetectionResult): boolean {
  // An explicit request about language outranks every basis below: see
  // `LANGUAGE_NAME_WORDS` for why locking on one is the single worst
  // outcome this feature can produce.
  if (result.mentionsLanguage) return false;
  switch (result.basis) {
    case "devanagari":
    case "mixed-script":
    case "roman-markers":
      return true;
    case "default-english":
      return result.hindiMarkerHits === 0;
    case "neutral":
    case "empty":
      return false;
  }
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
  // Computed once and carried on every result. Read by
  // `isLockGradeEvidence` only — it steers no detection below.
  const mentionsLanguage = mentionsALanguage(trimmed);

  if (trimmed.length === 0) {
    return {
      language: previous ?? SupportedLanguage.ENGLISH,
      confidence: 0,
      script: "latin",
      basis: "empty",
      hindiMarkerHits: 0,
      mentionsLanguage,
    };
  }

  const hasDevanagari = DEVANAGARI_RANGE.test(trimmed);
  const hasLatin = LATIN_LETTERS.test(trimmed);

  if (hasDevanagari) {
    if (!hasLatin) {
      return {
        language: SupportedLanguage.HINDI,
        confidence: 0.9,
        script: "devanagari",
        basis: "devanagari",
        hindiMarkerHits: 0,
        mentionsLanguage,
      };
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
      ? {
          language: SupportedLanguage.HINGLISH,
          confidence: 0.85,
          script: "mixed",
          basis: "mixed-script",
          hindiMarkerHits: 0,
          mentionsLanguage,
        }
      : {
          language: SupportedLanguage.HINDI,
          confidence: 0.85,
          script: "mixed",
          basis: "mixed-script",
          hindiMarkerHits: 0,
          mentionsLanguage,
        };
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
      basis: "roman-markers",
      hindiMarkerHits: hindiHits,
      mentionsLanguage,
    };
  }

  // Real code-mixing: enough Hindi to be deliberate, enough English
  // that replying in pure Hindi would not match how they spoke.
  if (hindiRatio >= HINGLISH_MARKER_RATIO) {
    return {
      language: SupportedLanguage.HINGLISH,
      confidence: 0.75,
      script: "latin",
      basis: "roman-markers",
      hindiMarkerHits: hindiHits,
      mentionsLanguage,
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
    return {
      language: previous,
      confidence: 0.5,
      script: "latin",
      basis: "neutral",
      hindiMarkerHits: hindiHits,
      mentionsLanguage,
    };
  }

  // Everything else — including an English sentence with one stray
  // Hindi word in it — is English.
  return {
    language: SupportedLanguage.ENGLISH,
    confidence: 0.75,
    script: "latin",
    basis: "default-english",
    hindiMarkerHits: hindiHits,
    mentionsLanguage,
  };
}