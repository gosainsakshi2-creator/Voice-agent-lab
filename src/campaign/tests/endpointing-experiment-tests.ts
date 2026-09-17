/**
 * endpointing-experiment-tests.ts — `npm run test:endpointing-experiment`
 *
 * PHASE 3 — CONTROLLED ENDPOINTING A/B. Covers the ASSIGNMENT
 * PLUMBING only. No experiment is run here and none is enabled
 * anywhere outside this file's own scoped environment edits.
 *
 * The properties under test are the ones that decide whether the
 * eventual comparison means anything at all:
 *
 *   A  the production default survives — off means 400, always
 *   B  an enabled experiment reaches both arms, and only those two
 *   C  assignment happens BEFORE the STT connection is created
 *   D  an assignment is stable for the whole call
 *   E  nothing can silently fall back to an unintended value
 *   F  the arm AND the value actually used are both persisted
 *   G  every existing caller and configuration still behaves as before
 *
 * Section C drives the REAL `VoiceSessionManager` against a fake STT
 * provider that records the order of events, so "before the socket"
 * is asserted on the real control flow rather than by reading it.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, OR
 * TOUCHES THE DATABASE.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  assignEndpointing,
  readEndpointingExperimentConfig,
  resolveEndpointingMs,
  CONTROL_ENDPOINTING_MS,
  TREATMENT_ENDPOINTING_MS,
  ENDPOINTING_EXPERIMENT_ENABLED_ENV,
  ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV,
} = await import("../../core/session/stt-endpointing-experiment");
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { SessionRecord } = await import("../../core/session/session-record");
const { DefaultVoiceSessionManager } = await import("../../core/session/voice-session-manager.impl");
const { SupportedLanguage, CallDirection, ProviderCategory, SessionState } = await import(
  "../../types/enums"
);
const { ConfigurationError } = await import("../../core/errors");

import type { EndpointingAssignment } from "../../core/session/stt-endpointing-experiment";
import type { SessionId, ProviderStackSelection } from "../../types/session.types";
import type { TranscriptSegment } from "../../types/provider.types";
import type { StreamingTranscriptionRequest } from "../../types/streaming.types";

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

/**
 * Runs `fn` with the experiment env vars set exactly as given, then
 * restores whatever was there before. The suite must not leave the
 * flag on for anything that imports after it.
 */
async function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ON = { [ENDPOINTING_EXPERIMENT_ENABLED_ENV]: "true" } as const;
const OFF = { [ENDPOINTING_EXPERIMENT_ENABLED_ENV]: undefined } as const;

/**
 * Deterministic stand-ins for `call_attempts.id` (`gen_random_uuid()`):
 * canonical v4 UUIDs derived from a seed, so the suite is reproducible
 * run to run while still exercising the real shape and entropy the
 * assignment now requires.
 */
function attemptUuid(seed: number): string {
  // xorshift32 — deterministic, and unlike a counter it actually fills
  // the nibbles.
  let x = (seed * 2654435761) >>> 0 || 1;
  const hex = (n: number): string => {
    let out = "";
    for (let i = 0; i < n; i += 1) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;  x >>>= 0;
      out += (x & 0xf).toString(16);
    }
    return out;
  };
  // Version 4, variant 8-b: exactly the shape Postgres emits.
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.abs(seed) % 4]}${hex(3)}-${hex(12)}`;
}

/** The session-id shape the assignment must now REFUSE. */
function legacySessionId(counter: number, nowMs = Date.UTC(2026, 8, 18, 9, 0, 0)): string {
  return `sess_${nowMs.toString(36)}_${counter.toString(36)}`;
}

function findKeyForArm(arm: "control" | "treatment"): string {
  const config = { enabled: true, treatmentPercent: 50 };
  for (let i = 1; i < 10_000; i += 1) {
    const key = attemptUuid(i);
    if (assignEndpointing(key, config).arm === arm) return key;
  }
  throw new Error(`no key found for arm ${arm} — the hash is not splitting`);
}

const CONTROL_KEY = findKeyForArm("control");
const TREATMENT_KEY = findKeyForArm("treatment");

// ═════════════════════════════════════════════════════════════════
// A. OFF BY DEFAULT — the production default survives
// ═════════════════════════════════════════════════════════════════
section("A. Default / off mode");

await test("A1 — with no env set at all, the experiment is disabled", async () => {
  await withEnv(OFF, () => {
    assert.equal(readEndpointingExperimentConfig().enabled, false);
  });
});

await test("A2 — off mode resolves EVERY key to control at 400", async () => {
  await withEnv(OFF, () => {
    for (let i = 0; i < 500; i += 1) {
      const a = assignEndpointing(attemptUuid(i));
      assert.equal(a.arm, "control", `attempt ${i} must be control while the experiment is off`);
      assert.equal(a.endpointingMs, 400);
      assert.equal(a.experimentEnabled, false);
    }
  });
});

await test("A3 — off mode includes the key that WOULD be treatment when enabled", async () => {
  await withEnv(OFF, () => {
    const a = assignEndpointing(TREATMENT_KEY);
    assert.equal(a.arm, "control");
    assert.equal(a.endpointingMs, CONTROL_ENDPOINTING_MS);
  });
});

await test("A4 — anything other than the literal \"true\" leaves it off", async () => {
  for (const value of ["", "false", "TRUE", "1", "yes", "on", " true"]) {
    await withEnv({ [ENDPOINTING_EXPERIMENT_ENABLED_ENV]: value }, () => {
      assert.equal(
        readEndpointingExperimentConfig().enabled,
        false,
        `"${value}" must not switch the experiment on`,
      );
    });
  }
});

await test("A5 — the production constants are unchanged", () => {
  assert.equal(CONTROL_ENDPOINTING_MS, 400, "production control must stay 400");
  assert.equal(TREATMENT_ENDPOINTING_MS, 300, "the only value under test is 300");
});

// ═════════════════════════════════════════════════════════════════
// B. ENABLED — both arms, and only those two
// ═════════════════════════════════════════════════════════════════
section("B. Enabled control and treatment");

await test("B1 — enabled control resolves to 400", async () => {
  await withEnv(ON, () => {
    const a = assignEndpointing(CONTROL_KEY);
    assert.equal(a.arm, "control");
    assert.equal(a.endpointingMs, 400);
    assert.equal(a.experimentEnabled, true);
  });
});

await test("B2 — enabled treatment resolves to 300", async () => {
  await withEnv(ON, () => {
    const a = assignEndpointing(TREATMENT_KEY);
    assert.equal(a.arm, "treatment");
    assert.equal(a.endpointingMs, 300);
    assert.equal(a.experimentEnabled, true);
  });
});

await test("B3 — an enabled experiment produces BOTH arms across a population", async () => {
  await withEnv(ON, () => {
    const arms = new Set<string>();
    for (let i = 1; i <= 300; i += 1) arms.add(assignEndpointing(attemptUuid(i)).arm);
    assert.deepEqual([...arms].sort(), ["control", "treatment"], "a one-armed split is not an experiment");
  });
});

await test("B4 — no assignment ever carries a value outside {400, 300}", async () => {
  await withEnv(ON, () => {
    for (let i = 0; i < 1000; i += 1) {
      const ms = assignEndpointing(attemptUuid(i)).endpointingMs;
      assert.ok(ms === 400 || ms === 300, `attempt ${i} produced endpointing=${ms}`);
    }
  });
});

await test("B5 — assignment is NOT sequential: arms interleave rather than switching once", async () => {
  await withEnv(ON, () => {
    const arms = Array.from({ length: 200 }, (_, i) => assignEndpointing(attemptUuid(i + 1)).arm);
    // A "first N then next N" scheme has exactly one transition. A
    // hash over ids has many. Anything under 10 would mean the split
    // is tracking call order, which is the design this replaces.
    let transitions = 0;
    for (let i = 1; i < arms.length; i += 1) if (arms[i] !== arms[i - 1]) transitions += 1;
    assert.ok(transitions > 10, `only ${transitions} arm changes over 200 calls — this looks time-ordered`);
  });
});

await test("B6 — 0% treatment never reaches treatment; 100% never reaches control", async () => {
  await withEnv({ ...ON, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: "0" }, () => {
    for (let i = 0; i < 200; i += 1) {
      assert.equal(assignEndpointing(attemptUuid(i)).arm, "control");
    }
  });
  await withEnv({ ...ON, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: "100" }, () => {
    for (let i = 0; i < 200; i += 1) {
      assert.equal(assignEndpointing(attemptUuid(i)).arm, "treatment");
    }
  });
});

await test("B7 — the split is namespaced, so it does not mirror another dimension's hash", async () => {
  await withEnv(ON, () => {
    const id = attemptUuid(7);
    const a = assignEndpointing(id);
    assert.equal(a.assignmentKey, `stt-endpointing:${id}`, "the hashed key must carry its dimension");
  });
});

// ═════════════════════════════════════════════════════════════════
// C. ORDERING — assigned before the STT connection is created
// ═════════════════════════════════════════════════════════════════
section("C. Assignment precedes STT connection creation");

function descriptor(category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) {
  return {
    category,
    id,
    displayName: id,
    supportedLanguages: [SupportedLanguage.ENGLISH],
    version: "nova-3",
  };
}
const healthy = (identifier: { category: unknown; id: string }) => ({
  identifier,
  isHealthy: true,
  checkedAt: new Date(),
});

const STACK = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
} as unknown as ProviderStackSelection;

function creationRequest() {
  return {
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    providerStack: STACK,
    destinationNumber: "+910000000000",
  };
}

/**
 * A provider set whose STT records the moment its stream is opened —
 * which is exactly where the real adapter calls `listen.v1.connect()`
 * — and the `endpointingMs` it was handed.
 */
function buildProviders() {
  const events: string[] = [];
  let seenEndpointing: number | undefined;
  let closed = false;
  /**
   * The session under test, handed to the fake once the manager has
   * created it. The fake reads its assignment AT CONNECT TIME, which
   * is the only vantage point from which "assigned before the socket"
   * can actually be observed — checking after `confirmCallAnswered`
   * returns is too late, because the pipeline may already have
   * connected by then.
   */
  const watched: { record?: InstanceType<typeof SessionRecord> } = {};
  let assignmentAtConnect: EndpointingAssignment | undefined;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (
      request: StreamingTranscriptionRequest,
    ): AsyncIterable<TranscriptSegment> {
      events.push("stt-connect");
      assignmentAtConnect = watched.record?.sttEndpointing;
      seenEndpointing = request.endpointingMs;
      void (async () => {
        try {
          for await (const _chunk of request.audio) void _chunk;
        } catch {
          /* closed */
        }
      })();
      while (!closed) await sleep(10);
    },
  };

  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async () => ({
      turn: { role: "assistant" as const, content: "", timestamp: new Date() },
      latencyMs: 0,
    }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* () {
      yield { type: "token" as const, delta: "", index: 0 };
    },
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async () => ({ data: new Uint8Array(8), encoding: "MULAW" as const, sampleRateHz: 8000 }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts")),
    disposeSession: () => undefined,
  };

  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake-telephony")),
  };

  const registry = {
    resolve(category: unknown) {
      if (category === ProviderCategory.SPEECH_TO_TEXT) return stt;
      if (category === ProviderCategory.LANGUAGE_MODEL) return llm;
      if (category === ProviderCategory.TEXT_TO_SPEECH) return tts;
      return telephony;
    },
    register: () => undefined,
  };

  return {
    events,
    registry,
    watch: (record: InstanceType<typeof SessionRecord>) => {
      watched.record = record;
    },
    stop: () => {
      closed = true;
    },
    seen: () => ({ endpointingMs: seenEndpointing, assignmentAtConnect }),
  };
}

await test("C1 — the arm is recorded before the STT connection is opened", async () => {
  await withEnv(ON, async () => {
    const providers = buildProviders();
    const manager = new DefaultVoiceSessionManager(providers.registry as never);
    // The private session map, read only so the test can watch the
    // record the manager is actually working on.
    const records = (manager as unknown as { sessions: Map<SessionId, InstanceType<typeof SessionRecord>> })
      .sessions;

    const snapshot = await manager.createSession(creationRequest() as never);
    const record = records.get(snapshot.id);
    assert.ok(record, "the manager must hold a record for the session it created");
    providers.watch(record);

    // Read into a local first: `assert.equal(x, undefined)` narrows
    // `x` for the rest of the block, which would hide the later reads.
    const beforeAnswer: EndpointingAssignment | undefined = record.sttEndpointing;
    assert.equal(
      beforeAnswer,
      undefined,
      "there is no arm before the conversation begins — and no socket either",
    );
    assert.equal(
      providers.events.includes("stt-connect"),
      false,
      "no STT connection exists before the conversation begins",
    );

    // `beginConversation` is reached from CALLING; `start()` would
    // also place a real call, which this suite must not do.
    record.state = SessionState.CALLING;
    manager.confirmCallAnswered(snapshot.id);
    await sleep(120);

    assert.ok(providers.events.includes("stt-connect"), "the pipeline should have opened the stream by now");
    assert.ok(
      providers.seen().assignmentAtConnect,
      "the arm must ALREADY have been assigned at the moment the STT connection was created",
    );
    assert.equal(
      providers.seen().assignmentAtConnect?.endpointingMs,
      record.sttEndpointing?.endpointingMs,
      "and it must be the same assignment the call ends up recorded under",
    );

    providers.stop();
    await manager.end(snapshot.id);
  });
});

await test("C2 — the connection is opened with exactly the value this call was assigned", async () => {
  await withEnv(ON, async () => {
    const providers = buildProviders();
    const manager = new DefaultVoiceSessionManager(providers.registry as never);
    const records = (manager as unknown as { sessions: Map<SessionId, InstanceType<typeof SessionRecord>> })
      .sessions;

    const snapshot = await manager.createSession(creationRequest() as never);
    const record = records.get(snapshot.id);
    assert.ok(record);
    record.state = SessionState.CALLING;
    manager.confirmCallAnswered(snapshot.id);
    await sleep(120);

    assert.equal(
      providers.seen().endpointingMs,
      record.sttEndpointing?.endpointingMs,
      "the socket must be opened with the assigned value, not a re-derived one",
    );
    assert.ok(
      providers.seen().endpointingMs === 400 || providers.seen().endpointingMs === 300,
      `the socket received endpointing=${String(providers.seen().endpointingMs)}`,
    );

    providers.stop();
    await manager.end(snapshot.id);
  });
});

await test("C3 — with the experiment off, the connection is opened at 400", async () => {
  await withEnv(OFF, async () => {
    const providers = buildProviders();
    const manager = new DefaultVoiceSessionManager(providers.registry as never);
    const records = (manager as unknown as { sessions: Map<SessionId, InstanceType<typeof SessionRecord>> })
      .sessions;

    const snapshot = await manager.createSession(creationRequest() as never);
    const record = records.get(snapshot.id);
    assert.ok(record);
    record.state = SessionState.CALLING;
    manager.confirmCallAnswered(snapshot.id);
    await sleep(120);

    assert.equal(providers.seen().endpointingMs, 400, "production behaviour must be untouched");
    assert.equal(record.sttEndpointing?.arm, "control");

    providers.stop();
    await manager.end(snapshot.id);
  });
});

// ═════════════════════════════════════════════════════════════════
// H. THE ASSIGNMENT KEY — the B1 regression
// ═════════════════════════════════════════════════════════════════
section("H. Assignment key is the call-attempt UUID");

await test("H1 - a session id is REFUSED, so the clustering defect cannot return", async () => {
  await withEnv(ON, () => {
    for (let i = 1; i <= 50; i += 1) {
      const a = assignEndpointing(legacySessionId(i));
      assert.equal(a.experimentEnabled, false, "a session id must never be hashed");
      assert.equal(a.ineligibleReason, "key-not-uuid");
      assert.equal(a.endpointingMs, 400, "a refused key runs the production default");
      assert.equal(a.assignmentKey, undefined);
    }
  });
});

await test("H2 - sequential session ids can no longer cluster, because none is used", async () => {
  await withEnv(ON, () => {
    // The old defect: at one fixed millisecond, consecutive counters
    // produced long monotone runs of one arm. Those ids now produce no
    // assignment at all, so the failure mode is structurally gone.
    const arms = new Set(
      Array.from({ length: 200 }, (_, i) => assignEndpointing(legacySessionId(i + 1)).arm),
    );
    assert.deepEqual([...arms], ["control"], "refused keys are uniformly control, never a fake split");
  });
});

await test("H3 - other non-UUID shapes are refused too", async () => {
  await withEnv(ON, () => {
    for (const bad of [
      "abc",
      "12345",
      "sess_mu50fix3_2",
      "00000000-0000-0000-0000-000000000000", // nil UUID: no entropy
      "3f2a1b4c5d6e7f8a9b0c1d2e3f4a5b6c",      // unhyphenated
      "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
    ]) {
      const a = assignEndpointing(bad);
      assert.equal(a.experimentEnabled, false, `"${bad}" must not be hashed`);
      assert.equal(a.ineligibleReason, "key-not-uuid");
    }
  });
});

await test("H4 - UUID inputs produce a deterministic assignment", async () => {
  await withEnv(ON, () => {
    for (let i = 1; i <= 200; i += 1) {
      const id = attemptUuid(i);
      const first = assignEndpointing(id);
      assert.deepEqual(assignEndpointing(id), first, `${id} changed arm between calls`);
      assert.equal(first.assignmentKey, `stt-endpointing:${id}`);
    }
  });
});

await test("H5 - a UUID is matched case-insensitively and keyed in one canonical form", async () => {
  await withEnv(ON, () => {
    const id = attemptUuid(11);
    const upper = assignEndpointing(id.toUpperCase());
    const lower = assignEndpointing(id);
    assert.equal(upper.arm, lower.arm, "case must not change the arm");
    assert.equal(upper.assignmentKey, lower.assignmentKey);
  });
});

await test("H6 - different attempt UUIDs map independently to different arms", async () => {
  await withEnv(ON, () => {
    const arms = Array.from({ length: 400 }, (_, i) => assignEndpointing(attemptUuid(i + 1)).arm);
    const treatment = arms.filter((a) => a === "treatment").length;
    assert.ok(treatment > 0 && treatment < arms.length, "both arms must occur");

    // The property the old key failed: consecutive draws must be
    // independent. A fair split flips ~50% of the time; the session-id
    // key managed 18-20%.
    let transitions = 0;
    for (let i = 1; i < arms.length; i += 1) if (arms[i] !== arms[i - 1]) transitions += 1;
    const rate = (transitions / (arms.length - 1)) * 100;
    assert.ok(rate > 35, `consecutive attempts are correlated (only ${rate.toFixed(1)}% arm changes)`);
  });
});

await test("H7 - allocation percentages are respected over a population", async () => {
  for (const pct of [10, 25, 50, 75, 90]) {
    const config = { enabled: true, treatmentPercent: pct };
    const n = 4000;
    const treatment = Array.from({ length: n }, (_, i) => assignEndpointing(attemptUuid(i + 1), config).arm)
      .filter((a) => a === "treatment").length;
    const share = (treatment / n) * 100;
    // 4 standard errors - generous, but still far tighter than the
    // 13-point skew the session-id key produced.
    const tolerance = 4 * Math.sqrt((pct * (100 - pct)) / n);
    assert.ok(
      Math.abs(share - pct) <= tolerance,
      `configured ${pct}% realised ${share.toFixed(2)}% (tolerance +/-${tolerance.toFixed(2)})`,
    );
  }
});

await test("H8 - a retry is a new attempt UUID and is drawn independently", async () => {
  await withEnv(ON, () => {
    // Two attempts on one contact are two different UUIDs, so they may
    // land in different arms. That is the intended unit of
    // randomisation; what must NOT happen is the same UUID drifting.
    let differed = 0;
    for (let i = 1; i <= 200; i += 1) {
      const first = assignEndpointing(attemptUuid(i * 2 - 1)).arm;
      const retry = assignEndpointing(attemptUuid(i * 2)).arm;
      if (first !== retry) differed += 1;
    }
    assert.ok(differed > 0, "retries must be redrawn, not inherited");
  });
});

await test("H9 - the campaign session context carries the attempt id to the assignment point", () => {
  const attemptId = attemptUuid(42);
  const record = new SessionRecord(
    "sess-h9" as SessionId,
    {
      direction: CallDirection.OUTBOUND,
      language: SupportedLanguage.ENGLISH,
      providerStack: STACK,
      campaign: { attemptId },
    } as never,
    STACK,
  );
  assert.equal(
    record.request.campaign?.attemptId,
    attemptId,
    "the manager reads the key from exactly here",
  );
});

// ═════════════════════════════════════════════════════════════════
// I. NO CONFIGURATION ERROR CAN REACH THE AUDIO LOOP — the B4 regression
// ═════════════════════════════════════════════════════════════════
section("I. Resolution happens once, outside the pipeline");

await test("I1 - the record always exposes a valid resolved value", () => {
  const record = new SessionRecord(
    "sess-i1" as SessionId,
    { direction: CallDirection.OUTBOUND, language: SupportedLanguage.ENGLISH, providerStack: STACK } as never,
    STACK,
  );
  // Before any assignment: the production default, as a plain number.
  assert.equal(record.sttEndpointingMs, 400);
  assert.equal(typeof record.sttEndpointingMs, "number");
});

await test("I2 - a malformed assignment is rejected AT THE WRITE, not in the pipeline", () => {
  const record = new SessionRecord(
    "sess-i2" as SessionId,
    { direction: CallDirection.OUTBOUND, language: SupportedLanguage.ENGLISH, providerStack: STACK } as never,
    STACK,
  );
  assert.throws(
    () =>
      record.assignSttEndpointing({
        arm: "treatment",
        endpointingMs: 250,
        experimentEnabled: true,
      } as EndpointingAssignment),
    ConfigurationError,
    "a bad value must be refused where the error can still be seen",
  );
  // And it must not have half-applied.
  assert.equal(record.sttEndpointingMs, 400, "the operational value stays on the production default");
});

await test("I3 - a malformed configuration cannot produce a silently deaf call", async () => {
  await withEnv(ON, async () => {
    const providers = buildProviders();
    const manager = new DefaultVoiceSessionManager(providers.registry as never);
    const records = (manager as unknown as { sessions: Map<SessionId, InstanceType<typeof SessionRecord>> })
      .sessions;

    const snapshot = await manager.createSession(creationRequest() as never);
    const record = records.get(snapshot.id);
    assert.ok(record);
    providers.watch(record);
    record.state = SessionState.CALLING;
    manager.confirmCallAnswered(snapshot.id);
    await sleep(120);

    // The STT stream must have OPENED. The old shape could throw
    // inside the pipeline's `try`, whose `catch` is empty, leaving a
    // live call with no transcription and no error anywhere.
    assert.ok(
      providers.events.includes("stt-connect"),
      "the STT stream must open; a swallowed config error would leave the call deaf",
    );
    assert.equal(providers.seen().endpointingMs, record.sttEndpointingMs);
    assert.ok(
      providers.seen().endpointingMs === 400 || providers.seen().endpointingMs === 300,
      "only a closed-set value may reach the provider",
    );

    providers.stop();
    await manager.end(snapshot.id);
  });
});

await test("I4 - the pipeline is handed a plain number, never a resolver call", () => {
  const src = readFileSync("src/core/session/conversation-pipeline.ts", "utf8");
  assert.ok(
    !/resolveEndpointingMs/.test(src),
    "the audio pipeline must not resolve or validate endpointing - its catch would swallow the throw",
  );
  assert.ok(
    /endpointingMs: this\.record\.sttEndpointingMs/.test(src),
    "it must read the already-resolved field",
  );
});

// ═════════════════════════════════════════════════════════════════
// D. STABILITY — one arm for the whole call
// ═════════════════════════════════════════════════════════════════
section("D. Stability for the lifetime of a call");

await test("D1 — the same key always yields the same arm, across calls and restarts", async () => {
  await withEnv(ON, () => {
    for (let i = 0; i < 200; i += 1) {
      const key = attemptUuid(i);
      const first = assignEndpointing(key);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        assert.deepEqual(assignEndpointing(key), first, `${key} changed arm between calls`);
      }
    }
  });
});

await test("D2 — the record's assignment is write-once", async () => {
  await withEnv(ON, () => {
    const record = new SessionRecord(
      "sess-d2" as SessionId,
      {
        direction: CallDirection.OUTBOUND,
        language: SupportedLanguage.ENGLISH,
        providerStack: STACK,
      } as never,
      STACK,
    );

    const first = record.assignSttEndpointing(assignEndpointing(TREATMENT_KEY));
    const second = record.assignSttEndpointing(assignEndpointing(CONTROL_KEY));

    assert.equal(second.arm, first.arm, "a retried webhook must not move a live call between arms");
    assert.equal(record.sttEndpointing?.endpointingMs, first.endpointingMs);
  });
});

await test("D3 — the collector's record of the arm is write-once too", () => {
  const collector = new SessionMetricsCollector("sess-d3" as SessionId, STACK);
  const treatment: EndpointingAssignment = {
    arm: "treatment",
    endpointingMs: 300,
    experimentEnabled: true,
    assignmentKey: "stt-endpointing:sess-d3",
    treatmentPercent: 50,
  };
  collector.noteEndpointingAssignment(treatment);
  collector.noteEndpointingAssignment({ ...treatment, arm: "control", endpointingMs: 400 });

  assert.equal(collector.build().sttEndpointing?.arm, "treatment");
  assert.equal(collector.build().sttEndpointing?.endpointingMs, 300);
});

// ═════════════════════════════════════════════════════════════════
// E. NO SILENT FALLBACK
// ═════════════════════════════════════════════════════════════════
section("E. No silent fallback to an unintended value");

await test("E1 — an absent assignment resolves to the production 400, explicitly", () => {
  assert.equal(resolveEndpointingMs(undefined), 400);
});

await test("E2 — an unassignable value THROWS rather than defaulting", () => {
  for (const bad of [0, 250, 350, 500, 1000, -400, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveEndpointingMs(bad),
      ConfigurationError,
      `endpointing=${String(bad)} must be refused, never quietly replaced`,
    );
  }
});

await test("E3 — the throw names the value, so the refusal is diagnosable", () => {
  assert.throws(() => resolveEndpointingMs(275), /275/);
});

await test("E4 - malformed or out-of-range percentages THROW, never coerce", async () => {
  // Every one of these used to be silently accepted: `1e2` became a
  // 100% treatment rollout, `0x10` became 16%, whitespace became 0%,
  // and the rest became a 50/50 split nobody configured.
  for (const bad of ["-1", "101", "100.5", "abc", "NaN", "Infinity", "1,5", "1e2", "0x10", "50%", "1/2"]) {
    await withEnv({ ...ON, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: bad }, () => {
      assert.throws(
        () => readEndpointingExperimentConfig(),
        ConfigurationError,
        `"${bad}" must be refused, not coerced into a percentage`,
      );
    });
  }
});

await test("E4b - genuinely valid percentages are still accepted", async () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["0", 0], ["50", 50], ["100", 100], ["33.33", 33.33], [" 25 ", 25],
  ];
  for (const [raw, expected] of cases) {
    await withEnv({ ...ON, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: raw }, () => {
      assert.equal(readEndpointingExperimentConfig().treatmentPercent, expected);
    });
  }
});

await test("E4c - an unset or blank split falls back to the documented default", async () => {
  for (const raw of [undefined, "", "   "]) {
    await withEnv({ ...ON, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: raw }, () => {
      assert.equal(readEndpointingExperimentConfig().treatmentPercent, 50);
    });
  }
});

await test("E5 - a malformed percentage cannot take production down while OFF", async () => {
  // Deliberate asymmetry: while the experiment is off the split is
  // never used, so a typo in an unused variable must not throw on every
  // call. Nothing malformed is recorded either - the default is.
  for (const bad of ["999", "abc", "1e2"]) {
    await withEnv({ ...OFF, [ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]: bad }, () => {
      const config = readEndpointingExperimentConfig();
      assert.equal(config.enabled, false);
      assert.equal(config.treatmentPercent, 50, "the unused split reports the default, never the typo");
      const a = assignEndpointing(attemptUuid(1), config);
      assert.equal(a.endpointingMs, 400);
      assert.equal(a.treatmentPercent, undefined, "a call not in the experiment records no split");
    });
  }
});

await test("E6 — an empty key stays on the production default rather than a fake random arm", async () => {
  await withEnv(ON, () => {
    for (const key of ["", "   ", undefined]) {
      const a = assignEndpointing(key);
      assert.equal(a.arm, "control");
      assert.equal(a.endpointingMs, 400);
      assert.equal(a.experimentEnabled, false, "an unassignable call must not claim to be in the experiment");
      assert.equal(a.ineligibleReason, "no-attempt-id");
      assert.equal(a.assignmentKey, undefined, "there is no key to report when nothing was hashed");
    }
  });
});

await test("E7 — the collector refuses to store an assignment carrying a foreign value", () => {
  const collector = new SessionMetricsCollector("sess-e7" as SessionId, STACK);
  collector.noteEndpointingAssignment({
    arm: "treatment",
    endpointingMs: 250,
    experimentEnabled: true,
    assignmentKey: "stt-endpointing:sess-e7",
    treatmentPercent: 50,
  });
  assert.ok(
    !("sttEndpointing" in collector.build()),
    "a record that cannot be true is worse than no record",
  );
});

await test("E8 — the collector refuses an unrecognised arm label", () => {
  const collector = new SessionMetricsCollector("sess-e8" as SessionId, STACK);
  collector.noteEndpointingAssignment({
    arm: "shadow" as never,
    endpointingMs: 400,
    experimentEnabled: true,
    assignmentKey: "stt-endpointing:sess-e8",
    treatmentPercent: 50,
  });
  assert.ok(!("sttEndpointing" in collector.build()));
});

// ═════════════════════════════════════════════════════════════════
// F. TELEMETRY — the arm AND the value actually used
// ═════════════════════════════════════════════════════════════════
section("F. Telemetry records the assignment and the actual value");

await test("F1 — a control assignment round-trips into the metrics record", () => {
  const collector = new SessionMetricsCollector("sess-f1" as SessionId, STACK);
  collector.noteEndpointingAssignment({
    arm: "control",
    endpointingMs: 400,
    experimentEnabled: true,
    assignmentKey: "stt-endpointing:sess-f1",
    treatmentPercent: 50,
  });
  const metrics = collector.build();
  assert.equal(metrics.sttEndpointing?.arm, "control");
  assert.equal(metrics.sttEndpointing?.endpointingMs, 400);
  assert.equal(metrics.sttEndpointing?.experimentEnabled, true);
  assert.equal(metrics.sessionId, "sess-f1", "the call id must be on the same record");
});

await test("F2 — a treatment assignment round-trips with its 300", () => {
  const collector = new SessionMetricsCollector("sess-f2" as SessionId, STACK);
  collector.noteEndpointingAssignment({
    arm: "treatment",
    endpointingMs: 300,
    experimentEnabled: true,
    assignmentKey: "stt-endpointing:sess-f2",
    treatmentPercent: 50,
  });
  const metrics = collector.build();
  assert.equal(metrics.sttEndpointing?.arm, "treatment");
  assert.equal(metrics.sttEndpointing?.endpointingMs, 300);
});

await test("F3 — the record survives JSON serialization into call_metrics.raw", () => {
  const collector = new SessionMetricsCollector("sess-f3" as SessionId, STACK);
  const assignment = assignEndpointing(TREATMENT_KEY, { enabled: true, treatmentPercent: 50 });
  collector.noteEndpointingAssignment(assignment);

  const raw = JSON.parse(JSON.stringify(collector.build())) as Record<string, unknown>;
  const stored = raw["sttEndpointing"] as Record<string, unknown>;

  assert.equal(stored["arm"], "treatment");
  assert.equal(stored["endpointingMs"], 300);
  assert.equal(stored["assignmentKey"], `stt-endpointing:${TREATMENT_KEY}`);
  assert.equal(stored["treatmentPercent"], 50);
  assert.equal(raw["sessionId"], "sess-f3");
});

await test("F4 — the stored key re-derives the same arm, so a record can be audited", () => {
  const assignment = assignEndpointing(TREATMENT_KEY, { enabled: true, treatmentPercent: 50 });
  // An auditor has only the stored record: the key and the split it
  // ran under. Both must be enough to reproduce the arm exactly.
  assert.ok(assignment.assignmentKey, "an in-experiment call must report the key it was hashed on");
  assert.equal(assignment.treatmentPercent, 50);
  const rederived = assignEndpointing(TREATMENT_KEY, {
    enabled: true,
    treatmentPercent: assignment.treatmentPercent ?? Number.NaN,
  });
  assert.deepEqual(rederived, assignment);
});

await test("F5 — an off-mode call still records its arm explicitly, not by omission", async () => {
  await withEnv(OFF, () => {
    const collector = new SessionMetricsCollector("sess-f5" as SessionId, STACK);
    collector.noteEndpointingAssignment(assignEndpointing("sess-f5"));
    const metrics = collector.build();
    assert.equal(metrics.sttEndpointing?.arm, "control");
    assert.equal(metrics.sttEndpointing?.endpointingMs, 400);
    assert.equal(metrics.sttEndpointing?.experimentEnabled, false);
  });
});

// ═════════════════════════════════════════════════════════════════
// G. BACKWARD COMPATIBILITY
// ═════════════════════════════════════════════════════════════════
section("G. Existing callers and configuration unchanged");

await test("G1 — a request with no endpointingMs is the production 400", () => {
  // Exactly the shape every call site built before this field
  // existed — it still satisfies the interface, unannotated.
  const request: StreamingTranscriptionRequest = {
    sessionId: "sess-g1" as SessionId,
    audio: (async function* () {})(),
    language: SupportedLanguage.ENGLISH,
  };
  assert.equal(resolveEndpointingMs(request.endpointingMs), 400);
});

await test("G2 — a session that was never assigned resolves to 400", () => {
  const record = new SessionRecord(
    "sess-g2" as SessionId,
    {
      direction: CallDirection.OUTBOUND,
      language: SupportedLanguage.ENGLISH,
      providerStack: STACK,
    } as never,
    STACK,
  );
  const assignment: EndpointingAssignment | undefined = record.sttEndpointing;
  assert.equal(assignment, undefined, "a hand-built record carries no arm");
  assert.equal(resolveEndpointingMs(record.sttEndpointing?.endpointingMs), 400);
});

await test("G3 — a metrics record built without an assignment omits the field entirely", () => {
  const metrics = new SessionMetricsCollector("sess-g3" as SessionId, STACK).build();
  assert.ok(!("sttEndpointing" in metrics), "absent, never a guessed default object");
});

await test("G4 — a historical record with no sttEndpointing remains readable", () => {
  const historical = JSON.parse(
    JSON.stringify({ sessionId: "old", sttModel: "nova-3", turnLatencies: [] }),
  ) as Record<string, unknown>;
  assert.equal(historical["sttEndpointing"], undefined);
  assert.equal(historical["sttModel"], "nova-3", "existing telemetry is untouched");
});

await test("G5 — the session state machine is unchanged by the assignment", async () => {
  await withEnv(ON, async () => {
    const providers = buildProviders();
    const manager = new DefaultVoiceSessionManager(providers.registry as never);
    const records = (manager as unknown as { sessions: Map<SessionId, InstanceType<typeof SessionRecord>> })
      .sessions;

    const snapshot = await manager.createSession(creationRequest() as never);
    const record = records.get(snapshot.id);
    assert.ok(record);
    record.state = SessionState.CALLING;
    manager.confirmCallAnswered(snapshot.id);

    // The pipeline goes straight on to the greeting, so what must be
    // asserted is the transition the assignment sits beside — not the
    // instantaneous state, and not everything the greeting then does.
    assert.equal(
      record.stateHistory[0] && `${record.stateHistory[0].from}->${record.stateHistory[0].to}`,
      "CALLING->LISTENING",
      "the assignment must not add, skip or reorder the transition it sits beside",
    );
    await sleep(20);
    providers.stop();
    await manager.end(snapshot.id);
  });
});

await test("G6 — the experiment env vars are not set in this process after the suite", () => {
  assert.equal(
    process.env[ENDPOINTING_EXPERIMENT_ENABLED_ENV] === "true",
    false,
    "the suite must not leave the experiment switched on",
  );
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
