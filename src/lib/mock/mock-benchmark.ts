/**
 * mock-benchmark.ts
 *
 * Mock `BenchmarkMetrics` for the Performance Metrics section.
 * Stands in for `VoiceSessionManager.getBenchmarkMetrics`. Shape
 * matches `types/benchmark.types.ts` exactly — no new fields added.
 */

import { DEFAULT_PROVIDER_STACK, MOCK_SESSION_ID } from "./mock-session";
import type { BenchmarkMetrics, TurnLatencyBreakdown } from "@/types/benchmark.types";

const sessionStart = new Date(Date.now() - 1000 * 42);

function turn(
  turnIndex: number,
  offsetMs: number,
  sttMs: number,
  llmMs: number,
  ttsMs: number,
): TurnLatencyBreakdown {
  const measuredAt = new Date(sessionStart.getTime() + offsetMs);
  return {
    turnIndex,
    stt: { milliseconds: sttMs, measuredAt },
    llm: { milliseconds: llmMs, measuredAt },
    tts: { milliseconds: ttsMs, measuredAt },
    total: { milliseconds: sttMs + llmMs + ttsMs, measuredAt },
  };
}

export const MOCK_TURN_LATENCIES: readonly TurnLatencyBreakdown[] = [
  turn(0, 3400, 312, 640, 890),
  turn(1, 12600, 284, 710, 940),
  turn(2, 21300, 298, 580, 860),
  turn(3, 29700, 305, 655, 905),
];

export const MOCK_BENCHMARK_METRICS: BenchmarkMetrics = {
  sessionId: MOCK_SESSION_ID,
  providerStack: DEFAULT_PROVIDER_STACK,
  timestamp: new Date(),
  callDuration: {
    seconds: 42,
    startedAt: sessionStart,
  },
  estimatedCost: {
    amount: 0.0847,
    currency: "USD",
    breakdown: {
      telephony: 0.021,
      speechToText: 0.014,
      languageModel: 0.038,
      textToSpeech: 0.0117,
    },
  },
  turnLatencies: MOCK_TURN_LATENCIES,
};
