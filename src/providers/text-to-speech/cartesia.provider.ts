/**
 * cartesia.provider.ts
 *
 * Concrete `TextToSpeechProvider` implementation backed by
 * Cartesia's official Node.js SDK (`@cartesia/cartesia-js`). Uses
 * the "bytes" endpoint (`client.tts.generate`) with a raw PCM
 * output format — no container to strip.
 */

import Cartesia from "@cartesia/cartesia-js";
import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  SynthesisTaskRequest,
  TextToSpeechProvider,
} from "../../interfaces/providers/text-to-speech-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv, optionalEnvNumber } from "../shared/env";

interface CartesiaEnvConfig {
  readonly apiKey: string;
  readonly modelId: string;
  readonly defaultVoiceId: string;
  readonly sampleRateHz: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  /** Sonic-3+ `generation_config.speed`, clamped to the SDK's documented [0.6, 1.5]. */
  readonly speed: number;
}

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;

/** Documented bounds of `GenerationConfig.speed` in @cartesia/cartesia-js v3.5.1. */
const MIN_SPEED = 0.6;
const MAX_SPEED = 1.5;

function loadEnvConfig(): CartesiaEnvConfig {
  const rate = optionalEnvNumber("CARTESIA_SAMPLE_RATE_HZ", 16000);
  const sampleRateHz = (SUPPORTED_SAMPLE_RATES as readonly number[]).includes(rate)
    ? (rate as CartesiaEnvConfig["sampleRateHz"])
    : 16000;

  // Clamp rather than throw: an out-of-range value would otherwise be
  // rejected by the API mid-call, which is a worse failure mode than
  // speaking at the nearest legal rate.
  const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, optionalEnvNumber("CARTESIA_SPEED", 1.0)));

  return {
    apiKey: requireEnv("CARTESIA_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA),
    modelId: optionalEnv("CARTESIA_MODEL_ID", "sonic"),
    defaultVoiceId: requireEnv("CARTESIA_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA),
    sampleRateHz,
    speed,
  };
}

/**
 * Cartesia's `SupportedLanguage` union has no distinct Hinglish
 * ("hi-en") tag; "hi" is the closest documented option rather than
 * an invented one.
 */
function toCartesiaLanguage(language: SupportedLanguage): string {
  switch (language) {
    case SupportedLanguage.ENGLISH:
      return "en";
    case SupportedLanguage.HINDI:
    case SupportedLanguage.HINGLISH:
      return "hi";
  }
}

export class CartesiaTextToSpeechProvider implements TextToSpeechProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
    displayName: "Cartesia",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH],
    version: "sonic",
  };

  private readonly client: Cartesia;
  private readonly config: CartesiaEnvConfig;

  constructor(config: CartesiaEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new Cartesia({ apiKey: config.apiKey });
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;

    const response = await this.client.tts.generate({
      model_id: this.config.modelId,
      transcript: task.request.text,
      voice: { id: voiceId, mode: "id" },
      language: toCartesiaLanguage(task.request.language),
      // `generation_config` is the only officially supported voice-control
      // surface in @cartesia/cartesia-js v3.5.1 — the v2-era
      // `voice.__experimental_controls` object no longer exists. The SDK
      // documents it as applying to `sonic-3` and newer only, so on an
      // older CARTESIA_MODEL_ID it is simply ignored rather than an error.
      // `emotion` and `volume` are also available here; both are left
      // unset so the voice keeps its natural delivery.
      generation_config: { speed: this.config.speed },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: this.config.sampleRateHz,
      },
    });

    const arrayBuffer = await response.arrayBuffer();

    return {
      data: new Uint8Array(arrayBuffer),
      encoding: "PCM_16",
      sampleRateHz: this.config.sampleRateHz,
    };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.voices.list();
    });
  }
}
