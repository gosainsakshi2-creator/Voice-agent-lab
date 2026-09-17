/**
 * cli.ts — `npm run bench:tts`
 *
 * PHASE 4, EVIDENCE STEP. The ONLY file in this harness that
 * constructs a provider, touches the filesystem, or can reach a
 * vendor — and it does none of those at import time.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────
 *
 * It is a baseline recorder. It sends a fixed corpus through the
 * EXISTING text passes and the EXISTING provider adapters at their
 * CURRENT settings, and writes down what went out and what came back.
 *
 * It is not a fix, a tuning pass, or a pronunciation mechanism. It
 * changes no adapter, no constant, no prompt, no allocation and no
 * call-path file. If a run makes a provider sound bad, that is the
 * evidence working.
 *
 * ── COST SAFETY ───────────────────────────────────────────────────
 *
 * This harness places NO telephone call, writes NO database row,
 * touches NO campaign, contact or session. It does, however, make real
 * billed TTS requests when asked to.
 *
 * So it follows `bench:llm`'s gate exactly: `main()` runs only when
 * this module is the process entry point, the default mode is a dry
 * run that contacts nobody, and synthesis requires BOTH `--synthesize`
 * and `--confirm-real-api-calls`. Providers are constructed only past
 * that gate, because construction is where the API keys are read and
 * an unconfirmed invocation has no business touching them.
 *
 * ── WHAT IS WRITTEN, AND WHERE ────────────────────────────────────
 *
 *   benchmark-output/tts/report.json          machine-readable
 *   benchmark-output/tts/report.md            human-readable
 *   benchmark-output/tts/<provider>/<id>/<id>.wav
 *
 * A dry run writes `report.dry-run.json` / `report.dry-run.md`
 * instead, so planning a run can never overwrite the evidence from a
 * real one.
 *
 * `benchmark-output` is gitignored in full, so no audio and no report
 * is ever committed — the same convention `bench:llm` already relies
 * on. NO API KEY is written to any of it: the report records a
 * credential's variable NAME and whether it is present, never a value.
 */

import { config as loadEnvFile } from "dotenv";

// Same two lines, in the same order, as `bench:llm`'s CLI and the two
// campaign CLIs. At module scope because it must precede provider
// CONSTRUCTION, which is where keys are read. Loading a file into
// `process.env` makes no network request, so the "import calls
// nothing" property below is unaffected.
loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CORPUS, CORPUS_VERSION, corpusFingerprint } from "./corpus";
import { buildJsonReport, buildMarkdownReport } from "./report";
import {
  effectiveConfig,
  providerById,
  selectedProviderIds,
  type EffectiveConfig,
} from "./providers";
import { dryRunRecords, runProvider, type EvidenceRecord } from "./runner";
import { pcm16ToWav } from "./wav";

/** Gitignored. Audio and rendered reports land here. */
export const OUTPUT_DIR = "benchmark-output/tts";

export const SYNTHESIZE_FLAG = "--synthesize";
export const CONFIRM_FLAG = "--confirm-real-api-calls";
export const DRY_RUN_FLAG = "--dry-run";
export const PROVIDERS_FLAG = "--providers=";

export type Mode = "dry-run" | "synthesize";

/**
 * Resolves the mode from argv.
 *
 * Dry run is the default and `--dry-run` states it explicitly.
 * `--synthesize` alone is REFUSED rather than honoured: the project's
 * established cost gate is `--confirm-real-api-calls`, and a flag that
 * spends money must be typed as deliberately here as it is in
 * `bench:llm`. Refusing is also the safer failure — a run that did not
 * happen costs a re-run, a run that should not have happened costs
 * credit.
 */
export function resolveMode(argv: readonly string[]): { mode: Mode; refusal?: string } {
  const wantsSynthesis = argv.includes(SYNTHESIZE_FLAG);
  const confirmed = argv.includes(CONFIRM_FLAG);

  if (!wantsSynthesis) {
    if (confirmed) {
      return {
        mode: "dry-run",
        refusal: `${CONFIRM_FLAG} was given without ${SYNTHESIZE_FLAG}; nothing was synthesized.`,
      };
    }
    return { mode: "dry-run" };
  }
  if (!confirmed) {
    return {
      mode: "dry-run",
      refusal: `${SYNTHESIZE_FLAG} requires ${CONFIRM_FLAG}. No vendor request was made.`,
    };
  }
  if (argv.includes(DRY_RUN_FLAG)) {
    return {
      mode: "dry-run",
      refusal: `${DRY_RUN_FLAG} and ${SYNTHESIZE_FLAG} are contradictory; the safer one wins.`,
    };
  }
  return { mode: "synthesize" };
}

/**
 * Short git revision, or undefined.
 *
 * `execFileSync` with a fixed argv — no shell, so nothing here can be
 * influenced by a filename or an environment value. Any failure
 * (not a repository, git absent, timeout) is reported as "unavailable"
 * rather than failing the run: the revision is provenance, not a
 * prerequisite.
 */
export function gitRevision(): { revision?: string; dirty?: boolean } {
  try {
    const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return {};
  }
}

function printPlan(
  log: (line: string) => void,
  mode: Mode,
  configs: readonly EffectiveConfig[],
): void {
  const requests = configs.length * CORPUS.length;
  log("");
  log("  TTS EVIDENCE HARNESS — PLAN");
  log("  ────────────────────────────────────────────────");
  log(`  corpus            ${CORPUS_VERSION}  (${CORPUS.length} items, ${corpusFingerprint()})`);
  log(`  providers         ${configs.length}  (${configs.map((c) => c.providerId).join(", ")})`);
  log(`  requests          ${requests}  = ${configs.length} providers x ${CORPUS.length} items`);
  log(`  mode              ${mode}`);
  if (mode === "synthesize") {
    log(`  vendor requests   ${requests}  — REAL, BILLED`);
  } else {
    log(`  vendor requests   0  — nothing is contacted`);
  }
  log("  telephony         none.  database  none.  campaign/contact  none.");
  log("  ────────────────────────────────────────────────");
  log("");
}

export async function main(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const { mode, refusal } = resolveMode(argv);
  const providerIds = selectedProviderIds(argv, PROVIDERS_FLAG);
  const providers = providerIds.map(providerById);
  const configs = providers.map(effectiveConfig);

  printPlan(log, mode, configs);
  if (refusal) {
    log(`  ${refusal}`);
    log("");
  }

  const runId = `tts_${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const startedAtIso = new Date().toISOString();
  const dir = path.join(process.cwd(), OUTPUT_DIR);
  await mkdir(dir, { recursive: true });

  let records: readonly EvidenceRecord[];

  if (mode === "dry-run") {
    records = dryRunRecords(providerIds, CORPUS);
    log("  dry run: corpus transformed, configuration read, NO vendor contacted.");
  } else {
    const missing = configs.filter((config) => !config.apiKeyPresent);
    if (missing.length > 0) {
      log("  REFUSING TO RUN. Missing credentials for:");
      for (const config of missing) log(`    ${config.providerId}  (${config.apiKeyEnv})`);
      log("");
      log("  Set them, or narrow the run with --providers=<ids>.");
      log("");
      return 1;
    }

    const collected: EvidenceRecord[] = [];
    for (const provider of providers) {
      log(`  ${provider.displayName} (${provider.id})`);
      // Constructed only past the confirmation gate, and only for the
      // lanes this run selected, so a single-provider run never reads
      // another vendor's key and cannot reach that vendor at all.
      const adapter = provider.construct();
      const providerRecords = await runProvider({
        providerId: provider.id,
        provider: adapter,
        items: CORPUS,
        outputDir: OUTPUT_DIR,
        log,
        onAudio: async (relativePath, pcm, outcome) => {
          const absolute = path.join(process.cwd(), relativePath);
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(
            absolute,
            pcm16ToWav(pcm, outcome.sampleRateHz ?? 0, outcome.encoding ?? "PCM_16"),
          );
        },
      });
      collected.push(...providerRecords);
    }
    records = collected;
  }

  const reportInput = {
    runId,
    mode,
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    items: CORPUS,
    configs,
    records,
    outputDir: OUTPUT_DIR,
    ...gitRevisionFields(),
  };

  const suffix = mode === "dry-run" ? ".dry-run" : "";
  const jsonPath = path.join(dir, `report${suffix}.json`);
  const mdPath = path.join(dir, `report${suffix}.md`);
  await writeFile(jsonPath, `${JSON.stringify(buildJsonReport(reportInput), null, 2)}\n`, "utf8");
  await writeFile(mdPath, buildMarkdownReport(reportInput), "utf8");

  log("");
  log(`  report: ${mdPath}`);
  log(`  json:   ${jsonPath}`);
  if (mode === "dry-run") {
    log("");
    log(`  To synthesize for real: npm run bench:tts -- ${SYNTHESIZE_FLAG} ${CONFIRM_FLAG}`);
  }
  log("");
  return 0;
}

/** Keeps `exactOptionalPropertyTypes` happy without an `any` in the report input. */
function gitRevisionFields(): { gitRevision?: string; gitDirty?: boolean } {
  const { revision, dirty } = gitRevision();
  return {
    ...(revision !== undefined ? { gitRevision: revision } : {}),
    ...(dirty !== undefined ? { gitDirty: dirty } : {}),
  };
}

/**
 * Entry-point guard. `main` runs only when this file IS the process
 * entry, so importing it from a test cannot start a run of any kind.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
