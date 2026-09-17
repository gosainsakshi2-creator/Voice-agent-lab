/**
 * stt-lag-inputs-tests.ts — `npm run test:stt-lag-inputs`
 *
 * PHASE 3 BATCH 6 — the two readings that complete the STT-lag
 * subtraction:
 *
 *   lastFinalWordEndStreamMs   the SUBTRAHEND — `sttStreamMsOf(segment)`,
 *                              the re-based end of the last recognised word
 *   sttClockOffsetMs           the re-base offset in force when it was read
 *
 * Batch 4 already persists the MINUEND (`inboundStreamMsAtFinalTranscript`).
 * With all three,
 *
 *     inboundStreamMsAtFinalTranscript - lastFinalWordEndStreamMs
 *
 * reproduces at analysis time exactly the lag the pipeline's
 * plausibility guard evaluated — including on the turns where that
 * guard DISCARDED it, which are the turns worth inspecting.
 *
 * THE PROPERTY THIS SUITE EXISTS FOR: both fields are recorded
 * UNCONDITIONALLY. A turn with no `stt` must still carry them, or the
 * absence of `stt` stays unexplainable.
 *
 * Telemetry only. This batch adds no control flow, and sections C and D
 * assert that `stt` itself and the Deepgram request are untouched.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, OR
 * TOUCHES THE DATABASE.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { TranscriptSegment } from "../../types/provider.types";
import type { SessionId, ProviderStackSelection } from "../../types/session.types";
import type { TurnLatencyInput } from "../../core/session/metrics-collector";
import type { TurnLatencyBreakdown } from "../../types/benchmark.types";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const STACK = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
} as unknown as ProviderStackSelection;

// ═════════════════════════════════════════════════════════════════
// A. THE COLLECTOR PERSISTS BOTH FIELDS
// ═════════════════════════════════════════════════════════════════
section("A. Collector round-trip");

const BASE = {
  sttMs: 900, llmMs: 1000, ttsMs: 150, totalMs: 2600,
  llmGenerationMs: 1200, ttsSynthesisMs: 1800, userSpeechMs: 1500,
  sttCostUsd: 0, llmCostUsd: 0, ttsCostUsd: 0,
  promptTokens: undefined, cachedPromptTokens: undefined, reasoningTokens: undefined,
} as const;

function collect(overrides: Partial<TurnLatencyInput>): TurnLatencyBreakdown {
  const collector = new SessionMetricsCollector("s-b6" as SessionId, STACK);
  collector.recordTurn({ turnIndex: 0, ...BASE, ...overrides } as TurnLatencyInput);
  const turn = collector.build().turnLatencies[0];
  assert.ok(turn);
  return turn;
}

await test("A1 — both fields round-trip into the persisted turn", () => {
  const turn = collect({ lastFinalWordEndStreamMs: 41_820, sttClockOffsetMs: 0 });
  assert.equal(turn.lastFinalWordEndStreamMs, 41_820);
  assert.equal(turn.sttClockOffsetMs, 0);
});

await test("A2 — they survive JSON serialization into call_metrics.raw", () => {
  const collector = new SessionMetricsCollector("s-raw" as SessionId, STACK);
  collector.recordTurn({
    turnIndex: 0, ...BASE,
    inboundStreamMsAtFinalTranscript: 42_560,
    lastFinalWordEndStreamMs: 41_820,
    sttClockOffsetMs: 1_337,
  } as TurnLatencyInput);
  const raw = JSON.parse(JSON.stringify(collector.build())) as Record<string, unknown>;
  const turn = (raw["turnLatencies"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(turn["lastFinalWordEndStreamMs"], 41_820);
  assert.equal(turn["sttClockOffsetMs"], 1_337);
  // The whole point: the lag is reconstructible from the stored row.
  assert.equal(
    Number(turn["inboundStreamMsAtFinalTranscript"]) - Number(turn["lastFinalWordEndStreamMs"]),
    740,
  );
});

await test("A3 — 0 SURVIVES on both; they are positions, not epoch stamps", () => {
  // 0 is diagnostic, not missing: for the word end it is what
  // `sttStreamMsOf` returns for "no word timings in this result", and
  // for the offset it means "no re-base has happened".
  const turn = collect({ lastFinalWordEndStreamMs: 0, sttClockOffsetMs: 0 });
  assert.equal(turn.lastFinalWordEndStreamMs, 0);
  assert.equal(turn.sttClockOffsetMs, 0);
  assert.ok("lastFinalWordEndStreamMs" in turn, "0 must not collapse into absence");
  assert.ok("sttClockOffsetMs" in turn);
});

await test("A4 — a negative or non-finite reading is dropped, never stored", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const turn = collect({ lastFinalWordEndStreamMs: bad, sttClockOffsetMs: bad });
    assert.equal(turn.lastFinalWordEndStreamMs, undefined, `${String(bad)} must not be stored`);
    assert.equal(turn.sttClockOffsetMs, undefined, `${String(bad)} must not be stored`);
  }
});

await test("A5 — omitting them is identical to 'not observed' (backward compatible)", () => {
  const turn = collect({});
  assert.ok(!("lastFinalWordEndStreamMs" in turn), "absent, never a substituted 0");
  assert.ok(!("sttClockOffsetMs" in turn));
});

// ═════════════════════════════════════════════════════════════════
// B. RECORDED EVEN WHEN THE stt GUARD REJECTS THE LAG — the point
// ═════════════════════════════════════════════════════════════════
section("B. Unconditional: present on a turn with no stt");

await test("B1 — a turn whose stt was rejected still carries both readings", () => {
  // `sttMs: undefined` is exactly what the pipeline passes when its
  // plausibility guard discarded the lag.
  const turn = collect({
    sttMs: undefined,
    inboundStreamMsAtFinalTranscript: 42_560,
    lastFinalWordEndStreamMs: 43_300, // > minuend => the lag was negative
    sttClockOffsetMs: 1_480,
  });
  assert.equal(turn.stt, undefined, "stt must still be absent — this batch does not revive it");
  assert.equal(turn.lastFinalWordEndStreamMs, 43_300);
  assert.equal(turn.sttClockOffsetMs, 1_480);
  // And the rejected lag is now visible for what it was.
  assert.equal(
    Number(turn.inboundStreamMsAtFinalTranscript) - Number(turn.lastFinalWordEndStreamMs),
    -740,
    "the negative lag the guard discarded is reconstructible",
  );
});

await test("B2 — a non-zero offset marks the turn as re-based, so it can be excluded", () => {
  const clean = collect({ lastFinalWordEndStreamMs: 100, sttClockOffsetMs: 0 });
  const rebased = collect({ lastFinalWordEndStreamMs: 100, sttClockOffsetMs: 5_120 });
  assert.equal(clean.sttClockOffsetMs, 0);
  assert.equal(rebased.sttClockOffsetMs, 5_120);
  assert.notEqual(clean.sttClockOffsetMs, rebased.sttClockOffsetMs);
});

// ── The REAL pipeline, driven so the lag guard actually rejects ──
//
// A final reporting `endedAtMs: 0` is Deepgram's "this result carried
// no word timings". `sttStreamMsOf` returns 0 for it, the lag becomes
// NaN, and the guard drops it — while both new readings must still be
// recorded.

function descriptor(category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) {
  return {
    category, id, displayName: id,
    supportedLanguages: [SupportedLanguage.ENGLISH],
    version: "fake",
  };
}
const healthy = (identifier: { category: unknown; id: string }) => ({
  identifier, isHealthy: true, checkedAt: new Date(),
});

function startHarness(replies: readonly string[]) {
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let replyIndex = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (request: { audio: AsyncIterable<unknown> }) {
      void (async () => {
        try {
          for await (const _c of request.audio) void _c;
        } catch { /* closed */ }
      })();
      while (!closed) {
        const next = segments.shift();
        if (next) { yield next; continue; }
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async () => ({
      turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0,
    }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: { history: ReadonlyArray<{ role: string }> }) {
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      const text = replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(10);
      yield { type: "token" as const, delta: text, index: 0 };
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: text, timestamp: new Date() },
        latencyMs: 1,
      };
    },
  };
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async () => ({ data: new Uint8Array(400), encoding: "MULAW" as const, sampleRateHz: 8000 }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts")),
  };
  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake-telephony")),
  };

  const record = new SessionRecord(
    "stt-lag-inputs" as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: STACK,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test", campaignType: "registration", scriptId: "test",
        scriptVersion: "v1", scriptHash: "test",
        agent: { gender: "male", name: "Rohan" }, customer: { name: "Sakshi" },
        openingLine: "Hello, this is Rohan.", systemPromptAppendix: "TEST APPENDIX",
      },
    } as never,
    STACK,
  );
  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => undefined);

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
  };
  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const push = (seg: TranscriptSegment): void => {
    segments.push(seg);
    waiters.shift()?.();
  };

  return {
    record,
    /** A final whose word timings are absent — `endedAtMs: 0`. */
    sayWithoutWordTimings(text: string): void {
      push({
        text, isFinal: true, isSpeechFinal: true, confidence: 0.95,
        language: SupportedLanguage.ENGLISH, startedAtMs: 0, endedAtMs: 0,
      });
    },
    pushAudio(): void {
      record.inboundAudioFallback.push({
        data: new Uint8Array(160), encoding: "MULAW", sampleRateHz: 8000,
      } as never);
    },
    async waitForReplies(n: number, timeoutMs = 15_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const count = record.memory.history().filter((t) => t.role === "assistant").length;
        if (count >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(`timed out waiting for ${n} replies`);
    },
    turns: () => record.metrics.build().turnLatencies ?? [],
    async stop(): Promise<void> {
      closed = true;
      for (const w of waiters.splice(0)) w();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

await test("B3 — REAL pipeline: a final with no word timings drops stt but keeps both readings", async () => {
  const h = startHarness(["Sure, happy to help."]);
  try {
    await h.waitForReplies(1);
    for (let i = 0; i < 5; i += 1) { h.pushAudio(); await sleep(5); }
    await sleep(30);
    h.sayWithoutWordTimings("Tell me about the workshop.");
    await h.waitForReplies(2);

    const turn = h.turns()[0];
    assert.ok(turn, "a turn must have been recorded");
    // The guard rejected the lag (endedAtMs 0 => NaN).
    assert.equal(turn.stt, undefined, "stt must be absent for a final with no word timings");
    // ...and the two readings explain exactly why.
    assert.equal(
      turn.lastFinalWordEndStreamMs,
      0,
      "0 is `sttStreamMsOf`'s answer for 'no word timings' — the rejection cause, recorded",
    );
    assert.equal(turn.sttClockOffsetMs, 0, "no re-base had occurred on this call");
    assert.ok(
      turn.inboundStreamMsAtFinalTranscript !== undefined,
      "its Batch 4 twin must still be recorded too",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// C. EXISTING stt BEHAVIOUR IS UNCHANGED
// ═════════════════════════════════════════════════════════════════
section("C. stt semantics untouched");

await test("C1 — a measured lag is still stored exactly as before", () => {
  assert.equal(collect({ sttMs: 900 }).stt?.milliseconds, 900);
  assert.equal(collect({ sttMs: 0 }).stt?.milliseconds, 0, "a real 0 lag still survives");
});

await test("C2 — an absent lag is still absent, and the new fields do not substitute for it", () => {
  const turn = collect({ sttMs: undefined, lastFinalWordEndStreamMs: 10, sttClockOffsetMs: 0 });
  assert.equal(turn.stt, undefined);
  assert.ok(!("stt" in turn), "no derived or inferred stt may appear");
});

await test("C3 — the plausibility guard and its bound are unchanged in source", () => {
  const src = readFileSync("src/core/session/conversation-pipeline.ts", "utf8");
  assert.ok(
    /MAX_PLAUSIBLE_STT_LAG_MS = 10_000/.test(src),
    "the plausibility bound must not have moved",
  );
  assert.ok(
    /if \(Number\.isFinite\(lagMs\) && lagMs >= 0 && lagMs <= MAX_PLAUSIBLE_STT_LAG_MS\)/.test(src),
    "the guard condition must be byte-for-byte what it was",
  );
  assert.ok(
    /this\.lastFinalWordEndStreamMs = segmentEndedAtStreamMs;/.test(src) &&
      /this\.lastFinalSttClockOffsetMs = this\.sttClockOffsetMs;/.test(src),
    "both readings must be written",
  );
  // Written BEFORE the guard, so no branch can skip them.
  assert.ok(
    src.indexOf("this.lastFinalWordEndStreamMs = segmentEndedAtStreamMs;") <
      src.indexOf("if (Number.isFinite(lagMs) && lagMs >= 0"),
    "the writes must precede the guard — that is what makes them unconditional",
  );
});

// ═════════════════════════════════════════════════════════════════
// D. NO ENDPOINTING / DETECTOR / RE-BASE BEHAVIOUR CHANGED
// ═════════════════════════════════════════════════════════════════
section("D. No behavioural change");

await test("D1 — the Deepgram request still defaults to 400 and keeps utterance_end_ms=1000", async () => {
  const { resolveEndpointingMs, CONTROL_ENDPOINTING_MS } = await import(
    "../../core/session/stt-endpointing-experiment"
  );
  assert.equal(resolveEndpointingMs(undefined), 400, "production default must remain 400");
  assert.equal(CONTROL_ENDPOINTING_MS, 400);
  const src = readFileSync("src/providers/speech-to-text/deepgram.provider.ts", "utf8");
  assert.ok(/utterance_end_ms:\s*"1000"/.test(src), "utterance_end_ms must remain 1000");
  assert.ok(
    !/endpointing:\s*"(?!400)/.test(src),
    "no hard-coded endpointing value other than 400 may appear",
  );
});

await test("D2 — the re-base arithmetic is unchanged in source", () => {
  const src = readFileSync("src/core/session/conversation-pipeline.ts", "utf8");
  assert.ok(
    /this\.sttClockOffsetMs = Math\.max\(0, this\.inboundStreamMs - reported\);/.test(src),
    "the offset computation must not have been touched",
  );
});

await test("D3 — the new readings are written but never read by a decision", () => {
  const src = readFileSync("src/core/session/conversation-pipeline.ts", "utf8");
  // Only the write, the snapshot, the clear, and the pass-through.
  const reads = src.match(/lastFinalWordEndStreamMs|lastFinalSttClockOffsetMs/g) ?? [];
  assert.ok(reads.length > 0, "the fields must exist");
  assert.ok(
    !/if \([^)]*lastFinalWordEndStreamMs/.test(src) &&
      !/if \([^)]*lastFinalSttClockOffsetMs/.test(src),
    "neither field may appear in a branch condition",
  );
});

await test("D4 — the detector's confirmation constants are unchanged", () => {
  const src = readFileSync("src/core/session/turn-detection.ts", "utf8");
  for (const [name, value] of [
    ["CONFIRMATION_WINDOW_MS", 300],
    ["EVIDENCED_CONFIRMATION_SHORT_MS", 150],
    ["EVIDENCED_CONFIRMATION_LONG_MS", 250],
    ["EVIDENCED_CONFIRMATION_OPEN_MS", 300],
  ] as const) {
    assert.ok(
      new RegExp(`const ${name} = ${value};`).test(src),
      `${name} must still be ${value}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
