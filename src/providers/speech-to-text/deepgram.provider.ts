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
  TranscriptionRequest
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

/**
 * How often the live stream checks whether it owes Deepgram a
 * KeepAlive, and how long the socket must have gone without audio
 * before one is sent. Deepgram drops a live stream that has received
 * no audio for ~10s, so a 3s check against a 4s idle threshold cannot
 * arrive late. Neither value is a recognition parameter.
 */
const KEEPALIVE_INTERVAL_MS = 3_000;
const KEEPALIVE_IDLE_MS = 4_000;

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
      // Batch transcription is handed one already-segmented utterance,
      // so its single result IS the endpoint — never a chunk boundary.
      isSpeechFinal: true,
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
const connection = await this.client.listen.v1.connect({
  model: this.config.model,
  language: "multi",
  encoding: "mulaw",
  sample_rate: 8000,
  punctuate: "true",
  smart_format: "true",
  interim_results: "true",
  // Deepgram's own endpointing only controls when IT finalises a
  // chunk; `AdaptiveTurnDetector` owns the actual reply decision. 300ms
  // finalises so eagerly that a caller drawing breath mid-sentence
  // arrives as several separate finals, which pushed the detector's
  // adaptive estimate down toward its floor. 400ms keeps the detector's
  // gap observations closer to real inter-utterance pauses without
  // adding meaningful latency.
  endpointing: "400",
});

connection.connect();
await connection.waitForOpen();
console.log("[Deepgram] Live connection opened");

// ── Why the transcript stream outlives the socket ────────────────────
//
// `client.listen.v1.connect()` hands back a RECONNECTING socket: on any
// close that is not code 1000 it dials again by itself, re-attaches the
// same message handler, and flushes the audio it queued while it was
// down. Every frame `send()` receives in the gap is buffered, so the
// caller's speech during a reconnect is transcribed late, not lost.
//
// The bug this replaces closed `queue` from the socket's `close` and
// `error` handlers. Those fire on the FIRST blip — the exact event the
// transport is built to recover from — so a recoverable close ended the
// segment stream for the rest of the call. The pipeline's listener loop
// then fell out silently, `lastConversationActivityAt` froze, the turn
// detector never fired again, and the campaign silence watchdog hung up
// a live conversation ~20s later, mid-sentence. One transient socket
// event was enough to drop a call.
//
// So the segment stream is now ended by exactly one thing: THIS
// generator deciding the call is over (audio source exhausted, or the
// session aborted). `finished` is that decision. Anything else is a
// transport event the transport itself is already handling.
let finished = false;
const finish = (): void => {
  finished = true;
  if (keepAlive !== undefined) clearInterval(keepAlive);
  queue.close();
};

// Deepgram closes a live stream that has received no audio for ~10s.
// Inbound telephony frames normally arrive continuously, but a carrier
// that suppresses silence (or a stalled media bridge) can starve the
// socket into exactly that close. A KeepAlive costs nothing, is sent
// only when no audio has gone out recently, and alters no recognition
// parameter — the request above is untouched.
let lastMediaSentAt = Date.now();
const keepAlive: ReturnType<typeof setInterval> = setInterval(() => {
  if (finished || Date.now() - lastMediaSentAt < KEEPALIVE_IDLE_MS) return;
  try {
    connection.socket.send(JSON.stringify({ type: "KeepAlive" }));
  } catch {
    // `send()` enqueues rather than throwing while the socket is down;
    // a throw here is nothing the stream needs to act on.
  }
}, KEEPALIVE_INTERVAL_MS);

connection.on("message", (message) => {
  if (message.type !== "Results") return;

  const alternative = message.channel?.alternatives?.[0];

  // ── The end-of-speech claim can arrive on its own ────────────────
  //
  // `speech_final: true` is set on whichever Results message Deepgram's
  // endpointer fires on. When it has already returned every word of the
  // utterance in an earlier `is_final` message, that message carries an
  // EMPTY transcript: the words and the "they have stopped talking"
  // claim arrive SEPARATELY.
  //
  // Filtering on transcript text (which is what the line below does,
  // and correctly, for interim noise) therefore silently discarded the
  // endpoint. Downstream, `isSpeechFinal` then stayed false for the
  // whole turn, so `AdaptiveTurnDetector` treated the caller's finished
  // sentence as a mid-utterance chunk boundary and paid a full adaptive
  // silence window (1100-1600ms) plus its chunk-boundary grace (700ms)
  // instead of the single confirmation window an endpointed turn gets.
  // That is ~1.0-1.5s added to `stt-to-release` on every turn it
  // happens on.
  //
  // Forwarded as a MARKER, never as a transcript: no text, no word
  // timings, and flagged so no consumer can mistake it for speech.
  // Recognition parameters are untouched — this reads a field the
  // socket was already delivering.
  if (!alternative?.transcript?.trim()) {
    if ((message.speech_final ?? false) && (message.is_final ?? false)) {
      queue.push({
        text: "",
        isFinal: true,
        isSpeechFinal: true,
        isEndOfSpeechMarker: true,
        confidence: 0,
        language: request.language,
        startedAtMs: 0,
        endedAtMs: 0,
      });
    }
    return;
  }

  const words = alternative.words ?? [];
    const firstWord = words[0];
    const lastWord = words.at(-1);
    const segment: TranscriptSegment = {
    text: alternative.transcript,
    isFinal: message.is_final ?? false,
    // `is_final` and `speech_final` are DIFFERENT claims and only the
    // second one is about the caller having stopped talking:
    //   is_final     — "I will not revise these words" (chunk boundary,
    //                  emitted repeatedly mid-utterance)
    //   speech_final — "my endpointer detected end of speech"
    // Passing only `is_final` downstream left the turn detector unable
    // to tell a mid-sentence chunk boundary from an actual endpoint, so
    // every chunk boundary started a full end-of-turn countdown.
    isSpeechFinal: message.speech_final ?? false,
    confidence: alternative.confidence ?? 0,
    language: request.language,

    startedAtMs: firstWord ? (firstWord.start ?? 0) * 1000 : 0,
    endedAtMs: lastWord ? (lastWord.end ?? 0) * 1000 : 0,
  };
console.log(
  "[Deepgram] Transcript:",
  segment.text,
  "Final:",
  segment.isFinal,
  "SpeechFinal:",
  segment.isSpeechFinal,
);
  queue.push(segment);
});                          
void (async () => {
  let sentFrames = 0;
  try {
for await (const audio of request.audio) {
  if (request.signal?.aborted) {
    break;
  }
  // Inbound audio is a continuous 20ms frame stream (50/sec). Nothing
  // is logged here: even a sampled log on this path issues synchronous
  // stdout writes that stall the event loop the outbound 20ms playback
  // pump runs on.
  sentFrames += 1;
  lastMediaSentAt = Date.now();
  connection.socket.send(
    Buffer.from(
      audio.data.buffer,
      audio.data.byteOffset,
      audio.data.byteLength,
    ),
  );
}

// The audio source is exhausted or the session aborted: this is the
// one place that decides the call is over. `finish()` before closing
// the socket, so the close event it provokes is recognised as ours.
console.log(`[Deepgram] Audio source ended after ${sentFrames} frames — closing live stream`);
finish();
connection.socket.close();
  } catch (error) {
    console.error("[Deepgram] Streaming error:", error);
    finish();
    connection.socket.close();
  }
})();
connection.on("close", (event) => {
  const code = (event as { code?: number } | undefined)?.code;
  if (finished) {
    // Our own teardown, already finished above.
    console.log(`[Deepgram] Connection closed (code=${code ?? "n/a"})`);
    queue.close();
    return;
  }
  if (code === 1000) {
    // A clean close is the only one the reconnecting socket will not
    // retry, so this genuinely is the end of transcription.
    console.log("[Deepgram] Connection closed cleanly by the server — ending transcript stream");
    finish();
    return;
  }
  // Recoverable. The socket reconnects itself and keeps delivering
  // Results on the same handler, so the transcript stream stays open —
  // ending it here is what used to kill the rest of the call.
  console.warn(
    `[Deepgram] Connection closed unexpectedly (code=${code ?? "n/a"}) — transport is reconnecting, transcription continues`,
  );
});
connection.on("error", (error) => {
  // A socket error precedes an abnormal close, which the branch above
  // recovers from. Diagnostic only: it must not end the stream.
  console.error("[Deepgram] Connection error (recoverable):", error);
});
for await (const segment of queue) {
  yield segment;
}
return;
}

async checkHealth(): Promise<ProviderHealthStatus> {
  return {
    identifier: this.descriptor,
    isHealthy: true,
    checkedAt: new Date(),
    latencyMs: 0,
  };
}
}