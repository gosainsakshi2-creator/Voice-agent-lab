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
  /** `pace` — clamped to bulbul:v3's documented 0.5–2.0 window. */
  readonly pace: number;
}

/**
 * `pace` is documented as 0.5–2.0 on bulbul:v3 and 0.3–3.0 on
 * bulbul:v2; the narrower window is used so a single value is legal
 * on both models regardless of which SARVAM_TTS_MODEL is configured.
 */
const MIN_PACE = 0.5;
const MAX_PACE = 2.0;

function loadEnvConfig(): SarvamEnvConfig {
  return {
    apiKey: requireEnv("SARVAM_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    baseUrl: optionalEnv("SARVAM_BASE_URL", "https://api.sarvam.ai"),
    model: optionalEnv("SARVAM_TTS_MODEL", "bulbul:v2"),
    defaultSpeaker: requireEnv("SARVAM_DEFAULT_SPEAKER", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    sampleRateHz: optionalEnvNumber("SARVAM_SAMPLE_RATE_HZ", 22050),
    // Clamp rather than throw — an out-of-range pace would be rejected
    // by the API mid-call, which is a worse failure than the nearest
    // legal value.
    pace: Math.min(MAX_PACE, Math.max(MIN_PACE, optionalEnvNumber("SARVAM_PACE", 1.0))),
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
        // `pace` is the one delivery control Sarvam supports on BOTH
        // bulbul:v2 and bulbul:v3 (v3 dropped `pitch` and `loudness`).
        // Deliberately NOT sending `enable_preprocessing`: it is a v2-only
        // field — on bulbul:v3 normalization of English words and numeric
        // entities is always on and cannot be toggled, so sending it would
        // be an unsupported parameter with no effect.
        pace: this.config.pace,
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
  // `speed` and `enable_preprocessing` were previously sent here.
  // Sarvam has no `speed` field at all (the pacing control is `pace`),
  // and `enable_preprocessing` is v2-only, so neither belongs in the
  // probe — the health check should mirror the real synthesis payload.
  pace: this.config.pace,
},
      );
 
    });
  }
}
