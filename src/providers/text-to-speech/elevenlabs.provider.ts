/**
 * elevenlabs.provider.ts
 *
 * Concrete `TextToSpeechProvider` implementation backed by
 * ElevenLabs' official Node.js SDK (`@elevenlabs/elevenlabs-js`).
 * Requests raw PCM output directly (no container), so no WAV
 * decoding is required, unlike the REST-only vendors in this layer.
 */

import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  SynthesisTaskRequest,
  TextToSpeechProvider,
} from "../../interfaces/providers/text-to-speech-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv, optionalEnvNumber } from "../shared/env";

interface ElevenLabsEnvConfig {
  readonly apiKey: string;
  readonly modelId: string;
  readonly defaultVoiceId: string;
  readonly sampleRateHz: number;
}

function loadEnvConfig(): ElevenLabsEnvConfig {
  return {
    apiKey: requireEnv("ELEVENLABS_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS),
    modelId: optionalEnv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    defaultVoiceId: requireEnv("ELEVENLABS_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS),
    sampleRateHz: optionalEnvNumber("ELEVENLABS_SAMPLE_RATE_HZ", 16000),
  };
}

/** Reads a full ReadableStream<Uint8Array> into a single Uint8Array. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * ElevenLabs' `languageCode` expects an ISO 639-1 tag and is only
 * honored by models that support explicit language enforcement.
 * "hi-en" (Hinglish) has no ISO 639-1 equivalent, so it is left
 * unset and the multilingual model auto-detects instead — better
 * than inventing an unsupported tag.
 */
function languageToIsoCode(language: SupportedLanguage): string | undefined {
  switch (language) {
    case SupportedLanguage.ENGLISH:
      return "en";
    case SupportedLanguage.HINDI:
      return "hi";
    case SupportedLanguage.HINGLISH:
      return undefined;
  }
}

/** Restricts a configured sample rate to ElevenLabs' documented raw-PCM output-format literals. */
function toPcmOutputFormat(sampleRateHz: number): ElevenLabs.TextToSpeechConvertRequestOutputFormat {
  const supported: Record<number, ElevenLabs.TextToSpeechConvertRequestOutputFormat> = {
    8000: "pcm_8000",
    16000: "pcm_16000",
    22050: "pcm_22050",
    24000: "pcm_24000",
    32000: "pcm_32000",
    44100: "pcm_44100",
    48000: "pcm_48000",
  };
  const format = supported[sampleRateHz];
  if (!format) {
    throw new Error(
      `Unsupported ELEVENLABS_SAMPLE_RATE_HZ "${sampleRateHz}". ` +
        `Supported values: ${Object.keys(supported).join(", ")}.`,
    );
  }
  return format;
}

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TEXT_TO_SPEECH,
    id: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
    displayName: "ElevenLabs",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "v2",
  };

  private readonly client: ElevenLabsClient;
  private readonly config: ElevenLabsEnvConfig;

  constructor(config: ElevenLabsEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;
    const languageCode = languageToIsoCode(task.request.language);

    const stream = await this.client.textToSpeech.convert(voiceId, {
      text: task.request.text,
      modelId: this.config.modelId,
      outputFormat: toPcmOutputFormat(this.config.sampleRateHz),
      ...(languageCode ? { languageCode } : {}),
    });

    const data = await collectStream(stream);

    return {
      data,
      encoding: "PCM_16",
      sampleRateHz: this.config.sampleRateHz,
    };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.models.list();
    });
  }
}
