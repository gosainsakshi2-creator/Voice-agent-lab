/**
 * measure.ts — timing and statistics for the offline LLM benchmark.
 *
 * PHASE 3 BATCH 3. Pure functions only: no provider, no network, no
 * clock beyond the monotonic reads it is handed. Importing this file
 * cannot make an API call.
 *
 * ── WHY MONOTONIC ─────────────────────────────────────────────────
 *
 * Durations come from `performance.now()`, which is monotonic and
 * unaffected by NTP steps or DST. Wall-clock ISO timestamps are
 * recorded ALONGSIDE for auditability, never subtracted from each
 * other — a benchmark whose numbers move because the machine synced
 * its clock is not a benchmark.
 */

/**
 * The percentiles this benchmark is permitted to report.
 *
 * DELIBERATELY EXCLUDES p95 AND p99. At the approved size (5
 * repetitions × 13 scenarios = 65 measured runs per model) a p95 is
 * the 4th-largest observation and a p99 is simply the maximum wearing
 * a more confident name. Both would imply a precision the sample does
 * not carry, which is the discipline this whole phase has applied to
 * production data and has no reason to relax for its own tooling.
 *
 * Asserted by the harness tests: the rendered report must contain
 * neither "p95" nor "p99".
 */
export const REPORTED_PERCENTILES = [0.5, 0.9] as const;

/** One completed (or failed) provider invocation. */
export interface RunRecord {
  /** Groups every record from one `bench:llm` invocation. */
  readonly benchmarkRunId: string;
  readonly scenarioId: string;
  /** Provider id, e.g. "gpt-5.1" / "gemma-4". */
  readonly model: string;
  /** 0 for the warm-up, then 1..N for measured repetitions. */
  readonly repetition: number;
  /** Warm-ups are recorded in full and excluded from every statistic. */
  readonly warmup: boolean;

  /** Wall clock, ISO. Audit trail only — never subtracted. */
  readonly startedAtIso: string;
  readonly endedAtIso: string;

  /**
   * Provider invocation -> first emitted `LlmTokenEvent` of type
   * "token". For Gemma this is the first ANSWER token by
   * construction: its adapter never yields a `thought` part. Absent
   * when the run produced no token at all.
   */
  readonly firstAnswerTokenMs: number | undefined;
  /** Provider invocation -> stream completion. */
  readonly completionMs: number | undefined;
  /** `completionMs - firstAnswerTokenMs`. Absent if either side is. */
  readonly firstAnswerToCompletionMs: number | undefined;
  /** Provider invocation -> stream completion, including a failed run's time-to-error. */
  readonly totalMs: number;

  /** Text assembled from the token stream only. See `runner.ts`. */
  readonly answerText: string;
  /** Tokens observed. */
  readonly tokenCount: number;
  /**
   * True when the provider's terminal event carried text that differs
   * from the concatenated token stream. For Gemma that would mean
   * reasoning had escaped its per-part filter, so it is a correctness
   * alarm, not a curiosity.
   */
  readonly finalTextDivergedFromTokens: boolean;

  readonly success: boolean;
  readonly errorCategory: ErrorCategory | undefined;
  readonly errorMessage: string | undefined;

  // --- PHASE 3 BATCH 3A: vendor retry attribution, carried through
  // from the provider's terminal event. OPTIONAL throughout, for two
  // independent reasons:
  //
  //   1. Records written before this batch do not have them, and that
  //      historical JSONL must stay readable.
  //   2. Only the OpenAI adapter reports them. Gemma's terminal event
  //      carries no usage of any kind, so for Gemma these are absent —
  //      which is the honest report, and must never become 0.
  //
  // A run that failed before the terminal event (an exception) also
  // has none: reporting "0 retries" for a request whose retry history
  // was never observed would invert the meaning of the measurement.

  /** HTTP attempts the SDK made for this request. 1 means no retry occurred. */
  readonly llmAttempts?: number;
  /** Attempts beyond the first. */
  readonly llmRetries?: number;
  /** Measured wall clock spent on failed attempts plus the SDK's backoff sleeps. */
  readonly llmRetryOverheadMs?: number;
  /** Compact, non-sensitive reasons, e.g. `"500,429"`. Absent when no retry occurred. */
  readonly llmRetryReasons?: string;
}

/**
 * How a slow run relates to the SDK's retry machinery.
 *
 * Three states, kept deliberately distinct: conflating "we know there
 * were no retries" with "we do not know" is exactly the error that
 * would let a false conclusion about causality through.
 */
export type RetryAttributionState = "retry-confirmed" | "zero-retries" | "attribution-missing";

export function retryAttributionStateOf(record: RunRecord): RetryAttributionState {
  if (record.llmAttempts === undefined) return "attribution-missing";
  return (record.llmRetries ?? 0) > 0 ? "retry-confirmed" : "zero-retries";
}

/** Slow-run thresholds the report breaks out, in ms. */
export const SLOW_RUN_THRESHOLDS_MS = [5000, 8000, 10000] as const;

/**
 * Why a run did not produce a usable answer.
 *
 * `harness_error` is deliberately separate from the provider
 * categories: it means the benchmark itself is broken, and it is the
 * ONLY category the runner may retry. A model that fails is a result;
 * a harness that fails is a bug.
 */
export type ErrorCategory = "provider_error" | "no_tokens" | "empty_answer" | "harness_error";

/** Nearest-rank percentile. `undefined` for an empty sample rather than 0. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export interface Summary {
  readonly n: number;
  readonly p50: number | undefined;
  readonly p90: number | undefined;
  readonly min: number | undefined;
  readonly max: number | undefined;
  /** Supplementary only — never the headline. */
  readonly mean: number | undefined;
}

export function summarize(values: readonly number[]): Summary {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return { n: 0, p50: undefined, p90: undefined, min: undefined, max: undefined, mean: undefined };
  }
  const sum = finite.reduce((a, b) => a + b, 0);
  return {
    n: finite.length,
    p50: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: Math.round(sum / finite.length),
  };
}

/**
 * The measured set: successful, non-warm-up runs.
 *
 * Warm-ups are excluded HERE, in one place, rather than at each call
 * site — a statistic that forgot to filter them would silently report
 * a cold first request as a typical one, which is the exact error the
 * warm-up exists to prevent.
 */
export function measuredRuns(records: readonly RunRecord[]): RunRecord[] {
  return records.filter((r) => !r.warmup && r.success);
}

/** Failed runs stay visible: they are a result about the model, not noise. */
export function failedRuns(records: readonly RunRecord[]): RunRecord[] {
  return records.filter((r) => !r.warmup && !r.success);
}

export type MetricKey = "firstAnswerTokenMs" | "firstAnswerToCompletionMs" | "totalMs";

export function metricValues(records: readonly RunRecord[], key: MetricKey): number[] {
  return records
    .map((r) => r[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** One JSONL line per record. Newline-terminated so appends concatenate cleanly. */
export function toJsonl(record: RunRecord): string {
  return `${JSON.stringify(record)}\n`;
}
