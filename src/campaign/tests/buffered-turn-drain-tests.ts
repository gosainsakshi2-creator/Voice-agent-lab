/**
 * buffered-turn-drain-tests.ts — `npm run test:buffered-turn`
 *
 * ONE LATENCY DEFECT, AND THE FIVE THINGS THE FIX MUST NOT BREAK.
 *
 * THE DEFECT. A caller who speaks into the THINKING gap has their words
 * END before the reply's audio begins, so `spokeOverTheAssistant` is
 * false, no barge-in path is ever consulted, and the completed turn
 * lands in `AdaptiveTurnDetector.pendingEvent` with no subscriber to
 * receive it. Nothing looks at it until the whole reply has drained —
 * so on a 350-character pitch block the caller waits out ~16 seconds of
 * audio before the thing they said is answered.
 *
 * THE FIX. `drainPlayback(signal, interruptibleByBufferedTurn)` polls
 * the new read-only `bufferedTurnText()` getter every 250ms and, when a
 * MEANINGFUL turn is already waiting, cuts the reply short through the
 * EXISTING `triggerExternalBargeIn()`. Passed `true` from exactly the
 * two generated-reply drains and from nowhere else.
 *
 * WHAT IS PROVEN HERE, IN THE ORDER IT MATTERS:
 *
 *   A. The two guards, on the real `drainPlayback`. Playback that has
 *      not started must not be pollable at all — `heardSoFarText()` is
 *      empty until the first frame, and a barge-in with nothing heard
 *      commits NOTHING, which erases the reply from history and makes
 *      the next request generate the block again from the top. And a
 *      DECLINED barge-in must mean "keep draining", never "stop".
 *
 *   B. The behaviour itself, end to end through the real pipeline: a
 *      meaningful buffered turn is answered without waiting out the
 *      block, while a buffered "okay" and a buffered "hello" are not
 *      allowed to cut it — cancelling a reply for one of those restarts
 *      the block the acknowledgement was agreeing with.
 *
 *   C. The registration invariants from the Risk #8 audit, against the
 *      REAL approved v4 gate read out of the script file. A prefix that
 *      never reached the gate must not settle as a confirmation; a
 *      prefix that DID reach it still must.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker, the conversation
 * memory, the classifier and the FINAL_YES gate are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline, bufferedTurnTakesTheFloor, isRepeatedGreeting } = await import(
  "../../core/session/conversation-pipeline"
);
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes } = await import("../integrations/final-yes-sheet");
const { findScript } = await import("../script/script-registry");

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { StreamingTranscriptionRequest } from "../../types/streaming.types";
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

/** Same rate the other pipeline suites use, so audio durations read in seconds. */
const CHARS_PER_SECOND = 22;

function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return {
    data: new Uint8Array(Math.round(seconds * 8000)),
    encoding: "MULAW",
    sampleRateHz: 8000,
  };
}

/** 100ms of 8kHz μ-law silence — one "microphone" frame. */
const MIC_FRAME_MS = 100;
function micFrame(): AudioPayload {
  return {
    data: new Uint8Array((MIC_FRAME_MS / 1000) * 8000),
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

/**
 * The two playback counters and the two read-only helpers section A
 * needs to reach. Private on the pipeline because nothing in
 * production may write them; a test that is ABOUT the guard on them
 * has to, and does so through one declared shape rather than scattered
 * `any`s.
 */
interface PlaybackInternals {
  outboundPlaybackStartedAt: number;
  outboundQueuedMs: number;
  heardSoFarText(): string;
  drainPlayback(signal: AbortSignal, interruptibleByBufferedTurn?: boolean): Promise<void>;
}
const internals = (pipeline: unknown): PlaybackInternals => pipeline as PlaybackInternals;

const stack = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
};

function newRecord(id: string, openingLine: string): InstanceType<typeof SessionRecord> {
  return new SessionRecord(
    id as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: stack,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test",
        campaignType: "registration",
        scriptId: "test",
        scriptVersion: "v4",
        scriptHash: "test",
        agent: { gender: "female", name: "Ishita" },
        customer: { name: "Priya" },
        openingLine,
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );
}

/** A finished caller utterance, as the detector receives it. */
function finalSegment(text: string, endedAtStreamMs: number): TranscriptSegment {
  const durationMs = Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
  return {
    text,
    isFinal: true,
    isSpeechFinal: true,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: Math.max(0, endedAtStreamMs - durationMs),
    endedAtMs: endedAtStreamMs,
  };
}

const OPENING = "Hello Priya, this is Ishita from Team FlexiFunnels.";

/**
 * The shape of the reply that makes the defect expensive: one long
 * generated block. ~350 characters is the p90 of the real pitch block
 * (HANDOFF §P0), i.e. ~16s of audio to sit through.
 */
const LONG_BLOCK =
  "I'm calling to personally invite you to a free live workshop we are hosting on Sunday at eleven in the morning. " +
  "We will actually build a complete online business live, directly from a phone, including the website, the product, " +
  "the checkout and the payments. And you do not need any coding or design skills whatsoever to follow along.";
const LONG_BLOCK_AUDIO_MS = (LONG_BLOCK.length / CHARS_PER_SECOND) * 1000;

/** Short enough that a test may wait out the whole drain to prove it was NOT cut. */
const SHORT_BLOCK = "We are hosting a free live workshop this Sunday morning, and it runs for about an hour.";

const FOLLOW_UP = "The workshop is completely free of charge.";

interface SayOptions {
  /**
   * Where on the STT stream clock the caller's words ENDED. Back-dating
   * this to a position before the reply's audio began is the whole
   * defect: `spokeOverTheAssistant` is then false, so the segment skips
   * every barge-in filter and is fed straight to the detector, which
   * buffers the completed turn because nothing is subscribed.
   */
  readonly endedAtStreamMs?: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  /** How many times the pipeline asked the manager to hang up. */
  hangupCount(): number;
  /** Outbound audio chunks handed to the transport, i.e. playback progress. */
  outboundChunks(): number;
  /** The harness's own mirror of the inbound stream position, in ms. */
  streamMs(): number;
  say(text: string, opts?: SayOptions): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /**
   * Blocks until the reply that answers `text` is actually PLAYING, and
   * returns the stream position at which the caller's next words end.
   *
   * The sequencing matters and is easy to get wrong: waiting on "any
   * outbound audio" is already true from the greeting, so a second
   * utterance said straight away arrives BEFORE the first turn has
   * endpointed and the detector merges the two into one turn — no
   * buffered turn is ever created and every assertion below passes
   * vacuously. Waiting for audio queued AFTER this turn was released is
   * what makes the buffered case real.
   */
  sayThenWaitForReply(text: string): Promise<number>;
  assistantTexts(): string[];
  /** Conversational language-model requests opened so far (the prefix-cache prime is not one). */
  requestCount(): number;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  /** Every host state transition, in order, with the pipeline's stated reason. */
  readonly transitions: Array<{ readonly from: string; readonly to: string; readonly reason?: string | undefined }>;
  /** Committed user + assistant turns, in order, as `role|text` rows. */
  conversation(): string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  /** Chosen by what the caller last said, so a speculative pre-open cannot shift a scripted index. */
  readonly replyFor: (lastUserText: string) => string;
  readonly replyDelayMs?: number;
}): Harness {
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let micStreamMs = 0;
  let outboundChunks = 0;
  let hangups = 0;
  let requests = 0;
  const synthesized: string[] = [];
  const transitions: Array<{ readonly from: string; readonly to: string; readonly reason?: string | undefined }> = [];

  const record = newRecord("buffered-turn-test", input.openingLine);

  // The "microphone": real-time inbound audio, so the pipeline's own
  // `inboundStreamMs` advances exactly as it does on a live call. Without
  // it every segment reads as an interruption, because the SPEAKING mark
  // it is compared against would never move off zero.
  const mic = setInterval(() => {
    if (closed) return;
    micStreamMs += MIC_FRAME_MS;
    record.inboundAudioFallback.push(micFrame());
  }, MIC_FRAME_MS);

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: (request: StreamingTranscriptionRequest): AsyncIterable<TranscriptSegment> => {
      // Drain the inbound audio. The pipeline counts the bytes as they
      // pass THROUGH to the provider, so a provider that never reads
      // them leaves the stream clock at zero.
      void (async () => {
        try {
          for await (const chunk of request.audio) {
            void chunk;
            if (closed) break;
          }
        } catch {
          // The harness stopped; nothing to do.
        }
      })();
      return (async function* () {
        while (!closed) {
          const next = segments.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      })();
    },
  };

  const lastUserTextIn = (history: readonly ConversationTurn[]): string => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const turn = history[i];
      if (turn?.role === "user") return turn.content;
    }
    return "";
  };

  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async (request: CompletionRequest) => ({
      turn: {
        role: "assistant" as const,
        content: input.replyFor(lastUserTextIn(request.history)),
        timestamp: new Date(),
      },
      latencyMs: 0,
    }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event. Not a
      // conversational request.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      // Keyed off what the caller said rather than off a call counter,
      // so a speculative pre-open for the same pending turn yields the
      // same reply and cannot shift what a later turn is answered with.
      requests += 1;
      const reply = input.replyFor(lastUserTextIn(request.history));
      await sleep(input.replyDelayMs ?? 10);
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

  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => {
    outboundChunks += 1;
    return undefined;
  });

  const host = {
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
      reason?: string,
    ) => {
      transitions.push({ from: r.state, to, reason });
      r.state = to;
    },
    markError: () => undefined,
    end: async () => {
      hangups += 1;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      return undefined;
    },
  };

  const pipeline = new ConversationPipeline(
    record,
    { telephony, stt, llm, tts } as never,
    host as never,
  );
  const loop = pipeline.run();

  return {
    record,
    pipeline,
    hangupCount: () => hangups,
    requestCount: () => requests,
    synthesized,
    transitions,
    outboundChunks: () => outboundChunks,
    streamMs: () => micStreamMs,
    say(text, opts) {
      // The caller is talking into the handset — stamped the way the
      // bridges stamp it, before the transcript arrives.
      record.lastCallerEnergyAt = Date.now();
      record.lastConversationActivityAt = Date.now();
      segments.push(finalSegment(text, opts?.endedAtStreamMs ?? micStreamMs));
      waiters.shift()?.();
    },
    async waitFor(what, predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async sayThenWaitForReply(text) {
      const chunksBefore = outboundChunks;
      const repliesBefore = record.memory.history().filter((t) => t.role === "assistant").length;
      this.say(text);
      // The caller's NEXT words end here — while the reply to `text` is
      // still being prepared, i.e. in the THINKING gap.
      const spokeAtStreamMs = micStreamMs;
      await this.waitFor(
        `the reply to "${text}" to start playing`,
        () =>
          outboundChunks > chunksBefore &&
          record.state === SessionState.SPEAKING &&
          record.memory.history().filter((t) => t.role === "assistant").length === repliesBefore,
      );
      return spokeAtStreamMs;
    },
    async waitForReplies(n, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((turn) => turn.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${
          record.memory.history().filter((turn) => turn.role === "assistant").length
        }, state=${record.state})`,
      );
    },
    assistantTexts() {
      return record.memory
        .history()
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.content);
    },
    conversation() {
      return record.memory
        .history()
        .filter((turn) => turn.role === "user" || turn.role === "assistant")
        .map((turn) => `${turn.role}|${turn.content}`);
    },
    async stop() {
      closed = true;
      clearInterval(mic);
      record.inboundAudioFallback.close();
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

/**
 * A pipeline that is NOT running its loop, for the two guard tests.
 * Nothing is dialled, nothing is spoken, and the real turn detector,
 * the real `drainPlayback` and the real `triggerExternalBargeIn` are
 * the ones under test.
 */
function idlePipeline(): {
  record: InstanceType<typeof SessionRecord>;
  pipeline: InstanceType<typeof ConversationPipeline>;
} {
  const record = newRecord("buffered-turn-guard", OPENING);
  record.loopAbortController = new AbortController();
  const noop = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake"),
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake")),
  };
  const pipeline = new ConversationPipeline(
    record,
    { telephony: noop, stt: noop, llm: noop, tts: noop } as never,
    {
      transition: (
        r: InstanceType<typeof SessionRecord>,
        to: (typeof SessionState)[keyof typeof SessionState],
      ) => {
        r.state = to;
      },
      markError: () => undefined,
      end: async () => undefined,
    } as never,
  );
  return { record, pipeline };
}

/** Buffers a completed turn in the REAL detector, with nothing subscribed. */
function bufferTurn(record: InstanceType<typeof SessionRecord>, text: string): void {
  record.turnDetector.feed(finalSegment(text, 1_000));
  record.turnDetector.forceEndTurn();
  assert.equal(record.turnDetector.hasBufferedTurn(), true, "the turn must be buffered");
  assert.equal(record.turnDetector.bufferedTurnText(), text, "the getter must report it verbatim");
}

const MEANINGFUL = "Wait, how much does the whole thing cost me?";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the two guards, on the real `drainPlayback`");
// ═════════════════════════════════════════════════════════════════

await test("A1. `bufferedTurnText()` is read-only: it neither consumes nor clears the buffered turn", () => {
  const { record } = idlePipeline();
  bufferTurn(record, MEANINGFUL);

  // Read it many times. The turn must still be there for the next
  // subscriber, whole and unchanged — `emitTurnEnd` buffers only while
  // nothing is subscribed, so a reader that consumed it would lose the
  // caller's words forever.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(record.turnDetector.bufferedTurnText(), MEANINGFUL);
  }
  assert.equal(record.turnDetector.hasBufferedTurn(), true, "still held after 5 reads");

  // And it is still DELIVERED to whoever subscribes next.
  let delivered: string | undefined;
  record.turnDetector.onTurnEnd((event) => {
    delivered = event.text;
  });
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      assert.equal(delivered, MEANINGFUL, "the buffered turn must reach the first subscriber");
      assert.equal(record.turnDetector.hasBufferedTurn(), false, "and be consumed by it, once");
      assert.equal(record.turnDetector.bufferedTurnText(), "", "the getter is empty once consumed");
      resolve();
    });
  });
});

await test("A2. playback that has not started is NOT pollable — the early return still wins", async () => {
  const { record, pipeline } = idlePipeline();
  bufferTurn(record, MEANINGFUL);
  record.state = SessionState.SPEAKING;

  const inner = internals(pipeline);
  // Audio has been queued but not one frame has been handed over yet —
  // the window between "TTS returned" and "the pump's first send".
  inner.outboundQueuedMs = 5_000;
  inner.outboundPlaybackStartedAt = 0;

  // THE REASON THE GUARD EXISTS: with nothing played, the heard text is
  // empty, and a barge-in here commits NOTHING — the reply vanishes
  // from history and the next request generates the block again.
  assert.equal(inner.heardSoFarText(), "", "nothing can have been heard before playback starts");

  const startedAt = Date.now();
  await inner.drainPlayback(new AbortController().signal, true);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs < 250,
    `the early return must fire before any polling (took ${elapsedMs}ms of a 5000ms queue)`,
  );
  assert.equal(record.state, SessionState.SPEAKING, "no barge-in may have been triggered");
  assert.equal(
    record.turnDetector.hasBufferedTurn(),
    true,
    "the buffered turn is untouched and still waiting for the main loop",
  );
});

await test("A3. a DECLINED barge-in means keep draining, not stop", async () => {
  const { record, pipeline } = idlePipeline();
  bufferTurn(record, MEANINGFUL);
  record.state = SessionState.SPEAKING;

  const inner = internals(pipeline);
  // Playback HAS started, so the poll loop really runs. But the opening
  // line is still playing as far as the pipeline is concerned
  // (`greetingDone` is false on a pipeline whose loop never ran), so
  // `triggerExternalBargeIn()` declines — exactly as it does for a
  // "hello" on pickup.
  const queuedMs = 900;
  inner.outboundQueuedMs = queuedMs;
  inner.outboundPlaybackStartedAt = Date.now();

  assert.equal(
    pipeline.triggerExternalBargeIn(),
    false,
    "the fixed opening line must be uninterruptible — this test depends on it",
  );

  const startedAt = Date.now();
  await inner.drainPlayback(new AbortController().signal, true);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs >= queuedMs - 100,
    `a declined barge-in must not cut the drain short (waited only ${elapsedMs}ms of ${queuedMs}ms)`,
  );
  assert.equal(
    record.turnDetector.hasBufferedTurn(),
    true,
    "and the caller's words are still waiting to be answered after it",
  );
});

await test("A4. with the flag OFF, a meaningful buffered turn changes nothing", async () => {
  const { record, pipeline } = idlePipeline();
  bufferTurn(record, MEANINGFUL);
  record.state = SessionState.SPEAKING;

  const inner = internals(pipeline);
  const queuedMs = 700;
  inner.outboundQueuedMs = queuedMs;
  inner.outboundPlaybackStartedAt = Date.now();

  const startedAt = Date.now();
  // No second argument: every fixed-utterance drain calls it this way.
  await inner.drainPlayback(new AbortController().signal);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs >= queuedMs - 100,
    `the default path must sleep out the whole span (waited ${elapsedMs}ms of ${queuedMs}ms)`,
  );
  assert.equal(record.state, SessionState.SPEAKING, "and must not trigger a barge-in of its own");
  assert.equal(record.turnDetector.hasBufferedTurn(), true);
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — the behaviour, end to end through the real pipeline");
// ═════════════════════════════════════════════════════════════════

await test("B1. a meaningful buffered turn is answered without waiting out the block", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);

    // The caller answers the greeting, then carries straight on. Their
    // second utterance ENDS before the block's audio begins; its
    // transcript only lands once the block is playing, which is the
    // whole defect — `spokeOverTheAssistant` is false, so no barge-in
    // path is consulted and the completed turn is merely buffered.
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    const drainStartedAt = Date.now();
    h.say(MEANINGFUL, { endedAtStreamMs: spokeAtStreamMs });

    await h.waitForReplies(3);
    const answeredAfterMs = Date.now() - drainStartedAt;

    const texts = h.assistantTexts();
    const spokenBlock = texts[1] ?? "";

    // The reply was CUT: what is committed is the part the caller heard.
    assert.ok(spokenBlock.length > 0, "the part the caller heard must be committed, not dropped");
    assert.ok(
      spokenBlock.length < LONG_BLOCK.length,
      `the block must have been cut short (committed ${spokenBlock.length} of ${LONG_BLOCK.length} chars)`,
    );
    assert.ok(
      LONG_BLOCK.startsWith(spokenBlock.slice(0, 40)),
      "and it must be a PREFIX of the block, never invented text",
    );

    // And it was answered without sitting through the rest of the audio.
    assert.ok(
      answeredAfterMs < LONG_BLOCK_AUDIO_MS * 0.75,
      `the buffered turn must be answered well before the block would have drained ` +
        `(${answeredAfterMs}ms against ${Math.round(LONG_BLOCK_AUDIO_MS)}ms of audio)`,
    );
    assert.equal(texts[2], FOLLOW_UP, "and answered contextually by the language model");
  } finally {
    await h.stop();
  }
});

await test("B2. a buffered bare acknowledgement does NOT cut the block", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? SHORT_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Okay.", { endedAtStreamMs: spokeAtStreamMs });

    // The turn really is buffered — otherwise this test would pass
    // vacuously, with nothing for the poll to have declined.
    await h.waitFor(
      "the bare acknowledgement to be buffered as a completed turn",
      () => h.record.turnDetector.bufferedTurnText().trim().length > 0,
    );

    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      SHORT_BLOCK,
      "the whole block must be spoken and committed — cutting it for an 'okay' is the " +
        "'it restarts after I said okay' defect",
    );
  } finally {
    await h.stop();
  }
});

await test("B3. a buffered bare greeting does NOT cut the block", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? SHORT_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Hello?", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitFor(
      "the bare greeting to be buffered as a completed turn",
      () => h.record.turnDetector.bufferedTurnText().trim().length > 0,
    );

    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      SHORT_BLOCK,
      "a caller filling the silence with 'hello' must not destroy the block",
    );
  } finally {
    await h.stop();
  }
});

await test('B3b. a buffered presence check ("Hello? Are you there?") does NOT cut the block', async () => {
  // The case the two specified predicates MISS. "are you there" is
  // content to both `BARE_GREETING_ONLY` and `isBareAcknowledgement`,
  // so without `isAttentionCheck` in the filter this cuts the block —
  // and `test:stt-clock` asserts directly that it must not.
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? SHORT_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Hello? Are you there?", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitFor(
      "the presence check to be buffered as a completed turn",
      () => h.record.turnDetector.bufferedTurnText().trim().length > 0,
    );

    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      SHORT_BLOCK,
      "a caller asking whether the line is alive must not destroy the block",
    );
  } finally {
    await h.stop();
  }
});

await test('B3c. ...but "Hello? What is this about?" is a real question and DOES cut it', async () => {
  // The other side of the same boundary: a greeting with a question
  // behind it is not a presence check, and the filter must not swallow
  // it. This is what keeps the fix from being a no-op in Hinglish
  // calls that open with a greeting token.
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Hello? What is this about?", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitForReplies(3);
    const spokenBlock = h.assistantTexts()[1] ?? "";
    assert.ok(spokenBlock.length > 0, "the heard part must still be committed");
    assert.ok(
      spokenBlock.length < LONG_BLOCK.length,
      `a real question must cut the block short (committed ${spokenBlock.length} of ${LONG_BLOCK.length})`,
    );
  } finally {
    await h.stop();
  }
});

await test('B3d. a MERGED buffered turn ("Umm Hello? Are you there?") does NOT cut the block', async () => {
  // THE REGRESSION THIS SECTION EXISTS FOR. `emitTurnEnd` merges turns
  // that endpoint while nothing is subscribed, so the caller's
  // timing-less "Umm" and their presence check arrive as ONE string
  // that no whole-utterance predicate recognises. Reading it as a real
  // contribution cut the block — which `test:stt-clock`'s "a result
  // carrying NO word timings" test asserts must not happen.
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? SHORT_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    // Two utterances, 150ms apart, so the detector merges them into one
    // buffered turn exactly as it does on the wire.
    h.say("Umm", { endedAtStreamMs: spokeAtStreamMs });
    await sleep(150);
    h.say("Hello? Are you there?", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitFor(
      "the merged turn to be buffered",
      () => h.record.turnDetector.bufferedTurnText().trim().split(/\s+/u).length > 1,
    );
    assert.match(
      h.record.turnDetector.bufferedTurnText(),
      /Umm.*there/su,
      "this test depends on the two utterances actually being MERGED into one buffered turn",
    );

    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      SHORT_BLOCK,
      "a merge of a hesitation sound and a presence check must not destroy the block",
    );
  } finally {
    await h.stop();
  }
});

await test("B3e. the floor decision, phrase by phrase, on the real predicate", () => {
  // The table form of the same boundary. Cheap, exhaustive and exact —
  // and it is the thing that will fail first if any of the three
  // underlying predicates is ever narrowed.
  const takesNoFloor = [
    "Umm Hello? Are you there?", // the merged regression case
    "Hello?",
    "Are you there?",
    "Umm",
    "Okay",
    "Yes",
    "Yeah",
    "Okay Umm", // merge of two acknowledgements
    "Umm, are you there?",
    "Hello? Hello?",
    "hmm okay",
    "Can you hear me?",
    "sun rahe ho?",
  ];
  const takesTheFloor = [
    "Hello? What is this about?",
    "Umm, I have a question about the workshop.",
    "Yes, I have a question.",
    "I wanted to ask about the registration.",
    "Wait, how much does the whole thing cost me?",
    "No, I am not interested.",
    "Umm Hello? What is the price?", // a merge whose second half IS content
  ];

  for (const text of takesNoFloor) {
    assert.equal(
      bufferedTurnTakesTheFloor(text),
      false,
      `"${text}" must NOT be allowed to cut a generated reply short`,
    );
  }
  for (const text of takesTheFloor) {
    assert.equal(
      bufferedTurnTakesTheFloor(text),
      true,
      `"${text}" MUST be able to cut a generated reply short — otherwise the fix is a no-op`,
    );
  }
});

await test("B3f. a meaningful turn whose FIRST words are filler still interrupts", async () => {
  // The mirror of B3d, end to end: the same merge shape, but the second
  // half is a real question. The split rule must not swallow it.
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Umm", { endedAtStreamMs: spokeAtStreamMs });
    await sleep(150);
    h.say("I have a question about the workshop.", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitForReplies(3);
    const spokenBlock = h.assistantTexts()[1] ?? "";
    assert.ok(spokenBlock.length > 0, "the heard part must still be committed");
    assert.ok(
      spokenBlock.length < LONG_BLOCK.length,
      `a real question behind a filler must still cut the block (committed ${spokenBlock.length} of ${LONG_BLOCK.length})`,
    );
  } finally {
    await h.stop();
  }
});

await test("B4. the assistant prefix is committed BEFORE the buffered caller turn", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say(MEANINGFUL, { endedAtStreamMs: spokeAtStreamMs });
    await h.waitForReplies(3);

    const rows = h.conversation();
    const prefixIndex = rows.findIndex((row) => row.startsWith("assistant|I'm calling"));
    const bufferedIndex = rows.findIndex((row) => row.startsWith("user|Wait, how much"));

    assert.ok(prefixIndex >= 0, `the cut block must be in history — got ${JSON.stringify(rows)}`);
    assert.ok(bufferedIndex >= 0, `the buffered turn must be in history — got ${JSON.stringify(rows)}`);
    // THE ORDERING INVARIANT. The classifier looks BACK from a caller
    // turn to the nearest assistant turn; a prefix committed after the
    // caller's words would put the wrong question behind their answer.
    assert.ok(
      prefixIndex < bufferedIndex,
      `the assistant prefix must precede the buffered caller turn (got ${prefixIndex} vs ${bufferedIndex})`,
    );
  } finally {
    await h.stop();
  }
});

await test("B5. the call stays up and the conversation carries on afterwards", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say(MEANINGFUL, { endedAtStreamMs: spokeAtStreamMs });
    await h.waitForReplies(3);

    assert.equal(h.hangupCount(), 0, "cutting a reply short must never end the call");
    assert.equal(h.record.state, SessionState.LISTENING, "and the agent must be listening again");

    // One more real exchange, on the same call, through the normal path.
    h.say("Alright, I would like to attend the workshop.");
    await h.waitForReplies(4);
    assert.equal(h.hangupCount(), 0);
    assert.equal(h.assistantTexts().length, 4, "the next reply must be generated normally");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — the registration invariants, against the REAL v4 gate");
// ═════════════════════════════════════════════════════════════════

const v4 = findScript("registration", "v4");
assert.ok(v4, "the approved registration v4 script must be registered");
const V4_GATE = "Would you like me to reserve your free seat?";
assert.ok(
  v4.systemPromptAppendix.includes(V4_GATE),
  "these tests' gate line must be the one in the approved v4 script",
);

type Turn = { role: "assistant" | "user"; text: string; at: string | null };
const agent = (text: string): Turn => ({ role: "assistant", text, at: null });
const caller = (text: string): Turn => ({ role: "user", text, at: null });

function settle(transcript: readonly Turn[]) {
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
    scriptText: v4!.systemPromptAppendix,
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return { classification, disposition };
}

/** The v4 pitch block, and the prefix of it a cut two sentences in leaves. */
const V4_PITCH =
  "I'm calling to personally invite you to a free live workshop we're hosting on Sunday, 6th September at 11 AM. " +
  "We'll actually build a complete online business live, directly from a phone — including the website, product, " +
  `checkout and payments. And you don't need any coding or design skills. ${V4_GATE}`;
const V4_PITCH_CUT =
  "I'm calling to personally invite you to a free live workshop we're hosting on Sunday, 6th September at 11 AM.";

await test("C1. the cut prefix really is a prefix, and really lacks the gate anchor", () => {
  assert.ok(V4_PITCH.startsWith(V4_PITCH_CUT), "the cut must be a prefix of the approved block");
  assert.ok(V4_PITCH.includes("reserve your free seat"), "the whole block carries the anchor");
  assert.ok(
    !V4_PITCH_CUT.includes("reserve your free seat"),
    "and the cut prefix must not — otherwise C2 proves nothing",
  );
});

await test("C2. a prefix that never reached the gate must NOT settle as a confirmation", () => {
  const { classification, disposition } = settle([
    agent(OPENING),
    agent(V4_PITCH_CUT),
    caller("Yes."),
  ]);

  assert.notEqual(
    classification.primaryReason,
    "confirmed_at_gate",
    "a yes to a block that never asked the question is not an answer to it",
  );
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false, "and nothing may reach the sheet");
});

await test("C3. a prefix that DID reach the gate still settles as FINAL_YES", () => {
  const { classification, disposition } = settle([
    agent(OPENING),
    agent(V4_PITCH),
    caller("Yes."),
  ]);

  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), true);
});

await test("C4. the gate survives a cut that lands AFTER it, mid-confirmation", () => {
  // The other side of the same coin: the caller heard the question, so
  // the chunk carrying it is behind the play head and is committed. A
  // later cut removes only what followed.
  const { classification, disposition } = settle([
    agent(OPENING),
    agent(V4_PITCH),
    caller("Yes, please reserve it."),
    agent("Perfect! I'll get your registration confirmed and send the joining"),
  ]);

  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), true);
});

// ═════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════
section("SECTION D — a REPEATED hello behind a playing block demands attention (the thinking-gap case)");
// ═════════════════════════════════════════════════════════════════
//
// Real call, 2026-09-04 08:52 UTC (Vobiz): the caller answered "Hello.",
// the model took ~2.8s to first audio, the caller said "Hello?" into
// that silence, and the pitch block then played for 18s before the
// buffered hello was answered. A bare greeting buffered behind a block
// still does NOT cut it (B3 — the caller filling the silence). What
// cuts it now is the caller REPEATING themselves: "Hello? Hello?" in one
// utterance, or "Hello." answered by this very reply and "Hello?" again
// behind it. The cut is the EXISTING external barge-in; what follows is
// the EXISTING hearing flow (`test:attention` sections B/C/J).

/** The fixed hearing question, as the pipeline speaks it. */
const HEARING_QUESTION = "Hey, can you hear me okay?";

/** Whitespace-insensitive equality, the way `unspokenTail` compares text. */
const sameWords = (a: string, b: string): boolean => a.replace(/\s+/gu, "") === b.replace(/\s+/gu, "");

/**
 * The pitch is the reply to the caller's bare "Hello."; anything else gets
 * the follow-up. An `includes`-style test, like the B-series helpers: the
 * current user turn reaches the model with a note and a language hint
 * prefixed to it (`buildRequestHistory`), so an anchored match never fires.
 */
const pitchForHello = (last: string): string => (/hello/iu.test(last) ? LONG_BLOCK : FOLLOW_UP);

/**
 * Drives the real call's shape: opening line, the caller answers with a
 * bare "Hello.", the pitch block starts, and a second "Hello?" — whose
 * words ended in the thinking gap — lands as a buffered turn behind it.
 * Returns the request count once the block was in flight.
 */
async function helloThenHelloBehindTheBlock(h: Harness): Promise<{ requestsBefore: number; drainStartedAt: number }> {
  await h.waitForReplies(1);
  const spokeAtStreamMs = await h.sayThenWaitForReply("Hello.");
  const requestsBefore = h.requestCount();
  const drainStartedAt = Date.now();
  h.say("Hello?", { endedAtStreamMs: spokeAtStreamMs });
  return { requestsBefore, drainStartedAt };
}

await test('D1 (spec B4). "Hello." answered by a long block, then a buffered "Hello?" — the block is CUT through the existing barge-in and the hearing question is asked at once', async () => {
  const h = startHarness({ openingLine: OPENING, replyFor: pitchForHello, replyDelayMs: 200 });
  try {
    const { requestsBefore, drainStartedAt } = await helloThenHelloBehindTheBlock(h);

    await h.waitForReplies(3);
    const askedAfterMs = Date.now() - drainStartedAt;
    const texts = h.assistantTexts();
    const spokenBlock = texts[1] ?? "";

    // The old response did not finish: a heard PREFIX is committed.
    assert.ok(spokenBlock.length > 0, "the part the caller heard must be committed, not dropped");
    assert.ok(
      spokenBlock.length < LONG_BLOCK.length,
      `the block must have been cut short (committed ${spokenBlock.length} of ${LONG_BLOCK.length} chars)`,
    );
    assert.ok(LONG_BLOCK.startsWith(spokenBlock.slice(0, 40)), "and it must be a PREFIX of the block, never invented text");
    assert.ok(
      askedAfterMs < LONG_BLOCK_AUDIO_MS * 0.75,
      `the hearing question must not wait for the block (${askedAfterMs}ms against ${Math.round(LONG_BLOCK_AUDIO_MS)}ms of audio)`,
    );
    // The EXISTING external barge-in did the cutting: the transition the
    // bridges clear playback on, before the question was synthesized.
    const bargeInIndex = h.transitions.findIndex(
      (t) => t.from === SessionState.SPEAKING && t.to === SessionState.LISTENING && /barge.?in/iu.test(t.reason ?? ""),
    );
    assert.ok(bargeInIndex >= 0, `expected the external barge-in transition, got ${JSON.stringify(h.transitions)}`);
    assert.ok(h.synthesized.includes(HEARING_QUESTION), "the hearing question was synthesized");
    assert.equal(texts[2], HEARING_QUESTION, "and committed as the reply to the repeated hello");
    assert.equal(h.requestCount(), requestsBefore, "the hearing question spends no language-model request");
    // Nothing of the old response is synthesized after the question: the
    // streaming path had already handed every sentence of the block to
    // TTS before the cut (a batch provider synthesizes ahead of playback),
    // and no sentence is handed over again once the question is asked.
    const questionIndex = h.synthesized.indexOf(HEARING_QUESTION);
    assert.deepEqual(h.synthesized.slice(questionIndex + 1), [], "nothing is synthesized after the hearing question");
    assert.equal(
      h.synthesized.filter((t) => t.startsWith(LONG_BLOCK.slice(0, 30))).length,
      1,
      "the block's first sentence was synthesized exactly once — never restarted",
    );
    assert.equal(h.record.state, SessionState.LISTENING, "then the pipeline LISTENS");
  } finally {
    await h.stop();
  }
});

await test('D2 (spec B5). a buffered "Hello? Hello?" after a SUBSTANTIVE turn also cuts the block and enters the hearing flow', async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? LONG_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    const requestsBefore = h.requestCount();
    h.say("Hello? Hello?", { endedAtStreamMs: spokeAtStreamMs });

    await h.waitForReplies(3);
    const texts = h.assistantTexts();
    assert.ok((texts[1] ?? "").length < LONG_BLOCK.length, "the block was cut");
    assert.equal(texts[2], HEARING_QUESTION, "the hearing question follows");
    assert.equal(h.requestCount(), requestsBefore, "without a language-model request");
    assert.equal(h.record.state, SessionState.LISTENING);
  } finally {
    await h.stop();
  }
});

await test('D3 (spec B6). a buffered SINGLE "Hello?" after a substantive turn still does NOT cut the block (B3, restated beside D1/D2)', async () => {
  const h = startHarness({
    openingLine: OPENING,
    replyFor: (last) => (last.includes("tell me") ? SHORT_BLOCK : FOLLOW_UP),
    replyDelayMs: 200,
  });
  try {
    await h.waitForReplies(1);
    const spokeAtStreamMs = await h.sayThenWaitForReply("Yes, please tell me.");
    h.say("Hello?", { endedAtStreamMs: spokeAtStreamMs });
    await h.waitFor(
      "the bare greeting to be buffered as a completed turn",
      () => h.record.turnDetector.bufferedTurnText().trim().length > 0,
    );
    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], SHORT_BLOCK, "a single hello after a real turn must not destroy the block");
    assert.ok(
      !h.transitions.some((t) => /barge.?in/iu.test(t.reason ?? "")),
      "and no barge-in of any kind was triggered for it",
    );
  } finally {
    await h.stop();
  }
});

await test("D4. the repeated-greeting predicate, asserted on both sides — presence questions and hesitation merges are NOT it", () => {
  for (const text of ["Hello? Hello?", "hello hello", "Hello. Hello hello", "हैलो हैलो", "Hi, hello?"]) {
    assert.equal(isRepeatedGreeting(text), true, `should be a repeated greeting: ${JSON.stringify(text)}`);
  }
  for (const text of [
    "Hello?",
    "Hello.",
    "Hello? Are you there?", // B3b — stays with today's behaviour
    "Umm Hello? Are you there?", // B3d — stays with today's behaviour
    "Can you hear me?",
    "Are you there?",
    "Hello? What is this about?",
    "haan ji",
    "okay",
    "",
  ]) {
    assert.equal(isRepeatedGreeting(text), false, `must NOT be a repeated greeting: ${JSON.stringify(text)}`);
  }
});

await test('D5. after the attention cut, "Yes, continue from where you stopped." resumes the HELD remainder — no generation, nothing restarted', async () => {
  const h = startHarness({ openingLine: OPENING, replyFor: pitchForHello, replyDelayMs: 200 });
  try {
    const { requestsBefore } = await helloThenHelloBehindTheBlock(h);
    await h.waitForReplies(3);
    const heard = h.assistantTexts()[1] ?? "";

    h.say("Yes, continue from where you stopped.");
    await h.waitForReplies(4, 30_000);
    const resumed = h.assistantTexts()[3] ?? "";
    assert.ok(resumed.length > 0, "the unheard tail was spoken");
    assert.ok(!LONG_BLOCK.startsWith(resumed.slice(0, 30)) || resumed.length < LONG_BLOCK.length, "not the block from the top");
    assert.ok(sameWords(heard + resumed, LONG_BLOCK), `heard + resumed must be exactly the block, got ${JSON.stringify([heard, resumed])}`);
    assert.equal(h.requestCount(), requestsBefore, "no language-model request for the question or the resume");
    assert.equal(h.record.state, SessionState.LISTENING);
  } finally {
    await h.stop();
  }
});

await test('D6. after the attention cut, "Start from the beginning." replays the FULL original block — no generation', async () => {
  const h = startHarness({ openingLine: OPENING, replyFor: pitchForHello, replyDelayMs: 200 });
  try {
    const { requestsBefore } = await helloThenHelloBehindTheBlock(h);
    await h.waitForReplies(3);

    h.say("Start from the beginning.");
    await h.waitForReplies(4, 40_000);
    const replayed = h.assistantTexts()[3] ?? "";
    assert.ok(sameWords(replayed, LONG_BLOCK), `the whole block again, got ${JSON.stringify(replayed)}`);
    // The reply was synthesized sentence by sentence; the replay is one
    // fixed utterance. So the block's opening words go to TTS exactly
    // twice: once at the top of the original reply, once for the replay.
    assert.equal(
      h.synthesized.filter((t) => t.startsWith(LONG_BLOCK.slice(0, 30))).length,
      2,
      "the block's opening was synthesized once for the reply and once for the replay",
    );
    assert.equal(h.requestCount(), requestsBefore, "no language-model request");
    assert.equal(h.record.state, SessionState.LISTENING);
  } finally {
    await h.stop();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`\nFailed:\n${failures.map((name) => `  - ${name}`).join("\n")}`);
  process.exit(1);
}
process.exit(0);
