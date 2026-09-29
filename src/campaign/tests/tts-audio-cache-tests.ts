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
const { ConversationPipeline, fillerKindFor } = await import("../../core/session/conversation-pipeline");
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

await test("M7. peek reads memory only: a hit is synchronous, a miss never touches the store", () => {
  const s = fakeStore();
  s.rows.set("in-store", clip(10));
  const cache = new TtsAudioCache(s.store);
  cache.put("k", "p", clip(10));
  assert.equal(cache.peek("k")?.data.length, 10);
  assert.equal(cache.peek("in-store"), undefined);
  assert.equal(s.gets(), 0);
});

await test("M8. warm copies the store's recent clips into memory, once per interval", async () => {
  const s = fakeStore();
  let reads = 0;
  s.store.recent = async (providerId) => {
    reads += 1;
    return providerId === "p" ? [{ key: "w1", audio: clip(10) }, { key: "w2", audio: clip(10) }] : [];
  };
  const cache = new TtsAudioCache(s.store);
  assert.equal(cache.peek("w1"), undefined);
  cache.warm("p");
  cache.warm("p"); // already running: no second read
  await sleep(20);
  assert.ok(cache.peek("w1") && cache.peek("w2"));
  cache.warm("p"); // within the interval: no read
  assert.equal(reads, 1);
});

await test("M9. a failing warm is silent and leaves the cache working", async () => {
  const s = fakeStore();
  s.store.recent = async () => {
    throw new Error("store down");
  };
  const cache = new TtsAudioCache(s.store);
  cache.warm("p");
  await sleep(20);
  cache.put("k", "p", clip(10));
  assert.ok(cache.peek("k"));
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

    await test("G4. recent() returns one provider's clips used after 'since', newest first, within the byte budget", async () => {
      await store.put("old-1", "sarvam", clip(4, 1));
      await store.put("new-1", "sarvam", clip(4, 2));
      await store.put("new-2", "sarvam", clip(4, 3));
      await store.put("other", "elevenlabs", clip(4, 4));
      await chain;
      await client.query("UPDATE tts_audio_cache SET last_used_at = now() - interval '1 day' WHERE cache_key = 'old-1'");
      await client.query("UPDATE tts_audio_cache SET last_used_at = now() - interval '1 minute' WHERE cache_key = 'new-1'");
      const since = new Date(Date.now() - 60 * 60_000);
      const rows = await store.recent("sarvam", since, 1_000_000);
      assert.deepEqual(rows.map((r) => r.key), ["new-2", "new-1"]);
      assert.deepEqual([...(rows[1]?.audio.data ?? [])], [2, 2, 2, 2]);
      assert.deepEqual((await store.recent("sarvam", since, 4)).map((r) => r.key), ["new-2"], "byte budget");
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

function startCall(input: { cache?: InstanceType<typeof TtsAudioCache>; identity?: boolean; customerName?: string; generated?: boolean; reply?: string; shortClip?: boolean; fillers?: boolean; llmDelayMs?: number }) {
  const reply = input.reply ?? GENERATED;
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
      if (input.llmDelayMs) await sleep(input.llmDelayMs);
      yield { type: "token" as const, delta: reply, index: 0 };
      yield { type: "final" as const, turn: { role: "assistant" as const, content: reply, timestamp: new Date() }, latencyMs: 1 };
    },
  };
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      if (input.shortClip === true && task.request.text !== OPENING) return clipFor("x");
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
  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never, {
    ...(input.cache ? { ttsCache: input.cache } : {}),
    ...(input.generated === true ? { cacheGeneratedSentences: true } : {}),
    ...(input.fillers === true ? { fillers: true } : {}),
  });
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

await test("P6. cacheGeneratedSentences: a generated sentence is synthesized once, then served from memory", async () => {
  const cache = new TtsAudioCache(undefined);
  const first = await oneCall({ cache, generated: true });
  const second = await oneCall({ cache, generated: true });
  assert.ok(first.includes(GENERATED), "call 1 synthesized it");
  assert.ok(!second.includes(GENERATED), "call 2 did not");
});

await test("P7. a generated sentence with the contact's name is never cached", async () => {
  const cache = new TtsAudioCache(undefined);
  const reply = "Sure Sakshi, happy to help with that.";
  const first = await oneCall({ cache, generated: true, reply });
  const second = await oneCall({ cache, generated: true, reply });
  assert.ok(first.includes(reply) && second.includes(reply));
});

await test("P8. a generated clip far too short for its text (a stream cut short) is not kept", async () => {
  const cache = new TtsAudioCache(undefined);
  await oneCall({ cache, generated: true, shortClip: true });
  const second = await oneCall({ cache, generated: true });
  assert.ok(second.includes(GENERATED));
});

await test("P9. a generated sentence NEVER waits on the store: a slow store is not read at all", async () => {
  const s = fakeStore({ delayMs: 5000 });
  const cache = new TtsAudioCache(s.store, { readTimeoutMs: 100 });
  const first = await oneCall({ cache, generated: true });
  assert.ok(first.includes(GENERATED));
  // Only the opening (a fixed line) may read the store.
  assert.ok(s.gets() <= 1, `store reads: ${s.gets()}`);
});

// ═════════════════════════════════════════════════════════════════
section("F. LATENCY FILLERS");

/** Console lines tagged [FILLER: while `fn` runs. */
let capturedFillerLines: string[] = [];
async function fillerLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[]; echoes: string[] }> {
  const lines: string[] = [];
  const echoes: string[] = [];
  capturedFillerLines = lines;
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[FILLER:") && line.includes("speaking")) lines.push(line);
    if (line.includes("[FILLER:") && line.includes("echo")) echoes.push(line);
    original(...args);
  };
  try {
    return { result: await fn(), lines, echoes };
  } finally {
    console.log = original;
  }
}

/** One call answering a question; `echo` is said ~0.5s into a filler. */
async function fillerCall(input: Parameters<typeof startCall>[0], echo?: string) {
  const c = startCall(input);
  try {
    await openingDone(c);
    await sleep(200);
    c.say("What is this about?");
    if (echo !== undefined) {
      await c.waitFor("the filler", () => capturedFillerLines.length > 0);
      await sleep(100);
      c.say(echo);
    }
    await c.waitFor("the reply", () => c.assistantTurns().length >= 2 && c.record.state === SessionState.LISTENING);
    await sleep(300);
    return {
      synthesized: [...c.synthesized],
      assistant: c.assistantTurns(),
      user: c.record.memory.history().filter((t) => t.role === "user").map((t) => t.content),
    };
  } finally {
    await c.stop();
  }
}

await test("F1. fillers are cached after a reply, then one is spoken before a SLOW reply — and kept out of history", async () => {
  const cache = new TtsAudioCache(undefined);
  const first = await fillerLines(() => fillerCall({ cache, fillers: true }));
  assert.equal(first.lines.length, 0, "a fast reply gets no filler");
  assert.ok(first.result.synthesized.includes("Sure, so…") && first.result.synthesized.includes("Right, so…"), first.result.synthesized.join(" | "));
  const second = await fillerLines(() => fillerCall({ cache, fillers: true, llmDelayMs: 2600 }));
  assert.equal(second.lines.length, 1, second.lines.join(" | "));
  assert.deepEqual(second.result.assistant, [OPENING, GENERATED], "the filler is not an assistant turn");
});

await test("F2. fillers OFF (the default): a slow reply gets no filler and nothing extra is synthesized", async () => {
  const cache = new TtsAudioCache(undefined);
  const run = await fillerLines(() => fillerCall({ cache, llmDelayMs: 2600 }));
  assert.equal(run.lines.length, 0);
  assert.ok(!run.result.synthesized.some((t) => t.includes("…")), run.result.synthesized.join(" | "));
});

await test("F3. a filler that is not cached yet is never synthesized while the caller waits", async () => {
  const cache = new TtsAudioCache(undefined);
  const run = await fillerLines(() => fillerCall({ cache, fillers: true, llmDelayMs: 2600 }));
  assert.equal(run.lines.length, 0, "nothing cached, so nothing played");
  assert.deepEqual(run.result.assistant, [OPENING, GENERATED]);
});

await test("F4. a reply that is ready in time never gets a filler, even with fillers cached", async () => {
  const cache = new TtsAudioCache(undefined);
  await fillerCall({ cache, fillers: true });
  const run = await fillerLines(() => fillerCall({ cache, fillers: true }));
  assert.equal(run.lines.length, 0);
});

await test("F5. the filler's own words coming back up the line are not a caller turn and do not cancel the reply", async () => {
  const cache = new TtsAudioCache(undefined);
  await fillerCall({ cache, fillers: true });
  const run = await fillerLines(() => fillerCall({ cache, fillers: true, llmDelayMs: 2600 }, "so"));
  assert.equal(run.lines.length, 1);
  assert.deepEqual(run.result.assistant, [OPENING, GENERATED]);
  assert.deepEqual(run.result.user, ["What is this about?"], run.result.user.join(" | "));
  assert.equal(run.echoes.length, 1, "the echo was recognised as the filler's");
});

await test("F6. the caller starting to talk during a filler stops it at once", async () => {
  const cache = new TtsAudioCache(undefined);
  await fillerCall({ cache, fillers: true });
  const stopped: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("filler stopped")) stopped.push(line);
    original(...args);
  };
  try {
    await fillerLines(() => fillerCall({ cache, fillers: true, llmDelayMs: 2600 }, "and one more thing about the timing"));
  } finally {
    console.log = original;
  }
  assert.equal(stopped.length, 1, "the filler was stopped by the caller");
});

await test("F7. the filler matches what the caller said", () => {
  const cases: Array<[string, string]> = [
    ["What is this about?", "question"],
    ["Webinar kitne baje hai", "question"],
    ["यह कब है?", "question"],
    ["I'm not interested.", "decline"],
    ["नहीं चाहिए।", "decline"],
    ["Mujhe abhi interest nahi hai", "decline"],
    ["I have a problem with the timing.", "concern"],
    ["मुझे थोड़ी दिक्कत है", "concern"],
    ["Yes.", "agreement"],
    ["हाँ जी।", "agreement"],
    ["Okay sir", "agreement"],
    ["No, I haven't tried.", "statement"],
    ["I run a small bakery in Pune.", "statement"],
    ["Yes, I tried Instagram but it did not work out.", "statement"],
    ["Yeah, tell me.", "question"],
    ["हाँ, बोलिए।", "question"],
    ["I will attend the program, no problem.", "statement"],
    ["I'm busy right now, ma'am. I'll call you later.", "decline"],
    ["नहीं, थैंक यू। मेरे पास अभी टाइम नहीं है।", "decline"],
  ];
  for (const [said, kind] of cases) assert.equal(fillerKindFor(said), kind, said);
  // Where only the real reply is right: no filler at all.
  for (const said of ["Who is this?", "Right. Who is this?", "आप कौन?", "हेलो।", "Hello?", "Yes?", "आवाज़ नहीं आ रही, मैडम।", "ओके, बाय।", "तू पागल है क्या?"]) {
    assert.equal(fillerKindFor(said), undefined, said);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
process.exit();
