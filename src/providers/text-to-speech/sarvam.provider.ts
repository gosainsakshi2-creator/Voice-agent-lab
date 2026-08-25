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

/**
 * How the end-of-utterance idle gap is sized.
 *
 * `SARVAM_STREAM_IDLE_GAP_MS` (700ms) is the CEILING on the ADAPTIVE
 * term, not the budget itself — see `synthesizeStream` for why waiting
 * the full ceiling on every request cost the caller real silence. The
 * floor and the multiplier below turn it into a budget derived from
 * this request's own observed frame cadence.
 *
 * Measured against bulbul on this account, with the raw socket logged
 * frame by frame: inter-frame gaps run 0-216ms once audio is flowing.
 * Four times the widest gap this request actually showed is therefore
 * a wide margin over its real cadence.
 *
 * ── Why the 300ms floor ALONE was not safe ────────────────────────
 *
 * `MIN_IDLE_GAP_MS` was written as the guard against "frames happened
 * to arrive in a tight burst". It is not, on its own, sufficient, and
 * this is the truncation defect the two constants below exist to fix.
 *
 * Sarvam does not send one frame per fixed slice of audio. Frame sizes
 * are quantised multiples of 2200 bytes, and which multiple you get
 * varies run to run on identical text (18 measured runs, 8kHz PCM_16,
 * so 16000 bytes/s):
 *
 *   2200 B = 138ms of audio      6600 B = 413ms of audio
 *   4400 B = 275ms of audio      8800 B = 550ms of audio
 *
 * On four of six runs of one 134-character sentence the stream was
 * mostly 6600- and 8800-byte frames. So the vendor routinely delivers
 * 413-550ms of audio per frame while the floor grants it only 300ms to
 * produce the next one — the safety mechanism was calibrated BELOW the
 * vendor's own delivery quantum. Any moment the vendor generates at
 * roughly real time (ordinary under load; socket-open alone was
 * measured at 255-1300ms on the same runs) the gap exceeds 300ms and a
 * healthy utterance is declared finished.
 *
 * That is exactly the reported failure. The truncated run in the audit
 * delivered `frames=2, audio=0.82s` of a 5.97s sentence: two 6600-byte
 * frames is 13200 bytes is 0.825s — the byte count matches the quantum
 * exactly. It was not a short read; it was two normal frames followed
 * by a normal gap that the budget was too small to survive.
 *
 * `widestFrameGapMs` starting at 0 is the second half of the same
 * defect: it is 0 until two frames have arrived, so `widest * FACTOR`
 * is 0 and the budget collapses to that too-small floor precisely in
 * the window where nothing about the cadence is yet known.
 */
const IDLE_GAP_SAFETY_FACTOR = 4;
const MIN_IDLE_GAP_MS = 300;

/**
 * How many real inter-frame gaps must be observed before the adaptive
 * term is trusted at all.
 *
 * Until then the budget is the configured `SARVAM_STREAM_IDLE_GAP_MS`
 * ceiling — i.e. the fixed 700ms this adapter used BEFORE the adaptive
 * change, which is the known-good value with no truncation on record.
 * This is a WIDENING of the early window only (300ms -> 700ms), so it
 * cannot introduce a new truncation, and it costs at most ~400ms of
 * tail on a clip so short it ends inside the first two frames.
 */
const MIN_OBSERVED_GAPS_BEFORE_ADAPTING = 2;

/**
 * Hard bound on the whole budget, including the delivery-quantum floor
 * derived from the stream (see `synthesizeStream`).
 *
 * The floor is evidence, not a constant, so it needs a ceiling of its
 * own: under sustained transport backpressure the consumer parks, a
 * whole utterance can accumulate in `pending`, and the burst that then
 * drains would otherwise license a tail as long as the clip.
 *
 * 1200ms is ~2.2x the widest single delivery ever measured (550ms) and
 * ~1.7x the pre-adaptive fixed wait (700ms).
 *
 * Whether the burst case is even reachable depends on the transport,
 * and the two bridges differ:
 *
 *   - **Vobiz** (the live campaign transport) applies NO outbound
 *     backpressure at all — its outbound listener returns void, and it
 *     queues every frame and paces the pump at real time. The producer
 *     is therefore never parked, so a large burst cannot accumulate in
 *     `pending` on this path and the hard bound is never reached.
 *   - **Plivo** does apply it: `OUTBOUND_HIGH_WATER_FRAMES` 140 (2800ms)
 *     parks the producer, `OUTBOUND_LOW_WATER_FRAMES` 110 (2200ms)
 *     releases it. This is the only path a big drained burst can come
 *     from — and there the queue still holds >=2200ms of audio when the
 *     producer resumes, which comfortably covers a 1200ms tail, so the
 *     extra wait costs the caller no dead air.
 */
const MAX_IDLE_GAP_MS = 1200;

/**
 * Speaking rate, sent as Sarvam's documented `pace` parameter on BOTH
 * synthesis paths (REST body and the WebSocket `config` frame), so the
 * caller hears the same delivery whichever one the pipeline takes —
 * the same single-source rule the Cartesia adapter applies to its
 * `generation_config`.
 *
 * The vendor default of 1.0 was the "voice is speaking too slowly"
 * complaint on live calls. 1.15 is deliberately conservative: inside
 * the documented range on both models (bulbul:v2 0.3–3.0, bulbul:v3
 * 0.5–2.0) and well short of the point where Hindi/Hinglish starts to
 * sound rushed. Not an environment variable, by the same reasoning as
 * Cartesia's fixed `speed`: an approved voice setting, not per-deploy
 * configuration.
 */
const SARVAM_PACE = 1.15;

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
        pace: SARVAM_PACE,
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
   *      open after the last one — verified by logging the raw socket:
   *      25 frames, then nothing at all, and no close from the server
   *      13 seconds after the final byte of audio. Completion can only
   *      be inferred from an idle gap.
   *
   * ── Why the idle gap is now measured rather than fixed ───────────
   *
   * The claim that the wait "costs no dead air" held only while the
   * transport still had more audio queued than the gap is long. It
   * does not hold at a chunk boundary, and the pipeline awaits this
   * generator once per sentence chunk: the next chunk's TTS request
   * cannot start until this one RETURNS, and this one did not return
   * until a fixed 700ms after its last frame. So every boundary paid
   * 700ms of pure serialisation on top of the next request's own
   * time-to-first-audio, against a cushion that had been draining the
   * whole time. Measured end to end on a three-chunk reply: 221ms and
   * 798ms of audible silence at the two boundaries, the second of them
   * essentially the idle gap itself.
   *
   * The gap is now derived from the cadence this request actually
   * showed (see `IDLE_GAP_SAFETY_FACTOR`), bounded below by
   * `MIN_IDLE_GAP_MS` and above by the configured
   * `SARVAM_STREAM_IDLE_GAP_MS`. It can therefore never wait LONGER
   * than it did before, and on a healthy request it returns roughly
   * 300ms sooner — which is 300ms less silence at every boundary.
   * Truncation risk is unchanged in kind and lower in practice: the
   * budget is still several times the widest gap observed while this
   * very utterance was streaming.
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
    /** Wall clock of the most recent frame yielded downstream. */
    let lastFrameAtMs = 0;
    /** Widest gap between consecutive frames seen on THIS request. */
    let widestFrameGapMs = 0;
    /**
     * How many real inter-frame gaps have been measured on this
     * request. `widestFrameGapMs` is only meaningful once this reaches
     * `MIN_OBSERVED_GAPS_BEFORE_ADAPTING`; before that it is 0 because
     * nothing has been measured, NOT because the cadence is tight.
     */
    let observedGapCount = 0;
    /**
     * The vendor's demonstrated DELIVERY QUANTUM: the most audio, in
     * real-time ms, it has ever handed over in one uninterrupted drain
     * - i.e. without us having to wait for it.
     *
     * This is the evidence the idle budget was missing. Sarvam's frames
     * carry 138-550ms of audio each (see the constants above), so a
     * vendor that has just delivered 550ms in one frame must be granted
     * at least 550ms to produce the next one before silence can be read
     * as "the utterance ended". Summed per drain pass rather than per
     * frame, because frames that arrive together and drain back to back
     * are one delivery as far as cadence is concerned - and they measure
     * as ~0ms gaps, which is what made the adaptive term blind to them.
     */
    let widestDeliveryMs = 0;

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
            pace: SARVAM_PACE,
          },
        }),
      );
      socket.send(JSON.stringify({ type: "text", data: { text: task.request.text } }));
      socket.send(JSON.stringify({ type: "flush" }));

      // -- Drain until the idle gap declares the utterance finished --
      for (;;) {
        if (aborted()) return;

        /**
         * Real-time audio, in ms, handed over during THIS pass. Reset
         * per pass so it measures one delivery rather than the whole
         * utterance.
         */
        let deliveredThisPassMs = 0;
        while (pending.length > 0) {
          const next = pending.shift();
          if (next === undefined || next.byteLength === 0) continue;
          // PCM_16 samples are 2 bytes; an odd length would shift every
          // later sample by one byte downstream.
          const aligned = next.byteLength & ~1;
          if (aligned === 0) continue;
          const frameAtMs = Date.now();
          if (lastFrameAtMs !== 0) {
            widestFrameGapMs = Math.max(widestFrameGapMs, frameAtMs - lastFrameAtMs);
            observedGapCount += 1;
          }
          lastFrameAtMs = frameAtMs;
          // PCM_16 mono: 2 bytes per sample, so bytes / (rate * 2) is
          // the clip's real-time duration.
          deliveredThisPassMs += (aligned / (this.config.sampleRateHz * 2)) * 1000;
          if (!loggedFirst) {
            loggedFirst = true;
            // eslint-disable-next-line no-console
            console.log(
              `[TTS:sarvam] first audio chunk in ${Date.now() - requestedAt}ms (textLen=${task.request.text.length})`,
            );
          }
          yield emit(next.subarray(0, aligned), false);
        }

        widestDeliveryMs = Math.max(widestDeliveryMs, deliveredThisPassMs);

        if (failure) throw failure;
        if (closed) break;

        // Two different waits wearing one name would be a bug. The gap
        // BETWEEN frames is ~40-70ms, so silence well past the vendor's
        // delivery quantum means the utterance ended. The wait for the
        // FIRST frame is a different quantity entirely - socket
        // handshake plus the vendor starting synthesis, measured at
        // 500-750ms and worse under load - so holding it to the
        // inter-frame gap would abandon healthy requests.
        //
        // -- The three layers, and why each is needed ----------------
        //
        // 1. ADAPTIVE. Four times the widest gap this request actually
        //    showed, floored at `MIN_IDLE_GAP_MS` and capped by the
        //    configured `SARVAM_STREAM_IDLE_GAP_MS`. This is the term
        //    that buys back the ~300ms tail at every chunk boundary,
        //    and it is unchanged - but it is only trusted once
        //    `MIN_OBSERVED_GAPS_BEFORE_ADAPTING` real gaps have been
        //    measured. Before that `widestFrameGapMs` is 0 because
        //    nothing has been observed, and multiplying that by four
        //    collapsed the budget to the floor in exactly the window
        //    where the least was known. Until the cadence exists, the
        //    budget is the configured ceiling - the fixed wait this
        //    adapter used before the adaptive change.
        //
        // 2. DELIVERY-QUANTUM FLOOR. Never conclude the vendor stopped
        //    in less time than the audio it just delivered in one go.
        //    Sarvam's frames carry 138-550ms each, so the old 300ms
        //    floor sat BELOW its own delivery quantum: two 6600-byte
        //    (413ms) frames followed by one ordinary gap is the audit's
        //    truncated run, byte for byte. This floor is measured from
        //    this stream, not configured, so it tracks whatever the
        //    vendor is actually doing on this request.
        //
        // 3. HARD BOUND. `MAX_IDLE_GAP_MS` caps the whole thing, so a
        //    large burst drained after transport backpressure cannot
        //    license a tail as long as the clip.
        //
        // Layers 1 and 2 are both WIDENINGS of the shipped budget, so
        // neither can introduce a truncation that did not already
        // exist; layer 3 is the only narrowing and it sits far above
        // both the configured ceiling and every delivery measured.
        const adaptiveBudget =
          observedGapCount >= MIN_OBSERVED_GAPS_BEFORE_ADAPTING
            ? Math.min(
                this.config.streamIdleGapMs,
                Math.max(MIN_IDLE_GAP_MS, widestFrameGapMs * IDLE_GAP_SAFETY_FACTOR),
              )
            : this.config.streamIdleGapMs;

        const budget = loggedFirst
          ? Math.min(MAX_IDLE_GAP_MS, Math.max(adaptiveBudget, Math.ceil(widestDeliveryMs)))
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
          if (loggedFirst) {
            // Diagnostic only, and the one place a truncation would
            // show: this line is where the utterance is declared over
            // on inference rather than on a marker. `budget` against
            // `delivery` is the safety margin that was actually
            // applied, so a real-call log makes a premature
            // termination visible instead of silent.
            // eslint-disable-next-line no-console
            console.log(
              `[TTS:sarvam] idle gap ${budget}ms elapsed after ${sequence} frames - treating utterance as complete (widestGap=${widestFrameGapMs}ms gaps=${observedGapCount} delivery=${Math.round(widestDeliveryMs)}ms)`,
            );
            break;
          }
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
