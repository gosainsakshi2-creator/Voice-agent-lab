/**
 * cartesia.provider.ts
 *
 * Concrete `TextToSpeechProvider` implementation backed by
 * Cartesia's official Node.js SDK (`@cartesia/cartesia-js`). Uses
 * the "bytes" endpoint (`client.tts.generate`) with a raw PCM
 * output format — no container to strip.
 *
 * `synthesizeStream` (the optional interface member) additionally
 * exposes the SSE endpoint, which is what the pipeline prefers. See
 * the long note on that method for the measurement that motivated it:
 * `generate()` cannot return a byte until the WHOLE clip is rendered,
 * so its time-to-first-audio grows with the text (~5.9ms per
 * character), while the SSE endpoint's is flat at ~160-230ms.
 */

import Cartesia from "@cartesia/cartesia-js";
import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type { TtsAudioChunk } from "../../types/streaming.types";
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
}

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;

function loadEnvConfig(): CartesiaEnvConfig {
  const rate = optionalEnvNumber("CARTESIA_SAMPLE_RATE_HZ", 16000);
  const sampleRateHz = (SUPPORTED_SAMPLE_RATES as readonly number[]).includes(rate)
    ? (rate as CartesiaEnvConfig["sampleRateHz"])
    : 16000;

  return {
    apiKey: requireEnv("CARTESIA_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA),
    modelId: optionalEnv("CARTESIA_MODEL_ID", "sonic-3.5"),
    defaultVoiceId: requireEnv("CARTESIA_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA),
    sampleRateHz,
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
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI],
    version: "sonic-3.5",
  };

  private readonly client: Cartesia;
  private readonly config: CartesiaEnvConfig;

  constructor(config: CartesiaEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new Cartesia({ apiKey: config.apiKey });
  }

  /**
   * The request body, shared by BOTH synthesis paths.
   *
   * Extracted for one reason, and it is a safety property rather than
   * tidiness: `synthesize` and `synthesizeStream` differ only in which
   * endpoint they post to. Model, voice, `generation_config` (speed,
   * emotion, volume), language and output format are produced here, so
   * the two paths cannot drift and the audio the caller hears is
   * byte-identical whichever one the pipeline picks. Every value below
   * is exactly what `synthesize` sent before this method existed.
   */
  private requestBody(task: SynthesisTaskRequest) {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;

    return {
      model_id: this.config.modelId,
      transcript: task.request.text,
      voice: { id: voiceId, mode: "id" as const },
      generation_config: {
        speed: 1.25,
        emotion: "neutral" as const,
        volume: 1.5,
      },
      language: toCartesiaLanguage(task.request.language),
      output_format: {
        container: "raw" as const,
        encoding: "pcm_s16le" as const,
        sample_rate: this.config.sampleRateHz,
      },
    };
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const response = await this.client.tts.generate(this.requestBody(task));

    const arrayBuffer = await response.arrayBuffer();

    return {
      data: new Uint8Array(arrayBuffer),
      encoding: "PCM_16",
      sampleRateHz: this.config.sampleRateHz,
    };
  }

  /**
   * OPTIONAL, ADDITIVE — the SSE endpoint, not a replacement for
   * `synthesize`.
   *
   * ── Why this exists ────────────────────────────────────────────────
   *
   * `tts.generate()` posts to the "bytes" endpoint, which renders the
   * ENTIRE clip before it sends a single byte. Time-to-first-audio for
   * a chunk therefore equals full synthesis time for that chunk and
   * grows with its length. `tts.generateSSE()` posts to the SSE
   * endpoint, which emits audio while the rest is still generating.
   *
   * Measured against this account, `sonic-3.5`, 16kHz, the exact
   * `generation_config` above, on the real first chunks this campaign's
   * replies produce — two samples each, warm connection:
   *
   *   first chunk    bytes endpoint   SSE endpoint   clip
   *    27 chars        700ms           230ms         2880ms
   *    68 chars        812ms           163ms         3760ms
   *   109 chars       1120ms           167ms         6080ms
   *   140 chars       1368ms           159ms         8480ms
   *   146 chars       1536ms           184ms         8800ms
   *
   * The bytes endpoint costs ~5.9ms per character; the SSE endpoint is
   * FLAT, because it is bounded by the first frame rather than by the
   * clip. Total synthesis time and the total byte count are the same on
   * both paths (identical audio duration per row), so this buys
   * time-to-first-audio and trades nothing for it — same model, same
   * voice, same generation config, same raw PCM output.
   *
   * The difference is network-independent: both paths pay the same
   * round trip, so it cancels out of the delta.
   *
   * ── Why no coalescing accumulator ──────────────────────────────────
   *
   * The ElevenLabs adapter buffers to ~100ms before yielding, because
   * that SDK hands back raw HTTP chunks whose sizes are set by TCP
   * segmentation and can be ODD — which splits a 2-byte PCM_16 sample
   * across two yields and silently distorts everything after it.
   * Cartesia's SSE events are discrete base64 audio payloads instead:
   * measured across two utterances (17 and 49 events, 10-200ms each),
   * every single one was even-length. The parity guard below is kept
   * anyway — the contract does not promise alignment and the failure
   * mode is severe — but there is nothing to coalesce, and buffering
   * would give back the latency this method exists to win. Sub-frame
   * payloads are already the media bridge's job: its framer carries a
   * 1..159-byte tail into the next chunk rather than emitting a runt
   * frame.
   */
  async *synthesizeStream(
    task: SynthesisTaskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioChunk> {
    // Diagnostic only, and the counterpart of the ElevenLabs line: the
    // pipeline's `tts-first-chunk` trace fires once per TURN, so the
    // second and later chunks of a reply have no timing of their own.
    //
    // Stamped BEFORE the await, not after. `generateSSE` resolves when
    // the response HEADERS arrive, so a mark taken after it measured
    // headers-to-first-event and read 1-18ms — flattering and useless.
    // From here it measures what the pipeline actually waits for.
    const requestedAt = Date.now();

    const stream = await this.client.tts.generateSSE(this.requestBody(task), {
      // Barge-in. Aborting the request is what stops Cartesia
      // generating audio nobody will hear; breaking out of the loop
      // alone would leave the socket draining.
      ...(signal ? { signal } : {}),
    });

    let sequence = 0;
    /** Odd trailing byte carried to the next event to keep PCM_16 sample alignment. */
    let carry: Uint8Array | undefined;

    let loggedFirstChunk = false;

    try {
      for await (const event of stream) {
        if (signal?.aborted) break;

        // The SSE stream also carries `timestamps`, `phoneme_timestamps`,
        // `done` and `error` events. Only `chunk` carries audio, so
        // discriminate on the tag rather than on `data` being truthy.
        if (event.type === "error") {
          throw new Error(`Cartesia SSE error ${event.status_code}: ${event.title} — ${event.message}`);
        }
        if (event.type !== "chunk") continue;

        const decoded = new Uint8Array(Buffer.from(event.data, "base64"));
        if (decoded.byteLength === 0) continue;

        let payload: Uint8Array;
        if (carry === undefined) {
          payload = decoded;
        } else {
          payload = new Uint8Array(carry.byteLength + decoded.byteLength);
          payload.set(carry, 0);
          payload.set(decoded, carry.byteLength);
          carry = undefined;
        }

        // Hold back an orphan byte rather than shifting every
        // subsequent sample by one. Never observed from this endpoint;
        // cheap insurance against a silent, total distortion.
        if (payload.byteLength % 2 !== 0) {
          carry = payload.subarray(payload.byteLength - 1);
          payload = payload.subarray(0, payload.byteLength - 1);
          if (payload.byteLength === 0) continue;
        }

        if (!loggedFirstChunk) {
          loggedFirstChunk = true;
          // eslint-disable-next-line no-console
          console.log(
            `[TTS:cartesia] first audio chunk in ${Date.now() - requestedAt}ms (textLen=${task.request.text.length})`,
          );
        }

        yield {
          audio: {
            data: payload,
            encoding: "PCM_16",
            sampleRateHz: this.config.sampleRateHz,
          },
          sequence: sequence++,
          isFinal: false,
        };
      }
    } finally {
      // Releases the underlying socket whether the loop ended normally,
      // threw, or the consumer broke out of it on barge-in.
      stream.controller.abort();
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.voices.list();
    });
  }
}
