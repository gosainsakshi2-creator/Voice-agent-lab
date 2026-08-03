/**
 * mock-session.ts
 *
 * Mock data standing in for what `VoiceSessionManager` would return
 * from `getSnapshot` / `getWarmupResult`, plus a default
 * `ProviderStackSelection` used to seed the Benchmark Configuration
 * panel. No `VoiceSessionManager` implementation lives here.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "@/constants/providers.constants";
import { CallDirection, ProviderCategory, SupportedLanguage } from "@/types/enums";
import type { ProviderHealthStatus } from "@/types/provider.types";
import type {
  ProviderStackSelection,
  SessionCreationRequest,
  SessionId,
} from "@/types/session.types";

/** Casts a plain string to the branded `SessionId` type for mock/demo purposes. */
export function toSessionId(value: string): SessionId {
  return value as SessionId;
}

export const MOCK_SESSION_ID: SessionId = toSessionId("sess_9f21c4e0");

export const DEFAULT_PROVIDER_STACK: ProviderStackSelection = {
  telephony: { category: ProviderCategory.TELEPHONY, id: TELEPHONY_PROVIDER_IDS.PLIVO },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1 },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS },
};

export const DEFAULT_SESSION_REQUEST: SessionCreationRequest = {
  language: SupportedLanguage.HINGLISH,
  direction: CallDirection.OUTBOUND,
  providerStack: DEFAULT_PROVIDER_STACK,
  destinationNumber: "+91 98765 43210",
};

/**
 * Mock `ProviderHealthStatus` entries for the "System Health"
 * section, keyed by provider id. Stands in for
 * `ProviderRegistry.checkAllHealth`.
 */
export const MOCK_PROVIDER_HEALTH: readonly ProviderHealthStatus[] = [
  {
    identifier: { category: ProviderCategory.TELEPHONY, id: TELEPHONY_PROVIDER_IDS.PLIVO },
    isHealthy: true,
    checkedAt: new Date(),
    latencyMs: 42,
  },
  {
    identifier: { category: ProviderCategory.SPEECH_TO_TEXT, id: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM },
    isHealthy: true,
    checkedAt: new Date(),
    latencyMs: 118,
  },
  {
    identifier: { category: ProviderCategory.LANGUAGE_MODEL, id: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1 },
    isHealthy: true,
    checkedAt: new Date(),
    latencyMs: 640,
  },
  {
    identifier: { category: ProviderCategory.TEXT_TO_SPEECH, id: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS },
    isHealthy: false,
    checkedAt: new Date(),
    latencyMs: 1240,
    message: "Elevated latency on synthesis endpoint",
  },
];
