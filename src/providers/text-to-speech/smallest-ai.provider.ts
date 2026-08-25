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

/* ────────────────────────────────────────────────────────────────
 * EDGE-SILENCE TRIM (Smallest AI only)
 *
 * MEASURED, live account, 2026-08-25, three consecutive sentences
 * streamed sequentially exactly as the pipeline does, two rounds
 * each (RMS > 60 on 10ms windows = "speech"):
 *
 *   sentence                      lead     trail    Cartesia lead/trail
 *   "Actually, I am calling…"     300ms    350ms         0 /  10ms
 *   "We have created Flexi…"       80ms    360ms        90 /  90ms
 *   "Would you like to hear…"     240ms    360ms         0 /  20ms
 *
 * Identical to the millisecond across rounds: the vendor BAKES
 * ~80-300ms of leading and ~350-380ms of trailing silence into every
 * clip it renders. The pipeline issues one independent request per
 * sentence chunk, so at every sentence boundary the caller hears
 * trail(N) + lead(N+1) ≈ 430-680ms of dead air on top of the natural
 * pause the chunker's cut already implies. Cartesia's edges are
 * 0-90ms, which is why the same pipeline sounds continuous on that
 * lane. Queue starvation was ruled out: each Smallest stream completes
 * ~2.4s before its own audio has finished playing, so the next
 * request's ~450ms first-audio is fully covered.
 *
 * `remove_extra_silence: true` was tried on the stream endpoint and is
 * silently ignored (lead/trail unchanged over six paired runs), so the
 * trim has to happen here.
 *
 * What the trimmer does, and does not do:
 *   - Leading: silence before the first speech window is cut down to
 *     `EDGE_SILENCE_KEEP_MS`. Nothing is buffered beyond what the
 *     vendor has sent; the first yield is simply the first event that
 *     contains speech, so speech reaches the transport EARLIER than
 *     before (it used to sit behind the silence).
 *   - Trailing: silence after the last speech window is HELD back, not
 *     dropped — it is released in full the moment more speech arrives
 *     (internal pauses are preserved byte-for-byte), and only what is
 *     still held at `done:true` is cut down to `EDGE_SILENCE_KEEP_MS`.
 *     Holding trailing silence delays no audible sample: the held
 *     bytes are silent, and the transport queue is seconds deep.
 *   - Bounded: held silence never exceeds `SILENCE_HOLD_CAP_MS`. Past
 *     the cap an internal pause is flushed intact and excess leading
 *     silence is discarded to the cap, so the worst case is today's
 *     behaviour, never a hang or a lost word.
 *   - Detection is RMS over PCM_16 at ~-54 dBFS; the vendor's padding
 *     measures RMS 0-8, real speech onsets hundreds. Windows are
 *     evaluated within each event, so at most one extra 10ms window
 *     of silence survives at an edge.
 * ──────────────────────────────────────────────────────────────── */

/** RMS (PCM_16 units) at or below which a 10ms window counts as silence (~-54 dBFS). */
const EDGE_SILENCE_RMS_THRESHOLD = 64;
/** Analysis window. */
const EDGE_SILENCE_WINDOW_MS = 10;
/** Silence retained at each edge of a clip — Cartesia's measured edges are 0-90ms. */
const EDGE_SILENCE_KEEP_MS = 50;
/** Never hold back more silence than this; the vendor's trailing pad measures ≤380ms. */
const SILENCE_HOLD_CAP_MS = 600;

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Streaming trimmer for the vendor's per-clip leading/trailing silence.
 * One instance per `synthesizeStream` call. Input chunks must be
 * PCM_16 little-endian with an even byte length (the parity guard in
 * the read loop guarantees that).
 */
export class EdgeSilenceTrimmer {
  private readonly windowBytes: number;
  private readonly keepBytes: number;
  private readonly holdCapBytes: number;
  private speechStarted = false;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private trimmedLeadBytes = 0;
  private trimmedTrailBytes = 0;

  constructor(sampleRateHz: number) {
    const bytesPerMs = (sampleRateHz * 2) / 1000;
    this.windowBytes = Math.max(2, Math.round((bytesPerMs * EDGE_SILENCE_WINDOW_MS) / 2) * 2);
    this.keepBytes = Math.round((bytesPerMs * EDGE_SILENCE_KEEP_MS) / 2) * 2;
    this.holdCapBytes = Math.round((bytesPerMs * SILENCE_HOLD_CAP_MS) / 2) * 2;
  }

  /** Bytes safe to emit now, or `undefined` when everything is being held as possible trailing silence. */
  push(chunk: Uint8Array): Uint8Array | undefined {
    const { firstLoudStart, lastLoudEnd } = this.loudSpan(chunk);

    if (lastLoudEnd === 0) {
      // Entirely silent: hold it until speech proves it was an internal pause.
      this.hold(chunk);
      if (this.heldBytes > this.holdCapBytes) {
        if (this.speechStarted) return this.takeHeld();
        // Leading silence past the cap is discarded down to the cap — it is
        // provably silent, so nothing audible is lost.
        const excess = this.heldBytes - this.holdCapBytes;
        this.trimmedLeadBytes += excess;
        this.hold(this.takeHeld().subarray(excess));
      }
      return undefined;
    }

    let lead: Uint8Array;
    if (this.speechStarted) {
      // An internal pause: release every held byte, unchanged.
      lead = this.takeHeld();
      lead = concatBytes([lead, chunk.subarray(0, firstLoudStart)]);
    } else {
      this.speechStarted = true;
      this.hold(chunk.subarray(0, firstLoudStart));
      const all = this.takeHeld();
      const keepFrom = Math.max(0, all.byteLength - this.keepBytes);
      this.trimmedLeadBytes += keepFrom;
      lead = all.subarray(keepFrom);
    }

    const out = concatBytes([lead, chunk.subarray(firstLoudStart, lastLoudEnd)]);
    if (lastLoudEnd < chunk.byteLength) this.hold(chunk.subarray(lastLoudEnd));
    return out;
  }

  /** At end of stream: whatever is still held is trailing silence — keep only `EDGE_SILENCE_KEEP_MS` of it. */
  finish(): Uint8Array | undefined {
    if (this.heldBytes === 0) return undefined;
    const all = this.takeHeld();
    const keep = Math.min(all.byteLength, this.keepBytes);
    if (this.speechStarted) this.trimmedTrailBytes += all.byteLength - keep;
    else this.trimmedLeadBytes += all.byteLength - keep;
    return keep === 0 ? undefined : all.subarray(0, keep);
  }

  /** Diagnostic: bytes removed so far. */
  get trimmed(): { readonly leadBytes: number; readonly trailBytes: number } {
    return { leadBytes: this.trimmedLeadBytes, trailBytes: this.trimmedTrailBytes };
  }

  private hold(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.held.push(bytes);
    this.heldBytes += bytes.byteLength;
  }

  private takeHeld(): Uint8Array {
    const out = this.held.length === 1 ? this.held[0]! : concatBytes(this.held);
    this.held = [];
    this.heldBytes = 0;
    return out;
  }

  /** Byte offsets of the first speech window's start and the last speech window's end (0/0 when all silent). */
  private loudSpan(chunk: Uint8Array): { readonly firstLoudStart: number; readonly lastLoudEnd: number } {
    let firstLoudStart = -1;
    let lastLoudEnd = 0;
    for (let start = 0; start < chunk.byteLength; start += this.windowBytes) {
      const end = Math.min(start + this.windowBytes, chunk.byteLength);
      if (this.isLoud(chunk, start, end)) {
        if (firstLoudStart < 0) firstLoudStart = start;
        lastLoudEnd = end;
      }
    }
    return { firstLoudStart: firstLoudStart < 0 ? 0 : firstLoudStart, lastLoudEnd };
  }

  private isLoud(chunk: Uint8Array, start: number, end: number): boolean {
    let sum = 0;
    let n = 0;
    for (let i = start; i + 1 < end; i += 2) {
      // PCM_16 little-endian, sign-extended.
      const sample = ((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16;
      sum += sample * sample;
      n += 1;
    }
    if (n === 0) return false;
    return Math.sqrt(sum / n) > EDGE_SILENCE_RMS_THRESHOLD;
  }
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
    // Per-clip leading/trailing silence trim — see the note above the
    // class. One instance per stream; it never spans utterances.
    const trimmer = new EdgeSilenceTrimmer(this.config.sampleRateHz);

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

            // Edge-silence trim. `undefined` means the whole event was
            // silence and is being held as possible trailing padding;
            // it is released on the next speech event or cut at `done`.
            const playable = trimmer.push(chunk);
            if (playable === undefined || playable.byteLength === 0) continue;

            emittedAudio = true;
            yield {
              audio: {
                data: playable,
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
        const tail = trimmer.finish();
        if (tail !== undefined && tail.byteLength > 0) {
          emittedAudio = true;
          yield {
            audio: { data: tail, encoding: "PCM_16", sampleRateHz: this.config.sampleRateHz },
            sequence: sequence++,
            isFinal: false,
          };
        }
        const { leadBytes, trailBytes } = trimmer.trimmed;
        if (leadBytes > 0 || trailBytes > 0) {
          const bytesPerMs = (this.config.sampleRateHz * 2) / 1000;
          // eslint-disable-next-line no-console
          console.log(
            `[TTS:smallest-ai] trimmed edge silence lead=${Math.round(leadBytes / bytesPerMs)}ms trail=${Math.round(trailBytes / bytesPerMs)}ms`,
          );
        }
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
