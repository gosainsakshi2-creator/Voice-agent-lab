/**
 * provider.config.ts
 *
 * Declares reusable ProviderStackPreset entries the Dashboard can
 * surface for quick benchmark setup. Pure data — no logic.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../constants/providers.constants";
import type { ProviderStackPreset } from "../types/config.types";

export const PROVIDER_STACK_PRESETS: readonly ProviderStackPreset[] = [
  {
    id: "baseline-elevenlabs-gpt",
    label: "Baseline — ElevenLabs + GPT-5.1",
    description: "Reference stack for English benchmarking.",
    telephonyId: TELEPHONY_PROVIDER_IDS.PLIVO,
    speechToTextId: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
    languageModelId: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
    textToSpeechId: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
  },
  {
    id: "hindi-sarvam-gemma",
    label: "Hindi — Sarvam + Gemma 4",
    description: "Low-latency stack tuned for Hindi/Hinglish.",
    telephonyId: TELEPHONY_PROVIDER_IDS.PLIVO,
    speechToTextId: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
    languageModelId: LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
    textToSpeechId: TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
  },
];
