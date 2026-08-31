/**
 * self-echo-tests.ts — `npm run test:self-echo`
 *
 * ONE REPORTED DEFECT: THE AGENT TALKED TO ITSELF.
 *
 * On the live Vobiz benchmarking call the caller's handset fed our own
 * outbound audio back up the inbound track, Deepgram transcribed it, and
 * the pipeline answered it as if the caller had spoken:
 *
 *   assistant: "You're welcome. What would you like to talk about?"
 *   "caller":  "You are welcome. What would you like to talk..."
 *   assistant: "I'm here for anything you need — billing, your account…"
 *   "caller":  "In here for anything you need."
 *
 * NOT AN OUTBOUND-TRACK PROBLEM, and this is why the fix is a text guard
 * rather than one string in the bridge's filter. A whole instrumented
 * call tallied `INBOUND (caller)=7116, distinctTrackValues=1` — Vobiz
 * sends exactly one, correctly-labelled, caller-only track. The echo IS
 * that track, acoustically, out of the caller's earpiece or speakerphone.
 *
 * WHY THE THREE EXISTING GATES CANNOT CATCH IT, which Section A pins:
 *   - the near-end RMS gate cannot — speakerphone echo is genuinely loud;
 *   - `isBackchannel` cannot — the text is not an acknowledgement;
 *   - `interruptionCorroborated` is never even asked, because the echo's
 *     Deepgram final lands ~0.4-1.7s after the words, by which time
 *     `drainPlayback` has left SPEAKING and `spokeOverTheAssistant` is
 *     false. That is the hole, and it is Section A's first test.
 *
 * Section B is the half that matters more: everything the guard must NOT
 * touch. A caller must still be able to interrupt, must still be
 * answered when they reuse the reply's own vocabulary, and must never be
 * suppressed for saying something short — "wait", "stop", "hello",
 * "yes", "billing" — whatever the assistant happens to be saying.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the conversation
 * memory are all the real ones.
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

// ═════════════════════════════════════════════════════════════════
// THE PIPELINE HARNESS
//
// Deliberately the same shape as the one in `barge-in-accuracy-tests.ts`
// — fakes for the four vendors and nothing else. MULAW/8000 means one
// byte is one sample, so a clip's real-time duration is exactly
// `bytes / 8` ms, which is what lets a test say "the echo's final lands
// after the reply has played" and mean it.
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

interface SayOptions {
  readonly isFinal?: boolean;
  readonly isSpeechFinal?: boolean;
  readonly confidence?: number;
  /**
   * What the TRANSPORT heard when these words were recognised. `"loud"`
   * is the near-end gate firing — and it is the DEFAULT here on purpose:
   * loud is exactly what speakerphone echo is, so every echo test runs
   * with the energy gate corroborating, which is the situation the RMS
   * threshold cannot help with.
   */
  readonly heardBy?: "loud" | "quiet" | "none";
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
}) {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;
  let hangups = 0;

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
      // greeting plays. Not a conversational request.
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
    "self-echo-test" as SessionId,
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
    requests,
    synthesized,
    hangupCount() {
      return hangups;
    },
    say(text: string, opts?: SayOptions) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      switch (opts?.heardBy ?? "loud") {
        case "loud":
          record.lastCallerEnergyAt = Date.now();
          break;
        case "quiet":
          record.lastCallerEnergyAt = Date.now() - 30_000;
          break;
        case "none":
          record.lastCallerEnergyAt = 0;
          break;
      }
      record.lastConversationActivityAt = Date.now();
      segments.push({
        text,
        isFinal,
        ...(opts?.isSpeechFinal !== undefined ? { isSpeechFinal: opts.isSpeechFinal } : { isSpeechFinal: isFinal }),
        confidence: opts?.confidence ?? 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      });
      waiters.shift()?.();
    },
    async waitFor(what: string, predicate: () => boolean, timeoutMs = 15000) {
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
    userTurns() {
      return record.memory
        .history()
        .filter((turn) => turn.role === "user")
        .map((turn) => turn.content);
    },
    async waitForReplies(n: number, timeoutMs = 15000) {
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
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

/**
 * The opening line from the live call, near enough. Long, so its echo has
 * plenty of word pairs — which is what a real echo has and what the
 * guard requires.
 */
const OPENING =
  "Hello Sakshi, this is Rohan calling from FlexiFunnels about the free AI workshop this Sunday.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — our own audio, transcribed as the caller (the defect)");
// ═════════════════════════════════════════════════════════════════

await test("the echo of the opening line does not become a caller turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["This should never be said."] });
  try {
    await h.waitFor("the opening line to be spoken", () => h.synthesized.length > 0);
    // Playback has begun, so there is now assistant audio the caller has
    // heard — the only thing an echo can be made of.
    await h.waitFor("playback to be under way", () => h.record.state === SessionState.SPEAKING);
    await sleep(120);
    // The echo, as Deepgram delivered it on the live call: our own words,
    // lightly mis-recognised, LOUD (speakerphone), and arriving as a
    // final. Every existing gate passes it.
    h.say("this is Rohan calling from FlexiFunnels about the free AI workshop");
    await sleep(600);
    assert.equal(
      h.userTurns().length,
      0,
      `the echo must not become a caller turn, got ${JSON.stringify(h.userTurns())}`,
    );
    assert.equal(
      h.requests.length,
      0,
      "the echo must not open an LLM request — no reply may be generated for it",
    );
  } finally {
    await h.stop();
  }
});

await test("the echo whose final lands AFTER the reply finished playing is still suppressed", async () => {
  // THE DOMINANT CASE, and the reason the guard is not gated on SPEAKING.
  // Deepgram's final for the echo arrives ~0.4-1.7s after the words, so
  // `drainPlayback` has already left SPEAKING and both existing filters
  // (backchannel, uncorroborated) are skipped entirely.
  const h = startHarness({
    openingLine: OPENING,
    replies: ["You're welcome. What would you like to talk about?", "This should never be said."],
  });
  try {
    await h.waitFor("the opening line to be spoken", () => h.synthesized.length > 0);
    await sleep(80);
    h.say("Nothing much, thanks for calling me today.");
    await h.waitForReplies(2);
    // The assistant has finished: state is LISTENING, playback drained.
    assert.equal(h.record.state, SessionState.LISTENING, "the reply must have finished playing");
    const repliesBefore = h.replyCount();
    const userTurnsBefore = h.userTurns().length;
    // NOW the echo's final lands — the exact transcript from the live call.
    h.say("You are welcome. What would you like to talk");
    await sleep(600);
    assert.equal(
      h.userTurns().length,
      userTurnsBefore,
      `a post-playback echo must not become a caller turn, got ${JSON.stringify(h.userTurns())}`,
    );
    assert.equal(h.replyCount(), repliesBefore, "and it must not be answered");
  } finally {
    await h.stop();
  }
});

await test("mis-recognised echo still matches — \"In here\" for \"I'm here\"", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "I'm here for anything you need, billing, your account, or help using FlexiFunnels.",
      "This should never be said.",
    ],
  });
  try {
    await h.waitFor("the opening line to be spoken", () => h.synthesized.length > 0);
    await sleep(80);
    h.say("Can you tell me what you do?");
    await h.waitForReplies(2);
    const userTurnsBefore = h.userTurns().length;
    // Apostrophe lost, "I'm" heard as "In" — a real acoustic path, not a
    // clean digital copy. The word PAIRS still line up.
    h.say("In here for anything you need");
    await sleep(600);
    assert.equal(
      h.userTurns().length,
      userTurnsBefore,
      `a mis-recognised echo must not become a caller turn, got ${JSON.stringify(h.userTurns())}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — what the guard must NEVER touch");
// ═════════════════════════════════════════════════════════════════

await test("a genuine interruption still interrupts, and is still answered", async () => {
  // THE GUARANTEE. Requirement B: barge-in for real caller speech is
  // untouched. The caller's words share nothing with the reply.
  const BLOCK =
    "We have created Flexi Genie, which automates your online business. It builds funnels and pages for you.";
  const input1Length = BLOCK.length;
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, "The workshop is free and runs this Sunday."],
  });
  try {
    // Sequenced exactly like SECTION F of `test:barge-in`: the greeting
    // is assistant turn 1, so waiting for it is what guarantees the
    // interruption below lands during the REPLY and not during the
    // opening line (which is deliberately not interruptible).
    await h.waitForReplies(1);
    h.say("Tell me more please.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    const requestsBefore = h.requests.length;
    h.say("Actually how much does the price come to?");
    await h.waitForReplies(3);
    const spoken = h.assistantTexts();
    assert.ok(
      spoken[1] !== undefined && spoken[1].length < input1Length,
      "the reply must have been cut short by a real interruption",
    );
    assert.equal(
      spoken[2],
      "The workshop is free and runs this Sunday.",
      `the interruption must be answered by the model, got ${JSON.stringify(spoken[2])}`,
    );
    assert.ok(
      h.requests.length > requestsBefore,
      "a real interruption must produce a language-model request",
    );
    assert.ok(
      h.userTurns().some((t) => t.includes("price")),
      `the interruption must become a caller turn, got ${JSON.stringify(h.userTurns())}`,
    );
  } finally {
    await h.stop();
  }
});

await test("short caller utterances are never suppressed, whatever the assistant said", async () => {
  // "wait", "stop", "hello", "yes", "billing" — all below the four-word
  // floor, so categorically ineligible. Driven through the real pipeline
  // rather than asserted on the threshold, because the floor is only
  // worth anything if these words actually reach the turn detector.
  const h = startHarness({
    openingLine: OPENING,
    replies: ["Wait, stop, hello, yes, billing, your account.", "Answered."],
  });
  try {
    await h.waitFor("the opening line to be spoken", () => h.synthesized.length > 0);
    await sleep(80);
    h.say("What can you help me with?");
    await h.waitForReplies(2);
    const userTurnsBefore = h.userTurns().length;
    // Every one of these words is IN the reply that just played. Under
    // unigram containment all of them would be suppressed.
    h.say("Wait stop");
    await sleep(400);
    assert.ok(
      h.userTurns().length > userTurnsBefore,
      `a short caller utterance must still become a turn, got ${JSON.stringify(h.userTurns())}`,
    );
  } finally {
    await h.stop();
  }
});

await test("a caller reusing the reply's own vocabulary is still answered", async () => {
  // The false positive that a containment check would produce: the
  // caller's answer is built from the words of the question. Word ORDER
  // is what separates it from an echo.
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      "I'm here for anything you need, billing, your account, or help using FlexiFunnels.",
      "Let me pull up your billing.",
    ],
  });
  try {
    await h.waitFor("the opening line to be spoken", () => h.synthesized.length > 0);
    await sleep(80);
    h.say("What can you help me with?");
    await h.waitForReplies(2);
    const userTurnsBefore = h.userTurns().length;
    // "billing", "account", "help", "need", "your" all appear in the
    // reply — but never in this order.
    h.say("Yes I need help with my billing account please");
    await sleep(600);
    assert.ok(
      h.userTurns().length > userTurnsBefore,
      `a genuine answer reusing the reply's words must become a turn, got ${JSON.stringify(h.userTurns())}`,
    );
  } finally {
    await h.stop();
  }
});

await test("with nothing played yet, no transcript can be judged an echo", async () => {
  // `heardSoFarText()` is the guard's entire bound — no timer, no window.
  // Before playback there is nothing to echo, so the caller's very first
  // words are untouchable even if they somehow matched.
  const h = startHarness({ openingLine: OPENING, replies: ["Answered."] });
  try {
    // Said as the handset is lifted, before any audio exists.
    h.say("Hello Sakshi this is Rohan calling from FlexiFunnels");
    await h.waitFor(
      "the words to reach the conversation",
      () => h.userTurns().length > 0 || h.requests.length > 0,
      8000,
    );
    assert.ok(
      h.userTurns().length > 0 || h.requests.length > 0,
      "words spoken before any playback must never be suppressed",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
if (failures.length > 0) {
  console.log(`\nFAILED — ${passed} passed, ${failures.length} failed`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`\nALL PASSED — ${passed} passed, 0 failed`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
