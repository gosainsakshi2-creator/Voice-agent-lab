/**
 * prepared-first-reply-tests.ts — `npm run test:prepared-first-reply`
 *
 * THE WAIT AFTER "HAAN JI".
 *
 * Real calls (2026-09-28) measured the reply to the identity confirmation
 * at p50 2.35s from the end of the caller's words: ~0.95s endpointing,
 * ~0.96s model time-to-first-token, then TTS — with the prompt prefix
 * already cached. Two changes take the model wait out of it, and neither
 * asks a script for anything:
 *
 *   A. a confirming turn PRE-OPENS its request like every later turn does
 *      (the gate used to block speculation on every outstanding turn,
 *      including the one it hands to the model);
 *   P. with `prepareFirstReply` on, the reply to a bare "Yes." / "हाँ जी।"
 *      is requested from the customer's own script WHILE the identity
 *      question plays, and its first sentence synthesized, so a bare
 *      confirmation is answered from what is already in hand. Anything
 *      else discards it and the turn requests its own reply, as before.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET OR CONTACTS A VENDOR.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import("../../types/enums");

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
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`);
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — identity-gate-tests' shape: the real pipeline, detector,
// classifier and memory against local fakes. MULAW/8000, so a clip's
// real-time duration is `bytes / 8` ms.
// ═════════════════════════════════════════════════════════════════

const CHARS_PER_SECOND = 22;

function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return { data: new Uint8Array(Math.round(seconds * 8000)), encoding: "MULAW", sampleRateHz: 8000 };
}

function descriptor(category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) {
  return { category, id, displayName: id, supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH], version: "fake" };
}

const healthy = (identifier: { category: unknown; id: string }) => ({ provider: identifier, status: "HEALTHY", checkedAt: new Date(), latencyMs: 1 });

const NAME = "Sakshi Gupta";
const OPENING = `Hello, am I speaking with ${NAME}?`;
const ID_LINE = `Am I speaking with ${NAME}?`;
/** What the fake model says to a bare "Yes." — i.e. what the script's first reply would be. */
const PREPARED_EN = "Hi Sakshi, I'm Rohan from Team FlexiFunnels. I'm calling to invite you to a free live workshop. Have you tried putting something online before?";
const PREPARED_HI = "Hi Sakshi, मैं Rohan, Team FlexiFunnels से। हमारा एक free live workshop है। आपने पहले कभी कुछ online डालने की try की है?";
/** What it says to anything else. */
const GENERATED = "Sure. You won't need any coding or design skills for this.";

interface LlmRequestSeen {
  readonly lastUser: string;
  readonly history: readonly ConversationTurn[];
  readonly atMs: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: LlmRequestSeen[];
  readonly synthesized: Array<{ readonly text: string; readonly atMs: number }>;
  say(text: string, language?: (typeof SupportedLanguage)[keyof typeof SupportedLanguage]): number;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  assistantTurns(): string[];
  stop(): Promise<void>;
}

function startHarness(input: { readonly prepare: boolean; readonly replyDelayMs?: number; readonly openingLine?: string }): Harness {
  const requests: LlmRequestSeen[] = [];
  const synthesized: Array<{ text: string; atMs: number }> = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;

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
    generateCompletion: async () => ({ turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache`: the system turn alone, abandoned at its first event.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      const lastUser = [...request.history].reverse().find((t) => t.role === "user")?.content.split("\n").pop() ?? "";
      requests.push({ lastUser, history: request.history, atMs: Date.now() });
      const reply = lastUser === "Yes." ? PREPARED_EN : lastUser === "हाँ जी।" ? PREPARED_HI : GENERATED;
      await sleep(input.replyDelayMs ?? 10);
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
        if (input.replyDelayMs !== undefined) await sleep(20);
      }
      yield { type: "final" as const, turn: { role: "assistant" as const, content: reply, timestamp: new Date() }, latencyMs: 1 };
    },
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push({ text: task.request.text, atMs: Date.now() });
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
    "prepared-first-reply-test" as SessionId,
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
        customer: { name: NAME },
        openingLine: input.openingLine ?? OPENING,
        identityLine: ID_LINE,
        systemPromptAppendix: "TEST APPENDIX — any customer's script",
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
    end: async () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never, { prepareFirstReply: input.prepare });
  const loop = pipeline.run();

  return {
    record,
    requests,
    synthesized,
    say(text, language = SupportedLanguage.ENGLISH) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({ text, isFinal: true, isSpeechFinal: true, confidence: 0.95, language, startedAtMs, endedAtMs: clockMs });
      waiters.shift()?.();
      return Date.now();
    },
    async waitFor(what, predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    assistantTurns() {
      return record.memory.history().filter((t) => t.role === "assistant").map((t) => t.content);
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

/** Waits for the opening to finish playing, then answers it. Returns when it was said. */
async function answerOpening(h: Harness, answer: string, language?: (typeof SupportedLanguage)[keyof typeof SupportedLanguage]): Promise<number> {
  await h.waitFor("the opening line to finish", () => h.assistantTurns().length >= 1 && h.record.state === SessionState.LISTENING);
  await sleep(200);
  return h.say(answer, language);
}

const awaitReply = (h: Harness, n: number) =>
  h.waitFor(`${n} assistant turns and LISTENING`, () => h.assistantTurns().length >= n && h.record.state === SessionState.LISTENING, 30000);

const firstSentence = (text: string) => text.split(/(?<=[.!?।？])\s+/u)[0] ?? text;

// ═════════════════════════════════════════════════════════════════
section("P. THE PREPARED FIRST REPLY");

await test("P1. 'Yes.' is answered from the reply prepared during the opening — no request after the caller spoke", async () => {
  const h = startHarness({ prepare: true });
  try {
    const saidAt = await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
    assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "nothing was requested after the confirmation");
    assert.deepEqual(h.requests.map((r) => r.lastUser).sort(), ["Yes.", "हाँ जी।"].sort(), "one preparation per language, during the opening");
    assert.equal(h.assistantTurns()[1], PREPARED_EN, "the prepared reply is what was committed");
    const firstAudio = h.synthesized.find((s) => s.text.startsWith("Hi Sakshi"));
    assert.ok(firstAudio !== undefined && firstAudio.atMs < saidAt, "its first sentence was synthesized before the caller answered");
    const turn = h.record.metrics.build().turnLatencies[0];
    assert.equal(turn?.replySource, "prepared", "telemetry marks it");
  } finally {
    await h.stop();
  }
});

await test("P2. the preparation reads the conversation the confirming turn will have: the opening, then a bare yes", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
    const prep = h.requests.find((r) => r.lastUser === "Yes.");
    const roles = prep?.history.map((t) => t.role);
    assert.deepEqual(roles, ["system", "assistant", "user"]);
    assert.equal(prep?.history[1]?.content, OPENING);
  } finally {
    await h.stop();
  }
});

await test("P3. a Devanagari confirmation gets the Hinglish reply", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "हाँ जी।", SupportedLanguage.HINGLISH);
    await awaitReply(h, 2);
    assert.equal(h.assistantTurns()[1], PREPARED_HI);
  } finally {
    await h.stop();
  }
});

await test("P4. ...and so does a romanized 'Haan ji.'", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Haan ji.");
    await awaitReply(h, 2);
    assert.equal(h.assistantTurns()[1], PREPARED_HI);
  } finally {
    await h.stop();
  }
});

for (const said of ["Yes, but I'm driving right now.", "Yes. Who is this?", "Haan ji, main driving kar raha hoon.", "Yes this is Sakshi, what is it about?"]) {
  await test(`P5. ${JSON.stringify(said)} is more than a bare yes — the prepared reply is discarded and the turn gets its own`, async () => {
    const h = startHarness({ prepare: true });
    try {
      await answerOpening(h, said);
      await awaitReply(h, 2);
      assert.ok(h.requests.some((r) => r.lastUser === said), "a request was made for what they actually said");
      assert.equal(h.assistantTurns()[1], GENERATED);
    } finally {
      await h.stop();
    }
  });
}

await test("P6. an unclear answer, a re-ask, then 'Yes.': the preparation no longer fits and is not used", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Hello?");
    await h.waitFor("the gate to re-ask", () => h.assistantTurns().length >= 2 && h.record.state === SessionState.LISTENING, 15000);
    await sleep(200);
    h.say("Yes.");
    await awaitReply(h, 3);
    assert.equal(h.requests.filter((r) => r.lastUser === "Yes.").length, 2, "the confirmation got a request of its own");
    assert.ok(!h.assistantTurns().slice(0, 2).some((t) => t.includes("workshop")), "no pitch before identity");
  } finally {
    await h.stop();
  }
});

await test("P7. a denial never hears the prepared pitch", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "No, wrong number.");
    await sleep(3000);
    assert.ok(!h.assistantTurns().includes(PREPARED_EN) && !h.assistantTurns().includes(PREPARED_HI));
  } finally {
    await h.stop();
  }
});

await test("P8. a SLOW model still serves the prepared reply: what was generated plays at once, the rest streams in", async () => {
  const h = startHarness({ prepare: true, replyDelayMs: 1500 });
  try {
    const saidAt = await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
    assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "still no request after the confirmation");
    assert.equal(h.assistantTurns()[1], PREPARED_EN, "the whole reply arrived");
  } finally {
    await h.stop();
  }
});

await test("P9. a barge-in over the prepared reply commits only what was heard, and the model answers the interruption", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Yes.");
    await h.waitFor("the prepared reply to start playing", () => h.record.state === SessionState.SPEAKING && h.assistantTurns().length === 1 && h.synthesized.some((s) => s.text.includes("invite")));
    await sleep(2500);
    h.say("Sorry, which workshop is this?");
    await h.waitFor("the model to answer the interruption", () => h.requests.some((r) => r.lastUser.includes("which workshop")), 20000);
    await awaitReply(h, 3);
    const heard = h.assistantTurns()[1] ?? "";
    assert.ok(heard.length > 0 && heard.length < PREPARED_EN.length, `only the heard part is committed: "${heard}"`);
    assert.ok(PREPARED_EN.startsWith(firstSentence(heard).slice(0, 20)));
  } finally {
    await h.stop();
  }
});

await test("P10. switched OFF, nothing is prepared: the confirmation is requested after the caller speaks, as before", async () => {
  const h = startHarness({ prepare: false });
  try {
    const saidAt = await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
    assert.equal(h.requests.length, 1, "exactly one request");
    assert.ok((h.requests[0]?.atMs ?? 0) >= saidAt, "and it was made after the caller answered");
    assert.equal(h.record.metrics.build().turnLatencies[0]?.replySource, undefined);
  } finally {
    await h.stop();
  }
});

await test("P11. an opening that does NOT ask who picked up prepares nothing until the identity question is asked", async () => {
  const h = startHarness({ prepare: true, openingLine: "Hello, this is Rohan from Team FlexiFunnels." });
  try {
    await h.waitFor("the opening line to finish", () => h.assistantTurns().length >= 1 && h.record.state === SessionState.LISTENING);
    await sleep(300);
    assert.equal(h.requests.length, 0, "no identity question yet, so nothing to prepare for");
    h.say("Hello.");
    await h.waitFor("the identity question", () => h.assistantTurns().some((t) => t === ID_LINE) && h.record.state === SessionState.LISTENING, 15000);
    await sleep(300);
    const saidAt = h.say("Yes.");
    await awaitReply(h, 3);
    assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "the identity question's yes was answered from the preparation");
    // Served — minus its "Hi Sakshi, I'm Rohan…" sentence, which the
    // existing repeated-introduction rule drops because this opening
    // already introduced the agent.
    assert.equal(h.assistantTurns()[2], PREPARED_EN.slice(firstSentence(PREPARED_EN).length).trim());
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("A. A CONFIRMING TURN PRE-OPENS ITS REQUEST (preparation off)");

await test("A1. 'Yes.' pre-opens the request before the turn is committed, and ONE request is spent", async () => {
  const h = startHarness({ prepare: false });
  try {
    await answerOpening(h, "Yes.");
    let committedAtRequest: boolean | undefined;
    await h.waitFor("the request", () => {
      if (h.requests.length > 0 && committedAtRequest === undefined) {
        committedAtRequest = h.record.memory.history().some((t) => t.role === "user" && t.content === "Yes.");
      }
      return h.requests.length > 0;
    });
    await awaitReply(h, 2);
    assert.equal(h.requests.length, 1, "one request — the pre-opened one was adopted");
    assert.equal(committedAtRequest, false, "opened before release, i.e. speculatively");
  } finally {
    await h.stop();
  }
});

await test("A2. an unclear outstanding turn pre-opens nothing — the gate answers it with a fixed line", async () => {
  const h = startHarness({ prepare: false });
  try {
    await answerOpening(h, "Hello?");
    await sleep(2500);
    assert.equal(h.requests.length, 0, "no request, speculative or otherwise");
  } finally {
    await h.stop();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
process.exit();
