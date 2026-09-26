/**
 * turn-outcome-telemetry-tests.ts — `npm run test:turn-outcome`
 *
 * PHASE A of the 2026-09-17 Gemma audit follow-up. Two changes, and
 * this file owns both:
 *
 *   1. AN EMPTY GENERATION IS NO LONGER AN ASSISTANT TURN. A provider
 *      stream that fails, or that ends with no content, used to reach
 *      the commit site as `recordAssistantTurn("")` — an empty
 *      assistant message in the history, sent back to the model on
 *      every later request. The audit measured 14 of those on gemma-4
 *      (14% of its assistant turns), 10 of which entered a later
 *      request; gpt-5.1 had none.
 *
 *   2. EVERY RECORDED TURN NOW STATES WHAT BECAME OF ITS REPLY
 *      (`turnOutcome`), with the raw generated character count, the
 *      TTS invocation count, and — for a superseded reply — whether
 *      the utterance that superseded it would be judged to take the
 *      floor. The audit could only establish this by elimination and
 *      by correlating stored transcripts against TTS metrics.
 *
 * The supersession behaviour itself is DELIBERATELY UNCHANGED here:
 * section D asserts that a superseded reply is still discarded and
 * still uncommitted, exactly as `test:continuity` section C requires.
 * This file only observes which branch took it.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker, the conversation
 * memory and the metrics collector are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId } from "../../types/session.types";
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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════
// THE HARNESS
//
// Same shape as `conversation-continuity-tests.ts`: fakes stand in for
// the four vendors and nothing else. Audio is MULAW/8000, one byte per
// sample, so a clip's real-time duration is exactly `bytes / 8` ms.
//
// One addition: a scripted reply may be an `Error`, which the fake
// language model THROWS from inside its stream. That is the shape of
// the OpenRouter failure the audit found — a stream that dies with no
// content — and it is the only way to reach the pipeline's
// `stream_error` branch without a network.
// ═════════════════════════════════════════════════════════════════

type Behaviour = string | Error;

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

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Wait until `n` assistant turns are committed AND the agent is listening again. */
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /** Wait until `n` TURNS have been recorded by the metrics collector. */
  waitForTurns(n: number, timeoutMs?: number): Promise<void>;
  /**
   * Wait until the turn detector is actually HOLDING a completed turn.
   *
   * This is what makes the Phase B tests deterministic rather than a
   * race: with `gateReplies`, the language model does not produce a
   * token until `releaseReply()` is called, so the test can prove the
   * buffered turn exists FIRST and only then let the reply arrive. No
   * test depends on a generation losing a race to an endpoint.
   */
  waitForBufferedTurn(timeoutMs?: number): Promise<void>;
  /** Let the gated language model produce its reply. */
  releaseReply(): void;
  /** Committed conversation, system turn excluded — what the model is shown. */
  history(): readonly ConversationTurn[];
  /** Per-turn metrics as the collector would hand them to the campaign layer. */
  turns(): readonly TurnLatencyBreakdown[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  /** Consumed in order; once exhausted, `fallbackReply` answers every further request. */
  readonly replies?: readonly Behaviour[];
  readonly fallbackReply?: Behaviour;
  readonly replyDelayMs?: number;
  /**
   * When set, a CONVERSATIONAL reply is held until `releaseReply()`.
   * The prefix-cache prime is unaffected — it never reaches the gate.
   */
  readonly gateReplies?: boolean;
}): Harness {
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;
  let openGate = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

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
    generateCompletion: async () => ({
      turn: { role: "assistant" as const, content: "", timestamp: new Date() },
      latencyMs: 0,
    }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event. Not a
      // conversational request, so it consumes no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      const scripted = input.replies?.[replyIndex];
      const reply: Behaviour = scripted ?? input.fallbackReply ?? "Okay.";
      replyIndex += 1;
      if (input.gateReplies === true) await gate;
      await sleep(input.replyDelayMs ?? 10);
      if (signal?.aborted) return;
      // The OpenRouter failure shape: the stream dies, having produced
      // nothing. The pipeline's existing catch is what handles it.
      if (reply instanceof Error) throw reply;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (delta.length === 0) continue;
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
    "turn-outcome-test" as SessionId,
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
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const assistantCount = () =>
    record.memory.history().filter((turn) => turn.role === "assistant").length;

  return {
    record,
    synthesized,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({
        text,
        isFinal,
        ...(opts?.isSpeechFinal !== undefined ? { isSpeechFinal: opts.isSpeechFinal } : { isSpeechFinal: isFinal }),
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
        if (assistantCount() >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${assistantCount()}, state=${record.state})`,
      );
    },
    async waitForTurns(n, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (record.metrics.build().turnLatencies.length >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} recorded turns (have ${
          record.metrics.build().turnLatencies.length
        }, state=${record.state})`,
      );
    },
    async waitForBufferedTurn(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (record.turnDetector.hasBufferedTurn()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for a buffered caller turn`);
    },
    releaseReply() {
      openGate();
    },
    history() {
      return record.memory.history().filter((turn) => turn.role !== "system");
    },
    turns() {
      return record.metrics.build().turnLatencies;
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

function assistantTexts(history: readonly ConversationTurn[]): string[] {
  return history.filter((turn) => turn.role === "assistant").map((turn) => turn.content);
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const FIRST_USER_TURN = "Yes, tell me.";
/** See `CARRY_ON_PAUSE_MS` in conversation-continuity-tests.ts. */
const CARRY_ON_PAUSE_MS = 900;
const BLOCK =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — an empty generation never enters conversation history");
// ═════════════════════════════════════════════════════════════════

await test("A1 — an empty reply is not committed, and is reported as empty_response", async () => {
  const h = startHarness({ openingLine: OPENING, fallbackReply: "" });
  try {
    await h.waitForReplies(1);
    assert.deepEqual(assistantTexts(h.history()), [OPENING], "only the opening should be committed");

    h.say(FIRST_USER_TURN);
    await h.waitForTurns(1);

    // THE INVARIANT: the history is exactly what it was. No empty
    // assistant message, and no placeholder in its place either.
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING],
      "an empty generation must leave conversation history unchanged",
    );
    assert.ok(
      !h.history().some((turn) => turn.role === "assistant" && turn.content.trim().length === 0),
      "no empty assistant turn may exist in history",
    );
    // The caller's turn is still there, still unanswered — which is
    // what actually happened.
    assert.equal(
      h.history().filter((turn) => turn.role === "user").length,
      1,
      "the caller's turn must still be committed",
    );

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must still be recorded");
    assert.equal(turn.turnOutcome, "empty_response", `expected empty_response, got ${turn.turnOutcome}`);
    assert.equal(turn.charsGenerated, 0, "an empty generation produced zero characters");
    assert.equal(turn.ttsChunkCount, 0, "TTS must never have been reached");
    assert.equal(turn.tts, undefined, "no audio was produced, so there is no time-to-first-audio");
  } finally {
    await h.stop();
  }
});

await test("A2 — a whitespace-only reply is not committed either", async () => {
  const h = startHarness({ openingLine: OPENING, fallbackReply: "   \n\t  " });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitForTurns(1);

    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING],
      "a whitespace-only generation must leave conversation history unchanged",
    );
    assert.ok(
      !h.history().some((turn) => turn.role === "assistant" && turn.content.trim().length === 0),
      "no blank assistant turn may exist in history",
    );

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must still be recorded");
    assert.equal(turn.turnOutcome, "empty_response", `expected empty_response, got ${turn.turnOutcome}`);
    // `charsGenerated` is the RAW model output, before `toSpokenText`,
    // so whitespace counts here even though nothing was speakable.
    assert.ok(
      (turn.charsGenerated ?? 0) > 0,
      "charsGenerated reports raw model output, so whitespace is counted",
    );
    assert.equal(turn.ttsChunkCount, 0, "TTS must never have been reached");
  } finally {
    await h.stop();
  }
});

await test("A3 — a stream that dies with no content is not committed, and is reported as stream_error", async () => {
  const h = startHarness({
    openingLine: OPENING,
    fallbackReply: new Error("simulated provider stream failure"),
  });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitForTurns(1);

    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING],
      "a failed stream must leave conversation history unchanged",
    );

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must still be recorded");
    assert.equal(turn.turnOutcome, "stream_error", `expected stream_error, got ${turn.turnOutcome}`);
    assert.equal(turn.charsGenerated, 0, "nothing was generated before the stream died");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — a valid reply is untouched");
// ═════════════════════════════════════════════════════════════════

await test("B1 — a valid reply is still committed exactly once, and reported as spoken", async () => {
  const REPLY = "Sure, I can explain the whole thing in a minute.";
  const h = startHarness({ openingLine: OPENING, replies: [REPLY], fallbackReply: "Okay." });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitForReplies(2);

    const committed = assistantTexts(h.history());
    assert.deepEqual(committed, [OPENING, REPLY], `expected the reply committed once, got ${JSON.stringify(committed)}`);
    assert.equal(
      committed.filter((text) => text === REPLY).length,
      1,
      "a valid reply must be committed exactly once",
    );
    assert.ok(h.synthesized.includes(REPLY), "the reply must have reached the text-to-speech provider");

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must be recorded");
    assert.equal(turn.turnOutcome, "spoken", `expected spoken, got ${turn.turnOutcome}`);
    assert.equal(turn.charsGenerated, REPLY.length, "charsGenerated must be the raw generated length");
    assert.ok((turn.ttsChunkCount ?? 0) >= 1, "at least one TTS invocation must be counted");
    assert.equal(
      turn.supersederTakesFloor,
      undefined,
      "a reply nobody superseded carries no superseder verdict",
    );
  } finally {
    await h.stop();
  }
});

await test("B2 — the existing spoken-turn measurements are unchanged", async () => {
  const REPLY = "It is on Sunday at eleven in the morning.";
  const h = startHarness({ openingLine: OPENING, replies: [REPLY], fallbackReply: "Okay." });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitForReplies(2);

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must be recorded");
    // Every pre-existing field still measured on a spoken turn. This is
    // the regression guard for "telemetry was added, measurement moved".
    assert.equal(turn.turnIndex, 0, "turn index is unchanged");
    assert.ok(turn.llm !== undefined, "LLM time-to-first-token is still measured");
    assert.ok(turn.tts !== undefined, "TTS time-to-first-audio is still measured");
    assert.ok(turn.llmGenerationMs !== undefined, "generation span is still measured");
    assert.ok(turn.ttsSynthesisMs !== undefined, "synthesis span is still measured");
    assert.ok(
      (turn.llm?.milliseconds ?? -1) >= 0 && Number.isFinite(turn.llm?.milliseconds),
      "time-to-first-token is a real measurement",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — cancelled-response behaviour is unchanged");
// ═════════════════════════════════════════════════════════════════

await test("C1 — a barge-in still commits the part the caller heard", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK], fallbackReply: "Sure, go ahead." });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
    await sleep(900);

    // "hello" mid-block is a real barge-in — deliberately not in the
    // backchannel vocabulary. The heard prefix must still be committed:
    // the empty-generation guard must not have touched this branch.
    h.say("hello");
    await h.waitForReplies(2);

    const committed = assistantTexts(h.history());
    assert.equal(committed[0], OPENING);
    assert.ok(
      (committed[1]?.length ?? 0) > 0 && BLOCK.startsWith(committed[1] ?? " "),
      `the heard prefix of the block must still be committed, got ${JSON.stringify(committed[1])}`,
    );
  } finally {
    await h.stop();
  }
});

await test("C2 — a cancelled reply the caller never heard still commits nothing", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["OBSOLETE.", "It is fifteen hundred rupees."],
    fallbackReply: "Okay.",
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    h.say("Is there any fee?");
    await sleep(CARRY_ON_PAUSE_MS);
    h.say("Actually I mean what is the price", { isFinal: true, isSpeechFinal: false });
    await sleep(1200);
    h.say("of the session?", { isFinal: true, isSpeechFinal: true });

    await h.waitForReplies(2);
    await sleep(400);

    assert.ok(
      !h.synthesized.includes("OBSOLETE."),
      `the superseded reply must never reach the text-to-speech provider, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.ok(
      !assistantTexts(h.history()).includes("OBSOLETE."),
      "an unspoken superseded reply must never be committed to memory",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — a superseded turn names the signal that took it");
//
// The BEHAVIOUR here is unchanged and must stay unchanged: the reply is
// still discarded, still uncommitted (section C2 above). These tests
// assert only that the record now says WHICH of the two signals fired
// and how the superseding utterance classifies — the evidence the audit
// had to reconstruct from stored transcripts.
// ═════════════════════════════════════════════════════════════════

await test("D1 — a floor-taking utterance is recorded as a supersession that took the floor", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["OBSOLETE.", "It is fifteen hundred rupees."],
    fallbackReply: "Okay.",
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    h.say("Is there any fee?");
    await sleep(CARRY_ON_PAUSE_MS);
    h.say("Actually I mean what is the price", { isFinal: true, isSpeechFinal: false });
    await sleep(1200);
    h.say("of the session?", { isFinal: true, isSpeechFinal: true });

    await h.waitForTurns(1);

    const turn = h.turns()[0];
    assert.ok(turn, "the superseded turn must still be recorded");
    assert.ok(
      turn.turnOutcome === "superseded_buffered" || turn.turnOutcome === "superseded_pending",
      `expected a supersession outcome, got ${turn.turnOutcome}`,
    );
    assert.equal(
      turn.supersederTakesFloor,
      true,
      "a real question takes the floor, and the record must say so",
    );
    assert.ok((turn.charsGenerated ?? 0) > 0, "the discarded reply was generated, and is counted");
    assert.equal(turn.ttsChunkCount, 0, "a superseded reply never reaches TTS");
    assert.equal(turn.tts, undefined, "a superseded reply produces no audio");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — PHASE B: the buffered signal is filtered by the existing floor policy");
//
// Both tests are GATED, not raced: the language model produces nothing
// until `releaseReply()`, so each test PROVES the caller turn is
// buffered before the reply exists. The two differ in one thing only —
// what the caller said — so the floor policy is the only variable.
// ═════════════════════════════════════════════════════════════════

await test("F1 — a buffered turn that does NOT take the floor no longer discards the reply", async () => {
  const REPLY = "It is completely free, and it runs for about an hour.";
  const h = startHarness({
    openingLine: OPENING,
    replies: [REPLY],
    fallbackReply: "Sure.",
    gateReplies: true,
  });
  try {
    await h.waitForReplies(1);

    h.say("Is there any fee?");
    // Wait for the turn to have been RELEASED and the reply to be under
    // way, so the acknowledgement below is a second, separate turn
    // rather than being merged into the first one. The gate holds the
    // model here indefinitely, so this is a state condition, not a race.
    await h.waitFor("the agent to start thinking", () => h.record.state === SessionState.THINKING);
    // A bare acknowledgement lands and COMPLETES while the assistant is
    // still thinking — the exact shape the audit found discarding 11 of
    // 18 gemma-4 replies.
    h.say("haan ji", { isFinal: true, isSpeechFinal: true });
    await h.waitForBufferedTurn();

    // Only now does the reply exist. The buffered turn is a fact, not a
    // race, at the moment the supersession check runs.
    h.releaseReply();
    await h.waitForTurns(1);

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must be recorded");
    assert.equal(
      turn.turnOutcome,
      "spoken",
      `a non-floor-taking buffered turn must not supersede the reply, got ${turn.turnOutcome}`,
    );
    assert.equal(
      turn.supersederTakesFloor,
      false,
      "the record must say the waiting utterance did not take the floor",
    );

    // ...and the reply really did reach the caller and the history.
    assert.ok(h.synthesized.includes(REPLY), "the kept reply must reach the text-to-speech provider");
    const committed = assistantTexts(h.history());
    assert.ok(committed.includes(REPLY), `the kept reply must be committed, got ${JSON.stringify(committed)}`);
    assert.equal(
      committed.filter((text) => text === REPLY).length,
      1,
      "the kept reply must be committed exactly once",
    );

    // Since 2026-09-26 (real call 6d25ea34) the acknowledgement is NOT
    // answered afterwards: it was said before this reply began to play,
    // so it cannot be an answer to it, and committing it after the reply
    // is what turned a hearing "yeah, yeah" into a seat registration.
    await sleep(1500);
    assert.equal(h.turns().length, 1, "the stale acknowledgement must not open a second request");
    assert.ok(
      !h.history().some((t) => t.role === "user" && t.content.includes("haan ji")),
      "the stale acknowledgement must not be committed as a user turn",
    );
  } finally {
    await h.stop();
  }
});

await test("F2 — a buffered turn that DOES take the floor still discards the reply", async () => {
  const OBSOLETE = "OBSOLETE ANSWER.";
  const h = startHarness({
    openingLine: OPENING,
    replies: [OBSOLETE, "It is fifteen hundred rupees."],
    fallbackReply: "Sure.",
    gateReplies: true,
  });
  try {
    await h.waitForReplies(1);

    h.say("Is there any fee?");
    await h.waitFor("the agent to start thinking", () => h.record.state === SessionState.THINKING);
    // Same structure as F1, same gate, same detector — a real question
    // instead of an acknowledgement. Supersession must be unchanged.
    h.say("actually what is the price of the session", { isFinal: true, isSpeechFinal: true });
    await h.waitForBufferedTurn();

    h.releaseReply();
    await h.waitForTurns(1);

    const turn = h.turns()[0];
    assert.ok(turn, "the turn must be recorded");
    assert.equal(
      turn.turnOutcome,
      "superseded_buffered",
      `a floor-taking buffered turn must still supersede, got ${turn.turnOutcome}`,
    );
    assert.equal(turn.supersederTakesFloor, true, "the record must say the utterance took the floor");
    assert.equal(turn.ttsChunkCount, 0, "a superseded reply never reaches TTS");

    assert.ok(
      !h.synthesized.includes(OBSOLETE),
      `the superseded reply must never be spoken, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.ok(
      !assistantTexts(h.history()).includes(OBSOLETE),
      "the superseded reply must never be committed to memory",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — the telemetry carries no conversation content");
// ═════════════════════════════════════════════════════════════════

await test("E1 — no transcript, reply or prompt text appears in the recorded turns", async () => {
  const REPLY = "Sure, I can explain the whole thing in a minute.";
  const USER = "What exactly is this about, please?";
  const h = startHarness({ openingLine: OPENING, replies: [REPLY], fallbackReply: "Okay." });
  try {
    await h.waitForReplies(1);
    h.say(USER);
    await h.waitForReplies(2);

    const serialized = JSON.stringify(h.turns());
    for (const secret of [OPENING, REPLY, USER, "Sakshi", "Rohan", "TEST APPENDIX", "FlexiFunnels"]) {
      assert.ok(
        !serialized.includes(secret),
        `turn telemetry must carry no conversation content, but it contained ${JSON.stringify(secret)}`,
      );
    }

    // Positive control: the fields that SHOULD be there are, so the
    // assertion above cannot pass merely because nothing was recorded.
    const turn = h.turns()[0];
    assert.ok(turn, "a turn must have been recorded");
    assert.equal(turn.turnOutcome, "spoken");
    assert.equal(typeof turn.charsGenerated, "number", "the record carries a COUNT of characters");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION G — cut-sentence telemetry is diagnostic only (2026-09-25)");
// ═════════════════════════════════════════════════════════════════

const BLOCK_SENTENCE_1 = "Actually, I am calling you with a very interesting invitation.";
const QUESTION_BLOCK =
  "Have you ever tried selling something online before? " +
  "We can help you get started with that very quickly today.";
const QUESTION_SENTENCE_1 = "Have you ever tried selling something online before?";
const INTERRUPTION = "Wait, how much does it cost?";

/** Cut the reply `fraction` of the way through its first sentence, with real content. */
async function cutFirstSentenceAt(h: Harness, sentence: string, fraction: number): Promise<void> {
  await h.waitForReplies(1);
  h.say(FIRST_USER_TURN);
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(Math.round((sentence.length / CHARS_PER_SECOND) * 1000 * fraction));
  h.say(INTERRUPTION);
  await h.waitForReplies(2);
}

function cutTurn(h: Harness): TurnLatencyBreakdown | undefined {
  return h.turns().find((t) => t.cutSentence !== undefined);
}

await test("G1 — a cut BEFORE half of a statement: recorded, does not qualify, and nothing more is committed", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutFirstSentenceAt(h, BLOCK_SENTENCE_1, 0.3);
    const cut = cutTurn(h)?.cutSentence;
    assert.ok(cut, `the cut sentence must be recorded, turns=${JSON.stringify(h.turns())}`);
    assert.equal(cut.sentenceIndex, 0);
    assert.equal(cut.sentenceChars, BLOCK_SENTENCE_1.length);
    assert.equal(cut.endsWithQuestion, false);
    assert.ok(cut.playedFraction !== undefined && cut.playedFraction > 0 && cut.playedFraction < 0.5, `fraction=${cut.playedFraction}`);
    assert.equal(cut.proposedRuleQualifies, false);
    assert.equal(cut.currentHeardChars, 0);
    assert.equal(cut.proposedHeardChars, cut.currentHeardChars, "PROPOSED equals CURRENT when the rule does not qualify");
    assert.deepEqual(assistantTexts(h.history()), [OPENING, "It is free."], "nothing of the cut sentence was committed (CURRENT behaviour)");
  } finally {
    await h.stop();
  }
});

await test("G2 — a cut AFTER half of a statement: the rule WOULD qualify, but CURRENT behaviour still commits nothing", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutFirstSentenceAt(h, BLOCK_SENTENCE_1, 0.8);
    const cut = cutTurn(h)?.cutSentence;
    assert.ok(cut, "the cut sentence must be recorded");
    assert.ok(cut.playedFraction !== undefined && cut.playedFraction > 0.5 && cut.playedFraction < 1, `fraction=${cut.playedFraction}`);
    assert.ok((cut.sentenceDurationMs ?? 0) > 0 && cut.playedMs > 0 && cut.playedMs < (cut.sentenceDurationMs ?? 0));
    assert.equal(cut.proposedRuleQualifies, true, "the proposed rule would credit it");
    assert.equal(cut.currentHeardChars, 0);
    assert.equal(cut.proposedHeardChars, BLOCK_SENTENCE_1.length, "PROPOSED would have credited the sentence");
    // THE POINT: logging only. The sentence is still NOT committed, and
    // the model is still shown exactly what it was shown before.
    assert.deepEqual(assistantTexts(h.history()), [OPENING, "It is free."], "CURRENT behaviour is unchanged");
  } finally {
    await h.stop();
  }
});

await test("G3 — a cut after half of a QUESTION: recorded as a question and never qualifies", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [QUESTION_BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutFirstSentenceAt(h, QUESTION_SENTENCE_1, 0.8);
    const cut = cutTurn(h)?.cutSentence;
    assert.ok(cut, "the cut sentence must be recorded");
    assert.equal(cut.endsWithQuestion, true);
    assert.ok(cut.playedFraction !== undefined && cut.playedFraction > 0.5, `fraction=${cut.playedFraction}`);
    assert.equal(cut.proposedRuleQualifies, false, "a question is never credited by the proposed rule");
    assert.equal(cut.proposedHeardChars, cut.currentHeardChars);
  } finally {
    await h.stop();
  }
});

await test("G4 — the cut-sentence record carries no conversation text", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutFirstSentenceAt(h, BLOCK_SENTENCE_1, 0.8);
    assert.ok(cutTurn(h), "positive control: a record exists");
    const serialized = JSON.stringify(h.turns());
    for (const secret of [BLOCK_SENTENCE_1, "Actually", "invitation", INTERRUPTION, OPENING]) {
      assert.ok(!serialized.includes(secret), `turn telemetry must carry no text, but contained ${JSON.stringify(secret)}`);
    }
  } finally {
    await h.stop();
  }
});

await test("G5 — an uninterrupted reply records no cut sentence", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure, it is free."], fallbackReply: "Okay." });
  try {
    await h.waitForReplies(1);
    h.say(FIRST_USER_TURN);
    await h.waitForReplies(2);
    assert.equal(cutTurn(h), undefined);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION H — barge-in trigger text SHAPE (Issue 2, 2026-09-26)");
// ═════════════════════════════════════════════════════════════════

async function cutWith(h: Harness, interruption: string): Promise<void> {
  await h.waitForReplies(1);
  h.say(FIRST_USER_TURN);
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(400);
  h.say(interruption);
  await h.waitForReplies(2);
}

const triggerOf = (h: Harness) => h.turns().find((t) => t.bargeInTrigger?.source === "transcript")?.bargeInTrigger;

await test("H1 — a trigger ending in an em-dash records endsWithDash=true and pendingWordCount=0", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."], fallbackReply: "Okay." });
  try {
    await cutWith(h, "Wait—");
    const trigger = triggerOf(h);
    assert.ok(trigger, `a transcript barge-in must be recorded, turns=${JSON.stringify(h.turns())}`);
    assert.equal(trigger.endsWithDash, true);
    assert.equal(trigger.pendingWordCount, 0);
  } finally {
    await h.stop();
  }
});

await test("H2 — a dash inside a trigger with content records endsWithDash=false", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutWith(h, "Yeah— but how much does it cost?");
    const trigger = triggerOf(h);
    assert.ok(trigger, "a transcript barge-in must be recorded");
    assert.equal(trigger.endsWithDash, false);
    assert.equal(typeof trigger.pendingWordCount, "number");
  } finally {
    await h.stop();
  }
});

await test("H3 — the trigger shape fields carry no caller text", async () => {
  const INTERRUPTION_TEXT = "Yeah— but how much does it cost?";
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is free."], fallbackReply: "Okay." });
  try {
    await cutWith(h, INTERRUPTION_TEXT);
    assert.ok(triggerOf(h), "positive control: a record exists");
    const serialized = JSON.stringify(h.turns());
    for (const secret of [INTERRUPTION_TEXT, "Yeah", "cost", OPENING]) {
      assert.ok(!serialized.includes(secret), `turn telemetry must carry no text, but contained ${JSON.stringify(secret)}`);
    }
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
