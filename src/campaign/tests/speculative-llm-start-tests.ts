/**
 * speculative-llm-start-tests.ts — `npm run test:speculative-llm`
 *
 * FIX #8 — the LLM request for a turn is PRE-OPENED the instant the turn
 * detector arms its EVIDENCED confirmation window (Deepgram's own
 * `speech_final` / end-of-speech marker + text that reads as finished +
 * no outstanding interim), so the provider's time-to-first-token runs
 * during that window instead of after it. Turn RELEASE is unchanged, and
 * the request that is eventually adopted must be the one the normal path
 * would have sent.
 *
 * What is proved here, in order:
 *
 *   SECTION A — what the detector's `onTurnPending` hook fires on, and
 *     what it never fires on. Explicit endpoint evidence (`feed`'s fast
 *     path, `noteEndOfSpeech`, the P0-1 collapse), plus ONE site with no
 *     claim at all: arming the chunk-boundary grace, a full adaptive
 *     silence window after the boundary, on text that survived every
 *     mid-thought guard. An interim, the boundary ON ARRIVAL, a provider
 *     that reports no claim, fillers, hold phrases and incomplete
 *     thoughts never fire it.
 *
 *   SECTION B — the pipeline: no request on interim-only input; no
 *     request on an `is_final` as it arrives; a request opened within
 *     milliseconds of `speech_final` / the marker, or a silence window
 *     after an unendpointed boundary — in every case BEFORE the user
 *     turn is committed, then adopted, ONE request per turn however many
 *     times the detector announced it; caller resuming speech aborts it;
 *     attention-check turns spend zero requests; barge-in takes exactly
 *     today's path; a provider without streaming is untouched.
 *
 *   SECTION C — the adopted request is identical, role for role and
 *     content for content, to the request the non-speculative path builds
 *     for the same conversation.
 *
 *   SECTION D — a timing readout (informational, asserted loosely) of
 *     evidence → llm-open, evidence → release, release → llm-request.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the
 * conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { AdaptiveTurnDetector } = await import("../../core/session/turn-detection");
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

// ═════════════════════════════════════════════════════════════════
// Detector-level helpers
// ═════════════════════════════════════════════════════════════════

function segment(
  text: string,
  opts: { isFinal?: boolean; isSpeechFinal?: boolean | undefined; omitSpeechFinal?: boolean } = {},
  streamMs = 1_000,
): TranscriptSegment {
  const base: TranscriptSegment = {
    text,
    isFinal: opts.isFinal ?? true,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: streamMs - 1_000,
    endedAtMs: streamMs,
  };
  if (opts.omitSpeechFinal) return base;
  return { ...base, isSpeechFinal: opts.isSpeechFinal ?? false };
}

/** Feeds segments and reports what `onTurnPending` / `onTurnEnd` saw. */
async function observe(
  steps: Array<{ seg?: TranscriptSegment; marker?: true; afterMs?: number }>,
  settleMs: number,
): Promise<{ pending: string[]; released: string[] }> {
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  const released: string[] = [];
  detector.onTurnPending((text) => pending.push(text));
  detector.onTurnEnd((event) => released.push(event.text));
  for (const step of steps) {
    if (step.afterMs) await sleep(step.afterMs);
    if (step.marker) detector.noteEndOfSpeech();
    else if (step.seg) detector.feed(step.seg);
  }
  await sleep(settleMs);
  detector.reset();
  return { pending, released };
}

// ═════════════════════════════════════════════════════════════════
// Pipeline harness — the real pipeline against local fakes
// ═════════════════════════════════════════════════════════════════

/** ~22 chars/second is ordinary speech. */
const CHARS_PER_SECOND = 22;

function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return {
    data: new Uint8Array(Math.round(seconds * 8000)),
    encoding: "MULAW",
    sampleRateHz: 8000,
  };
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

interface SeenRequest {
  readonly history: readonly ConversationTurn[];
  /** Wall clock at which the provider was handed the request. */
  readonly at: number;
  /**
   * Whether the pipeline had ALREADY committed a user turn ending in this
   * request's user text when the request was made. `false` is the
   * signature of a pre-opened (speculative) request: the normal path
   * commits first and requests second.
   */
  readonly userTurnCommitted: boolean;
  /** The user text this request answers, as the last line of the annotated user turn. */
  readonly userText: string;
  aborted(): boolean;
  /** Whether the consumer pulled the stream through to its final event. */
  consumed: boolean;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: SeenRequest[];
  readonly synthesized: string[];
  readonly transitions: Array<{ readonly to: string; readonly reason: string }>;
  say(
    text: string,
    opts?: {
      isFinal?: boolean;
      isSpeechFinal?: boolean;
      /**
       * Omit `isSpeechFinal` from the segment ENTIRELY — the shape a
       * provider that reports no endpoint claim produces. The detector
       * reads absent as "assume endpointed", so such a turn never takes
       * the chunk-boundary grace AND is never announced (`feed` notifies
       * only on `isSpeechFinal === true`). It is the only remaining way
       * to drive a genuinely non-speculative release through the
       * pipeline, which is what C1 needs to compare against.
       */
      omitSpeechFinal?: boolean;
    },
  ): void;
  markEndOfSpeech(): void;
  bargedIn(): boolean;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  logs: string[];
  stop(): Promise<void>;
}

function lastLine(content: string): string {
  const lines = content.split("\n");
  return lines[lines.length - 1] ?? "";
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
  /** Omit `generateCompletionStream` entirely — the batch-LLM shape. */
  readonly streaming?: boolean;
  readonly sessionId?: string;
  readonly captureLogs?: boolean;
}): Harness {
  const requests: SeenRequest[] = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  const transitions: Array<{ readonly to: string; readonly reason: string }> = [];
  const logs: string[] = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;

  if (input.captureLogs) {
    const original = console.log;
    // eslint-disable-next-line no-console
    console.log = ((...args: unknown[]) => {
      const line = args.map((a) => String(a)).join(" ");
      logs.push(line);
      original(...args);
    }) as typeof console.log;
    (logs as unknown as { restore: () => void }).restore = () => {
      // eslint-disable-next-line no-console
      console.log = original;
    };
  }

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

  // Declared before the LLM so its closure can inspect committed memory.
  // eslint-disable-next-line prefer-const
  let record: InstanceType<typeof SessionRecord>;

  const seen = (history: readonly ConversationTurn[], signal: AbortSignal | undefined): SeenRequest => {
    const lastUser = [...history].reverse().find((t) => t.role === "user");
    const userText = lastUser ? lastLine(lastUser.content) : "";
    const committed = record.memory
      .history()
      .some((t) => t.role === "user" && t.content === userText);
    const entry: SeenRequest = {
      history,
      at: Date.now(),
      userTurnCommitted: committed,
      userText,
      aborted: () => signal?.aborted ?? false,
      consumed: false,
    };
    requests.push(entry);
    return entry;
  };

  const streamingLlm = {
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      const entry = seen(request.history, signal);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(input.replyDelayMs ?? 10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      // Reached only if the consumer pulled every token: an abandoned
      // stream is aborted (returns above) or returned before this.
      entry.consumed = true;
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: reply, timestamp: new Date() },
        latencyMs: 1,
      };
    },
  };

  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async (request: CompletionRequest) => {
      const entry = seen(request.history, undefined);
      entry.consumed = true;
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(input.replyDelayMs ?? 10);
      return { turn: { role: "assistant" as const, content: reply, timestamp: new Date() }, latencyMs: 1 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    ...(input.streaming === false ? {} : streamingLlm),
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

  record = new SessionRecord(
    (input.sessionId ?? "speculate-test") as SessionId,
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
        openingLine: input.openingLine,
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );

  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => undefined);

  const host = {
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
      reason?: string,
    ) => {
      transitions.push({ to: String(to), reason: reason ?? "" });
      r.state = to;
    },
    markError: () => undefined,
    end: async () => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      return undefined;
    },
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const push = (seg: TranscriptSegment): void => {
    segments.push(seg);
    waiters.shift()?.();
  };

  const isBargeInTransition = (t: { to: string; reason: string }): boolean =>
    t.to === String(SessionState.LISTENING) && /barge.?in/iu.test(t.reason);

  return {
    record,
    requests,
    synthesized,
    transitions,
    logs,
    say(text, opts) {
      record.lastCallerEnergyAt = Date.now();
      record.lastConversationActivityAt = Date.now();
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      const base = {
        text,
        isFinal,
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      };
      push(
        opts?.omitSpeechFinal === true
          ? base
          : { ...base, isSpeechFinal: opts?.isSpeechFinal ?? false },
      );
    },
    markEndOfSpeech() {
      // Byte-for-byte the shape the Deepgram adapter emits.
      push({
        text: "",
        isFinal: true,
        isSpeechFinal: true,
        isEndOfSpeechMarker: true,
        confidence: 0,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: 0,
        endedAtMs: 0,
      });
    },
    bargedIn: () => transitions.some(isBargeInTransition),
    async waitFor(what, predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(2);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async waitForReplies(n, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((turn) => turn.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(5);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${
          record.memory.history().filter((turn) => turn.role === "assistant").length
        }, state=${record.state})`,
      );
    },
    history() {
      return record.memory.history().filter((turn) => turn.role !== "system");
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
      (logs as unknown as { restore?: () => void }).restore?.();
    },
  };
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK_SENTENCE_1 = "Actually, I am calling you with a very interesting invitation.";
const BLOCK_SENTENCE_2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const BLOCK_SENTENCE_3 =
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${BLOCK_SENTENCE_1} ${BLOCK_SENTENCE_2} ${BLOCK_SENTENCE_3}`;

/** The detector's evidenced windows, restated so a drift shows up here. */
const EVIDENCED_SHORT_MS = 150;
const SILENCE_WINDOW_MS = 1_100;

/** Drives the call to the moment the agent is a sentence into its block. */
async function upToMidBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.", { isSpeechFinal: true });
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(900);
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the detector hook fires ONLY on explicit end-of-speech evidence");
// ═════════════════════════════════════════════════════════════════

await test("A1 — an interim never fires onTurnPending, and releases nothing", async () => {
  const r = await observe([{ seg: segment("I would like to join", { isFinal: false }) }], 600);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.released, []);
});

await test("A2 — `is_final` WITHOUT `speech_final` fires nothing ON ARRIVAL; the grace-arm announcement comes a full silence window later, and release is unchanged", async () => {
  // RE-POINTED. This test previously asserted that a chunk boundary
  // NEVER announces. The grace-arm site (see `onTurnPending`, the QUIET
  // class) intentionally announces one adaptive silence window after
  // that boundary — with no endpoint claim, on the strength of the
  // window having expired silently. What the test protects is unchanged
  // and is now pinned more precisely: the SEGMENT itself still
  // announces nothing, and the release is still by inference.
  const onArrival = await observe(
    [{ seg: segment("Yes, that's right.", { isFinal: true, isSpeechFinal: false }) }],
    600,
  );
  assert.deepEqual(onArrival.pending, [], "a chunk boundary on arrival is not evidence and announces nothing");
  assert.deepEqual(onArrival.released, [], "…and releases nothing that early either");

  const r = await observe(
    [{ seg: segment("Yes, that's right.", { isFinal: true, isSpeechFinal: false }) }],
    SILENCE_WINDOW_MS + 700 + 400,
  );
  assert.deepEqual(r.pending, ["Yes, that's right."], "the grace-arm announcement, once");
  assert.deepEqual(r.released, ["Yes, that's right."], "the inference path still releases it");
});

await test("A3 — a provider that reports NO endpoint claim (`isSpeechFinal` absent) never fires onTurnPending", async () => {
  const r = await observe([{ seg: segment("Yes, that's right.", { omitSpeechFinal: true }) }], 500);
  assert.deepEqual(r.pending, [], "absent is 'assume endpointed' for release, but it is not evidence");
  assert.deepEqual(r.released, ["Yes, that's right."]);
});

await test("A4 — `speech_final: true` on a finished thought fires onTurnPending ONCE, with the exact text later released", async () => {
  const r = await observe([{ seg: segment("Yes, that's right.", { isSpeechFinal: true }) }], EVIDENCED_SHORT_MS + 200);
  assert.deepEqual(r.pending, ["Yes, that's right."]);
  assert.deepEqual(r.released, ["Yes, that's right."]);
});

await test("A5 — the standalone end-of-speech MARKER after an `is_final` chunk fires onTurnPending with the held text", async () => {
  const r = await observe(
    [{ seg: segment("Yes, that's right.", { isSpeechFinal: false }) }, { marker: true, afterMs: 30 }],
    EVIDENCED_SHORT_MS + 200,
  );
  assert.deepEqual(r.pending, ["Yes, that's right."]);
  assert.deepEqual(r.released, ["Yes, that's right."]);
});

await test("A6 — the detector's own guards run FIRST: filler, hold phrase and an incomplete thought never fire it even with `speech_final`", async () => {
  for (const text of ["Umm.", "Wait.", "I would like to", "Yes, but"]) {
    const r = await observe([{ seg: segment(text, { isSpeechFinal: true }) }], 200);
    assert.deepEqual(r.pending, [], `must not announce a pending turn for ${JSON.stringify(text)}`);
  }
});

await test("A7 — new speech inside the window is seen as the fed segment; onTurnEnd then carries the merged text, not the announced one", async () => {
  const r = await observe(
    [
      { seg: segment("Yes, that's right.", { isSpeechFinal: true }) },
      { seg: segment("but I have a question.", { isFinal: false }, 2_000), afterMs: 40 },
      { seg: segment("but I have a question.", { isSpeechFinal: true }, 2_000), afterMs: 40 },
    ],
    EVIDENCED_SHORT_MS + 300,
  );
  assert.deepEqual(r.pending, ["Yes, that's right.", "Yes, that's right. but I have a question."]);
  assert.deepEqual(r.released, ["Yes, that's right. but I have a question."]);
});

await test("A8 — a detector with no subscriber behaves byte-for-byte as before (hook is pure observation)", async () => {
  const detector = new AdaptiveTurnDetector();
  const released: string[] = [];
  detector.onTurnEnd((e) => released.push(e.text));
  const t0 = Date.now();
  detector.feed(segment("Yes, that's right.", { isSpeechFinal: true }));
  await sleep(EVIDENCED_SHORT_MS + 150);
  assert.deepEqual(released, ["Yes, that's right."]);
  assert.ok(Date.now() - t0 >= EVIDENCED_SHORT_MS, "the evidenced window is still paid in full");
  detector.reset();
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — the pipeline speculates only on evidence, and never leaves a stray request behind");
// ═════════════════════════════════════════════════════════════════

await test("B1 — interim-only input produces NO language-model request", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say("I would like to join the", { isFinal: false });
    await sleep(800);
    assert.equal(h.requests.length, 0, "an interim is not a turn and must not open a request");
  } finally {
    await h.stop();
  }
});

await test("B2 — `is_final` WITHOUT `speech_final` opens nothing on arrival; the grace-arm pre-open follows a silence window later, and it is still ONE request", async () => {
  // RE-POINTED alongside A2, and only where it conflicts. The
  // "nothing on the chunk boundary" assertion below is unchanged and is
  // still the meaningful boundary — 600ms is inside the adaptive
  // silence window, before the grace exists. What changed is the LAST
  // assertion: the request for this turn is now pre-opened at grace-arm
  // and adopted, so it is made BEFORE the commit rather than after.
  // The one-request-per-turn invariant is untouched and still asserted.
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isFinal: true, isSpeechFinal: false });
    await sleep(600);
    assert.equal(h.requests.length, 0, "a chunk boundary is not evidence — nothing pre-opened");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "still exactly one request for the turn");
    assert.equal(
      h.requests[0]!.userTurnCommitted,
      false,
      "pre-opened at grace-arm, then adopted — requested before the commit",
    );
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, "Yes, that's right.", "R1"]);
  } finally {
    await h.stop();
  }
});

await test("B3 — `speech_final` on the words: the request opens within milliseconds, BEFORE the turn is committed, and is the ONLY request for the turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    const saidAt = Date.now();
    h.say("Yes, that's right.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    const openedAfterMs = h.requests[0]!.at - saidAt;
    assert.equal(h.requests[0]!.userTurnCommitted, false, "opened before the user turn was committed — i.e. during the confirmation window");
    assert.ok(openedAfterMs < 100, `opened ${openedAfterMs}ms after the final — must not wait out the window`);
    assert.equal(h.requests[0]!.userText, "Yes, that's right.");

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "adopted — no second request at release");
    assert.equal(h.requests[0]!.aborted(), false, "the adopted stream was never aborted");
    assert.equal(h.requests[0]!.consumed, true, "and was consumed to completion");
    assert.deepEqual(
      h.history().map((t) => t.content),
      [OPENING, "Yes, that's right.", "R1"],
      "memory holds exactly the turns the normal path would commit, in order",
    );
  } finally {
    await h.stop();
  }
});

await test('B4 — the headline case: greeting → "Hello." with `speech_final` → pre-opened and adopted, one request', async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say("Hello.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    assert.equal(h.requests[0]!.userTurnCommitted, false);
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, "Hello.", "R1"]);
  } finally {
    await h.stop();
  }
});

await test("B5 — the standalone end-of-speech MARKER path: words `is_final` only, then the marker → pre-opened on the marker and adopted", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isFinal: true, isSpeechFinal: false });
    await sleep(120);
    assert.equal(h.requests.length, 0, "nothing on the bare `is_final`");
    const markerAt = Date.now();
    h.markEndOfSpeech();
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    assert.equal(h.requests[0]!.userTurnCommitted, false);
    assert.ok(h.requests[0]!.at - markerAt < 100);
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "adopted — one request");
  } finally {
    await h.stop();
  }
});

await test("B6 — the caller RESUMES inside the window: the pre-opened request is aborted, the merged turn gets its own request, and the abandoned reply is never spoken or committed", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["FIRST-SHOULD-BE-ABANDONED", "SECOND"], replyDelayMs: 40 });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    h.say("but I have", { isFinal: false });
    await h.waitFor("the pre-opened request to be aborted", () => h.requests[0]!.aborted(), 200);
    h.say("but I have a question.", { isSpeechFinal: true });
    await h.waitForReplies(2);

    assert.equal(h.requests.length, 2, "one abandoned, one real");
    assert.equal(h.requests[1]!.userText, "Yes, that's right. but I have a question.", "the real request carries the MERGED turn");
    assert.equal(h.requests[1]!.aborted(), false);
    const texts = h.history().map((t) => t.content);
    assert.ok(!texts.includes("FIRST-SHOULD-BE-ABANDONED"), "the abandoned reply must never be committed");
    assert.ok(!h.synthesized.some((t) => t.includes("FIRST-SHOULD-BE-ABANDONED")), "…nor spoken");
    assert.deepEqual(texts, [OPENING, "Yes, that's right. but I have a question.", "SECOND"]);
  } finally {
    await h.stop();
  }
});

await test("B7 — attention-check turns spend ZERO requests: acknowledgement, hearing confirmation and resume all stay off the model; the next real question reaches it once", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "ANSWER"] });
  try {
    await upToMidBlock(h);
    const before = h.requests.length; // the BLOCK request
    h.say("Hello?", { isSpeechFinal: true });
    await h.waitForReplies(3);
    assert.equal(h.requests.length, before, "the acknowledgement must not open a request — not even a pre-opened one");
    assert.ok(h.synthesized.some((t) => t.includes("can you hear me")), "the acknowledgement was spoken");

    h.say("Yes, I can hear you.", { isSpeechFinal: true });
    await h.waitForReplies(4);
    assert.equal(h.requests.length, before, "the hearing confirmation resumes the held script — no request");

    h.say("How much does it cost?", { isSpeechFinal: true });
    await h.waitFor("the real question to reach the model", () => h.requests.length === before + 1);
    await h.waitForReplies(5);
    assert.equal(h.requests.length, before + 1, "exactly one request for the real question");
    assert.equal(h.requests[before]!.userText, "How much does it cost?");
  } finally {
    await h.stop();
  }
});

await test("B8 — barge-in is untouched: an interruption mid-reply cancels playback exactly as before, and the interrupting turn takes the normal (committed-first) path", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "R2"] });
  try {
    await upToMidBlock(h);
    h.say("Wait, how much does it cost?", { isSpeechFinal: true });
    await h.waitFor("the barge-in", () => h.bargedIn(), 2_000);
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0]!.aborted(), true, "the interrupted reply's stream was cancelled");
    assert.equal(h.requests[1]!.userText, "Wait, how much does it cost?");
    assert.equal(
      h.requests[1]!.userTurnCommitted,
      true,
      "no speculation is alive while the assistant is speaking or unwinding — the interrupting turn is sent after commit, as today",
    );
  } finally {
    await h.stop();
  }
});

await test("B9 — a provider WITHOUT streaming is untouched: nothing is pre-opened; generateCompletion runs once, after commit", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"], streaming: false });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isSpeechFinal: true });
    await sleep(60);
    assert.equal(h.requests.length, 0, "nothing to pre-open without a streaming method");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.userTurnCommitted, true);
  } finally {
    await h.stop();
  }
});

await test("B10 — the session ending inside the window aborts the pre-opened request", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"], replyDelayMs: 200 });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    await h.stop();
    await sleep(20);
    assert.equal(h.requests[0]!.aborted(), true);
  } finally {
    await h.stop();
  }
});

await test("B11 — P0-1: a marker collapsing the CHUNK-BOUNDARY GRACE now pre-opens the request too, and it is adopted", async () => {
  // The route B5 does NOT cover. There the marker lands while the
  // adaptive silence window is still armed, so `noteEndOfSpeech` decides
  // and announces. Here it lands after that window has expired and the
  // 700ms chunk-boundary grace is the armed window, so `noteEndOfSpeech`
  // collapses the grace with `rearmTimer(0)` and returns BEFORE its own
  // announcement — handing the decision to `emitTurnEnd`, which arms the
  // evidenced window on the identical evidence. Until P0-1 that window
  // was announced by nobody and the turn paid it with nothing overlapped.
  //
  // The text is deliberately longer than `SHORT_COMPLETE_TURN_MAX_WORDS`.
  // A short punctuated turn ("Yes, that's right.") is granted a window of
  // ZERO by `confirmationWindowMs` and released on the spot, so there is
  // no window to announce and nothing this change could overlap — which
  // is correct, and is why that fixture proves nothing here.
  const TURN = "Yes I would like to attend the session today.";
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say(TURN, { isFinal: true, isSpeechFinal: false });
    // RE-POINTED: the zero-check moved inside the adaptive silence
    // window. Past it, grace-arm has legitimately pre-opened the
    // request (B13) — so the assertion that a bare `is_final` opens
    // nothing is now only true ON ARRIVAL, which is where it belongs.
    await sleep(600);
    assert.equal(h.requests.length, 0, "a bare `is_final` must still open nothing on its own");
    // Past the silence window, into the grace.
    await sleep(SILENCE_WINDOW_MS + 250 - 600);
    const markerAt = Date.now();
    h.markEndOfSpeech();

    await h.waitFor("a pre-opened request on the collapsed grace", () => h.requests.length >= 1, 150);
    assert.equal(
      h.requests[0]!.userTurnCommitted,
      false,
      "pre-opened: the normal path commits the user turn first and requests second",
    );
    assert.ok(
      h.requests[0]!.at - markerAt < 120,
      `the request must open on the marker, not after the window: ${h.requests[0]!.at - markerAt}ms`,
    );

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "adopted — ONE request for the turn, not a duplicate");
    assert.equal(h.requests[0]!.aborted(), false, "the adopted stream must not have been abandoned");
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, TURN, "R1"]);
  } finally {
    await h.stop();
  }
});

await test("B12 — P0-1 announces nothing for a MID-THOUGHT turn on the same path: zero pre-opened requests", async () => {
  // Same collapse, text that reads unfinished. `isReleasableThought()`
  // is false, so the gate excludes it; the turn takes its continuation
  // graces and reaches the model ONCE, by the normal committed-first
  // path. A pre-opened request here would be a request for half a
  // sentence.
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say("I was going to ask about the timing and", { isFinal: true, isSpeechFinal: false });
    await sleep(SILENCE_WINDOW_MS + 250);
    h.markEndOfSpeech();
    await sleep(400);
    assert.equal(h.requests.length, 0, "a mid-thought turn must never be pre-opened");

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "it still reaches the model exactly once");
    assert.equal(
      h.requests[0]!.userTurnCommitted,
      true,
      "…by the normal path: committed first, requested second",
    );
  } finally {
    await h.stop();
  }
});

/**
 * The turn used by B13-B15. Longer than `SHORT_COMPLETE_TURN_MAX_WORDS`
 * on purpose: a short punctuated turn is granted a ZERO confirmation
 * window and released the instant the grace ends, which leaves no window
 * to observe an adoption in.
 */
const GRACE_TURN = "Yes I would like to attend the session today.";

await test("B13 — GRACE-ARM: the request is pre-opened a silence window BEFORE any endpoint claim, and adopted", async () => {
  // The chunk-boundary grace is armed when the full adaptive silence
  // window has expired on a final Deepgram did NOT endpoint. No claim
  // ever arrives in this test, so the turn takes the ordinary inference
  // path to release — unchanged — while the request runs during it.
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say(GRACE_TURN, { isFinal: true, isSpeechFinal: false });

    await sleep(600);
    assert.equal(h.requests.length, 0, "nothing on the chunk boundary itself — the window must run first");

    await h.waitFor("a request pre-opened at grace-arm", () => h.requests.length >= 1, 1_200);
    assert.equal(
      h.requests[0]!.userTurnCommitted,
      false,
      "pre-opened: the normal path commits the user turn first and requests second",
    );

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "adopted — ONE request for the turn");
    assert.equal(h.requests[0]!.aborted(), false, "the adopted stream must not have been abandoned");
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, GRACE_TURN, "R1"]);
  } finally {
    await h.stop();
  }
});

await test("B14 — GRACE-ARM: the caller RESUMING inside the grace abandons it; the merged turn gets its own request", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["FIRST-SHOULD-BE-ABANDONED", "SECOND"],
    replyDelayMs: 40,
  });
  try {
    await h.waitForReplies(1);
    h.say(GRACE_TURN, { isFinal: true, isSpeechFinal: false });
    await h.waitFor("a request pre-opened at grace-arm", () => h.requests.length >= 1, 1_800);

    h.say("and one more thing.", { isFinal: true, isSpeechFinal: true });
    await h.waitFor("the pre-opened request to be aborted", () => h.requests[0]!.aborted(), 400);

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 2, "one abandoned, one real");
    assert.equal(
      h.requests[1]!.userText,
      `${GRACE_TURN} and one more thing.`,
      "the real request carries the MERGED turn",
    );
    assert.equal(h.requests[1]!.aborted(), false);
    const texts = h.history().map((t) => t.content);
    assert.ok(!texts.includes("FIRST-SHOULD-BE-ABANDONED"), "the abandoned reply must never be committed");
    assert.ok(
      !h.synthesized.some((t) => t.includes("FIRST-SHOULD-BE-ABANDONED")),
      "…nor spoken",
    );
    assert.deepEqual(texts, [OPENING, `${GRACE_TURN} and one more thing.`, "SECOND"]);
  } finally {
    await h.stop();
  }
});

await test("B15 — GRACE-ARM then the P0-1 COLLAPSE: two announcements, EXACTLY ONE request", async () => {
  // The detector announces at both sites with identical text (asserted
  // at that level by `test:wire-trace` E6). `startSpeculation` returns
  // early on `speculation.text === text`, so the second announcement
  // opens nothing. This is the assertion that proves it.
  const h = startHarness({ openingLine: OPENING, replies: ["R1"] });
  try {
    await h.waitForReplies(1);
    h.say(GRACE_TURN, { isFinal: true, isSpeechFinal: false });
    await h.waitFor("a request pre-opened at grace-arm", () => h.requests.length >= 1, 1_800);
    const afterGraceArm = h.requests.length;
    assert.equal(afterGraceArm, 1, "one request at grace-arm");

    // The endpoint claim lands inside the grace — the P0-1 collapse.
    h.markEndOfSpeech();
    await sleep(300);
    assert.equal(h.requests.length, 1, "the collapse announcement must NOT open a second request");

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "still exactly one request for the turn, and it was adopted");
    assert.equal(h.requests[0]!.aborted(), false);
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, GRACE_TURN, "R1"]);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — the adopted request IS the normal request");
// ═════════════════════════════════════════════════════════════════

await test("C1 — role-for-role, content-for-content identical to the request the non-speculative path builds for the same conversation", async () => {
  const a = startHarness({ openingLine: OPENING, replies: ["R1", "R2"], sessionId: "same-session" });
  const b = startHarness({ openingLine: OPENING, replies: ["R1", "R2"], sessionId: "same-session" });
  try {
    await a.waitForReplies(1);
    await b.waitForReplies(1);
    // A: two evidenced turns (pre-opened + adopted). B: the same two
    // turns with NO endpoint claim reported at all, which is now the
    // only shape that still reaches the model non-speculatively — a
    // chunk boundary is pre-opened at grace-arm (see B2/B13), so it can
    // no longer serve as the control arm. Everything C1 actually
    // asserts below is unchanged.
    a.say("Yes, tell me.", { isSpeechFinal: true });
    b.say("Yes, tell me.", { omitSpeechFinal: true });
    await a.waitForReplies(2);
    await b.waitForReplies(2);
    a.say("How much does it cost?", { isSpeechFinal: true });
    b.say("How much does it cost?", { omitSpeechFinal: true });
    await a.waitForReplies(3);
    await b.waitForReplies(3);

    assert.equal(a.requests.length, 2);
    assert.equal(b.requests.length, 2);
    assert.equal(a.requests[0]!.userTurnCommitted, false, "A's requests were pre-opened");
    assert.equal(a.requests[1]!.userTurnCommitted, false);
    assert.equal(b.requests[0]!.userTurnCommitted, true, "B's were the normal path");
    assert.equal(b.requests[1]!.userTurnCommitted, true);

    for (let i = 0; i < 2; i += 1) {
      const ha = a.requests[i]!.history;
      const hb = b.requests[i]!.history;
      assert.equal(ha.length, hb.length, `request #${i}: same history length`);
      for (let j = 0; j < ha.length; j += 1) {
        assert.equal(ha[j]!.role, hb[j]!.role, `request #${i} turn #${j}: same role`);
        assert.equal(ha[j]!.content, hb[j]!.content, `request #${i} turn #${j}: same content`);
      }
    }
    assert.deepEqual(a.history().map((t) => t.content), b.history().map((t) => t.content), "identical committed conversations");
  } finally {
    await a.stop();
    await b.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — timing readout (evidence → llm-open, evidence → release, release → llm-request)");
// ═════════════════════════════════════════════════════════════════

await test("D1 — evidence → llm-open is a few ms; the confirmation window is still paid before release; the first token is in hand at adoption", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK], captureLogs: true });
  try {
    await h.waitForReplies(1);
    h.say("Tell me about the workshop.", { isSpeechFinal: true });
    await h.waitForReplies(2);
    const open = h.logs.find((l) => l.includes("[SPECULATE:") && l.includes("PRE-OPENED"));
    const adopted = h.logs.find((l) => l.includes("[SPECULATE:") && l.includes("ADOPTED"));
    const deltas = h.logs.find((l) => l.startsWith("[TIMING:speculate-test] TURN#0 DELTAS"));
    assert.ok(open, "expected a PRE-OPENED line");
    assert.ok(adopted, "expected an ADOPTED line");
    assert.ok(deltas, "expected a DELTAS block");
    const evidenceToOpen = Number(/evidence-to-llm-open=(\d+)ms/u.exec(open!)?.[1]);
    const openLead = Number(/llm-request is (\d+)ms after/u.exec(adopted!)?.[1]);
    const endpointToRelease = Number(/endpoint-to-release=(\d+)ms/u.exec(deltas!)?.[1]);
    const releaseToLlm = Number(/release-to-llm-request=(\d+)ms/u.exec(deltas!)?.[1]);
    console.log(
      `         evidence→llm-open=${evidenceToOpen}ms  evidence→release=${endpointToRelease}ms  release→llm-request=${releaseToLlm}ms  llm-open lead over llm-request=${openLead}ms  ${adopted!.includes("already in hand") ? "first token already in hand at adoption" : "first token NOT in hand at adoption"}`,
    );
    assert.ok(Number.isFinite(evidenceToOpen) && evidenceToOpen <= 30, `evidence→llm-open should be ~0ms, got ${evidenceToOpen}ms`);
    assert.ok(endpointToRelease >= EVIDENCED_SHORT_MS - 20, `the evidenced confirmation window is still paid (${endpointToRelease}ms)`);
    assert.ok(openLead >= EVIDENCED_SHORT_MS - 30, `the request was open for the whole window (${openLead}ms)`);
    assert.ok(adopted!.includes("already in hand"), "with a 10ms fake TTFT the first token was waiting at adoption");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — FIX #9: endpoint-evidence telemetry is attributed only to the turn it belongs to");
// ═════════════════════════════════════════════════════════════════

await test("E1 — a late end-of-speech MARKER for an already-answered turn is not attributed to the next one (no bogus multi-second endpoint-to-release)", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1", "R2"], captureLogs: true });
  try {
    await h.waitForReplies(1);
    h.say("Yes.", { isSpeechFinal: true });
    await h.waitForReplies(2);
    // Deepgram's `UtteranceEnd` for "Yes." lands ~1s after the words —
    // long after the 150ms evidenced release. Nothing is held, so it is
    // about nobody's turn.
    h.markEndOfSpeech();
    await sleep(700);
    // The next turn releases by INFERENCE (chunk boundary, no claim).
    h.say("Tell me more about it.", { isFinal: true, isSpeechFinal: false });
    await h.waitForReplies(3);
    const deltas = h.logs.find((l) => l.startsWith("[TIMING:speculate-test] TURN#1 DELTAS"));
    assert.ok(deltas, "expected TURN#1 DELTAS");
    const endpointToRelease = /endpoint-to-release=([^\n]+)/u.exec(deltas!)?.[1];
    assert.equal(endpointToRelease, "NOT DIRECTLY MEASURABLE", `a turn released without evidence must not inherit stale evidence (got ${endpointToRelease})`);
    // Behaviour is byte-for-byte what it was: same requests, same history.
    assert.equal(h.requests.length, 2);
    // RE-POINTED: the inferred release is now pre-opened at grace-arm
    // (B13). E1's subject — that stale evidence is not attributed to
    // this turn — is the assertion above and is untouched.
    assert.equal(h.requests[1]!.userTurnCommitted, false, "pre-opened at grace-arm, then adopted");
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, "Yes.", "R1", "Tell me more about it.", "R2"]);
  } finally {
    await h.stop();
  }
});

await test("E2 — evidence for a turn the caller then CONTINUES is not attributed to the merged turn's inferred release; release, abandonment and adoption are unchanged", async () => {
  // Two scripted replies: the fake model consumes one per request, and
  // the abandoned pre-opened request takes the first (as in B6).
  const h = startHarness({ openingLine: OPENING, replies: ["ABANDONED", "R1"], captureLogs: true });
  try {
    await h.waitForReplies(1);
    h.say("Yes.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 100);
    h.say("but I", { isFinal: false });
    await h.waitFor("the pre-opened request to be aborted", () => h.requests[0]!.aborted(), 200);
    h.say("but I want to know the timing.", { isFinal: true, isSpeechFinal: false });
    await h.waitForReplies(2);
    const deltas = h.logs.find((l) => l.startsWith("[TIMING:speculate-test] TURN#0 DELTAS"));
    assert.ok(deltas, "expected TURN#0 DELTAS");
    const endpointToRelease = /endpoint-to-release=([^\n]+)/u.exec(deltas!)?.[1];
    assert.equal(endpointToRelease, "NOT DIRECTLY MEASURABLE", `the "Yes." evidence was superseded by more speech (got ${endpointToRelease})`);
    assert.equal(h.requests.length, 2, "one abandoned, one real — no duplicate");
    assert.equal(h.requests[1]!.userText, "Yes. but I want to know the timing.");
    assert.deepEqual(h.history().map((t) => t.content), [OPENING, "Yes. but I want to know the timing.", "R1"]);
  } finally {
    await h.stop();
  }
});

await test("E3 — a marker that DOES land on held words is still stamped: endpoint-to-release reads the evidenced tier, as before", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1"], captureLogs: true });
  try {
    await h.waitForReplies(1);
    h.say("Yes, that's right.", { isFinal: true, isSpeechFinal: false });
    await sleep(120);
    h.markEndOfSpeech();
    await h.waitForReplies(2);
    const deltas = h.logs.find((l) => l.startsWith("[TIMING:speculate-test] TURN#0 DELTAS"));
    const trace = h.logs.find((l) => l.startsWith("[TIMING:speculate-test] TURN#0\n"));
    assert.ok(deltas && trace, "expected the TURN#0 trace and DELTAS");
    assert.ok(trace!.includes("(utterance_end)"), "the marker is the evidence for this turn");
    const endpointToRelease = Number(/endpoint-to-release=(\d+)ms/u.exec(deltas!)?.[1]);
    assert.ok(Number.isFinite(endpointToRelease) && endpointToRelease >= EVIDENCED_SHORT_MS - 20 && endpointToRelease < 600, `evidenced release (${endpointToRelease}ms)`);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.userTurnCommitted, false, "still pre-opened on the marker");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
