/**
 * smallest-ai.provider.ts
 *
 * Concrete `TextToSpeechProvider` implementation for Smallest AI's
 * "Lightning" TTS model. Smallest AI does not publish an official
 * Node.js SDK, so — per the task's fallback rule — this adapter
 * calls Smallest AI's official REST synthesis endpoint directly via
 * `fetch`, returning raw audio bytes (WAV container) in the response
 * body.
 *
 * API shape (per Smallest AI's published REST docs):
 *   POST https://waves-api.smallest.ai/api/v1/lightning/get_speech
 *   headers: { Authorization: "Bearer <key>" }
 *   body: { text, voice_id, sample_rate?, speed? }
 *   response: audio bytes (audio/wav) in the response body
 */


import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  SynthesisTaskRequest,
  TextToSpeechProvider,
} from "../../interfaces/providers/text-to-speech-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv, optionalEnvNumber } from "../shared/env";
import { postJsonForBinary } from "../shared/http";
import { decodeWav } from "../shared/audio";

interface SmallestAiEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultVoiceId: string;
  readonly sampleRateHz: number;
  /** `speed` — clamped to the documented 0.5–2.0 window (vendor default 1.0). */
  readonly speed: number;
}

const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

function loadEnvConfig(): SmallestAiEnvConfig {
  return {
    apiKey: requireEnv("SMALLEST_AI_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI),
    baseUrl: optionalEnv("SMALLEST_AI_BASE_URL", "https://api.smallest.ai"),
    defaultVoiceId: requireEnv("SMALLEST_AI_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI),
    sampleRateHz: optionalEnvNumber("SMALLEST_AI_SAMPLE_RATE_HZ", 24000),
    // Clamp rather than throw — an out-of-range speed would be rejected
    // by the API mid-call, which is a worse failure than the nearest
    // legal value.
    speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, optionalEnvNumber("SMALLEST_AI_SPEED", 1.0))),
  };
}

export class SmallestAiTextToSpeechProvider implements TextToSpeechProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
    displayName: "Smallest AI",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "lightning-v3.1",
  };

  private readonly config: SmallestAiEnvConfig;

  constructor(config: SmallestAiEnvConfig = loadEnvConfig()) {
    this.config = config;
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;

    const wavBytes = await postJsonForBinary(
      this.descriptor.id,
      `${this.config.baseUrl}/waves/v1/tts`,
      {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "audio/wav",
      },
      {
        text: task.request.text,
        voice_id: voiceId,
        sample_rate: this.config.sampleRateHz,
        output_format: "wav",
        speed: this.config.speed,
      },
    );

    const decoded = decodeWav(wavBytes);

    return {
      data: decoded.pcm,
      encoding: "PCM_16",
      sampleRateHz: decoded.sampleRateHz,
    };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      // Smallest AI publishes no separate health/status endpoint;
      // verify reachability and authentication with a minimal real
      // call against the same synthesis endpoint the adapter uses.
      await postJsonForBinary(
        this.descriptor.id,
        `${this.config.baseUrl}/waves/v1/tts`,
        {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "audio/wav",
        },
        {
          text: "Hello",
          voice_id: this.config.defaultVoiceId,
          sample_rate: this.config.sampleRateHz,
          output_format: "wav",
          speed: this.config.speed,
        },
      );
    });
  }
}
