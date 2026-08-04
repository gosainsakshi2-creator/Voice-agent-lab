/**
 * mock-providers.ts
 *
 * Mock `ProviderDescriptor` data for every provider id locked in
 * `constants/providers.constants.ts`. This is display data only —
 * standing in for what `ProviderRegistry.listByCategory` would
 * return at runtime. No provider is implemented here.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "@/constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "@/types/enums";
import type { ProviderDescriptor } from "@/types/provider.types";

const ALL_LANGUAGES: readonly SupportedLanguage[] = [
  SupportedLanguage.ENGLISH,
  SupportedLanguage.HINDI,
  SupportedLanguage.HINGLISH,
];

export const MOCK_TELEPHONY_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    category: ProviderCategory.TELEPHONY,
    id: TELEPHONY_PROVIDER_IDS.PLIVO,
    displayName: "Plivo",
    supportedLanguages: ALL_LANGUAGES,
    version: "2.4.1",
  },
];

export const MOCK_SPEECH_TO_TEXT_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    category: ProviderCategory.SPEECH_TO_TEXT,
    id: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
    displayName: "Deepgram",
    supportedLanguages: ALL_LANGUAGES,
    version: "nova-3",
  },
];

export const MOCK_LANGUAGE_MODEL_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    category: ProviderCategory.LANGUAGE_MODEL,
    id: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
    displayName: "GPT-5.1",
    supportedLanguages: ALL_LANGUAGES,
    version: "2026-01",
  },
  {
    category: ProviderCategory.LANGUAGE_MODEL,
    id: LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
    displayName: "Gemma 4",
    supportedLanguages: [SupportedLanguage.HINDI, SupportedLanguage.HINGLISH, SupportedLanguage.ENGLISH],
    version: "4.0",
  },
];

export const MOCK_TEXT_TO_SPEECH_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
    displayName: "ElevenLabs",
    supportedLanguages: ALL_LANGUAGES,
    version: "v3",
  },
  {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
    displayName: "Cartesia",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH],
    version: "sonic-3.5",
  },
  {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
    displayName: "Sarvam",
    supportedLanguages: [SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "bulbul-v2",
  },
  {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
    displayName: "Smallest AI",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "lightning-v1",
  },
];

export const MOCK_PROVIDERS_BY_CATEGORY: Readonly<
  Record<ProviderCategory, readonly ProviderDescriptor[]>
> = {
  [ProviderCategory.TELEPHONY]: MOCK_TELEPHONY_PROVIDERS,
  [ProviderCategory.SPEECH_TO_TEXT]: MOCK_SPEECH_TO_TEXT_PROVIDERS,
  [ProviderCategory.LANGUAGE_MODEL]: MOCK_LANGUAGE_MODEL_PROVIDERS,
  [ProviderCategory.TEXT_TO_SPEECH]: MOCK_TEXT_TO_SPEECH_PROVIDERS,
};
