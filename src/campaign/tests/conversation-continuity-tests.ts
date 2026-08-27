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
/**
 * PHASE 2 — pause before a caller "carries on" while an earlier reply
 * is still generating, used by tests A/B/E/F/I below.
 *
 * Those tests race a follow-up fragment against a stale reply's
 * arrival: the fragment must be FED (even unfinished, see
 * `newerUserTurnWaiting`) before `replyDelayMs` elapses on the earlier
 * turn, or the stale reply is spoken before there is anything to
 * supersede it with. It was `1500`, tuned to Phase 1's turn-release
 * latency (300-600ms for the short turn-1 utterances these tests use).
 * Phase 2 collapsed that to a single evidenced window
 * (150-250ms — see `EVIDENCED_CONFIRMATION_SHORT_MS` in
 * turn-detection.ts), so a turn-1 reply is now ready ~150-350ms
 * SOONER and `1500` no longer reliably lands before it — it isn't a
 * race the pipeline is meant to lose, it is a wall-clock constant that
 * assumed the old latency. Shortened with headroom under the fastest
 * remaining case (an evidenced-short turn-1: ~150ms release +
 * `replyDelayMs` 1200ms = ~1350ms).
 */
const CARRY_ON_PAUSE_MS = 900;
const BLOCK_B =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — an interrupted block stays in the history (TEST 1, TEST 5)");
//
// ONE ASSERTION IN TEST 1 WAS RETIRED WHEN THE HELLO / ATTENTION-CHECK
// FIX LANDED. It is worth saying exactly which, and why that is not a
// weakening.
//
// TEST 1 originally asserted that a mid-block "hello" PRODUCED a
// language-model request, and then inspected that request's history for
// the opening line and the block. That was the correct shape of the
// first remedy for this defect: the model was going to be asked either
// way, so the only thing that could be fixed was WHAT IT WAS TOLD —
// hence this file's opening note about asserting "the fix at the only
// place it can be asserted honestly".
//
// The pipeline no longer asks. A bare attention check is answered from
// the script position the pipeline already computed (`unspokenTail`,
// held across the turn), so it spends no generation at all — which is a
// strictly stronger guarantee than showing the model the right history,
// because a generation that never happens cannot restate a line.
// "Hello must produce a request" was therefore an expectation about the
// old MECHANISM, not about the invariant, and the two cannot both hold.
//
// The invariant itself is unchanged and TEST 1 still owns it, now
// asserted as the property rather than the mechanism:
//
//   - the assistant content the caller HEARD stays in history;
//   - the unheard remainder is not lost — it is resumed verbatim, and
//     heard + resumed reconstruct the block exactly;
//   - no already-heard content is ever spoken a second time;
//   - a bare hello and a resume each spend ZERO generations;
//   - the next SUBSTANTIVE turn still gets its reply, and the history
//     that reply is built from still contains the opening, the heard
//     block and the resumed part — the original assertion, unweakened,
//     re-pointed at the turn that actually reaches the model.
//
// Supporting coverage, all green and none of it removed: TEST 1b (only
// the played part is committed), TEST 2 (a contextual question does not
// rewind the script), and `test:attention` C1/C3/C4/H1/H2 for the
// attention path itself.
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
    const requestsBeforeHello = h.requests.length;
    h.say("hello");
    // THREE assistant turns by the time this settles: the opening, the
    // part of the block that PLAYED before the barge-in, and the short
    // attention acknowledgement. Waiting for only two would return
    // while the acknowledgement was still being prepared, and the
    // caller's next line would then merge into the same turn.
    await h.waitForReplies(3);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken[0], OPENING);
    assert.ok(
      spoken[1]?.startsWith("Actually, I am calling you"),
      `the part of the block the caller heard must be committed, got ${JSON.stringify(spoken[1])}`,
    );
    assert.ok(
      spoken[2]?.includes("can you hear me"),
      `the hello is answered by the short attention line, got ${JSON.stringify(spoken[2])}`,
    );

    // THE INVARIANT, first half: a bare "hello" must not spend a
    // generation. This assertion REPLACES an obsolete one — see the
    // note under SECTION A. The old expectation was that the hello
    // produced an LLM request whose history contained the block; that
    // was the first remedy for this defect, and it has been superseded
    // by one that does not consult the model at all. What must never
    // regress is the CONTINUITY, not the request count, so the request
    // count is now asserted the other way round.
    assert.equal(
      h.requests.length,
      requestsBeforeHello,
      "a bare attention check must not spend a language-model generation",
    );

    // THE INVARIANT, second half: the unheard remainder was NOT lost
    // with the reply that was cancelled. The caller confirms, and the
    // block carries on from exactly where it stopped — still with no
    // generation, because this is text already produced for this caller.
    h.say("Yes, I can hear you.");
    await h.waitForReplies(4);
    const resumed = assistantTexts(h.history())[3] ?? "";
    assert.ok(
      resumed.startsWith("We have created Flexi Genie"),
      `the unheard remainder must be resumed at its exact stopping point, got ${JSON.stringify(resumed.slice(0, 80))}`,
    );
    assert.ok(
      !resumed.includes("Actually, I am calling you"),
      "and must not repeat the sentence the caller already heard",
    );
    assert.equal(
      `${spoken[1]} ${resumed}`.replace(/\s+/gu, " ").trim(),
      BLOCK_B.replace(/\s+/gu, " ").trim(),
      "the heard part and the resumed part must reconstruct the block exactly — nothing lost, nothing said twice",
    );
    assert.equal(
      h.requests.length,
      requestsBeforeHello,
      "resuming an already-generated remainder must not spend a generation either",
    );

    // THE INVARIANT, third half: the next SUBSTANTIVE turn still gets a
    // reply, and the history it is built from still contains everything
    // the agent has said. This is the original assertion, unweakened —
    // only re-pointed at the turn that actually reaches the model.
    h.say("What is the date of the session?");
    await h.waitFor("the reply to the substantive turn", () => h.requests.length >= requestsBeforeHello + 1);
    assert.equal(
      h.requests.length,
      requestsBeforeHello + 1,
      "exactly one generation for the whole episode, and it belongs to the real question",
    );
    const next = h.requests[h.requests.length - 1] ?? [];
    const shown = next.filter((t) => t.role === "assistant").map((t) => t.content);
    assert.ok(shown.includes(OPENING), "the model must still be shown its own opening line");
    assert.ok(
      shown.some((text) => text.startsWith("Actually, I am calling you")),
      `the model must be shown the block it already spoke, got ${JSON.stringify(shown)}`,
    );
    assert.ok(
      shown.some((text) => text.startsWith("We have created Flexi Genie")),
      `and the part it resumed with, got ${JSON.stringify(shown)}`,
    );

    // Already-heard content is never spoken a second time, for the
    // whole episode. The transport dropped the queued remainder at the
    // barge-in, so a repeat here would be one the caller genuinely
    // heard twice.
    assert.equal(
      h.synthesized.filter((text) => text === OPENING).length,
      1,
      "the opening line is spoken exactly once for the whole call",
    );
    assert.equal(
      h.synthesized.filter((text) => text.startsWith("Actually, I am calling you")).length,
      1,
      "and the sentence the caller heard before the interruption is spoken exactly once",
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

// ═════════════════════════════════════════════════════════════════
section("SECTION F — the caller RESUMES SPEAKING before the reply is spoken");
//
// THE DEFECT THIS SECTION EXISTS FOR.
//
// `newerUserTurnWaiting()` used to be `hasBufferedTurn()` alone — a
// turn that had fully ENDPOINTED. That is blind to the commonest shape
// of the report: the caller finishes a thought, the detector releases
// it, and while the model is still generating they carry on. Nothing
// has endpointed, so `pendingEvent` is null, so the reply to the older,
// partial thought was spoken OVER them — and their real question was
// then answered separately. Three utterances that were one thought came
// back as three isolated answers.
//
// The signal that closes it is the turn detector's pending FINAL text:
// the words it holds for an utterance in progress. It can never be the
// turn being answered (`emitTurnEnd` resets before it dispatches), and
// it is guaranteed to become a turn, so a supersession is always
// followed by a real one.
//
// Every test below drives the caller's second thought in as a Deepgram
// CHUNK-BOUNDARY final — `is_final` without `speech_final`, which is
// what a caller mid-sentence actually produces. Nothing has endpointed
// at the moment the reply would have been spoken.
// ═════════════════════════════════════════════════════════════════

await test("A — three related utterances become ONE context and ONE answer", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "STALE — answers only the ad, not the question that followed it.",
      "Yes, it is from FlexiFunnels, and the session shows how Flexi Genie builds your business.",
    ],
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    // The caller's opening thought, released as a turn.
    h.say("I just saw Saurabh sir's ad on Instagram.");
    await sleep(CARRY_ON_PAUSE_MS);
    // They carry on while the model is still generating.
    h.say("I wanted to know whether this is related to FlexiFunnels", {
      isFinal: true,
      isSpeechFinal: false,
    });
    await sleep(1200);
    h.say("and what exactly is the session about?", { isFinal: true, isSpeechFinal: true });

    await h.waitForReplies(2);
    await sleep(400);

    assert.ok(
      !h.synthesized.some((text) => text.includes("STALE")),
      `the reply to the partial thought must never be spoken, got ${JSON.stringify(h.synthesized)}`,
    );

    // ONE answer, not one per utterance.
    const spoken = assistantTexts(h.history());
    assert.equal(
      spoken.length,
      2,
      `exactly one answer should follow the opening, got ${JSON.stringify(spoken)}`,
    );

    // And it was generated from the COMBINED context: the ad, the
    // FlexiFunnels question and the session question are all present in
    // the request that produced it.
    const answering = h.requests[h.requests.length - 1] ?? [];
    const everythingTheCallerSaid = answering
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.content)
      .join(" ");
    for (const fragment of ["ad on Instagram", "related to FlexiFunnels", "session about"]) {
      assert.ok(
        everythingTheCallerSaid.includes(fragment),
        `the combined context must contain "${fragment}", got ${JSON.stringify(everythingTheCallerSaid)}`,
      );
    }
    // The NEWEST of them is the one marked as the turn to answer.
    assert.ok(
      lastUserContent(answering).includes("session about"),
      `the newest thought must be the current turn, got ${JSON.stringify(lastUserContent(answering))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("B — a newer utterance supersedes the obsolete pending reply", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["OBSOLETE.", "It is fifteen hundred rupees."],
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
      `the obsolete reply must not reach the text-to-speech provider, got ${JSON.stringify(h.synthesized)}`,
    );
    // Not committed either — the caller never heard a word of it, so it
    // is not part of the conversation the next request is built from.
    assert.ok(
      !assistantTexts(h.history()).includes("OBSOLETE."),
      "an unspoken superseded reply must never be committed to memory",
    );
  } finally {
    await h.stop();
  }
});

await test("C — an answer the caller already heard is never spoken twice", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK_B, "Sure, ask away.", "It is on Sunday at 11 am."],
    replyDelayMs: 60,
  });
  try {
    await h.waitForReplies(1);
    h.say("Tell me about it.");
    await h.waitForReplies(2);
    h.say("I have a question.");
    await h.waitForReplies(3);

    // BLOCK_B is three sentences, so it is synthesized as three chunks;
    // counting its FIRST sentence is what tells a re-run from chunking.
    const firstSentence = "Actually, I am calling you with a very interesting invitation.";
    const occurrences = h.synthesized.filter((text) => text.includes(firstSentence)).length;
    assert.equal(
      occurrences,
      1,
      `the block must be spoken exactly once, got ${JSON.stringify(h.synthesized)}`,
    );

    // The model is SHOWN what it already said, which is what makes "do
    // not repeat it" an actionable instruction rather than a wish.
    const latest = h.requests[h.requests.length - 1] ?? [];
    const alreadySaid = latest
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.content)
      .join(" ");
    assert.ok(
      alreadySaid.includes(firstSentence),
      "the block the caller already heard must be in the history the model is given",
    );
  } finally {
    await h.stop();
  }
});

for (const ack of ["Hello.", "Hi.", "Okay.", "Haan."]) {
  await test(`D — "${ack}" while the agent is thinking does not cancel or restart anything`, async () => {
    const h = startHarness({
      openingLine: OPENING,
      replies: ["The session is this Sunday at 11 am.", "SHOULD-NOT-BE-NEEDED"],
      replyDelayMs: 1200,
    });
    try {
      await h.waitForReplies(1);

      h.say("When is the session?");
      await sleep(1500);
      // A bare acknowledgement lands while the model is generating. It
      // is the caller showing they are listening, not a new
      // contribution, so the reply must still be spoken — and the
      // opening must not be spoken again.
      h.say(ack, { isFinal: true, isSpeechFinal: false });

      await h.waitForReplies(2);
      await sleep(400);

      assert.ok(
        h.synthesized.includes("The session is this Sunday at 11 am."),
        `the reply must survive "${ack}", got ${JSON.stringify(h.synthesized)}`,
      );
      assert.equal(
        h.synthesized.filter((text) => text === OPENING).length,
        1,
        `"${ack}" must not make the agent introduce itself again, got ${JSON.stringify(h.synthesized)}`,
      );
    } finally {
      await h.stop();
    }
  });
}

await test("E — after a supersession the agent resumes from where it was, not from the top", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK_B, "STALE.", "No coding needed, and as I was saying, it writes your emails too."],
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);
    h.say("Tell me about it.");
    await h.waitForReplies(2);

    h.say("Is it hard to use?");
    await sleep(CARRY_ON_PAUSE_MS);
    h.say("I mean do I need to know coding", { isFinal: true, isSpeechFinal: false });
    await sleep(1200);
    h.say("for it?", { isFinal: true, isSpeechFinal: true });

    await h.waitForReplies(3);
    await sleep(400);

    // The reply to the half-asked question never reached the caller...
    assert.ok(
      !h.synthesized.includes("STALE."),
      `the superseded reply must not be spoken, got ${JSON.stringify(h.synthesized)}`,
    );

    // ...and the block the caller heard is still in the history the model is
    // shown, so "carry on from where you were" is a statement about
    // something it can see. That is the whole mechanism behind "do not
    // restart the script".
    const answering = h.requests[h.requests.length - 1] ?? [];
    const alreadySaid = answering
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.content)
      .join(" ");
    assert.ok(
      alreadySaid.includes("Flexi Genie"),
      "the script position the agent reached must still be in its history",
    );
    assert.equal(
      h.synthesized.filter((text) => text === OPENING).length,
      1,
      `the opening must not be spoken a second time, got ${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

await test("F — a contextual question is answered, not talked over by the scripted line", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "SCRIPTED CONTINUATION — answers nothing the caller asked.",
      "It is free, and it runs for about an hour.",
    ],
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    h.say("Okay tell me more.");
    await sleep(CARRY_ON_PAUSE_MS);
    // The real question arrives while the scripted continuation is
    // still being generated.
    h.say("Actually is there any fee", { isFinal: true, isSpeechFinal: false });
    await sleep(1200);
    h.say("and how long is it?", { isFinal: true, isSpeechFinal: true });

    await h.waitForReplies(2);
    await sleep(400);

    assert.ok(
      !h.synthesized.some((text) => text.includes("SCRIPTED CONTINUATION")),
      `the scripted line must not be spoken over the question, got ${JSON.stringify(h.synthesized)}`,
    );
    const current = lastUserContent(h.requests[h.requests.length - 1] ?? []);
    assert.ok(
      current.includes("any fee") && current.includes("how long"),
      `both halves of the question must be the current context, got ${JSON.stringify(current)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION G — the protected systems, asserted unchanged");
// ═════════════════════════════════════════════════════════════════

await test("G — FINAL_YES and FINAL_NO still read the same way", () => {
  // A supersession leaves TWO consecutive caller turns with no agent
  // turn between them — the same shape a barge-in leaves. The gate must
  // read that exactly as it does today.
  assert.equal(
    definitiveAnswerIn(
      [
        agentTurn("So, would you be interested to attend?"),
        callerTurn("I just saw the ad."),
        callerTurn("Haan, yes, I will attend."),
        agentTurn("Perfect! I will get your registration done."),
      ],
      "registration",
    ),
    "FINAL_YES",
  );
  assert.equal(
    definitiveAnswerIn(
      [
        agentTurn("So, would you be interested to attend?"),
        callerTurn("No, I am not interested."),
        agentTurn("No problem at all, thank you for your time."),
      ],
      "registration",
    ),
    "FINAL_NO",
  );
  // And an unanswered gate is still not an answer.
  assert.equal(
    definitiveAnswerIn([agentTurn("So, would you be interested to attend?")], "registration"),
    undefined,
  );
});

await test("H — the Google Sheets FINAL_YES gate is the same decision", async () => {
  const { isFinalYes } = await import("../integrations/final-yes-sheet");
  const confirmed = {
    outcomeType: "registered_confirmed",
    succeeded: true,
    primaryReason: "confirmed_at_gate",
    classifier: "test",
    schemaVersion: 1,
    detail: {
      confidence: "high",
      campaignType: "registration",
      customerTurns: 2,
      assistantTurns: 2,
      signals: [],
      explanation: "test",
    },
  };
  assert.equal(isFinalYes(confirmed as never, "FINAL_YES"), true, "a real registration still writes");
  assert.equal(isFinalYes(confirmed as never, "FINAL_NO"), false, "a refusal never writes");
  assert.equal(isFinalYes(undefined, "FINAL_YES"), false, "an unclassified call never writes");
  assert.equal(
    isFinalYes({ ...confirmed, primaryReason: "asked_a_question" } as never, "FINAL_YES"),
    false,
    "a question at the gate is not a confirmation",
  );
});

await test("I — a supersession never strands the call: the agent keeps answering", async () => {
  const states: string[] = [];
  const h = startHarness({
    openingLine: OPENING,
    replies: ["STALE ONE.", "ANSWER ONE.", "ANSWER TWO."],
    replyDelayMs: 1200,
  });
  try {
    await h.waitForReplies(1);

    // Supersede a reply...
    h.say("What is it about?");
    await sleep(CARRY_ON_PAUSE_MS);
    h.say("I mean what is the session about", { isFinal: true, isSpeechFinal: false });
    await sleep(1200);
    h.say("exactly?", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2);
    states.push(h.record.state);

    // ...and the call must still be a working conversation afterwards.
    h.say("And who is it for?");
    await h.waitForReplies(3);
    states.push(h.record.state);

    assert.deepEqual(
      states,
      [SessionState.LISTENING, SessionState.LISTENING],
      "the session must return to LISTENING after every turn",
    );
    assert.ok(
      h.synthesized.includes("ANSWER ONE.") && h.synthesized.includes("ANSWER TWO."),
      `both later answers must be spoken, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.ok(
      !h.synthesized.includes("STALE ONE."),
      "the superseded reply is still the only thing dropped",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — the caller's PICKUP ACKNOWLEDGEMENT is not a turn (FIX A)");
//
// THE DEFECT. The STT listener starts BEFORE the fixed opening line (a
// deliberate latency fix), and its segments are fed to the turn
// detector unchanged — only barge-in is gated on `greetingDone`. So the
// "Hello" a caller says as they lift the handset was released by the
// detector while our opening line was still playing, held in
// `AdaptiveTurnDetector.pendingEvent` because nobody was subscribed
// yet, and handed to the main loop's FIRST `onTurnEnd` subscription as
// the call's first user turn. It reached the language model and was
// answered conversationally — "Hi! How can I help you?" — immediately
// after our own opening line. `handleAttentionCheck` could not catch
// it: that path only answers a turn itself when a barge-in left an
// unheard script remainder, and nothing had been interrupted.
//
// WHAT IS ASSERTED HERE is the property, not the mechanism: for a
// pickup acknowledgement the language model is never asked (F1-F3, F5),
// nothing but the opening line is ever synthesized (F1, F2), and no
// user turn is committed (F1, F3, F5).
//
// AND THE BOUNDARY, which is the whole safety case. F4: "Hello? Who is
// this?" during the opening carries a real question and MUST still be
// answered after it. F6: a bare "hello" said AFTER the opening has
// finished is untouched by this and keeps exactly today's behaviour —
// the allowance is spent by the first turn whatever it is, so at most
// one turn per call can ever be dropped. F7: a call where the caller
// stays quiet through the opening is byte-for-byte the call it was.
//
// Nothing in `turn-detection.ts` is involved: every window, threshold
// and release guard is untouched, and these tests deliberately do not
// assert any timing.
// ═════════════════════════════════════════════════════════════════

await test("F1 — a bare \"Hello\" as the caller picks up is not a conversational turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["SHOULD-NOT-BE-GENERATED"] });
  try {
    // Said the instant the line opens, before the opening line can even
    // start — the phone-answer reflex this fix is about.
    h.say("Hello");
    await h.waitForReplies(1);
    // Long enough for the buffered turn to be delivered to the main
    // loop's first subscription and acted on.
    await sleep(300);

    assert.equal(
      h.requests.length,
      0,
      `a pickup "Hello" must not reach the language model, got ${JSON.stringify(h.requests.map(lastUserContent))}`,
    );
    assert.deepEqual(
      h.synthesized,
      [OPENING],
      `nothing but the opening line may be spoken, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING],
      "the opening line must be spoken exactly once",
    );
    assert.equal(
      h.history().filter((turn) => turn.role === "user").length,
      0,
      `a pickup "Hello" must not be committed to history, got ${JSON.stringify(h.history().map((t) => `${t.role}:${t.content}`))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("F2 — a \"Hello\" landing while the opening line is PLAYING leaves the opening exactly once", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["SHOULD-NOT-BE-GENERATED"] });
  try {
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    h.say("Hello");
    await h.waitForReplies(1);
    await sleep(300);

    assert.equal(
      h.synthesized.filter((text) => text === OPENING).length,
      1,
      `the opening line must be spoken exactly once, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(h.requests.length, 0, "a pickup \"Hello\" must not reach the language model");
  } finally {
    await h.stop();
  }
});

// The whole vocabulary, both scripts. Every one of these is the WHOLE
// utterance — which is what makes it an acknowledgement rather than a
// contribution (see F4 for the other side of that line).
for (const pickup of ["Hello", "hello hello", "Hi", "Haan.", "Okay.", "Ji haan", "नमस्ते"]) {
  await test(`F3 — "${pickup}" on pickup is dropped: no request, no reply, no history`, async () => {
    const h = startHarness({ openingLine: OPENING, replies: ["SHOULD-NOT-BE-GENERATED"] });
    try {
      h.say(pickup);
      await h.waitForReplies(1);
      await sleep(300);

      assert.equal(h.requests.length, 0, `"${pickup}" must not reach the language model`);
      assert.deepEqual(
        h.synthesized,
        [OPENING],
        `"${pickup}" must produce no speech of its own, got ${JSON.stringify(h.synthesized)}`,
      );
      assert.equal(
        h.history().filter((turn) => turn.role === "user").length,
        0,
        `"${pickup}" must not be committed to history`,
      );
    } finally {
      await h.stop();
    }
  });
}

await test("F4 — \"Hello? Who is this?\" during the opening IS a real turn and is answered after it", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["It is about the free AI workshop this Sunday."],
  });
  try {
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    // A greeting with a real question attached to it. The greeting half
    // is identical to F1's whole utterance; the question is what makes
    // this a contribution, and dropping it would be the fix eating a
    // real turn.
    h.say("Hello? Who is this?");
    await h.waitForReplies(2);

    assert.equal(
      h.requests.length,
      1,
      "a greeting with content attached must be answered by the normal contextual path",
    );
    assert.ok(
      lastUserContent(h.requests[0] ?? []).includes("Who is this"),
      `the model must be given the caller's actual question, got ${JSON.stringify(lastUserContent(h.requests[0] ?? []))}`,
    );
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING, "It is about the free AI workshop this Sunday."],
      "the buffered turn must be answered once the opening line finishes",
    );
  } finally {
    await h.stop();
  }
});

await test("F5 — the allowance is spent once: the caller's real first answer is answered normally", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure, let me tell you."] });
  try {
    h.say("Hello");
    await h.waitForReplies(1);
    await sleep(300);
    // The answer they actually give once they have heard the opening.
    h.say("Yes, tell me.", { isSpeechFinal: true });
    await h.waitForReplies(2);

    assert.equal(
      h.requests.length,
      1,
      `exactly one language-model request for the one real turn, got ${JSON.stringify(h.requests.map(lastUserContent))}`,
    );
    assert.ok(
      lastUserContent(h.requests[0] ?? []).includes("Yes, tell me."),
      `the request must be for the real answer, not the pickup "Hello", got ${JSON.stringify(lastUserContent(h.requests[0] ?? []))}`,
    );
    assert.deepEqual(
      h.history().filter((turn) => turn.role === "user").map((turn) => turn.content),
      ["Yes, tell me."],
      "the pickup \"Hello\" is gone and the real answer is the only user turn",
    );
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING, "Sure, let me tell you."],
      "the opening line, then one reply — nothing else",
    );
  } finally {
    await h.stop();
  }
});

await test("F6 — a bare \"hello\" AFTER the opening has finished keeps exactly today's behaviour", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Yes, I am here."] });
  try {
    // Nothing said during the opening, so no allowance was ever set.
    await h.waitForReplies(1);
    h.say("hello", { isSpeechFinal: true });
    await h.waitForReplies(2);

    assert.equal(
      h.requests.length,
      1,
      "a hello outside the opening phase is a turn like any other and is answered as it is today",
    );
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING, "Yes, I am here."],
      "and the opening line is still spoken exactly once",
    );
  } finally {
    await h.stop();
  }
});

await test("F7 — a quiet opening: the first real turn is the call it always was", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["It is this Sunday at 11 am.", "It is free."] });
  try {
    await h.waitForReplies(1);
    h.say("When is the session?", { isSpeechFinal: true });
    await h.waitForReplies(2);
    h.say("Is there any fee?", { isSpeechFinal: true });
    await h.waitForReplies(3);

    assert.equal(h.requests.length, 2, "one request per turn, exactly as before");
    assert.deepEqual(
      assistantTexts(h.history()),
      [OPENING, "It is this Sunday at 11 am.", "It is free."],
      "the opening line and both replies, in order",
    );
    assert.deepEqual(
      h.history().filter((turn) => turn.role === "user").map((turn) => turn.content),
      ["When is the session?", "Is there any fee?"],
      "both user turns committed, nothing dropped",
    );
  } finally {
    await h.stop();
  }
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
