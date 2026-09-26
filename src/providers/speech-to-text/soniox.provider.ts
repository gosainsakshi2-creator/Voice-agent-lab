/**
 * soniox.provider.ts
 *
 * Concrete `SpeechToTextProvider` backed by Soniox's real-time
 * speech-to-text WebSocket (`wss://stt-rt.soniox.com/transcribe-websocket`,
 * model `stt-rt-v5`).
 *
 * ADDITIVE AND INERT BY DEFAULT. Registering this adapter changes
 * nothing: Deepgram remains the default and only allocated STT
 * provider, `resolveCallProviderStack` still returns the Deepgram
 * literal, and this class is only ever constructed when
 * `SONIOX_API_KEY` is set AND something asks the registry for the
 * `"soniox"` id by name.
 *
 * ── WHY THE RAW SOCKET AND NOT `@soniox/node` ────────────────────────
 *
 * The documented protocol is one JSON config frame, then binary audio
 * frames, then JSON result frames — small enough that the SDK would be
 * a dependency without a job. `ws` is already a production dependency
 * of this repo (the telephony media bridges run on it), so this adds
 * none. It also keeps the socket INJECTABLE, which is what lets the
 * whole adapter be tested against a mock without a Soniox key, a
 * network, or a live call. If the SDK is preferred later, `socketFactory`
 * is the single seam to swap.
 *
 * ── AUDIO ────────────────────────────────────────────────────────────
 *
 * The telephony bridges emit `MULAW` at 8000 Hz mono, and Soniox
 * accepts exactly that as the raw format `"mulaw"` with an explicit
 * `sample_rate`/`num_channels`. The bytes are forwarded UNTOUCHED —
 * there is no resampling, no transcoding and no framing change
 * anywhere in this file. A payload arriving in any other encoding is
 * refused rather than silently converted (see `assertSupportedAudio`).
 *
 * ── ENDPOINTING IS SONIOX'S, NOT DEEPGRAM'S ──────────────────────────
 *
 * Nothing here reads or reuses Deepgram's `endpointing`,
 * `utterance_end_ms`, `speech_final` or `UtteranceEnd`. Soniox signals
 * an endpoint with a dedicated `<end>` token that is always final and
 * appears once at the close of a finalized segment; that token is
 * mapped onto the provider-neutral `isEndOfSpeechMarker` segment this
 * codebase already defines for "the endpointer spoke, there are no new
 * words". Deepgram's own configuration is untouched by this file.
 */

import type { StreamingTranscriptionRequest } from "../../types/streaming.types";
import { SPEECH_TO_TEXT_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus, TranscriptSegment } from "../../types/provider.types";
import type {
  SpeechToTextProvider,
  TranscriptionRequest,
} from "../../interfaces/providers/speech-to-text-provider.interface";
import { optionalEnv, optionalEnvNumber } from "../shared/env";
import { ConfigurationError } from "../../core/errors";
import { AsyncQueue } from "../../core/session/async-queue";

/** Documented real-time endpoint. */
export const SONIOX_REALTIME_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
/** Documented real-time model. */
export const SONIOX_DEFAULT_MODEL = "stt-rt-v5";
/**
 * Soniox's raw-format name for 8 kHz G.711 mu-law — byte-identical to
 * what the Plivo and Vobiz bridges already produce.
 */
export const SONIOX_AUDIO_FORMAT = "mulaw";
export const SONIOX_SAMPLE_RATE_HZ = 8000;
export const SONIOX_NUM_CHANNELS = 1;
/** The endpoint token Soniox emits when `enable_endpoint_detection` is on. */
export const SONIOX_END_TOKEN = "<end>";

/**
 * Which languages to BIAS Soniox toward for a given session language.
 *
 * WHY THIS EXISTS. With no `language_hints` the multilingual model
 * "automatically detects and transcribes any supported language" — and
 * on this deployment's audio it was resolving Hindi and English speech
 * as PUNJABI. Punjabi is acoustically and lexically close to Hindi, so
 * an unbiased detector picking it is an entirely ordinary failure; the
 * transcript is then in a script the caller never spoke, and every
 * downstream vocabulary (the Devanagari affirmation/refusal tables,
 * the registration gate) stops matching.
 *
 * Hints BIAS, they do not restrict: Soniox documents that they "do not
 * restrict recognition to those languages — they only bias the model
 * toward them." So a caller who genuinely switches to a third language
 * is still transcribed; this only stops the model wandering off when
 * the audio is the Hindi/English it actually is.
 *
 * Derived from the session's own language rather than hard-coded, so
 * a Hindi campaign biases to Hindi alone and a Hinglish one carries
 * both — which is what code-switching mid-sentence needs.
 *
 * AN ENGLISH CAMPAIGN HINTS BOTH TOO (2026-09-21). Every campaign on
 * this deployment is stored as `en` (the form offers English and
 * Hindi, defaults to English, and its own help text says the language
 * is "opening language only"), yet the calls are answered in English,
 * Hindi and Hinglish alike. With `["en"]` the Hindi half of the audio
 * was unhinted, and on real calls the model resolved a one-word pickup
 * or acknowledgement to an unrelated language and script — 54 of ~800
 * Soniox caller turns arrived as Malayalam ("ഹലോ"), Gurmukhi ("ਹਾਂ
 * ਜੀ"), Kannada, Urdu, Gujarati, Telugu or Bengali, and every
 * downstream vocabulary then failed on them. Hints bias rather than
 * restrict, so English speech is still English; this only tells the
 * model which second language this deployment actually hears. The
 * campaign's stored language, the lock and the stream lifecycle are
 * unchanged — the hint is sent once, at connection, exactly as before.
 *
 * ── THE HINT ALONE IS NOT ENOUGH: SEE `language_hints_strict` ────────
 *
 * Hints BIAS. That is their documented job and also their limit, and
 * it is why widening this array did not stop the wrong-script
 * transcripts: measured over 167 answered English calls, 20.4% had at
 * least one Devanagari caller turn and 29.3% at least one non-Latin
 * turn, under hints `["en"]` ALONE. The model was not mishearing the
 * words — `"ब्रो, आय एम टेलिंग यू अगेन अँड अगेन दॅट यस, यू आर स्पीकिंग विथ साक्षी."`
 * is phonetic Devanagari of correctly recognised English — it was
 * writing them in a language the caller never spoke, and no value of a
 * BIAS parameter can forbid that.
 *
 * `language_hints_strict` is the parameter that can, and Soniox's own
 * documentation names this exact failure as what it is for: language
 * restriction is for applications that need "to avoid incorrect
 * alphabet transliteration". It is sent alongside this array — see
 * `SonioxEnvConfig.languageHintsStrict`.
 */
export function sonioxLanguageHints(language: SupportedLanguage): readonly string[] {
  switch (language) {
    case SupportedLanguage.ENGLISH:
      return ["hi", "en"];
    case SupportedLanguage.HINDI:
      return ["hi"];
    case SupportedLanguage.HINGLISH:
      // Both, deliberately. A Hinglish turn mixes the two inside one
      // sentence, so hinting only one biases against the other half.
      return ["hi", "en"];
  }
}

/**
 * Bounded, deliberately. The socket is re-dialled on an unexpected
 * close so a transient blip does not end a live call's transcription,
 * but a socket that cannot be established — a revoked key, a removed
 * model — must stop rather than spin. After this many consecutive
 * failures the stream reports the failure and ends.
 */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 250;

/**
 * ── WHY THESE DEFAULTS ARE NOT SONIOX'S DEFAULTS ─────────────────────
 *
 * Soniox's own defaults are `max_endpoint_delay_ms: 2000`,
 * `endpoint_latency_adjustment_level: 0` and `endpoint_sensitivity: 0.0`
 * — a conservative transcription profile, not a voice-agent one. Left
 * at those values this adapter would wait up to TWO SECONDS after the
 * caller stops before reporting an endpoint, while the Deepgram path it
 * would be compared against is configured at 400ms. That is not a
 * provider difference, it is a handicap, and it would make any
 * Soniox-vs-Deepgram measurement meaningless.
 *
 * These are the low-latency starting values Soniox's own endpoint
 * documentation recommends (level 2, sensitivity 0.3, delay 1500ms).
 * Every one is overridable from the environment for tuning.
 *
 * This changes NOTHING in production: Soniox is registered but never
 * selected unless `STT_PROVIDER=soniox`, and Deepgram's configuration
 * is not touched by this file.
 */
export const SONIOX_DEFAULT_MAX_ENDPOINT_DELAY_MS = 1500;
export const SONIOX_DEFAULT_LATENCY_ADJUSTMENT_LEVEL = 2;
export const SONIOX_DEFAULT_ENDPOINT_SENSITIVITY = 0.3;

/**
 * ── WHY STRICT IS ON BY DEFAULT ──────────────────────────────────────
 *
 * `language_hints` biases; `language_hints_strict` restricts. With the
 * hints alone the multilingual model stayed free to resolve this
 * deployment's audio to ANY of its 60+ languages, and on real calls it
 * did exactly that — English "Yes" as `यस।`, "Hello" as `हेलो।`/`हॅलो`,
 * and whole fluent English sentences written out in phonetic
 * Devanagari, plus Gurmukhi, Bengali, Malayalam, Telugu, Urdu, Kannada
 * and French renderings of the same one-word pickups. Soniox's
 * language-restriction documentation names this as the case the
 * parameter exists for: applications that need "to avoid incorrect
 * alphabet transliteration".
 *
 * With it true and the hints `["hi", "en"]`, the model is confined to
 * the two languages this deployment actually hears. That is what keeps
 * English in Latin and Hindi in Devanagari, and it is also what lets a
 * Hinglish sentence stay mixed: BOTH languages are inside the
 * restriction, so "मुझे इस webinar के बारे में जानना है" has every word it
 * needs available in its own script. A Hindi campaign restricts to
 * `["hi"]` alone, which is the single-language mode the vendor calls
 * most robust and "strongly recommended for production use".
 *
 * HONEST LIMITS, BOTH DOCUMENTED BY THE VENDOR:
 *
 *   - restriction is "best-effort, not a hard guarantee" — the model
 *     "may still occasionally output another language in rare edge
 *     cases";
 *   - with MORE than one language restricted, "accuracy can degrade
 *     when language identification becomes ambiguous, especially with
 *     heavy accents or acoustically similar languages". Hindi and
 *     accented Indian English are precisely such a pair, so this
 *     narrows the hi/en confusion sharply but cannot abolish it.
 *
 * Restricting to `["en"]` alone WOULD abolish it, and is refused: it
 * would transcribe a genuinely Hindi caller into Latin nonsense and
 * break every Devanagari vocabulary downstream. Two languages is the
 * strongest setting that still satisfies "Hindi speech → Hindi
 * transcript".
 *
 * The env var is the ROLLBACK LEVER — set `SONIOX_LANGUAGE_HINTS_STRICT
 * =false` to return to the previous bias-only behaviour without a code
 * change. Nothing else in the adapter reads it.
 */
export const SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT = true;

/**
 * ── KEYWORD BOOSTING (`context`) ─────────────────────────────────────
 *
 * Sent once, in the connection config. Soniox reads `terms` to recognise
 * listed words and keep their spelling and casing consistent, and
 * `general` as short domain guidance. Added 2026-09-26 because callers'
 * English words were coming back in Devanagari ("ओके", "राइट", "यस"): the
 * aim is that listed English words are written in Latin. A BIAS, not a
 * guarantee — the vendor says accented English can still be read as
 * Hindi. Hindi words are not listed, so Hindi speech is untouched.
 *
 * Rollback lever: `SONIOX_CONTEXT_ENABLED=false`.
 */
export const SONIOX_CONTEXT = {
  general: [
    { key: "domain", value: "Outbound phone call inviting the listener to a free live webinar" },
    { key: "organization", value: "FlexiFunnels" },
    { key: "languages", value: "Indian English and Hindi, often mixed in one sentence; English words are written in English" },
  ],
  terms: [
    "okay", "OK", "yes", "yeah", "right", "correct", "speaking", "hello", "hi",
    "sorry", "thank you", "thanks", "please", "sure", "fine", "no", "sir", "madam", "ma'am",
    "FlexiFunnels", "webinar", "workshop", "free seat", "reserve", "register", "registration",
    "WhatsApp", "email", "link", "online business", "website", "product", "checkout", "payments",
    "coding", "design", "Sunday", "October", "Launch-In-A-Day Starter Kit", "Q&A",
  ],
} as const;

export interface SonioxEnvConfig {
  /** Empty string means "not configured" — see `checkHealth`. */
  readonly apiKey: string;
  readonly model: string;
  readonly enableEndpointDetection: boolean;
  /**
   * Restrict recognition to `language_hints` rather than merely biasing
   * toward them. Vendor default false; we ship true — see
   * `SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT`.
   */
  readonly languageHintsStrict: boolean;
  /** Send `SONIOX_CONTEXT` (keyword boosting). Omitted means off, so configs built by hand in tests are unchanged. */
  readonly contextEnabled?: boolean;
  /** Documented range 500-3000ms. Vendor default 2000; we ship 1500. */
  readonly maxEndpointDelayMs: number;
  /** Documented range 0-3, higher returns endpoints sooner. Vendor default 0; we ship 2. */
  readonly endpointLatencyAdjustmentLevel: number;
  /** Documented range -1.0 to 1.0, higher makes an endpoint likelier. Vendor default 0; we ship 0.3. */
  readonly endpointSensitivity: number;
}

/**
 * Reads one numeric knob and REFUSES an out-of-range value.
 *
 * A throw here is safe and is the right loudness: `registerIfConfigured`
 * catches it and simply leaves Soniox unregistered with the reason
 * recorded, so a bad Soniox tuning value can never affect the Deepgram
 * registration production actually runs on.
 */
function rangedEnv(name: string, fallback: number, min: number, max: number): number {
  const value = optionalEnvNumber(name, fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(
      `${name} must be a number between ${min} and ${max}. Received "${String(value)}".`,
    );
  }
  return value;
}

export function loadSonioxEnvConfig(): SonioxEnvConfig {
  return {
    // NOT `requireEnv`. A missing key must leave the provider
    // constructible and merely UNHEALTHY — a throwing constructor
    // would take down `bootstrapProviderRegistry` for every other
    // provider, including the Deepgram one production actually uses.
    apiKey: optionalEnv("SONIOX_API_KEY", ""),
    model: optionalEnv("SONIOX_MODEL", SONIOX_DEFAULT_MODEL),
    enableEndpointDetection: optionalEnv("SONIOX_ENABLE_ENDPOINT_DETECTION", "true") === "true",
    // Same "opt OUT by setting the string false" shape as the line
    // above, so the one rollback lever behaves like the knob beside it.
    languageHintsStrict:
      optionalEnv(
        "SONIOX_LANGUAGE_HINTS_STRICT",
        SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT ? "true" : "false",
      ) === "true",
    contextEnabled: optionalEnv("SONIOX_CONTEXT_ENABLED", "true") === "true",
    maxEndpointDelayMs: rangedEnv(
      "SONIOX_MAX_ENDPOINT_DELAY_MS",
      SONIOX_DEFAULT_MAX_ENDPOINT_DELAY_MS,
      500,
      3000,
    ),
    endpointLatencyAdjustmentLevel: rangedEnv(
      "SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL",
      SONIOX_DEFAULT_LATENCY_ADJUSTMENT_LEVEL,
      0,
      3,
    ),
    endpointSensitivity: rangedEnv(
      "SONIOX_ENDPOINT_SENSITIVITY",
      SONIOX_DEFAULT_ENDPOINT_SENSITIVITY,
      -1,
      1,
    ),
  };
}

/** The subset of a WebSocket this adapter uses. Keeps the socket mockable. */
export interface SonioxSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  readyState?: number;
}

export type SonioxSocketFactory = (url: string) => SonioxSocketLike;

/** One token as Soniox delivers it. Every field beyond `text` is optional. */
interface SonioxToken {
  readonly text?: string;
  readonly is_final?: boolean;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly confidence?: number;
  readonly speaker?: string;
  readonly language?: string;
}

interface SonioxMessage {
  readonly tokens?: readonly SonioxToken[];
  readonly final_audio_proc_ms?: number;
  readonly total_audio_proc_ms?: number;
  readonly finished?: boolean;
  readonly error_code?: string | number;
  readonly error_message?: string;
}

/** Why the provider is not usable, when it is not. Drives `checkHealth`. */
export type SonioxUnavailableReason =
  | "missing_api_key"
  | "authentication_failed"
  | "provider_unavailable";

/**
 * Maps one Soniox result message onto this codebase's transcript
 * contract. Exported and PURE so the whole normalization can be
 * asserted without a socket.
 *
 * Three distinct outputs, matching the three things Soniox can say:
 *
 *   - non-final tokens  -> one INTERIM segment (`isFinal: false`)
 *   - final tokens      -> one FINAL segment (`isFinal: true`), which
 *                          is explicitly NOT an endpoint claim:
 *                          `isSpeechFinal: false`, because Soniox
 *                          finalizes words as it goes and says nothing
 *                          about the speaker having stopped.
 *   - the `<end>` token -> an END-OF-SPEECH MARKER carrying no words
 *
 * The `<end>` token is stripped from transcript text in every case: it
 * is a signal, and letting it reach the LLM or the turn detector as
 * literal characters would put "<end>" into the conversation.
 */
export function segmentsFromSonioxMessage(
  message: SonioxMessage,
  language: SupportedLanguage,
): readonly TranscriptSegment[] {
  const tokens = message.tokens ?? [];
  if (tokens.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  const endpointSeen = tokens.some((t) => t.text === SONIOX_END_TOKEN);
  const words = tokens.filter((t) => t.text !== SONIOX_END_TOKEN && (t.text ?? "").length > 0);

  const finals = words.filter((t) => t.is_final === true);
  const interims = words.filter((t) => t.is_final !== true);

  const build = (group: readonly SonioxToken[], isFinal: boolean): TranscriptSegment | undefined => {
    const text = group.map((t) => t.text ?? "").join("").trim();
    if (text.length === 0) return undefined;
    const starts = group.map((t) => t.start_ms).filter((n): n is number => typeof n === "number");
    const ends = group.map((t) => t.end_ms).filter((n): n is number => typeof n === "number");
    const confidences = group
      .map((t) => t.confidence)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    return {
      text,
      isFinal,
      // Soniox finalizes words continuously; only the `<end>` token is
      // an endpoint claim. Marking a word-bearing final as
      // `isSpeechFinal` would tell the turn detector the caller had
      // stopped every time a phrase settled mid-sentence.
      isSpeechFinal: false,
      confidence: confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
      language,
      // `0` is this codebase's "no word timings in this result"; Soniox
      // reports token times in ms from stream start, same basis the
      // pipeline's audio clock uses.
      startedAtMs: starts.length > 0 ? Math.min(...starts) : 0,
      endedAtMs: ends.length > 0 ? Math.max(...ends) : 0,
    };
  };

  const interimSegment = build(interims, false);
  if (interimSegment) segments.push(interimSegment);
  const finalSegment = build(finals, true);
  if (finalSegment) segments.push(finalSegment);

  if (endpointSeen) {
    // The provider-neutral marker this codebase already defines: no
    // text, no timings, no confidence worth reading — a signal that the
    // endpointer spoke. Emitted LAST so any words in the same message
    // reach the detector before the endpoint they belong to.
    segments.push({
      text: "",
      isFinal: true,
      isSpeechFinal: true,
      isEndOfSpeechMarker: true,
      confidence: 0,
      language,
      startedAtMs: 0,
      endedAtMs: 0,
    });
  }

  return segments;
}

/**
 * Refuses anything that is not what the bridges actually send.
 *
 * Deliberately a THROW rather than a conversion: this repo's
 * architecture makes transcoding a provider's own responsibility, but
 * inventing one here would mean shipping an untested resampler on the
 * live audio path. mu-law 8 kHz mono is what Plivo and Vobiz produce
 * and what Soniox accepts, so no conversion is required for any
 * configured telephony provider.
 */
function assertSupportedAudio(encoding: string, sampleRateHz: number): void {
  if (encoding !== "MULAW" || sampleRateHz !== SONIOX_SAMPLE_RATE_HZ) {
    throw new ConfigurationError(
      `Soniox STT is wired for MULAW @ ${SONIOX_SAMPLE_RATE_HZ}Hz (what the telephony bridges emit). ` +
        `Received ${encoding} @ ${sampleRateHz}Hz. Refusing rather than transcoding on the live path.`,
    );
  }
}

/** Recognises Soniox's authentication failures without leaking the key. */
function isAuthFailure(message: SonioxMessage): boolean {
  const code = String(message.error_code ?? "");
  const text = String(message.error_message ?? "").toLowerCase();
  return (
    code === "401" ||
    code === "403" ||
    code.toLowerCase().includes("unauthorized") ||
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("invalid api key")
  );
}

export class SonioxSpeechToTextProvider implements SpeechToTextProvider {
  readonly descriptor: ProviderDescriptor;

  private readonly config: SonioxEnvConfig;
  private readonly socketFactory: SonioxSocketFactory;
  /**
   * The last reason a stream could not run, latched for `checkHealth`.
   * This is how health distinguishes "auth rejected us" from "we could
   * not reach the service" WITHOUT making a probe call of its own.
   */
  private lastFailure: SonioxUnavailableReason | undefined;

  constructor(config: SonioxEnvConfig = loadSonioxEnvConfig(), socketFactory?: SonioxSocketFactory) {
    this.config = config;
    this.socketFactory = socketFactory ?? defaultSocketFactory;
    this.descriptor = {
      category: ProviderCategory.SPEECH_TO_TEXT,
      id: SPEECH_TO_TEXT_PROVIDER_IDS.SONIOX,
      displayName: "Soniox",
      supportedLanguages: [
        SupportedLanguage.ENGLISH,
        SupportedLanguage.HINDI,
        SupportedLanguage.HINGLISH,
      ],
      // Read by `SessionMetricsCollector.noteSttModel`, so a call runs
      // its model name into `call_metrics.raw.sttModel` exactly as the
      // Deepgram adapter does.
      version: config.model,
    };
  }

  /**
   * Soniox is integrated as a REAL-TIME provider only. Batch
   * transcription is a different endpoint that nothing in this
   * pipeline uses (the conversation loop feature-detects
   * `transcribeStream` and always takes it for a streaming provider),
   * so rather than ship an untested second integration this reports
   * plainly that it is not wired.
   */
  async transcribe(_request: TranscriptionRequest): Promise<readonly TranscriptSegment[]> {
    throw new ConfigurationError(
      "Soniox is integrated for real-time streaming only; use transcribeStream().",
    );
  }

  async *transcribeStream(
    request: StreamingTranscriptionRequest,
  ): AsyncIterable<TranscriptSegment> {
    if (this.config.apiKey.trim().length === 0) {
      this.lastFailure = "missing_api_key";
      throw new ConfigurationError(
        'Missing required environment variable "SONIOX_API_KEY" for provider "soniox".',
      );
    }

    const queue = new AsyncQueue<TranscriptSegment>();
    let finished = false;
    let attempts = 0;
    /**
     * Whether ANY socket reached `open` on this stream. A stream that
     * ends having never opened one is, by definition, a provider we
     * could not reach — latched here so `checkHealth` reports it even
     * when the caller's audio ended before the retry budget ran out.
     */
    let everOpened = false;
    let socket: SonioxSocketLike | undefined;
    /** Buffered while a reconnect is in flight, so no caller audio is dropped. */
    const pending: Uint8Array[] = [];

    const finish = (): void => {
      if (!finished && !everOpened) this.lastFailure ??= "provider_unavailable";
      finished = true;
      try {
        socket?.close(1000, "stream complete");
      } catch {
        // A socket already gone is exactly the state we wanted.
      }
      queue.close();
    };

    const handleMessage = (raw: unknown): void => {
      let message: SonioxMessage;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as SonioxMessage;
      } catch {
        return; // Not JSON — nothing this adapter can act on.
      }
      if (message.error_code !== undefined || message.error_message !== undefined) {
        this.lastFailure = isAuthFailure(message) ? "authentication_failed" : "provider_unavailable";
        // eslint-disable-next-line no-console
        console.error(
          `[STT:soniox] provider error code=${String(message.error_code ?? "-")} message=${String(message.error_message ?? "-")}`,
        );
        // An error is terminal for this socket. `finish()` ends the
        // segment stream rather than leaving the pipeline listening to
        // a socket that will never speak again.
        finish();
        return;
      }
      // TELEMETRY ONLY (2026-09-21) — Soniox reports a language per
      // token and this adapter stamps every segment with the REQUEST
      // language instead, so a transcript arriving in a script the caller
      // never spoke could not be attributed after the fact. Logged for
      // finals only, one line per final message; nothing reads it.
      const finalLanguages = [
        ...new Set(
          (message.tokens ?? [])
            .filter((t) => t.is_final === true && t.text !== SONIOX_END_TOKEN && (t.text ?? "").length > 0)
            .map((t) => t.language ?? "?"),
        ),
      ];
      if (finalLanguages.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[STT:soniox:${request.sessionId}] final tokens detected language=[${finalLanguages.join(",")}] requested=${request.language} hints=[${sonioxLanguageHints(request.language).join(",")}]`,
        );
      }
      for (const segment of segmentsFromSonioxMessage(message, request.language)) {
        queue.push(segment);
      }
      if (message.finished === true) finish();
    };

    const connect = (): void => {
      if (finished) return;
      attempts += 1;
      let next: SonioxSocketLike;
      try {
        next = this.socketFactory(SONIOX_REALTIME_URL);
      } catch (error) {
        this.lastFailure = "provider_unavailable";
        // eslint-disable-next-line no-console
        console.error(
          `[STT:soniox] socket could not be created: ${error instanceof Error ? error.message : String(error)}`,
        );
        finish();
        return;
      }
      socket = next;

      const on = (event: string, listener: (arg: unknown) => void): void => {
        if (typeof next.on === "function") next.on(event, (arg: unknown) => listener(arg));
        else if (typeof next.addEventListener === "function") next.addEventListener(event, listener);
      };

      on("open", () => {
        everOpened = true;
        attempts = 0; // A successful open retires the failure budget.
        // TELEMETRY ONLY (2026-09-21) — which hints this connection was
        // actually opened with, so a wrong-script transcript can be set
        // against the bias that was in force. The key is not logged.
        // eslint-disable-next-line no-console
        console.log(
          `[STT:soniox:${request.sessionId}] connecting model=${this.config.model} requested=${request.language} language_hints=[${sonioxLanguageHints(request.language).join(",")}]`,
        );
        // The config frame. The key is sent to Soniox and nowhere
        // else — it is never logged, never returned, never attached to
        // a segment or a metric.
        next.send(
          JSON.stringify({
            api_key: this.config.apiKey,
            model: this.config.model,
            audio_format: SONIOX_AUDIO_FORMAT,
            sample_rate: SONIOX_SAMPLE_RATE_HZ,
            num_channels: SONIOX_NUM_CHANNELS,
            // Biases recognition to the language this session is
            // actually conducted in. Without it the multilingual model
            // free-detects and was resolving Hindi/English audio as
            // Punjabi — see `sonioxLanguageHints`.
            language_hints: sonioxLanguageHints(request.language),
            // RESTRICTS to that array instead of merely biasing toward
            // it. This is the parameter that keeps English in Latin and
            // Hindi in Devanagari; the hints alone could not, because
            // they leave all 60+ languages reachable and the model was
            // reaching for them. See
            // `SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT` for the measured
            // failure and the vendor's own stated limits.
            language_hints_strict: this.config.languageHintsStrict,
            // Keyword boosting — see `SONIOX_CONTEXT`.
            ...(this.config.contextEnabled === true ? { context: SONIOX_CONTEXT } : {}),
            enable_endpoint_detection: this.config.enableEndpointDetection,
            // The three latency knobs, sent explicitly rather than left
            // to Soniox's conservative transcription defaults. See the
            // note on SONIOX_DEFAULT_MAX_ENDPOINT_DELAY_MS for why the
            // vendor defaults would have handicapped every measurement.
            max_endpoint_delay_ms: this.config.maxEndpointDelayMs,
            endpoint_latency_adjustment_level: this.config.endpointLatencyAdjustmentLevel,
            endpoint_sensitivity: this.config.endpointSensitivity,
          }),
        );
        for (const chunk of pending.splice(0)) next.send(chunk);
      });

      on("message", (event: unknown) => {
        const data =
          event !== null && typeof event === "object" && "data" in (event as Record<string, unknown>)
            ? (event as { data: unknown }).data
            : event;
        handleMessage(data);
      });

      on("error", (error: unknown) => {
        this.lastFailure ??= "provider_unavailable";
        // eslint-disable-next-line no-console
        console.warn(
          `[STT:soniox] socket error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      on("close", () => {
        if (finished) return;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          this.lastFailure ??= "provider_unavailable";
          // eslint-disable-next-line no-console
          console.error(
            `[STT:soniox] giving up after ${MAX_RECONNECT_ATTEMPTS} consecutive connection attempts`,
          );
          finish();
          return;
        }
        // BOUNDED backoff, and never a tight loop: each close costs one
        // attempt from a fixed budget that only a successful open refills.
        const delay = RECONNECT_BASE_DELAY_MS * attempts;
        // eslint-disable-next-line no-console
        console.warn(`[STT:soniox] socket closed — reconnecting in ${delay}ms (attempt ${attempts})`);
        setTimeout(connect, delay).unref?.();
      });
    };

    connect();

    const pump = (async () => {
      try {
        for await (const chunk of request.audio) {
          if (finished || request.signal?.aborted) break;
          assertSupportedAudio(chunk.encoding, chunk.sampleRateHz);
          const isOpen = socket?.readyState === undefined || socket.readyState === 1;
          if (socket && isOpen) socket.send(chunk.data);
          else pending.push(chunk.data);
        }
      } finally {
        finish();
      }
    })();

    const onAbort = (): void => finish();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const segment of queue) yield segment;
    } finally {
      finish();
      request.signal?.removeEventListener("abort", onAbort);
      await pump.catch(() => undefined);
    }
  }

  /**
   * Local readiness only — this makes NO outbound request, so it can
   * never place a call or spend a Soniox minute to answer.
   *
   * Four distinguishable states, as required:
   *   missing_api_key        the key is absent from the environment
   *   authentication_failed  a stream was rejected as unauthenticated
   *   provider_unavailable   a stream could not reach/keep the socket
   *   healthy                configured, and nothing has failed yet
   *
   * The two failure states are LATCHED from real stream attempts
   * rather than probed, which is what keeps this side-effect free.
   */
  async checkHealth(): Promise<ProviderHealthStatus> {
    const checkedAt = new Date();
    if (this.config.apiKey.trim().length === 0) {
      return {
        identifier: this.descriptor,
        isHealthy: false,
        checkedAt,
        latencyMs: 0,
        message: "missing_api_key: SONIOX_API_KEY is not configured.",
      };
    }
    if (this.lastFailure !== undefined) {
      return {
        identifier: this.descriptor,
        isHealthy: false,
        checkedAt,
        latencyMs: 0,
        message: `${this.lastFailure}: the most recent Soniox stream did not succeed.`,
      };
    }
    return { identifier: this.descriptor, isHealthy: true, checkedAt, latencyMs: 0 };
  }
}

/**
 * Real socket, built on the `ws` dependency the media bridges already
 * use. Imported lazily so constructing the provider — which the tests
 * and the registry both do — never opens a socket or requires `ws` to
 * be resolvable at module load.
 */
function defaultSocketFactory(url: string): SonioxSocketLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebSocket } = require("ws") as { WebSocket: new (u: string) => SonioxSocketLike };
  return new WebSocket(url);
}
