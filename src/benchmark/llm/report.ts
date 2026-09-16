/**
 * report.ts — renders the benchmark results.
 *
 * PHASE 3 BATCH 3. Pure: takes records, returns strings. No I/O, no
 * clock, no network.
 *
 * Two outputs, deliberately:
 *   - MARKDOWN for a human, including the quality adjudication sheet
 *   - JSON for a machine, so a later batch can diff two runs
 *
 * ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────────
 *
 * It does not compute p95 or p99 (see `REPORTED_PERCENTILES`), and it
 * does not score quality. There is no automated quality number
 * anywhere in this harness: a rubric that scores itself would inherit
 * the biases of whatever scored it, and the Phase 1 suites — not this
 * benchmark — remain the behavioural source of truth. What it
 * produces is a sheet a human fills in.
 */

import {
  failedRuns,
  measuredRuns,
  metricValues,
  retryAttributionStateOf,
  summarize,
  SLOW_RUN_THRESHOLDS_MS,
  type MetricKey,
  type RetryAttributionState,
  type RunRecord,
  type Summary,
} from "./measure";

/** Exactly the configuration each arm ran under. Printed verbatim — never normalized. */
export interface ModelConfigNote {
  readonly model: string;
  readonly settings: Readonly<Record<string, string>>;
}

export interface ReportInput {
  readonly benchmarkRunId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly records: readonly RunRecord[];
  readonly configs: readonly ModelConfigNote[];
  readonly scenarioTitles: Readonly<Record<string, string>>;
  readonly scenarioIntents: Readonly<Record<string, string>>;
  readonly scenarioFingerprints: Readonly<Record<string, string>>;
}

const METRICS: readonly { key: MetricKey; label: string }[] = [
  { key: "firstAnswerTokenMs", label: "First usable ANSWER token (ms)" },
  { key: "firstAnswerToCompletionMs", label: "First answer token to completion (ms)" },
  { key: "totalMs", label: "Total request duration (ms)" },
];

/** CRITICAL criteria — any failure fails the scenario outright. */
export const CRITICAL_CRITERIA: readonly string[] = [
  "registration-gate correctness",
  "no fabricated business facts",
  "language consistency",
  "no reasoning-trace leakage",
];

/** BEHAVIOURAL criteria — judged, not blocking. */
export const BEHAVIOURAL_CRITERIA: readonly string[] = [
  "approved script facts preserved",
  "concise voice-friendly answer",
  "natural conversational register",
  "caller's actual question addressed",
  "correct refusal/uncertainty handling",
  "no unnecessary repetition/re-introduction",
  "no robotic/meta language",
  "required business facts preserved",
];

function fmt(value: number | undefined): string {
  return value === undefined ? "n/a" : String(Math.round(value));
}

function summaryRow(label: string, s: Summary): string {
  return `| ${label} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.mean)} |`;
}

const SUMMARY_HEADER =
  "| | n | p50 | p90 | min | max | mean* |\n|---|---|---|---|---|---|---|";

export interface JsonReport {
  readonly benchmarkRunId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly comparisonKind: "production-configuration";
  readonly configs: readonly ModelConfigNote[];
  readonly percentilesReported: readonly number[];
  readonly models: readonly {
    readonly model: string;
    readonly measuredRuns: number;
    readonly failedRuns: number;
    readonly aggregate: Readonly<Record<MetricKey, Summary>>;
    readonly perScenario: readonly {
      readonly scenarioId: string;
      readonly n: number;
      readonly summaries: Readonly<Record<MetricKey, Summary>>;
    }[];
  }[];
}

function modelsIn(records: readonly RunRecord[]): string[] {
  return [...new Set(records.map((r) => r.model))];
}

function scenariosIn(records: readonly RunRecord[]): string[] {
  return [...new Set(records.map((r) => r.scenarioId))];
}

function summariesFor(records: readonly RunRecord[]): Record<MetricKey, Summary> {
  return {
    firstAnswerTokenMs: summarize(metricValues(records, "firstAnswerTokenMs")),
    firstAnswerToCompletionMs: summarize(metricValues(records, "firstAnswerToCompletionMs")),
    totalMs: summarize(metricValues(records, "totalMs")),
  };
}

export function buildJsonReport(input: ReportInput): JsonReport {
  const measured = measuredRuns(input.records);
  const failed = failedRuns(input.records);

  return {
    benchmarkRunId: input.benchmarkRunId,
    startedAtIso: input.startedAtIso,
    finishedAtIso: input.finishedAtIso,
    comparisonKind: "production-configuration",
    configs: input.configs,
    percentilesReported: [0.5, 0.9],
    models: modelsIn(input.records).map((model) => {
      const mine = measured.filter((r) => r.model === model);
      return {
        model,
        measuredRuns: mine.length,
        failedRuns: failed.filter((r) => r.model === model).length,
        aggregate: summariesFor(mine),
        perScenario: scenariosIn(input.records).map((scenarioId) => {
          const rows = mine.filter((r) => r.scenarioId === scenarioId);
          return { scenarioId, n: rows.length, summaries: summariesFor(rows) };
        }),
      };
    }),
  };
}

const STATE_LABEL: Readonly<Record<RetryAttributionState, string>> = {
  "retry-confirmed": "RETRY-CONFIRMED",
  "zero-retries": "zero retries",
  "attribution-missing": "ATTRIBUTION MISSING",
};

/**
 * Slow runs, with their retry attribution — the section this batch
 * exists to produce.
 *
 * It states what was OBSERVED and stops there. It does not compute a
 * correlation, rank a cause, or call a retry-confirmed slow run
 * "explained": a retry that coincides with a slow run is consistent
 * with the hypothesis and is not proof of it, and at these sample
 * sizes nothing stronger is available. The three states are kept
 * apart for the same reason — "we know there were no retries" and "we
 * do not know" support opposite conclusions and must never be merged.
 */
function renderSlowRunSection(measured: readonly RunRecord[]): string {
  const out: string[] = [];
  out.push("## Slow runs and retry attribution");
  out.push("");

  const slow = measured
    .filter((r) => typeof r.firstAnswerTokenMs === "number" && r.firstAnswerTokenMs > SLOW_RUN_THRESHOLDS_MS[0])
    .sort((a, b) => (b.firstAnswerTokenMs ?? 0) - (a.firstAnswerTokenMs ?? 0));

  out.push("| threshold | runs | retry-confirmed | zero retries | attribution missing |");
  out.push("|---|---|---|---|---|");
  for (const threshold of SLOW_RUN_THRESHOLDS_MS) {
    const bucket = measured.filter(
      (r) => typeof r.firstAnswerTokenMs === "number" && r.firstAnswerTokenMs > threshold,
    );
    const count = (state: RetryAttributionState) =>
      bucket.filter((r) => retryAttributionStateOf(r) === state).length;
    out.push(
      `| first-answer > ${threshold / 1000}s | ${bucket.length} | ${count("retry-confirmed")} | ` +
        `${count("zero-retries")} | ${count("attribution-missing")} |`,
    );
  }
  out.push("");

  if (slow.length === 0) {
    out.push(`No run exceeded ${SLOW_RUN_THRESHOLDS_MS[0] / 1000}s to first answer token.`);
    out.push("");
    return out.join("\n");
  }

  out.push("Every run above the lowest threshold, slowest first:");
  out.push("");
  out.push("| model | scenario | rep | first answer (ms) | attribution | attempts | retries | retry overhead (ms) | reasons |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of slow) {
    const state = retryAttributionStateOf(r);
    out.push(
      `| ${r.model} | ${r.scenarioId} | ${r.repetition} | ${fmt(r.firstAnswerTokenMs)} | ` +
        `${STATE_LABEL[state]} | ${r.llmAttempts ?? "n/a"} | ${r.llmRetries ?? "n/a"} | ` +
        `${fmt(r.llmRetryOverheadMs)} | ${r.llmRetryReasons ?? "none"} |`,
    );
  }
  out.push("");
  out.push(
    "> **No causality is asserted here.** A retry coinciding with a slow run is consistent with " +
      "the retry hypothesis, not proof of it. `ATTRIBUTION MISSING` means the provider reported " +
      "nothing for that run — a stream that failed before its terminal event, or a provider that " +
      "reports no usage at all (Gemma) — and must not be read as zero retries.",
  );
  out.push("");
  return out.join("\n");
}

export function buildMarkdownReport(input: ReportInput): string {
  const measured = measuredRuns(input.records);
  const failed = failedRuns(input.records);
  const warmups = input.records.filter((r) => r.warmup);
  const models = modelsIn(input.records);
  const scenarios = scenariosIn(input.records);

  const out: string[] = [];

  out.push(`# LLM Benchmark — ${input.benchmarkRunId}`);
  out.push("");
  out.push(
    "**This is a production-configuration comparison, not a parameter-matched model comparison.**",
  );
  out.push("");
  out.push(
    "Each model ran under the settings it uses in production today. Where those settings differ, " +
      "the difference is shown below rather than normalized away — so a latency or quality gap may " +
      "reflect configuration as much as model capability. The question this run answers is the " +
      "practical one: *is Gemma 4 a viable replacement for GPT-5.1 in the current voice-agent setup?*",
  );
  out.push("");
  out.push(`Started \`${input.startedAtIso}\` · finished \`${input.finishedAtIso}\``);
  out.push("");

  out.push("## Configuration, as run");
  out.push("");
  for (const config of input.configs) {
    out.push(`**${config.model}**`);
    out.push("");
    out.push("| setting | value |");
    out.push("|---|---|");
    for (const [key, value] of Object.entries(config.settings)) {
      out.push(`| ${key} | \`${value}\` |`);
    }
    out.push("");
  }

  out.push("## Sample");
  out.push("");
  out.push(`- Measured runs: **${measured.length}** (successful, warm-ups excluded)`);
  out.push(`- Failed runs: **${failed.length}** (listed below; never silently replaced)`);
  out.push(`- Warm-ups discarded: **${warmups.length}**`);
  out.push(`- Scenarios: **${scenarios.length}** · models: **${models.length}**`);
  out.push("");
  out.push(
    "Percentiles reported: **p50 and p90 only**. p95 and p99 are deliberately withheld — " +
      "at this sample size a p95 is the 4th-largest observation and a p99 is the maximum under " +
      "another name. No significance is claimed. `mean*` is supplementary.",
  );
  out.push("");

  out.push("## Latency — aggregate");
  out.push("");
  for (const { key, label } of METRICS) {
    out.push(`### ${label}`);
    out.push("");
    out.push(SUMMARY_HEADER);
    for (const model of models) {
      const rows = measured.filter((r) => r.model === model);
      out.push(summaryRow(model, summarize(metricValues(rows, key))));
    }
    out.push("");
  }

  out.push("> **First-generated-token is not reported.** It is not a cross-model metric: OpenAI");
  out.push("> never streams reasoning as a content delta, so no observable event precedes the first");
  out.push("> answer token; Gemma's reasoning parts do stream but its adapter filters them before");
  out.push("> they reach the token stream. Reporting one would compare two different things.");
  out.push("");

  out.push("## Latency — per scenario");
  out.push("");
  out.push("First usable ANSWER token (ms).");
  out.push("");
  out.push(`| scenario | ${models.map((m) => `${m} p50 | ${m} p90`).join(" | ")} | n |`);
  out.push(`|---|${models.map(() => "---|---").join("|")}|---|`);
  for (const scenarioId of scenarios) {
    const cells: string[] = [];
    let n = 0;
    for (const model of models) {
      const rows = measured.filter((r) => r.model === model && r.scenarioId === scenarioId);
      n = Math.max(n, rows.length);
      const s = summarize(metricValues(rows, "firstAnswerTokenMs"));
      cells.push(fmt(s.p50), fmt(s.p90));
    }
    out.push(`| ${scenarioId} | ${cells.join(" | ")} | ${n} |`);
  }
  out.push("");

  out.push(renderSlowRunSection(measured));

  if (failed.length > 0) {
    out.push("## Failed runs");
    out.push("");
    out.push("| model | scenario | rep | category | message |");
    out.push("|---|---|---|---|---|");
    for (const r of failed) {
      out.push(
        `| ${r.model} | ${r.scenarioId} | ${r.repetition} | ${r.errorCategory ?? "?"} | ${(r.errorMessage ?? "").slice(0, 120)} |`,
      );
    }
    out.push("");
  }

  const diverged = input.records.filter((r) => r.finalTextDivergedFromTokens);
  if (diverged.length > 0) {
    out.push("## ⚠ Token-stream divergence");
    out.push("");
    out.push(
      "The terminal event's text differed from the concatenated token stream on the runs below. " +
        "For Gemma this would mean a reasoning part escaped its per-part filter and must be " +
        "investigated before any conclusion is drawn from this run.",
    );
    out.push("");
    for (const r of diverged) out.push(`- ${r.model} · ${r.scenarioId} · rep ${r.repetition}`);
    out.push("");
  }

  out.push("## Quality adjudication — to be completed by a human");
  out.push("");
  out.push(
    "No automated score is produced. Mark each criterion PASS or FAIL with a note. " +
      "Any CRITICAL failure fails the scenario outright. The Phase 1 test suites remain the " +
      "definition of correct behaviour.",
  );
  out.push("");

  for (const scenarioId of scenarios) {
    out.push(`### ${scenarioId} — ${input.scenarioTitles[scenarioId] ?? ""}`);
    out.push("");
    out.push(`*Testing:* ${input.scenarioIntents[scenarioId] ?? ""}`);
    out.push(`*Input fingerprint:* \`${input.scenarioFingerprints[scenarioId] ?? "n/a"}\``);
    out.push("");
    for (const model of models) {
      const first = measured.find((r) => r.model === model && r.scenarioId === scenarioId);
      out.push(`**${model}** — answer as generated:`);
      out.push("");
      out.push("```");
      out.push(first?.answerText ?? "(no successful run)");
      out.push("```");
      out.push("");
      out.push("| criterion | type | PASS/FAIL | note |");
      out.push("|---|---|---|---|");
      for (const c of CRITICAL_CRITERIA) out.push(`| ${c} | CRITICAL | | |`);
      for (const c of BEHAVIOURAL_CRITERIA) out.push(`| ${c} | behavioural | | |`);
      out.push("");
    }
  }

  return out.join("\n");
}
