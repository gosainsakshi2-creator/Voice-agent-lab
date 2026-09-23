/**
 * barge-in-resume-accuracy-tests.ts — `npm run test:resume-accuracy`
 *
 * WHERE DOES THE PITCH PICK UP AFTER THE CALLER CUTS IT OFF?
 *
 * The reported defect, from a real call:
 *
 *   agent:  "I am calling you to invite you to a webinar we are…"
 *   caller: "Hello?"            (a few hundred ms in)
 *   agent:  "Hey, can you hear me okay?"
 *   caller: "Yes"
 *   agent:  "…we are doing tomorrow."      <- a whole sentence skipped
 *
 * The caller heard four words and was answered with the sentence after
 * them. `heardSoFarText()` counted a TTS chunk as fully heard the
 * instant its START was behind the play head, and the play head itself
 * was measured from hand-off to the transport — which runs up to
 * `OUTBOUND_HIGH_WATER_FRAMES` (2800ms) ahead of what the caller is
 * actually hearing, and every one of those queued ms is DISCARDED by
 * the barge-in. Both errors point the same way: the position held for
 * the resume sits ahead of the caller's ears.
 *
 * This suite pins the corrected measurement and the two things that had
 * to move with it:
 *
 *   SECTION A  delivered progress — a chunk counts as heard only once
 *              it is complete and fully played, minus whatever the
 *              transport still had queued and threw away.
 *   SECTION B  a recovery that delivered NOTHING is not progress, so it
 *              no longer resets the existing hearing-line cap.
 *   SECTION C  recovery text is handed to TTS unchanged — it has been
 *              through `toSpokenText` once already, and a second pass
 *              rewrites a remainder that begins mid-sentence.
 *   SECTION D  a recovery replay is marked as one, all the way to the
 *              stored transcript and the adherence diagnostic, so it is
 *              never read as the agent looping on its own script.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR OR
 * READS THE DATABASE. Every provider is a local fake; the pipeline, the
 * turn detector, the sentence chunker, the speech formatter and the
 * conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);
const { checkScriptAdherence } = await import("../outcome/script-adherence");
const { toStoredTranscript, fromStoredTranscript } = await import("../outcome/transcript");

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
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  assistantTurns(): readonly ConversationTurn[];
  assistantTexts(): readonly string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly replies: readonly string[];
  /** Fixed transport backlog in ms, as a bridge would report it. */
  readonly backlogMs?: number;
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
      await sleep(10);
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
    "resume-accuracy-test" as SessionId,
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
  record.outboundAudioListeners.add(() => undefined);
  // The one thing a bridge installs that this suite cares about. Left
  // unset (the default) the pipeline reads no backlog at all, which is
  // exactly what the in-process fallback does today.
  if (input.backlogMs !== undefined) {
    const backlog = input.backlogMs;
    record.outboundBacklogMs = () => backlog;
  }

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
/** 61 chars ≈ 2.8s of audio — long enough to interrupt well inside. */
const S1 = "Actually, I am calling you with a very interesting invitation.";
const S2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const S3 = "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${S1} ${S2} ${S3}`;

/**
 * One run-on sentence the real `SentenceChunker` force-cuts mid-phrase,
 * so the held remainder BEGINS WITH A LOWERCASE WORD. That is the input
 * Section C needs and it cannot be written by hand — the cut point is
 * the chunker's decision, not this file's.
 */
const RUN_ON =
  "It is a live reveal of the Funnel Builder Agent, where they will watch it build funnels, pages, " +
  "products, checkout, courses and emails from plain instructions, and then carry on with the same " +
  "step you were at, with no extra cost at all.";

const FOLLOW_UP = "Sure, go ahead.";
/** The approved script text the adherence diagnostic reads. */
const SCRIPT_TEXT = `${OPENING}\n${BLOCK}`;

/** How many synthesised texts carry the block's first sentence. */
const s1Spoken = (h: Harness): number => h.synthesized.filter((t) => t.includes("interesting invitation")).length;

/** Drive past the opening line and start the block. */
async function startBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — delivered progress, not handed-over progress");
// ═════════════════════════════════════════════════════════════════

await test("A1. a barge-in 600ms into a 2.8s sentence commits NONE of it", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor(
      "the hearing acknowledgement",
      () => h.synthesized.some((t) => t.includes("can you hear me")),
    );
    // THE DEFECT, stated directly: the caller heard four words of S1,
    // so no part of S1 may be recorded as something they were told.
    assert.ok(
      !h.assistantTexts().some((t) => t.includes("interesting invitation")),
      `no part of the cut sentence may be committed, got ${JSON.stringify(h.assistantTexts())}`,
    );
  } finally {
    await h.stop();
  }
});

await test("A1b. …and the resume then replays that sentence from its first word", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    const requestsBefore = h.requests.length;
    h.say("Yes, I can hear you.");
    await h.waitFor("the resume", () => s1Spoken(h) >= 2);
    assert.equal(h.requests.length, requestsBefore, "the resume is spoken from text already generated");
  } finally {
    await h.stop();
  }
});

await test("A2. a sentence that fully played IS committed, and is not replayed", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    // Past the end of S1 and well inside S2.
    await sleep(msFor(S1) + 500);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    assert.ok(
      h.assistantTexts().some((t) => t.includes("interesting invitation")),
      `the sentence the caller heard must be committed, got ${JSON.stringify(h.assistantTexts())}`,
    );
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    h.say("Yes, I can hear you.");
    await h.waitFor("the resume", () => h.synthesized.some((t) => t.startsWith("We have created")));
    assert.equal(s1Spoken(h), 1, "a sentence the caller genuinely heard is never said twice");
  } finally {
    await h.stop();
  }
});

await test("A3. audio still queued in the transport is NOT counted as heard", async () => {
  // Same instant as A2 — hand-off says S1 is long past — but the bridge
  // reports 2800ms still queued, and a barge-in discards exactly that.
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP], backlogMs: 2800 });
  try {
    await startBlock(h);
    await sleep(msFor(S1) + 500);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    assert.ok(
      !h.assistantTexts().some((t) => t.includes("interesting invitation")),
      `queued-then-discarded audio was never heard, got ${JSON.stringify(h.assistantTexts())}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — a recovery that delivered nothing is not progress");
// ═════════════════════════════════════════════════════════════════

await test("B1. a resume cut off before any of it plays commits nothing", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    h.say("Yes, I can hear you.");
    await h.waitFor("the resume to start", () => s1Spoken(h) >= 2);
    const turnsBefore = h.assistantTurns().length;
    await sleep(400);
    h.say("Hello?");
    await sleep(1200);
    // `spoken.heard === ""` is private; this is the same statement in
    // the terms the transcript can make it: the interrupted resume put
    // no new assistant turn on record.
    const committedByResume = h
      .assistantTurns()
      .slice(turnsBefore)
      .filter((t) => t.content.includes("interesting invitation"));
    assert.equal(
      committedByResume.length,
      0,
      `a resume that delivered nothing must commit nothing, got ${JSON.stringify(committedByResume.map((t) => t.content))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("B1b. the first zero-progress resume is still replayed, without the model", async () => {
  // Recovery itself is untouched: the caller heard none of the
  // remainder, so it IS offered again, and offering it costs no
  // language-model request. What the zero-delivery count changes is only
  // what happens when that keeps failing — see B1c.
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    const requestsBefore = h.requests.length;
    h.say("Yes, I can hear you.");
    await h.waitFor("the resume", () => s1Spoken(h) >= 2, 20000);
    // Asserted HERE, on the resume itself, before anything else is said:
    // the turn after this one is the cap terminating the episode, and
    // that turn reaching the model is the designed fallback (see B1c),
    // not a cost of the resume.
    assert.equal(h.requests.length, requestsBefore, "the resume reached no language model");
    // Cut it off before any of it can play — the zero-delivery case.
    await sleep(400);
    h.say("Hello?");
    await sleep(1200);
    assert.equal(s1Spoken(h), 2, "the remainder was offered again exactly once, not twice");
  } finally {
    await h.stop();
  }
});

await test("B1c. REPEATED zero-progress recovery leaves the loop through the existing cap", async () => {
  // THE INVARIANT. Not "a sentence is spoken once" — undelivered content
  // may be replayed, and forcing exactly-once is the original defect. The
  // invariant is that a caller who hears nothing, over and over, does not
  // get the same block forever: the existing hearing cap ends it and the
  // turn takes the contextual path.
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP, FOLLOW_UP, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    const requestsBefore = h.requests.length;

    // Interrupt every recovery attempt before any of it can play.
    for (let i = 0; i < 6; i += 1) {
      h.say("Hello?");
      await sleep(400);
    }
    await sleep(2000);

    assert.ok(
      h.requests.length > requestsBefore,
      `repeated zero-progress recovery must reach the contextual path, spokenCopies=${s1Spoken(h)} requests=${h.requests.length}`,
    );
    assert.ok(
      s1Spoken(h) <= 4,
      `the block must not be replayed once per "hello" forever, got ${s1Spoken(h)} copies`,
    );
  } finally {
    await h.stop();
  }
});

await test("B2. a resume that plays out in full DOES reset the cap", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    h.say("Yes, I can hear you.");
    // Let the whole resumed block play out, uninterrupted. Waited on the
    // COMMIT rather than on LISTENING, which is already true here — the
    // acknowledgement has just finished and the resume has not started.
    await h.waitFor(
      "the resume to play out and be committed",
      () => h.assistantTurns().some((t) => t.replayOf === "resume"),
      30000,
    );
    assert.ok(
      h.assistantTexts().some((t) => t.includes("interesting invitation")),
      "a resume that played in full is committed as heard",
    );
    // The cap was reset by that delivery, so a later hearing check is
    // still answered with a fixed line rather than going to the model.
    const requestsBefore = h.requests.length;
    h.say("Hello?");
    h.say("Hello?");
    await sleep(1500);
    assert.equal(
      h.requests.length,
      requestsBefore,
      "with the cap reset, a hearing check is still answered without the model",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — recovery text reaches TTS unchanged");
// ═════════════════════════════════════════════════════════════════

await test("C1. a held remainder beginning mid-sentence is not re-capitalised", async () => {
  const h = startHarness({ replies: [RUN_ON, FOLLOW_UP] });
  try {
    await h.waitForReplies(1);
    h.say("Tell me more please.");
    await h.waitFor("the reply to start", () => h.record.state === SessionState.SPEAKING);
    // The chunker force-cuts this run-on at "…funnels, pages," so the
    // remainder starts at a lowercase word. Wait past the first piece.
    await h.waitFor(
      "the second piece to be synthesized",
      () => h.synthesized.some((t) => t.startsWith("products,") || t.startsWith("Products,")),
      20000,
    );
    const firstPiece = h.synthesized.find((t) => t.includes("live reveal")) ?? "";
    await sleep(msFor(firstPiece) + 500);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    const before = h.synthesized.length;
    h.say("Yes, I can hear you.");
    await h.waitFor("the resume", () => h.synthesized.length > before, 20000);
    const resumed = h.synthesized.slice(before).join(" ");
    assert.ok(
      resumed.includes("products, checkout"),
      `the remainder must be spoken exactly as held, got ${JSON.stringify(resumed.slice(0, 80))}`,
    );
    assert.ok(
      !resumed.startsWith("Products,"),
      `a second toSpokenText pass must not capitalise a mid-sentence remainder, got ${JSON.stringify(resumed.slice(0, 40))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("C2. the fixed acknowledgement line is untouched by the change", async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    assert.ok(
      h.synthesized.includes("Hey, can you hear me okay?"),
      `the fixed line is spoken verbatim, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.ok(h.synthesized.includes(OPENING), "the opening line is still spoken verbatim");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — a replay is marked as one, all the way down");
// ═════════════════════════════════════════════════════════════════

await test('D1. an automatic resume commits replayOf: "resume"', async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    h.say("Yes, I can hear you.");
    await h.waitFor(
      "the resumed block to be committed",
      () => h.assistantTurns().some((t) => t.replayOf === "resume"),
      30000,
    );
    const replay = h.assistantTurns().find((t) => t.replayOf === "resume");
    assert.ok(replay?.content.includes("interesting invitation"), "the replay carries the script text");
    assert.ok(
      h.assistantTurns().filter((t) => t.replayOf === undefined).length > 0,
      "ordinary turns carry no replay marker at all",
    );
  } finally {
    await h.stop();
  }
});

await test('D2. a caller-requested repeat commits replayOf: "repeat"', async () => {
  const h = startHarness({ replies: [BLOCK, FOLLOW_UP] });
  try {
    await startBlock(h);
    await sleep(600);
    h.say("Hello?");
    await h.waitFor("the acknowledgement", () => h.synthesized.some((t) => t.includes("can you hear me")));
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING);
    h.say("Can you repeat that?");
    await h.waitFor(
      "the repeated block to be committed",
      () => h.assistantTurns().some((t) => t.replayOf === "repeat"),
      30000,
    );
    assert.ok(
      !h.assistantTurns().some((t) => t.replayOf === "resume"),
      "an explicit repeat is never recorded as an automatic resume",
    );
  } finally {
    await h.stop();
  }
});

await test("D3. the adherence diagnostic ignores a resume and still reports a repeat", async () => {
  const line = "We have created Flexi Genie, which helps you build and automate your online business.";
  const base = [
    { role: "assistant" as const, text: OPENING, at: null },
    { role: "user" as const, text: "Yes, tell me.", at: null },
    { role: "assistant" as const, text: line, at: null },
    { role: "user" as const, text: "Hello?", at: null },
  ];

  const resumed = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [...base, { role: "assistant" as const, text: line, at: null, replayOf: "resume" as const }],
  });
  assert.equal(resumed.repeatedScriptLines, 0, "a recovery replay is not the agent repeating itself");
  assert.equal(resumed.restartedScript, false, "a recovery replay is not a restart");

  const repeated = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [...base, { role: "assistant" as const, text: line, at: null, replayOf: "repeat" as const }],
  });
  assert.equal(repeated.repeatedScriptLines, 1, "a caller-requested repeat stays visible");

  const unmarked = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [...base, { role: "assistant" as const, text: line, at: null }],
  });
  assert.equal(unmarked.repeatedScriptLines, 1, "an unmarked repetition is unchanged by this field");
});

await test("D4. replayOf survives the stored-transcript round trip", () => {
  const turns: ConversationTurn[] = [
    { role: "system", content: "prompt", timestamp: new Date() },
    { role: "assistant", content: "Hello there.", timestamp: new Date() },
    { role: "assistant", content: "The rest of it.", timestamp: new Date(), replayOf: "resume" },
    { role: "assistant", content: "All of it again.", timestamp: new Date(), replayOf: "repeat" },
  ];
  const stored = toStoredTranscript(turns);
  assert.equal(stored.turns.length, 3, "the system turn is dropped, as before");
  assert.equal(stored.turns[0]?.replayOf, undefined, "an ordinary turn stores no marker");
  assert.equal(stored.turns[1]?.replayOf, "resume");
  assert.equal(stored.turns[2]?.replayOf, "repeat");

  const back = fromStoredTranscript(JSON.parse(JSON.stringify(stored)));
  assert.equal(back[0]?.replayOf, undefined);
  assert.equal(back[1]?.replayOf, "resume");
  assert.equal(back[2]?.replayOf, "repeat");

  // Anything else in that position is dropped rather than trusted.
  const hostile = fromStoredTranscript({
    turns: [{ role: "assistant", text: "x", at: null, replayOf: "whatever" }],
  });
  assert.equal(hostile[0]?.replayOf, undefined, "an unrecognised marker is not carried through");
});

// ═════════════════════════════════════════════════════════════════

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, Deepgram, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
