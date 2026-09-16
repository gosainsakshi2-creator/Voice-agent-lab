/**
 * latency-boundary-telemetry-tests.ts — `npm run test:latency-boundaries`
 *
 * PHASE 3 BATCH 1 — MEASUREMENT GAP CLOSURE. Covers the three
 * per-turn boundaries that the Phase 3 audit found were computed for
 * the console trace and then discarded, plus the call-level
 * first-outbound-audio instant that `dispatch_metrics` has had a
 * column for since `001_init.sql` and never once received a value in.
 *
 *   endpointToReleaseMs   provider endpoint claim -> turn released
 *   speechEndToReleaseMs  caller's audio ended    -> turn released
 *   playbackStartupMs     first frame QUEUED      -> first frame SENT
 *   firstOutboundAudioAt  call-level, set by the media bridge's pump
 *
 * The property under test throughout is the one the whole metrics
 * layer is built on and which this batch must not weaken: A
 * MEASUREMENT THAT DOES NOT EXIST IS ABSENT, NEVER ZERO. Zero is a
 * legitimate latency and would be averaged in as one, so every
 * "missing" and every "impossible ordering" case below asserts
 * absence rather than a clamped value.
 *
 * Everything here is the REAL `SessionMetricsCollector`, the REAL
 * `SessionRecord` and the REAL `DefaultVoiceSessionManager`. NOTHING
 * HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, TOUCHES A
 * DATABASE OR TOUCHES GOOGLE.
 */

import assert from "node:assert/strict";

const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { DefaultVoiceSessionManager } = await import("../../core/session/voice-session-manager.impl");
const { CallDirection, ProviderCategory, SupportedLanguage } = await import("../../types/enums");

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
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "sarvam" },
};

/** A turn with every pre-existing field present, so each test varies only what it is about. */
function baseTurn(overrides: Partial<TurnLatencyInput> = {}): TurnLatencyInput {
  return {
    turnIndex: 0,
    sttMs: 900,
    llmMs: 1000,
    ttsMs: 240,
    totalMs: 2500,
    llmGenerationMs: 1200,
    ttsSynthesisMs: 1800,
    userSpeechMs: 1500,
    sttCostUsd: 0,
    llmCostUsd: 0,
    ttsCostUsd: 0,
    promptTokens: undefined,
    cachedPromptTokens: undefined,
    reasoningTokens: undefined,
    ...overrides,
  };
}

function oneTurn(overrides: Partial<TurnLatencyInput> = {}) {
  const collector = new SessionMetricsCollector("s-test" as SessionId, STACK);
  collector.recordTurn(baseTurn(overrides));
  const turn = collector.build().turnLatencies[0];
  assert.ok(turn, "expected exactly one recorded turn");
  return turn;
}

// ═════════════════════════════════════════════════════════════════
section("A. ENDPOINTING — the two boundaries reach the persisted metrics");

await test("A1. a valid endpoint claim and release produce endpointToReleaseMs", () => {
  const turn = oneTurn({ endpointToReleaseMs: 180 });
  assert.equal(turn.endpointToReleaseMs, 180);
});

await test("A2. a valid speech-end and release produce speechEndToReleaseMs", () => {
  const turn = oneTurn({ speechEndToReleaseMs: 1340 });
  assert.equal(turn.speechEndToReleaseMs, 1340);
});

await test("A3. both boundaries survive together, independently of each other", () => {
  const turn = oneTurn({ endpointToReleaseMs: 210, speechEndToReleaseMs: 1180 });
  assert.equal(turn.endpointToReleaseMs, 210);
  assert.equal(turn.speechEndToReleaseMs, 1180);
});

await test("A4. a turn released by INFERENCE has no endpoint claim, and reports absence — not 0", () => {
  // The silence window simply expired; Deepgram never said "they
  // stopped". Reporting 0 here would describe the detector as instant
  // on precisely the turns where it waited longest.
  const turn = oneTurn({ endpointToReleaseMs: undefined, speechEndToReleaseMs: 1400 });
  assert.ok(!("endpointToReleaseMs" in turn), "endpointToReleaseMs must be ABSENT, not present-and-zero");
  assert.equal(turn.speechEndToReleaseMs, 1400, "the other boundary is unaffected by the missing one");
});

await test("A5. no speech-end timestamp means no speechEndToReleaseMs", () => {
  const turn = oneTurn({ speechEndToReleaseMs: undefined });
  assert.ok(!("speechEndToReleaseMs" in turn), "must be ABSENT rather than fabricated");
});

await test("A6. omitting the fields entirely behaves exactly as passing undefined", () => {
  // Backward compatibility: every construction site that predates this
  // batch omits these keys, and must keep working unchanged.
  const turn = oneTurn();
  assert.ok(!("endpointToReleaseMs" in turn));
  assert.ok(!("speechEndToReleaseMs" in turn));
  assert.ok(!("playbackStartupMs" in turn));
});

await test("A7. impossible ordering (release BEFORE the endpoint claim) is rejected, not clamped", () => {
  const turn = oneTurn({ endpointToReleaseMs: -250, speechEndToReleaseMs: -1 });
  assert.ok(!("endpointToReleaseMs" in turn), "a negative span means the clocks disagreed — report nothing");
  assert.ok(!("speechEndToReleaseMs" in turn), "a negative span must never be stored");
});

await test("A8. a genuine zero-length wait is preserved (0 is a real measurement)", () => {
  // The distinction A4/A7 exist to protect only means something if a
  // real 0 still survives.
  const turn = oneTurn({ endpointToReleaseMs: 0 });
  assert.equal(turn.endpointToReleaseMs, 0);
  assert.ok("endpointToReleaseMs" in turn);
});

await test("A9. NaN/Infinity from a clock glitch are rejected", () => {
  const turn = oneTurn({ endpointToReleaseMs: Number.NaN, speechEndToReleaseMs: Number.POSITIVE_INFINITY });
  assert.ok(!("endpointToReleaseMs" in turn));
  assert.ok(!("speechEndToReleaseMs" in turn));
});

// ═════════════════════════════════════════════════════════════════
section("B. PLAYBACK STARTUP — the span `total` stops short of");

await test("B1. a valid queued->sent span produces playbackStartupMs", () => {
  const turn = oneTurn({ playbackStartupMs: 104 });
  assert.equal(turn.playbackStartupMs, 104);
});

await test("B2. a turn that produced no audio reports no playback startup", () => {
  const turn = oneTurn({ playbackStartupMs: undefined, totalMs: undefined });
  assert.ok(!("playbackStartupMs" in turn), "must be ABSENT rather than 0");
});

await test("B3. a negative queued->sent span is rejected", () => {
  const turn = oneTurn({ playbackStartupMs: -20 });
  assert.ok(!("playbackStartupMs" in turn));
});

await test("B4. playbackStartupMs is never summed into total — it is recorded alongside it", () => {
  const turn = oneTurn({ playbackStartupMs: 110, totalMs: 2500 });
  assert.equal(turn.total?.milliseconds, 2500, "total must be exactly what was measured, unchanged");
  assert.equal(turn.playbackStartupMs, 110);
});

// ═════════════════════════════════════════════════════════════════
section("C. THE FIRST OUTBOUND FRAME — reported by the media bridge's pump");

const stubRegistry = {
  resolve: () => ({ descriptor: { category: ProviderCategory.TELEPHONY, id: "stub" } }),
} as never;

async function managerWithSession() {
  const manager = new DefaultVoiceSessionManager(stubRegistry);
  const created = await manager.createSession({
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    providerStack: STACK,
  });
  return { manager, sessionId: created.id };
}

await test("C1. no frame sent yet means no first-audio instant — absent, not epoch-zero", async () => {
  const { manager, sessionId } = await managerWithSession();
  const before = await manager.getBenchmarkMetrics(sessionId);
  assert.equal(
    before.callDuration.firstOutboundAudioAt,
    undefined,
    "a call whose bridge never sent a frame must report N/A",
  );
});

await test("C2. the first frame the pump sends stamps the call-level instant", async () => {
  const { manager, sessionId } = await managerWithSession();
  manager.noteOutboundFrameSent(sessionId);
  const after = await manager.getBenchmarkMetrics(sessionId);
  assert.ok(
    after.callDuration.firstOutboundAudioAt instanceof Date,
    "the bridge's first frame is what stamps it",
  );
});

await test("C3. later frames do NOT overwrite the first-frame timestamp", async () => {
  const { manager, sessionId } = await managerWithSession();
  manager.noteOutboundFrameSent(sessionId);
  const first = (await manager.getBenchmarkMetrics(sessionId)).callDuration.firstOutboundAudioAt;
  assert.ok(first instanceof Date);

  // The pump calls this ~50x/second for the rest of the call. Spin past
  // at least one clock tick so an overwrite would be visibly different.
  const until = Date.now() + 12;
  while (Date.now() < until) manager.noteOutboundFrameSent(sessionId);
  manager.noteOutboundFrameSent(sessionId);

  const later = (await manager.getBenchmarkMetrics(sessionId)).callDuration.firstOutboundAudioAt;
  assert.deepEqual(later, first, "the call-level stamp must remain the FIRST frame's, forever");
});

await test("C4. a fresh session record carries no per-turn frame instant", async () => {
  // The pipeline's per-turn span is `firstOutboundFrameAtMs` minus
  // `firstAudioQueuedAtMs`, and `beginTurnTiming` clears BOTH at the
  // top of every turn. This pins the starting state that clearing
  // restores — an undefined field, so a turn with no audio yields no
  // span rather than a span measured from the previous turn.
  const { SessionRecord } = await import("../../core/session/session-record");
  const record = new SessionRecord(
    "s-fresh" as SessionId,
    { language: SupportedLanguage.ENGLISH, direction: CallDirection.OUTBOUND, providerStack: STACK },
    STACK,
  );
  assert.equal(record.firstOutboundFrameAtMs, undefined);
});

await test("C5. stamping a session the manager has already forgotten never throws", async () => {
  const { manager } = await managerWithSession();
  // A socket callback can outlive its session by a frame or two —
  // exactly why `noteCallerSpeech` is written the same way. Telemetry
  // must not be able to take a call, or the process, down.
  assert.doesNotThrow(() => manager.noteOutboundFrameSent("does-not-exist" as SessionId));
});

// ═════════════════════════════════════════════════════════════════
section("D. EXISTING TELEMETRY IS UNCHANGED");

await test("D1. every pre-existing per-turn field is byte-identical with the new ones present", () => {
  const turn = oneTurn({ endpointToReleaseMs: 200, speechEndToReleaseMs: 1100, playbackStartupMs: 100 });
  assert.equal(turn.stt?.milliseconds, 900);
  assert.equal(turn.llm?.milliseconds, 1000);
  assert.equal(turn.tts?.milliseconds, 240);
  assert.equal(turn.total?.milliseconds, 2500);
  assert.equal(turn.llmGenerationMs, 1200);
  assert.equal(turn.ttsSynthesisMs, 1800);
  assert.equal(turn.userSpeechMs, 1500);
});

await test("D2. an existing consumer reading only the old fields sees no change", () => {
  // Old records have none of the new keys; new records have them
  // alongside. Neither shape may disturb the other.
  const oldShape = oneTurn();
  const newShape = oneTurn({ endpointToReleaseMs: 200, playbackStartupMs: 100 });
  for (const key of ["stt", "llm", "tts", "total", "llmGenerationMs", "ttsSynthesisMs", "userSpeechMs"] as const) {
    assert.deepEqual(
      (oldShape as unknown as Record<string, unknown>)[key],
      (newShape as unknown as Record<string, unknown>)[key],
      `"${key}" must be identical whether or not the new boundaries were measured`,
    );
  }
});

await test("D3. call duration still reports answer/end exactly as before", () => {
  const collector = new SessionMetricsCollector("s-dur" as SessionId, STACK);
  collector.markCallAnswered();
  collector.markCallEnded();
  const d = collector.build().callDuration;
  assert.ok(d.answeredAt instanceof Date);
  assert.ok(d.endedAt instanceof Date);
  assert.ok(typeof d.seconds === "number");
  assert.equal(d.firstOutboundAudioAt, undefined, "absent when no bridge ever sent a frame");
});

await test("D4. markFirstOutboundAudio is idempotent at the collector level too", () => {
  const collector = new SessionMetricsCollector("s-idem" as SessionId, STACK);
  collector.markFirstOutboundAudio();
  const first = collector.build().callDuration.firstOutboundAudioAt;
  for (let i = 0; i < 200; i += 1) collector.markFirstOutboundAudio();
  assert.deepEqual(collector.build().callDuration.firstOutboundAudioAt, first);
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
