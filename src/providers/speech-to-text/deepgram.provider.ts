/**
 * deepgram.provider.ts
 *
 * Concrete `SpeechToTextProvider` implementation backed by
 * Deepgram's official Node.js SDK (`@deepgram/sdk`). Uses the
 * pre-recorded ("batch") transcription endpoint
 * (`client.listen.v1.media.transcribeFile`) since streaming/partial
 * results are explicitly out of scope for this architecture pass
 * (see `SpeechToTextProvider.transcribe` doc comment).
 */
import type { StreamingTranscriptionRequest } from "../../types/streaming.types";
import { DeepgramClient } from "@deepgram/sdk";
import { SPEECH_TO_TEXT_PROVIDER_IDS } from "../../constants/providers.constants";
import { LANGUAGE_METADATA } from "../../constants/languages.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus, TranscriptSegment } from "../../types/provider.types";
import type {
  SpeechToTextProvider,
  TranscriptionRequest,
} from "../../interfaces/providers/speech-to-text-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv } from "../shared/env";
import { AsyncQueue } from "../../core/session/async-queue";
interface DeepgramEnvConfig {
  readonly apiKey: string;
  readonly model: string;
}

function loadEnvConfig(): DeepgramEnvConfig {
  return {
    apiKey: requireEnv("DEEPGRAM_API_KEY", SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM),
    model: optionalEnv("DEEPGRAM_MODEL", "nova-3"),
  };
}

/** Maps our closed `AudioEncoding` set to Deepgram's request encoding literal. */
function toDeepgramEncoding(encoding: TranscriptionRequest["audio"]["encoding"]): string {
  switch (encoding) {
    case "PCM_16":
      return "linear16";
    case "MULAW":
      return "mulaw";
    case "OPUS":
      return "opus";
  }
}

export class DeepgramSpeechToTextProvider implements SpeechToTextProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.SPEECH_TO_TEXT,
    id: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
    displayName: "Deepgram",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "nova-3",
  };

  private readonly client: DeepgramClient;
  private readonly config: DeepgramEnvConfig;

  constructor(config: DeepgramEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new DeepgramClient({ apiKey: config.apiKey });
  }

  async transcribe(request: TranscriptionRequest): Promise<readonly TranscriptSegment[]> {
    // Deepgram's `transcribeFile` expects a Node.js Buffer (or a
    // ReadableStream / URL). The VAD segmenter hands us a Uint8Array.
    // Passing a raw Uint8Array to older SDK versions can cause a silent
    // failure or a "source not provided" error. Wrap to Buffer to be safe.
    const audioBuffer = Buffer.isBuffer(request.audio.data)
      ? request.audio.data
      : Buffer.from(
          request.audio.data.buffer,
          request.audio.data.byteOffset,
          request.audio.data.byteLength,
        );

    // eslint-disable-next-line no-console
    console.log(
      `[STT:deepgram] transcribe: encoding=${request.audio.encoding} sampleRate=${request.audio.sampleRateHz} bytes=${audioBuffer.byteLength} language=${LANGUAGE_METADATA[request.language].bcp47Tag} model=${this.config.model}`,
    );

    const response = await this.client.listen.v1.media.transcribeFile(
      audioBuffer,
      {
        model: this.config.model,
        encoding: toDeepgramEncoding(request.audio.encoding),
        language: LANGUAGE_METADATA[request.language].bcp47Tag,
        punctuate: true,
        smart_format: true,
      },
      // `sample_rate` is a documented Deepgram query parameter required
      // alongside `encoding` for raw/headerless audio, but it is not part
      // of the SDK's typed request body — pass it through `queryParams`
      // rather than inventing a body field the SDK doesn't declare.
      { queryParams: { sample_rate: request.audio.sampleRateHz } },
    );

    // Streaming/partial-result semantics are out of scope, so batch
    // transcription always yields final segments.
    if (!("results" in response)) {
      // eslint-disable-next-line no-console
      console.log(`[STT:deepgram] transcribeFile returned async/accepted response (no inline results)`);
      // ListenV1AcceptedResponse (async callback flow) — no inline
      // transcript is available synchronously.
      return [];
    }

    const alternative = response.results.channels[0]?.alternatives?.[0];
    if (!alternative || !alternative.transcript) {
      // eslint-disable-next-line no-console
      console.log(`[STT:deepgram] No transcript in response (silence or unrecognized audio)`);
      return [];
    }

    // eslint-disable-next-line no-console
    console.log(
      `[STT:deepgram] Transcript: "${alternative.transcript.slice(0, 80)}${alternative.transcript.length > 80 ? "..." : ""}" confidence=${alternative.confidence}`,
    );

    const words = alternative.words ?? [];
    const startedAtMs = words.length > 0 ? (words[0]?.start ?? 0) * 1000 : 0;
    const endedAtMs = words.length > 0 ? (words[words.length - 1]?.end ?? 0) * 1000 : 0;

    const segment: TranscriptSegment = {
      text: alternative.transcript,
      isFinal: true,
      confidence: alternative.confidence ?? 0,
      language: request.language,
      startedAtMs,
      endedAtMs,
    };

    return [segment];
  }
  async *transcribeStream(
  request: StreamingTranscriptionRequest,
): AsyncIterable<TranscriptSegment> {
 const queue = new AsyncQueue<TranscriptSegment>();
  const socket = await this.client.listen.v1.connect({

  model: this.config.model,

  language: LANGUAGE_METADATA[request.language].bcp47Tag,

  encoding: toDeepgramEncoding("MULAW"),

  sample_rate: 8000,

interim_results: "true",
smart_format: "true",
punctuate: "true",
vad_events: "true",

  endpointing: 300,

});
await socket.waitForOpen();
}
  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.manage.v1.projects.list();
    });
  }
}
