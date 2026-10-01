/**
 * stop-and-delivery-tests.ts — `npm run test:stop-and-delivery`
 *
 * P0 #3 (part) and P0 #2, 2026-10-01.
 *
 *   SECTION A  `isStopRequest`: "wait" / "ruko" / "रुको" alone — not
 *              "actually", not "haan", not "wait, what did you say?".
 *   SECTION B  `stopOnRequest`: a one-word stop INTERIM interrupts the
 *              reply at once instead of waiting ~0.5s for its final; off,
 *              nothing changes; the energy gate still applies.
 *   SECTION C  delivery counters: what the media bridges already logged
 *              (starved pump, gap, late burst, send error, socket close)
 *              now reaches `call_metrics.raw`, per call and per turn.
 *
 * Harness copied from interruption-note-tests.ts. Every provider is a
 * local fake; nothing places a call or reads the database.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { isStopRequest } = await import("../../core/session/turn-detection");
const { SessionMetricsCollector, socketCloseEvent } = await import("../../core/session/metrics-collector");
const { RuntimeHealthProbe } = await import("../../core/session/runtime-health");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId } from "../../types/session.types";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── The harness (same shape as the script-repetition suite) ───────

/**
 * The fake TTS returns a clip whose real-time duration is proportional
 * to the text, at the same ~22 characters per second the chunker's own
 * thresholds are reasoned about in. That is what makes "interrupt 600ms
 * into a 2.8s sentence" a statement this suite can actually make.
 */
const CHARS_PER_SECOND = 22;
const msFor = (text: string) => (text.length / CHARS_PER_SECOND) * 1000;

function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return { data: new Uint8Array(Math.round(seconds * 8000)), encoding: "MULAW", sampleRateHz: 8000 };
}

function descriptor(category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) {
  return {
    category,
    id,
    displayName: id,
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH],
    version: "fake",
  };
}

const healthy = (identifier: { category: unknown; id: string }) => ({
  identifier,
  isHealthy: true,
  checkedAt: new Date(),
});

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  say(text: string): void;
  /** An INTERIM segment only — no final follows unless the test sends one. */
  sayInterim(text: string, opts?: { readonly confidence?: number; readonly startedAtMs?: number }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  assistantTurns(): readonly ConversationTurn[];
  assistantTexts(): readonly string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly replies: readonly string[];
  /**
   * Simulate a real media bridge (2026-09-25): every chunk is ENQUEUED
   * the instant it is handed over, a pump sends it in real time after a
   * 100ms pre-roll (idle time is not banked), a barge-in clears what is
   * unsent, and the bridge reports that unsent queue as its backlog —
   * the Plivo/Vobiz contract. `highWaterMs` adds Plivo's backpressure:
   * the listener's promise holds the producer while the queue is at or
   * above it. Omitted, no bridge is installed and no backlog is read.
   */
  readonly bridge?: { readonly highWaterMs?: number };
  readonly stopOnRequest?: boolean;
  readonly callerFirstTurnTaking?: boolean;
  /** Delay before the Nth request's first token (by request index), so a turn can supersede it while THINKING. */
  readonly llmDelayMs?: Readonly<Record<number, number>>;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;

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
    generateCompletion: async (request: CompletionRequest) => {
      requests.push(request.history);
      return { turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(input.llmDelayMs?.[requests.length - 1] ?? 10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: reply, timestamp: new Date() },
        latencyMs: 1,
      };
    },
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      return clipFor(task.request.text);
    },
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
    "interruption-note-test" as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: stack,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test",
        campaignType: "registration",
        scriptId: "test",
        scriptVersion: "v1",
        scriptHash: "test",
        agent: { gender: "male", name: "Rohan" },
        customer: { name: "Sakshi" },
        openingLine: OPENING,
        systemPromptAppendix: SCRIPT_TEXT,
      },
    },
    stack,
  );
  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  // The one thing a bridge installs that this suite cares about. Left
  // unset (the default) the pipeline reads no backlog at all, which is
  // exactly what the in-process fallback does today.
  const BRIDGE_PREROLL_MS = 100;
  let bridgeQueueMs = 0;
  let bridgeDrainFromMs = 0;
  const drainBridge = (): void => {
    const now = Date.now();
    if (bridgeQueueMs > 0 && now > bridgeDrainFromMs) {
      bridgeQueueMs = Math.max(0, bridgeQueueMs - (now - bridgeDrainFromMs));
      bridgeDrainFromMs = now;
    }
  };
  if (input.bridge === undefined) {
    record.outboundAudioListeners.add(() => undefined);
  } else {
    const highWaterMs = input.bridge.highWaterMs;
    record.outboundAudioListeners.add((audio: AudioPayload) => {
      if (audio.data.byteLength === 0) return undefined;
      drainBridge();
      // An empty queue restarts the pump, after its pre-roll.
      if (bridgeQueueMs === 0) bridgeDrainFromMs = Date.now() + BRIDGE_PREROLL_MS;
      bridgeQueueMs += (audio.data.byteLength / audio.sampleRateHz) * 1000;
      if (highWaterMs === undefined) return undefined;
      drainBridge();
      if (bridgeQueueMs < highWaterMs) return undefined;
      return new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          drainBridge();
          if (closed || bridgeQueueMs < highWaterMs) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
    });
    record.outboundBacklogMs = () => {
      drainBridge();
      return bridgeQueueMs;
    };
  }

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      // A bridge discards what it has not sent when SPEAKING ends on a
      // barge-in; after a normal finish the queue has already drained.
      if (r.state === SessionState.SPEAKING && to !== SessionState.SPEAKING) bridgeQueueMs = 0;
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never, {
    ...(input.stopOnRequest === true ? { stopOnRequest: true } : {}),
    ...(input.callerFirstTurnTaking === true ? { callerFirstTurnTaking: true } : {}),
  });
  const loop = pipeline.run();

  return {
    record,
    requests,
    synthesized,
    sayInterim(text, opts = {}) {
      const startedAtMs = opts.startedAtMs ?? clockMs;
      segments.push({
        text,
        isFinal: false,
        isSpeechFinal: false,
        confidence: opts.confidence ?? 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: startedAtMs + 300,
      });
      waiters.shift()?.();
    },
    say(text) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, msFor(text));
      segments.push({
        text,
        isFinal: true,
        isSpeechFinal: true,
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      });
      waiters.shift()?.();
    },
    async waitFor(what, predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async waitForReplies(n, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((t) => t.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${
          record.memory.history().filter((t) => t.role === "assistant").length
        }, state=${record.state})`,
      );
    },
    assistantTurns() {
      return record.memory.history().filter((t) => t.role === "assistant");
    },
    assistantTexts() {
      return record.memory
        .history()
        .filter((t) => t.role === "assistant")
        .map((t) => t.content);
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}


// ─── Script shape ──────────────────────────────────────────────────

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const S1 = "Actually, I am calling you with a very interesting invitation.";
const S2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const S3 = "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${S1} ${S2} ${S3}`;
const ANSWER = "Sure, take your time.";
const FOLLOW_UP = "Great, shall I reserve your seat?";
const SCRIPT_TEXT = `${OPENING}\n${BLOCK}`;

async function startBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
}

const STACK = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
};

// ═════════════════════════════════════════════════════════════════
section("SECTION A — what counts as a stop request");
// ═════════════════════════════════════════════════════════════════

await test("A1. the stop words, alone, in English, Hinglish and Devanagari", () => {
  for (const s of ["wait", "Wait.", "wait wait", "hold on", "one second", "just a minute", "stop", "ruko", "rukiye", "ek minute", "रुको", "रुकिए", "एक मिनट"]) {
    assert.ok(isStopRequest(s), `"${s}" must be a stop request`);
  }
});

await test("A2. …but not thinking aloud, an acknowledgement, or a longer turn that opens with one", () => {
  for (const s of ["actually", "i mean", "matlab", "haan", "okay", "hmm", "wait, what did you say?", "one second please tell me the price", ""]) {
    assert.ok(!isStopRequest(s), `"${s}" must not be a stop request`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — a one-word \"wait\" interim while the agent speaks");
// ═════════════════════════════════════════════════════════════════

await test("B1. option ON: an interim \"wait\" stops the reply at once, no final needed", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], stopOnRequest: true });
  try {
    await startBlock(h);
    await sleep(600);
    h.sayInterim("wait");
    await h.waitFor("the reply to stop", () => h.record.state !== SessionState.SPEAKING, 3000);
  } finally {
    await h.stop();
  }
});

await test("B2. option OFF: the same interim is ignored, exactly as before", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.sayInterim("wait");
    await sleep(1500);
    assert.equal(h.record.state, SessionState.SPEAKING, "a one-word interim still waits for its final");
  } finally {
    await h.stop();
  }
});

await test("B3. option ON: an interim \"okay\" still does not stop the reply", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], stopOnRequest: true });
  try {
    await startBlock(h);
    await sleep(600);
    h.sayInterim("okay");
    await sleep(1500);
    assert.equal(h.record.state, SessionState.SPEAKING);
  } finally {
    await h.stop();
  }
});

await test("B4. option ON: the energy gate still applies — a \"wait\" with no loud speech behind it is ignored", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], stopOnRequest: true });
  try {
    await startBlock(h);
    // A transport that reports energy, last loud 5s ago: the TV across the room.
    h.record.lastCallerEnergyAt = Date.now() - 5000;
    await sleep(600);
    h.sayInterim("wait");
    await sleep(1500);
    assert.equal(h.record.state, SessionState.SPEAKING);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — delivery counters");
// ═════════════════════════════════════════════════════════════════

await test("C1. the collector totals what the bridge reports, and build() carries it", () => {
  const c = new SessionMetricsCollector("sess-c1" as SessionId, STACK as never);
  assert.equal(c.build().delivery, undefined, "nothing sent, nothing recorded");
  for (let i = 0; i < 50; i++) c.countOutboundFrame();
  c.noteOutboundDelivery({ kind: "starved" });
  c.noteOutboundDelivery({ kind: "gap", ms: 340.6 });
  c.noteOutboundDelivery({ kind: "gap", ms: 120 });
  c.noteOutboundDelivery({ kind: "burst_capped", lateMs: 400 });
  c.noteOutboundDelivery({ kind: "send_error" });
  c.noteOutboundDelivery(socketCloseEvent([1006, Buffer.from("abnormal")]));
  c.noteOutboundDelivery(socketCloseEvent([1000, Buffer.from("later")]));
  const d = c.build().delivery!;
  assert.deepEqual(
    { ...d, socketClose: { code: d.socketClose?.code, reason: d.socketClose?.reason } },
    {
      framesSent: 50, starvedCount: 1, gapCount: 2, gapMsTotal: 461, maxGapMs: 341,
      burstCapCount: 1, maxLateMs: 400, sendErrors: 1,
      socketClose: { code: 1006, reason: "abnormal" },
    },
  );
  assert.ok(Number.isInteger(d.gapMsTotal) && Number.isInteger(d.maxGapMs), "integers only");
});

await test("C1b. call 64f54e00: a turn's max gap is its own, even when an earlier turn's was bigger", () => {
  const c = new SessionMetricsCollector("sess-c1b" as SessionId, STACK as never);
  c.noteOutboundDelivery({ kind: "gap", ms: 465 });
  c.noteOutboundDelivery({ kind: "burst_capped", lateMs: 1800 });
  assert.equal(c.deliverySnapshot().maxGapMs, 465);
  c.noteOutboundDelivery({ kind: "gap", ms: 453 });
  const second = c.deliverySnapshot();
  assert.equal(second.maxGapMs, 453, "the second turn's own gap, not 0");
  assert.equal(second.maxLateMs, 0, "no late burst in the second turn");
  assert.equal(c.build().delivery!.maxGapMs, 465, "the call-wide max is unchanged");
  assert.equal(c.build().delivery!.maxLateMs, 1800);
});

await test("C2. a turn records the counters since the previous turn, and only when something happened", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await startBlock(h);
    for (let i = 0; i < 30; i++) h.record.metrics.countOutboundFrame();
    h.record.metrics.noteOutboundDelivery({ kind: "gap", ms: 250 });
    await h.waitFor("the block to finish", () => h.record.state === SessionState.LISTENING, 30000);
    h.say("Okay, sounds good.");
    await h.waitForReplies(3, 20000);
    await h.waitFor("the turn to be recorded", () => h.record.metrics.build().turnLatencies.length >= 2, 20000);
    const turns = h.record.metrics.build().turnLatencies;
    const withDelivery = turns.filter((t) => t.delivery !== undefined);
    assert.equal(withDelivery.length, 1, `one turn carries it, got ${JSON.stringify(turns.map((t) => t.delivery))}`);
    assert.deepEqual(
      { frames: withDelivery[0]!.delivery!.framesSent, gaps: withDelivery[0]!.delivery!.gapCount, gapMs: withDelivery[0]!.delivery!.gapMsTotal },
      { frames: 30, gaps: 1, gapMs: 250 },
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — caller first: quiet but clear speech stops the reply, acknowledgements never do");
// ═════════════════════════════════════════════════════════════════

/** Start the block, then make the caller QUIET: the bridge reports energy, last loud 5s ago. */
async function quietCaller(h: Harness): Promise<void> {
  await startBlock(h);
  h.record.lastCallerEnergyAt = Date.now() - 5000;
  await sleep(600);
}

const keepsSpeaking = async (h: Harness): Promise<void> => {
  await sleep(1500);
  assert.equal(h.record.state, SessionState.SPEAKING, "the agent must keep talking");
};
const stops = (h: Harness) => h.waitFor("the reply to stop", () => h.record.state !== SessionState.SPEAKING, 3000);

await test("D1. ON: a quiet question stops the reply", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], callerFirstTurnTaking: true });
  try {
    await quietCaller(h);
    h.sayInterim("how much does this cost", { startedAtMs: 6000 });
    await stops(h);
    assert.ok((h.record.metrics.build().bargeInGate?.energyBypassed ?? 0) >= 1, "and telemetry counts it");
  } finally {
    await h.stop();
  }
});

await test("D2. OFF: the same quiet question is ignored, exactly as before — and counted", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await quietCaller(h);
    h.sayInterim("how much does this cost", { startedAtMs: 6000 });
    await keepsSpeaking(h);
    assert.ok((h.record.metrics.build().bargeInGate?.uncorroboratedInterims ?? 0) >= 1, "the miss is now visible in telemetry");
  } finally {
    await h.stop();
  }
});

for (const [label, loud] of [["quiet", false], ["loud", true]] as const) {
  await test(`D3. ON: a ${label} acknowledgement never stops the reply`, async () => {
    const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], callerFirstTurnTaking: true });
    try {
      await quietCaller(h);
      if (loud) h.record.lastCallerEnergyAt = Date.now();
      h.sayInterim("haan ji haan", { startedAtMs: 6000 });
      await keepsSpeaking(h);
      h.sayInterim("okay okay", { startedAtMs: 6500 });
      await keepsSpeaking(h);
    } finally {
      await h.stop();
    }
  });
}

await test("D4. ON: two quiet words right after the reply started (the caller carrying on after a pause) stop it", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], callerFirstTurnTaking: true });
  try {
    await quietCaller(h);
    h.sayInterim("and also", { startedAtMs: 500 });
    await stops(h);
  } finally {
    await h.stop();
  }
});

await test("D5. ON: …but two quiet words deep into the reply do not", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], callerFirstTurnTaking: true });
  try {
    await quietCaller(h);
    h.sayInterim("and also", { startedAtMs: 6000 });
    await keepsSpeaking(h);
  } finally {
    await h.stop();
  }
});

await test("D6. ON: quiet speech the STT is unsure of still does not stop the reply", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], callerFirstTurnTaking: true });
  try {
    await quietCaller(h);
    h.sayInterim("how much does this cost", { startedAtMs: 6000, confidence: 0.6 });
    await keepsSpeaking(h);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — runtime health: a blocked event loop is measured");
// ═════════════════════════════════════════════════════════════════

await test("E1. a 400ms synchronous block shows up as loopMaxMs, and the figures freeze at stop", async () => {
  const probe = new RuntimeHealthProbe();
  probe.start();
  await sleep(100);
  const until = Date.now() + 400;
  while (Date.now() < until) {
    // Block the event loop, as a stalled reply start would.
  }
  await sleep(100);
  probe.stop();
  const r = probe.snapshot();
  assert.ok(r.loopMaxMs >= 200, `loopMaxMs=${r.loopMaxMs}`);
  // The block was our own CPU work, so the stall's CPU is about its length.
  assert.ok(r.stallCount >= 1, `stallCount=${r.stallCount}`);
  const worst = r.stalls[0]!;
  assert.ok(worst.gapMs >= 250, JSON.stringify(worst));
  assert.ok(worst.cpuMs >= worst.gapMs * 0.5, `a busy loop uses CPU: ${JSON.stringify(worst)}`);
  assert.ok(typeof r.nodeEnv === "string" && r.rssMb > 0, JSON.stringify(r));
  await sleep(50);
  assert.deepEqual(probe.snapshot(), r, "frozen after stop");
});

await test("E2. the collector reports `runtime` only when a probe is attached, and stops it at call end", () => {
  const c = new SessionMetricsCollector("sess-e2" as SessionId, STACK as never);
  assert.equal(c.build().runtime, undefined);
  const probe = new RuntimeHealthProbe();
  probe.start();
  c.attachRuntimeProbe(probe);
  c.markCallEnded();
  const first = c.build().runtime;
  assert.ok(first !== undefined);
  assert.deepEqual(c.build().runtime, first, "stopped: the same figures every build");
});

void SCRIPT_TEXT;
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, the STT, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
