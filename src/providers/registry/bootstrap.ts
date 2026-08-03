/**
 * bootstrap.ts
 *
 * Wires every concrete provider adapter into a `ProviderRegistry`
 * instance, driven entirely by environment variables — this is the
 * "registration-time change, not an application-logic change" the
 * architecture's README describes. Nothing in `VoiceSessionManager`
 * or the Dashboard needs to know this file exists; they only ever
 * see the `ProviderRegistry` interface.
 *
 * A provider is registered only when its required environment
 * variables are present, so a deployment can configure a subset of
 * providers (e.g. only the "baseline" stack) without the other
 * adapters throwing at startup.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../../constants/providers.constants";
import { ProviderCategory } from "../../types/enums";
import type { ProviderIdentifier } from "../../types/provider.types";
import type { ProviderCategoryMap, ProviderRegistry } from "../../interfaces/provider-registry.interface";
import { InMemoryProviderRegistry } from "./in-memory-provider-registry";

import { PlivoTelephonyProvider } from "../telephony/plivo.provider";
import { DeepgramSpeechToTextProvider } from "../speech-to-text/deepgram.provider";
import { OpenAiGptLanguageModelProvider } from "../language-model/openai-gpt.provider";
import { GemmaLanguageModelProvider } from "../language-model/gemma.provider";
import { ElevenLabsTextToSpeechProvider } from "../text-to-speech/elevenlabs.provider";
import { CartesiaTextToSpeechProvider } from "../text-to-speech/cartesia.provider";
import { SarvamTextToSpeechProvider } from "../text-to-speech/sarvam.provider";
import { SmallestAiTextToSpeechProvider } from "../text-to-speech/smallest-ai.provider";

/** Outcome of attempting to register a single provider, surfaced for startup logging/diagnostics. */
export interface ProviderRegistrationOutcome {
  readonly identifier: ProviderIdentifier;
  readonly registered: boolean;
  readonly reason?: string;
}

export interface BootstrapResult {
  readonly registry: ProviderRegistry;
  readonly outcomes: readonly ProviderRegistrationOutcome[];
}

/**
 * Registers `factory()`'s provider under `category`/`id`, but only
 * if every name in `requiredEnvVars` is present. Centralizes the
 * "check env, construct, register, record outcome" sequence so it
 * isn't repeated by hand eight times below.
 */
function registerIfConfigured<C extends ProviderCategory>(
  registry: ProviderRegistry,
  category: C,
  id: string,
  requiredEnvVars: readonly string[],
  factory: () => ProviderCategoryMap[C],
  outcomes: ProviderRegistrationOutcome[],
): void {
  const identifier: ProviderIdentifier = { category, id };
  const missing = requiredEnvVars.filter((name) => !process.env[name] || process.env[name]?.trim() === "");

  if (missing.length > 0) {
    outcomes.push({
      identifier,
      registered: false,
      reason: `Missing environment variable(s): ${missing.join(", ")}`,
    });
    return;
  }

  try {
    registry.register(category, factory());
    outcomes.push({ identifier, registered: true });
  } catch (error) {
    outcomes.push({
      identifier,
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Builds a fully-wired `ProviderRegistry` from environment
 * variables. Pass an existing registry instance to register into it
 * instead of creating a new one (useful for tests).
 */
export function bootstrapProviderRegistry(
  registry: ProviderRegistry = new InMemoryProviderRegistry(),
): BootstrapResult {
  const outcomes: ProviderRegistrationOutcome[] = [];

  registerIfConfigured(
    registry,
    ProviderCategory.TELEPHONY,
    TELEPHONY_PROVIDER_IDS.PLIVO,
    ["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "PLIVO_FROM_NUMBER", "PLIVO_ANSWER_URL"],
    () => new PlivoTelephonyProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.SPEECH_TO_TEXT,
    SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
    ["DEEPGRAM_API_KEY"],
    () => new DeepgramSpeechToTextProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.LANGUAGE_MODEL,
    LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
    ["OPENAI_API_KEY"],
    () => new OpenAiGptLanguageModelProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.LANGUAGE_MODEL,
    LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
    ["GEMMA_API_KEY"],
    () => new GemmaLanguageModelProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.TEXT_TO_SPEECH,
    TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
    ["ELEVENLABS_API_KEY", "ELEVENLABS_DEFAULT_VOICE_ID"],
    () => new ElevenLabsTextToSpeechProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.TEXT_TO_SPEECH,
    TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
    ["CARTESIA_API_KEY", "CARTESIA_DEFAULT_VOICE_ID"],
    () => new CartesiaTextToSpeechProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.TEXT_TO_SPEECH,
    TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
    ["SARVAM_API_KEY", "SARVAM_DEFAULT_SPEAKER"],
    () => new SarvamTextToSpeechProvider(),
    outcomes,
  );

  registerIfConfigured(
    registry,
    ProviderCategory.TEXT_TO_SPEECH,
    TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
    ["SMALLEST_AI_API_KEY", "SMALLEST_AI_DEFAULT_VOICE_ID"],
    () => new SmallestAiTextToSpeechProvider(),
    outcomes,
  );

  return { registry, outcomes };
}
