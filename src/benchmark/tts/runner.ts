/**
 * runner.ts — drives one provider over the corpus.
 *
 * PHASE 4, EVIDENCE STEP. Touches no filesystem: audio is handed to
 * the caller through `onAudio`, which is what keeps every write in
 * `cli.ts` and lets the tests drive this file with a fake provider and
 * no disk at all.
 *
 * ── IT SYNTHESIZES THE WAY PRODUCTION SYNTHESIZES ─────────────────
 *
 * `conversation-pipeline.ts::synthesizeAndPlay` feature-detects
 * `synthesizeStream` and falls back to `synthesize`. All four
 * configured adapters implement the streaming member, so streaming IS
 * the production path on every lane and the batch branch is currently
 * unreachable in a real call. This runner makes the same choice, by
 * the same feature detection, and records which branch it took — a
 * report that did not say so could be comparing a streamed lane
 * against a batched one.
 *
 * What it deliberately does NOT reproduce: the sentence chunker. On a
 * live call a long reply is cut into several TTS requests and the
 * seams are audible. Here every corpus item is ONE request, because
 * the question this evidence answers is how a vendor reads a given
 * string — not how the chunker splits a paragraph. Chunk-boundary
 * behaviour is a separate measurement and is out of scope for this
 * step.
 *
 * ── TIMING ────────────────────────────────────────────────────────
 *
 * `firstAudioMs` is wall-clock from the call to the first chunk that
 * carries bytes, i.e. the same instant `synthesizeAndPlay` marks
 * `tts-first-chunk`. It is a vendor-latency observation made from a
 * developer machine over whatever network is present; it is NOT
 * comparable to production p50s and the report says so. `durationMs`
 * is real audio time, computed from the returned bytes by the
 * platform's own `estimateAudioSeconds`.
 */

import { estimateAudioSeconds } from "../../core/session/audio-utils";
import type { AudioEncoding } from "../../types/provider.types";
import type { TextToSpeechProvider } from "../../interfaces/providers/text-to-speech-provider.interface";
import type { SessionId } from "../../types/session.types";
import type { CorpusItem } from "./corpus";
import { transformItem, type TransformResult } from "./transform";

/**
 * Failure buckets, coarse on purpose. The report groups by these so a
 * run that failed for one reason cannot look like four unrelated
 * problems.
 */
export type SynthesisErrorCategory =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "VENDOR_OR_NETWORK"
  | "EMPTY_AUDIO"
  | "UNKNOWN";

export interface SynthesisOutcome {
  readonly ok: boolean;
  readonly branch: "synthesizeStream" | "synthesize";
  readonly chunkCount: number;
  readonly audioBytes: number;
  readonly sampleRateHz?: number;
  readonly encoding?: AudioEncoding;
  /** Real audio time of what came back. */
  readonly durationMs?: number;
  /** Wall clock to the first chunk carrying bytes. Streaming branch only. */
  readonly firstAudioMs?: number;
  /** Wall clock for the whole call. */
  readonly totalMs: number;
  readonly errorCategory?: SynthesisErrorCategory;
  readonly errorMessage?: string;
}

export interface EvidenceRecord {
  readonly providerId: string;
  readonly corpusId: string;
  readonly category: CorpusItem["category"];
  readonly transform: TransformResult;
  /** Undefined on a dry run — no vendor was contacted. */
  readonly synthesis?: SynthesisOutcome;
  /** Repo-relative, deterministic. Present only when audio was written. */
  readonly audioPath?: string;
}

/**
 * Where a lane's audio for one corpus item lives.
 *
 * Deterministic and collision-safe by construction: corpus ids are
 * asserted unique by the harness tests and are restricted to
 * `[a-z0-9-]`, so no id can escape its directory, collide with another
 * after case-folding on Windows, or need escaping. Re-running
 * overwrites in place, which is what makes two runs of the same corpus
 * directly diffable.
 */
export function audioRelativePath(outputDir: string, providerId: string, corpusId: string): string {
  return `${outputDir}/${providerId}/${corpusId}/${corpusId}.wav`;
}

/** Corpus ids and provider ids must both satisfy this to be path-safe. */
export const SAFE_ID_PATTERN = /^[a-z0-9-]+$/u;

function categorize(error: unknown): SynthesisErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "ConfigurationError" || /missing required environment variable/iu.test(message)) {
    return "CONFIGURATION";
  }
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid api key|subscription-key/iu.test(message)) {
    return "AUTHENTICATION";
  }
  if (/\b4\d\d\b|\b5\d\d\b|fetch|socket|econn|enotfound|etimedout|timeout|network|stream/iu.test(message)) {
    return "VENDOR_OR_NETWORK";
  }
  return "UNKNOWN";
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Synthesizes ONE corpus item. Returns the outcome and, on success,
 * the raw PCM — the caller decides whether to write it.
 */
export async function synthesizeOne(
  provider: TextToSpeechProvider,
  item: CorpusItem,
  synthesisText: string,
  sessionId: string,
): Promise<{ outcome: SynthesisOutcome; pcm?: Uint8Array }> {
  const task = {
    sessionId: sessionId as SessionId,
    request: { text: synthesisText, language: item.language },
  };
  const startedAt = Date.now();

  if (provider.synthesizeStream) {
    const parts: Uint8Array[] = [];
    let total = 0;
    let chunkCount = 0;
    let firstAudioMs: number | undefined;
    let sampleRateHz: number | undefined;
    let encoding: AudioEncoding | undefined;
    try {
      for await (const chunk of provider.synthesizeStream(task)) {
        if (chunk.audio.data.byteLength === 0) continue; // final marker
        if (firstAudioMs === undefined) firstAudioMs = Date.now() - startedAt;
        chunkCount += 1;
        sampleRateHz = chunk.audio.sampleRateHz;
        encoding = chunk.audio.encoding;
        parts.push(chunk.audio.data);
        total += chunk.audio.data.byteLength;
      }
    } catch (error) {
      return {
        outcome: {
          ok: false,
          branch: "synthesizeStream",
          chunkCount,
          audioBytes: total,
          totalMs: Date.now() - startedAt,
          ...(sampleRateHz !== undefined ? { sampleRateHz } : {}),
          ...(encoding !== undefined ? { encoding } : {}),
          ...(firstAudioMs !== undefined ? { firstAudioMs } : {}),
          errorCategory: categorize(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const totalMs = Date.now() - startedAt;
    if (total === 0 || sampleRateHz === undefined || encoding === undefined) {
      return {
        outcome: {
          ok: false,
          branch: "synthesizeStream",
          chunkCount,
          audioBytes: 0,
          totalMs,
          errorCategory: "EMPTY_AUDIO",
          errorMessage: "the provider completed without yielding any audio bytes",
        },
      };
    }

    const pcm = concat(parts, total);
    return {
      outcome: {
        ok: true,
        branch: "synthesizeStream",
        chunkCount,
        audioBytes: total,
        sampleRateHz,
        encoding,
        durationMs: Math.round(estimateAudioSeconds({ data: pcm, encoding, sampleRateHz }) * 1000),
        totalMs,
        ...(firstAudioMs !== undefined ? { firstAudioMs } : {}),
      },
      pcm,
    };
  }

  try {
    const audio = await provider.synthesize(task);
    const totalMs = Date.now() - startedAt;
    if (audio.data.byteLength === 0) {
      return {
        outcome: {
          ok: false,
          branch: "synthesize",
          chunkCount: 0,
          audioBytes: 0,
          totalMs,
          errorCategory: "EMPTY_AUDIO",
          errorMessage: "the provider returned an empty payload",
        },
      };
    }
    return {
      outcome: {
        ok: true,
        branch: "synthesize",
        chunkCount: 1,
        audioBytes: audio.data.byteLength,
        sampleRateHz: audio.sampleRateHz,
        encoding: audio.encoding,
        durationMs: Math.round(estimateAudioSeconds(audio) * 1000),
        totalMs,
      },
      pcm: audio.data,
    };
  } catch (error) {
    return {
      outcome: {
        ok: false,
        branch: "synthesize",
        chunkCount: 0,
        audioBytes: 0,
        totalMs: Date.now() - startedAt,
        errorCategory: categorize(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export interface RunProviderOptions {
  readonly providerId: string;
  readonly provider: TextToSpeechProvider;
  readonly items: readonly CorpusItem[];
  readonly outputDir: string;
  /** Receives the WAV-ready PCM. The runner itself never writes a file. */
  readonly onAudio: (relativePath: string, pcm: Uint8Array, outcome: SynthesisOutcome) => Promise<void>;
  readonly log?: (line: string) => void;
}

/**
 * One provider, the whole corpus, in corpus order.
 *
 * Sequential by design. A parallel run would interleave four vendors'
 * connections and make `firstAudioMs` a measurement of this machine's
 * network rather than of the vendor.
 */
export async function runProvider(options: RunProviderOptions): Promise<readonly EvidenceRecord[]> {
  const { providerId, provider, items, outputDir, onAudio, log } = options;
  const records: EvidenceRecord[] = [];

  for (const item of items) {
    const transform = transformItem(item);
    const { outcome, pcm } = await synthesizeOne(
      provider,
      item,
      transform.synthesisText,
      `tts-evidence-${providerId}-${item.id}`,
    );

    let audioPath: string | undefined;
    if (outcome.ok && pcm) {
      audioPath = audioRelativePath(outputDir, providerId, item.id);
      await onAudio(audioPath, pcm, outcome);
    }

    log?.(
      outcome.ok
        ? `    [ok]   ${item.id}  ${outcome.audioBytes}B  ${outcome.durationMs ?? "?"}ms audio  first=${outcome.firstAudioMs ?? "n/a"}ms`
        : `    [FAIL] ${item.id}  ${outcome.errorCategory}: ${outcome.errorMessage ?? ""}`,
    );

    records.push({
      providerId,
      corpusId: item.id,
      category: item.category,
      transform,
      synthesis: outcome,
      ...(audioPath !== undefined ? { audioPath } : {}),
    });
  }

  // Session-scoped vendor resources (Sarvam pre-opens a socket) are
  // released the way the pipeline releases them at call teardown.
  if (provider.disposeSession) {
    for (const item of items) {
      try {
        provider.disposeSession(`tts-evidence-${providerId}-${item.id}` as SessionId);
      } catch {
        // Contractually must not throw; ignored here for the same reason.
      }
    }
  }

  return records;
}

/** Dry-run records: transformation only, no vendor contacted. */
export function dryRunRecords(
  providerIds: readonly string[],
  items: readonly CorpusItem[],
): readonly EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  for (const providerId of providerIds) {
    for (const item of items) {
      records.push({
        providerId,
        corpusId: item.id,
        category: item.category,
        transform: transformItem(item),
      });
    }
  }
  return records;
}
