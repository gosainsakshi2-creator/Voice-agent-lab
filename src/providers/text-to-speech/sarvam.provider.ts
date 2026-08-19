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
import { WebSocket } from "ws";
import type { TtsAudioChunk } from "../../types/streaming.types";

interface SarvamEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly defaultSpeaker: string;
  readonly sampleRateHz: number;
  readonly streamIdleGapMs: number;
  readonly streamStartTimeoutMs: number;
}

function loadEnvConfig(): SarvamEnvConfig {
  return {
    apiKey: requireEnv("SARVAM_API_KEY", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    baseUrl: optionalEnv("SARVAM_BASE_URL", "https://api.sarvam.ai"),
    model: optionalEnv("SARVAM_TTS_MODEL", "bulbul:v2"),
    defaultSpeaker: requireEnv("SARVAM_DEFAULT_SPEAKER", TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM),
    sampleRateHz: optionalEnvNumber("SARVAM_SAMPLE_RATE_HZ", 22050),
    streamIdleGapMs: optionalEnvNumber("SARVAM_STREAM_IDLE_GAP_MS", 700),
    streamStartTimeoutMs: optionalEnvNumber("SARVAM_STREAM_START_TIMEOUT_MS", 6000),
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
    version: "bulbul-v3",
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
 
  /**
   * Streaming synthesis over Sarvam's WebSocket TTS endpoint.
   *
   * `synthesize()` above posts to the REST endpoint, which renders the
   * ENTIRE clip before it returns a single byte. Measured on this
   * account with bulbul:v3: 1763ms for a 44-character sentence and
   * 4166ms for a 164-character one — time-to-first-audio equals full
   * synthesis time and grows with the text. The pipeline synthesizes
   * one clause/sentence at a time and the bridge's outbound queue only
   * holds ~1.2s, so every chunk boundary drained the pump dry. That is
   * the audible "Sarvam pauses too much".
   *
   * The WebSocket endpoint streams instead: first audio frame at
   * ~85-100ms, and a 2.65s utterance fully delivered in ~1.38s — audio
   * arrives faster than it plays, so the queue stays fed across the
   * boundary.
   *
   * Two details this protocol imposes, both handled below:
   *
   *   1. The first `audio` frame is a bare 44-byte RIFF/WAV header,
   *      not samples. Passing it downstream as PCM would inject a
   *      click and shift every later sample by an odd offset.
   *   2. There is NO end-of-stream marker. Every frame Sarvam sends is
   *      `{type:"audio"}` with identical keys, and the socket stays
   *      open after the last one. Completion is therefore inferred
   *      from an idle gap: frames arrive ~40-70ms apart while
   *      synthesis runs, so `SARVAM_STREAM_IDLE_GAP_MS` (700ms
   *      default) sits an order of magnitude above the real cadence
   *      without truncating the tail. The wait costs no dead air — by
   *      the time it elapses the transport already holds more queued
   *      audio than the gap is long.
   */
  async *synthesizeStream(
    task: SynthesisTaskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioChunk> {
    const speaker = task.request.voiceId ?? this.config.defaultSpeaker;
    const wsUrl = `${this.config.baseUrl.replace(/^http/, "ws")}/text-to-speech/ws?model=${encodeURIComponent(
      this.config.model,
    )}`;

    const socket = new WebSocket(wsUrl, {
      headers: { "api-subscription-key": this.config.apiKey },
    });

    /** Frames received but not yet yielded, oldest first. */
    const pending: Uint8Array[] = [];
    let notify: (() => void) | undefined;
    let closed = false;
    let failure: Error | undefined;
    let sawRiffHeader = false;

    const wake = (): void => {
      const fn = notify;
      notify = undefined;
      fn?.();
    };

    const finish = (err?: Error): void => {
      if (err && !failure) failure = err;
      closed = true;
      wake();
    };

    socket.on("message", (raw: Buffer) => {
      let parsed: { type?: string; data?: { audio?: string; message?: string } };
      try {
        parsed = JSON.parse(raw.toString()) as typeof parsed;
      } catch {
        return; // Sarvam sends only JSON frames; ignore anything else.
      }
      if (parsed.type === "error") {
        finish(new Error(`Sarvam TTS stream error: ${parsed.data?.message ?? "unknown"}`));
        return;
      }
      if (parsed.type !== "audio" || parsed.data?.audio === undefined) return;

      let bytes = new Uint8Array(Buffer.from(parsed.data.audio, "base64"));

      // Strip the leading RIFF container. It arrives as its own frame,
      // but tolerate a header prefixed onto the first data frame too.
      if (!sawRiffHeader && bytes.byteLength >= 4) {
        if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF") {
          sawRiffHeader = true;
          bytes = bytes.subarray(44);
        }
      }
      if (bytes.byteLength === 0) return;

      pending.push(bytes);
      wake();
    });

    socket.on("error", (err: Error) => finish(err));
    socket.on("close", () => finish());

    const onAbort = (): void => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    /**
     * Read through a call, not a property test: `signal.aborted` flips
     * during the awaits below (that is the whole point of barge-in),
     * but a direct `signal?.aborted === true` check gets narrowed by
     * the compiler at its first use and every later one is then
     * reported as impossible.
     */
    const aborted = (): boolean => signal?.aborted === true;

    let sequence = 0;
    const emit = (data: Uint8Array, isFinal: boolean): TtsAudioChunk => ({
      audio: { data, encoding: "PCM_16" as const, sampleRateHz: this.config.sampleRateHz },
      sequence: sequence++,
      isFinal,
    });

    const requestedAt = Date.now();
    let loggedFirst = false;

    try {
      // -- Open, configure, submit, flush ---------------------------
      await new Promise<void>((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) {
          resolve();
          return;
        }
        socket.once("open", () => resolve());
        socket.once("error", (err: Error) => reject(err));
        socket.once("close", () =>
          reject(new Error("Sarvam TTS socket closed before it opened.")),
        );
      });
      if (aborted()) return;

      socket.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker,
            target_language_code: toSarvamLanguage(task.request.language),
            output_audio_codec: "wav",
            speech_sample_rate: this.config.sampleRateHz,
          },
        }),
      );
      socket.send(JSON.stringify({ type: "text", data: { text: task.request.text } }));
      socket.send(JSON.stringify({ type: "flush" }));

      // -- Drain until the idle gap declares the utterance finished --
      for (;;) {
        if (aborted()) return;

        while (pending.length > 0) {
          const next = pending.shift();
          if (next === undefined || next.byteLength === 0) continue;
          // PCM_16 samples are 2 bytes; an odd length would shift every
          // later sample by one byte downstream.
          const aligned = next.byteLength & ~1;
          if (aligned === 0) continue;
          if (!loggedFirst) {
            loggedFirst = true;
            // eslint-disable-next-line no-console
            console.log(
              `[TTS:sarvam] first audio chunk in ${Date.now() - requestedAt}ms (textLen=${task.request.text.length})`,
            );
          }
          yield emit(next.subarray(0, aligned), false);
        }

        if (failure) throw failure;
        if (closed) break;

        // Two different waits wearing one name would be a bug. The gap
        // BETWEEN frames is ~40-70ms, so 700ms of silence means the
        // utterance ended. The wait for the FIRST frame is a different
        // quantity entirely — socket handshake plus the vendor starting
        // synthesis, measured at 500-750ms and worse under load — so
        // holding it to the inter-frame gap would abandon healthy
        // requests.
        const budget = loggedFirst
          ? this.config.streamIdleGapMs
          : this.config.streamStartTimeoutMs;

        const gotFrame = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            notify = undefined;
            resolve(false);
          }, budget);
          notify = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });

        if (!gotFrame) {
          // Once audio has started, silence is this protocol's only
          // available end-of-utterance signal.
          if (loggedFirst) break;
          throw new Error(
            `Sarvam TTS sent no audio within ${budget}ms for session "${task.sessionId}".`,
          );
        }
      }

      if (!aborted()) {
        yield emit(new Uint8Array(0), true);
      }
    } catch (err) {
      // ── Degrade to the blocking REST call, never to silence ───────
      //
      // The pipeline's streaming branch catches whatever escapes this
      // generator and merely logs a warning, so an unhandled failure
      // here means the agent says NOTHING for that sentence — strictly
      // worse than the pause this streaming path exists to remove.
      //
      // Only safe when no audio has been emitted yet: re-synthesizing
      // after a mid-stream failure would replay the part the caller
      // has already queued.
      if (aborted()) return;
      if (loggedFirst) throw err;

      // eslint-disable-next-line no-console
      console.warn(
        `[TTS:sarvam] streaming failed before any audio (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the blocking REST endpoint.`,
      );
      const audio = await this.synthesize(task);
      if (aborted()) return;
      yield emit(audio.data, false);
      yield emit(new Uint8Array(0), true);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    }
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
  enable_preprocessing: true,
  speed: 1.0,
},
      );
 
    });
  }
}
