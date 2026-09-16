/**
 * cli.ts — `npm run bench:llm`
 *
 * PHASE 3 BATCH 3. The ONLY file in this harness that constructs a
 * provider, touches the filesystem, or can reach a vendor — and it
 * does none of those at import time.
 *
 * ── COST SAFETY ───────────────────────────────────────────────────
 *
 * A full run is 156 real, billed requests at ~17,100 prompt tokens
 * each, against two vendors. So `main()` runs only when this module is
 * the process entry point, and even then it PLANS AND EXITS unless the
 * operator passes `--confirm-real-api-calls`. Importing this file —
 * from a test, a bundler, an editor's type server — plans nothing and
 * calls nothing.
 *
 * ── WHAT IS AND IS NOT WRITTEN TO DISK ────────────────────────────
 *
 * Written: per-run timings, the generated answer text, and a short
 * fingerprint of the input.
 *
 * NOT written: API keys, and the ~17,100-token prompt itself. The
 * prompt is reproducible from the scenario id plus the committed
 * script/policy, so storing it would add 2MB per run and a copy of
 * the campaign script to a gitignored directory for no benefit. The
 * fingerprint is what ties a number to the exact bytes that produced
 * it.
 *
 * The only personal name in the fixtures is the synthetic
 * "Rahul Sharma". No production contact reaches this harness.
 */

import { config as loadEnvFile } from "dotenv";

// Same two lines, in the same order, as `production-readiness-cli.ts`
// and `audit-cli.ts`. Loaded at module scope rather than inside
// `main()` because it must precede provider CONSTRUCTION, which is
// where the API keys are read. Loading a file into `process.env`
// makes no network request, so the "import calls nothing" property
// below is unaffected.
loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { OpenAiGptLanguageModelProvider } from "../../providers/language-model/openai-gpt.provider";
import { GemmaLanguageModelProvider } from "../../providers/language-model/gemma.provider";
import type { LanguageModelProvider } from "../../interfaces/providers/language-model-provider.interface";

import { SCENARIOS, scenarioInputFingerprint } from "./scenarios";
import { plannedRequestCount, runBenchmark } from "./runner";
import { toJsonl } from "./measure";
import { buildJsonReport, buildMarkdownReport, type ModelConfigNote } from "./report";

/** Approved: 13 scenarios × 5 measured repetitions × 2 models, plus 1 warm-up each. */
export const REPETITIONS = 5;
export const WARMUP = true;

export const CONFIRM_FLAG = "--confirm-real-api-calls";
/**
 * Restricts the run to a subset of models, e.g. `--models=gpt-5.1`.
 *
 * Exists so a targeted evidence-collection run does not have to spend
 * requests on an arm it is not asking about. Omitting it runs every
 * configured model, so the default is unchanged.
 */
export const MODELS_FLAG = "--models=";
/** Gitignored. Raw measurements and rendered reports land here. */
export const OUTPUT_DIR = "benchmark-output/llm";

/**
 * The settings each arm actually ran under, printed verbatim in the
 * report. Read from the same env the providers read, so the report
 * cannot claim a configuration the run did not use.
 */
function configNotes(): ModelConfigNote[] {
  return [
    {
      model: "gpt-5.1",
      settings: {
        model: process.env["OPENAI_MODEL"] ?? "gpt-5.1",
        verbosity: "low (production setting)",
        stream: "true",
        stream_options: "include_usage",
        temperature: "not set — API default",
        max_tokens: "not set — API default",
        maxRetries: "2 (SDK default, unchanged)",
        timeout: "SDK default, unchanged",
      },
    },
    {
      model: "gemma-4",
      settings: {
        model: process.env["GEMMA_MODEL"] ?? "gemma-4-31b-it",
        generationConfig: "not set — API defaults",
        thinking: "ENABLED AND NOT DISABLEABLE (API rejects thinkingBudget/thinkingLevel)",
        reasoningHandling: "thought parts filtered by the adapter; never enter the answer",
        verbosityEquivalent: "NONE — no Gemma equivalent to GPT's verbosity=low",
        temperature: "not set — API default",
      },
    },
  ];
}

function printPlan(log: (s: string) => void, modelIds: readonly string[]): void {
  const plan = plannedRequestCount({
    models: modelIds.length,
    scenarios: SCENARIOS.length,
    repetitions: REPETITIONS,
    warmup: WARMUP,
  });
  log("");
  log("  LLM BENCHMARK — PLAN");
  log("  ────────────────────────────────────────────────");
  log(`  models            ${modelIds.length}  (${modelIds.join(", ")})`);
  log(`  scenarios         ${SCENARIOS.length}`);
  log(`  repetitions       ${REPETITIONS} measured per model per scenario`);
  log(`  warm-ups          ${plan.warmups}  (recorded, excluded from statistics)`);
  log(`  measured runs     ${plan.measured}`);
  // Names only the vendors this run will actually bill — a GPT-only
  // run that warned about Google would be describing a request it is
  // not going to make.
  const vendors = [
    ...(modelIds.includes("gpt-5.1") ? ["OpenAI"] : []),
    ...(modelIds.includes("gemma-4") ? ["Google"] : []),
  ].join(" and ");
  log(`  TOTAL REQUESTS    ${plan.total}  — REAL, BILLED, to ${vendors}`);
  log(`  prompt size       ~17,100 tokens per request`);
  log("  ────────────────────────────────────────────────");
  log("");
}

/** All models the harness can run, in a fixed order. */
const ALL_MODEL_IDS = ["gpt-5.1", "gemma-4"] as const;

/**
 * Parses `--models=a,b`. An unknown id is a hard error rather than a
 * silent no-op: a typo that quietly ran nothing, or ran both arms when
 * one was intended, would spend real money on the wrong experiment.
 */
export function selectedModelIds(argv: readonly string[]): readonly string[] {
  const flag = argv.find((a) => a.startsWith(MODELS_FLAG));
  if (!flag) return ALL_MODEL_IDS;
  const requested = flag.slice(MODELS_FLAG.length).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !ALL_MODEL_IDS.includes(id as (typeof ALL_MODEL_IDS)[number]));
  if (unknown.length > 0) {
    throw new Error(`unknown model id(s): ${unknown.join(", ")}. Known: ${ALL_MODEL_IDS.join(", ")}`);
  }
  if (requested.length === 0) throw new Error(`${MODELS_FLAG} was given with no model ids`);
  return requested;
}

export async function main(argv: readonly string[], log: (s: string) => void = console.log): Promise<number> {
  const confirmed = argv.includes(CONFIRM_FLAG);
  const modelIds = selectedModelIds(argv);
  printPlan(log, modelIds);

  if (!confirmed) {
    log(`  NOT RUNNING. No API request was made.`);
    log(`  Re-run with ${CONFIRM_FLAG} to execute the plan above.`);
    log("");
    return 0;
  }

  // Constructed only past the confirmation gate. Construction itself
  // makes no request, but it reads the API keys, and there is no
  // reason for an unconfirmed invocation to touch them.
  // Only the selected arms are CONSTRUCTED, so a GPT-only run never
  // reads the Google key and cannot reach Google at all.
  const providers: LanguageModelProvider[] = modelIds.map((id) => {
    if (id === "gpt-5.1") return new OpenAiGptLanguageModelProvider();
    if (id === "gemma-4") return new GemmaLanguageModelProvider();
    throw new Error(`benchmark harness: no constructor for model id "${id}"`);
  });

  const benchmarkRunId = `bench_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = path.join(process.cwd(), OUTPUT_DIR, benchmarkRunId);
  await mkdir(dir, { recursive: true });
  const rawPath = path.join(dir, "runs.jsonl");

  const startedAtIso = new Date().toISOString();
  log(`  run id: ${benchmarkRunId}`);
  log(`  raw:    ${rawPath}`);
  log("");

  // Appended as each run finishes, so an interrupted benchmark still
  // leaves every completed measurement on disk.
  const records = await runBenchmark({
    benchmarkRunId,
    providers,
    scenarios: SCENARIOS,
    repetitions: REPETITIONS,
    warmup: WARMUP,
    log,
    onRecord: async (record) => {
      await appendFile(rawPath, toJsonl(record), "utf8");
    },
  });

  const finishedAtIso = new Date().toISOString();
  const reportInput = {
    benchmarkRunId,
    startedAtIso,
    finishedAtIso,
    records,
    configs: configNotes().filter((c) => modelIds.includes(c.model)),
    scenarioTitles: Object.fromEntries(SCENARIOS.map((s) => [s.id, s.title])),
    scenarioIntents: Object.fromEntries(SCENARIOS.map((s) => [s.id, s.intent])),
    scenarioFingerprints: Object.fromEntries(SCENARIOS.map((s) => [s.id, scenarioInputFingerprint(s)])),
  };

  await writeFile(path.join(dir, "report.md"), buildMarkdownReport(reportInput), "utf8");
  await writeFile(
    path.join(dir, "report.json"),
    `${JSON.stringify(buildJsonReport(reportInput), null, 2)}\n`,
    "utf8",
  );

  log("");
  log(`  report: ${path.join(dir, "report.md")}`);
  log(`  json:   ${path.join(dir, "report.json")}`);
  log("");
  return 0;
}

/**
 * Entry-point guard. `main` runs only when this file IS the process
 * entry, so importing it from a test cannot start a billed run.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
