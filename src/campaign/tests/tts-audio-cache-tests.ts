/**
 * tts-audio-cache-tests.ts — `npm run test:tts-audio-cache`
 *
 * The TTS audio cache (src/core/session/tts-audio-cache.ts) and its use by
 * the pipeline:
 *
 *   SECTION K — the key: every input that shapes the audio moves it.
 *   SECTION M — the tiers: memory first, then the store; LRU by bytes; a
 *     slow, failing or empty store is "not cached", never an error.
 *   SECTION G — the Postgres store against the real DATABASE_URL, through
 *     TEMP tables on one dedicated connection (`SET search_path TO
 *     pg_temp`), so no real row is read or written. Skipped when there
 *     is no DATABASE_URL.
 *   SECTION P — the pipeline: a fixed line is synthesized once and then
 *     served from the cache; a line with the contact's name, a generated
 *     reply, a provider without `cacheIdentity` and a pipeline without a
 *     cache are all synthesized live exactly as before.
 *
 * NOTHING HERE PLACES A CALL OR CONTACTS A VENDOR.
 */

import assert from "node:assert/strict";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });

const { TtsAudioCache, PostgresTtsAudioStore, ttsCacheKey, joinAudioChunks } = await import("../../core/session/tts-audio-cache");
const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import("../../types/enums");

import type { AudioPayload, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId } from "../../types/session.types";
import type { TtsAudioStore } from "../../core/session/tts-audio-cache";

let passed = 0;
let skipped = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`);
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (bytes: number, fill = 1): AudioPayload => ({ data: new Uint8Array(bytes).fill(fill), encoding: "PCM_16", sampleRateHz: 8000 });

/** An in-memory store double whose behaviour a test can set. */
function fakeStore(mode: { delayMs?: number; fail?: boolean } = {}) {
  const rows = new Map<string, AudioPayload>();
  let gets = 0;
  const store: TtsAudioStore = {
    async get(key) {
      gets += 1;
      if (mode.delayMs) await sleep(mode.delayMs);
      if (mode.fail) throw new Error("store down");
      return rows.get(key);
    },
    async put(key, _providerId, audio) {
      if (mode.fail) throw new Error("store down");
      rows.set(key, audio);
    },
  };
  return { store, rows, gets: () => gets };
}

// ═════════════════════════════════════════════════════════════════
section("K. THE KEY");

await test("K1. provider, provider fingerprint and text each move the key; identical inputs do not", () => {
  const base = ttsCacheKey("cartesia", '{"voice":"a"}', "Hey, can you hear me okay?");
  assert.equal(base, ttsCacheKey("cartesia", '{"voice":"a"}', "Hey, can you hear me okay?"));
  assert.notEqual(base, ttsCacheKey("elevenlabs", '{"voice":"a"}', "Hey, can you hear me okay?"));
  assert.notEqual(base, ttsCacheKey("cartesia", '{"voice":"b"}', "Hey, can you hear me okay?"));
  assert.notEqual(base, ttsCacheKey("cartesia", '{"voice":"a"}', "Hey, can you hear me?"));
  assert.match(base, /^[0-9a-f]{64}$/);
});

// ═════════════════════════════════════════════════════════════════
section("M. THE TIERS");

await test("M1. a clip put is served from memory without touching the store", async () => {
  const s = fakeStore();
  const cache = new TtsAudioCache(s.store);
  cache.put("k", "p", clip(10));
  const hit = await cache.get("k");
  assert.equal(hit?.tier, "memory");
  assert.equal(s.gets(), 0);
});

await test("M2. a clip only in the store is served from it, then from memory", async () => {
  const s = fakeStore();
  s.rows.set("k", clip(10));
  const cache = new TtsAudioCache(s.store);
  assert.equal((await cache.get("k"))?.tier, "store");
  assert.equal((await cache.get("k"))?.tier, "memory");
  assert.equal(s.gets(), 1);
});

await test("M3. a SLOW store is a miss after the read timeout, not a wait", async () => {
  const s = fakeStore({ delayMs: 1000 });
  s.rows.set("k", clip(10));
  const cache = new TtsAudioCache(s.store, { readTimeoutMs: 50 });
  const started = Date.now();
  assert.equal(await cache.get("k"), undefined);
  assert.ok(Date.now() - started < 300, `waited ${Date.now() - started}ms`);
});

await test("M4. a FAILING store is a miss on read and silent on write", async () => {
  const s = fakeStore({ fail: true });
  const cache = new TtsAudioCache(s.store);
  assert.equal(await cache.get("nope"), undefined);
  cache.put("k", "p", clip(10));
  await sleep(20);
  assert.equal((await cache.get("k"))?.tier, "memory", "still cached in this process");
});

await test("M5. memory is bounded by bytes and evicts the least recently used", async () => {
  const cache = new TtsAudioCache(undefined, { maxMemoryBytes: 25 });
  cache.put("a", "p", clip(10));
  cache.put("b", "p", clip(10));
  await cache.get("a"); // a is now the most recent
  cache.put("c", "p", clip(10)); // 30 > 25: evicts b
  assert.ok(await cache.get("a"));
  assert.equal(await cache.get("b"), undefined);
  assert.ok(await cache.get("c"));
});

await test("M6. streamed chunks join into one clip; mixed formats do not", () => {
  const joined = joinAudioChunks([clip(3, 1), clip(2, 2)]);
  assert.deepEqual([...(joined?.data ?? [])], [1, 1, 1, 2, 2]);
  assert.equal(joinAudioChunks([clip(3), { ...clip(2), sampleRateHz: 16000 }]), undefined);
  assert.equal(joinAudioChunks([]), undefined);
});

// ═════════════════════════════════════════════════════════════════
section("G. THE POSTGRES STORE — TEMP tables only");

if (!process.env.DATABASE_URL) {
  skipped += 1;
  console.log("  [SKIP] no DATABASE_URL");
} else {
  // A connection from the project's own pool (its SSL and pooler settings),
  // DESTROYED afterwards so its pg_temp search_path never returns to the pool.
  const { getDbPool, closeDbPool } = await import("../db/client");
  const client = await getDbPool().connect();
  try {
    await client.query("SET search_path TO pg_temp");
    await client.query(`CREATE TEMP TABLE tts_audio_cache (
      cache_key TEXT PRIMARY KEY, provider_id TEXT NOT NULL, encoding TEXT NOT NULL,
      sample_rate_hz INTEGER NOT NULL, audio BYTEA NOT NULL, byte_length INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      hit_count INTEGER NOT NULL DEFAULT 0)`);
    const count = await client.query("SELECT count(*)::int AS n FROM tts_audio_cache");
    assert.equal(count.rows[0]?.n, 0, "the shadow must be empty before seeding — refusing to run against real data");

    // A bare Client interleaves concurrent queries; serialise them.
    let chain: Promise<unknown> = Promise.resolve();
    const runner = {
      query: (text: string, params?: unknown[]) => {
        const next = chain.then(() => client.query(text, params));
        chain = next.catch(() => undefined);
        return next as Promise<{ rows: Array<Record<string, unknown>> }>;
      },
    };
    const store = new PostgresTtsAudioStore(runner);

    await test("G1. put then get round-trips the exact bytes and format", async () => {
      const audio: AudioPayload = { data: new Uint8Array([0, 1, 2, 250, 255]), encoding: "PCM_16", sampleRateHz: 16000 };
      await store.put("key-1", "cartesia", audio);
      const back = await store.get("key-1");
      assert.deepEqual([...(back?.data ?? [])], [0, 1, 2, 250, 255]);
      assert.equal(back?.encoding, "PCM_16");
      assert.equal(back?.sampleRateHz, 16000);
    });

    await test("G2. a second put of the same key is a no-op, and a read counts as a use", async () => {
      await store.put("key-1", "cartesia", clip(3, 9));
      const back = await store.get("key-1");
      assert.equal(back?.data.length, 5, "the first clip stays");
      await chain;
      await sleep(50);
      const row = await client.query("SELECT hit_count FROM tts_audio_cache WHERE cache_key = 'key-1'");
      assert.ok((row.rows[0]?.hit_count ?? 0) >= 2);
    });

    await test("G3. an unknown key is undefined", async () => {
      assert.equal(await store.get("missing"), undefined);
    });
  } finally {
    client.release(true);
    await closeDbPool();
  }
}

// ═════════════════════════════════════════════════════════════════
// PIPELINE HARNESS — the real pipeline against local fakes.
// ═════════════════════════════════════════════════════════════════

const CHARS_PER_SECOND = 22;
const clipFor = (text: string): AudioPayload => ({
  data: new Uint8Array(Math.round(Math.max(0.05, text.length / CHARS_PER_SECOND) * 8000)),
  encoding: "MULAW",
  sampleRateHz: 8000,
});
const descriptor = (category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) => ({
  category, id, displayName: id, supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH], version: "fake",
});
const healthy = (identifier: { category: unknown; id: string }) => ({ provider: identifier, status: "HEALTHY", checkedAt: new Date(), latencyMs: 1 });

const OPENING = "Hello, this is Rohan from Team FlexiFunnels.";
const GENERATED = "Sure, happy to help with that.";

function startCall(input: { cache?: InstanceType<typeof TtsAudioCache>; identity?: boolean; customerName?: string }) {
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (): AsyncIterable<TranscriptSegment> {
      while (!closed) {
        const next = segments.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async () => ({ turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest) {
      if (request.history.length === 1) {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      yield { type: "token" as const, delta: GENERATED, index: 0 };
      yield { type: "final" as const, turn: { role: "assistant" as const, content: GENERATED, timestamp: new Date() }, latencyMs: 1 };
    },
  };
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      return clipFor(task.request.text);
    },
    ...(input.identity !== false ? { cacheIdentity: () => JSON.stringify({ voice: "fake-voice", rate: 8000 }) } : {}),
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts")),
  };
  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake-telephony")),
  };
  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
  };
  const record = new SessionRecord(
    "tts-cache-test" as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: stack,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test", campaignType: "registration", scriptId: "test", scriptVersion: "v1", scriptHash: "test",
        agent: { gender: "male", name: "Rohan" },
        customer: { name: input.customerName ?? "Sakshi Gupta" },
        openingLine: OPENING,
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );
  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => undefined);
  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
    end: async () => undefined,
  };
  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never, input.cache ? { ttsCache: input.cache } : {});
  const loop = pipeline.run();
  return {
    record,
    synthesized,
    say(text: string) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({ text, isFinal: true, isSpeechFinal: true, confidence: 0.95, language: SupportedLanguage.ENGLISH, startedAtMs, endedAtMs: clockMs });
      waiters.shift()?.();
    },
    async waitFor(what: string, predicate: () => boolean, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out waiting for: ${what}`);
    },
    assistantTurns: () => record.memory.history().filter((t) => t.role === "assistant").map((t) => t.content),
    async stop() {
      closed = true;
      for (const w of waiters.splice(0)) w();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

type Call = ReturnType<typeof startCall>;
const openingDone = (c: Call) => c.waitFor("the opening", () => c.assistantTurns().length >= 1 && c.record.state === SessionState.LISTENING);

/** One call: the opening, then one generated reply. Returns what TTS was asked to synthesize. */
async function oneCall(input: Parameters<typeof startCall>[0]): Promise<string[]> {
  const c = startCall(input);
  try {
    await openingDone(c);
    await sleep(200);
    c.say("What is this about?");
    await c.waitFor("the reply", () => c.assistantTurns().length >= 2 && c.record.state === SessionState.LISTENING);
    return [...c.synthesized];
  } finally {
    await c.stop();
  }
}

// ═════════════════════════════════════════════════════════════════
section("P. THE PIPELINE");

await test("P1. a fixed line is synthesized on the first call and served from the cache on the second", async () => {
  const cache = new TtsAudioCache(undefined);
  const first = await oneCall({ cache });
  const second = await oneCall({ cache });
  assert.ok(first.includes(OPENING), "call 1 synthesized the opening");
  assert.ok(!second.includes(OPENING), "call 2 did not");
});

await test("P2. a GENERATED reply is never cached — it is synthesized on both calls", async () => {
  const cache = new TtsAudioCache(undefined);
  const first = await oneCall({ cache });
  const second = await oneCall({ cache });
  assert.ok(first.includes(GENERATED) && second.includes(GENERATED));
});

await test("P3. a fixed line carrying the contact's name is never cached", async () => {
  const cache = new TtsAudioCache(undefined);
  // The opening names "Rohan"; make that the contact's name too.
  const first = await oneCall({ cache, customerName: "Rohan Mehta" });
  const second = await oneCall({ cache, customerName: "Rohan Mehta" });
  assert.ok(first.includes(OPENING) && second.includes(OPENING));
});

await test("P4. a provider without cacheIdentity is never cached", async () => {
  const cache = new TtsAudioCache(undefined);
  await oneCall({ cache, identity: false });
  const second = await oneCall({ cache, identity: false });
  assert.ok(second.includes(OPENING));
});

await test("P5. no cache configured: every line is synthesized live, as before", async () => {
  await oneCall({});
  const second = await oneCall({});
  assert.ok(second.includes(OPENING));
});

console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
process.exit();
