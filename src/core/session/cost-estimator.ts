/**
 * cost-estimator.ts
 *
 * Estimated-cost heuristics for populating `BenchmarkMetrics.estimatedCost`.
 *
 * Each vendor is priced in ITS OWN billing unit rather than being
 * forced into a single shared unit:
 *
 *   Telephony (Plivo/Vobiz) -> connected minutes
 *   STT (Deepgram)          -> audio minutes
 *   LLM (GPT-5.1 / Gemma)   -> input tokens and output tokens, priced
 *                              SEPARATELY per 1M tokens
 *   TTS (ElevenLabs,        -> characters per 1K
 *        Sarvam, Smallest)
 *   TTS (Cartesia)          -> GENERATED AUDIO minutes, not characters
 *
 * Unknown/unregistered provider ids fall back to a conservative
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

/**
 * Deepgram Nova-3 Multilingual Streaming.
 *
 * Current benchmark rate:
 * $0.0058 per minute for Pay-As-You-Go streaming.
 *
 * The benchmark uses Nova-3 with multilingual/cross-language
 * conversation support, including Hindi and English code-switching.
 *
 * This rate is used for the actual streaming STT audio duration.
 */
const STT_COST_PER_MINUTE_USD: Readonly<Record<string, number>> = {
  [SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM]: 0.0058,
};

/**
 * INR -> USD divisor for the one vendor that publishes in rupees.
 *
 * The project has no pre-existing currency-conversion mechanism to
 * reuse: `EstimatedCostMetric.currency` is hard-coded "USD" in
 * `SessionMetricsCollector.build`, and `formatCurrency` only formats
 * whatever it is handed. So rather than introduce a conversion layer,
 * Sarvam's published rupee price is folded into a USD rate at module
 * load through this single constant. Update it (one place) if the rate
 * you want to benchmark against moves.
 */
const INR_PER_USD = 88;

/** Sarvam bulbul:v3 publishes ₹30 / 10,000 characters, i.e. ₹3 / 1,000. */
const SARVAM_INR_PER_1K_CHARS = 3;

/**
 * Input/output token rates per 1,000,000 tokens.
 *
 * A single blended rate is wrong for GPT-5.1 by a factor of 8 between
 * the two directions ($1.25 in vs $10 out), and a voice agent's ratio
 * is nothing like 50/50 — the prompt carries the whole system prompt
 * plus rolling history every turn while the completion is one short
 * spoken sentence. Blending therefore mispriced every turn.
 *
 * GEMMA_4: ⚠ UNVERIFIED. Gemma 4 is served here by Google AI Studio
 * (`@google/generative-ai`, model `gemma-4-31b-it` per GEMMA_MODEL),
 * and neither this repository nor its environment declares a price for
 * that endpoint. The inherited blended 0.002 / 1K rate is preserved
 * exactly — as 2.00 / 1M applied to both directions — so this change
 * does not alter Gemma's reported cost. Do not treat it as confirmed.
 */
interface TokenRateUsd {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

const LLM_COST_PER_1M_TOKENS_USD: Readonly<Record<string, TokenRateUsd>> = {
  [LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1]: { inputPer1M: 1.25, outputPer1M: 10 },
  [LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4]: { inputPer1M: 0, outputPer1M: 0 },
};

/** Vendors that bill per character of submitted text. */
const TTS_COST_PER_1K_CHARS_USD: Readonly<Record<string, number>> = {
  [TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS]: 0.05,
  [TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM]: SARVAM_INR_PER_1K_CHARS / INR_PER_USD,
  [TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI]: 0.0175,
};

/**
 * Vendors that bill per minute of GENERATED AUDIO.
 *
 * Cartesia is metered on synthesized audio duration ($5 per 100
 * generated TTS minutes on the plan this benchmark prices against), so
 * pricing it by character count — as the previous shared per-1K-chars
 * path did — measured the wrong quantity entirely. The duration used
 * must be the length of the audio produced, NOT `ttsMs`, which is
 * synthesis wall-clock latency.
 */
const TTS_COST_PER_GENERATED_MINUTE_USD: Readonly<Record<string, number>> = {
  [TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA]: 0.05,
};

const FALLBACK_TELEPHONY_PER_MINUTE_USD = 0.015;
const FALLBACK_STT_PER_MINUTE_USD = 0.006;
const FALLBACK_LLM_PER_1M_TOKENS_USD: TokenRateUsd = { inputPer1M: 5, outputPer1M: 5 };
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

/**
 * Cartesia's duration-billed rate, exposed standalone because it was
 * already part of this module's public surface (re-exported by
 * `core/session/index.ts`). Delegates to the same table
 * `estimateTtsCost` uses so the two can never disagree.
 */
export function estimateCartesiaTtsCost(generatedAudioSeconds: number): number {
  const perMinute =
    TTS_COST_PER_GENERATED_MINUTE_USD[TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA] ?? 0;
  return (generatedAudioSeconds / 60) * perMinute;
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
 * @param inputTokens Prompt tokens — the full payload actually sent,
 *   system prompt and rolling history included, not just the latest
 *   user utterance. Counted once per request.
 * @param outputTokens Completion tokens for that same request only.
 *
 * Directions are priced separately (see LLM_COST_PER_1M_TOKENS_USD):
 * passing the sum under one blended rate is what this replaces.
 *
 * Both figures are still `estimateTokenCount` approximations. Neither
 * configured provider surfaces real usage to the caller — the OpenAI
 * adapter returns only `{ turn, latencyMs }` and its stream is opened
 * without `stream_options.include_usage`; the Gemma adapter likewise
 * discards `usageMetadata` — and manufacturing those counts would mean
 * changing the LLM request/response path, which is out of scope here.
 */
export function estimateLlmCost(
  providerId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = LLM_COST_PER_1M_TOKENS_USD[providerId] ?? FALLBACK_LLM_PER_1M_TOKENS_USD;
  return (
    (inputTokens / 1_000_000) * rate.inputPer1M + (outputTokens / 1_000_000) * rate.outputPer1M
  );
}

/**
 * @param characterCount Characters submitted for synthesis. Used only
 *   by character-billed vendors.
 * @param generatedAudioSeconds Duration of the audio actually produced
 *   (from `estimateAudioSeconds`, i.e. the same basis as `playbackMs`).
 *   Required by duration-billed vendors, ignored by the others.
 *
 * The two are NOT interchangeable, which is why both are accepted and
 * the provider's own billing unit decides which one is read.
 */
export function estimateTtsCost(
  providerId: string,
  characterCount: number,
  generatedAudioSeconds?: number,
): number {
  const perGeneratedMinute = TTS_COST_PER_GENERATED_MINUTE_USD[providerId];
  if (perGeneratedMinute !== undefined) {
    if (generatedAudioSeconds === undefined) {
      // Unreachable with the current provider set: every
      // duration-billed vendor here (Cartesia) implements only
      // `synthesize()`, and that branch always has the generated
      // duration in hand. Warn loudly rather than silently substituting
      // a character-based number in a unit the vendor does not bill in.
      // eslint-disable-next-line no-console
      console.warn(
        `[COST] ${providerId} bills per generated audio minute but no generated duration was supplied — TTS cost omitted for this utterance.`,
      );
      return 0;
    }
    return (generatedAudioSeconds / 60) * perGeneratedMinute;
  }

  const per1k = TTS_COST_PER_1K_CHARS_USD[providerId] ?? FALLBACK_TTS_PER_1K_CHARS_USD;
  return (characterCount / 1000) * per1k;
}
