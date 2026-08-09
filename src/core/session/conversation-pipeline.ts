/**
 * conversation-pipeline.ts
 *
 * Drives one session's LISTENING -> THINKING -> SPEAKING -> (repeat)
 * cycle against whatever streaming capabilities its resolved
 * provider stack happens to expose:
 *
 *  - STT: if `transcribeStream` exists, runs ONE continuous
 *    streaming transcription for the whole call and derives turn
 *    boundaries from the `AdaptiveTurnDetector`. Otherwise falls
 *    back to acquiring one whole `AudioPayload` at a time and
 *    treating each as a complete turn (the only option a batch
 *    `transcribe()` call allows).
 *
 *  - LLM: if `generateCompletionStream` exists, sentence-chunks the
 *    incoming token deltas and starts TTS on each sentence as soon
 *    as it's complete — real overlap between "the model is still
 *    thinking" and "the assistant has already started speaking".
 *    Otherwise waits for the full `generateCompletion` result before
 *    speaking at all.
 *
 *  - TTS: if `synthesizeStream` exists, plays audio chunks as they
 *    arrive. Otherwise synthesizes the whole utterance at once and
 *    simulates its playback duration so barge-in cancellation still
 *    behaves correctly even without a live audio transport.
 *
 * Barge-in ("the AI is speaking and the user starts talking") is
 * handled the same way regardless of which capabilities are
 * present: `BargeInController.triggerBargeIn()` aborts whatever is
 * currently in flight and the pipeline immediately falls back to
 * LISTENING.
 */
import type { TranscriptSegment } from "../../types/provider.types";
import { SessionState } from "../../types/enums";
import type { SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ConversationTurn } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { LanguageModelProvider } from "../../interfaces/providers/language-model-provider.interface";
import type { SpeechToTextProvider } from "../../interfaces/providers/speech-to-text-provider.interface";
import type { TextToSpeechProvider, SynthesisTaskRequest } from "../../interfaces/providers/text-to-speech-provider.interface";
import type { TelephonyProvider } from "../../interfaces/providers/telephony-provider.interface";

import type { SessionRecord } from "./session-record";
import { detectLanguage, type LanguageDetectionResult } from "./language-detector";
import { languageHintFor, openingLineFor } from "./system-prompt";
import { SentenceChunker } from "./sentence-chunker";
import { combineSignals, abortableSleep } from "./abort-utils";
import { estimateAudioSeconds, withByteCounter } from "./audio-utils";
import { estimateLlmCost, estimateSttCost, estimateTtsCost, estimateTokenCount } from "./cost-estimator";
import { withGracefulRetry, RecoverableTurnError, toSessionErrorInfo } from "./error-recovery";
import { formatForSpeech } from "../../utils/speech-formatter";

export interface ResolvedProviderStack {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LanguageModelProvider;
  readonly tts: TextToSpeechProvider;
}

/**
 * The slice of the VoiceSessionManager the pipeline needs in order
 * to move a session between states without duplicating the
 * transition-validation logic that already lives on the manager.
 */
export interface PipelineHost {
  transition(record: SessionRecord, to: SessionState, reason?: string): void;
  markError(record: SessionRecord, sourceCategory: string, error: unknown): void;
}

interface AcquiredTurn {
  readonly text: string;
  readonly sttMs: number;
  readonly sttCostUsd: number;
}

interface ThinkingAndSpeakingResult {
  readonly assistantText: string;
  readonly llmMs: number;
  readonly llmCostUsd: number;
  readonly ttsMs: number;
  readonly ttsCostUsd: number;
}

// ------------------------------------------------------------------
// Voice-safe output validation
// ------------------------------------------------------------------

/**
 * Strips markdown formatting that would sound wrong when read aloud
 * by TTS. Only removes formatting — NOT content. Prompt-echo
 * contamination is handled by `isContaminatedOutput` + retry, not
 * by regex stripping.
 */
function stripMarkdown(raw: string): string {
  let text = raw;

  // Remove markdown bullet points and numbered lists (e.g. "- ", "* ", "1. ")
  text = text.replace(/^[\t ]*[-*•]\s+/gm, "");
  text = text.replace(/^[\t ]*\d+\.\s+/gm, "");

  // Remove markdown headers ("# ", "## ", etc.)
  text = text.replace(/^[\t ]*#{1,6}\s+/gm, "");

  // Remove bold / italic markers (* ** _ __ ` ``)
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  text = text.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");

  // Collapse multiple newlines into a single space (voice is continuous)
  text = text.replace(/\n{2,}/g, " ");
  text = text.replace(/\n/g, " ");

  // Collapse multiple spaces
  text = text.replace(/ {2,}/g, " ");

  return text.trim();
}

/**
 * The full text -> speech conversion applied to everything the caller
 * hears: strip formatting TTS would read aloud, then enforce the
 * conversational rules the system prompt only asks for (no hesitation
 * openers, no stacked acknowledgements, no textbook Hindi, no ellipsis
 * dead air).
 */
function toSpokenText(raw: string): string {
  return formatForSpeech(stripMarkdown(raw));
}

/**
 * Detects prompt-contaminated output — the model has echoed system
 * instructions instead of producing a natural reply. Any output
 * matching this check is NEVER spoken. The pipeline retries with
 * a simplified prompt instead.
 */
const CONTAMINATION_MARKERS = [
  "role:",
  "persona:",
  "constraint",
  "language:",
  "how to talk:",
  "remember:",
  "context:",
  "instructions:",
  "system prompt:",
  "developer notes:",
  "as a voice assistant",
  "i was instructed",
  "my role is",
  "voice assistant on a",
];

function isContaminatedOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTAMINATION_MARKERS.filter((m) => lower.includes(m)).length >= 2;
}

/** Language-appropriate fallback greetings when the LLM fails or produces contaminated output. */
function fallbackGreeting(language: SupportedLanguage): string {
  switch (language) {
    case "hi":
      return "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?";
    case "hi-en":
      return "Hey, namaste! Kaise help kar sakta hoon aapki?";
    default:
      return "Hey! How can I help you today?";
  }
}

/** Maximum characters for a greeting — anything longer is almost certainly a prompt echo. */
const MAX_GREETING_CHARS = 200;

/**
 * Compensates for the small startup buffer the telephony bridges fill
 * before their playback pump sends its first frame. Keeps the drain
 * from finishing marginally early and re-opening the "queue still
 * playing while state says LISTENING" gap it exists to close.
 */
const PLAYBACK_PREROLL_ALLOWANCE_MS = 150;

/**
 * One end-to-end latency trace per turn.
 *
 * The pipeline's stages run across three different async contexts
 * (the STT listener, the LLM stream, the TTS stream), so "where did
 * the time go" was previously only answerable by diffing wall-clock
 * timestamps across unrelated log lines. This emits every stage of a
 * single turn on a shared clock instead:
 *
 *   greeting:     call-connected -> tts-first-chunk -> audio-queued
 *   normal turn:  turn-detected -> llm-request -> llm-first-token
 *                 -> tts-first-chunk -> audio-queued
 *
 * `audio-queued` is the moment the first frame reaches the transport;
 * the caller hears it one bridge pre-roll (~100ms) later.
 */
class TurnTimer {
  private readonly startedAt = Date.now();
  private readonly marks: string[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly label: string,
  ) {}

  mark(stage: string): void {
    const at = Date.now() - this.startedAt;
    this.marks.push(`${stage}=${at}ms`);
    // eslint-disable-next-line no-console
    console.log(`[TIMING:${this.sessionId}] ${this.label} ${stage} +${at}ms`);
  }

  summarize(): void {
    // eslint-disable-next-line no-console
    console.log(
      `[TIMING:${this.sessionId}] ${this.label} SUMMARY total=${Date.now() - this.startedAt}ms ${this.marks.join(" ")}`,
    );
  }
}

export class ConversationPipeline {
  private readonly usesStreamingStt: boolean;
  private sinceLastTurnBytes = 0;
  private sinceLastTurnEncoding: AudioPayload["encoding"] | undefined;
  private sinceLastTurnSampleRateHz: number | undefined;
  private batchAudioIterator: AsyncIterator<AudioPayload> | undefined;
  /** Total inbound audio (ms) handed to the STT stream so far — the same clock Deepgram's word times use. */
  private inboundStreamMs = 0;
  /** Value of `inboundStreamMs` when the current SPEAKING phase began. */
  private speakingStartedAtStreamMs = 0;
  /** Latency trace for the turn currently in flight, if any. */
  private activeTimer: TurnTimer | undefined;
  /** Guards `tts-first-chunk` / `audio-queued` so they mark the FIRST occurrence of each per turn. */
  private markedTtsThisTurn = false;
  private markedAudioThisTurn = false;

  constructor(
    private readonly record: SessionRecord,
    private readonly providers: ResolvedProviderStack,
    private readonly host: PipelineHost,
  ) {
    this.usesStreamingStt = typeof providers.stt.transcribeStream === "function";
  }

  /** Runs until the session's loop-abort signal fires or a fatal error occurs. */
  async run(): Promise<void> {
    const sid = this.record.id;
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal) {
      // eslint-disable-next-line no-console
      console.error(`[PIPELINE:${sid}] run() aborted — no loopAbortController on session record`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PIPELINE:${sid}] run() started — state=${this.record.state} streamingSTT=${this.usesStreamingStt} llm=${this.providers.llm.descriptor.id} tts=${this.providers.tts.descriptor.id} stt=${this.providers.stt.descriptor.id}`,
    );
    console.log("[PIPELINE] usesStreamingStt =", this.usesStreamingStt);

    // --- Greeting phase: a dedicated startup action, NOT a turn ---
    //
    // Continuous STT is deliberately NOT started yet. It used to start
    // here, concurrently with greeting generation, and that race is what
    // broke startup:
    //
    //   `startContinuousStt`'s barge-in check accepts a segment as an
    //   interruption when `segment.endedAtMs > speakingStartedAtStreamMs`.
    //   `speakingStartedAtStreamMs` is a snapshot of `inboundStreamMs`,
    //   which only advances as chunks are PULLED through the byte
    //   counter — and nothing is pulled until Deepgram's socket opens.
    //   So at greeting time the baseline is still ~0, and the very first
    //   transcript Deepgram ever emits (the caller's "Hello?" as they
    //   pick up, or line noise) satisfies `endedAtMs > 0` and barges in
    //   on the greeting. The greeting's LLM stream then breaks with
    //   empty text, so nothing is spoken and nothing is recorded — and
    //   the caller's "hello" becomes turn 1 instead, whose reply arrives
    //   many seconds later looking like a very slow greeting.
    //
    // Deferring the listener costs nothing: inbound audio accumulates in
    // the session's `AsyncQueue` (no telephony provider implements
    // `openMediaStream`, so that is always the source) and is replayed
    // to Deepgram in full the moment consumption starts below. Anything
    // the caller said during the greeting still becomes their first
    // turn — it just can no longer abort the greeting.
    if (!loopSignal.aborted) {
      // --- The greeting is spoken, not generated ---
      //
      // The system prompt mandates ONE fixed opening line per language
      // ("Use one opening line only ... then stop and let them
      // answer"), so an LLM round trip here only regenerates a line
      // that is already decided — at a measured cost of ~2.0s on
      // GPT-5.1 and ~5.7s on Gemma 4 before a single audio frame can
      // exist. Speaking `openingLineFor` directly removes the entire
      // LLM leg from call-connect, which is the only way time-to-first-
      // audio can reach the ~1s target: even the fastest configured
      // model's time-to-first-token exceeds that budget on its own.
      //
      // Everything downstream is unchanged — the greeting is still
      // recorded in memory as the assistant's first turn, so the
      // model has full context from the caller's very first reply.
      // Benchmark metrics are unaffected: `metrics.recordTurn` was
      // never called for the greeting (it is a startup action, not a
      // turn), and every LLM-served turn is still measured.
      const timer = new TurnTimer(sid, "GREETING");
      // eslint-disable-next-line no-console
      console.log(`[PIPELINE:${sid}] Conversation started — speaking fixed greeting, state=${this.record.state}`);
      try {
        const greetingText = openingLineFor(this.record.memory.currentLanguage, this.record.voiceGender);
        timer.mark("greeting-text-ready");

        this.beginTurnTiming(timer);
        await this.speakFixedUtterance(greetingText, loopSignal);
        this.activeTimer = undefined;
        timer.summarize();

        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Greeting spoken: text="${greetingText}" state=${this.record.state}`);
        this.record.memory.recordAssistantTurn(greetingText);
        this.record.bargeIn.reset();
      } catch (error) {
        this.activeTimer = undefined;
        if (!(error instanceof RecoverableTurnError)) {
          // eslint-disable-next-line no-console
          console.error(
            `[PIPELINE:${sid}] Greeting FATAL error: state=${this.record.state} error=${error instanceof Error ? error.message : String(error)} errorType=${error?.constructor?.name}`,
          );
          this.host.markError(this.record, "PIPELINE", error);
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] Greeting RecoverableTurnError (recovering): state=${this.record.state} error=${error.message} source=${error.sourceCategory} cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        );
        // State may be THINKING or SPEAKING here after the error.
        // Recover to LISTENING so the main loop can proceed. The
        // state machine now allows THINKING → LISTENING for exactly
        // this recovery case.
        if (this.record.state !== SessionState.LISTENING) {
          try {
            this.host.transition(this.record, SessionState.LISTENING, "recovering from greeting error");
          } catch {
            // eslint-disable-next-line no-console
            console.error(`[PIPELINE:${sid}] Could not recover to LISTENING from state=${this.record.state} — ending pipeline`);
            this.host.markError(this.record, "PIPELINE", error);
            return;
          }
        }
      }
    }

    // --- Hand off to the normal contextual conversation flow ---
    // The greeting is done (or failed and recovered to LISTENING).
    // Start the continuous listener now: from here on, everything —
    // turn detection, barge-in, contextual replies — behaves exactly
    // as it always has.
    if (this.usesStreamingStt && !loopSignal.aborted) {
      this.startContinuousStt(loopSignal);
    }

    // --- Main loop ---
    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] entering main loop — state=${this.record.state} aborted=${loopSignal.aborted}`);

    while (!loopSignal.aborted) {
      try {
        if (this.record.state !== SessionState.LISTENING) {
          // eslint-disable-next-line no-console
          console.log(
            `[PIPELINE:${sid}] Main loop: state=${this.record.state}, transitioning to LISTENING`,
          );
          this.host.transition(this.record, SessionState.LISTENING, "awaiting user speech");
        }

        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Waiting for user speech...`);
        const turn = await this.acquireNextUserTurn(loopSignal);
        if (!turn || loopSignal.aborted) {
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] acquireNextUserTurn returned null or aborted — exiting loop`);
          break;
        }

        // eslint-disable-next-line no-console
        console.log(`[STT:${sid}] Transcript received: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? "..." : ""}" sttMs=${turn.sttMs}`);

        // t0 for this turn's latency trace: the turn detector has just
        // endpointed, i.e. the caller has stopped speaking as far as
        // the pipeline is concerned. Everything after this is ours.
        const timer = new TurnTimer(sid, `TURN#${this.record.turnIndex}`);
        timer.mark("turn-detected");
        this.beginTurnTiming(timer);

        const detected = detectLanguage(turn.text, this.record.memory.currentLanguage);
        this.record.memory.recordUserTurn(turn.text, detected.language);
        // The committed turn now carries this text — drop the
        // display-only preview so it is not rendered twice.
        this.record.liveUserTranscript = "";

        const turnStartedAt = Date.now();
        const result = await this.runThinkingAndSpeaking(turn.text, detected, loopSignal);
        timer.summarize();
        this.activeTimer = undefined;
        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Turn complete: assistant="${result.assistantText.slice(0, 80)}${result.assistantText.length > 80 ? "..." : ""}" llmMs=${result.llmMs} ttsMs=${result.ttsMs}`);
        this.record.memory.recordAssistantTurn(result.assistantText);
        this.record.bargeIn.reset();

        this.record.metrics.recordTurn({
          turnIndex: this.record.turnIndex++,
          sttMs: turn.sttMs,
          llmMs: result.llmMs,
          ttsMs: result.ttsMs,
          totalMs: turn.sttMs + (Date.now() - turnStartedAt),
          sttCostUsd: turn.sttCostUsd,
          llmCostUsd: result.llmCostUsd,
          ttsCostUsd: result.ttsCostUsd,
        });
      } catch (error) {
        if (error instanceof RecoverableTurnError) {
          // eslint-disable-next-line no-console
          console.warn(`[PIPELINE:${sid}] RecoverableTurnError (continuing): ${error.message}`);
          // Recover state to LISTENING so the next iteration can proceed.
          if (this.record.state !== SessionState.LISTENING) {
            try {
              this.host.transition(this.record, SessionState.LISTENING, "recovering from turn error");
            } catch {
              // eslint-disable-next-line no-console
              console.error(`[PIPELINE:${sid}] Cannot recover to LISTENING from state=${this.record.state}`);
            }
          }
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] FATAL error — state=${this.record.state} errorType=${error?.constructor?.name} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.host.markError(this.record, "PIPELINE", error);
        return;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] run() exiting — state=${this.record.state} aborted=${loopSignal.aborted}`);
  }

  /** Installs `timer` as the trace for the turn now starting. */
  private beginTurnTiming(timer: TurnTimer): void {
    this.activeTimer = timer;
    this.markedTtsThisTurn = false;
    this.markedAudioThisTurn = false;
  }

  /** Records a stage on the in-flight turn's trace, if one is active. */
  private markTiming(stage: string): void {
    this.activeTimer?.mark(stage);
  }

  /** Externally-triggered barge-in (e.g. from a future real-time transport, or a test harness). */
  triggerExternalBargeIn(): void {
    this.record.bargeIn.triggerBargeIn();
    if (this.record.state === SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.LISTENING, "external barge-in signal");
    }
  }

  // ---------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------

  private inboundAudioSource(): AsyncIterable<AudioPayload> {
    return this.record.mediaStream?.inbound ?? this.record.inboundAudioFallback;
  }

  private startContinuousStt(loopSignal: AbortSignal): void {
    console.log("[PIPELINE] startContinuousStt() called");
    const wrapped = withByteCounter(this.inboundAudioSource(), (chunk) => {
      this.sinceLastTurnBytes += chunk.data.byteLength;
      this.sinceLastTurnEncoding ??= chunk.encoding;
      this.sinceLastTurnSampleRateHz ??= chunk.sampleRateHz;
      // Monotonic clock over the audio actually handed to the STT
      // stream, in the SAME units Deepgram reports word times in
      // (ms from the start of the stream). Used below to tell
      // "the caller is interrupting me" apart from "the caller
      // spoke before I started, and the transcript only just landed".
      this.inboundStreamMs += estimateAudioSeconds(chunk) * 1000;
    });

    void (async () => {
      try {
        const stream = this.providers.stt.transcribeStream?.({
          sessionId: this.record.id,
          audio: wrapped,
          language: this.record.memory.currentLanguage,
          signal: loopSignal,
        });
        if (!stream) return;

        for await (const segment of stream) {
          if (loopSignal.aborted) break;
         console.log(
  "[PIPELINE GOT]",
  Date.now(),
  segment.text,
  segment.isFinal,
  this.record.state
);
          // DISPLAY ONLY: surface what the caller is saying as soon
          // as Deepgram reports it (interim segments included) so the
          // Dashboard transcript no longer lags turn-end. Nothing
          // downstream reads this — turn detection, barge-in and the
          // LLM continue to work off `segment` / the turn detector
          // exactly as before.
          if (segment.text.trim().length > 0) {
            this.record.liveUserTranscript = segment.text;
          }

          // The user has started talking while the assistant was
          // speaking — cut TTS immediately and resume listening,
          // then keep feeding this segment into the turn detector so
          // nothing the user said is lost.
          //
          // `segment.endedAtMs` is the stream-relative end of the last
          // word Deepgram has transcribed. A segment only counts as an
          // interruption if that speech happened AFTER the assistant
          // started speaking. Without this check the very first turn is
          // always destroyed: the caller says "Hello?" as they pick up
          // (while we are still in THINKING), Deepgram's transcript for
          // it lands a second later — by which time the greeting has
          // entered SPEAKING — and the greeting is barged-in before a
          // single audio frame reaches the caller.
          if (
            this.record.state === SessionState.SPEAKING &&
            segment.endedAtMs > this.speakingStartedAtStreamMs
          ) {
            this.triggerExternalBargeIn();
          }

          this.record.turnDetector.feed(segment);
        }
      } catch {
        // A broken streaming STT connection here degrades to
        // "no more live transcription" rather than crashing the
        // session; `acquireNextUserTurn` will simply stop resolving
        // new turns, and `end()` still works normally.
      }
    })();
  }

  private async acquireNextUserTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    if (this.usesStreamingStt) {
      return this.waitForTurnDetectorEnd(loopSignal);
    }
    return this.acquireBatchTurn(loopSignal);
  }

  private waitForTurnDetectorEnd(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (result: AcquiredTurn | null): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        loopSignal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const unsubscribe = this.record.turnDetector.onTurnEnd((event) => {
             console.log(
  `[TURN END] ${Date.now()} text="${event.text}" sttMs=${event.turnDurationMs}`
);
        const audioSeconds = this.consumeSinceLastTurnAudioSeconds();
        const providerId = this.providers.stt.descriptor.id;
        finish({
          text: event.text,
          sttMs: event.turnDurationMs,
          sttCostUsd: estimateSttCost(providerId, audioSeconds),
        });
      });

      const onAbort = (): void => finish(null);
      loopSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private consumeSinceLastTurnAudioSeconds(): number {
    if (this.sinceLastTurnBytes === 0 || !this.sinceLastTurnSampleRateHz) return 0;
    const seconds = estimateAudioSeconds({
      data: new Uint8Array(this.sinceLastTurnBytes),
      encoding: this.sinceLastTurnEncoding ?? "PCM_16",
      sampleRateHz: this.sinceLastTurnSampleRateHz,
    });
    this.sinceLastTurnBytes = 0;
    return seconds;
  }

  private async acquireBatchTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    this.batchAudioIterator ??= this.inboundAudioSource()[Symbol.asyncIterator]();

    while (!loopSignal.aborted) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<IteratorResult<AudioPayload>>((resolve) => {
        onAbort = () => resolve({ value: undefined as unknown as AudioPayload, done: true });
        loopSignal.addEventListener("abort", onAbort, { once: true });
      });

      const next = await Promise.race([this.batchAudioIterator.next(), abortPromise]);
      if (onAbort) loopSignal.removeEventListener("abort", onAbort);

      if (next.done || loopSignal.aborted) return null;

      const providerId = this.providers.stt.descriptor.id;
      let segments: TranscriptSegment[] = [];

if (this.usesStreamingStt && this.providers.stt.transcribeStream) {
  segments = [];

  for await (const segment of this.providers.stt.transcribeStream({
    sessionId: this.record.id,
    audio: (async function* () {
      yield next.value;
    })(),
    language: this.record.memory.currentLanguage,
    signal: loopSignal,
  })) {
    segments.push(segment);
  }
} else {
  segments = [
    ...(await withGracefulRetry("SPEECH_TO_TEXT", () =>
    this.providers.stt.transcribe({
      sessionId: this.record.id,
      audio: next.value,
      language: this.record.memory.currentLanguage,
    }),
    )),
];
}

      const text = segments
        .filter((segment) => segment.isFinal)
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (text.length === 0) continue; // silence/noise chunk — keep listening

      return {
        text,
        sttMs: 0,
        sttCostUsd: estimateSttCost(providerId, estimateAudioSeconds(next.value)),
      };
    }

    return null;
  }

  // ---------------------------------------------------------------
  // LLM + TTS
  // ---------------------------------------------------------------

  /**
   * Builds the turn array sent to the LLM.
   *
   * Rules:
   *   1. Exactly ONE system turn — the leading prompt from ConversationMemory.
   *   2. Language hints are folded into the latest user message,
   *      never added as a separate system turn (doing so caused
   *      Gemma's `toGoogleContents` to merge ALL system turns into
   *      the first user message, growing it each turn and triggering
   *      prompt-echo).
   *   3. History order: system → user → assistant → user → assistant …
   */
 private buildRequestHistory(
  detectedLanguage: SupportedLanguage
): readonly ConversationTurn[] {

  const turns = this.record.memory.recentHistory().map(turn => ({ ...turn }));

  const hint = languageHintFor(detectedLanguage);

  for (let i = turns.length - 1; i >= 0; i--) {

      const turn = turns[i];

      if (!turn) continue;

      if (turn.role === "user") {

          turn.content = `${hint}\n${turn.content}`;

          break;
      }
  }

  return turns;
}

  /**
   * Speaks a known utterance with no LLM call in the path — used for
   * the greeting, whose text the system prompt already fixes.
   *
   * Goes through the same THINKING -> SPEAKING -> drain sequence as a
   * generated reply so state transitions, barge-in and playback
   * accounting behave identically; only the token-generation stage is
   * absent. THINKING is entered because the state machine has no
   * LISTENING -> SPEAKING edge, and skipping it would also hide the
   * greeting from the dashboard's state stepper.
   */
  private async speakFixedUtterance(text: string, loopSignal: AbortSignal): Promise<void> {
    this.host.transition(this.record, SessionState.THINKING, "preparing the greeting");
    const speakingSignal = this.enterSpeaking();
    if (speakingSignal.aborted || loopSignal.aborted) return;

    await this.synthesizeAndPlay(toSpokenText(text), speakingSignal);
    await this.drainPlayback(speakingSignal);
  }

  private async runThinkingAndSpeaking(
    userText: string,
    detected: LanguageDetectionResult,
    loopSignal: AbortSignal,
  ): Promise<ThinkingAndSpeakingResult> {
    const sid = this.record.id;
    const isGreeting = userText === "";

    this.host.transition(this.record, SessionState.THINKING, "generating a reply");
    const thinkingSignal = combineSignals([this.record.bargeIn.beginThinking(), loopSignal]);
    const request: CompletionRequest = { sessionId: this.record.id, history: this.buildRequestHistory(detected.language) };
    const llmProviderId = this.providers.llm.descriptor.id;

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:${sid}] Sending to ${llmProviderId}: historyLength=${request.history.length} roles=[${request.history.map((t) => t.role).join(",")}] streaming=${typeof this.providers.llm.generateCompletionStream === "function"}`,
    );
    this.markTiming("llm-request");

    if (this.providers.llm.generateCompletionStream) {
      return this.runStreamingCompletion(request, thinkingSignal, loopSignal, userText, llmProviderId);
    }

    return withGracefulRetry("LANGUAGE_MODEL", async () => {
      // eslint-disable-next-line no-console
      console.log(`[LLM:${sid}] Calling generateCompletion() (batch mode)...`);
      const startedAt = Date.now();
      const completion = await this.providers.llm.generateCompletion(request);
      let llmMs = Date.now() - startedAt;

      let spokenContent = toSpokenText(completion.turn.content);

      // --- Contamination check: if the output echoes system-prompt
      // markers, retry ONCE with a simplified prompt. Never speak
      // contaminated output. ---
      if (isContaminatedOutput(spokenContent) || (isGreeting && spokenContent.length > MAX_GREETING_CHARS)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LLM:${sid}] Output contaminated or too long (len=${spokenContent.length}), retrying with simplified prompt`,
        );
        const retryHistory: ConversationTurn[] = request.history
          .filter((t) => t.role !== "system")
          .slice(-2); // Last user + possibly last assistant only
        retryHistory.unshift({
          role: "system" as const,
          content: "Reply in one short, natural sentence. Do not describe yourself or your instructions.",
          timestamp: new Date(),
        });
        const retryRequest: CompletionRequest = { sessionId: request.sessionId, history: retryHistory };
        const retryStart = Date.now();
        try {
          const retryCompletion = await this.providers.llm.generateCompletion(retryRequest);
          llmMs += Date.now() - retryStart;
          const retryContent = toSpokenText(retryCompletion.turn.content);
          if (!isContaminatedOutput(retryContent) && retryContent.length > 0) {
            spokenContent = retryContent;
            // eslint-disable-next-line no-console
            console.log(`[LLM:${sid}] Retry succeeded: "${spokenContent.slice(0, 80)}"`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[LLM:${sid}] Retry also contaminated — using fallback`);
            spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
          }
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`[LLM:${sid}] Retry failed — using fallback`);
          spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[LLM:${sid}] Response generated in ${llmMs}ms: text="${spokenContent.slice(0, 120)}${spokenContent.length > 120 ? "..." : ""}" state=${this.record.state}`,
      );
const speakingSignal = combineSignals([
  this.record.bargeIn.beginSpeaking(),
  loopSignal,
]);

if (this.record.state !== SessionState.SPEAKING) {
  this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
}
this.resetPlaybackAccounting();

const { ttsMs, ttsCostUsd } =
  await this.synthesizeAndPlay(spokenContent, speakingSignal);

// Streaming TTS only enqueues; hold SPEAKING until playback drains.
// (The batch-TTS branch already sleeps for its own playback and will
// simply find nothing left to wait for here.)
await this.drainPlayback(speakingSignal);

      return {
        assistantText: spokenContent,
        llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(spokenContent)),
        ttsMs,
        ttsCostUsd,
      };
    });
  }

  private async runStreamingCompletion(
    request: CompletionRequest,
    thinkingSignal: AbortSignal,
    loopSignal: AbortSignal,
    userText: string,
    llmProviderId: string,
  ): Promise<ThinkingAndSpeakingResult> {
    const chunker = new SentenceChunker();
    let fullText = "";
    let finalText: string | undefined;
    let llmMs = 0;
    let ttsMs = 0;
    let ttsCostUsd = 0;
    let speakingSignal: AbortSignal | undefined;
    // Set once contamination is detected mid-stream: stops speaking any
    // further sentences from this turn. See the contamination check
    // below for why this exists — the batch path's isContaminatedOutput
    // + retry safety net never runs for a streaming provider, and both
    // configured LLM providers (GPT-5.1, Gemma) implement streaming.
    let contaminated = false;
    const startedAt = Date.now();

    try {
      const stream = this.providers.llm.generateCompletionStream?.(request, thinkingSignal);
      if (!stream) throw new Error("generateCompletionStream unexpectedly unavailable");

      for await (const event of stream) {
        if (thinkingSignal.aborted) break;

        if (event.type === "token") {
          if (fullText.length === 0) this.markTiming("llm-first-token");
          fullText += event.delta;
          const readySentences = chunker.push(event.delta);
          for (const sentence of readySentences) {
            const cleaned = toSpokenText(sentence);
            if (cleaned.length === 0) continue;

            // Check the ACCUMULATED text so far, not just this sentence
            // in isolation — a leak's markers are often split across
            // sentence boundaries (e.g. "Persona: ..." / "Constraints:
            // ..."), and isContaminatedOutput requires two markers to
            // avoid false positives on an innocent single word. This
            // can't prevent an EARLIER sentence in the same turn from
            // having already been spoken (streaming speaks as it goes,
            // by design, for latency) — but it stops the turn the
            // moment contamination becomes detectable, rather than
            // speaking the entire echoed prompt to the caller.
            if (isContaminatedOutput(fullText)) {
              contaminated = true;
              break;
            }

            speakingSignal ??= this.enterSpeaking();
            if (speakingSignal.aborted) break;
            const spoken = await this.synthesizeAndPlay(cleaned, speakingSignal);
            ttsMs += spoken.ttsMs;
            ttsCostUsd += spoken.ttsCostUsd;
          }
        } else {
          finalText = event.turn.content;
          llmMs = event.latencyMs;
        }

        if (contaminated || speakingSignal?.aborted) break;
      }
    } catch {
      // Streaming LLM connection dropped mid-reply — speak whatever
      // was generated so far rather than losing the turn entirely.
    }

    if (llmMs === 0) llmMs = Date.now() - startedAt;

    if (contaminated) {
      // eslint-disable-next-line no-console
      console.warn(
        `[LLM:${this.record.id}] Streaming output contaminated (prompt echo) — suppressing remainder of turn, using fallback`,
      );
      const fallback = fallbackGreeting(this.record.memory.currentLanguage);
      if (!(speakingSignal?.aborted ?? false)) {
        speakingSignal ??= this.enterSpeaking();
        if (!speakingSignal.aborted) {
          const spoken = await this.synthesizeAndPlay(fallback, speakingSignal);
          ttsMs += spoken.ttsMs;
          ttsCostUsd += spoken.ttsCostUsd;
        }
      }
      // Stay in SPEAKING until the queued audio has actually played.
      // `ttsMs`/`ttsCostUsd` are already fixed above, so the drain
      // never leaks into the TTS latency metric.
      if (speakingSignal) await this.drainPlayback(speakingSignal);
      return {
        assistantText: fallback,
        llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(fallback)),
        ttsMs,
        ttsCostUsd,
      };
    }

    const rawRemainder = chunker.flush();
    const remainder = rawRemainder ? toSpokenText(rawRemainder) : "";
    if (remainder.length > 0 && !(speakingSignal?.aborted ?? false)) {
      speakingSignal ??= this.enterSpeaking();
      if (!speakingSignal.aborted) {
        const spoken = await this.synthesizeAndPlay(remainder, speakingSignal);
        ttsMs += spoken.ttsMs;
        ttsCostUsd += spoken.ttsCostUsd;
      }
    }

    // Hold SPEAKING open for the audio still queued on the transport.
    // Aborts instantly on barge-in; `ttsMs` was already accumulated
    // from generation time only, so the metric is unaffected.
    if (speakingSignal) await this.drainPlayback(speakingSignal);

    const assistantText = toSpokenText(finalText ?? fullText);

    // If nothing was ever spoken (e.g. immediate barge-in), still
    // make sure we transitioned through SPEAKING at least nominally
    // isn't required — LISTENING is re-entered naturally by the
    // caller's next loop iteration either way.
    void loopSignal;

    return {
      assistantText,
      llmMs,
      llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(assistantText)),
      ttsMs,
      ttsCostUsd,
    };
  }

  private enterSpeaking(): AbortSignal {
    if (this.record.state !== SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
    }
    this.resetPlaybackAccounting();
    return combineSignals([this.record.bargeIn.beginSpeaking(), this.record.loopAbortController!.signal]);
  }

  // ---------------------------------------------------------------
  // Real-time playback accounting
  //
  // A streaming TTS provider hands us a whole reply far faster than
  // real time, and `playAudioChunk` only ENQUEUES it on the transport
  // (both the Plivo and Vobiz bridges pace their own 20ms pumps).
  // Without the drain below, SPEAKING ended the moment the last byte
  // was queued — leaving several seconds of assistant audio still
  // playing while the session already claimed to be LISTENING. That
  // single fact broke barge-in (`state === SPEAKING` was false, so no
  // interruption was ever triggered) and let a new turn's audio be
  // appended behind the previous turn's backlog.
  // ---------------------------------------------------------------

  /** Total real-time duration of audio handed to the transport this speaking phase. */
  private outboundQueuedMs = 0;
  /** Wall clock at which the transport began playing this speaking phase. */
  private outboundPlaybackStartedAt = 0;

  private resetPlaybackAccounting(): void {
    this.outboundQueuedMs = 0;
    this.outboundPlaybackStartedAt = 0;
    // Called at exactly the two places the session enters SPEAKING, so
    // this is the stream-clock mark the barge-in check above compares
    // incoming transcript segments against.
    this.speakingStartedAtStreamMs = this.inboundStreamMs;
  }

  /**
   * Holds SPEAKING open until the audio already handed to the
   * transport has actually played out. Resolves immediately when
   * `signal` aborts, so barge-in cuts the wait with no added latency.
   */
  private async drainPlayback(signal: AbortSignal): Promise<void> {
    if (this.outboundPlaybackStartedAt === 0 || this.outboundQueuedMs <= 0) return;
    if (signal.aborted) return;

    const elapsedMs = Date.now() - this.outboundPlaybackStartedAt;
    // Small allowance for the bridge's startup pre-roll: the pump waits
    // for a few frames before its first send, so playback starts
    // marginally later than the first enqueue.
    const remainingMs = this.outboundQueuedMs - elapsedMs + PLAYBACK_PREROLL_ALLOWANCE_MS;
    if (remainingMs <= 0) return;

    // eslint-disable-next-line no-console
    console.log(
      `[PLAYBACK:${this.record.id}] draining ${Math.round(remainingMs)}ms of queued audio before leaving SPEAKING (queued=${Math.round(this.outboundQueuedMs)}ms elapsed=${elapsedMs}ms)`,
    );
    await abortableSleep(remainingMs, signal);
  }

  private async synthesizeAndPlay(text: string, speakingSignal: AbortSignal): Promise<{ ttsMs: number; ttsCostUsd: number }> {
    const sid = this.record.id;
    if (speakingSignal.aborted || text.trim().length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] synthesizeAndPlay skipped (aborted=${speakingSignal.aborted} emptyText=${text.trim().length === 0})`);
      return { ttsMs: 0, ttsCostUsd: 0 };
    }

    const ttsProviderId = this.providers.tts.descriptor.id;
    // eslint-disable-next-line no-console
    console.log(`[TTS:${sid}] Synthesis started: provider=${ttsProviderId} textLen=${text.length} text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}" streaming=${typeof this.providers.tts.synthesizeStream === "function"}`);
    const task: SynthesisTaskRequest = {
      sessionId: this.record.id,
      request: { text, language: this.record.memory.currentLanguage },
    };
    const startedAt = Date.now();

    if (this.providers.tts.synthesizeStream) {
      let chunkCount = 0;
      this.transportBackpressureMs = 0;
      try {
       for await (const chunk of this.providers.tts.synthesizeStream(task, speakingSignal)) {
   if (chunkCount === 0 && !this.markedTtsThisTurn) {
    this.markedTtsThisTurn = true;
    this.markTiming("tts-first-chunk");
}
  if (speakingSignal.aborted) {
    console.log(`[TTS:${sid}] Barge-in detected, interrupting playback`);

    await this.record.mediaStream?.interruptPlayback();

    break;
  }

  chunkCount += 1;

  await this.playAudioChunk(chunk.audio);
}
      } catch (err) {
        if (!speakingSignal.aborted) {
          // eslint-disable-next-line no-console
          console.warn(`[TTS:${sid}] streaming TTS error after ${chunkCount} chunks: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const ttsMs = Math.max(0, Date.now() - startedAt - this.transportBackpressureMs);
      // eslint-disable-next-line no-console
      console.log(
        `[TTS:${sid}] streaming TTS done: ${chunkCount} chunks, ${ttsMs}ms (paced ${this.transportBackpressureMs}ms on transport backpressure)`,
      );
      return { ttsMs, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    }

    return withGracefulRetry("TEXT_TO_SPEECH", async () => {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] Calling synthesize() (batch mode)...`);
      const audio = await this.providers.tts.synthesize(task);
      const ttsCallMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[TTS:${sid}] Audio chunks generated: ${ttsCallMs}ms encoding=${audio.encoding} sampleRate=${audio.sampleRateHz} bytes=${audio.data.byteLength}`,
      );
      await this.playAudioChunk(audio);

      const playbackMs = estimateAudioSeconds(audio) * 1000;
      // eslint-disable-next-line no-console
      console.log(`[PLAYBACK:${sid}] Playback started: estimated ${Math.round(playbackMs)}ms`);
      await abortableSleep(playbackMs, speakingSignal);
      if (speakingSignal.aborted) {
        await this.record.mediaStream?.interruptPlayback();
      }

      return { ttsMs: ttsCallMs, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    });
  }

  private playAudioChunkCount = 0;
  private outboundReadyResolved = false;
  /**
   * Wall-clock ms the current `synthesizeAndPlay` call spent parked on
   * transport backpressure. Subtracted from `ttsMs` so the benchmark
   * metric keeps measuring how fast the TTS provider generated audio,
   * not how long the telephony pump took to play it — the same
   * separation `drainPlayback` already preserves.
   */
  private transportBackpressureMs = 0;

  /**
   * Waits until at least one outbound delivery path (mediaStream or
   * a listener) is available, up to a timeout. Called once before
   * the first audio chunk to handle the edge case where the pipeline
   * starts before the bridge has registered its listener.
   */
  private async waitForOutboundReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.outboundReadyResolved) return;
    const hasPath = () => !!this.record.mediaStream || this.record.outboundAudioListeners.size > 0;
    if (hasPath()) { this.outboundReadyResolved = true; return; }

    // eslint-disable-next-line no-console
    console.warn(
      `[PLAYBACK:${this.record.id}] No outbound delivery path yet — waiting up to ${timeoutMs}ms for bridge to attach`,
    );

    const deadline = Date.now() + timeoutMs;
    while (!hasPath() && Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 50));
    }

    this.outboundReadyResolved = true;
    if (!hasPath()) {
      // eslint-disable-next-line no-console
      console.error(
        `[PLAYBACK:${this.record.id}] WARNING: No outbound delivery path after ${timeoutMs}ms — audio will be lost. hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[PLAYBACK:${this.record.id}] Outbound delivery path ready: hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    }
  }

  private async playAudioChunk(audio: AudioPayload): Promise<void> {
    this.playAudioChunkCount += 1;
    const sid = this.record.id;

    // On the first chunk, wait for the bridge to register its listener.
    if (this.playAudioChunkCount === 1) {
      await this.waitForOutboundReady(500, this.record.loopAbortController?.signal ?? AbortSignal.abort());
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PLAYBACK:${sid}] playAudioChunk #${this.playAudioChunkCount}: encoding=${audio.encoding} sampleRate=${audio.sampleRateHz} bytes=${audio.data.byteLength} hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
    );
    // Account for the real-time duration handed to the transport so
    // `drainPlayback` can hold SPEAKING open until it has actually
    // played. Zero-byte chunks are stream-end markers, not audio.
    if (audio.data.byteLength > 0) {
      if (this.outboundPlaybackStartedAt === 0) {
        this.outboundPlaybackStartedAt = Date.now();
      }
      if (!this.markedAudioThisTurn) {
        this.markedAudioThisTurn = true;
        // First frame handed to the transport. The caller hears it one
        // bridge pre-roll later (~100ms on the Plivo/Vobiz pumps).
        this.markTiming("audio-queued");
      }
      this.outboundQueuedMs += estimateAudioSeconds(audio) * 1000;
    }

    if (this.record.mediaStream) {
      await this.record.mediaStream.sendAudio(audio);
    }
    for (const listener of this.record.outboundAudioListeners) {
      // A transport may return a promise to apply backpressure once its
      // outbound queue is full (see SessionRecord.outboundAudioListeners).
      // Awaiting it paces this loop to roughly real time, which is what
      // keeps the bridge's queue — and therefore the audio at risk of
      // being discarded on barge-in or socket close — bounded.
      // Bridges resolve pending waiters on barge-in/close, so this can
      // never outlive the utterance it belongs to.
      const pending = listener(audio);
      if (pending) {
        const parkedAt = Date.now();
        await pending;
        this.transportBackpressureMs += Date.now() - parkedAt;
      }
    }
  }
}

export { toSessionErrorInfo };