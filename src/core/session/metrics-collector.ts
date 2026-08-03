/**
 * metrics-collector.ts
 *
 * Accumulates the latency and cost measurements the
 * VoiceSessionManager is required to expose via
 * `getBenchmarkMetrics` — per-stage (STT/LLM/TTS) latency per turn,
 * end-to-end per-turn latency, call duration, and estimated cost —
 * without owning any timing logic itself (the pipeline measures;
 * this class only aggregates and shapes the result).
 */

import type {
  BenchmarkMetrics,
  CallDurationMetric,
  EstimatedCostMetric,
  TurnLatencyBreakdown,
} from "../../types/benchmark.types";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";

export interface TurnLatencyInput {
  readonly turnIndex: number;
  readonly sttMs: number;
  readonly llmMs: number;
  readonly ttsMs: number;
  readonly totalMs: number;
  readonly sttCostUsd: number;
  readonly llmCostUsd: number;
  readonly ttsCostUsd: number;
}

export class SessionMetricsCollector {
  private readonly turnLatencies: TurnLatencyBreakdown[] = [];
  private readonly costTotals = { telephony: 0, speechToText: 0, languageModel: 0, textToSpeech: 0 };
  private readonly startedAt = new Date();
  private endedAt: Date | undefined;

  constructor(
    private readonly sessionId: SessionId,
    private readonly providerStack: ProviderStackSelection,
  ) {}

  recordTurn(input: TurnLatencyInput): void {
    const measuredAt = new Date();

    this.turnLatencies.push({
      turnIndex: input.turnIndex,
      stt: { milliseconds: input.sttMs, measuredAt },
      llm: { milliseconds: input.llmMs, measuredAt },
      tts: { milliseconds: input.ttsMs, measuredAt },
      total: { milliseconds: input.totalMs, measuredAt },
    });

    this.costTotals.speechToText += input.sttCostUsd;
    this.costTotals.languageModel += input.llmCostUsd;
    this.costTotals.textToSpeech += input.ttsCostUsd;
  }

  markCallEnded(): void {
    this.endedAt = new Date();
  }

  build(): BenchmarkMetrics {
    const callDuration: CallDurationMetric = {
      seconds: ((this.endedAt ?? new Date()).getTime() - this.startedAt.getTime()) / 1000,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
    };

    const totalCost =
      this.costTotals.telephony +
      this.costTotals.speechToText +
      this.costTotals.languageModel +
      this.costTotals.textToSpeech;

    const estimatedCost: EstimatedCostMetric = {
      amount: totalCost,
      currency: "USD",
      breakdown: { ...this.costTotals },
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
