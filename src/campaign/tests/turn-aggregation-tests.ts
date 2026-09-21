/**
 * turn-aggregation-tests.ts
 *
 * ONE CALLER THOUGHT, SPOKEN IN PIECES, IS ONE LOGICAL TURN.
 *
 * The real-call audit of 2026-09-21 (60 most recent transcripts) traced
 * the "answers the first sentence, then separately answers the second"
 * defect to the turn detector's `feed` fast path: a complete-looking
 * sentence with content ("Yes, I would like to join.") was released
 * 250ms after the provider's ~400ms endpoint — less quiet than the
 * pause a person takes between two sentences of one thought. The
 * continuation then arrived 0.9-1.6s later as a turn of its own. It was
 * merged only by THINKING-phase supersession (a reply discarded after
 * generation), and once the reply's audio had started it became a
 * barge-in and a second response. `MAX_CONTINUATION_GRACES` was NOT the
 * cause on these calls: one turn in 108 released with
 * `grace_cap_reached`.
 *
 * Fix under test: `EVIDENCED_CONFIRMATION_SENTENCE_MS` in
 * turn-detection.ts — a complete sentence of more than four words that
 * is not a question takes a 600ms confirmation on that one path. Short
 * answers, questions, the marker path and the inferred path are
 * unchanged, and every case below asserts one of those from the other
 * side.
 *
 * HARNESS TIME vs REAL TIME. There is no Deepgram here: a segment fed
 * with `isSpeechFinal: true` IS the endpoint claim, which on a real call
 * arrives ~400ms after the caller's last word. So a pause of `P` ms
 * between two `say()` calls below stands for a real pause of roughly
 * `P + 400` ms. The "natural pause" used here (450ms) is therefore a
 * real pause of ~850ms — squarely inside the 0.9-1.6s band measured.
 *
 * The real `ConversationPipeline` and `AdaptiveTurnDetector` run; fakes
 * stand in for the four vendors. Nothing here dials.
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

/** A natural pause between two sentences of one thought — see the header. */
const NATURAL_PAUSE_MS = 450;
/** The detector's sentence window, restated so a drift shows up here. */
const SENTENCE_WINDOW_MS = 600;
/** The detector's short tier, restated. */
const SHORT_WINDOW_MS = 150;

// ─── The harness ───────────────────────────────────────────────────

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
  /** Wall clock at which each request in `requests` was OPENED (the speculative pre-open, when adopted). */
  readonly requestAt: number[];
  /** Every stream the model was asked to open, abandoned pre-opens included. */
  openedCount(): number;
  /** Resolve with the wall clock at which the n-th user turn was committed (i.e. released by the detector). */
  waitForUserTurns(n: number, timeoutMs?: number): Promise<number>;
  readonly synthesized: string[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): number;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  replyCount(): number;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: { readonly replies: readonly string[]; readonly replyDelayMs?: number }): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const requestAt: number[] = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let opened = 0;

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
      requestAt.push(Date.now());
      return { turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      // The pipeline PRE-OPENS a request the moment the detector arms a
      // confirmation window (`startSpeculation`) and abandons it if the
      // caller carries on. Those abandoned streams are not requests the
      // conversation acted on, so only a stream that reaches its final
      // is recorded — that is the request whose reply was spoken.
      const openedAt = Date.now();
      opened += 1;
      // Scripted by COMPLETED request, so an abandoned pre-open does not
      // consume the reply meant for the turn that actually gets answered.
      const reply = input.replies[requests.length] ?? "Okay.";
      await sleep(input.replyDelayMs ?? 10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      requests.push(request.history);
      requestAt.push(openedAt);
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
    "aggregation-test" as SessionId,
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
    requestAt,
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
      return Date.now();
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
    openedCount() {
      return opened;
    },
    async waitForUserTurns(n, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (record.memory.history().filter((turn) => turn.role === "user").length >= n) return Date.now();
        await sleep(10);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${n} user turns`);
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

// ─── Fixtures ──────────────────────────────────────────────────────

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const REPLY_1 = "Great, glad to hear that. It covers building a website and taking payments online.";
const REPLY_2 = "Sure, happy to help with that too.";
const BLOCK =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

/** The last user turn of a request, minus the internal per-turn note. */
function lastUserContent(history: readonly ConversationTurn[]): string {
  const userTurns = history.filter((turn) => turn.role === "user");
  return userTurns[userTurns.length - 1]?.content.split("\n").pop() ?? "";
}

/** Every user turn of a request, notes stripped. */
function userContents(history: readonly ConversationTurn[]): string[] {
  return history.filter((turn) => turn.role === "user").map((turn) => turn.content.split("\n").pop() ?? "");
}

/** Wait until the fixed opening has been spoken and the agent is listening. */
async function afterOpening(h: Harness): Promise<void> {
  await h.waitForReplies(1);
}

// ═════════════════════════════════════════════════════════════════
section("A. TWO SENTENCES, ONE THOUGHT");
// ═════════════════════════════════════════════════════════════════

await test("A. 'Yes, I would like to join.' [pause] 'Actually, can you tell me what the webinar covers?' is ONE turn and ONE reply", async () => {
  const h = startHarness({ replies: [REPLY_1, REPLY_2] });
  try {
    await afterOpening(h);
    h.say("Yes, I would like to join.");
    await sleep(NATURAL_PAUSE_MS);
    h.say("Actually, can you tell me what the webinar covers?");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "exactly one language-model request");
    assert.equal(
      lastUserContent(h.requests[0]!),
      "Yes, I would like to join. Actually, can you tell me what the webinar covers?",
      "the model is handed the WHOLE thought as one user turn",
    );
    assert.equal(h.synthesized.filter((t) => t.includes("glad to hear")).length, 1, "one reply, spoken once");
    assert.equal(h.history().filter((t) => t.role === "user").length, 1, "one committed user turn");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. A BARE 'YES' THAT CARRIES ON");
// ═════════════════════════════════════════════════════════════════

await test("B1. 'Yes...' [pause] 'I would like to join...' [pause] 'and I have one question.' is ONE turn (trailing off is held by the continuation grace)", async () => {
  const h = startHarness({ replies: [REPLY_1] });
  try {
    await afterOpening(h);
    // Deepgram renders a caller trailing off with a comma or ellipsis;
    // `looksIncomplete` holds either, so the pieces join.
    h.say("Yes...");
    await sleep(NATURAL_PAUSE_MS);
    h.say("I would like to join...");
    await sleep(NATURAL_PAUSE_MS);
    h.say("and I have one question.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "one request");
    assert.equal(lastUserContent(h.requests[0]!), "Yes... I would like to join... and I have one question.");
  } finally {
    await h.stop();
  }
});

await test("B2. a hard-stopped 'Yes.' followed ~1s later by the rest: still ONE spoken reply, and the model sees both pieces before it is spoken", async () => {
  // A bare short answer deliberately keeps the 150ms tier (every gate
  // answer depends on it), so the detector releases "Yes." on its own.
  // The pipeline then merges the continuation the way it already does:
  // the reply to "Yes." is superseded BEFORE any of it is spoken, and
  // the one reply that is spoken is generated with both pieces on
  // record. Live LLM first-token latency is ~1s; the fake takes 1.2s.
  const h = startHarness({ replies: [REPLY_1, REPLY_2], replyDelayMs: 1200 });
  try {
    await afterOpening(h);
    h.say("Yes.");
    await sleep(600);
    h.say("I would like to join, and I have one question.");
    await h.waitForReplies(2);
    await sleep(300);
    const spoken = h.synthesized.filter((t) => t.includes("glad to hear") || t.includes("happy to help"));
    assert.equal(spoken.length, 1, `exactly one reply spoken, saw: ${JSON.stringify(spoken)}`);
    const last = h.requests[h.requests.length - 1]!;
    assert.deepEqual(
      userContents(last),
      ["Yes.", "I would like to join, and I have one question."],
      "the reply that was spoken was generated with BOTH pieces in the model's history",
    );
    assert.equal(h.history().filter((t) => t.role === "assistant").length, 2, "opening + one reply; nothing was spoken for the bare yes alone");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. A LONG SENTENCE WITH NATURAL PAUSES");
// ═════════════════════════════════════════════════════════════════

await test("C. three complete-looking sentences with natural pauses between them → ONE response", async () => {
  const h = startHarness({ replies: [REPLY_1] });
  try {
    await afterOpening(h);
    // Each piece is a complete sentence of 5-6 words: none is long
    // enough for the long-turn window, and each used to be released on
    // the 250ms tier before the next one arrived.
    h.say("I run a small clothing shop.");
    await sleep(NATURAL_PAUSE_MS);
    h.say("It is in Pune actually.");
    await sleep(NATURAL_PAUSE_MS);
    h.say("And I want to start selling online.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "one request for the whole explanation");
    assert.equal(
      lastUserContent(h.requests[0]!),
      "I run a small clothing shop. It is in Pune actually. And I want to start selling online.",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. A CALLER WHO IS DONE IS ANSWERED PROMPTLY");
// ═════════════════════════════════════════════════════════════════

await test("D1. a finished sentence is released on the sentence window — not a silence window", async () => {
  const h = startHarness({ replies: [REPLY_1] });
  try {
    await afterOpening(h);
    const saidAt = h.say("Yes, I would like to join.");
    const releasedAt = await h.waitForUserTurns(1);
    const toReleaseMs = releasedAt - saidAt;
    assert.ok(toReleaseMs < SENTENCE_WINDOW_MS + 300, `released within the sentence window plus slack: ${toReleaseMs}ms`);
    assert.ok(toReleaseMs < 1_100, `never a full silence window: ${toReleaseMs}ms`);
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1);
    // The speculative pre-open is what absorbs the wider window on a
    // live call: the model was asked BEFORE the release, not after it.
    assert.ok(h.requestAt[0]! <= releasedAt, "the request that produced the reply was opened no later than the release");
  } finally {
    await h.stop();
  }
});

await test("D2. a short answer — every gate answer — keeps the short tier", async () => {
  const h = startHarness({ replies: [REPLY_1] });
  try {
    await afterOpening(h);
    const saidAt = h.say("Yes, please.");
    const toReleaseMs = (await h.waitForUserTurns(1)) - saidAt;
    assert.ok(toReleaseMs < SHORT_WINDOW_MS + 250, `a short answer must not pay the sentence window: ${toReleaseMs}ms`);
  } finally {
    await h.stop();
  }
});

await test("D3. a finished QUESTION keeps the short tier whatever its length", async () => {
  const h = startHarness({ replies: [REPLY_1] });
  try {
    await afterOpening(h);
    const saidAt = h.say("Can you tell me what the webinar covers?");
    const toReleaseMs = (await h.waitForUserTurns(1)) - saidAt;
    assert.ok(toReleaseMs < SHORT_WINDOW_MS + 250, `a finished question must not pay the sentence window: ${toReleaseMs}ms`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. A NEW TURN AFTER THE REPLY IS A NEW TURN");
// ═════════════════════════════════════════════════════════════════

await test("E. the caller speaks again after the reply has been spoken → a second, separate turn", async () => {
  const h = startHarness({ replies: [REPLY_1, REPLY_2] });
  try {
    await afterOpening(h);
    h.say("Yes, I would like to join.");
    await h.waitForReplies(2);
    h.say("Actually, can you tell me what the webinar covers?");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "two requests — the second thought came after the first was answered");
    assert.equal(lastUserContent(h.requests[1]!), "Actually, can you tell me what the webinar covers?");
    assert.equal(h.history().filter((t) => t.role === "user").length, 2);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("F. BARGE-IN DURING THE REPLY IS UNCHANGED");
// ═════════════════════════════════════════════════════════════════

await test("F. a real interruption mid-block still cuts the block and is answered as its own turn", async () => {
  const h = startHarness({ replies: [BLOCK, REPLY_2] });
  try {
    await afterOpening(h);
    h.say("Yes, tell me.");
    await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
    await sleep(900);
    h.say("Wait, how much does it cost?");
    await h.waitForReplies(3);
    const assistantTurns = h.history().filter((t) => t.role === "assistant").map((t) => t.content);
    const committedBlock = assistantTurns[1] ?? "";
    assert.ok(committedBlock.length > 0 && committedBlock.length < BLOCK.length, "the heard PREFIX of the block was committed, not the whole block");
    assert.equal(h.requests.length, 2, "the interruption became a turn of its own");
    assert.equal(lastUserContent(h.requests[1]!), "Wait, how much does it cost?");
    // The diagnostic record (2026-09-21) names the path that accepted
    // the barge-in and the evidence it was accepted on — never the words.
    const bargedTurn = h.record.metrics.build().turnLatencies.find((t) => t.bargeInPhase === "speaking");
    assert.ok(bargedTurn, "the interrupted turn is labelled with its barge-in phase");
    assert.equal(bargedTurn.bargeInTrigger?.source, "transcript");
    assert.equal(bargedTurn.bargeInTrigger?.words, 6);
    assert.equal(bargedTurn.bargeInTrigger?.isFinal, true);
    assert.equal(bargedTurn.bargeInTrigger?.beganBeforeReply, false);
    assert.ok(Object.values(bargedTurn.bargeInTrigger ?? {}).every((v) => typeof v !== "string" || v === "transcript"), "no caller text in telemetry");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("G. THE REGISTRATION ANSWER STILL ARRIVES WHOLE AND FAST");
// ═════════════════════════════════════════════════════════════════

await test("G. 'Yes, please reserve my seat.' [pause] 'Thank you.' → one turn carrying the yes; a bare 'Haan ji.' stays on the short tier", async () => {
  const h = startHarness({ replies: [REPLY_1, REPLY_2] });
  try {
    await afterOpening(h);
    h.say("Yes, please reserve my seat.");
    await sleep(NATURAL_PAUSE_MS);
    h.say("Thank you.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1);
    assert.equal(lastUserContent(h.requests[0]!), "Yes, please reserve my seat. Thank you.");
    const saidAt = h.say("Haan ji.");
    const toReleaseMs = (await h.waitForUserTurns(2)) - saidAt;
    assert.ok(toReleaseMs < SHORT_WINDOW_MS + 250, `a bare gate answer keeps the short tier: ${toReleaseMs}ms`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, Deepgram, the LLM and the TTS vendors were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
