/**
 * sarvam.provider.ts
 *
 * Concrete `TextToSpeechProvider` implementation for Sarvam AI.
 * Sarvam does not publish an official Node.js SDK, so — per the
 * task's fallback rule — this adapter calls Sarvam's official REST
 * Text-to-Speech endpoint directly via `fetch`.
 *
 * API shape (per Sarvam's published REST docs):
 *   POST https://api.sarvam.ai/text-to-speech
 *   headers: { "api-subscription-key": <key> }
 *   body: { text, target_language_code, speaker?, model?,
 *           speech_sample_rate?, enable_preprocessing? }
 *   response: { request_id, audios: string[] }  // base64 WAV per input
 */

import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { LANGUAGE_METADATA } from "../../constants/languages.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  SynthesisTaskRequest,
  TextToSpeechProvider,
} from "../../interfaces/providers/text-to-speech-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv, optionalEnvNumber } from "../shared/env";
import { postJson } from "../shared/http";
import { decodeWav } from "../shared/audio";

interface SarvamEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly defaultSpeaker: string;
  readonly sampleRateHz: number;
}

function loadEnvConfig(): SarvamEnvConfig {
  return {
    apiKey: requireEnv("SARVAM_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    baseUrl: optionalEnv("SARVAM_BASE_URL", "https://api.sarvam.ai"),
    model: optionalEnv("SARVAM_TTS_MODEL", "bulbul:v2"),
    defaultSpeaker: requireEnv("SARVAM_DEFAULT_SPEAKER", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    sampleRateHz: optionalEnvNumber("SARVAM_SAMPLE_RATE_HZ", 22050),
  };
}
function toSarvamLanguage(language: SupportedLanguage): string {
  switch (language) {
    case SupportedLanguage.ENGLISH:
      return "en-IN";

    case SupportedLanguage.HINDI:
      return "hi-IN";

    case SupportedLanguage.HINGLISH:
      return "hi-IN";
  }
}
interface SarvamTtsResponse {
  readonly request_id?: string;
  readonly audios: readonly string[];
}

export class SarvamTextToSpeechProvider implements TextToSpeechProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
    displayName: "Sarvam",
    supportedLanguages: [SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "bulbul-v2",
  };

  private readonly config: SarvamEnvConfig;

  constructor(config: SarvamEnvConfig = loadEnvConfig()) {
    this.config = config;
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const speaker = task.request.voiceId ?? this.config.defaultSpeaker;
    const response = await postJson<SarvamTtsResponse>(
      this.descriptor.id,
      `${this.config.baseUrl}/text-to-speech`,
      { "api-subscription-key": this.config.apiKey },
      {
        text: task.request.text,
        target_language_code: toSarvamLanguage(task.request.language),
        speaker,
        model: this.config.model,
        speech_sample_rate: this.config.sampleRateHz,
      },
    );

    const [firstAudio] = response.audios;
    if (!firstAudio) {
      throw new Error(`Sarvam TTS response contained no audio for session "${task.sessionId}".`);
    }

    const wavBytes = Buffer.from(firstAudio, "base64");
    const decoded = decodeWav(new Uint8Array(wavBytes));

    return {
      data: decoded.pcm,
      encoding: "PCM_16",
      sampleRateHz: decoded.sampleRateHz,
    };
  }
 
  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      // Sarvam publishes no separate health/status or list-models
      // endpoint, so the only documented way to verify reachability
      // and authentication is a minimal real call against the same
      // TTS endpoint the adapter actually uses.
      await postJson<SarvamTtsResponse>(
        this.descriptor.id,
        `${this.config.baseUrl}/text-to-speech`,
        { "api-subscription-key": this.config.apiKey },
        {
          text: "Hello ",
          target_language_code: toSarvamLanguage(SupportedLanguage.ENGLISH),
          speaker: this.config.defaultSpeaker,
          model: this.config.model,
          speech_sample_rate: this.config.sampleRateHz,
        },
      );
 
    });
  }
}
