/**
 * cost-estimator.ts
 *
 * Estimated-cost heuristics for populating `BenchmarkMetrics.estimatedCost`.
 * These are approximations based on each vendor's published per-unit
 * pricing structure (per-minute audio for STT, per-1K-tokens for
 * LLMs, per-1K-characters for TTS) — not a billing-grade ledger.
 * Unknown/未registered provider ids fall back to a conservative
 * blended default so a new provider never causes a crash or a
 * silently-zeroed cost line.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../../constants/providers.constants";

/**
 * Per-minute voice rates for the CONNECTED portion of a call.
 *
 * Telephony was previously the one category that could never
 * contribute anything: the collector initialised its total to 0 and
 * nothing ever added to it, so the per-minute charge — the single
 * largest structural cost difference between two telephony vendors —
 * was silently missing from the exact number the lab exists to
 * compare. These are order-of-magnitude list-price placeholders;
 * replace them with your contracted rates before quoting figures.
 */
const TELEPHONY_COST_PER_MINUTE_USD: Readonly<Record<string, number>> = {
  [TELEPHONY_PROVIDER_IDS.PLIVO]: 0.0125,
  [TELEPHONY_PROVIDER_IDS.VOBIZ]: 0.0125,
};

const STT_COST_PER_MINUTE_USD: Readonly<Record<string, number>> = {
  [SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM]: 0.0043,
};

const LLM_COST_PER_1K_TOKENS_USD: Readonly<Record<string, number>> = {
  [LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1]: 0.01,
  [LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4]: 0.002,
};

const TTS_COST_PER_1K_CHARS_USD: Readonly<Record<string, number>> = {
  [TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS]: 0.18,
  [TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA]: 0.06,
  [TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM]: 0.02,
  [TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI]: 0.02,
};

const FALLBACK_TELEPHONY_PER_MINUTE_USD = 0.015;
const FALLBACK_STT_PER_MINUTE_USD = 0.006;
const FALLBACK_LLM_PER_1K_TOKENS_USD = 0.005;
const FALLBACK_TTS_PER_1K_CHARS_USD = 0.05;

/**
 * Characters per token, by script.
 *
 * A flat ~4 chars/token is a Latin-text rule of thumb. Devanagari
 * tokenizes far worse — commonly 1-2 characters per token — so on a
 * platform whose configured languages are en / hi / hi-en, a flat
 * divisor undercounted every Hindi and Hinglish turn several-fold.
 */
const LATIN_CHARS_PER_TOKEN = 4;
const DEVANAGARI_CHARS_PER_TOKEN = 1.5;

/** Script-aware rough token estimate — good enough for a cost estimate, not for billing. */
export function estimateTokenCount(text: string): number {
  const devanagariChars = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  const otherChars = text.length - devanagariChars;
  return Math.ceil(
    otherChars / LATIN_CHARS_PER_TOKEN + devanagariChars / DEVANAGARI_CHARS_PER_TOKEN,
  );
}

export function estimateTelephonyCost(providerId: string, connectedSeconds: number): number {
  const perMinute = TELEPHONY_COST_PER_MINUTE_USD[providerId] ?? FALLBACK_TELEPHONY_PER_MINUTE_USD;
  return (connectedSeconds / 60) * perMinute;
}

export function estimateSttCost(providerId: string, audioSeconds: number): number {
  const perMinute = STT_COST_PER_MINUTE_USD[providerId] ?? FALLBACK_STT_PER_MINUTE_USD;
  return (audioSeconds / 60) * perMinute;
}

/**
 * @param approxTotalTokens Prompt tokens PLUS completion tokens. The
 *   prompt is the full payload actually sent — system prompt and
 *   recent history included, not just the latest user utterance,
 *   which is what the caller used to pass and is why multi-turn calls
 *   were undercounted by roughly an order of magnitude.
 *
 * Still a single blended per-1K rate rather than a separate
 * input/output split, so this remains an estimate.
 */
export function estimateLlmCost(providerId: string, approxTotalTokens: number): number {
  const per1k = LLM_COST_PER_1K_TOKENS_USD[providerId] ?? FALLBACK_LLM_PER_1K_TOKENS_USD;
  return (approxTotalTokens / 1000) * per1k;
}

export function estimateTtsCost(providerId: string, characterCount: number): number {
  const per1k = TTS_COST_PER_1K_CHARS_USD[providerId] ?? FALLBACK_TTS_PER_1K_CHARS_USD;
  return (characterCount / 1000) * per1k;
}
