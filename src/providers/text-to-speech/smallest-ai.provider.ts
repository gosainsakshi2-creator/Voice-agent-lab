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
 *
 * `synthesizeStream` (the optional interface member) additionally
 * exposes the vendor's SSE endpoint, which is what the pipeline
 * prefers. See the long note on that method for the measurement that
 * motivated it: `synthesize()` ends in `arrayBuffer()`, so it cannot
 * yield a byte until the last byte of the body has landed, and its
 * time-to-first-audio therefore grows with the text.
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
import { postJsonForBinary, ProviderHttpError } from "../shared/http";
import { decodeWav } from "../shared/audio";
import type { TtsAudioChunk } from "../../types/streaming.types";

interface SmallestAiEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /**
   * Host serving the SSE streaming endpoint. SEPARATE from `baseUrl`,
   * and it has to be: the batch endpoint this adapter has always used
   * is `https://api.smallest.ai/waves/v1/tts`, and that host answers
   * **HTTP 404** for `/api/v1/lightning-v3.1/stream` — verified. Only
   * `waves-api.smallest.ai` serves the stream. Different host AND a
   * different path root, so one base URL cannot express both.
   */
  readonly streamBaseUrl: string;
  readonly defaultVoiceId: string;
  readonly sampleRateHz: number;
}

function loadEnvConfig(): SmallestAiEnvConfig {
  return {
    apiKey: requireEnv("SMALLEST_AI_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI),
    baseUrl: optionalEnv("SMALLEST_AI_BASE_URL", "https://api.smallest.ai"),
    streamBaseUrl: optionalEnv("SMALLEST_AI_STREAM_BASE_URL", "https://waves-api.smallest.ai"),
    defaultVoiceId: requireEnv("SMALLEST_AI_DEFAULT_VOICE_ID", TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI),
    sampleRateHz: optionalEnvNumber("SMALLEST_AI_SAMPLE_RATE_HZ", 24000),
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

  /**
   * The request body, shared by BOTH synthesis paths.
   *
   * Extracted for one reason, and it is a safety property rather than
   * tidiness: `synthesize` and `synthesizeStream` differ only in which
   * endpoint they post to and how they read the response. Voice, sample
   * rate, output format and `speed: .92` are produced here, so the two
   * paths cannot drift and the audio the caller hears is the same
   * whichever one the pipeline picks. Every value below is exactly what
   * `synthesize` sent before this method existed.
   *
   * The drift this prevents is real and is in this codebase: the
   * ElevenLabs adapter's `synthesize` and `synthesizeStream` send
   * DIFFERENT `voiceSettings` (stability 0.5/0.9 against 0.42/0.88 and
   * a speed the batch path does not set), so the same text is spoken
   * differently depending on which branch the pipeline took.
   *
   * Verified against the live account: the stream endpoint honours
   * `speed` (0.92 -> 46444 bytes, 1.4 -> 34322 bytes for identical
   * text) and `sample_rate`, and the PCM it streams is byte-for-byte
   * the same length as the `data` chunk of the WAV the batch endpoint
   * returns for the same text.
   */
  private requestBody(task: SynthesisTaskRequest) {
    const voiceId = task.request.voiceId ?? this.config.defaultVoiceId;

    return {
      text: task.request.text,
      voice_id: voiceId,
      sample_rate: this.config.sampleRateHz,
      output_format: "wav",
      speed: .92,
    };
  }

  async synthesize(task: SynthesisTaskRequest): Promise<AudioPayload> {
    const wavBytes = await postJsonForBinary(
      this.descriptor.id,
      `${this.config.baseUrl}/waves/v1/tts`,
      {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "audio/wav",
      },
      this.requestBody(task),
    );

    const decoded = decodeWav(wavBytes);

    return {
      data: decoded.pcm,
      encoding: "PCM_16",
      sampleRateHz: decoded.sampleRateHz,
    };
  }

  /**
   * OPTIONAL, ADDITIVE — the SSE endpoint, not a replacement for
   * `synthesize`.
   *
   * ── Why this exists ──────────────────────────────────────────────
   *
   * `synthesize()` goes through `postJsonForBinary`, which ends in
   * `await response.arrayBuffer()`. It therefore cannot yield a single
   * byte until the LAST byte of the body has landed, so its
   * time-to-first-audio is the whole render plus the whole body
   * transfer. Production, 100 real turns on this lane: **958ms p50 /
   * 1928ms p90** — the slowest of the three campaign lanes by a wide
   * margin once Cartesia's SSE change (§0) is deployed.
   *
   * `POST /api/v1/lightning-v3.1/stream` emits audio while the rest is
   * still generating. Measured against the live account, same text,
   * same voice, same `speed: .92`:
   *
   *   chars   batch first audio   stream first audio   saved
   *     16         1758ms               447ms          1311ms
   *     80          934ms               360ms           574ms
   *    110         1265ms               265ms          1000ms
   *
   * and the streamed byte count is IDENTICAL to the batch WAV's `data`
   * chunk (41574 = 41574, 132166 = 132166), which is the strong
   * evidence that voice, model, sample rate and speed all carry over.
   *
   * ── What the wire actually looks like ────────────────────────────
   *
   * Traced rather than assumed, because "streaming" does not promise
   * the first event is playable:
   *
   *   event: audio
   *   data: {"audio":"<base64>","done":false,"status":"206"}
   *   ...
   *   data: {"status":"200","done":true}          <- no `event:` line
   *
   * Three things follow, and each is handled below:
   *
   *   1. The payload is RAW PCM, with NO container — even though the
   *      shared body asks for `output_format: "wav"` and the batch
   *      endpoint honours that. So `decodeWav` must NOT be applied
   *      here, and the sample rate comes from config. A defensive RIFF
   *      strip is kept anyway, because a vendor that starts honouring
   *      `output_format` on this endpoint would otherwise inject 44
   *      header bytes into the middle of the caller's audio.
   *   2. The FIRST audio event is immediately playable — it is leading
   *      silence, exactly as the batch clip's first bytes are. Nothing
   *      needs to be accumulated before the first yield.
   *   3. There IS an explicit end-of-stream marker (`done: true`),
   *      unlike Sarvam's WebSocket. Completion is read from it rather
   *      than inferred from an idle gap.
   *
   * Errors do NOT arrive as an SSE event: a bad voice id returns
   * **HTTP 400** with `{"error":[{...,"message":"Invalid Voice ID"}]}`
   * before the stream starts, so the status check below is the whole
   * error path.
   *
   * ── Why no coalescing accumulator ────────────────────────────────
   *
   * The ElevenLabs adapter buffers to ~100ms before yielding because
   * that SDK hands back raw HTTP chunks whose sizes are set by TCP
   * segmentation and can be ODD, which splits a 2-byte PCM_16 sample
   * and silently distorts everything after it. These are discrete
   * base64 payloads instead: measured across 8 utterances (9-40 events
   * each, sizes 48-5516 bytes), **every single one was even-length**.
   * The parity guard below is kept anyway — the contract does not
   * promise alignment and the failure mode is severe — but there is
   * nothing to coalesce, and buffering would give back the latency this
   * method exists to win.
   */
  async *synthesizeStream(
    task: SynthesisTaskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioChunk> {
    /**
     * Read through a call, not a property test: `signal.aborted` flips
     * during the awaits below (that is the whole point of barge-in),
     * but a direct `signal?.aborted === true` check gets narrowed by
     * the compiler at its first use and every later one is then
     * reported as impossible. Same reason, and same shape, as the
     * Sarvam adapter's.
     */
    const aborted = (): boolean => signal?.aborted === true;

    const requestedAt = Date.now();
    let sequence = 0;
    /** Odd trailing byte carried to the next event to keep PCM_16 sample alignment. */
    let carry: Uint8Array | undefined;
    let loggedFirstChunk = false;
    let emittedAudio = false;

    try {
      const response = await fetch(
        `${this.config.streamBaseUrl}/api/v1/lightning-v3.1/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(this.requestBody(task)),
          // Barge-in. Aborting the request is what stops Smallest AI
          // generating audio nobody will hear; breaking out of the read
          // loop alone would leave the body draining.
          ...(signal ? { signal } : {}),
        },
      );

      if (!response.ok) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          bodyText = "<unreadable>";
        }
        throw new ProviderHttpError(
          this.descriptor.id,
          response.status,
          response.statusText,
          bodyText,
        );
      }
      if (!response.body) {
        throw new Error(
          `Smallest AI streaming response had no body for session "${task.sessionId}".`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      /** Bytes read but not yet forming a complete SSE record. */
      let buffered = "";
      let sawRiffHeader = false;
      let done = false;

      try {
        while (!done) {
          if (aborted()) break;

          const { done: bodyEnded, value } = await reader.read();
          if (bodyEnded) break;
          buffered += decoder.decode(value, { stream: true });

          // SSE separates records with a blank line. The vendor sends
          // LF, but the spec permits CRLF, so accept both rather than
          // silently buffering a whole response that never "completes".
          for (;;) {
            // `done` has to be re-tested HERE, not only by the outer
            // loop: a terminal record and whatever follows it can arrive
            // in the same read, and draining the rest of the buffer
            // regardless would play audio the vendor emitted after it
            // said the utterance was over.
            if (done) break;
            const match = /\r?\n\r?\n/u.exec(buffered);
            if (match === null) break;
            const record = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);

            const payload = this.audioFromRecord(record);
            if (payload === undefined) continue;
            if (payload.done) done = true;
            if (payload.audio === undefined) continue;

            let decoded = payload.audio;

            // Defensive: this endpoint streams raw PCM today. If it
            // ever starts honouring `output_format: "wav"`, the header
            // must be stripped rather than played as samples.
            if (!sawRiffHeader && decoded.byteLength >= 44) {
              if (Buffer.from(decoded.subarray(0, 4)).toString("ascii") === "RIFF") {
                sawRiffHeader = true;
                decoded = decoded.subarray(44);
              }
            }
            if (decoded.byteLength === 0) continue;

            let chunk: Uint8Array;
            if (carry === undefined) {
              chunk = decoded;
            } else {
              chunk = new Uint8Array(carry.byteLength + decoded.byteLength);
              chunk.set(carry, 0);
              chunk.set(decoded, carry.byteLength);
              carry = undefined;
            }

            // Hold back an orphan byte rather than shifting every
            // subsequent sample by one. Never observed from this
            // endpoint; cheap insurance against a silent, total
            // distortion.
            if (chunk.byteLength % 2 !== 0) {
              carry = chunk.subarray(chunk.byteLength - 1);
              chunk = chunk.subarray(0, chunk.byteLength - 1);
              if (chunk.byteLength === 0) continue;
            }

            if (!loggedFirstChunk) {
              loggedFirstChunk = true;
              // eslint-disable-next-line no-console
              console.log(
                `[TTS:smallest-ai] first audio chunk in ${Date.now() - requestedAt}ms (textLen=${task.request.text.length})`,
              );
            }

            emittedAudio = true;
            yield {
              audio: {
                data: chunk,
                encoding: "PCM_16",
                sampleRateHz: this.config.sampleRateHz,
              },
              sequence: sequence++,
              isFinal: false,
            };
          }
        }
      } finally {
        // Releases the underlying socket whether the loop ended
        // normally, threw, or the consumer broke out of it on barge-in.
        await reader.cancel().catch(() => undefined);
      }

      if (!aborted()) {
        yield {
          audio: { data: new Uint8Array(0), encoding: "PCM_16", sampleRateHz: this.config.sampleRateHz },
          sequence: sequence++,
          isFinal: true,
        };
      }
    } catch (err) {
      // ── Degrade to the blocking REST call, never to silence ───────
      //
      // The pipeline's streaming branch catches whatever escapes this
      // generator and merely logs a warning, so an unhandled failure
      // here means the agent says NOTHING for that sentence — strictly
      // worse than the latency this streaming path exists to remove.
      // The same reasoning, and the same shape, as the Sarvam adapter.
      //
      // Only safe when no audio has been emitted yet: re-synthesizing
      // after a mid-stream failure would replay the part the caller has
      // already queued.
      if (aborted()) return;
      if (emittedAudio) throw err;

      // eslint-disable-next-line no-console
      console.warn(
        `[TTS:smallest-ai] streaming failed before any audio (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the blocking REST endpoint.`,
      );
      const audio = await this.synthesize(task);
      if (aborted()) return;
      yield { audio, sequence: sequence++, isFinal: false };
      yield {
        audio: { data: new Uint8Array(0), encoding: "PCM_16", sampleRateHz: audio.sampleRateHz },
        sequence: sequence++,
        isFinal: true,
      };
    }
  }

  /**
   * One SSE record -> its audio payload and whether it ends the stream.
   *
   * Returns `undefined` for a record carrying neither, so the caller
   * does not have to distinguish "no data line" from "a data line with
   * nothing in it". Discriminates on the `audio` FIELD rather than on
   * the `event:` name, because the terminal record
   * (`{"status":"200","done":true}`) arrives with no `event:` line at
   * all — keying off the name would either miss the end of the stream
   * or treat the terminal record as audio.
   */
  private audioFromRecord(
    record: string,
  ): { readonly audio?: Uint8Array; readonly done: boolean } | undefined {
    const dataLines: string[] = [];
    for (const line of record.split(/\r?\n/u)) {
      // `:` opens an SSE comment/keep-alive; `event:` and `id:` are not
      // needed, since the payload itself says what it is.
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return undefined;

    const data = dataLines.join("");
    if (data.length === 0) return undefined;

    let parsed: { audio?: unknown; done?: unknown };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      // Not JSON. Not something this endpoint has ever sent, and
      // guessing that it is bare base64 audio risks queueing garbage as
      // samples, so it is ignored rather than played.
      return undefined;
    }

    const done = parsed.done === true;
    if (typeof parsed.audio !== "string" || parsed.audio.length === 0) return { done };
    return { audio: new Uint8Array(Buffer.from(parsed.audio, "base64")), done };
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
        this.requestBody({
          sessionId: "health" as SynthesisTaskRequest["sessionId"],
          request: { text: "Hello", language: SupportedLanguage.ENGLISH },
        }),
      );
    });
  }
}
