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
import type { TtsAudioChunk } from "../../types/streaming.types";
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
    // `eleven_flash_v2_5` — the low-latency model, and the single
    // largest cross-cutting latency win in the stack. Measured against
    // this account, same voice, same text, same pcm_8000 output, time
    // to FIRST audio byte:
    //   eleven_multilingual_v2  1467ms
    //   eleven_turbo_v2_5        445ms
    //   eleven_flash_v2_5        412ms
    // That ~1.05s is paid on the greeting AND on every single reply,
    // for every LLM, so it dominates everything downstream of the
    // model. Flash covers the same 32 languages (English, Hindi and
    // the Hinglish mix included). Set ELEVENLABS_MODEL_ID to override
    // if a specific call needs multilingual_v2's extra fidelity more
    // than it needs a second of latency.
    modelId: optionalEnv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
    defaultVoiceId: requireEnv("ELEVENLABS_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS),
    // Default to 8 kHz — the native rate of both telephony transports
    // (Plivo and Vobiz are fixed at 8 kHz G.711 mu-law). Requesting
    // pcm_8000 makes ElevenLabs do the band-limiting and resampling
    // server-side with a proper resampler, so the local
    // `resamplePcm16` path is bypassed entirely (fromRate === toRate
    // returns the input untouched). That removes the last resampling
    // stage from the hot path: no aliasing, no filter transients, and
    // half the bytes over the wire for lower latency.
    //
    // Set ELEVENLABS_SAMPLE_RATE_HZ to override; the anti-aliased
    // resampler in audio-codec.ts now handles 16000/22050/24000/etc
    // correctly too, so a higher rate is safe — just slower.
    sampleRateHz: optionalEnvNumber("ELEVENLABS_SAMPLE_RATE_HZ", 8000),
  };
}

/**
 * Reads a stream into a single Uint8Array.
 *
 * The ElevenLabs SDK may return either a Web ReadableStream (browser /
 * newer Node.js) or a Node.js Readable / AsyncIterable (older SDK
 * builds or certain Node runtimes). This helper handles both shapes
 * so TTS synthesis never silently fails due to a stream-type mismatch.
 */
async function collectStream(stream: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  const push = (value: Uint8Array | Buffer): void => {
    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(u8);
    totalLength += u8.byteLength;
  };

  // Path 1: Web ReadableStream (has .getReader)
  if (
    typeof stream === "object" &&
    stream !== null &&
    typeof (stream as ReadableStream<Uint8Array>).getReader === "function"
  ) {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) push(value);
    }
  }
  // Path 2: Node.js Readable / AsyncIterable (has Symbol.asyncIterator)
else if (
  typeof stream === "object" &&
  stream !== null &&
  Symbol.asyncIterator in (stream as object)
) {
  const asyncStream = stream as unknown as AsyncIterable<Uint8Array | Buffer>;

  for await (const chunk of asyncStream) {
    push(chunk);
  }
}
  // Path 3: Already a Buffer or Uint8Array (some SDK versions return the whole thing)
  else if (stream instanceof Uint8Array || Buffer.isBuffer(stream)) {
    push(stream);
  } else {
    throw new Error(
      `[ElevenLabs] collectStream: unsupported stream type "${typeof stream}" — ` +
        `expected ReadableStream, AsyncIterable, or Buffer`,
    );
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

/**
 * The raw-PCM literals accepted by BOTH `textToSpeech.convert` (batch)
 * and `textToSpeech.stream` (progressive). The two request types declare
 * separate unions; intersecting them keeps one shared format table that
 * is type-checked against whichever endpoint is called.
 */
type PcmOutputFormat = ElevenLabs.TextToSpeechConvertRequestOutputFormat &
  ElevenLabs.TextToSpeechStreamRequestOutputFormat;

/** Restricts a configured sample rate to ElevenLabs' documented raw-PCM output-format literals. */
function toPcmOutputFormat(sampleRateHz: number): PcmOutputFormat {
  const supported: Record<number, PcmOutputFormat> = {
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

    // eslint-disable-next-line no-console
    console.log(
      `[TTS:elevenlabs] synthesize: voiceId=${voiceId} model=${this.config.modelId} outputFormat=${toPcmOutputFormat(this.config.sampleRateHz)} language=${languageCode ?? "auto"} textLen=${task.request.text.length}`,
    );

    const stream = await this.client.textToSpeech.convert(voiceId, {
      text: task.request.text,
      modelId: this.config.modelId,
      outputFormat: toPcmOutputFormat(this.config.sampleRateHz),
      voiceSettings: {
  stability: 0.42,
  similarityBoost: 0.88,
  style: 0,
  useSpeakerBoost: true,
  speed: 0.94,
},
      ...(languageCode ? { languageCode } : {}),
    });

    // eslint-disable-next-line no-console
    console.log(
      `[TTS:elevenlabs] convert() returned: type=${typeof stream} constructor=${(stream as object)?.constructor?.name} hasGetReader=${typeof (stream as ReadableStream)?.getReader === "function"} hasAsyncIterator=${typeof stream === "object" && stream !== null && Symbol.asyncIterator in (stream as object)}`,
    );

    const data = await collectStream(stream);

    // eslint-disable-next-line no-console
    console.log(`[TTS:elevenlabs] collectStream done: ${data.byteLength} bytes of PCM_16 audio`);

    return {
      data,
      encoding: "PCM_16",
      sampleRateHz: this.config.sampleRateHz,
    };
  }

  async *synthesizeStream(
    task: SynthesisTaskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioChunk> {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;
    const languageCode = languageToIsoCode(task.request.language);

    // eslint-disable-next-line no-console
    console.log(
      `[TTS:elevenlabs] synthesizeStream: voiceId=${voiceId} model=${this.config.modelId} textLen=${task.request.text.length}`,
    );

    // ── Must be `stream()`, NOT `convert()` ─────────────────────────
    //
    // Both SDK methods hand back a `ReadableStream`, which is why
    // `convert()` looked interchangeable here — but they hit different
    // endpoints, and only one of them streams:
    //
    //   convert() -> POST /v1/text-to-speech/{voice_id}
    //                ElevenLabs renders the ENTIRE clip before it sends
    //                a single byte. The client-side stream then delivers
    //                the whole thing in one burst. Time-to-first-audio
    //                therefore equals full synthesis time for the chunk
    //                and scales with its length (measured: 2254ms).
    //
    //   stream()  -> POST /v1/text-to-speech/{voice_id}/stream
    //                Chunked transfer — audio starts arriving while the
    //                rest is still being generated (~300-400ms on
    //                eleven_flash_v2_5, independent of chunk length).
    //
    // That difference is the whole of the dead-air problem. The pipeline
    // synthesizes one clause/sentence chunk at a time, and the bridge's
    // outbound queue only ever holds ~1.2s of audio, so a chunk boundary
    // that costs a full 2s+ re-synthesis with zero bytes arriving drains
    // the pump dry — heard as a 1-3s silence in the middle of a sentence
    // and as a slow start on the first one.
    const stream = await this.client.textToSpeech.stream(voiceId, {
      text: task.request.text,
      modelId: this.config.modelId,
      outputFormat: toPcmOutputFormat(this.config.sampleRateHz),
      voiceSettings: {
  stability: 0.42,
  similarityBoost: 0.88,
  style: 0,
  useSpeakerBoost: true,
  speed: 0.94,
},
      ...(languageCode ? { languageCode } : {}),
    });

    let sequence = 0;

    // ── PCM byte-alignment accumulator ──────────────────────────────
    //
    // The ElevenLabs SDK streams raw HTTP response chunks whose sizes
    // are dictated by TCP segmentation, NOT by PCM sample boundaries.
    // PCM_16 samples are 2 bytes each — an odd-length chunk splits a
    // sample across two yields, causing `bytesToPcm16()` downstream
    // to silently drop the orphan byte and shift every subsequent
    // sample by one byte.  The result is ~50% of audio time rendered
    // from byte-misaligned pairs → severe distortion on every call.
    //
    // Fix: accumulate raw bytes and only yield when:
    //   (a) we have ≥ MIN_YIELD_BYTES (ensures reasonable chunk size,
    //       reduces runt codec frames from ~70 to ~3-5 per sentence), AND
    //   (b) the yielded length is EVEN (preserves PCM_16 sample alignment).
    //
    // At stream end, flush whatever remains (still even-aligned).
    // ────────────────────────────────────────────────────────────────

    /**
     * ~100 ms of PCM_16 mono at the configured rate, rounded to a
     * whole number of 20 ms telephony frames so the bridge's frame
     * slicer never produces a runt frame mid-stream.
     * (8 kHz -> 1600 bytes = 5 frames; 16 kHz -> 3200 bytes = 5 frames.)
     */
    const MIN_YIELD_BYTES = Math.max(320, Math.round(this.config.sampleRateHz * 2 * 0.1));
    let accBuf = new Uint8Array(MIN_YIELD_BYTES * 2); // pre-allocated, grows if needed
    let accLen = 0;

    // Diagnostic only. The pipeline's `tts-first-chunk` trace fires once
    // per TURN, so the second and later chunks of a reply — exactly where
    // the mid-sentence dead air was coming from — had no timing at all in
    // the logs. One line per utterance makes every chunk boundary visible.
    const requestedAt = Date.now();
    let loggedFirstChunk = false;
    const noteFirstChunk = (): void => {
      if (loggedFirstChunk) return;
      loggedFirstChunk = true;
      // eslint-disable-next-line no-console
      console.log(
        `[TTS:elevenlabs] first audio chunk in ${Date.now() - requestedAt}ms (textLen=${task.request.text.length})`,
      );
    };

    const accumulate = (incoming: Uint8Array): void => {
      if (accLen + incoming.byteLength > accBuf.byteLength) {
        // Grow to 2× needed capacity
        const next = new Uint8Array((accLen + incoming.byteLength) * 2);
        next.set(accBuf.subarray(0, accLen));
        accBuf = next;
      }
      accBuf.set(incoming, accLen);
      accLen += incoming.byteLength;
    };

    /**
     * Yield an even-aligned slice of the accumulator when it has
     * reached `MIN_YIELD_BYTES`.  Returns the `TtsAudioChunk` to
     * yield, or `undefined` if the buffer isn't full enough yet.
     */
    const drainIfReady = (): TtsAudioChunk | undefined => {
      if (accLen < MIN_YIELD_BYTES) return undefined;
      // Ensure even byte count so every PCM_16 sample is complete.
      const yieldLen = accLen & ~1; // round down to even
      if (yieldLen === 0) return undefined;
      const out = new Uint8Array(yieldLen);
      out.set(accBuf.subarray(0, yieldLen));
      // Shift any leftover byte (at most 1) to the front.
      const leftover = accLen - yieldLen;
      if (leftover > 0) {
        accBuf[0] = accBuf[yieldLen]!;
      }
      accLen = leftover;
      return {
        audio: { data: out, encoding: "PCM_16" as const, sampleRateHz: this.config.sampleRateHz },
        sequence: sequence++,
        isFinal: false,
      };
    };

    /** Flush whatever remains in the accumulator (even-aligned). */
    const flush = (): TtsAudioChunk | undefined => {
      if (accLen === 0) return undefined;
      const yieldLen = accLen & ~1;
      if (yieldLen === 0) return undefined; // lone orphan byte — discard
      const out = new Uint8Array(yieldLen);
      out.set(accBuf.subarray(0, yieldLen));
      accLen = 0;
      return {
        audio: { data: out, encoding: "PCM_16" as const, sampleRateHz: this.config.sampleRateHz },
        sequence: sequence++,
        isFinal: false,
      };
    };

    // The SDK returns an AsyncIterable or ReadableStream of audio chunks.
    if (
      typeof stream === "object" &&
      stream !== null &&
      Symbol.asyncIterator in (stream as object)
    ) {
      const asyncStream = stream as unknown as AsyncIterable<Uint8Array | Buffer>;
      for await (const chunk of asyncStream) {
        if (signal?.aborted) break;
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (u8.byteLength === 0) continue;
        accumulate(u8);
        const ready = drainIfReady();
        if (ready) {
          noteFirstChunk();
          yield ready;
        }
      }
    } else if (
      typeof stream === "object" &&
      stream !== null &&
      typeof (stream as ReadableStream<Uint8Array>).getReader === "function"
    ) {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          accumulate(value);
          const ready = drainIfReady();
          if (ready) {
            noteFirstChunk();
            yield ready;
          }
        }
      }
    } else {
      // Fallback: treat as single chunk (already fully buffered)
      const data = await collectStream(stream);
      if (data.byteLength > 0) {
        const yieldLen = data.byteLength & ~1;
        if (yieldLen > 0) {
          yield {
            audio: { data: data.subarray(0, yieldLen), encoding: "PCM_16" as const, sampleRateHz: this.config.sampleRateHz },
            sequence: sequence++,
            isFinal: true,
          };
        }
        return;
      }
    }

    // Flush any remaining accumulated bytes before the final marker.
    const tail = flush();
    if (tail) yield tail;

    // Emit a zero-byte final marker so callers know the stream is done.
    yield {
      audio: { data: new Uint8Array(0), encoding: "PCM_16" as const, sampleRateHz: this.config.sampleRateHz },
      sequence: sequence++,
      isFinal: true,
    };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.models.list();
    });
  }
}