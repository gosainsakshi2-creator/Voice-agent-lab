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
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../../constants/providers.constants";

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

const FALLBACK_STT_PER_MINUTE_USD = 0.006;
const FALLBACK_LLM_PER_1K_TOKENS_USD = 0.005;
const FALLBACK_TTS_PER_1K_CHARS_USD = 0.05;

/** Very rough token estimate (~4 characters/token) — good enough for a cost estimate, not for billing. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateSttCost(providerId: string, audioSeconds: number): number {
  const perMinute = STT_COST_PER_MINUTE_USD[providerId] ?? FALLBACK_STT_PER_MINUTE_USD;
  return (audioSeconds / 60) * perMinute;
}

export function estimateLlmCost(providerId: string, approxTotalTokens: number): number {
  const per1k = LLM_COST_PER_1K_TOKENS_USD[providerId] ?? FALLBACK_LLM_PER_1K_TOKENS_USD;
  return (approxTotalTokens / 1000) * per1k;
}

export function estimateTtsCost(providerId: string, characterCount: number): number {
  const per1k = TTS_COST_PER_1K_CHARS_USD[providerId] ?? FALLBACK_TTS_PER_1K_CHARS_USD;
  return (characterCount / 1000) * per1k;
}
