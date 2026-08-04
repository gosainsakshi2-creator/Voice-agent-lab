/**
 * providers.constants.ts
 *
 * Locked provider identifiers for this deployment of Voice Agent
 * Lab. These are the ONLY provider ids the Provider Registry is
 * expected to have entries for out of the box. Adding a new vendor
 * later means extending these consts (and the env typing) — no
 * changes to VoiceSessionManager or any interface are required.
 */

import { ProviderCategory } from "../types/enums";

export const TELEPHONY_PROVIDER_IDS = {
  PLIVO: "plivo",
  VOBIZ: "vobiz",
} as const;

export const SPEECH_TO_TEXT_PROVIDER_IDS = {
  DEEPGRAM: "deepgram",
} as const;

export const LANGUAGE_MODEL_PROVIDER_IDS = {
  GPT_5_1: "gpt-5.1",
  GEMMA_4: "gemma-4",
} as const;

export const TEXT_TO_SPEECH_PROVIDER_IDS = {
  ELEVENLABS: "elevenlabs",
  CARTESIA: "cartesia",
  SARVAM: "sarvam",
  SMALLEST_AI: "smallest-ai",
} as const;

export type TelephonyProviderId =
  (typeof TELEPHONY_PROVIDER_IDS)[keyof typeof TELEPHONY_PROVIDER_IDS];

export type SpeechToTextProviderId =
  (typeof SPEECH_TO_TEXT_PROVIDER_IDS)[keyof typeof SPEECH_TO_TEXT_PROVIDER_IDS];

export type LanguageModelProviderId =
  (typeof LANGUAGE_MODEL_PROVIDER_IDS)[keyof typeof LANGUAGE_MODEL_PROVIDER_IDS];

export type TextToSpeechProviderId =
  (typeof TEXT_TO_SPEECH_PROVIDER_IDS)[keyof typeof TEXT_TO_SPEECH_PROVIDER_IDS];

/**
 * Flat lookup of every category -> allowed id list, useful for
 * validating a ProviderConfigEntry at startup without a switch
 * statement scattered across the codebase.
 */
export const PROVIDER_IDS_BY_CATEGORY: Readonly<
  Record<ProviderCategory, readonly string[]>
> = {
  [ProviderCategory.TELEPHONY]: Object.values(TELEPHONY_PROVIDER_IDS),
  [ProviderCategory.SPEECH_TO_TEXT]: Object.values(SPEECH_TO_TEXT_PROVIDER_IDS),
  [ProviderCategory.LANGUAGE_MODEL]: Object.values(LANGUAGE_MODEL_PROVIDER_IDS),
  [ProviderCategory.TEXT_TO_SPEECH]: Object.values(TEXT_TO_SPEECH_PROVIDER_IDS),
};
