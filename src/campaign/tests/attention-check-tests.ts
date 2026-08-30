/**
 * attention-check-tests.ts — `npm run test:attention`
 *
 * FIX #2: "HELLO? HELLO? HELLO?" MUST NOT RESTART THE SCRIPT.
 *
 * THE DEFECT, MEASURED THROUGH THE REAL PIPELINE BEFORE THE FIX.
 *
 *   3 x "Hello?" over a playing block
 *     -> 3 separate language-model requests
 *     -> 3 separately generated, separately spoken replies
 *     -> the unheard tail of the block ("We have created Flexi
 *        Genie, ...") discarded and never spoken again
 *
 * The barge-in itself was never the bug: a "hello" over audio the
 * caller is hearing means the line may have gone bad, and it must
 * interrupt. What was missing is what happened AFTER. The part of the
 * reply the caller never heard is computed by `unspokenTail` and was
 * then dropped on the floor, because `resumeAfterStrandedBargeIn`
 * abandons the moment the caller produces turn material — and the
 * "hello" IS turn material. The next request was a full generation over
 * the campaign prompt with no record of where the block stopped, so the
 * likeliest completion was the block's own opening sentence. Once per
 * "hello".
 *
 * So the fix is a turn CLASS, read in the main loop between the user
 * turn being committed and the language model being called: an
 * attention check is answered from the position the pipeline already
 * computed, never by the model.
 *
 * SECTIONS
 *   A  the vocabulary boundary — the whole safety case, asserted both ways
 *   B  one short acknowledgement, and only one per episode
 *   C  resume from the EXACT stopping point, on a confirmation
 *   D  a greeting with a real question attached is NOT an attention check
 *   E  a background voice never enters the flow
 *   F  backchannel, unchanged
 *   G  a meaningful interruption, unchanged
 *   H  already-heard text is never spoken twice
 *   I  normal conversation continues afterwards
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the
 * conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline, isAttentionCheck } = await import(
  "../../core/session/conversation-pipeline"
);
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
// THE HARNESS
//
// The same shape `conversation-continuity-tests.ts` uses, and for the
// same reason: audio is MULAW/8000, where one byte is one sample, so a
// clip's real-time duration is exactly `bytes / 8` ms — which is what
// lets a test say "interrupt 900ms into the reply" and mean it.
// ═════════════════════════════════════════════════════════════════

/** Speech rate used to size a fake clip. ~22 chars/second is ordinary speech. */
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
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  /** Feed one transcript segment, exactly as the streaming STT would. */
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  /**
   * A voice the transport's energy VAD does NOT corroborate as the
   * near-end caller — a television, a second person in the room. Driven
   * through the confidence floor, which is one of the two independent
   * gates `interruptionCorroborated` applies. Untouched by this fix.
   */
  sayBackground(text: string): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /** Committed conversation, system turn excluded — what the model is shown. */
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  /** Monotonic stream clock for segment timestamps, in ms. */
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
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event. Not a
      // conversational request, so it consumes no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
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
    // Batch-only, like Cartesia and Smallest AI — the production shape.
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
    "attention-test" as SessionId,
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

  const push = (text: string, isFinal: boolean, isSpeechFinal: boolean, confidence: number): void => {
    const startedAtMs = clockMs;
    clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
    segments.push({
      text,
      isFinal,
      isSpeechFinal,
      confidence,
      language: SupportedLanguage.ENGLISH,
      startedAtMs,
      endedAtMs: clockMs,
    });
    waiters.shift()?.();
  };

  return {
    record,
    requests,
    synthesized,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      push(text, isFinal, opts?.isSpeechFinal ?? isFinal, 0.95);
    },
    sayBackground(text) {
      push(text, true, true, 0.2);
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
    history() {
      return record.memory.history().filter((turn) => turn.role !== "system");
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

/** The fixed English acknowledgement, as the pipeline speaks it. */
const ACK = "Hello, can you hear me?";

/** How many times the acknowledgement was actually SPOKEN. */
function ackCount(synthesized: readonly string[]): number {
  return synthesized.filter((text) => text.includes("can you hear me")).length;
}

// The approved script's own shape: an opening the caller has already
// heard, then a block long enough that a caller can interrupt the
// middle of it. Sized so one block is ~5s of audio.
const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK_SENTENCE_1 = "Actually, I am calling you with a very interesting invitation.";
const BLOCK_SENTENCE_2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const BLOCK_SENTENCE_3 =
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${BLOCK_SENTENCE_1} ${BLOCK_SENTENCE_2} ${BLOCK_SENTENCE_3}`;

/**
 * Drives the call to the exact production moment: the agent is a
 * sentence into its block, and the caller cuts in.
 */
async function upToMidBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(900);
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the vocabulary boundary (the whole safety case)");
//
// `isAttentionCheck` decides whether a turn is answered from the held
// script position or by the language model. Both sides of that line are
// asserted directly, because a table is only safe if a future widening
// of it trips a test rather than a live call.
// ═════════════════════════════════════════════════════════════════

await test("A1 — a bare presence check IS an attention check", () => {
  for (const text of [
    "Hello?",
    "hello hello",
    "Hello? Hello? Hello?",
    "Hello, can you hear me?",
    "Can you hear me?",
    "Are you there?",
    "hello are you there",
    "Hello, are you still there?",
    "Is anyone there?",
    "hi",
    "Hey?",
    "Hello ji",
    "Suniye?",
    "Hello, aap sun rahe hain?",
    "sunai de raha hai?",
    "आप सुन रहे हैं?",
    "हैलो, सुनिए",
  ]) {
    assert.equal(isAttentionCheck(text), true, `should be an attention check: ${JSON.stringify(text)}`);
  }
});

await test("A2 — a greeting with CONTENT attached is NOT an attention check", () => {
  for (const text of [
    "Hello? What is this about?",
    "Hello, who are you?",
    "Hello, what company is this?",
    "Hello, I don't want this.",
    "Hello, can you call me later?",
    "Hi, how much does it cost?",
    "Hello? Can you explain that?",
    "Wait, what did you say?",
    "hello no",
    "Hello, can you hear me talking about the price?",
    "haan bataiye",
    "नमस्ते, यह क्या है?",
  ]) {
    assert.equal(isAttentionCheck(text), false, `must NOT be an attention check: ${JSON.stringify(text)}`);
  }
});

await test("A3 — a bare backchannel is NOT an attention check", () => {
  // Backchannel classification is a separate, untouched mechanism
  // (`isBareAcknowledgement`). These must never be routed through the
  // attention path, or an "okay" would resume the script out of turn.
  for (const text of ["okay", "ok ok", "right", "hmm", "got it", "achha", "bilkul", "sure"]) {
    assert.equal(isAttentionCheck(text), false, `must NOT be an attention check: ${JSON.stringify(text)}`);
  }
});

await test("A4 — empty and whitespace are not attention checks", () => {
  assert.equal(isAttentionCheck(""), false);
  assert.equal(isAttentionCheck("   "), false);
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — ONE short acknowledgement, once per episode");
// ═════════════════════════════════════════════════════════════════

await test('B1 — a single "Hello?" mid-block gets one short acknowledgement, with NO language-model request', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await upToMidBlock(h);
    const requestsBefore = h.requests.length;

    h.say("Hello?");
    await h.waitForReplies(3);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken[2], ACK, `expected the fixed acknowledgement, got ${JSON.stringify(spoken[2])}`);
    // THE POINT: the acknowledgement is not a generated reply, so it
    // cannot regenerate a line of the campaign script.
    assert.equal(
      h.requests.length,
      requestsBefore,
      "the attention check must not reach the language model",
    );
  } finally {
    await h.stop();
  }
});

await test("B2 — the acknowledgement is SHORT", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "X"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    const ack = assistantTexts(h.history())[2] ?? "";
    assert.ok(ack.length <= 60, `the acknowledgement must be short, got ${ack.length} chars`);
    assert.ok(ack.length < BLOCK_SENTENCE_1.length, "shorter than a single script sentence");
  } finally {
    await h.stop();
  }
});

await test('B3 — "Hello? Hello? Hello?" produces exactly ONE acknowledgement', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "R2", "R3", "R4"] });
  try {
    await upToMidBlock(h);

    h.say("Hello?");
    await sleep(1500);
    h.say("Hello?");
    await sleep(1500);
    h.say("Hello?");
    await sleep(2500);

    assert.equal(
      ackCount(h.synthesized),
      1,
      `the acknowledgement must be spoken exactly once, spoken=${JSON.stringify(h.synthesized)}`,
    );
    const committedAcks = assistantTexts(h.history()).filter((t) => t.includes("can you hear me")).length;
    assert.equal(committedAcks, 1, "and committed exactly once");
  } finally {
    await h.stop();
  }
});

await test("B4 — a repeated hello NEVER re-speaks the campaign opening", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "R2", "R3", "R4"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await sleep(1500);
    h.say("Hello?");
    await sleep(1500);
    h.say("Hello?");
    await sleep(2500);

    const openings = h.synthesized.filter((t) => t === OPENING).length;
    assert.equal(openings, 1, `the opening line must be spoken exactly once, got ${openings}`);
    const firstSentences = h.synthesized.filter((t) => t.startsWith("Actually, I am calling you")).length;
    assert.equal(firstSentences, 1, `the block's first sentence must be spoken exactly once, got ${firstSentences}`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — resume from the EXACT point the reply stopped");
// ═════════════════════════════════════════════════════════════════

await test('C1 — "Yes, I can hear you." resumes the block, without a language-model request', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    const requestsAfterAck = h.requests.length;

    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);

    const resumed = assistantTexts(h.history())[3] ?? "";
    assert.ok(
      resumed.startsWith("We have created Flexi Genie"),
      `must resume at the exact stopping point, got ${JSON.stringify(resumed.slice(0, 80))}`,
    );
    assert.ok(
      !resumed.includes("Actually, I am calling you"),
      "must NOT repeat the sentence the caller already heard",
    );
    assert.equal(
      h.requests.length,
      requestsAfterAck,
      "the resume must not reach the language model — it is text already generated for this caller",
    );
  } finally {
    await h.stop();
  }
});

await test('C2 — a bare "Haan" after the acknowledgement resumes too', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Haan");
    await h.waitForReplies(4);

    const resumed = assistantTexts(h.history())[3] ?? "";
    assert.ok(
      resumed.startsWith("We have created Flexi Genie"),
      `must resume at the stopping point, got ${JSON.stringify(resumed.slice(0, 80))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("C3 — a SECOND hello resumes rather than acknowledging again", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Hello?");
    await h.waitForReplies(4);

    const resumed = assistantTexts(h.history())[3] ?? "";
    assert.ok(
      resumed.startsWith("We have created Flexi Genie"),
      `the second hello must resume, got ${JSON.stringify(resumed.slice(0, 80))}`,
    );
    assert.equal(ackCount(h.synthesized), 1, "and must not acknowledge a second time");
  } finally {
    await h.stop();
  }
});

await test("C4 — the resumed text is in the history the model is next shown", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "A contextual answer."] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);

    // A real question now — the model must be able to see everything
    // that has been said, or it has no way to know not to say it again.
    h.say("What is the date?");
    await h.waitFor("the contextual reply", () => h.requests.length >= 2, 15000);
    const shown = (h.requests[h.requests.length - 1] ?? [])
      .filter((t) => t.role === "assistant")
      .map((t) => t.content);
    assert.ok(shown.includes(OPENING), "the model must still be shown its own opening line");
    assert.ok(
      shown.some((t) => t.startsWith("Actually, I am calling you")),
      "and the part of the block the caller heard before the interruption",
    );
    assert.ok(
      shown.some((t) => t.startsWith("We have created Flexi Genie")),
      "and the part it resumed with",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — a greeting with a real question is NOT an attention check");
// ═════════════════════════════════════════════════════════════════

await test('D1 — "Hello? What is this about?" is answered contextually, not acknowledged', async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, "It is about a free live session where you can see Flexi Genie build a funnel."],
  });
  try {
    await upToMidBlock(h);
    const requestsBefore = h.requests.length;

    h.say("Hello? What is this about?");
    await h.waitForReplies(3);

    assert.equal(h.requests.length, requestsBefore + 1, "the real question must reach the language model");
    const reply = assistantTexts(h.history())[2] ?? "";
    assert.ok(reply.startsWith("It is about a free live session"), `expected the contextual answer, got ${JSON.stringify(reply)}`);
    assert.equal(ackCount(h.synthesized), 0, "and no attention acknowledgement is spoken");
  } finally {
    await h.stop();
  }
});

await test("D2 — a real question RELEASES the held script position", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "It is about a live session.", "R3"] });
  try {
    await upToMidBlock(h);
    h.say("Hello? What is this about?");
    await h.waitForReplies(3);

    // The conversation has moved on. A later bare "hello" must not
    // resurrect a remainder from before that question.
    h.say("Hello?");
    await sleep(2500);
    const spokenAfter = h.synthesized.slice(h.synthesized.indexOf("It is about a live session.") + 1);
    assert.ok(
      !spokenAfter.some((t) => t.startsWith("We have created Flexi Genie")),
      `a stale remainder must never be spoken into a conversation that moved on, got ${JSON.stringify(spokenAfter)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — a background voice never enters the flow (UNCHANGED)");
// ═════════════════════════════════════════════════════════════════

await test("E1 — an uncorroborated background hello produces no attention response and no turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-HAPPEN"] });
  try {
    await upToMidBlock(h);
    const requestsBefore = h.requests.length;

    h.sayBackground("hello");
    await sleep(3000);

    assert.equal(ackCount(h.synthesized), 0, "a background voice must not trigger the attention flow");
    assert.equal(h.requests.length, requestsBefore, "and must not produce a turn");
    const users = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(users, ["Yes, tell me."], `no user turn may be created, got ${JSON.stringify(users)}`);
  } finally {
    await h.stop();
  }
});

await test("E2 — the assistant finishes its block through a background hello", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "X"] });
  try {
    await upToMidBlock(h);
    h.sayBackground("hello");
    await h.waitForReplies(2);
    const committed = assistantTexts(h.history())[1] ?? "";
    assert.ok(committed.includes("plain instructions"), `the whole block must be committed, got ${JSON.stringify(committed.slice(-60))}`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — backchannel, unchanged");
// ═════════════════════════════════════════════════════════════════

await test('F1 — "okay" over a long reply is still absorbed: no turn, no acknowledgement', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-HAPPEN"] });
  try {
    await upToMidBlock(h);
    const requestsBefore = h.requests.length;

    h.say("okay");
    await h.waitForReplies(2);

    assert.equal(ackCount(h.synthesized), 0, "a backchannel must not trigger the attention flow");
    assert.equal(h.requests.length, requestsBefore, "and must not produce a turn");
    const committed = assistantTexts(h.history())[1] ?? "";
    assert.ok(committed.includes("plain instructions"), "the assistant finishes its sentence, exactly as before");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION G — a meaningful interruption, unchanged");
// ═════════════════════════════════════════════════════════════════

await test("G1 — a real interruption still barges in and is answered by the model", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "I'm Rohan, calling from Team FlexiFunnels."] });
  try {
    await upToMidBlock(h);
    const requestsBefore = h.requests.length;

    h.say("Wait, who are you?");
    await h.waitForReplies(3);

    assert.equal(h.requests.length, requestsBefore + 1, "a real interruption reaches the language model");
    assert.equal(ackCount(h.synthesized), 0, "and never produces an attention acknowledgement");
    const reply = assistantTexts(h.history())[2] ?? "";
    assert.ok(reply.startsWith("I'm Rohan"), `expected the contextual answer, got ${JSON.stringify(reply)}`);
  } finally {
    await h.stop();
  }
});

await test("G2 — only the part of the block the caller HEARD is committed (unchanged)", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Answer."] });
  try {
    await upToMidBlock(h);
    h.say("Wait, who are you?");
    await h.waitForReplies(3);

    const committed = assistantTexts(h.history())[1] ?? "";
    assert.ok(committed.length > 0, "what the caller heard must be committed");
    assert.ok(
      committed.length < BLOCK.length,
      `the unplayed remainder must NOT be committed: ${committed.length} of ${BLOCK.length} chars`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION H — already-heard text is never spoken twice");
// ═════════════════════════════════════════════════════════════════

await test("H1 — no sentence the caller has heard is ever synthesized a second time", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "R2", "R3"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);
    await sleep(500);

    // Every distinct piece of speech, counted. The transport dropped the
    // queued remainder at the barge-in, so a sentence appearing twice
    // here would be one the caller genuinely heard twice.
    const heard = h.synthesized.filter((t) => t.length > 0);
    const played = heard.slice(0, 2); // opening + the sentence that played before the barge-in
    for (const text of played) {
      const later = heard.slice(2).filter((t) => t === text).length;
      assert.equal(later, 0, `already-heard text was spoken again: ${JSON.stringify(text)}`);
    }
    assert.equal(
      heard.filter((t) => t === OPENING).length,
      1,
      "the opening line is spoken exactly once for the whole call",
    );
  } finally {
    await h.stop();
  }
});

await test("H2 — the resume is a strict suffix of the interrupted reply", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "R2"] });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);

    const heardBefore = assistantTexts(h.history())[1] ?? "";
    const resumed = assistantTexts(h.history())[3] ?? "";
    assert.ok(BLOCK.startsWith(heardBefore), "the committed prefix is a prefix of the block");
    assert.ok(BLOCK.endsWith(resumed), "and the resume is the block's own tail, verbatim");
    assert.ok(
      `${heardBefore} ${resumed}`.replace(/\s+/gu, " ") === BLOCK.replace(/\s+/gu, " "),
      "together they are the whole block, with nothing said twice and nothing lost",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION I — normal conversation continues afterwards");
// ═════════════════════════════════════════════════════════════════

await test("I1 — the call carries on normally after an attention-check episode", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, "The session is free, and it runs for about an hour."],
  });
  try {
    await upToMidBlock(h);
    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);

    h.say("Is it free?");
    await h.waitForReplies(5);

    const reply = assistantTexts(h.history())[4] ?? "";
    assert.ok(reply.startsWith("The session is free"), `expected a normal contextual reply, got ${JSON.stringify(reply)}`);
    assert.equal(h.record.state, SessionState.LISTENING, "and the session is listening again");
  } finally {
    await h.stop();
  }
});

await test("I2 — an attention check with nothing to resume takes the normal path", async () => {
  // The block finished and the caller heard all of it. There is no
  // position to carry on from, so the contextual path answers — exactly
  // as it did before this fix existed.
  const h = startHarness({ openingLine: OPENING, replies: ["Short reply.", "Yes, I'm here."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitForReplies(2);
    const requestsBefore = h.requests.length;

    h.say("Hello?");
    await h.waitForReplies(3);

    assert.equal(h.requests.length, requestsBefore + 1, "with nothing held, the model answers as before");
    assert.equal(ackCount(h.synthesized), 0, "and the fixed acknowledgement is not used");
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
