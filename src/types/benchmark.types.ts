/**
 * benchmark.types.ts
 *
 * Shared, provider-agnostic types describing the metrics captured
 * for a single benchmark session. These are DATA shapes only — how
 * they are measured, aggregated, or persisted is an implementation
 * concern out of scope for this architecture pass.
 */

import type { ProviderStackSelection, SessionId } from "./session.types";

/**
 * A generic millisecond latency measurement, reused across every
 * per-stage latency type below so they share a single shape.
 */
export interface LatencyMeasurementMs {
  readonly milliseconds: number;
  /** When this measurement was recorded. */
  readonly measuredAt: Date;
}

/**
 * Latency contributed by the Speech-To-Text provider for a single
 * turn (audio-in to final transcript).
 */
export interface SttLatencyMetric extends LatencyMeasurementMs {}

/**
 * Latency contributed by the Language Model provider for a single
 * turn (prompt/history-in to completion-out).
 */
export interface LlmLatencyMetric extends LatencyMeasurementMs {}

/**
 * Latency contributed by the Text-To-Speech provider for a single
 * turn (text-in to synthesized audio-out).
 */
export interface TtsLatencyMetric extends LatencyMeasurementMs {}

/**
 * End-to-end latency for a single conversational turn — i.e. the
 * sum (or measured wall-clock span) of STT + LLM + TTS for that
 * turn. Kept as its own type rather than a derived sum so it can be
 * measured directly (wall-clock) or reconciled against the
 * component metrics.
 */
export interface TotalLatencyMetric extends LatencyMeasurementMs {}

/**
 * Total wall-clock duration of the call itself, independent of any
 * single turn's latency.
 */
export interface CallDurationMetric {
  readonly seconds: number;
  readonly startedAt: Date;
  readonly endedAt?: Date;
}

/**
 * Estimated monetary cost of a session, broken down by the
 * provider category that incurred it. `currency` follows ISO 4217
 * (e.g. "USD").
 */
export interface EstimatedCostMetric {
  readonly amount: number;
  readonly currency: string;
  readonly breakdown?: Readonly<{
    readonly telephony?: number;
    readonly speechToText?: number;
    readonly languageModel?: number;
    readonly textToSpeech?: number;
  }>;
}

/**
 * A single latency sample tied to the turn it was measured in,
 * allowing per-turn benchmarking rather than only session-level
 * averages.
 */
export interface TurnLatencyBreakdown {
  readonly turnIndex: number;
  readonly stt: SttLatencyMetric;
  readonly llm: LlmLatencyMetric;
  readonly tts: TtsLatencyMetric;
  readonly total: TotalLatencyMetric;
}

/**
 * The complete set of benchmark metrics collected for one session,
 * tying every measurement back to the exact provider stack under
 * test. This is the primary artifact the platform exists to
 * produce: a like-for-like comparison across provider stacks.
 */
export interface BenchmarkMetrics {
  readonly sessionId: SessionId;
  readonly providerStack: ProviderStackSelection;
  readonly timestamp: Date;
  readonly callDuration: CallDurationMetric;
  readonly estimatedCost: EstimatedCostMetric;
  readonly turnLatencies: readonly TurnLatencyBreakdown[];
}
