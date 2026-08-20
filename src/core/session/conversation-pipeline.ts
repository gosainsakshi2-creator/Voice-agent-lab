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
import { currentTurnNote, languageHintFor, openingLineFor } from "./system-prompt";
import { SentenceChunker } from "./sentence-chunker";
import { isBareAcknowledgement } from "./turn-detection";
import { combineSignals, abortableSleep } from "./abort-utils";
import { estimateAudioSeconds, withByteCounter } from "./audio-utils";
import { estimateLlmCost, estimateSttCost, estimateTtsCost, estimateTokenCount } from "./cost-estimator";
import { withGracefulRetry, RecoverableTurnError, toSessionErrorInfo } from "./error-recovery";
import { formatForSpeech } from "../../utils/speech-formatter";
import { pronounceForSpeech } from "../../utils/speech-pronunciation";

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
  /** How long the caller spoke. Context, NOT a latency — see benchmark.types.ts. */
  readonly userSpeechMs: number;
  /** STT recognition lag of the final segment that completed this turn. */
  readonly sttLagMs: number | undefined;
  /** Wall clock at which the caller's audio actually ended, back-dated by the recognition lag. */
  readonly userSpeechEndedAtMs: number | undefined;
  readonly sttCostUsd: number;
}

interface ThinkingAndSpeakingResult {
  readonly assistantText: string;
  /** LLM time-to-first-token. */
  readonly llmMs: number | undefined;
  /** Full generation span with TTS blocking time subtracted out. */
  readonly llmGenerationMs: number | undefined;
  readonly llmCostUsd: number;
  /** TTS time-to-first-audio-chunk for the first utterance of the turn. */
  readonly ttsMs: number | undefined;
  /** Total synthesis wall-clock across every sentence chunk of the turn. */
  readonly ttsSynthesisMs: number;
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
 * How much of its own reply the assistant must still have left to
 * speak before a bare acknowledgement counts as backchannel rather
 * than as an answer.
 *
 * This is the whole safety margin of the backchannel rule, so it is
 * set from the approved script rather than from taste. The
 * commitment question is the second-to-last line of its block —
 * "Would you be interested to attend?" is followed by "The
 * registration is completely FREE.", roughly two seconds of speech.
 * A caller answering that question therefore has at most ~2s of reply
 * left when their "haan" is recognised, and must be heard normally:
 * that answer is the registration.
 *
 * 4000ms is double that, so an answer at the gate is never absorbed,
 * while the long explanation blocks — where the queued reply runs many
 * seconds ahead of playback — are fully covered. A short reply (a
 * one-sentence answer to a question) never reaches this threshold at
 * all and so keeps exactly today's barge-in behaviour.
 *
 * Measured from the same span `drainPlayback` waits out, so "still
 * speaking" means here what it already means everywhere else.
 */
const BACKCHANNEL_MIN_REMAINING_SPEECH_MS = 4_000;

/**
 * Upper bound on a believable STT recognition lag, used only to
 * discard nonsense samples from the benchmark (see
 * `lastFinalSttLagMs`). Purely a metrics guard — it gates no
 * transcript, no turn and no audio.
 */
const MAX_PLAUSIBLE_STT_LAG_MS = 10_000;

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
  /**
   * True while the caller's CURRENT utterance has already been judged
   * backchannel. Keeps one utterance treated consistently: its interim
   * may be recognised with seconds of reply left and its final only
   * once the reply is nearly over, and half of an ignored "okay"
   * becoming a turn is the one outcome worse than either choice.
   * Cannot outlive the assistant's turn — every read of it is guarded
   * by `spokeOverTheAssistant`.
   */
  private backchannelInFlight = false;
  /**
   * False until the greeting has finished. The STT listener now runs
   * from call-connect (see `run()`), so this is what keeps the
   * greeting's own SPEAKING phase from being barge-in-able — exactly
   * the property deferring the listener used to provide.
   */
  private greetingDone = false;
  /**
   * ---------------- Assistant response lifecycle ----------------
   *
   * PENDING/SPEAKING -> COMPLETED -> committed to `memory`
   * PENDING/SPEAKING -> CANCELLED -> discarded, never committed
   *
   * `runThinkingAndSpeaking` returns NORMALLY on barge-in (the LLM
   * stream breaks, `drainPlayback` resolves early) and hands back
   * whatever text had accumulated — including the complete reply when
   * the model finished streaming while its audio was still queued on
   * the transport. Nothing in that result says "this was cut off", so
   * the commit site had no way to tell an interrupted reply from a
   * finished one and committed both.
   *
   * An id rather than a boolean flag: the cancellation is recorded
   * against the specific response that was in flight, so a stream that
   * produces its last chunk (or its `final` event) after the barge-in
   * handler has already run cannot commit itself, and — equally — a
   * barge-in that lands when no response is pending cannot cancel the
   * NEXT one, which takes a fresh id.
   */
  /** Id of the assistant response currently PENDING/SPEAKING. */
  private currentResponseId = 0;
  /** Id of the response a barge-in cancelled, if any. */
  private cancelledResponseId: number | undefined;
  /**
   * The part of the cancelled response the caller had ACTUALLY HEARD,
   * frozen at the instant of cancellation.
   *
   * A cancelled response is still not committed as if it had been
   * delivered — that design is unchanged and correct. But discarding
   * ALL of it, including the sentences the caller already listened to,
   * is what let the script restart: the model's history said it had
   * never spoken, so the next request regenerated the same block from
   * the top and the caller heard the introduction again.
   *
   * So the two halves of an interrupted reply are now separated. What
   * played is history (it happened, the caller heard it, and it is what
   * "continue from where you were" is relative to). What was still
   * queued, or never synthesized at all, is discarded exactly as
   * before. Computed inside `triggerExternalBargeIn` — the single
   * choke point every cancellation goes through — because playback
   * stops there, and reading the clock any later would count audio the
   * transport had already thrown away.
   */
  private cancelledHeardText = "";
  /**
   * ---------------- Metrics bookkeeping (read-only observers) ----------------
   * Everything below is written from points that already exist in the
   * flow and is read only by `recordTurn`. Nothing here feeds turn
   * detection, barge-in, STT, LLM, TTS or transport decisions.
   */
  /** Wall clock at which the most recent non-empty FINAL transcript segment arrived. */
  private lastFinalSegmentAtMs: number | undefined;
  /**
   * Recognition lag of that segment: `inboundStreamMs - segment.endedAtMs`.
   * Both operands are positions on the same audio-stream clock (the
   * barge-in check above already relies on that equivalence), so the
   * difference is how far behind the audio the transcript arrived.
   */
  private lastFinalSttLagMs: number | undefined;
  /** Wall clock at which this turn's FIRST audio frame reached the transport. */
  private firstAudioQueuedAtMs: number | undefined;

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

    // --- Start the continuous listener BEFORE the greeting ---
    //
    // The listener used to start after the greeting had finished
    // playing, to stop the greeting being barged in on by the caller's
    // "Hello?" as they pick up. That worked, but it made the FIRST user
    // turn pay three costs no later turn pays:
    //
    //   1. Deepgram's websocket handshake (connect + waitForOpen) sat
    //      directly on the first turn's critical path — the provider's
    //      `checkHealth` does no network I/O, so warm-up never opens it.
    //   2. Inbound audio has been accumulating in the session's
    //      unbounded `AsyncQueue` since call-connect (no telephony
    //      provider implements `openMediaStream`, so that is always the
    //      source). By greeting-end that is ~4.5s of audio, which then
    //      burst-replayed into the socket — leaving Deepgram several
    //      hundred ms behind the live edge for the whole first turn.
    //   3. The caller's first words were therefore transcribed late,
    //      which delayed the turn detector, the LLM and the reply.
    //
    // Starting here removes all three: the handshake completes while
    // the greeting is playing, and audio streams in real time from the
    // first frame, so there is no backlog to catch up on. The greeting
    // stays exactly as protected as before — `greetingDone` gates the
    // barge-in check below, which is the only thing that could have
    // interrupted it. Everything else (turn detection, the display
    // transcript, metrics) runs live, so anything the caller says
    // during the greeting is already recognized and waiting to become
    // their first turn instead of arriving in a post-greeting burst.
    if (this.usesStreamingStt && !loopSignal.aborted) {
      this.startContinuousStt(loopSignal);
    }

    // --- Greeting phase: a dedicated startup action, NOT a turn ---
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
        const greetingText = openingLineFor(this.record.memory.currentLanguage, this.record.voiceGender, this.record.campaignOpeningLine);
        timer.mark("greeting-text-ready");

        this.beginTurnTiming(timer);
        // Runs WHILE the greeting is being spoken, and is never awaited
        // — see `primeLlmPrefixCache`. It is started here rather than
        // after the greeting so the prefill overlaps greeting playback
        // instead of the caller's first reply.
        this.primeLlmPrefixCache(loopSignal);
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
    // Release the barge-in gate: from here on, everything — turn
    // detection, barge-in, contextual replies — behaves exactly as it
    // always has. The listener itself has been running since before
    // the greeting (see above), so nothing has to be caught up here.
    this.greetingDone = true;

    // --- Main loop ---
    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] entering main loop — state=${this.record.state} aborted=${loopSignal.aborted}`);

    while (!loopSignal.aborted) {
      try {
        if (this.record.state !== SessionState.LISTENING) {
          this.host.transition(this.record, SessionState.LISTENING, "awaiting user speech");
        }

        const turn = await this.acquireNextUserTurn(loopSignal);
        if (!turn || loopSignal.aborted) {
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] acquireNextUserTurn returned null or aborted — exiting loop`);
          break;
        }

        // eslint-disable-next-line no-console
        console.log(`[STT:${sid}] Transcript received: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? "..." : ""}" userSpeechMs=${turn.userSpeechMs} sttLagMs=${turn.sttLagMs ?? "n/a"}`);

        // t0 for this turn's latency trace: the turn detector has just
        // endpointed, i.e. the caller has stopped speaking as far as
        // the pipeline is concerned. Everything after this is ours.
        const timer = new TurnTimer(sid, `TURN#${this.record.turnIndex}`);
        timer.mark("turn-detected");
        // The trace above starts at turn RELEASE, so everything the
        // caller actually waited through before that — Deepgram's
        // endpointing window, its delivery lag, and the detector's
        // confirmation hold — was invisible in the logs while being a
        // real part of the "why is the reply 2-3s late" question. This
        // is that span, from the wall clock at which the caller stopped
        // talking (`userSpeechEndedAtMs`, already computed for the
        // end-to-end metric) to the release this trace begins at.
        // Diagnostic only: read by nothing, changes no timing.
        if (turn.userSpeechEndedAtMs !== undefined) {
          // eslint-disable-next-line no-console
          console.log(
            `[TIMING:${sid}] TURN#${this.record.turnIndex} stt-to-release=${Date.now() - turn.userSpeechEndedAtMs}ms (sttLag=${turn.sttLagMs ?? "n/a"}ms)`,
          );
        }
        this.beginTurnTiming(timer);

        const detected = detectLanguage(turn.text, this.record.memory.currentLanguage);
        this.record.memory.recordUserTurn(turn.text, detected.language);
        // The committed turn now carries this text — drop the
        // display-only preview so it is not rendered twice.
        this.record.liveUserTranscript = "";

        // The reply about to be generated is PENDING from here until it
        // either completes normally (committed below) or is cancelled by
        // a barge-in (discarded below). Taken BEFORE generation starts so
        // the id belongs to this response and no other.
        const responseId = this.beginAssistantResponse();
        const result = await this.runThinkingAndSpeaking(turn.text, detected, loopSignal);
        timer.summarize();
        this.activeTimer = undefined;
        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Turn complete: assistant="${result.assistantText.slice(0, 80)}${result.assistantText.length > 80 ? "..." : ""}" llmMs=${result.llmMs} ttsMs=${result.ttsMs}`);
        // An interrupted reply is CANCELLED, not a completed assistant
        // turn: the caller talked over it, so committing it would put a
        // sentence the caller never let us finish between their own two
        // utterances and feed it to the next LLM request as if it had
        // been a real exchange. Their words are not lost — the turn
        // detector holds the interrupting utterance (see
        // `AdaptiveTurnDetector.pendingEvent`) and it becomes the next
        // user turn on the following iteration, so the model sees the
        // caller's latest thought as the live conversational state.
        if (this.isResponseCancelled(responseId)) {
          // The part that PLAYED is what the caller heard, so it is
          // what the conversation actually contains — see
          // `cancelledHeardText`. Committing it is what makes "carry on
          // from where you left off" a statement about something the
          // model can see; committing nothing is what made the next
          // request start the block again. The unplayed remainder is
          // still discarded, so nothing the caller never heard is ever
          // put into the assistant's mouth.
          const heard = this.cancelledHeardText;
          // eslint-disable-next-line no-console
          console.log(
            `[PIPELINE:${sid}] Response #${responseId} CANCELLED by barge-in — heard="${heard.slice(0, 80)}${heard.length > 80 ? "..." : ""}" discarded="${result.assistantText.slice(heard.length, heard.length + 80)}${result.assistantText.length > heard.length + 80 ? "..." : ""}"`,
          );
          if (heard.length > 0) this.record.memory.recordAssistantTurn(heard);
        } else {
          this.record.memory.recordAssistantTurn(result.assistantText);
        }
        this.record.bargeIn.reset();

        // TRUE end-to-end response latency: the caller stopped talking
        // -> the first AI audio frame reached the transport. Both
        // endpoints are wall-clock stamps captured where those events
        // actually happen, so this is one measured span rather than a
        // sum of stages. It is deliberately NOT extended to cover the
        // rest of the reply — synthesis of later sentences, queue
        // drain and playback all happen while the caller is already
        // being spoken to, so none of it is latency they wait on.
        // Absent when the turn produced no audio at all (e.g. an
        // immediate barge-in), which reports as N/A rather than 0.
        const totalMs =
          turn.userSpeechEndedAtMs !== undefined && this.firstAudioQueuedAtMs !== undefined
            ? this.firstAudioQueuedAtMs - turn.userSpeechEndedAtMs
            : undefined;

        this.record.metrics.recordTurn({
          turnIndex: this.record.turnIndex++,
          sttMs: turn.sttLagMs,
          llmMs: result.llmMs,
          ttsMs: result.ttsMs,
          totalMs,
          llmGenerationMs: result.llmGenerationMs,
          ttsSynthesisMs: result.ttsSynthesisMs,
          userSpeechMs: turn.userSpeechMs,
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
    this.firstAudioQueuedAtMs = undefined;
  }

  /**
   * Sends the system prompt to the LLM once, while the greeting is
   * still playing, so the caller's FIRST reply is answered from the
   * provider's prompt-prefix cache instead of a cold prefill.
   *
   * WHY THE SECOND RESPONSE IS THE SLOW ONE. The greeting is fixed text
   * and deliberately makes no LLM request (see the greeting block
   * above), so the reply to the caller's first "Yes." is this call's
   * FIRST LLM request — and it is the one request that cannot hit the
   * prefix cache. Measured against the live prompt stack on gpt-5.1
   * (12,411 prompt tokens, `verbosity: "low"`, 0 reasoning tokens):
   *
   *   cold  `cached_tokens: 0`      first visible token 2726ms
   *   warm  `cached_tokens: 12288`  first visible token 1326ms
   *
   * Turn detection for a short endpointed "Yes." already releases in
   * ~300ms and TTS is warm from the greeting, so that ~1.4s prefill is
   * the bottleneck on this exact transition, and it is the only turn
   * that pays it.
   *
   * COSTS NOTHING IT DOES NOT ALREADY COST. The prefill happens once
   * per call either way — this only moves it off the caller's clock and
   * onto greeting playback. The stream is abandoned at its first event,
   * so it generates no reply.
   *
   * TOUCHES NOTHING. Not awaited, so no path waits on it; sends only
   * the system turn, so it cannot alter what the model is later told;
   * writes nothing to `memory`, records no metrics, and swallows every
   * error — a provider that refuses this leaves the call exactly as it
   * behaves today.
   */
  private primeLlmPrefixCache(loopSignal: AbortSignal): void {
    const generate = this.providers.llm.generateCompletionStream;
    if (!generate) return;
    // The shared prefix of every later request, and nothing else.
    const prefix = this.record.memory.recentHistory().filter(turn => turn.role === "system");
    if (prefix.length === 0) return;

    void (async () => {
      const abort = new AbortController();
      const signal = combineSignals([abort.signal, loopSignal]);
      try {
        const stream = generate.call(
          this.providers.llm,
          { sessionId: this.record.id, history: prefix },
          signal,
        );
        if (!stream) return;
        // The prefill — the part being cached — is complete before the
        // first event can arrive, so there is nothing to gain by
        // reading further.
        for await (const _event of stream) {
          void _event;
          break;
        }
      } catch {
        // A cold cache is the current behaviour, not a failure.
      } finally {
        abort.abort();
      }
    })();
  }

  /**
   * Real-time ms of already-synthesized reply audio the transport has
   * been handed but has not played yet — the same span `drainPlayback`
   * waits out before leaving SPEAKING. `0` when nothing is playing.
   */
  private remainingSpeechMs(): number {
    if (this.outboundPlaybackStartedAt === 0 || this.outboundQueuedMs <= 0) return 0;
    return this.outboundQueuedMs - (Date.now() - this.outboundPlaybackStartedAt);
  }

  /**
   * The part of the reply currently being spoken that the transport has
   * already PLAYED — i.e. what the caller has actually heard.
   *
   * Every utterance handed to `synthesizeAndPlay` is recorded with the
   * playback offset it starts at (`spokenUtterances`), and playback
   * runs in real time from `outboundPlaybackStartedAt`, so an utterance
   * whose start offset is behind the play head has been heard. The one
   * still playing when this is read counts as heard: the caller is
   * listening to it, and the alternative — dropping it — is the
   * repetition this exists to prevent.
   *
   * Read-only over counters that already exist for `drainPlayback` and
   * `remainingSpeechMs`. Nothing here changes what is synthesized,
   * queued, played or cancelled.
   */
  private heardSoFarText(): string {
    if (this.outboundPlaybackStartedAt === 0 || this.spokenUtterances.length === 0) return "";
    const playedMs = Date.now() - this.outboundPlaybackStartedAt;
    return this.spokenUtterances
      .filter((utterance) => utterance.startsAtMs < playedMs)
      .map((utterance) => utterance.text)
      .join(" ")
      .trim();
  }

  /**
   * Has the caller already finished saying something NEWER than the
   * turn this reply is answering?
   *
   * True only when the turn detector is holding a fully endpointed turn
   * for the next subscriber (`hasBufferedTurn`), which means the caller
   * spoke, stopped, and their words passed every release guard while we
   * were still preparing a reply to what they said before that. Read
   * only at the two points below, and only while nothing has been
   * spoken yet.
   */
  private newerUserTurnWaiting(): boolean {
    return this.record.turnDetector.hasBufferedTurn();
  }

  /**
   * Is this segment the caller acknowledging, rather than taking a
   * turn? Only ever asked while the assistant is speaking.
   *
   * Judged on the WHOLE pending utterance — the finals the turn
   * detector already holds plus this segment — so a turn that started
   * with real content is never mistaken for an acknowledgement.
   */
  private isBackchannel(segment: TranscriptSegment): boolean {
    const pending = this.record.turnDetector.getPendingTurnText();
    const utterance = pending.length > 0 ? `${pending} ${segment.text}` : segment.text;
    if (!isBareAcknowledgement(utterance)) return false;
    return (
      this.backchannelInFlight ||
      this.remainingSpeechMs() > BACKCHANNEL_MIN_REMAINING_SPEECH_MS
    );
  }

  /** Records a stage on the in-flight turn's trace, if one is active. */
  private markTiming(stage: string): void {
    this.activeTimer?.mark(stage);
  }

  /**
   * Marks a new assistant response as PENDING and returns its id. The
   * id is what the commit site checks against `cancelledResponseId`.
   */
  private beginAssistantResponse(): number {
    this.currentResponseId += 1;
    // Whatever the PREVIOUS reply spoke belongs to the previous reply.
    // Cleared here, at the response boundary, and not only in
    // `resetPlaybackAccounting`: a reply cancelled before it ever
    // entered SPEAKING never calls that, and would otherwise be
    // credited with the utterances of the reply before it — which is
    // the last reply's text being committed a second time.
    this.spokenUtterances = [];
    this.cancelledHeardText = "";
    return this.currentResponseId;
  }

  /** True if `responseId` was cancelled by a barge-in while in flight. */
  private isResponseCancelled(responseId: number): boolean {
    return this.cancelledResponseId === responseId;
  }

  /** Externally-triggered barge-in (e.g. from a future real-time transport, or a test harness). */
  triggerExternalBargeIn(): void {
    // Recorded FIRST, before anything can observe the aborts below:
    // whichever response is in flight is now CANCELLED and stays
    // cancelled, so a chunk or `final` event that arrives after this
    // handler has run cannot commit it. Marking the id of an already
    // committed response (a barge-in signalled with nothing pending) is
    // harmless — the next response takes a fresh id.
    this.cancelledResponseId = this.currentResponseId;
    // Frozen HERE, before the aborts below stop the transport: this is
    // the last instant at which "how much of the reply has played" is
    // still a true statement about what the caller heard. Read by the
    // commit site in the main loop — see `cancelledHeardText`.
    this.cancelledHeardText = this.heardSoFarText();
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
          // DISPLAY ONLY: surface what the caller is saying as soon
          // as Deepgram reports it (interim segments included) so the
          // Dashboard transcript no longer lags turn-end. Nothing
          // downstream reads this — turn detection, barge-in and the
          // LLM continue to work off `segment` / the turn detector
          // exactly as before.
          if (segment.text.trim().length > 0) {
            // The caller is audibly speaking right now. Stamped here
            // because this is the earliest point the pipeline knows
            // that — before any state transition — so the campaign
            // silence watchdog cannot mistake a caller mid-utterance
            // for a silent line.
            this.record.lastConversationActivityAt = Date.now();
            // Prefix the finals already accumulated for this turn. A
            // Deepgram interim/final is only the tail since the last
            // final, so without this the preview snaps back to the
            // latest fragment ("50,000 rupees") halfway through an
            // utterance the detector is correctly still buffering.
            // Still one field, so still one bubble — display only.
            const buffered = this.record.turnDetector.getPendingTurnText();
            this.record.liveUserTranscript =
              buffered.length > 0 ? `${buffered} ${segment.text}`.trim() : segment.text;
          }

          // METRICS ONLY — pure observation, no control flow. Records
          // when this final landed and how far behind the audio it
          // was, so `recordTurn` can report real recognition latency
          // instead of the caller's speaking duration.
          if (segment.isFinal && segment.text.trim().length > 0) {
            this.lastFinalSegmentAtMs = Date.now();
            const lagMs = this.inboundStreamMs - segment.endedAtMs;
            // Bounded: during the initial replay of audio buffered
            // while the greeting played, the stream clock advances far
            // faster than real time and a segment landing inside that
            // burst yields a meaningless span.
            if (Number.isFinite(lagMs) && lagMs >= 0 && lagMs <= MAX_PLAUSIBLE_STT_LAG_MS) {
              this.lastFinalSttLagMs = lagMs;
            }
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
          //
          // `greetingDone` keeps that guarantee now that the listener
          // starts before the greeting rather than after it: until the
          // greeting has finished, no segment can trigger a barge-in,
          // which is precisely the protection deferring the listener
          // used to provide. The segment is still fed to the turn
          // detector below, so the words are not lost.
          const spokeOverTheAssistant =
            this.greetingDone &&
            this.record.state === SessionState.SPEAKING &&
            segment.endedAtMs > this.speakingStartedAtStreamMs;

          // ── Backchannel, not barge-in ─────────────────────────────
          //
          // "Ok." / "haan" / "hmm" said while the assistant is still
          // several seconds into its own reply is the caller showing
          // they are listening, not asking it to stop. Treating it as
          // an interruption is what produced the reported "the agent
          // stops and repeats the explanation" behaviour, and the
          // mechanism is not the prompt:
          //
          //   1. barge-in aborts the LLM/TTS stream mid-paragraph;
          //   2. an interrupted reply is CANCELLED, so it is never
          //      committed to `memory` (see the commit site in the main
          //      loop) — the model's history says it never spoke;
          //   3. the next request therefore generates the SAME block
          //      again from the top, and the caller hears the pitch
          //      restart. `conversation-policy.ts` cannot prevent that:
          //      "never repeat a line they have already heard" is
          //      unactionable when history shows the line was never
          //      said.
          //
          // So an acknowledgement here does nothing at all: no
          // interruption, and it is not fed to the turn detector, so it
          // creates no turn and the assistant simply finishes its
          // sentence — which also means the reply IS committed, and the
          // commitment question inside it stays in the transcript the
          // FINAL_YES gate reads.
          //
          // The whole utterance is tested, not just this segment, so
          // "ok, but what's the price?" is not an acknowledgement and
          // interrupts exactly as it does today. Deepgram's interims
          // accumulate until its next final, so the "ok" is still part
          // of the turn when the caller carries on.
          if (spokeOverTheAssistant && this.isBackchannel(segment)) {
            // Deepgram finalising the utterance ends it; until then the
            // same utterance keeps being treated as backchannel even if
            // the reply is nearly finished by the time its final lands.
            this.backchannelInFlight = !segment.isFinal;
            // Display-only preview. Cleared because no turn will
            // replace it, and `getTranscript` appends it as a trailing
            // user turn — a stale one would sit after the assistant's
            // last turn and block the final-answer hangup check, which
            // requires the assistant to have spoken last.
            this.record.liveUserTranscript = "";
            // eslint-disable-next-line no-console
            console.log(
              `[TURN:${this.record.id}] backchannel ignored (not a barge-in): "${segment.text.trim()}" — ${Math.round(this.remainingSpeechMs())}ms of reply still to play`,
            );
            continue;
          }
          this.backchannelInFlight = false;

          if (spokeOverTheAssistant) {
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

        // Snapshot the metrics observers for THIS turn before the next
        // one starts overwriting them. `userSpeechEndedAtMs` back-dates
        // the last final's arrival by its own recognition lag, giving
        // the wall clock at which the caller actually stopped talking —
        // the t0 the end-to-end latency is measured from.
        const sttLagMs = this.lastFinalSttLagMs;
        const lastSegmentAtMs = this.lastFinalSegmentAtMs;
        const userSpeechEndedAtMs =
          lastSegmentAtMs !== undefined ? lastSegmentAtMs - (sttLagMs ?? 0) : undefined;
        this.lastFinalSttLagMs = undefined;
        this.lastFinalSegmentAtMs = undefined;

        finish({
          text: event.text,
          userSpeechMs: event.turnDurationMs,
          sttLagMs,
          userSpeechEndedAtMs,
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

      // A batch `transcribe()` exposes no per-segment stream
      // timestamps, so recognition lag and end-of-speech are genuinely
      // unmeasurable here — reported as absent rather than as 0.
      return {
        text,
        userSpeechMs: 0,
        sttLagMs: undefined,
        userSpeechEndedAtMs: undefined,
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
   *   2. The language hint and the current-turn marker are folded into
   *      the latest user message, never added as separate system turns
   *      (doing so caused
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

          // Marked as well as language-hinted. History has no "this one
          // is now" signal of its own, and a barge-in leaves two user
          // turns in a row with no assistant turn between them (the
          // interrupted reply is never committed) — which is exactly
          // when a reply comes back continuing the previous topic
          // instead of answering what was just asked.
          turn.content = `${currentTurnNote()}\n${hint}\n${turn.content}`;

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

    const spoken = await this.synthesizeAndPlay(toSpokenText(text), speakingSignal);
    // The greeting is a startup action, not a turn, so it is correctly
    // absent from `turnLatencies` — but it still consumes real TTS
    // characters, and that cost used to be dropped on the floor.
    this.record.metrics.recordAuxiliaryCost({ textToSpeech: spoken.ttsCostUsd });
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

    // Cost basis: the tokens ACTUALLY sent — system prompt and recent
    // history included — not just the latest user utterance, which is
    // what was previously counted and is why multi-turn calls were
    // undercounted by roughly an order of magnitude.
    const promptTokens = request.history.reduce(
      (sum, turn) => sum + estimateTokenCount(turn.content),
      0,
    );

    if (this.providers.llm.generateCompletionStream) {
      return this.runStreamingCompletion(request, thinkingSignal, loopSignal, promptTokens, llmProviderId);
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

const { ttsMs, ttsCostUsd, firstChunkMs } =
  await this.synthesizeAndPlay(spokenContent, speakingSignal);

// Streaming TTS only enqueues; hold SPEAKING until playback drains.
// (The batch-TTS branch already sleeps for its own playback and will
// simply find nothing left to wait for here.)
await this.drainPlayback(speakingSignal);

      // A non-streaming provider emits nothing until generation is
      // complete, so time-to-first-token and full generation time are
      // necessarily the same measurement. Neither is contaminated by
      // TTS here: `generateCompletion` is a single await with no
      // synthesis interleaved inside it.
      return {
        assistantText: spokenContent,
        llmMs,
        llmGenerationMs: llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(spokenContent)),
        ttsMs: firstChunkMs,
        ttsSynthesisMs: ttsMs,
        ttsCostUsd,
      };
    });
  }

  private async runStreamingCompletion(
    request: CompletionRequest,
    thinkingSignal: AbortSignal,
    loopSignal: AbortSignal,
    promptTokens: number,
    llmProviderId: string,
  ): Promise<ThinkingAndSpeakingResult> {
    const chunker = new SentenceChunker();
    let fullText = "";
    let finalText: string | undefined;
    let ttsSynthesisMs = 0;
    let ttsCostUsd = 0;
    let speakingSignal: AbortSignal | undefined;
    // --- Metrics accumulators (no effect on generation or playback) ---
    /** Request -> first token. The only LLM figure TTS cannot contaminate. */
    let llmFirstTokenMs: number | undefined;
    /** Time-to-first-audio of the FIRST utterance spoken this turn. */
    let ttsFirstChunkMs: number | undefined;
    /**
     * Wall clock spent inside `synthesizeAndPlay` while the LLM stream
     * was still open. The provider's generator is suspended at its
     * `yield` for exactly this long, so its own `latencyMs` silently
     * includes it — subtracting it back out is what makes
     * `llmGenerationMs` a real generation measurement.
     */
    let ttsBlockedDuringStreamMs = 0;
    /** Wall clock at which the LLM stream finished producing. */
    let llmStreamEndedAtMs: number | undefined;
    // Set once contamination is detected mid-stream: stops speaking any
    // further sentences from this turn. See the contamination check
    // below for why this exists — the batch path's isContaminatedOutput
    // + retry safety net never runs for a streaming provider, and both
    // configured LLM providers (GPT-5.1, Gemma) implement streaming.
    let contaminated = false;
    /**
     * Set when the caller's newer turn cancelled this reply before a
     * word of it was spoken. Only used to keep the two checks below
     * from cancelling — and logging — the same reply twice.
     */
    let superseded = false;
    const startedAt = Date.now();

    try {
      const stream = this.providers.llm.generateCompletionStream?.(request, thinkingSignal);
      if (!stream) throw new Error("generateCompletionStream unexpectedly unavailable");

      for await (const event of stream) {
        if (thinkingSignal.aborted) break;

        if (event.type === "token") {
          if (fullText.length === 0) {
            llmFirstTokenMs ??= Date.now() - startedAt;
            this.markTiming("llm-first-token");
          }
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

            // ── Superseded, not interrupted ───────────────────────
            //
            // Nothing of this reply has been spoken yet
            // (`speakingSignal` is still unset), and the caller has
            // ALREADY finished saying something newer — a correction, a
            // clarification, a different question. Speaking this now
            // answers a question they have moved on from, and then
            // makes them wait through it before their real one is
            // answered. That is the stale-backlog behaviour: old
            // question, old answer, new question, new answer.
            //
            // So the reply is cancelled through the SAME path a
            // barge-in takes — the caller's newer turn wins, this
            // response is never committed, and the buffered turn (the
            // turn detector merges consecutive ones, so a correction
            // and the thought it corrects arrive together) is picked up
            // as the next turn on the following iteration. One current
            // response instead of a queue of stale ones.
            //
            // Deliberately only BEFORE the first sentence. Once audio
            // is playing, the caller talking is a barge-in and is
            // handled exactly as it is today; nothing about that path
            // changes. And the loop cannot stall: a buffered turn is
            // delivered to the next subscriber immediately, so every
            // supersession is followed by a real turn.
            if (speakingSignal === undefined && this.newerUserTurnWaiting()) {
              // eslint-disable-next-line no-console
              console.log(
                `[PIPELINE:${this.record.id}] reply SUPERSEDED before it was spoken — the caller has already said something newer`,
              );
              superseded = true;
              this.triggerExternalBargeIn();
              break;
            }

            speakingSignal ??= this.enterSpeaking();
            if (speakingSignal.aborted) break;
            const synthesisStartedAt = Date.now();
            const spoken = await this.synthesizeAndPlay(cleaned, speakingSignal);
            ttsBlockedDuringStreamMs += Date.now() - synthesisStartedAt;
            ttsFirstChunkMs ??= spoken.firstChunkMs;
            ttsSynthesisMs += spoken.ttsMs;
            ttsCostUsd += spoken.ttsCostUsd;
          }
        } else {
          finalText = event.turn.content;
          llmStreamEndedAtMs = Date.now();
        }

        if (contaminated || speakingSignal?.aborted) break;
      }
    } catch {
      // Streaming LLM connection dropped mid-reply — speak whatever
      // was generated so far rather than losing the turn entirely.
    }

    // The stream may end without a final event (abort, dropped
    // connection); fall back to "now" so generation time is still
    // bounded by something real.
    llmStreamEndedAtMs ??= Date.now();
    const llmGenerationMs = Math.max(
      0,
      llmStreamEndedAtMs - startedAt - ttsBlockedDuringStreamMs,
    );

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
          ttsFirstChunkMs ??= spoken.firstChunkMs;
          ttsSynthesisMs += spoken.ttsMs;
          ttsCostUsd += spoken.ttsCostUsd;
        }
      }
      // Stay in SPEAKING until the queued audio has actually played.
      // The TTS metrics are already fixed above, so the drain never
      // leaks into them.
      if (speakingSignal) await this.drainPlayback(speakingSignal);
      return {
        assistantText: fallback,
        llmMs: llmFirstTokenMs,
        llmGenerationMs,
        llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(fallback)),
        ttsMs: ttsFirstChunkMs,
        ttsSynthesisMs,
        ttsCostUsd,
      };
    }

    const rawRemainder = chunker.flush();
    const remainder = rawRemainder ? toSpokenText(rawRemainder) : "";
    // The same supersession test, for the reply that never reached a
    // sentence cut and so arrives here whole. Same two conditions:
    // nothing spoken yet, and the caller has already moved on.
    if (superseded) {
      // Already cancelled above; the remainder belongs to the reply the
      // caller has moved on from, so none of it is spoken.
    } else if (remainder.length > 0 && speakingSignal === undefined && this.newerUserTurnWaiting()) {
      // eslint-disable-next-line no-console
      console.log(
        `[PIPELINE:${this.record.id}] reply SUPERSEDED before it was spoken — the caller has already said something newer`,
      );
      this.triggerExternalBargeIn();
    } else if (remainder.length > 0 && !(speakingSignal?.aborted ?? false)) {
      speakingSignal ??= this.enterSpeaking();
      if (!speakingSignal.aborted) {
        const spoken = await this.synthesizeAndPlay(remainder, speakingSignal);
        ttsFirstChunkMs ??= spoken.firstChunkMs;
        ttsSynthesisMs += spoken.ttsMs;
        ttsCostUsd += spoken.ttsCostUsd;
      }
    }

    // Hold SPEAKING open for the audio still queued on the transport.
    // Aborts instantly on barge-in; the TTS metrics were accumulated
    // from generation time only, so they are unaffected.
    if (speakingSignal) await this.drainPlayback(speakingSignal);

    const assistantText = toSpokenText(finalText ?? fullText);

    // If nothing was ever spoken (e.g. immediate barge-in), still
    // make sure we transitioned through SPEAKING at least nominally
    // isn't required — LISTENING is re-entered naturally by the
    // caller's next loop iteration either way.
    void loopSignal;

    return {
      assistantText,
      llmMs: llmFirstTokenMs,
      llmGenerationMs,
      llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(assistantText)),
      ttsMs: ttsFirstChunkMs,
      ttsSynthesisMs,
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
  /**
   * Every utterance handed to the transport this speaking phase, with
   * the playback offset (ms into this phase's audio) at which it
   * starts — i.e. `outboundQueuedMs` as it stood before the utterance
   * was queued. Read only by `heardSoFarText`, to tell the part of an
   * interrupted reply the caller heard from the part they did not.
   */
  private spokenUtterances: Array<{ readonly text: string; readonly startsAtMs: number }> = [];

  private resetPlaybackAccounting(): void {
    this.outboundQueuedMs = 0;
    this.outboundPlaybackStartedAt = 0;
    // Belongs to one reply, like the two counters above it.
    this.spokenUtterances = [];
    // Called at exactly the two places the session enters SPEAKING, so
    // this is the stream-clock mark the barge-in check above compares
    // incoming transcript segments against.
    this.speakingStartedAtStreamMs = this.inboundStreamMs;
    // A backchannel judgement belongs to one utterance during one
    // reply. If Deepgram never sent the final that would have closed it
    // (a dropped socket mid-"okay"), it must not carry into the next
    // reply and absorb the first acknowledgement heard there.
    this.backchannelInFlight = false;
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

  private async synthesizeAndPlay(
    text: string,
    speakingSignal: AbortSignal,
  ): Promise<{ ttsMs: number; ttsCostUsd: number; firstChunkMs?: number }> {
    const sid = this.record.id;
    if (speakingSignal.aborted || text.trim().length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] synthesizeAndPlay skipped (aborted=${speakingSignal.aborted} emptyText=${text.trim().length === 0})`);
      return { ttsMs: 0, ttsCostUsd: 0 };
    }

    // The text of this utterance, against the playback offset it starts
    // at. Recorded before synthesis so it is recorded whether or not
    // the provider, the transport or the caller cuts it short —
    // `heardSoFarText` decides what of it was heard from the play head,
    // not from whether this call returned. The original wording is
    // stored, NOT the `pronounceForSpeech` rewrite below: history, the
    // classifier and the sheet all read approved wording.
    this.spokenUtterances.push({ text, startsAtMs: this.outboundQueuedMs });

    const ttsProviderId = this.providers.tts.descriptor.id;
    const language = this.record.memory.currentLanguage;
    const task: SynthesisTaskRequest = {
      sessionId: this.record.id,
      // Numeric notation ("7:30 PM", "₹1,50,000+") is read aloud
      // differently in English than in Hindi/Hinglish, and every TTS
      // vendor mangles it the same way. Rewriting it HERE, on the way
      // into `synthesize`, is what keeps that fix identical across
      // Cartesia, Smallest AI, Sarvam and ElevenLabs while leaving the
      // transcript, the classifier and the sheet reading the original
      // approved wording.
      request: { text: pronounceForSpeech(text, language), language },
    };
    const startedAt = Date.now();

    if (this.providers.tts.synthesizeStream) {
      let chunkCount = 0;
      // Synthesis time-to-first-chunk for THIS utterance. Independent
      // of `markedTtsThisTurn`, which fires once per turn and so
      // cannot measure the second and later sentences.
      let firstChunkMs: number | undefined;
      this.transportBackpressureMs = 0;
      try {
       for await (const chunk of this.providers.tts.synthesizeStream(task, speakingSignal)) {
   if (chunkCount === 0) {
    firstChunkMs = Date.now() - startedAt;
    if (!this.markedTtsThisTurn) {
      this.markedTtsThisTurn = true;
      this.markTiming("tts-first-chunk");
    }
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
      // Charged once for this utterance's text, not per chunk. No
      // generated duration is passed: ElevenLabs is the only provider
      // with `synthesizeStream`, and it bills per character. Should a
      // duration-billed vendor ever gain a streaming path, this is the
      // call site that must supply its generated audio duration —
      // `estimateTtsCost` warns rather than silently mispricing.
      return {
        ttsMs,
        ttsCostUsd: estimateTtsCost(ttsProviderId, text.length),
        ...(firstChunkMs !== undefined ? { firstChunkMs } : {}),
      };
    }

    return withGracefulRetry("TEXT_TO_SPEECH", async () => {
      const audio = await this.providers.tts.synthesize(task);
      const ttsCallMs = Date.now() - startedAt;
      await this.playAudioChunk(audio);

      // ── Do NOT wait out this clip's playback here ──────────────────
      //
      // This branch runs for every TTS provider that exposes only
      // `synthesize()` — Cartesia, Sarvam and Smallest AI. ElevenLabs
      // is the sole provider with `synthesizeStream`, so it takes the
      // streaming branch above, which enqueues and returns immediately.
      // That difference was the entire dead-air problem:
      //
      //   `runStreamingCompletion` awaits `synthesizeAndPlay` once per
      //   sentence chunk. `playAudioChunk` has already handed the whole
      //   clip to the transport and parked on the bridge's outbound
      //   backpressure until the queue drained back to its low-water
      //   mark (~0.8s still buffered). Sleeping the FULL clip duration
      //   on top of that waited for the same audio a second time, so
      //   the pump ran dry — and only then did the next sentence's
      //   synthesis round trip start, with nothing queued to cover it.
      //   Measured silence per chunk boundary: (clipDuration - 0.8s) +
      //   the next request's latency, i.e. the reported 1-3s pauses,
      //   landing on exactly the `.`/`,` boundaries the chunker cuts at.
      //
      // Dropping the sleep makes this branch behave like the streaming
      // one: the next sentence is synthesized while the current one is
      // still playing out of the transport queue, so the queue stays
      // fed across the boundary. Nothing is lost — SPEAKING is still
      // held open for queued-but-unplayed audio by `drainPlayback`,
      // which accounts for it from `outboundQueuedMs` (incremented in
      // `playAudioChunk` whether or not a transport is attached) and
      // aborts instantly on barge-in.
      const playbackMs = estimateAudioSeconds(audio) * 1000;
      if (speakingSignal.aborted) {
        await this.record.mediaStream?.interruptPlayback();
      }

      // Batch synthesis returns the whole utterance in one piece, so
      // first-audio and full-synthesis are the same measurement.
      //
      // Both billing units are handed over and the provider's own rate
      // table picks the one it actually bills in: characters for Sarvam
      // and Smallest AI, generated audio minutes for Cartesia. The
      // duration is `playbackMs` — the length of the synthesized audio
      // — NOT `ttsCallMs`, which is synthesis latency.
      return {
        ttsMs: ttsCallMs,
        ttsCostUsd: estimateTtsCost(ttsProviderId, text.length, playbackMs / 1000),
        firstChunkMs: ttsCallMs,
      };
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

    // On the first chunk, wait for the bridge to register its listener.
    if (this.playAudioChunkCount === 1) {
      await this.waitForOutboundReady(500, this.record.loopAbortController?.signal ?? AbortSignal.abort());
    }

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
        // This is the t1 of the end-to-end latency metric — the same
        // instant the `audio-queued` trace has always logged, now also
        // retained as a number instead of only reaching the console.
        this.firstAudioQueuedAtMs = Date.now();
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