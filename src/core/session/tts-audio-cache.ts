/**
 * tts-audio-cache.ts
 *
 * Synthesized audio for lines that are the same on every call — the
 * hearing line, the silence prompts, the fixed closes — so each is paid
 * for once instead of on every call that says it. Real calls measured
 * TTS first audio at p50 ~180ms / p90 ~490ms (2026-09-28), and these
 * lines are spoken exactly when the caller is already waiting.
 *
 * TWO TIERS, READ IN ORDER:
 *   1. memory — this process, byte-bounded LRU, ~0ms;
 *   2. a shared store (Postgres, `tts_audio_cache`) — every process,
 *      survives deploys, bounded by `readTimeoutMs`.
 * A clip found in the store is copied into memory; a clip synthesized
 * live is written to both.
 *
 * IT CAN NEVER BREAK A CALL. Every store read is raced against a short
 * timeout and every error is swallowed: the answer is then "not cached"
 * and the line is synthesized live, exactly as it was before this file
 * existed. Writes are fire-and-forget.
 *
 * WHAT MAY BE CACHED IS DECIDED BY THE CALLER, NOT HERE. The pipeline
 * only asks for fixed lines with no contact name in them, and only on a
 * provider that states its request fingerprint (`cacheIdentity`) — see
 * `ttsCacheKeyFor` in the pipeline. This module stores bytes by key.
 */

import { createHash } from "node:crypto";

import type { AudioPayload } from "../../types/provider.types";

/** Bump when the pipeline changes what it does to audio before playback, so older clips are never read again. */
export const TTS_CACHE_SCHEMA = "tts-cache-v1";

/** The cache key: every input that shapes the audio, hashed. */
export function ttsCacheKey(providerId: string, providerIdentity: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([TTS_CACHE_SCHEMA, providerId, providerIdentity, text]), "utf8")
    .digest("hex");
}

/** The shared tier. Implementations may throw; `TtsAudioCache` contains every failure. */
export interface TtsAudioStore {
  get(key: string): Promise<AudioPayload | undefined>;
  put(key: string, providerId: string, audio: AudioPayload): Promise<void>;
}

export interface TtsAudioCacheOptions {
  /** Upper bound on the memory tier, in audio bytes. */
  readonly maxMemoryBytes?: number;
  /** How long a store read may take before the line is synthesized live instead. */
  readonly readTimeoutMs?: number;
}

export class TtsAudioCache {
  private readonly memory = new Map<string, AudioPayload>();
  private memoryBytes = 0;
  private readonly maxMemoryBytes: number;
  private readonly readTimeoutMs: number;

  constructor(
    private readonly store: TtsAudioStore | undefined,
    options: TtsAudioCacheOptions = {},
  ) {
    this.maxMemoryBytes = options.maxMemoryBytes ?? 64 * 1024 * 1024;
    this.readTimeoutMs = options.readTimeoutMs ?? 120;
  }

  /** The clip for `key`, or undefined — never throws, never waits past the read timeout. */
  async get(key: string): Promise<{ readonly audio: AudioPayload; readonly tier: "memory" | "store" } | undefined> {
    const inMemory = this.memory.get(key);
    if (inMemory !== undefined) {
      // Refresh recency: a Map iterates in insertion order.
      this.memory.delete(key);
      this.memory.set(key, inMemory);
      return { audio: inMemory, tier: "memory" };
    }
    if (this.store === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.readTimeoutMs);
      });
      const found = await Promise.race([this.store.get(key).catch(() => undefined), timeout]);
      if (found === undefined || found.data.length === 0) return undefined;
      this.remember(key, found);
      return { audio: found, tier: "store" };
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Keep a clip synthesized live. Never throws; the store write is not awaited. */
  put(key: string, providerId: string, audio: AudioPayload): void {
    if (audio.data.length === 0) return;
    this.remember(key, audio);
    if (this.store === undefined) return;
    void this.store.put(key, providerId, audio).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[TTS-CACHE] store write failed — the line stays cached in this process only: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private remember(key: string, audio: AudioPayload): void {
    if (audio.data.length > this.maxMemoryBytes) return;
    const previous = this.memory.get(key);
    if (previous !== undefined) {
      this.memoryBytes -= previous.data.length;
      this.memory.delete(key);
    }
    this.memory.set(key, audio);
    this.memoryBytes += audio.data.length;
    // Evict least recently used until under the bound.
    for (const [oldKey, oldAudio] of this.memory) {
      if (this.memoryBytes <= this.maxMemoryBytes) break;
      this.memory.delete(oldKey);
      this.memoryBytes -= oldAudio.data.length;
    }
  }
}

/** Joins a streamed utterance into one clip. Undefined if the chunks do not share one format. */
export function joinAudioChunks(chunks: readonly AudioPayload[]): AudioPayload | undefined {
  const first = chunks[0];
  if (first === undefined) return undefined;
  if (chunks.some((c) => c.encoding !== first.encoding || c.sampleRateHz !== first.sampleRateHz)) return undefined;
  const total = chunks.reduce((sum, c) => sum + c.data.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return { data, encoding: first.encoding, sampleRateHz: first.sampleRateHz };
}

/** Minimal query surface, so the store can be driven by a pool or a test double. */
export interface SqlQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Postgres "undefined_table": migration 007 has not been run here. */
const UNDEFINED_TABLE = "42P01";

/** The Postgres tier — table `tts_audio_cache`, migration 007. */
export class PostgresTtsAudioStore implements TtsAudioStore {
  /** Set once the table is found missing: the store then stays out of the way, with one warning, not one per line. */
  private disabled = false;

  constructor(private readonly db: SqlQueryable) {}

  private async run(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> } | undefined> {
    if (this.disabled) return undefined;
    try {
      return await this.db.query(text, params);
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === UNDEFINED_TABLE) {
        this.disabled = true;
        // eslint-disable-next-line no-console
        console.warn("[TTS-CACHE] table tts_audio_cache does not exist (run `npm run db:migrate`) — caching in memory only");
        return undefined;
      }
      throw error;
    }
  }

  async get(key: string): Promise<AudioPayload | undefined> {
    const result = await this.run(
      "SELECT encoding, sample_rate_hz, audio FROM tts_audio_cache WHERE cache_key = $1",
      [key],
    );
    const row = result?.rows[0];
    if (row === undefined) return undefined;
    // Usage bookkeeping for pruning; never awaited, never allowed to fail the read.
    void this.run("UPDATE tts_audio_cache SET last_used_at = now(), hit_count = hit_count + 1 WHERE cache_key = $1", [key]).catch(
      () => undefined,
    );
    const audio = row.audio;
    const bytes = audio instanceof Uint8Array ? new Uint8Array(audio) : undefined;
    if (bytes === undefined || typeof row.encoding !== "string" || typeof row.sample_rate_hz !== "number") return undefined;
    return { data: bytes, encoding: row.encoding as AudioPayload["encoding"], sampleRateHz: row.sample_rate_hz };
  }

  async put(key: string, providerId: string, audio: AudioPayload): Promise<void> {
    await this.run(
      "INSERT INTO tts_audio_cache (cache_key, provider_id, encoding, sample_rate_hz, audio, byte_length) " +
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (cache_key) DO NOTHING",
      [key, providerId, audio.encoding, audio.sampleRateHz, Buffer.from(audio.data), audio.data.length],
    );
  }
}
