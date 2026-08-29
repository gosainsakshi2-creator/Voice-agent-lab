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
 * ── HOW THE END OF AN UTTERANCE IS KNOWN ──────────────────────────
 *
 * Sarvam's WebSocket TTS protocol DOES carry an end-of-utterance marker,
 * but only when it is asked for: with `send_completion_event=true` on
 * the connection url, the server follows the last audio frame of a
 * `flush` with
 *
 *   {"type":"event","data":{"event_type":"final"}}
 *
 * Measured on the live account (bulbul:v3, 8kHz wav), 22 of 22 completed
 * utterances, 8-201 characters, cold and after a 3s virgin idle: the
 * event arrived 0-2ms AFTER the final audio frame, never before it, and
 * no audio frame ever followed it. Without the parameter the server
 * sends nothing at all after the last frame (15/15), which is why every
 * earlier audit of this adapter recorded "no non-audio frame" — the
 * marker is opt-in, and the url never opted in.
 *
 * That event is the ONLY completion signal `synthesizeStream` trusts.
 * Silence is not one: the vendor was observed to pause 786ms
 * mid-utterance and then finish normally, so any silence budget short
 * enough to be cheap at a chunk boundary is long enough to be tripped
 * by an ordinary stall — which is exactly how the previous idle-gap
 * inference (adaptive, 300-1200ms) truncated live sentences at 550, 672
 * and 700ms. The RIFF header declares `0xFFFFFFFF` for both sizes and
 * the server never closes on its own, so there was nothing else to read.
 *
 * ── THE FALLBACK, AND WHY IT IS NOT A COMPLETION PATH ─────────────
 *
 * Once in 34 live runs the vendor stopped sending audio and never sent
 * `final` either (a dropped stream: 133 characters, 3.6s of a ~7s clip,
 * then 11s of nothing). The audio is gone in that case; the only thing
 * left to bound is how long the caller hears dead air before the next
 * sentence. `COMPLETION_EVENT_FALLBACK_MS` is that bound. It is ~2.5x
 * the widest mid-stream stall ever observed on a healthy utterance, so
 * a stream that is merely slow is not abandoned, and it is reached ONLY
 * when the vendor has failed its own protocol. On a healthy utterance the
 * generator returns on the event, ~1-2ms after the last frame, and this
 * constant is never waited on.
 *
 * `SARVAM_STREAM_IDLE_GAP_MS` is still read into the config for
 * environment compatibility but no longer governs completion.
 */
const COMPLETION_EVENT_FALLBACK_MS = 2_000;

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
const SARVAM_PACE = 1.00;

/**
 * ── FIX #11 — VIRGIN-SOCKET PRE-OPEN ──────────────────────────────
 *
 * Sarvam is the only vendor in this stack reached over a WebSocket, so
 * it is the only one `http-keepalive.ts` cannot help: that file extends
 * the keep-alive of the global `fetch` pool, and says in its own header
 * that WebSocket traffic is untouched. Cartesia and Smallest AI reuse a
 * warm HTTPS socket across the inter-turn gap; this adapter built a new
 * connection from scratch for every utterance, and fully awaited it
 * before the first byte of text was sent.
 *
 * Measured on the live account, 3 runs, this pass:
 *
 *   handshake            347 / 369 / 369 ms
 *   RIFF header frame    +81 / +81 / +82 ms after the text is sent
 *   first REAL audio     +258 / +287 / +619 ms
 *
 * Phase C decomposed the same handshake as DNS 2ms / TCP 73ms / TLS
 * 88ms / **HTTP upgrade 169ms** = 326ms median — the largest component
 * being the vendor answering `101`, which is not client-optimizable by
 * anything except not opening the connection on the caller's clock.
 * (TLS session resumption via a shared agent was measured at 13ms / 4%
 * and rejected. Recorded so nobody re-measures it.)
 *
 * So the handshake is moved OFF the caller's clock: it is started when
 * the pipeline learns a turn is about to be released, which is ~1.1-1.5s
 * before the first sentence chunk exists (the evidenced confirmation
 * window, plus LLM time-to-first-token, plus chunker accumulation). A
 * 326-383ms handshake fits inside that with room to spare.
 *
 * ── WHY THIS IS NOT THE SOCKET POOLING PHASE C REFUSED ─────────────
 *
 * Phase C proved that Sarvam's protocol has NO utterance boundary: the
 * streaming RIFF header is sent ONCE PER SOCKET, not once per utterance
 * (3 utterances down one socket produced 1 header and 0 non-audio
 * frames), so two utterances sharing a socket cannot be told apart and
 * a truncation would become cross-utterance contamination. That finding
 * stands and this does not touch it.
 *
 * The property that makes this safe is that a socket handed out here is
 * VIRGIN: no `config`, no `text`, no `flush` has ever been sent on it,
 * and it is handed out AT MOST ONCE. So no two utterances ever share a
 * socket, exactly as before — the only thing that changed is WHEN the
 * TCP/TLS/upgrade cost was paid. One utterance per socket, one RIFF
 * header per socket, unchanged.
 *
 * ── PROVEN, NOT ASSUMED ────────────────────────────────────────────
 *
 * Idle tolerance before `config` was the one thing Phase C had not
 * measured. Probed against the live endpoint: virgin idle of
 * 0/1/3/5/7/10/20/40s — 12 sockets, every one still OPEN afterwards,
 * every one accepted `config` and produced valid 8kHz/16-bit/mono audio
 * (RMS 2693-3265, even byte counts), zero frames received while idle,
 * zero protocol errors. Concurrency worst case (3 streaming + 3 held
 * virgin = 6 simultaneous sockets): 6/6 handshakes, 3/3 virgins survived
 * the burst and then produced audio. 18/18 sockets valid overall.
 *
 * The TTL below is therefore chosen with margin rather than at the edge
 * of what was proven: 5s is well inside a tolerance that held at 40s.
 */
const WARM_SOCKET_TTL_MS = 5_000;

/**
 * One pre-opened, never-written-to socket belonging to ONE session.
 *
 * The parked listeners are the reason this is a record rather than a
 * bare socket. A `ws` socket with no `error` listener throws on error,
 * which would take the process down for a connection nobody is waiting
 * on — so a parked socket carries its own handlers, and they are
 * removed at the instant it is claimed, in the same synchronous block
 * that attaches `synthesizeStream`'s own. There is no window in which
 * the socket is unhandled.
 */
interface WarmSocket {
  readonly socket: WebSocket;
  readonly openedAtMs: number;
  /** Unused-socket reaper. `unref`ed, so a warm socket can never hold the process open. */
  readonly expiry: ReturnType<typeof setTimeout>;
  readonly onParkedError: (err: Error) => void;
  readonly onParkedClose: () => void;
  readonly onParkedMessage: () => void;
  /** Detaches the session's abort listener; called on claim and on dispose. */
  readonly detachAbort: () => void;
  /** Set the instant it leaves the map. A socket is handed out at most once. */
  claimed: boolean;
  /**
   * Set by a parked close, error, or — the contamination guard — ANY
   * inbound application frame. Nothing was sent, so nothing should ever
   * arrive; if something does, this socket is not virgin and is never
   * handed out.
   */
  poisoned: boolean;
}

interface SarvamEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly defaultSpeaker: string;
  readonly sampleRateHz: number;
  /** Read for environment compatibility; no longer governs completion — see `COMPLETION_EVENT_FALLBACK_MS`. */
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

  /**
   * FIX #11 — at most ONE pre-opened virgin socket per session, keyed by
   * `sessionId` and never shared. The provider is a process-wide
   * singleton (`bootstrapProviderRegistry` runs each factory once), so
   * all concurrent calls share this instance — which is exactly why the
   * key is the session and why `claimWarmSocket` deletes before it
   * returns.
   */
  private readonly warmSockets = new Map<string, WarmSocket>();

  constructor(config: SarvamEnvConfig = loadEnvConfig()) {
    this.config = config;
  }

  /**
   * The streaming endpoint. Extracted verbatim from `synthesizeStream`
   * so the pre-open and the synthesis path cannot drift apart — a warm
   * socket must be a socket to the SAME url, and everything that varies
   * per utterance (speaker, language, sample rate, pace) travels in the
   * `config` frame, not in the url.
   */
  private streamUrl(): string {
    // `send_completion_event=true` is what makes the server send the
    // `final` event the drain loop completes on. Requested here, on the
    // ONE url both the pre-open and the fresh-socket path use, so a warm
    // socket and a cold one are the same socket to the vendor.
    return `${this.config.baseUrl.replace(/^http/, "ws")}/text-to-speech/ws?model=${encodeURIComponent(
      this.config.model,
    )}&send_completion_event=true`;
  }

  private closeQuietly(socket: WebSocket): void {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      // A socket that cannot be closed is already gone. Nothing to do,
      // and this must never throw into a teardown path.
    }
  }

  /**
   * FIX #11 — open the socket this session's next utterance will need,
   * now. See `WARM_SOCKET_TTL_MS`.
   *
   * Nothing is sent. This opens a connection and parks it; the socket
   * stays VIRGIN until `claimWarmSocket` hands it to `synthesizeStream`,
   * which is the only place `config`/`text`/`flush` are ever written.
   *
   * ── Why this cannot race ───────────────────────────────────────────
   *
   * `new WebSocket(...)` is synchronous (it starts connecting and
   * returns), and the map is written in the SAME synchronous block, with
   * no `await` between the lookup and the insert. So two `prepareSession`
   * calls for one session — whether in the same tick or different ticks
   * — cannot both create a socket: the second finds the first's entry
   * and returns. One socket per session, by construction rather than by
   * a lock.
   *
   * Never throws: a provider hint that can break the caller is not a
   * hint. If anything here fails, the session simply pays the handshake
   * on the caller's clock exactly as it did before this existed.
   */
  prepareSession(sessionId: string, signal?: AbortSignal): void {
    try {
      if (signal?.aborted === true) return;

      const existing = this.warmSockets.get(sessionId);
      if (existing !== undefined) {
        // Already have one for this session — CONNECTING counts, so a
        // second hint arriving while the handshake is still in flight
        // does not open a duplicate.
        if (
          !existing.poisoned &&
          (existing.socket.readyState === WebSocket.CONNECTING ||
            existing.socket.readyState === WebSocket.OPEN)
        ) {
          return;
        }
        // Dead or contaminated: drop it and open a fresh one.
        this.disposeSession(sessionId);
      }

      const socket = new WebSocket(this.streamUrl(), {
        headers: { "api-subscription-key": this.config.apiKey },
      });

      const poison = (): void => {
        const current = this.warmSockets.get(sessionId);
        // Already claimed, already replaced, or already disposed — the
        // entry this listener belongs to is no longer the live one.
        if (current === undefined || current.socket !== socket) return;
        current.poisoned = true;
        this.disposeSession(sessionId);
      };

      const onParkedError = (): void => poison();
      const onParkedClose = (): void => poison();
      // Contamination guard. Nothing has been sent, so nothing should
      // arrive. If the vendor ever volunteers a frame, this socket is
      // not virgin and must never be handed to an utterance.
      const onParkedMessage = (): void => {
        // eslint-disable-next-line no-console
        console.warn(
          `[TTS:sarvam] pre-opened socket for session "${sessionId}" received an unsolicited frame — discarding it as non-virgin`,
        );
        poison();
      };

      const expiry = setTimeout(() => {
        const current = this.warmSockets.get(sessionId);
        if (current === undefined || current.socket !== socket) return;
        // eslint-disable-next-line no-console
        console.log(
          `[TTS:sarvam] pre-opened socket for session "${sessionId}" expired unused after ${WARM_SOCKET_TTL_MS}ms`,
        );
        this.disposeSession(sessionId);
      }, WARM_SOCKET_TTL_MS);
      if (typeof expiry.unref === "function") expiry.unref();

      const onAbort = (): void => this.disposeSession(sessionId);
      signal?.addEventListener("abort", onAbort, { once: true });

      const entry: WarmSocket = {
        socket,
        openedAtMs: Date.now(),
        expiry,
        onParkedError,
        onParkedClose,
        onParkedMessage,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
        claimed: false,
        poisoned: false,
      };

      // Synchronous with `new WebSocket` above — this is the whole of
      // the race argument. No await may ever be introduced between them.
      this.warmSockets.set(sessionId, entry);

      socket.on("error", onParkedError);
      socket.on("close", onParkedClose);
      socket.on("message", onParkedMessage);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[TTS:sarvam] could not pre-open a socket for session "${sessionId}" — the normal path is unaffected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * FIX #11 — release whatever `prepareSession` opened. Idempotent, and
   * safe for a session that was never prepared.
   *
   * The `error`/`close` listeners are deliberately left attached across
   * `closeQuietly`: closing can itself emit `error`, and an unhandled
   * one on a `ws` socket throws. `poison()` is guarded on the entry
   * still being the live one, so the close this triggers cannot recurse.
   */
  disposeSession(sessionId: string): void {
    const entry = this.warmSockets.get(sessionId);
    if (entry === undefined) return;
    this.warmSockets.delete(sessionId);
    clearTimeout(entry.expiry);
    entry.detachAbort();
    entry.socket.off("message", entry.onParkedMessage);
    this.closeQuietly(entry.socket);
  }

  /**
   * FIX #11 — atomically take this session's pre-opened socket, or
   * `undefined` if there is not a usable one.
   *
   * "Atomically" is load-bearing and is why the delete comes FIRST and
   * unconditionally: the entry leaves the map before a single check runs,
   * so a socket can be handed out at most once even if two utterances
   * for one session raced here, and an unusable one is never left behind
   * for the next utterance to trip over. Returning `undefined` is not a
   * failure — it is the signal to open a fresh socket exactly as the
   * method always did.
   */
  private claimWarmSocket(sessionId: string): WebSocket | undefined {
    const entry = this.warmSockets.get(sessionId);
    if (entry === undefined) return undefined;

    this.warmSockets.delete(sessionId);
    clearTimeout(entry.expiry);
    entry.detachAbort();

    if (entry.claimed) return undefined;
    entry.claimed = true;

    if (entry.poisoned || entry.socket.readyState !== WebSocket.OPEN) {
      // Still needs its parked handlers through the close, for the same
      // reason `disposeSession` keeps them.
      entry.socket.off("message", entry.onParkedMessage);
      this.closeQuietly(entry.socket);
      return undefined;
    }

    // Handed over unhandled — `synthesizeStream` attaches its own
    // `message`/`error`/`close` listeners in the same synchronous block
    // that calls this, so there is no window in which an `error` on this
    // socket is unhandled.
    entry.socket.off("error", entry.onParkedError);
    entry.socket.off("close", entry.onParkedClose);
    entry.socket.off("message", entry.onParkedMessage);
    return entry.socket;
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
   *   2. The end-of-utterance marker is OPT-IN. `streamUrl()` requests
   *      it, and `{type:"event", event_type:"final"}` is what ends the
   *      drain loop — see `COMPLETION_EVENT_FALLBACK_MS` for the
   *      measurements, and for why silence is deliberately NOT read as
   *      completion any more.
   */
  async *synthesizeStream(
    task: SynthesisTaskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioChunk> {
    const speaker = task.request.voiceId ?? this.config.defaultSpeaker;

    // FIX #11 — take this session's pre-opened VIRGIN socket if one is
    // waiting, otherwise open one exactly as this method always has.
    //
    // Everything below this line is unchanged, and deliberately so:
    //   - a claimed socket is already OPEN, so the open `await` below
    //     short-circuits on its existing `readyState === OPEN` branch
    //     and returns without waiting;
    //   - `config`, `text` and `flush` are still sent from here and
    //     ONLY from here, in the same order, with the same payloads —
    //     a warm socket has never carried application data;
    //   - the `finally` still closes the socket, warm or fresh, so a
    //     socket is used for exactly one utterance either way;
    //   - with no warm socket this is byte-for-byte the previous
    //     behaviour, which is what makes the fallback path free.
    const warmSocket = this.claimWarmSocket(task.sessionId);
    const socket =
      warmSocket ??
      new WebSocket(this.streamUrl(), {
        headers: { "api-subscription-key": this.config.apiKey },
      });
    if (warmSocket !== undefined) {
      // eslint-disable-next-line no-console
      console.log(
        `[TTS:sarvam] using PRE-OPENED socket for session "${task.sessionId}" — handshake already paid off the caller's clock`,
      );
    }

    /** Frames received but not yet yielded, oldest first. */
    const pending: Uint8Array[] = [];
    let notify: (() => void) | undefined;
    let closed = false;
    /** Set by the vendor's `final` event. The one thing that means "done". */
    let completed = false;
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
      let parsed: { type?: string; data?: { audio?: string; message?: string; event_type?: string } };
      try {
        parsed = JSON.parse(raw.toString()) as typeof parsed;
      } catch {
        return; // Sarvam sends only JSON frames; ignore anything else.
      }
      if (parsed.type === "error") {
        finish(new Error(`Sarvam TTS stream error: ${parsed.data?.message ?? "unknown"}`));
        return;
      }
      // The opt-in end-of-utterance marker — see `COMPLETION_EVENT_FALLBACK_MS`.
      if (parsed.type === "event") {
        if (parsed.data?.event_type === "final") {
          completed = true;
          wake();
        }
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
            pace: SARVAM_PACE,
          },
        }),
      );
      socket.send(JSON.stringify({ type: "text", data: { text: task.request.text } }));
      socket.send(JSON.stringify({ type: "flush" }));

      // -- Drain until the vendor's completion event -----------------
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
        // The vendor has said the utterance is over. Every audio frame
        // precedes the event on the wire and the socket delivers in
        // order, so by the time `completed` is observed here the drain
        // above has already yielded all of them — the check is placed
        // AFTER the drain for exactly that reason.
        if (completed) {
          if (!loggedFirst) {
            // eslint-disable-next-line no-console
            console.warn(
              `[TTS:sarvam] completion event arrived with NO audio for session "${task.sessionId}" (textLen=${task.request.text.length})`,
            );
          }
          break;
        }
        if (closed) break;

        // Two different waits wearing one name would be a bug. Before
        // the first frame this is the start timeout — socket handshake
        // plus the vendor starting synthesis, 500-1750ms measured and
        // worse under load. After it, it is the FAILURE-RECOVERY bound
        // described at `COMPLETION_EVENT_FALLBACK_MS`: not how long an
        // utterance is given to finish, but how long a vendor that has
        // gone silent WITHOUT sending `final` is given before the caller
        // is spared further dead air. A healthy stream never reaches it.
        const budget = loggedFirst ? COMPLETION_EVENT_FALLBACK_MS : this.config.streamStartTimeoutMs;

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
          if (loggedFirst) {
            // This line is the one place an utterance ends on anything
            // other than the vendor's own marker, and it means the
            // vendor dropped the stream. Loud on purpose.
            // eslint-disable-next-line no-console
            console.warn(
              `[TTS:sarvam] FALLBACK: no completion event and no audio for ${budget}ms after ${sequence} frames (textLen=${task.request.text.length}) — the vendor dropped the stream; ending the utterance`,
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
