/**
 * metrics-collector.ts
 *
 * Accumulates the latency and cost measurements the
 * VoiceSessionManager is required to expose via
 * `getBenchmarkMetrics` — per-stage (STT/LLM/TTS) latency per turn,
 * end-to-end per-turn latency, call duration, and estimated cost —
 * without owning any timing logic itself (the pipeline measures;
 * this class only aggregates and shapes the result).
 *
 * Two rules this class enforces on behalf of every consumer:
 *
 *   1. Call duration is measured from the TELEPHONY-CONFIRMED ANSWER
 *      (`markCallAnswered`), never from construction. Construction
 *      happens at `createSession`, i.e. before provider warm-up,
 *      before the outbound REST call, and before the phone has even
 *      started ringing — using it as the origin inflated every call
 *      by the whole dial-and-ring period.
 *
 *   2. A measurement that does not exist is `undefined`, never 0.
 *      Zero is a legitimate latency value and would be averaged in as
 *      one; "not measured" must survive all the way to the UI so it
 *      can render N/A.
 */

import type {
  BenchmarkMetrics,
  CallDurationMetric,
  EstimatedCostMetric,
  LatencyMeasurementMs,
  TurnLatencyBreakdown,
} from "../../types/benchmark.types";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";
import { estimateTelephonyCost } from "./cost-estimator";

export interface TurnLatencyInput {
  readonly turnIndex: number;
  /** STT recognition lag, or `undefined` if the provider exposed no usable timestamps. */
  readonly sttMs: number | undefined;
  /** LLM time-to-first-token. */
  readonly llmMs: number | undefined;
  /** TTS time-to-first-audio-chunk. */
  readonly ttsMs: number | undefined;
  /** Measured end-of-speech -> first-audio-on-the-wire span. */
  readonly totalMs: number | undefined;
  readonly llmGenerationMs: number | undefined;
  readonly ttsSynthesisMs: number | undefined;
  readonly userSpeechMs: number | undefined;
  // PHASE 3 BATCH 1. OPTIONAL (`?:`), not merely nullable, and that is
  // deliberate: every field above is required-but-nullable, so adding
  // these as required would break every existing construction site of
  // this type — including tests that must not be edited to accommodate
  // a telemetry addition. Omitting them is identical to passing
  // `undefined`: both report "not measured".
  /** Endpoint claim observed -> turn released. `undefined` when the turn was released by inference. */
  readonly endpointToReleaseMs?: number | undefined;
  /** Caller's audio ended -> turn released. */
  readonly speechEndToReleaseMs?: number | undefined;
  /** First frame queued on the transport -> first frame the bridge actually sent. */
  readonly playbackStartupMs?: number | undefined;
  // PHASE 3 BATCH 3 — ABSOLUTE wall-clock observations, not durations.
  // Optional for the same backward-compatibility reason every batch
  // before them is: existing construction sites omit them, and omitting
  // is identical to "not observed". See `TurnLatencyBreakdown`.
  /** Wall clock of the most recent caller audio chunk received. */
  readonly lastInboundAudioAtMs?: number | undefined;
  /** Wall clock of the latest non-empty INTERIM transcript for this turn. */
  readonly lastInterimTranscriptAtMs?: number | undefined;
  /** Wall clock of the latest non-empty FINAL transcript for this turn. */
  readonly lastFinalTranscriptAtMs?: number | undefined;
  /** Wall clock at which this turn's endpoint evidence arrived. */
  readonly endpointEvidenceAtMs?: number | undefined;
  /** WHICH endpoint claim it was, preserved verbatim from the pipeline. */
  readonly endpointEvidenceKind?: "speech_final" | "utterance_end" | undefined;
  // PHASE 3 BATCH 4 — the audio-bytes clock read at the same event
  // `lastFinalTranscriptAtMs` reads the wall clock at. Measurement
  // validation only; see `TurnLatencyBreakdown`.
  /** `inboundStreamMs` at final-transcript arrival. A counter, so 0 is meaningful. */
  readonly inboundStreamMsAtFinalTranscript?: number | undefined;
  readonly sttCostUsd: number;
  readonly llmCostUsd: number;
  readonly ttsCostUsd: number;
  /** OpenAI-reported prompt tokens for this turn's LLM request, when the provider exposed them. */
  readonly promptTokens: number | undefined;
  /** Of `promptTokens`, how many were served from the prompt-prefix cache. */
  readonly cachedPromptTokens: number | undefined;
  /** Reasoning tokens generated before the first visible content token. */
  readonly reasoningTokens: number | undefined;
  // PHASE 3 BATCH 2A — optional for the same backward-compatibility
  // reason the Batch 1 boundaries are: existing construction sites
  // omit them, and omitting is identical to "not measured".
  /** HTTP attempts the SDK made for this turn's LLM request. */
  readonly llmAttempts?: number | undefined;
  /** Attempts beyond the first. */
  readonly llmRetries?: number | undefined;
  /** Measured wall clock spent on failed attempts plus backoff sleeps. */
  readonly llmRetryOverheadMs?: number | undefined;
  /** Compact non-sensitive retry reasons. */
  readonly llmRetryReasons?: string | undefined;
}

/**
 * Cost incurred outside a recorded conversational turn — currently
 * the greeting, which is a startup action rather than a turn and
 * whose synthesis cost was previously discarded.
 */
export interface AuxiliaryCostInput {
  readonly speechToText?: number;
  readonly languageModel?: number;
  readonly textToSpeech?: number;
}

/** Rejects non-finite and negative spans so a clock glitch can't enter the averages. */
function measurementOf(
  milliseconds: number | undefined,
  measuredAt: Date,
): LatencyMeasurementMs | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  return { milliseconds, measuredAt };
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export class SessionMetricsCollector {
  private readonly turnLatencies: TurnLatencyBreakdown[] = [];
  private readonly costTotals = { speechToText: 0, languageModel: 0, textToSpeech: 0 };
  /** Session construction. Diagnostic only — never the call-duration origin. */
  private readonly createdAt = new Date();
  private answeredAt: Date | undefined;
  private endedAt: Date | undefined;
  /** First outbound audio frame of the call, reported by the media bridge. */
  private firstOutboundAudioAt: Date | undefined;

  constructor(
    private readonly sessionId: SessionId,
    private readonly providerStack: ProviderStackSelection,
  ) {}

  recordTurn(input: TurnLatencyInput): void {
    const measuredAt = new Date();

    const stt = measurementOf(input.sttMs, measuredAt);
    const llm = measurementOf(input.llmMs, measuredAt);
    const tts = measurementOf(input.ttsMs, measuredAt);
    const total = measurementOf(input.totalMs, measuredAt);
    const llmGenerationMs = positiveOrUndefined(input.llmGenerationMs);
    const ttsSynthesisMs = positiveOrUndefined(input.ttsSynthesisMs);
    const userSpeechMs = positiveOrUndefined(input.userSpeechMs);
    // Token counts, not latencies — 0 is meaningful (e.g. a genuine
    // cache miss), so it must survive alongside `undefined` ("not
    // reported"), not collapse into it. `positiveOrUndefined` already
    // preserves 0 and only rejects undefined/NaN/negative.
    const promptTokens = positiveOrUndefined(input.promptTokens);
    const cachedPromptTokens = positiveOrUndefined(input.cachedPromptTokens);
    const reasoningTokens = positiveOrUndefined(input.reasoningTokens);
    // PHASE 3 BATCH 1 — same rule as every span above: a negative or
    // non-finite value means the two clocks disagreed (a stale
    // snapshot, a reordered event), and the honest report for that is
    // "not measured", never a clamped 0 that would be averaged in as a
    // real zero-length wait.
    const endpointToReleaseMs = positiveOrUndefined(input.endpointToReleaseMs);
    const speechEndToReleaseMs = positiveOrUndefined(input.speechEndToReleaseMs);
    const playbackStartupMs = positiveOrUndefined(input.playbackStartupMs);
    // PHASE 3 BATCH 3 — absolute epoch-ms stamps, not spans. The same
    // `positiveOrUndefined` guard applies (it rejects undefined, NaN
    // and negatives), and it cannot collapse a real stamp: `Date.now()`
    // is never 0 or negative, so "absent" stays absent rather than
    // becoming a 1970 timestamp.
    const lastInboundAudioAtMs = positiveOrUndefined(input.lastInboundAudioAtMs);
    const lastInterimTranscriptAtMs = positiveOrUndefined(input.lastInterimTranscriptAtMs);
    const lastFinalTranscriptAtMs = positiveOrUndefined(input.lastFinalTranscriptAtMs);
    const endpointEvidenceAtMs = positiveOrUndefined(input.endpointEvidenceAtMs);
    // A closed string union, so it is validated the same way
    // `llmRetryReasons` is rather than through a numeric guard. An
    // unrecognised value is dropped rather than stored, so the field
    // can only ever hold a claim the pipeline actually made.
    const endpointEvidenceKind =
      input.endpointEvidenceKind === "speech_final" || input.endpointEvidenceKind === "utterance_end"
        ? input.endpointEvidenceKind
        : undefined;
    // PHASE 3 BATCH 4 — same guard, and here `positiveOrUndefined`
    // PRESERVING 0 is the correct semantic rather than an accident:
    // this is a counter, and "no audio ingested yet" is a real reading,
    // unlike the epoch stamps above where 0 would mean 1970.
    const inboundStreamMsAtFinalTranscript = positiveOrUndefined(
      input.inboundStreamMsAtFinalTranscript,
    );
    // Counts, not latencies: 0 retries is a REAL and important
    // observation (it is the answer "retries did not cause this"),
    // so it must survive alongside `undefined` ("not observed").
    // `positiveOrUndefined` already preserves 0.
    const llmAttempts = positiveOrUndefined(input.llmAttempts);
    const llmRetries = positiveOrUndefined(input.llmRetries);
    const llmRetryOverheadMs = positiveOrUndefined(input.llmRetryOverheadMs);
    const llmRetryReasons =
      typeof input.llmRetryReasons === "string" && input.llmRetryReasons.length > 0
        ? input.llmRetryReasons
        : undefined;

    this.turnLatencies.push({
      turnIndex: input.turnIndex,
      ...(stt !== undefined ? { stt } : {}),
      ...(llm !== undefined ? { llm } : {}),
      ...(tts !== undefined ? { tts } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(llmGenerationMs !== undefined ? { llmGenerationMs } : {}),
      ...(ttsSynthesisMs !== undefined ? { ttsSynthesisMs } : {}),
      ...(userSpeechMs !== undefined ? { userSpeechMs } : {}),
      ...(endpointToReleaseMs !== undefined ? { endpointToReleaseMs } : {}),
      ...(speechEndToReleaseMs !== undefined ? { speechEndToReleaseMs } : {}),
      ...(playbackStartupMs !== undefined ? { playbackStartupMs } : {}),
      ...(lastInboundAudioAtMs !== undefined ? { lastInboundAudioAtMs } : {}),
      ...(lastInterimTranscriptAtMs !== undefined ? { lastInterimTranscriptAtMs } : {}),
      ...(lastFinalTranscriptAtMs !== undefined ? { lastFinalTranscriptAtMs } : {}),
      ...(endpointEvidenceAtMs !== undefined ? { endpointEvidenceAtMs } : {}),
      ...(endpointEvidenceKind !== undefined ? { endpointEvidenceKind } : {}),
      ...(inboundStreamMsAtFinalTranscript !== undefined
        ? { inboundStreamMsAtFinalTranscript }
        : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(llmAttempts !== undefined ? { llmAttempts } : {}),
      ...(llmRetries !== undefined ? { llmRetries } : {}),
      ...(llmRetryOverheadMs !== undefined ? { llmRetryOverheadMs } : {}),
      ...(llmRetryReasons !== undefined ? { llmRetryReasons } : {}),
    });

    this.costTotals.speechToText += input.sttCostUsd;
    this.costTotals.languageModel += input.llmCostUsd;
    this.costTotals.textToSpeech += input.ttsCostUsd;
  }

  recordAuxiliaryCost(input: AuxiliaryCostInput): void {
    this.costTotals.speechToText += input.speechToText ?? 0;
    this.costTotals.languageModel += input.languageModel ?? 0;
    this.costTotals.textToSpeech += input.textToSpeech ?? 0;
  }

  /**
   * The telephony provider has confirmed the callee actually picked
   * up. Idempotent: a duplicate/retried webhook or media-stream
   * `start` must not restart the clock.
   */
  markCallAnswered(): void {
    this.answeredAt ??= new Date();
  }

  /**
   * PHASE 3 BATCH 1. The media bridge has handed the FIRST outbound
   * audio frame of this call to the transport.
   *
   * Idempotent for exactly the reason `markCallAnswered` is: the pump
   * calls this on every frame it sends (~50/s), and only the first one
   * is the answer to "when did the caller start hearing us". `??=`
   * makes every later call a single no-op comparison rather than
   * requiring the bridge to carry a flag of its own — which would
   * put the definition of "first" in two places.
   */
  markFirstOutboundAudio(): void {
    this.firstOutboundAudioAt ??= new Date();
  }

  markCallEnded(): void {
    this.endedAt ??= new Date();
  }

  build(): BenchmarkMetrics {
    // While the call is live there is no `endedAt` yet, so duration
    // is measured against now — the same live-ticking behaviour the
    // dashboard already relied on, just anchored correctly.
    const endReference = this.endedAt ?? new Date();
    const connectedSeconds =
      this.answeredAt !== undefined
        ? Math.max(0, (endReference.getTime() - this.answeredAt.getTime()) / 1000)
        : undefined;

    const callDuration: CallDurationMetric = {
      ...(connectedSeconds !== undefined ? { seconds: connectedSeconds } : {}),
      createdAt: this.createdAt,
      ...(this.answeredAt !== undefined ? { answeredAt: this.answeredAt } : {}),
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.firstOutboundAudioAt !== undefined
        ? { firstOutboundAudioAt: this.firstOutboundAudioAt }
        : {}),
    };

    // Telephony bills the connected span, so it is derived here
    // rather than accumulated per turn. An unanswered call is billed
    // nothing, which is exactly what `connectedSeconds === undefined`
    // should produce.
    const telephony =
      connectedSeconds !== undefined
        ? estimateTelephonyCost(this.providerStack.telephony.id, connectedSeconds)
        : 0;

    const breakdown = { telephony, ...this.costTotals };
    const estimatedCost: EstimatedCostMetric = {
      amount:
        breakdown.telephony +
        breakdown.speechToText +
        breakdown.languageModel +
        breakdown.textToSpeech,
      currency: "USD",
      isEstimate: true,
      breakdown,
    };

    return {
      sessionId: this.sessionId,
      providerStack: this.providerStack,
      timestamp: new Date(),
      callDuration,
      estimatedCost,
      turnLatencies: [...this.turnLatencies],
    };
  }
}
