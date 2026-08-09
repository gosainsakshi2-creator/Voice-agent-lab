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
  readonly sttCostUsd: number;
  readonly llmCostUsd: number;
  readonly ttsCostUsd: number;
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

    this.turnLatencies.push({
      turnIndex: input.turnIndex,
      ...(stt !== undefined ? { stt } : {}),
      ...(llm !== undefined ? { llm } : {}),
      ...(tts !== undefined ? { tts } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(llmGenerationMs !== undefined ? { llmGenerationMs } : {}),
      ...(ttsSynthesisMs !== undefined ? { ttsSynthesisMs } : {}),
      ...(userSpeechMs !== undefined ? { userSpeechMs } : {}),
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
