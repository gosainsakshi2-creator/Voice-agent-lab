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
const { MulawVadSegmenter } = await import("../../server/vad-segmenter");
const { pcm16ToMulaw } = await import("../../server/audio-codec");
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
  say(text: string, opts?: { readonly speaker?: string }): void;
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
  /** Request indices whose stream throws before any token, like an API error. */
  readonly llmFailRequests?: ReadonlySet<number>;
  readonly llmErrorFallback?: boolean;
  readonly backgroundVoiceGuard?: boolean;
  readonly openingSilencePrompt?: boolean;
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
      if (input.llmFailRequests?.has(requests.length - 1)) {
        throw Object.assign(new Error("429 Rate limit reached for requests"), { name: "RateLimitError", status: 429 });
      }
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
    ...(input.llmErrorFallback === true ? { llmErrorFallback: true } : {}),
    ...(input.backgroundVoiceGuard === true ? { backgroundVoiceGuard: true, ignoreOtherSpeakersOverReply: true } : {}),
    ...(input.openingSilencePrompt === true ? { openingSilencePrompt: true } : {}),
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
    say(text, opts = {}) {
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
        ...(opts.speaker !== undefined ? { speaker: opts.speaker } : {}),
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
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 1 });
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 300 });
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
      framesSent: 50, starvedCount: 2, starvedEarlyCount: 1, gapCount: 2, gapMsTotal: 461, maxGapMs: 341,
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

await test("C1c. each starve records what the producer was doing", () => {
  const c = new SessionMetricsCollector("sess-c1c" as SessionId, STACK as never);
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 200, producer: "tts_first_chunk" });
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 200, producer: "tts_streaming" });
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 200, producer: "tts_streaming" });
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 200 });
  assert.deepEqual(c.build().delivery?.starvedWhile, { ttsFirstChunk: 1, ttsStreaming: 2, waitingLlm: 0, replyDone: 0 });
});

await test("C1d. calls 3c0ae749/943a5341: the pump running dry after the reply's last sentence is the reply ending, not a gap", () => {
  const c = new SessionMetricsCollector("sess-c1d" as SessionId, STACK as never);
  for (let i = 0; i < 100; i++) c.countOutboundFrame();
  // The reply ends: dry pump, then the end-of-speech flush restarts it ~450ms later.
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 100, producer: "reply_done" });
  c.noteOutboundDelivery({ kind: "gap", ms: 450 });
  // A real mid-reply gap still counts.
  c.noteOutboundDelivery({ kind: "starved", framesBefore: 100, producer: "tts_streaming" });
  c.noteOutboundDelivery({ kind: "gap", ms: 300 });
  const d = c.build().delivery!;
  assert.deepEqual(
    { starved: d.starvedCount, gaps: d.gapCount, gapMs: d.gapMsTotal, replyDone: d.starvedWhile?.replyDone, streaming: d.starvedWhile?.ttsStreaming },
    { starved: 1, gaps: 1, gapMs: 300, replyDone: 1, streaming: 1 },
  );
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

// ═════════════════════════════════════════════════════════════════
section("SECTION F — background-voice step 1: how loud, who, how sure (telemetry only)");
// ═════════════════════════════════════════════════════════════════

/** One 20ms μ-law frame of a tone at `amplitude` (0 = silence). */
const toneFrame = (amplitude: number): Uint8Array => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 300 * i) / 8000));
  return pcm16ToMulaw(pcm);
};

await test("F1. the VAD reports the RMS of speech frames only, and nothing without the callback", () => {
  const seen: number[] = [];
  const vad = new MulawVadSegmenter(() => undefined, undefined, { speechThreshold: 700, onSpeechFrameRms: (rms) => seen.push(rms) });
  for (let i = 0; i < 5; i++) vad.push(toneFrame(6000));
  for (let i = 0; i < 5; i++) vad.push(toneFrame(0));
  assert.equal(seen.length, 5, `speech frames only, got ${seen.length}`);
  assert.ok(seen.every((r) => r > 3000 && r < 5000), JSON.stringify(seen.map(Math.round)));
  new MulawVadSegmenter(() => undefined).push(toneFrame(6000));
});

await test("F2. each turn records its level against the median of the caller's earlier turns, and the STT confidence", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await h.waitForReplies(1);
    // The caller's first turn: 20 frames at -20 dBFS sets their level.
    h.record.inboundSpeechLevel = { sumDbfs: -20 * 20, frames: 20 };
    h.say("Yes, tell me.");
    await h.waitFor("the block to finish", () => h.record.state === SessionState.LISTENING && h.assistantTexts().length >= 2, 30000);
    // A turn 18 dB quieter: the shape of a voice across the room.
    h.record.inboundSpeechLevel = { sumDbfs: -38 * 30, frames: 30 };
    h.say("Okay, sounds good.");
    await h.waitFor("both turns recorded", () => h.record.metrics.build().turnLatencies.filter((t) => t.voice !== undefined).length >= 2, 20000);
    const voices = h.record.metrics.build().turnLatencies.map((t) => t.voice).filter((v) => v !== undefined);
    assert.deepEqual(
      voices.map((v) => ({ frames: v!.speechFrames, dbfs: v!.speechDbfs, vsCaller: v!.levelVsCallerDb, confidence: v!.confidence })),
      [
        { frames: 20, dbfs: -20, vsCaller: undefined, confidence: 0.95 },
        { frames: 30, dbfs: -38, vsCaller: -18, confidence: 0.95 },
      ],
    );
    assert.equal(h.record.inboundSpeechLevel.frames, 0, "read and reset once per turn");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION G — test-call audio capture (RECORD_CALL_AUDIO)");
// ═════════════════════════════════════════════════════════════════

const { DefaultVoiceSessionManager } = await import("../../core/session/voice-session-manager.impl");
const stubRegistry = { resolve: () => ({ descriptor: { category: ProviderCategory.TELEPHONY, id: "stub" } }) } as never;
const newSession = async (record: boolean) => {
  const before = process.env.RECORD_CALL_AUDIO;
  if (record) process.env.RECORD_CALL_AUDIO = "true";
  else delete process.env.RECORD_CALL_AUDIO;
  try {
    const manager = new DefaultVoiceSessionManager(stubRegistry);
    const created = await manager.createSession({ language: SupportedLanguage.ENGLISH, direction: CallDirection.OUTBOUND, providerStack: STACK as never });
    return { manager, sessionId: created.id };
  } finally {
    if (before === undefined) delete process.env.RECORD_CALL_AUDIO;
    else process.env.RECORD_CALL_AUDIO = before;
  }
};
const frame = (byte: number): AudioPayload => ({ data: new Uint8Array(160).fill(byte), encoding: "MULAW", sampleRateHz: 8000 });

await test("G1. ON: the caller-side frames are kept in order, with the agent's speaking spans, and taken once", async () => {
  const { manager, sessionId } = await newSession(true);
  for (let i = 0; i < 50; i++) manager.pushInboundAudio(sessionId, frame(i));
  const capture = manager.takeAudioCapture(sessionId)!;
  assert.ok(capture !== undefined);
  assert.equal(capture.durationMs, 1000, "50 frames of 20ms");
  const bytes = Buffer.from(capture.base64, "base64");
  assert.equal(bytes.length, 8000);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[160 * 49], 49, "frames kept in the order they arrived");
  assert.equal(manager.takeAudioCapture(sessionId), undefined, "taken once");
});

await test("G2. OFF (the default): nothing is captured", async () => {
  const { manager, sessionId } = await newSession(false);
  manager.pushInboundAudio(sessionId, frame(1));
  assert.equal(manager.takeAudioCapture(sessionId), undefined);
});

// ═════════════════════════════════════════════════════════════════
section("SECTION H — a failed LLM stream says why (call 8b8069a8)");
// ═════════════════════════════════════════════════════════════════

await test("H1. a turn whose LLM stream throws records the error's name, message and status", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], llmFailRequests: new Set([1]) });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block", () => h.assistantTexts().length >= 2 && h.record.state === SessionState.LISTENING, 30000);
    h.say("And what does it cost?");
    await h.waitFor("the failed turn to be recorded", () => h.record.metrics.build().turnLatencies.some((t) => t.llmError !== undefined), 20000);
    const failed = h.record.metrics.build().turnLatencies.find((t) => t.llmError !== undefined)!;
    assert.equal(failed.turnOutcome, "stream_error");
    assert.deepEqual(failed.llmError, { name: "RateLimitError", message: "429 Rate limit reached for requests", status: 429 });
  } finally {
    await h.stop();
  }
});

const { llmErrorLine } = await import("../../core/session/conversation-pipeline");
const REPEAT = llmErrorLine(SupportedLanguage.ENGLISH, false);
const GIVE_UP = llmErrorLine(SupportedLanguage.ENGLISH, true);

/** Runs the block, then sends `asks` caller turns, one after each reply settles. */
async function failedTurns(h: Harness, asks: readonly string[]): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the block", () => h.assistantTexts().length >= 2 && h.record.state === SessionState.LISTENING, 30000);
  for (const [i, ask] of asks.entries()) {
    h.say(ask);
    await h.waitFor(`failed turn ${i + 1}`, () => h.record.metrics.build().turnLatencies.filter((t) => t.llmError !== undefined).length >= i + 1, 20000);
    await h.waitFor("listening again", () => h.record.state === SessionState.LISTENING, 20000);
  }
}

await test("H2. ON: a failed reply is answered with the fixed repeat line, not silence, and committed", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], llmFailRequests: new Set([1]), llmErrorFallback: true });
  try {
    await failedTurns(h, ["And what does it cost?"]);
    assert.ok(h.synthesized.includes(REPEAT), `spoken: ${JSON.stringify(h.synthesized)}`);
    assert.equal(h.assistantTexts().at(-1), REPEAT);
  } finally {
    await h.stop();
  }
});

await test("H3. ON: two failures ask to repeat, the third says the line is unclear, the fourth is silent", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], llmFailRequests: new Set([1, 2, 3, 4]), llmErrorFallback: true });
  try {
    await failedTurns(h, ["What does it cost?", "Is it on Sunday morning?", "Do I need a laptop for it?", "Will there be a recording?"]);
    assert.equal(h.synthesized.filter((t) => t === REPEAT).length, 2);
    assert.equal(h.synthesized.filter((t) => t === GIVE_UP).length, 1);
  } finally {
    await h.stop();
  }
});

await test("H4. OFF (the default): a failed reply stays silent, exactly as before", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], llmFailRequests: new Set([1]) });
  try {
    await failedTurns(h, ["And what does it cost?"]);
    assert.ok(!h.synthesized.includes(REPEAT) && !h.synthesized.includes(GIVE_UP));
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION I — background voice (calls 4f59ca66 / 85515f69, 2026-10-03)");
// ═════════════════════════════════════════════════════════════════

/** The caller (label "2") answers at -20 dBFS; returns once the block has played. */
async function callerEstablished(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.record.inboundSpeechLevel = { sumDbfs: -20 * 40, frames: 40 };
  h.say("Yes, tell me.", { speaker: "2" });
  await h.waitFor("the block", () => h.assistantTexts().length >= 2 && h.record.state === SessionState.LISTENING, 30000);
}

const VIDEO = "नमस्ते, मेरा नाम प्रीति है।";

await test("I1. ON: call b568b5e1 — a quieter turn in another label is NEVER dropped: answered, and only counted", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], backgroundVoiceGuard: true });
  try {
    await callerEstablished(h);
    const turnsBefore = h.record.metrics.build().turnLatencies.length;
    // The caller's own question, quieter and in the other label — exactly what was dropped on b568b5e1.
    h.record.inboundSpeechLevel = { sumDbfs: -27 * 60, frames: 60 };
    h.say("Okay, like what are you telling me? Tell me about that.", { speaker: "1" });
    await h.waitFor("the turn answered", () => h.record.metrics.build().turnLatencies.length > turnsBefore, 20000);
    assert.ok(h.record.memory.history().some((t) => t.role === "user" && t.content.includes("Tell me about that")), "in the transcript");
    assert.equal(h.record.metrics.build().turnLatencies.at(-1)?.backgroundTurnsSuspected, 1);
  } finally {
    await h.stop();
  }
});

await test("I2. ON: the caller's own turn in a flipped label, at their own level, is answered (call 85515f69)", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], backgroundVoiceGuard: true });
  try {
    await callerEstablished(h);
    const requestsBefore = h.requests.length;
    h.record.inboundSpeechLevel = { sumDbfs: -21 * 60, frames: 60 };
    h.say("Listen, I want to ask you something about it.", { speaker: "1" });
    await h.waitFor("a reply", () => h.requests.length > requestsBefore, 20000);
  } finally {
    await h.stop();
  }
});

await test("I3. ON: a short quiet \"Okay.\" in another label is never dropped — too little audio to judge", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], backgroundVoiceGuard: true });
  try {
    await callerEstablished(h);
    const requestsBefore = h.requests.length;
    h.record.inboundSpeechLevel = { sumDbfs: -28 * 5, frames: 5 };
    h.say("Is it free?", { speaker: "1" });
    await h.waitFor("a reply", () => h.requests.length > requestsBefore, 20000);
  } finally {
    await h.stop();
  }
});

await test("I4. OFF (the default): the same quiet video line is answered, exactly as before", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await callerEstablished(h);
    const requestsBefore = h.requests.length;
    h.record.inboundSpeechLevel = { sumDbfs: -27 * 60, frames: 60 };
    h.say(VIDEO, { speaker: "1" });
    await h.waitFor("a reply", () => h.requests.length > requestsBefore, 20000);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION J — a caller who never speaks after the opening (call 1098ac39)");
// ═════════════════════════════════════════════════════════════════

const ARE_YOU_THERE = "Hello, are you there?";

await test("J1. ON: nothing said after the opening — \"are you there?\" ~6s after the agent finished, not 30s", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], openingSilencePrompt: true });
  try {
    await h.waitForReplies(1);
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING, 15000);
    const finishedAt = Date.now();
    await h.waitFor("the prompt", () => h.synthesized.includes(ARE_YOU_THERE), 10000);
    const afterMs = Date.now() - finishedAt;
    assert.ok(afterMs >= 5000 && afterMs <= 9000, `prompted ${afterMs}ms after the opening finished`);
  } finally {
    await h.stop();
  }
});

await test("J2. OFF (the default): the same silence gets no prompt within 10s, exactly as before", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await h.waitForReplies(1);
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING, 15000);
    await sleep(10000);
    assert.ok(!h.synthesized.includes(ARE_YOU_THERE));
  } finally {
    await h.stop();
  }
});

await test("J3. ON: a caller who answered and then listens silently to a long pitch is NOT asked \"are you there?\" after it", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], openingSilencePrompt: true });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the pitch to start", () => h.record.state === SessionState.SPEAKING, 15000);
    await h.waitFor("the pitch to finish", () => h.assistantTexts().length >= 2 && h.record.state === SessionState.LISTENING, 30000);
    await sleep(10000);
    assert.ok(!h.synthesized.includes(ARE_YOU_THERE), "the caller has spoken, so the 30s window applies");
  } finally {
    await h.stop();
  }
});

void SCRIPT_TEXT;
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, the STT, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
