/**
 * runner.ts — drives both models through the shared provider interface.
 *
 * PHASE 3 BATCH 3. Constructs no provider of its own: the providers
 * are INJECTED, which is what lets the tests exercise every path
 * without a network request and is why importing this file cannot
 * reach a vendor.
 *
 * ── WHAT IS MEASURED, AND FROM WHERE ──────────────────────────────
 *
 * Only `LanguageModelProvider.generateCompletionStream` — the same
 * public member the production pipeline uses. No provider internal is
 * duplicated, no vendor SDK is called directly, and neither adapter is
 * modified.
 *
 * ── WHY ANSWER TEXT COMES FROM THE TOKEN STREAM ───────────────────
 *
 * The answer is assembled from `type: "token"` events, NOT from the
 * terminal event's `turn.content`. That choice is the Gemma safety
 * property: its adapter yields tokens from the response's `content`
 * only, never from OpenRouter's separate `reasoning` field, so a
 * reasoning chunk can never become a token event. Reading the terminal
 * turn instead would bypass the one place that filter is applied.
 *
 * The two are cross-checked anyway and any divergence is recorded as
 * `finalTextDivergedFromTokens` — for Gemma that would mean reasoning
 * had escaped its filter, which is a correctness alarm rather than a
 * curiosity.
 */

import { performance } from "node:perf_hooks";

import type { LanguageModelProvider } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId } from "../../types/session.types";
import { buildScenarioHistory, type BenchmarkScenario } from "./scenarios";
import type { ErrorCategory, RunRecord } from "./measure";

/** How many times the harness may retry its OWN failure. Model failures are never retried. */
const MAX_HARNESS_RETRIES = 1;

export interface RunnerOptions {
  readonly benchmarkRunId: string;
  readonly providers: readonly LanguageModelProvider[];
  readonly scenarios: readonly BenchmarkScenario[];
  /** Measured repetitions per model per scenario. */
  readonly repetitions: number;
  /** One discarded warm-up per model per scenario when true. */
  readonly warmup: boolean;
  /** Called as each record is produced, so raw data is durable before the run ends. */
  readonly onRecord?: (record: RunRecord) => void | Promise<void>;
  /** Progress line sink. Defaults to silence so tests stay quiet. */
  readonly log?: (line: string) => void;
}

/** Total provider invocations a given plan will make. Printed before any call. */
export function plannedRequestCount(options: {
  readonly models: number;
  readonly scenarios: number;
  readonly repetitions: number;
  readonly warmup: boolean;
}): { readonly warmups: number; readonly measured: number; readonly total: number } {
  const warmups = options.warmup ? options.models * options.scenarios : 0;
  const measured = options.models * options.scenarios * options.repetitions;
  return { warmups, measured, total: warmups + measured };
}

function categorizeError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/benchmark harness/i.test(message)) return "harness_error";
  return "provider_error";
}

/**
 * One provider invocation, fully measured.
 *
 * Never throws: a model that fails is a RESULT, and swallowing it into
 * an exception would lose the very observation the benchmark exists to
 * make. The failure is recorded with its category and the run
 * continues.
 */
export async function runOnce(args: {
  readonly benchmarkRunId: string;
  readonly provider: LanguageModelProvider;
  readonly scenario: BenchmarkScenario;
  readonly repetition: number;
  readonly warmup: boolean;
}): Promise<RunRecord> {
  const { benchmarkRunId, provider, scenario, repetition, warmup } = args;
  const model = provider.descriptor.id;

  const history = buildScenarioHistory(scenario);
  const request = { sessionId: `bench-${scenario.id}` as SessionId, history };

  const startedAtIso = new Date().toISOString();
  // Monotonic: immune to an NTP step mid-run. Wall clock is recorded
  // separately for audit and is never subtracted.
  const t0 = performance.now();

  let firstAnswerTokenMs: number | undefined;
  let completionMs: number | undefined;
  let tokenCount = 0;
  let streamedText = "";
  let finalText: string | undefined;
  let success = false;
  let errorCategory: ErrorCategory | undefined;
  let errorMessage: string | undefined;
  // PHASE 3 BATCH 3A — read straight off the terminal event. These
  // fields are part of the PUBLIC `LlmFinalEvent` contract (added in
  // Batch 2A), so the harness consumes the existing telemetry surface
  // rather than reimplementing the SDK log parser or touching either
  // provider. Absent for Gemma, whose terminal event reports no usage.
  let llmAttempts: number | undefined;
  let llmRetries: number | undefined;
  let llmRetryOverheadMs: number | undefined;
  let llmRetryReasons: string | undefined;

  try {
    const stream = provider.generateCompletionStream?.(request);
    if (!stream) {
      throw new Error("benchmark harness: provider exposes no generateCompletionStream");
    }

    for await (const event of stream) {
      if (event.type === "token") {
        // The metric. First token event === first usable ANSWER token
        // for both providers: Gemma never yields a reasoning chunk as
        // a token, and OpenAI never streams reasoning as a content
        // delta at all.
        firstAnswerTokenMs ??= performance.now() - t0;
        tokenCount += 1;
        streamedText += event.delta;
      } else {
        finalText = event.turn.content;
        llmAttempts = event.llmAttempts;
        llmRetries = event.llmRetries;
        llmRetryOverheadMs = event.llmRetryOverheadMs;
        llmRetryReasons = event.llmRetryReasons;
      }
    }

    completionMs = performance.now() - t0;

    if (tokenCount === 0) {
      errorCategory = "no_tokens";
      errorMessage = "stream completed without emitting a token event";
    } else if (streamedText.trim().length === 0) {
      errorCategory = "empty_answer";
      errorMessage = "tokens were emitted but the assembled answer is blank";
    } else {
      success = true;
    }
  } catch (error) {
    errorCategory = categorizeError(error);
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const totalMs = performance.now() - t0;

  return {
    benchmarkRunId,
    scenarioId: scenario.id,
    model,
    repetition,
    warmup,
    startedAtIso,
    endedAtIso: new Date().toISOString(),
    firstAnswerTokenMs,
    completionMs,
    firstAnswerToCompletionMs:
      completionMs !== undefined && firstAnswerTokenMs !== undefined
        ? completionMs - firstAnswerTokenMs
        : undefined,
    totalMs,
    answerText: streamedText,
    tokenCount,
    // `undefined` finalText (an aborted stream) is not a divergence.
    finalTextDivergedFromTokens: finalText !== undefined && finalText !== streamedText,
    success,
    errorCategory,
    errorMessage,
    // Spread-omitted when absent, so a record from a provider that
    // reports no attribution is indistinguishable from a historical
    // record written before this batch — both correctly read as
    // "not observed" rather than as zero retries.
    ...(llmAttempts !== undefined ? { llmAttempts } : {}),
    ...(llmRetries !== undefined ? { llmRetries } : {}),
    ...(llmRetryOverheadMs !== undefined ? { llmRetryOverheadMs } : {}),
    ...(llmRetryReasons !== undefined ? { llmRetryReasons } : {}),
  };
}

/**
 * The full matrix: every scenario × every model × (warm-up + N
 * repetitions), strictly sequentially.
 *
 * SEQUENTIAL ON PURPOSE. Running two models concurrently would have
 * them share this machine's uplink and each other's tail, and a
 * latency benchmark whose arms contend with one another measures the
 * contention.
 */
export async function runBenchmark(options: RunnerOptions): Promise<RunRecord[]> {
  const log = options.log ?? (() => {});
  const records: RunRecord[] = [];

  const emit = async (record: RunRecord): Promise<void> => {
    records.push(record);
    await options.onRecord?.(record);
  };

  for (const scenario of options.scenarios) {
    for (const provider of options.providers) {
      const model = provider.descriptor.id;

      if (options.warmup) {
        log(`  warm-up  ${model.padEnd(10)} ${scenario.id}`);
        // Repetition 0 marks the warm-up. It is recorded in full so it
        // is auditable, and excluded from every statistic by
        // `measuredRuns`.
        await emit(await runOnce({ ...args(options, provider, scenario), repetition: 0, warmup: true }));
      }

      for (let rep = 1; rep <= options.repetitions; rep += 1) {
        let record = await runOnce({ ...args(options, provider, scenario), repetition: rep, warmup: false });

        // A HARNESS fault is our bug and may be retried. A model
        // failure is a result and is never retried — doing so would
        // quietly delete the observation.
        for (let attempt = 0; attempt < MAX_HARNESS_RETRIES && record.errorCategory === "harness_error"; attempt += 1) {
          log(`  retry    ${model.padEnd(10)} ${scenario.id} rep=${rep} (harness error, not a model failure)`);
          record = await runOnce({ ...args(options, provider, scenario), repetition: rep, warmup: false });
        }

        log(
          `  measured ${model.padEnd(10)} ${scenario.id} rep=${rep} ` +
            `firstAnswer=${record.firstAnswerTokenMs !== undefined ? `${Math.round(record.firstAnswerTokenMs)}ms` : "n/a"} ` +
            `total=${Math.round(record.totalMs)}ms ${record.success ? "ok" : `FAILED(${record.errorCategory})`}`,
        );
        await emit(record);
      }
    }
  }

  return records;
}

function args(
  options: RunnerOptions,
  provider: LanguageModelProvider,
  scenario: BenchmarkScenario,
): { benchmarkRunId: string; provider: LanguageModelProvider; scenario: BenchmarkScenario } {
  return { benchmarkRunId: options.benchmarkRunId, provider, scenario };
}
