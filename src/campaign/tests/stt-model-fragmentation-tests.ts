/**
 * stt-model-fragmentation-tests.ts — `npm run test:stt-fragmentation`
 *
 * PHASE 3 PHASE 0 — experiment prerequisites. Covers the two telemetry
 * additions that must exist BEFORE any endpointing A/B can be judged:
 *
 *   1. the ACTUAL Deepgram model is recorded per call, so a model
 *      change between arms cannot silently confound the result;
 *   2. SPEECH FRAGMENTATION is measurable, so the failure mode
 *      `endpointing: 300` was rejected for on 2026-08-09 ("a caller
 *      drawing breath mid-sentence arrives as several separate finals")
 *      can be quantified rather than eyeballed.
 *
 * NEITHER changes behaviour. `endpointing` stays `"400"` — asserted
 * directly in section F, from the provider source.
 *
 * NOTHING HERE OPENS A SOCKET, CONTACTS DEEPGRAM, PLACES A CALL OR
 * TOUCHES A DATABASE.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { DeepgramSpeechToTextProvider } = await import("../../providers/speech-to-text/deepgram.provider");
const { ProviderCategory } = await import("../../types/enums");

import type { TurnLatencyInput } from "../../core/session/metrics-collector";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";

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

const STACK: ProviderStackSelection = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
};

function turnWith(overrides: Partial<TurnLatencyInput>) {
  const collector = new SessionMetricsCollector("s-frag" as SessionId, STACK);
  collector.recordTurn({
    turnIndex: 0,
    sttMs: 900, llmMs: 1000, ttsMs: 150, totalMs: 2600,
    llmGenerationMs: 1200, ttsSynthesisMs: 1800, userSpeechMs: 1500,
    sttCostUsd: 0, llmCostUsd: 0, ttsCostUsd: 0,
    promptTokens: undefined, cachedPromptTokens: undefined, reasoningTokens: undefined,
    ...overrides,
  } as TurnLatencyInput);
  const turn = collector.build().turnLatencies[0];
  assert.ok(turn);
  return turn;
}

// ═════════════════════════════════════════════════════════════════
section("A. THE ACTUAL DEEPGRAM MODEL IS RECORDED");

await test("A1. the descriptor reports the CONFIGURED model, not a hard-coded literal", () => {
  const p = new DeepgramSpeechToTextProvider({ apiKey: "test-key", model: "nova-9-experimental" });
  assert.equal(
    p.descriptor.version,
    "nova-9-experimental",
    "version must follow DEEPGRAM_MODEL; a literal would silently confound any A/B",
  );
});

await test("A2. the default model still reports nova-3, so nothing changes today", () => {
  const p = new DeepgramSpeechToTextProvider({ apiKey: "test-key", model: "nova-3" });
  assert.equal(p.descriptor.version, "nova-3");
  assert.equal(p.descriptor.id, "deepgram");
  assert.equal(p.descriptor.category, ProviderCategory.SPEECH_TO_TEXT);
});

await test("A3. the model is persisted onto the call's benchmark metrics", () => {
  const collector = new SessionMetricsCollector("s-model" as SessionId, STACK);
  collector.noteSttModel("nova-3");
  assert.equal(collector.build().sttModel, "nova-3");
});

await test("A4. noteSttModel is idempotent — the first resolution describes the call", () => {
  const collector = new SessionMetricsCollector("s-model" as SessionId, STACK);
  collector.noteSttModel("nova-3");
  collector.noteSttModel("nova-2");
  collector.noteSttModel("something-else");
  assert.equal(collector.build().sttModel, "nova-3", "a retried webhook must not rewrite it");
});

await test("A5. a call that never reported a model omits the field entirely", () => {
  const metrics = new SessionMetricsCollector("s-none" as SessionId, STACK).build();
  assert.ok(!("sttModel" in metrics), "absent, never an empty string");
});

await test("A6. a blank or whitespace model is ignored rather than stored", () => {
  for (const bad of ["", "   ", undefined]) {
    const collector = new SessionMetricsCollector("s-blank" as SessionId, STACK);
    collector.noteSttModel(bad as string | undefined);
    assert.ok(!("sttModel" in collector.build()), `"${String(bad)}" must not be stored`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. FRAGMENTATION COUNT");

await test("B1. one final => count 1 and NO gaps array", () => {
  const turn = turnWith({ finalTranscriptCount: 1, interFinalGapsMs: [] });
  assert.equal(turn.finalTranscriptCount, 1);
  assert.ok(!("interFinalGapsMs" in turn), "a single final has no gap; an empty array would be noise");
});

await test("B2. multiple finals => the count is preserved (the fragmentation signal)", () => {
  const turn = turnWith({ finalTranscriptCount: 4, interFinalGapsMs: [120, 260, 90] });
  assert.equal(turn.finalTranscriptCount, 4);
  assert.deepEqual(turn.interFinalGapsMs, [120, 260, 90]);
});

await test("B3. gaps always number one fewer than the finals", () => {
  for (const n of [2, 3, 5]) {
    const gaps = Array.from({ length: n - 1 }, (_, i) => 100 + i);
    const turn = turnWith({ finalTranscriptCount: n, interFinalGapsMs: gaps });
    assert.equal(turn.interFinalGapsMs?.length, n - 1, `count ${n} must yield ${n - 1} gaps`);
  }
});

await test("B4. multiple turns each carry their own count — no leakage between them", () => {
  const collector = new SessionMetricsCollector("s-multi" as SessionId, STACK);
  const base = {
    sttMs: 900, llmMs: 1000, ttsMs: 150, totalMs: 2600, llmGenerationMs: 1200,
    ttsSynthesisMs: 1800, userSpeechMs: 1500, sttCostUsd: 0, llmCostUsd: 0, ttsCostUsd: 0,
    promptTokens: undefined, cachedPromptTokens: undefined, reasoningTokens: undefined,
  };
  collector.recordTurn({ ...base, turnIndex: 0, finalTranscriptCount: 1 } as TurnLatencyInput);
  collector.recordTurn({ ...base, turnIndex: 1, finalTranscriptCount: 3, interFinalGapsMs: [80, 140] } as TurnLatencyInput);
  collector.recordTurn({ ...base, turnIndex: 2, finalTranscriptCount: 1 } as TurnLatencyInput);
  const turns = collector.build().turnLatencies;
  assert.deepEqual(turns.map((t) => t.finalTranscriptCount), [1, 3, 1]);
  assert.equal(turns[0]?.interFinalGapsMs, undefined);
  assert.deepEqual(turns[1]?.interFinalGapsMs, [80, 140]);
  assert.equal(turns[2]?.interFinalGapsMs, undefined, "turn 1's gaps must not leak into turn 2");
});

await test("B5. zero finals survives as a real observation, not as 'not measured'", () => {
  const turn = turnWith({ finalTranscriptCount: 0 });
  assert.equal(turn.finalTranscriptCount, 0);
  assert.ok("finalTranscriptCount" in turn, "a turn released with no final is diagnostic, not missing");
});

// ═════════════════════════════════════════════════════════════════
section("C. INTER-FINAL GAPS COME FROM THE CORRECT TIMESTAMPS");

await test("C1. a gap is the wall-clock difference between consecutive finals", () => {
  // The pipeline reads Date.now() ONCE per final and measures against
  // the previous final's stamp, so a gap is exactly t(n) - t(n-1).
  const t0 = 1_000_000;
  const stamps = [t0, t0 + 250, t0 + 1300];
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
  const turn = turnWith({ finalTranscriptCount: stamps.length, interFinalGapsMs: gaps });
  assert.deepEqual(turn.interFinalGapsMs, [250, 1050]);
});

await test("C2. a negative gap is dropped without poisoning the rest of the array", () => {
  const turn = turnWith({ finalTranscriptCount: 4, interFinalGapsMs: [120, -5, 300] });
  assert.deepEqual(turn.interFinalGapsMs, [120, 300], "two clocks disagreeing costs one gap, not all of them");
});

await test("C3. NaN/Infinity gaps are dropped", () => {
  const turn = turnWith({
    finalTranscriptCount: 4,
    interFinalGapsMs: [Number.NaN, 200, Number.POSITIVE_INFINITY],
  });
  assert.deepEqual(turn.interFinalGapsMs, [200]);
});

await test("C4. a genuine 0ms gap is preserved — two finals can land in the same millisecond", () => {
  const turn = turnWith({ finalTranscriptCount: 2, interFinalGapsMs: [0] });
  assert.deepEqual(turn.interFinalGapsMs, [0]);
});

// ═════════════════════════════════════════════════════════════════
section("D. BACKWARD COMPATIBILITY");

await test("D1. a turn recorded WITHOUT the new fields is still valid", () => {
  const turn = turnWith({});
  assert.ok(!("finalTranscriptCount" in turn));
  assert.ok(!("interFinalGapsMs" in turn));
  assert.equal(turn.stt?.milliseconds, 900, "every pre-existing field is untouched");
  assert.equal(turn.total?.milliseconds, 2600);
});

await test("D2. historical records without sttModel or fragmentation remain readable", () => {
  const legacy = JSON.parse(
    '{"turnIndex":0,"stt":{"milliseconds":990,"measuredAt":"2026-09-16T00:00:00Z"},' +
      '"llm":{"milliseconds":1021,"measuredAt":"2026-09-16T00:00:00Z"},' +
      '"total":{"milliseconds":2695,"measuredAt":"2026-09-16T00:00:00Z"}}',
  );
  assert.equal(legacy.finalTranscriptCount, undefined);
  assert.equal(legacy.interFinalGapsMs, undefined);
  assert.equal(legacy.stt.milliseconds, 990, "the old shape still parses and reads");
});

await test("D3. every pre-existing per-turn field is identical with the new ones present", () => {
  const withNew = turnWith({ finalTranscriptCount: 3, interFinalGapsMs: [80, 140] });
  const without = turnWith({});
  for (const key of ["stt", "llm", "tts", "total", "llmGenerationMs", "ttsSynthesisMs", "userSpeechMs"] as const) {
    assert.deepEqual(
      (without as unknown as Record<string, unknown>)[key],
      (withNew as unknown as Record<string, unknown>)[key],
      `"${key}" must not change`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. NO CREDENTIALS OR SENSITIVE DATA ENTER TELEMETRY");

await test("E1. the descriptor carries the model and never the API key", () => {
  const secret = "sk-deepgram-SUPER-SECRET-9876";
  const p = new DeepgramSpeechToTextProvider({ apiKey: secret, model: "nova-3" });
  const serialised = JSON.stringify(p.descriptor);
  assert.ok(!serialised.includes(secret), "the API key must not appear in the descriptor");
  assert.ok(!serialised.toLowerCase().includes("apikey"));
  assert.ok(serialised.includes("nova-3"));
});

await test("E2. built metrics contain no credential-shaped value", () => {
  const secret = "sk-deepgram-SUPER-SECRET-9876";
  const p = new DeepgramSpeechToTextProvider({ apiKey: secret, model: "nova-3" });
  const collector = new SessionMetricsCollector("s-sec" as SessionId, STACK);
  collector.noteSttModel(p.descriptor.version);
  const serialised = JSON.stringify(collector.build());
  assert.ok(!serialised.includes(secret));
  assert.ok(!/sk-[A-Za-z0-9-]{8,}/.test(serialised), "no API-key-shaped token anywhere in the metrics");
});

await test("E3. fragmentation telemetry is numeric only — it cannot carry transcript text", () => {
  const turn = turnWith({ finalTranscriptCount: 3, interFinalGapsMs: [80, 140] });
  assert.equal(typeof turn.finalTranscriptCount, "number");
  for (const g of turn.interFinalGapsMs ?? []) assert.equal(typeof g, "number");
});

// ═════════════════════════════════════════════════════════════════
section("F. THE EXPERIMENT VARIABLE IS UNTOUCHED");

await test("F1. endpointing is still exactly \"400\" and utterance_end_ms still \"1000\"", () => {
  // Phase 0 is telemetry only. This asserts the one thing the whole
  // batch promised not to touch, read from the provider source itself.
  const src = readFileSync("src/providers/speech-to-text/deepgram.provider.ts", "utf8");
  assert.ok(/endpointing:\s*"400"/.test(src), "endpointing must remain 400");
  assert.ok(/utterance_end_ms:\s*"1000"/.test(src), "utterance_end_ms must remain 1000");
  assert.ok(!/endpointing:\s*"(?!400)/.test(src), "no other endpointing value may appear");
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
