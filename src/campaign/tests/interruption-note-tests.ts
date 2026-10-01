/**
 * interruption-note-tests.ts — `npm run test:interruption-note`
 *
 * WHEN THE CALLER CUTS A REPLY OFF, DOES THE NEXT REQUEST KNOW WHERE?
 *
 * The history holds only what the caller HEARD (`cancelledHeardText`),
 * rounded to sentences. On its own that reads to the model as a reply it
 * finished — or, when nothing played, as no reply at all — so it repeats
 * what the caller heard or skips what they missed. `noteInterruptedReply`
 * adds one internal note to the next request: the words they heard (word
 * by word, up to the play head) and the words they did not.
 *
 *   SECTION A  the pure helpers: word rounding and the note text.
 *   SECTION B  the pipeline: the note reaches the next request, carries
 *              the unheard words, is gone once a reply lands, and the
 *              committed history is identical with the option on or off.
 *
 * Harness copied from barge-in-resume-accuracy-tests.ts. Every provider
 * is a local fake; nothing places a call or reads the database.
 */

import assert from "node:assert/strict";

const { ConversationPipeline, wordPrefixAtFraction } = await import("../../core/session/conversation-pipeline");
const { interruptedReplyNote } = await import("../../core/session/system-prompt");
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
  say(text: string): void;
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
  readonly noteInterruptedReply?: boolean;
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
    ...(input.noteInterruptedReply === true ? { noteInterruptedReply: true } : {}),
  });
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
/** 61 chars ≈ 2.8s of audio. */
const S1 = "Actually, I am calling you with a very interesting invitation.";
/** 110 chars ≈ 5s of audio. */
const S2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const S3 = "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${S1} ${S2} ${S3}`;
const ANSWER = "It is completely free.";
const FOLLOW_UP = "Great, shall I reserve your seat?";
const SCRIPT_TEXT = `${OPENING}\n${BLOCK}`;
const QUESTION = "Wait, how much does this cost me?";

/** The latest user turn of a request, as the model receives it. */
const lastUserTurn = (request: readonly ConversationTurn[]): string =>
  [...request].reverse().find((t) => t.role === "user")?.content ?? "";

/** Opening line, "Yes, tell me.", then the block starts playing. */
async function startBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
}

/** Cut the block ~1.5s into S2 with a real question, then let the answer land. */
async function cutInsideS2(h: Harness): Promise<number> {
  await startBlock(h);
  await sleep(msFor(S1) + 1500);
  const requestsBefore = h.requests.length;
  h.say(QUESTION);
  await h.waitFor("the request answering the question", () => h.requests.length > requestsBefore, 20000);
  return requestsBefore;
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the pure helpers");
// ═════════════════════════════════════════════════════════════════

await test("A1. wordPrefixAtFraction rounds DOWN to a whole word", () => {
  assert.equal(wordPrefixAtFraction("Actually, I am calling you", 0.5), "Actually, I");
  assert.equal(wordPrefixAtFraction("Actually, I am calling you", 0.02), "");
  assert.equal(wordPrefixAtFraction("one two", 3 / 7), "one", "a cut on the space keeps the word before it");
});

await test("A2. …0 is nothing, 1 is everything", () => {
  assert.equal(wordPrefixAtFraction(S1, 0), "");
  assert.equal(wordPrefixAtFraction(S1, 1), S1);
  assert.equal(wordPrefixAtFraction(S1, 1.4), S1);
});

await test("A3. …and Devanagari rounds on words too", () => {
  const hindi = "हम एक फ्री वर्कशॉप कर रहे हैं";
  const got = wordPrefixAtFraction(hindi, 0.5);
  assert.ok(hindi.startsWith(got) && (got === "" || hindi[got.length] === " "), `must end on a word, got "${got}"`);
});

await test("A4. the note quotes both parts, and says so when nothing was heard", () => {
  const note = interruptedReplyNote("Actually, I am calling", "you with a very interesting invitation.");
  assert.ok(note.includes('They heard up to: "Actually, I am calling"'), note);
  assert.ok(note.includes('They did NOT hear: "you with a very interesting invitation."'), note);
  assert.ok(note.startsWith("[internal note, never speak"), "same framing as the current-turn note");
  assert.ok(interruptedReplyNote("", S1).includes("They heard none of it."));
});

await test("A5. …and a long part is trimmed, not pasted whole", () => {
  const long = `${BLOCK} ${BLOCK} ${BLOCK}`;
  const note = interruptedReplyNote(long, long);
  assert.ok(note.length < 800, `note is ${note.length} chars`);
  assert.ok(note.includes("…"), "the trim is marked");
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — the pipeline");
// ═════════════════════════════════════════════════════════════════

await test("B1. a cut inside S2: the next request says what was heard and what was not", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], noteInterruptedReply: true });
  try {
    const before = await cutInsideS2(h);
    const turn = lastUserTurn(h.requests[before]!);
    assert.ok(turn.includes("your previous reply was cut off"), `no note in: ${turn.slice(0, 300)}`);
    assert.ok(turn.includes(QUESTION), "the caller's words are still there");
    const unheard = /They did NOT hear: "([^"]*)"/u.exec(turn)?.[1] ?? "";
    assert.ok(unheard.includes("plain instructions"), `S3 was never played, unheard="${unheard}"`);
    assert.ok(!unheard.includes("interesting invitation"), `S1 was fully played, unheard="${unheard}"`);
    assert.ok(unheard.includes("chatting with AI"), `the end of S2 was not played, unheard="${unheard}"`);
  } finally {
    await h.stop();
  }
});

await test("B2. …the note is gone once the answer is committed", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], noteInterruptedReply: true });
  try {
    await cutInsideS2(h);
    await h.waitFor("the answer", () => h.assistantTexts().some((t) => t.includes(ANSWER)), 20000);
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING, 20000);
    const before = h.requests.length;
    h.say("Okay, sounds good to me.");
    await h.waitFor("the next request", () => h.requests.length > before, 20000);
    const turn = lastUserTurn(h.requests[before]!);
    assert.ok(!turn.includes("cut off"), `a stale note leaked into: ${turn.slice(0, 300)}`);
  } finally {
    await h.stop();
  }
});

await test("B3. option OFF: no note, exactly as before", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    const before = await cutInsideS2(h);
    assert.ok(!lastUserTurn(h.requests[before]!).includes("cut off"));
  } finally {
    await h.stop();
  }
});

await test("B5. call 2e94826f: the note survives the hearing question and reaches the next real request", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], noteInterruptedReply: true });
  try {
    await startBlock(h);
    await sleep(msFor(S1) + 1500);
    h.say("Hello? Hello?");
    await h.waitFor("the hearing question", () => h.synthesized.some((t) => t.includes("can you hear me")), 20000);
    await h.waitFor("the agent to listen again", () => h.record.state === SessionState.LISTENING, 20000);
    const before = h.requests.length;
    h.say(QUESTION);
    await h.waitFor("the request answering the question", () => h.requests.length > before, 20000);
    const turn = lastUserTurn(h.requests[before]!);
    assert.ok(turn.includes("your previous reply was cut off"), `the hearing question must not end the note: ${turn.slice(0, 300)}`);
    assert.ok(turn.includes("plain instructions"), "and it still names what was never played");
  } finally {
    await h.stop();
  }
});

await test("B6. the turn that carried the note records it in telemetry, counts only", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], noteInterruptedReply: true });
  try {
    await cutInsideS2(h);
    await h.waitFor("the answer", () => h.assistantTexts().some((t) => t.includes(ANSWER)), 20000);
    await h.waitFor("the turn to be recorded", () =>
      h.record.metrics.build().turnLatencies.some((t) => t.interruptionNote !== undefined), 20000);
    const turns = h.record.metrics.build().turnLatencies;
    const noted = turns.filter((t) => t.interruptionNote !== undefined);
    assert.equal(noted.length, 1, `exactly the answering turn, got ${JSON.stringify(turns.map((t) => t.interruptionNote))}`);
    const note = noted[0]!.interruptionNote!;
    assert.ok(note.heardChars > S1.length && note.unheardChars > S3.length, JSON.stringify(note));
    assert.equal(note.unheardEndsWithQuestion, false);
  } finally {
    await h.stop();
  }
});

await test("B7. option OFF: no telemetry entry", async () => {
  const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP] });
  try {
    await cutInsideS2(h);
    await h.waitFor("the answer", () => h.assistantTexts().some((t) => t.includes(ANSWER)), 20000);
    await sleep(300);
    assert.ok(h.record.metrics.build().turnLatencies.every((t) => t.interruptionNote === undefined));
  } finally {
    await h.stop();
  }
});

await test("B4. the committed history is the same with the option on and off", async () => {
  const run = async (on: boolean): Promise<readonly string[]> => {
    const h = startHarness({ replies: [BLOCK, ANSWER, FOLLOW_UP], ...(on ? { noteInterruptedReply: true } : {}) });
    try {
      await cutInsideS2(h);
      await h.waitFor("the answer", () => h.assistantTexts().some((t) => t.includes(ANSWER)), 20000);
      return h.assistantTexts();
    } finally {
      await h.stop();
    }
  };
  const off = await run(false);
  const on = await run(true);
  assert.deepEqual(on, off);
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, the STT, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
