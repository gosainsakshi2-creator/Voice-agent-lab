/**
 * report.ts — renders the evidence.
 *
 * PHASE 4, EVIDENCE STEP. Pure: records in, strings out. No I/O, no
 * clock, no network.
 *
 * ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────────
 *
 * It does not score a provider, rank providers, pick a winner, or
 * derive any quality number from any measurement. It reports what each
 * vendor was sent, what it returned, how long it took and how big the
 * audio was, and it stops there.
 *
 * That restraint is the point of the step, not modesty about the code.
 * A pronunciation judgement is made by a person listening to a name in
 * their own language; a byte count and a millisecond cannot stand in
 * for one, and a harness that produced a league table would invite
 * exactly the tuning decision this phase exists to postpone until
 * there is evidence for it. The same rule is already written into
 * `benchmark/llm/report.ts`.
 *
 * ── DETERMINISM, STATED IN THE REPORT ITSELF ──────────────────────
 *
 * The corpus, the transformations and the request text are fully
 * deterministic: same source, same corpus, same configuration, same
 * strings, every time. The AUDIO is not — these are generative models
 * and two runs of identical text differ. Every report says so in both
 * renderings, because a reader comparing two runs needs to know which
 * half of the evidence is allowed to move.
 */

import {
  CORPUS_VERSION,
  corpusFingerprint,
  countByCategory,
  type CorpusItem,
} from "./corpus";
import type { EffectiveConfig } from "./providers";
import type { EvidenceRecord, SynthesisErrorCategory } from "./runner";
import { mismatches } from "./transform";

export interface ReportInput {
  readonly runId: string;
  readonly mode: "dry-run" | "synthesize";
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  /** Short git revision, or undefined when it could not be read safely. */
  readonly gitRevision?: string;
  readonly gitDirty?: boolean;
  readonly items: readonly CorpusItem[];
  readonly configs: readonly EffectiveConfig[];
  readonly records: readonly EvidenceRecord[];
  readonly outputDir: string;
}

const DETERMINISM_NOTE =
  "Corpus, text transformations and the exact string sent to each vendor are DETERMINISTIC: " +
  "the same source code, corpus and provider configuration reproduce them byte for byte. " +
  "The generated AUDIO is NOT deterministic - these are generative models, and two runs of " +
  "identical text will differ. Compare text and configuration across runs; listen to audio " +
  "within a run.";

const NO_SCORING_NOTE =
  "This report contains no quality score, no ranking and no recommended provider. " +
  "Byte counts and latencies are observations, not verdicts.";

const TIMING_NOTE =
  "Latencies are measured from the machine that ran the harness, over its network, one " +
  "request at a time. They are NOT comparable with production p50s from call_metrics.";

export interface ProviderSummary {
  readonly providerId: string;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly totalAudioBytes: number;
  readonly totalAudioMs: number;
  readonly firstAudioMsMedian?: number;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

export function summarizeProvider(
  providerId: string,
  records: readonly EvidenceRecord[],
): ProviderSummary {
  const mine = records.filter((record) => record.providerId === providerId);
  const synthesized = mine.filter((record) => record.synthesis !== undefined);
  const ok = synthesized.filter((record) => record.synthesis?.ok === true);
  const firstAudio = ok
    .map((record) => record.synthesis?.firstAudioMs)
    .filter((value): value is number => typeof value === "number");

  const summary: ProviderSummary = {
    providerId,
    attempted: synthesized.length,
    succeeded: ok.length,
    failed: synthesized.length - ok.length,
    totalAudioBytes: ok.reduce((sum, r) => sum + (r.synthesis?.audioBytes ?? 0), 0),
    totalAudioMs: ok.reduce((sum, r) => sum + (r.synthesis?.durationMs ?? 0), 0),
  };
  const med = median(firstAudio);
  return med === undefined ? summary : { ...summary, firstAudioMsMedian: med };
}

export function failuresByReason(
  records: readonly EvidenceRecord[],
): ReadonlyMap<SynthesisErrorCategory, readonly EvidenceRecord[]> {
  const grouped = new Map<SynthesisErrorCategory, EvidenceRecord[]>();
  for (const record of records) {
    const category = record.synthesis?.errorCategory;
    if (!category) continue;
    const bucket = grouped.get(category) ?? [];
    bucket.push(record);
    grouped.set(category, bucket);
  }
  return grouped;
}

/** The machine-readable report. Contains no secret and no scoring. */
export function buildJsonReport(input: ReportInput): Record<string, unknown> {
  const providerIds = input.configs.map((config) => config.providerId);
  const transformOnly = input.records.filter((r) => r.providerId === providerIds[0]);

  return {
    schema: "voice-agent-lab/tts-evidence/1",
    run: {
      runId: input.runId,
      mode: input.mode,
      startedAtIso: input.startedAtIso,
      finishedAtIso: input.finishedAtIso,
      gitRevision: input.gitRevision ?? null,
      gitWorkingTreeDirty: input.gitDirty ?? null,
      outputDir: input.outputDir,
    },
    corpus: {
      version: CORPUS_VERSION,
      fingerprint: corpusFingerprint(input.items),
      itemCount: input.items.length,
      byCategory: Object.fromEntries(countByCategory(input.items)),
      exhaustive: false,
    },
    notes: {
      determinism: DETERMINISM_NOTE,
      scoring: NO_SCORING_NOTE,
      timing: TIMING_NOTE,
      transformPath:
        "formatForSpeech -> pronounceForSpeech -> provider. stripMarkdown (module-private in " +
        "conversation-pipeline.ts) is NOT applied; no corpus item contains markdown.",
      chunking:
        "Each corpus item is ONE synthesis request. The production sentence chunker is not " +
        "reproduced here, so chunk-boundary seams are out of scope for this evidence.",
    },
    providers: input.configs.map((config) => ({
      providerId: config.providerId,
      displayName: config.displayName,
      settings: config.settings,
      speakingRate: {
        parameter: config.rate.parameter,
        declaredValue: config.rate.declaredValue,
        source: `${config.rate.sourceFile} (${config.rate.constantName})`,
        appliedOn: config.rate.appliedOn,
        note: "Hard-coded in the adapter, not configurable. Guarded by tts-evidence-harness-tests.",
      },
      languageMapping: config.languageMapping,
      credentialEnv: config.apiKeyEnv,
      credentialPresent: config.apiKeyPresent,
    })),
    transformations: transformOnly.map((record) => {
      const item = input.items.find((candidate) => candidate.id === record.corpusId);
      return {
        corpusId: record.corpusId,
        category: record.category,
        language: record.transform.language,
        note: item?.note ?? null,
        originalText: record.transform.originalText,
        formattedText: record.transform.formattedText,
        synthesisText: record.transform.synthesisText,
        changed: record.transform.changed,
        changedBy: record.transform.changedBy,
        declaredExpectation: record.transform.declaredExpectation,
        verdict: record.transform.verdict,
        stripMarkdownApplied: record.transform.stripMarkdownApplied,
      };
    }),
    synthesis: input.records
      .filter((record) => record.synthesis !== undefined)
      .map((record) => ({
        providerId: record.providerId,
        corpusId: record.corpusId,
        language: record.transform.language,
        synthesisText: record.transform.synthesisText,
        ok: record.synthesis?.ok,
        branch: record.synthesis?.branch,
        chunkCount: record.synthesis?.chunkCount,
        audioBytes: record.synthesis?.audioBytes,
        sampleRateHz: record.synthesis?.sampleRateHz ?? null,
        encoding: record.synthesis?.encoding ?? null,
        durationMs: record.synthesis?.durationMs ?? null,
        firstAudioMs: record.synthesis?.firstAudioMs ?? null,
        totalMs: record.synthesis?.totalMs,
        audioPath: record.audioPath ?? null,
        errorCategory: record.synthesis?.errorCategory ?? null,
        errorMessage: record.synthesis?.errorMessage ?? null,
      })),
    summary: {
      byProvider: providerIds.map((id) => summarizeProvider(id, input.records)),
      transformationMismatches: mismatches(transformOnly.map((r) => r.transform)).map((r) => r.corpusId),
      failuresByReason: Object.fromEntries(
        [...failuresByReason(input.records)].map(([reason, records]) => [
          reason,
          records.map((record) => ({ providerId: record.providerId, corpusId: record.corpusId })),
        ]),
      ),
    },
  };
}

function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const head = `| ${header?.join(" | ")} |`;
  const rule = `| ${(header ?? []).map(() => "---").join(" | ")} |`;
  const lines = body.map((row) => `| ${row.join(" | ")} |`);
  return [head, rule, ...lines].join("\n");
}

/** Escapes a cell so a pipe or newline in corpus text cannot break the table. */
function cell(text: string): string {
  return text.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

/** The human-readable report. Same facts, same refusals. */
export function buildMarkdownReport(input: ReportInput): string {
  const providerIds = input.configs.map((config) => config.providerId);
  const transformOnly = input.records.filter((r) => r.providerId === providerIds[0]);
  const out: string[] = [];

  out.push(`# TTS EVIDENCE BASELINE — ${input.runId}`);
  out.push("");
  out.push(`*Phase 4, evidence step. Mode: **${input.mode}**.*`);
  out.push("");
  out.push(`- started: ${input.startedAtIso}`);
  out.push(`- finished: ${input.finishedAtIso}`);
  out.push(`- git revision: ${input.gitRevision ?? "(unavailable)"}${input.gitDirty ? " (working tree dirty)" : ""}`);
  out.push(`- corpus: ${CORPUS_VERSION}, ${input.items.length} items, fingerprint \`${corpusFingerprint(input.items)}\``);
  out.push(`- output dir: \`${input.outputDir}\``);
  out.push("");
  out.push(`> ${DETERMINISM_NOTE}`);
  out.push("");
  out.push(`> ${NO_SCORING_NOTE}`);
  out.push("");
  out.push("The corpus is a fixed sample covering the shapes the Phase 4 audit named. It is **not exhaustive** and proves nothing about coverage.");
  out.push("");

  out.push("## Provider configuration used by this run");
  out.push("");
  for (const config of input.configs) {
    out.push(`### ${config.displayName} (\`${config.providerId}\`)`);
    out.push("");
    for (const [label, value] of Object.entries(config.settings)) {
      out.push(`- **${label}**: ${value}`);
    }
    out.push(
      `- **${config.rate.parameter}**: ${config.rate.declaredValue} — hard-coded in \`${config.rate.sourceFile}\` (\`${config.rate.constantName}\`), applied on ${config.rate.appliedOn}`,
    );
    out.push(`- **language mapping**: ${config.languageMapping}`);
    out.push(`- **credential**: \`${config.apiKeyEnv}\` ${config.apiKeyPresent ? "present" : "MISSING"} (value never read or reported)`);
    out.push("");
  }

  out.push("## Text transformation — what each provider is sent");
  out.push("");
  out.push("Identical for every provider: one text buffer is produced, then handed to whichever lane the contact was allocated to.");
  out.push("");
  out.push(
    table([
      ["id", "lang", "original", "after formatForSpeech", "SENT TO PROVIDER", "changed", "vs declared"],
      ...transformOnly.map((record) => [
        `\`${record.corpusId}\``,
        record.transform.language,
        cell(record.transform.originalText),
        record.transform.formattedText === record.transform.originalText
          ? "_(same)_"
          : cell(record.transform.formattedText),
        cell(record.transform.synthesisText),
        record.transform.changed ? record.transform.changedBy.join(" + ") : "no",
        record.transform.verdict === "match" ? "ok" : "**MISMATCH**",
      ]),
    ]),
  );
  out.push("");

  const mismatched = mismatches(transformOnly.map((r) => r.transform));
  if (mismatched.length > 0) {
    out.push("### Declaration mismatches");
    out.push("");
    out.push("The corpus declaration no longer describes what the code does. Read why before re-baselining the corpus.");
    out.push("");
    for (const result of mismatched) {
      out.push(`- \`${result.corpusId}\`: declared ${result.declaredExpectation}, observed ${result.changed ? "transformed" : "unchanged"}`);
    }
    out.push("");
  }

  if (input.mode === "dry-run") {
    out.push("## Synthesis");
    out.push("");
    out.push("**Not performed.** This was a dry run: zero vendor requests, zero audio, zero credit spent.");
    out.push("");
    return `${out.join("\n")}\n`;
  }

  out.push("## Synthesis results");
  out.push("");
  out.push(`> ${TIMING_NOTE}`);
  out.push("");
  for (const providerId of providerIds) {
    const mine = input.records.filter((r) => r.providerId === providerId && r.synthesis);
    if (mine.length === 0) continue;
    out.push(`### ${providerId}`);
    out.push("");
    out.push(
      table([
        ["id", "ok", "branch", "chunks", "bytes", "audio ms", "first audio ms", "total ms", "file"],
        ...mine.map((record) => [
          `\`${record.corpusId}\``,
          record.synthesis?.ok ? "yes" : `NO (${record.synthesis?.errorCategory})`,
          record.synthesis?.branch ?? "",
          String(record.synthesis?.chunkCount ?? ""),
          String(record.synthesis?.audioBytes ?? ""),
          String(record.synthesis?.durationMs ?? ""),
          String(record.synthesis?.firstAudioMs ?? ""),
          String(record.synthesis?.totalMs ?? ""),
          record.audioPath ? `\`${record.audioPath}\`` : "",
        ]),
      ]),
    );
    out.push("");
  }

  out.push("## Summary by provider");
  out.push("");
  out.push(
    table([
      ["provider", "attempted", "ok", "failed", "audio bytes", "audio ms", "median first-audio ms"],
      ...providerIds.map((id) => {
        const summary = summarizeProvider(id, input.records);
        return [
          id,
          String(summary.attempted),
          String(summary.succeeded),
          String(summary.failed),
          String(summary.totalAudioBytes),
          String(summary.totalAudioMs),
          summary.firstAudioMsMedian === undefined ? "n/a" : String(summary.firstAudioMsMedian),
        ];
      }),
    ]),
  );
  out.push("");

  const failures = failuresByReason(input.records);
  out.push("## Failures by reason");
  out.push("");
  if (failures.size === 0) {
    out.push("None.");
  } else {
    for (const [reason, records] of failures) {
      out.push(`### ${reason} (${records.length})`);
      out.push("");
      for (const record of records) {
        out.push(`- \`${record.providerId}\` / \`${record.corpusId}\`: ${cell(record.synthesis?.errorMessage ?? "")}`);
      }
      out.push("");
    }
  }
  out.push("");

  return `${out.join("\n")}\n`;
}
