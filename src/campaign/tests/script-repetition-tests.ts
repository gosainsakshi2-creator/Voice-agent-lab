/**
 * script-repetition-tests.ts
 *
 * THE AGENT MUST NOT REPEAT ITS SCRIPT UNLESS ASKED TO.
 *
 * Real-call audit, 2026-09-21 (60 most recent transcripts): every
 * verbatim repetition of a scripted line the pipeline itself produced
 * came from one of two places — the identity gate re-asking the opening
 * after the caller's pickup "Hello" (fixed in the identity-gate suite,
 * D10), and the language model regenerating a block after an unwanted
 * barge-in (the turn-aggregation and barge-in suites). Nothing else in
 * the pipeline re-speaks script text on its own: the RESUME / REPEAT
 * branches of `handleAttentionCheck` speak an interrupted reply only
 * inside an open hearing episode, and `recoverFromSilence` resumes a
 * held remainder only after a barge-in left one.
 *
 * This suite pins that boundary from both sides, with the real
 * `ConversationPipeline` and fakes for the four vendors:
 *
 *   NO repetition   — a "hello", an ordinary answer, and a fragmented
 *                     answer after a completed block: the block is never
 *                     re-synthesised by any fixed path, and the model is
 *                     asked ONCE with the completed block in its history
 *                     (the record it needs in order not to repeat it).
 *   Repetition OK   — "Can you repeat that?" / "I didn't hear you." after
 *                     a cut-off block: the REPEAT branch speaks the full
 *                     reply again, from the text already generated,
 *                     with no language-model request.
 *
 * Nothing here dials, and no vendor is contacted.
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

// ─── The harness (same shape as the identity-gate suite) ───────────

const CHARS_PER_SECOND = 22;

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

const healthy = (identifier: { category: unknown; id: string }) => ({ identifier, isHealthy: true, checkedAt: new Date() });

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  replyCount(): number;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: { readonly replies: readonly string[]; readonly replyDelayMs?: number }): Harness {
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

  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
  };

  const record = new SessionRecord(
    "repetition-test" as SessionId,
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

  return {
    record,
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

// ─── Script shape ──────────────────────────────────────────────────

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK_SENTENCE_1 = "Actually, I am calling you with a very interesting invitation.";
const BLOCK_SENTENCE_2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const BLOCK_SENTENCE_3 = "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${BLOCK_SENTENCE_1} ${BLOCK_SENTENCE_2} ${BLOCK_SENTENCE_3}`;
/** What the fake model says to whatever comes after the block — deliberately nothing like the block. */
const FOLLOW_UP = "Sure, go ahead.";

/** How many synthesised texts carry the block's first sentence. */
const blockSpoken = (h: Harness): number =>
  h.synthesized.filter((t) => t.includes("very interesting invitation")).length;

/** The last user turn of a request, minus the internal per-turn note. */
function lastUserContent(history: readonly ConversationTurn[]): string {
  const userTurns = history.filter((turn) => turn.role === "user");
  return userTurns[userTurns.length - 1]?.content.split("\n").pop() ?? "";
}

/** Drive the call through the opening and one COMPLETED block. */
async function throughOneBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitForReplies(2);
  assert.equal(blockSpoken(h), 1, "the block was spoken once, in full");
  assert.equal(h.requests.length, 1, "one request produced it");
}

/** Drive the call to a sentence into the block, and cut it with a "Hello?". */
async function cutMidBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(900);
  h.say("Hello?");
  await h.waitFor(
    "the hearing acknowledgement",
    () => h.synthesized.some((t) => t.includes("can you hear me")),
  );
  await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
}

// ═════════════════════════════════════════════════════════════════
section("A. NO REPETITION — the block is never re-spoken by the pipeline unasked");
// ═════════════════════════════════════════════════════════════════

await test("A1. a bare 'Hello.' after a completed block: not replayed, and the model is asked once WITH the block on record", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP, FOLLOW_UP] });
  try {
    await throughOneBlock(h);
    h.say("Hello.");
    await h.waitForReplies(3);
    assert.equal(blockSpoken(h), 1, "the block must not be synthesised a second time");
    assert.equal(h.requests.length, 2, "exactly one further request, for the hello");
    const shown = h.requests[1]!;
    assert.ok(
      shown.some((t) => t.role === "assistant" && t.content.includes("very interesting invitation")),
      "the completed block is in the history the model sees — the record it needs to not repeat it",
    );
    assert.equal(lastUserContent(shown), "Hello.");
    assert.ok(h.synthesized.includes(FOLLOW_UP), "what is spoken is the model's reply to the hello");
  } finally {
    await h.stop();
  }
});

await test("A2. a normal answer after a completed block: one reply, no replay", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await throughOneBlock(h);
    h.say("I have a small shop in Pune.");
    await h.waitForReplies(3);
    assert.equal(blockSpoken(h), 1);
    assert.equal(h.requests.length, 2);
    assert.equal(lastUserContent(h.requests[1]!), "I have a small shop in Pune.");
  } finally {
    await h.stop();
  }
});

await test("A3. a FRAGMENTED answer (chunk-boundary finals) after a block: one turn, one reply, no replay", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await throughOneBlock(h);
    // Deepgram closing chunks mid-utterance: finals the provider did NOT
    // endpoint, then the endpointed one.
    h.say("I want to", { isFinal: true, isSpeechFinal: false });
    await sleep(150);
    h.say("know more", { isFinal: true, isSpeechFinal: false });
    await sleep(150);
    h.say("about it.", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(3);
    assert.equal(blockSpoken(h), 1, "fragmentation must not cause a replay");
    assert.equal(h.requests.length, 2, "the fragments became ONE turn and ONE request");
    assert.equal(lastUserContent(h.requests[1]!), "I want to know more about it.");
  } finally {
    await h.stop();
  }
});

await test("A4. a slow caller after a completed block: silence alone never replays the block", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await throughOneBlock(h);
    await sleep(2500);
    assert.equal(blockSpoken(h), 1, "nothing was re-spoken into the silence");
    assert.equal(h.requests.length, 1, "and nothing was regenerated");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. REPETITION ON REQUEST — the caller asks, and the cut-off reply is said again");
// ═════════════════════════════════════════════════════════════════

await test("B1. 'Can you repeat that?' after a cut-off block repeats it in full, with NO language-model request", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await cutMidBlock(h);
    const requestsBefore = h.requests.length;
    h.say("Can you repeat that?");
    await h.waitFor("the block to be repeated", () => blockSpoken(h) >= 2);
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    assert.equal(h.requests.length, requestsBefore, "the repeat is spoken from the text already generated");
    assert.ok(
      h.synthesized.some((t) => t.includes("very interesting invitation") && t.includes("plain instructions")),
      "the WHOLE reply is repeated from its first word",
    );
  } finally {
    await h.stop();
  }
});

await test("B2. 'I didn't hear you.' after a cut-off block repeats it the same way", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await cutMidBlock(h);
    const requestsBefore = h.requests.length;
    h.say("I didn't hear you.");
    await h.waitFor("the block to be repeated", () => blockSpoken(h) >= 2);
    assert.equal(h.requests.length, requestsBefore, "no language-model request");
  } finally {
    await h.stop();
  }
});

await test("B3. ...but a hearing CONFIRMATION resumes from where it stopped rather than repeating", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await cutMidBlock(h);
    const requestsBefore = h.requests.length;
    h.say("Yes, I can hear you.");
    await h.waitFor("the remainder to be resumed", () => h.synthesized.some((t) => t.includes("plain instructions")));
    assert.equal(blockSpoken(h), 1, "the first sentence — already heard — is not said again");
    assert.equal(h.requests.length, requestsBefore, "no language-model request");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, Deepgram, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
