/**
 * conversation-continuity-tests.ts — `npm run test:continuity`
 *
 * THREE REPORTED CONVERSATION DEFECTS, AND THE REGISTRATION GATE THEY
 * MUST NOT DISTURB.
 *
 * 1. THE SCRIPT RESTARTED FROM THE TOP.
 *
 *    The caller says "hello" over the middle of a block and the agent
 *    introduces itself again. The mechanism was never the prompt:
 *    `conversation-policy.ts` already says "never repeat the opening
 *    line", and that instruction is unactionable when the opening line
 *    is not in the history the model is shown. A barged-in reply was
 *    CANCELLED and discarded whole — including the sentences the caller
 *    had already listened to — so the next request was built from a
 *    history in which the agent had said nothing, and regenerated the
 *    block from its first word.
 *
 *    Sections A and B assert the fix at the only place it can be
 *    asserted honestly: what the model is TOLD. The pipeline is driven
 *    for real and every `CompletionRequest` the language model receives
 *    is captured, so "the agent knows it already said this" is a
 *    statement about bytes in a request, not about a model's mood.
 *
 * 2. STALE RESPONSES ARRIVED IN A QUEUE.
 *
 *    Ask something, correct yourself, correct yourself again, and the
 *    agent answers all three in order, seconds apart. Section C asserts
 *    one current answer instead: a reply not yet spoken is superseded by
 *    the caller's newer completed turn, and the turn detector's existing
 *    merge means the correction and the thought it corrects arrive
 *    together.
 *
 * 3. THE HISTORY WINDOW DROPPED THE INTRODUCTION.
 *
 *    Section D: after six exchanges a 6-pair window no longer contained
 *    the agent's own opening, which is the other half of defect 1.
 *
 * Section E is the registration gate, unchanged and asserted to be
 * unchanged: a "yes" to the greeting is not a registration, and a "yes"
 * to the commitment question still is.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker, the conversation
 * memory and the classifier are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { definitiveAnswerIn } = await import("../dispatch/call-runner");
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
// Fakes stand in for the four vendors and nothing else. Audio is
// MULAW/8000, where one byte is one sample, so a clip's real-time
// duration is exactly `bytes / 8` ms — which is what lets a test say
// "interrupt 600ms into the reply" and mean it.
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

/**
 * A scripted call.
 *
 * `replies` is what the fake language model returns, in order — one
 * entry per request it receives. `replyDelayMs` is how long it waits
 * before its first token, which is the window a test uses to make the
 * caller say something newer while the agent is still thinking.
 */
interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  /** Feed one transcript segment, exactly as the streaming STT would. */
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  /** Wait until `predicate` holds, or fail after `timeoutMs`. */
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Wait until `n` assistant turns are committed AND the agent is listening again. */
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /** How many assistant turns are committed so far. */
  replyCount(): number;
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      // greeting plays and abandons the stream at its first event. It is
      // not a conversational request, so it is not recorded and consumes
      // no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(input.replyDelayMs ?? 10);
      if (signal?.aborted) return;
      // Word-aligned deltas, the shape a real token stream has.
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
    "continuity-test" as SessionId,
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
  // The real pipeline is handed a session that has just been answered:
  // it speaks the greeting and only then enters LISTENING. Starting in
  // LISTENING would let a test's first utterance land during the
  // greeting, which is a different scenario entirely.
  record.state = SessionState.CALLING;
  // An outbound path must exist or `waitForOutboundReady` burns 500ms
  // before the first clip. No backpressure: the fake transport is
  // instant, and `drainPlayback` is what paces the reply.
  record.outboundAudioListeners.add(() => undefined);

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
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
    requests,
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
      const waiter = waiters.shift();
      waiter?.();
    },
    async waitFor(what, predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    replyCount() {
      return record.memory.history().filter((turn) => turn.role === "assistant").length;
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

/** The last user turn of a captured request, minus the internal per-turn note. */
function lastUserContent(history: readonly ConversationTurn[]): string {
  const userTurns = history.filter((turn) => turn.role === "user");
  return userTurns[userTurns.length - 1]?.content ?? "";
}

function assistantTexts(history: readonly ConversationTurn[]): string[] {
  return history.filter((turn) => turn.role === "assistant").map((turn) => turn.content);
}

// The approved script's own shape: an opening the caller has already
// heard, then a block long enough that a caller can interrupt the
// middle of it. Sized so one block is ~5s of audio.
const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK_B =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — an interrupted block stays in the history (TEST 1, TEST 5)");
// ═════════════════════════════════════════════════════════════════

await test('TEST 1 — "hello" over the middle of a block does not erase the block from history', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK_B, "Sure, go ahead."] });
  try {
    await h.waitForReplies(1);
    assert.deepEqual(assistantTexts(h.history()), [OPENING], "the opening should be committed");

    // The caller's first reply, then the agent starts the block.
    h.say("Yes, tell me.");
    await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
    await sleep(900);

    // "hello" mid-block is a real barge-in — it is deliberately NOT in
    // the backchannel vocabulary (see `isBareAcknowledgement`), so this
    // is the exact production path that used to discard the whole block.
    h.say("hello");
    await h.waitForReplies(2);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken[0], OPENING);
    assert.ok(
      spoken[1]?.startsWith("Actually, I am calling you"),
      `the part of the block the caller heard must be committed, got ${JSON.stringify(spoken[1])}`,
    );

    // THE REGRESSION. The next request the model receives must contain
    // both — otherwise it has no way to know it already said them, and
    // starts the script again.
    await h.waitFor("the reply after the interruption", () => h.requests.length >= 2);
    const next = h.requests[h.requests.length - 1] ?? [];
    const shown = next.filter((t) => t.role === "assistant").map((t) => t.content);
    assert.ok(shown.includes(OPENING), "the model must still be shown its own opening line");
    assert.ok(
      shown.some((text) => text.startsWith("Actually, I am calling you")),
      `the model must be shown the block it already spoke, got ${JSON.stringify(shown)}`,
    );
  } finally {
    await h.stop();
  }
});

await test("TEST 1b — only the part that PLAYED is committed, never the queued remainder", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK_B, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    // Interrupt early: a batch provider has already synthesized and
    // queued the whole block by now, but only its first sentence has
    // actually played.
    await h.waitFor("the agent to start speaking", () => h.record.state === SessionState.SPEAKING);
    await sleep(700);
    h.say("hello");
    await h.waitForReplies(2);

    const committed = assistantTexts(h.history())[1] ?? "";
    assert.ok(committed.length > 0, "something the caller heard must be committed");
    assert.ok(
      committed.length < BLOCK_B.length,
      `the unplayed remainder must NOT be committed: committed ${committed.length} of ${BLOCK_B.length} chars`,
    );
  } finally {
    await h.stop();
  }
});

// One reply, ~3.3s of audio, interrupted 900ms in — so ~2.4s is still
// to play. That is deliberately BELOW the backchannel threshold, which
// makes every one of these four words a real barge-in rather than an
// ignored acknowledgement: the path that used to restart the script.
const SHORT_BLOCK = "We have created Flexi Genie, which automates your whole online business.";

for (const word of ["okay", "hi", "hello", "haan"]) {
  await test(`TEST 5 — "${word}" never resets script progress`, async () => {
    const h = startHarness({ openingLine: OPENING, replies: [SHORT_BLOCK, "Sure."] });
    try {
      await h.waitForReplies(1);
      h.say("Yes, tell me.");
      await h.waitFor("the agent to start speaking", () => h.record.state === SessionState.SPEAKING);
      await sleep(900);
      h.say(word);
      await h.waitForReplies(2);

      const spoken = assistantTexts(h.history());
      assert.equal(spoken[0], OPENING, `"${word}" must not erase the opening line`);
      assert.ok(
        spoken[1]?.startsWith("We have created Flexi Genie"),
        `after "${word}" what the caller already heard must still be in history, got ${JSON.stringify(spoken)}`,
      );

      await h.waitFor(`the reply after "${word}"`, () => h.requests.length >= 2);
      const shown = (h.requests[h.requests.length - 1] ?? [])
        .filter((t) => t.role === "assistant")
        .map((t) => t.content);
      assert.ok(
        shown.includes(OPENING),
        `after "${word}" the model must still be shown its opening line, got ${JSON.stringify(shown)}`,
      );
      assert.ok(
        shown.some((text) => text.startsWith("We have created Flexi Genie")),
        `after "${word}" the model must still be shown what it already said, got ${JSON.stringify(shown)}`,
      );
    } finally {
      await h.stop();
    }
  });
}

// ═════════════════════════════════════════════════════════════════
section("SECTION B — a contextual question does not rewind the script (TEST 2)");
// ═════════════════════════════════════════════════════════════════

await test("TEST 2 — the answer to a mid-script question is built on top of what was already said", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "We have created Flexi Genie, which helps you automate your online business.",
      "It builds funnels, pages and emails from plain instructions.",
      "So, would you be interested to attend?",
    ],
  });
  try {
    await h.waitForReplies(1);

    // Section A of the script is spoken to the end — no interruption.
    h.say("Yes, tell me.");
    await h.waitForReplies(2);
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING, "We have created Flexi Genie, which helps you automate your online business."],
      "an uninterrupted block is committed whole, exactly as before",
    );

    // The contextual question.
    h.say("Wait, what exactly does it do?");
    await h.waitForReplies(3);

    // The request that produced the ANSWER had to carry the block
    // already spoken, or the model can only start the script over.
    const answering = h.requests[h.requests.length - 1] ?? [];
    assert.ok(
      lastUserContent(answering).includes("what exactly does it do"),
      `the question must be the current turn, got ${JSON.stringify(lastUserContent(answering))}`,
    );
    const shown = answering.filter((t) => t.role === "assistant").map((t) => t.content);
    assert.deepEqual(
      shown,
      [OPENING, "We have created Flexi Genie, which helps you automate your online business."],
      "the model answers with the script's progress in front of it",
    );

    // And the answer itself is now part of the progress, so the next
    // scripted step continues rather than restarting.
    const after = assistantTexts(h.history());
    assert.equal(after.length, 3, `expected opening + block + answer, got ${JSON.stringify(after)}`);
    assert.equal(after[2], "It builds funnels, pages and emails from plain instructions.");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — one current response, not a backlog (TEST 3, TEST 4)");
// ═════════════════════════════════════════════════════════════════

await test("TEST 3 — a clarification arriving before the agent speaks produces ONE answer", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "STALE — this answers the first question only.",
      "It can build a whole website for you, yes.",
    ],
    // The model takes its time, which is the window a real caller
    // corrects themselves in.
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    h.say("What does it do?");
    // The first reply is still being generated; nothing has been spoken.
    await sleep(500);
    h.say("Actually, I mean can it build a website?");

    await h.waitForReplies(2);
    await sleep(300);

    const spoken = assistantTexts(h.history());
    assert.ok(
      !h.synthesized.some((text) => text.includes("STALE")),
      `the superseded answer must never reach the text-to-speech provider, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.deepEqual(
      spoken,
      [OPENING, "It can build a whole website for you, yes."],
      "exactly one answer, and it is the answer to the question the caller ended up asking",
    );
  } finally {
    await h.stop();
  }
});

await test("TEST 4 — a correction wins, and its context comes with it", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["STALE ANSWER.", "Yes, it automates your business end to end."],
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    h.say("What does it do?");
    await sleep(400);
    h.say("Actually, I mean can it build a website?");
    await sleep(400);
    h.say("No, I mean can it automate my business?");

    await h.waitForReplies(2);
    await sleep(300);

    const spoken = assistantTexts(h.history());
    assert.ok(
      !h.synthesized.some((text) => text.includes("STALE")),
      `no stale answer may reach the text-to-speech provider, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(
      spoken.length,
      2,
      `exactly one answer should follow the opening, got ${JSON.stringify(spoken)}`,
    );

    // The request that produced the spoken answer must carry the
    // correction — and, because the turn detector merges turns that
    // endpoint while nobody is subscribed, the thought it corrects too.
    const answering = h.requests[h.requests.length - 1] ?? [];
    const current = lastUserContent(answering);
    assert.ok(
      current.includes("automate my business"),
      `the correction must be the current context, got ${JSON.stringify(current)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — the history window holds a whole call");
// ═════════════════════════════════════════════════════════════════

await test("the opening line is still in the LLM window after ten exchanges", async () => {
  const { ConversationMemory } = await import("../../core/session/conversation-memory");
  const memory = new ConversationMemory(SupportedLanguage.ENGLISH, "SYSTEM");
  memory.recordAssistantTurn(OPENING);
  for (let i = 0; i < 10; i += 1) {
    memory.recordUserTurn(`question ${i}`, SupportedLanguage.ENGLISH);
    memory.recordAssistantTurn(`answer ${i}`);
  }
  const shown = memory.recentHistory().map((turn) => turn.content);
  assert.equal(shown[0], "SYSTEM", "the system prompt is always the first turn");
  assert.ok(
    shown.includes(OPENING),
    "the agent's own opening must still be visible ten exchanges later",
  );
});

await test("the window is still a window — it does not grow without bound", async () => {
  const { ConversationMemory } = await import("../../core/session/conversation-memory");
  const memory = new ConversationMemory(SupportedLanguage.ENGLISH, "SYSTEM");
  for (let i = 0; i < 200; i += 1) {
    memory.recordUserTurn(`u${i}`, SupportedLanguage.ENGLISH);
    memory.recordAssistantTurn(`a${i}`);
  }
  const shown = memory.recentHistory();
  assert.equal(shown.length, 41, "system turn + 20 pairs");
  assert.equal(shown[shown.length - 1]?.content, "a199", "the newest turn is always present");
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — the registration gate, unchanged (TEST 6, TEST 7)");
// ═════════════════════════════════════════════════════════════════

const agentTurn = (text: string): ConversationTurn => ({
  role: "assistant",
  content: text,
  timestamp: new Date(),
});
const callerTurn = (text: string): ConversationTurn => ({
  role: "user",
  content: text,
  timestamp: new Date(),
});

await test('TEST 6 — "Yes" to the greeting is NOT a registration', () => {
  const verdict = definitiveAnswerIn(
    [
      agentTurn("Hi Sakshi, this is Rohan from Team FlexiFunnels."),
      callerTurn("Yes."),
      agentTurn("Actually, I am calling you with a very interesting invitation."),
    ],
    "registration",
  );
  assert.notEqual(verdict, "FINAL_YES", 'a "yes" to the greeting must never register anyone');
});

await test('TEST 6b — "Yes" to a courtesy question is NOT a registration', () => {
  const verdict = definitiveAnswerIn(
    [
      agentTurn("Can I tell you in 20 seconds why I think you should attend?"),
      callerTurn("Yes."),
      agentTurn("We have created Flexi Genie, which automates your online business."),
    ],
    "registration",
  );
  assert.notEqual(verdict, "FINAL_YES", "interest is not a commitment");
});

await test('TEST 7 — "Yes" to the commitment question still registers, exactly as before', () => {
  const verdict = definitiveAnswerIn(
    [
      agentTurn("Hi Sakshi, this is Rohan from Team FlexiFunnels."),
      callerTurn("Yes."),
      agentTurn("So, would you be interested to attend?"),
      callerTurn("Yes, please."),
      agentTurn("Perfect! I will get your registration done right away."),
    ],
    "registration",
  );
  assert.equal(verdict, "FINAL_YES", "a yes at the gate is still a registration");
});

await test("TEST 7b — an interrupted gate question the caller HEARD still counts", () => {
  // This is what the fix changes, and it changes it in the safe
  // direction: the commitment question was spoken and the caller
  // answered it, so it is now in the transcript instead of being
  // discarded by the barge-in — which is the only reason this
  // registration used to be lost.
  const verdict = definitiveAnswerIn(
    [
      agentTurn("We have created Flexi Genie, which automates your online business."),
      callerTurn("Okay."),
      agentTurn("So, would you be interested to attend?"),
      callerTurn("Haan, yes."),
      agentTurn("Perfect! I will get your registration done."),
    ],
    "registration",
  );
  assert.equal(verdict, "FINAL_YES");
});

await test("a transcript whose last turn is the caller's is never a final answer", () => {
  const verdict = definitiveAnswerIn(
    [
      agentTurn("So, would you be interested to attend?"),
      callerTurn("Yes, please."),
    ],
    "registration",
  );
  assert.equal(verdict, undefined, "the agent's reply must have been spoken first");
});

// ─────────────────────────────────────────────────────────────────
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
