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
const { FirstReplyCache } = await import("../../core/session/first-reply-cache");
const { TtsAudioCache } = await import("../../core/session/tts-audio-cache");

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
/** The same replies as a script whose pitch names nobody — the shape a cached first reply needs. */
const PREPARED_EN_NAMELESS = "Hi, I'm Rohan from Team FlexiFunnels. I'm calling to invite you to a free live workshop. Have you tried putting something online before?";
const PREPARED_HI_NAMELESS = "Hi, मैं Rohan, Team FlexiFunnels से। हमारा एक free live workshop है। आपने पहले कभी कुछ online डालने की try की है?";
/** What it says to anything else. */
const GENERATED = "Sure. You won't need any coding or design skills for this.";

interface LlmRequestSeen {
  readonly lastUser: string;
  readonly history: readonly ConversationTurn[];
  readonly atMs: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  readonly requests: LlmRequestSeen[];
  readonly synthesized: Array<{ readonly text: string; readonly atMs: number }>;
  say(text: string, language?: (typeof SupportedLanguage)[keyof typeof SupportedLanguage]): number;
  /** An interim (non-final) segment: the words so far, not yet finalized. */
  sayInterim(text: string): number;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  assistantTurns(): string[];
  stop(): Promise<void>;
}

interface ReplyCacheInput {
  /** Shared across harnesses to stand for one process running several calls. */
  readonly firstReplyCache?: InstanceType<typeof FirstReplyCache>;
  /** Shared audio cache; the fake voice then states a fingerprint so clips can be kept. */
  readonly ttsCache?: InstanceType<typeof TtsAudioCache>;
  readonly customerName?: string;
  readonly appendix?: string;
  /** The model's reply to a bare "Yes." names nobody, as a real script's pitch does. */
  readonly namelessReplies?: boolean;
}

function startHarness(input: { readonly prepare: boolean; readonly replyDelayMs?: number; readonly openingLine?: string; readonly interim?: boolean; readonly finish?: boolean; readonly slowStreamedPreparedTts?: boolean } & ReplyCacheInput): Harness {
  const customerName = input.customerName ?? NAME;
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
      const reply =
        lastUser === "Yes."
          ? input.namelessReplies === true ? PREPARED_EN_NAMELESS : PREPARED_EN
          : lastUser === "हाँ जी।"
            ? input.namelessReplies === true ? PREPARED_HI_NAMELESS : PREPARED_HI
            : GENERATED;
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
    ...(input.ttsCache !== undefined ? { cacheIdentity: () => "fake-voice" } : {}),
    // Sarvam's shape: the first chunk arrives quickly, the whole clip much
    // later. Only the prepared reply's sentences are slow, so every other
    // line keeps the harness's timing.
    ...(input.slowStreamedPreparedTts === true
      ? {
          synthesizeStream: async function* (task: { request: { text: string } }, signal?: AbortSignal) {
            synthesized.push({ text: task.request.text, atMs: Date.now() });
            const clip = clipFor(task.request.text);
            const pieces = task.request.text.startsWith("Hi Sakshi") ? 3 : 1;
            const size = Math.ceil(clip.data.length / pieces);
            for (let i = 0; i < pieces; i += 1) {
              if (i > 0) await sleep(1500);
              if (signal?.aborted) return;
              yield { audio: { ...clip, data: clip.data.slice(i * size, (i + 1) * size) }, sequence: i, isFinal: i === pieces - 1 };
            }
          },
        }
      : {}),
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
        customer: { name: customerName },
        openingLine: input.openingLine ?? `Hello, am I speaking with ${customerName}?`,
        identityLine: `Am I speaking with ${customerName}?`,
        systemPromptAppendix: input.appendix ?? "TEST APPENDIX — any customer's script",
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

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never, {
    prepareFirstReply: input.prepare,
    ...(input.firstReplyCache !== undefined ? { firstReplyCache: input.firstReplyCache } : {}),
    ...(input.ttsCache !== undefined ? { ttsCache: input.ttsCache, cacheGeneratedSentences: true } : {}),
    speculateOnInterim: input.interim === true,
    ...(input.finish === true ? { letCallerFinish: true } : {}),
  });
  const loop = pipeline.run();

  return {
    record,
    pipeline,
    requests,
    synthesized,
    say(text, language = SupportedLanguage.ENGLISH) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({ text, isFinal: true, isSpeechFinal: true, confidence: 0.95, language, startedAtMs, endedAtMs: clockMs });
      waiters.shift()?.();
      return Date.now();
    },
    sayInterim(text) {
      segments.push({ text, isFinal: false, isSpeechFinal: false, confidence: 0.9, language: SupportedLanguage.ENGLISH, startedAtMs: clockMs, endedAtMs: clockMs + 200 });
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
section("V. THE CONFIRMATION VOCABULARY — real answers from the 2026-09-29 audit");

const { preparedReplyVariantFor } = await import("../../core/session/confirmation-vocabulary");
const SAKSHI = ["Sakshi Gosain", "साक्षी"];
for (const [said, expected] of [
  ["Yes.", "en"], ["Yeah", "en"], ["यस", "en"], ["Yes ma'am", "en"], ["Right, who's this?", "en"], ["Yes tell me", "en"],
  ["Speaking, who is this?", "en"], ["Yes, what happened?", "en"], ["Please say who you are and why you're calling.", "en"],
  ["Yes, you are speaking with साक्षी, tell me.", "en"], ["यस सर हेलो", "en"], ["राइट", "en"], ["Hello— Thank you, sir.", "en"],
  ["हाँ", "hinglish"], ["हाँ जी", "hinglish"], ["जी", "hinglish"], ["हाँ बोलिए", "hinglish"], ["हाँ, कौन बोल रहा है?", "hinglish"],
  ["हाँ मैं बात कर रहा हूँ", "hinglish"], ["Yes बोलिए", "hinglish"], ["Haan ji bataiye", "hinglish"], ["हम्म यस बोलो", "hinglish"],
  ["Yes, but I am driving right now.", undefined], ["Yeah, I'm just riding right now. Can you call me after, like, half an hour?", undefined],
  ["Hold on. Yes?", undefined], ["I cannot pick up the call right now; this is my true caller voicemail.", undefined],
  ["Hello, — You're speaking with Ayusha's assistant. May I know who's calling?", undefined],
  ["Hi, thank you for calling me. I couldn't answer your call right now. Please leave a message,", undefined],
  ["हाँ, बाद में बात करते हैं", undefined], ["Yes, not interested.", undefined], ["", undefined],
] as const) {
  await test(`V. ${JSON.stringify(said)} → ${expected ?? "its own request"}`, () => {
    assert.equal(preparedReplyVariantFor(said, SAKSHI), expected);
  });
}

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

// Real confirmations (2026-09-29 audit of 487): the reply introduces the
// agent and the purpose, so it answers these too.
for (const [said, expected] of [
  ["Yes, madam.", PREPARED_EN],
  ["Yeah, tell me.", PREPARED_EN],
  ["Right, who's this?", PREPARED_EN],
  ["Yes this is Sakshi, what is it about?", PREPARED_EN],
  ["हाँ जी बोलिए।", PREPARED_HI],
  ["हाँ, कौन बोल रहा है?", PREPARED_HI],
] as const) {
  await test(`P5a. ${JSON.stringify(said)} is a confirmation the prepared reply answers`, async () => {
    const h = startHarness({ prepare: true });
    try {
      const saidAt = await answerOpening(h, said, /[ऀ-ॿ]/u.test(said) ? SupportedLanguage.HINGLISH : SupportedLanguage.ENGLISH);
      await awaitReply(h, 2);
      assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "no request after the confirmation");
      assert.equal(h.assistantTurns()[1], expected);
    } finally {
      await h.stop();
    }
  });
}

for (const said of ["Yes, but I'm driving right now.", "Haan ji, main driving kar raha hoon.", "Hold on. Yes?", "Yeah, can you call me after half an hour?"]) {
  await test(`P5. ${JSON.stringify(said)} says something the pitch would talk past — the prepared reply is discarded and the turn gets its own`, async () => {
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

await test("P6. an unclear answer, a re-ask, then 'Yes.': the reply is prepared AGAIN for the re-ask and served", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Hello?");
    await h.waitFor("the gate to re-ask", () => h.assistantTurns().length >= 2 && h.record.state === SessionState.LISTENING, 15000);
    await sleep(200);
    const saidAt = h.say("Yes.");
    await awaitReply(h, 3);
    assert.ok(!h.assistantTurns().slice(0, 2).some((t) => t.includes("workshop")), "no pitch before identity");
    assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "no request after the confirmation");
    assert.equal(h.assistantTurns()[2], PREPARED_EN);
    const reAsk = h.assistantTurns()[1] ?? "";
    const lastPrep = [...h.requests].reverse().find((r) => r.lastUser === "Yes.");
    assert.equal(lastPrep?.history.filter((t) => t.role === "assistant").pop()?.content, reAsk, "prepared for the re-ask, not the opening");
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

await test("P8b. prepared audio still being synthesized when the caller confirms plays from its FIRST chunk, not after the whole clip (real calls 2841028a, b24e639c)", async () => {
  const h = startHarness({ prepare: true, slowStreamedPreparedTts: true });
  try {
    const saidAt = await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
    assert.equal(h.requests.filter((r) => r.atMs >= saidAt).length, 0, "still no request after the confirmation");
    assert.equal(h.assistantTurns()[1], PREPARED_EN, "the whole reply was spoken and committed");
    const turn = h.record.metrics.build().turnLatencies[0];
    assert.equal(turn?.replySource, "prepared");
    // The clip takes 3s to synthesize in full; its first chunk is in hand
    // before the caller answers. Waiting for the whole clip costs ~1s+.
    const ttsMs = turn?.tts?.milliseconds ?? Number.POSITIVE_INFINITY;
    assert.ok(ttsMs < 400, `the reply's audio started from the first chunk (${ttsMs}ms), not after the whole clip`);
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
section("I. A SETTLED INTERIM PRE-OPENS THE TURN'S REQUEST (speculateOnInterim)");

/** Past the identity turn, so the next turn is an ordinary one. */
async function pastIdentity(h: Harness): Promise<void> {
  await answerOpening(h, "Yes.");
  await awaitReply(h, 2);
  await sleep(200);
}

const ANSWER = "I have tried it before";

await test("I1. an interim that settles opens the request BEFORE the final; the final adopts it — one request for the turn", async () => {
  const h = startHarness({ prepare: true, interim: true });
  try {
    await pastIdentity(h);
    const before = h.requests.length;
    h.sayInterim(ANSWER.toLowerCase());
    await h.waitFor("the request pre-opened on the interim", () => h.requests.length > before, 2000);
    assert.ok(!h.record.memory.history().some((t) => t.role === "user" && t.content.startsWith("I have tried")), "opened before the turn was released");
    await sleep(300);
    h.say(`${ANSWER}.`);
    await awaitReply(h, 3);
    assert.equal(h.requests.length - before, 1, "the pre-opened request was adopted, not re-sent");
    assert.equal(h.assistantTurns()[2], GENERATED);
  } finally {
    await h.stop();
  }
});

await test("I2. an interim that reads unfinished opens nothing", async () => {
  const h = startHarness({ prepare: true, interim: true });
  try {
    await pastIdentity(h);
    const before = h.requests.length;
    h.sayInterim("I have tried it before but");
    await sleep(700);
    assert.equal(h.requests.length, before);
  } finally {
    await h.stop();
  }
});

await test("I3. the caller carries on after the interim settled: that request is abandoned and the full turn is answered", async () => {
  const h = startHarness({ prepare: true, interim: true });
  try {
    await pastIdentity(h);
    const before = h.requests.length;
    h.sayInterim("i have tried");
    await h.waitFor("the first pre-open", () => h.requests.length > before, 2000);
    h.sayInterim("i have tried it before on instagram");
    await sleep(100);
    h.say("I have tried it before on Instagram.");
    await awaitReply(h, 3);
    const lastUser = h.requests[h.requests.length - 1]?.lastUser ?? "";
    assert.ok(/instagram/iu.test(lastUser), `the reply was made for the whole turn, got "${lastUser}"`);
    assert.equal(h.assistantTurns()[2], GENERATED);
  } finally {
    await h.stop();
  }
});

await test("I4. switched OFF, an interim opens nothing (FIX #8's rule)", async () => {
  const h = startHarness({ prepare: true, interim: false });
  try {
    await pastIdentity(h);
    const before = h.requests.length;
    h.sayInterim(ANSWER.toLowerCase());
    await sleep(700);
    assert.equal(h.requests.length, before);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("G. A GREETING BACK OVER \"Hi Sakshi, I'm Rohan…\" DOES NOT CUT THE PITCH (real calls f1494c20, e21f370f)");

/** Starts the reply after "Yes." and returns once its first audio is playing. */
async function pitchPlaying(h: Harness): Promise<void> {
  await answerOpening(h, "Yes.");
  await h.waitFor("the pitch to start playing", () => h.record.state === SessionState.SPEAKING && h.assistantTurns().length === 1);
}

for (const [label, said, delayMs] of [
  ["\"Yeah, hey.\" over the greeting sentence", "Yeah, hey.", 700],
  ["\"हाँ, हेलो\" over the greeting sentence", "हाँ, हेलो", 700],
  ["\"Hello.\" arriving just after the greeting sentence (transcript lag)", "Hello.", 2600],
] as const) {
  await test(`G1. ${label} — the pitch is delivered whole`, async () => {
    const h = startHarness({ prepare: true });
    try {
      await pitchPlaying(h);
      await sleep(delayMs);
      h.say(said, /[ऀ-ॿ]/u.test(said) ? SupportedLanguage.HINGLISH : SupportedLanguage.ENGLISH);
      await h.waitFor("the pitch to be committed", () => h.assistantTurns().length >= 2, 30000);
      assert.equal(h.assistantTurns()[1], PREPARED_EN, "not cut");
    } finally {
      await h.stop();
    }
  });
}

await test("G2. \"Hello? Hello?\" — somebody who cannot hear — still interrupts", async () => {
  const h = startHarness({ prepare: true });
  try {
    await pitchPlaying(h);
    await sleep(700);
    h.say("Hello? Hello?");
    await h.waitFor("the pitch to be committed", () => h.assistantTurns().length >= 2, 30000);
    assert.notEqual(h.assistantTurns()[1], PREPARED_EN, "cut");
  } finally {
    await h.stop();
  }
});

await test("G3. a real interruption over the greeting sentence still interrupts", async () => {
  const h = startHarness({ prepare: true });
  try {
    await pitchPlaying(h);
    await sleep(700);
    h.say("Sorry, who gave you my number?");
    await h.waitFor("the pitch to be committed", () => h.assistantTurns().length >= 2, 30000);
    assert.notEqual(h.assistantTurns()[1], PREPARED_EN, "cut");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("R. REAL CALLS 8a610d3c / cc27c467 (2026-09-29)");

await test("R1. \"Who's this?\" → the re-ask introduces the agent → \"Yes.\": the pitch does NOT introduce it a second time", async () => {
  const h = startHarness({ prepare: true });
  try {
    await answerOpening(h, "Who's this?");
    await h.waitFor("the re-ask", () => h.assistantTurns().length >= 2 && h.record.state === SessionState.LISTENING, 15000);
    assert.ok(/Rohan/u.test(h.assistantTurns()[1] ?? ""), `the re-ask introduced the agent: "${h.assistantTurns()[1]}"`);
    await sleep(200);
    h.say("Yes.");
    await awaitReply(h, 3);
    const pitch = h.assistantTurns()[2] ?? "";
    assert.ok(!/I'm Rohan/u.test(pitch), `introduced twice: "${pitch}"`);
    assert.equal(pitch, PREPARED_EN.slice(firstSentence(PREPARED_EN).length).trim());
  } finally {
    await h.stop();
  }
});

for (const said of ["No.", "No, thank you.", "नहीं जी।"]) {
  await test(`R2. ${JSON.stringify(said)} after a confirmed registration gets the fixed goodbye, not the decline close`, async () => {
    const h = startHarness({ prepare: true });
    try {
      await pastIdentity(h);
      // The agent last said a STATEMENT to a caller STATEMENT, then the caller said no.
      h.say("Okay, I understand the details.");
      await awaitReply(h, 3);
      await sleep(200);
      h.pipeline.armScriptedClosing();
      const before = h.requests.length;
      h.say(said, /[ऀ-ॿ]/u.test(said) ? SupportedLanguage.HINGLISH : SupportedLanguage.ENGLISH);
      await awaitReply(h, 4);
      assert.equal(h.requests.length, before, "no model request");
      assert.ok(!/no problem|thanks for your time/iu.test(h.assistantTurns()[3] ?? ""), `decline-sounding close: "${h.assistantTurns()[3]}"`);
    } finally {
      await h.stop();
    }
  });
}

await test("R4. THE REAL CALL cc27c467: a question, an answer that missed it, then \"No.\" — the agent asks what they wanted to know and the call is NOT closed", async () => {
  const h = startHarness({ prepare: true });
  try {
    await pastIdentity(h);
    h.say("What— what one? The active 3,000?");
    await awaitReply(h, 3);
    await sleep(200);
    h.pipeline.armScriptedClosing();
    const before = h.requests.length;
    h.say("No.");
    await awaitReply(h, 4);
    assert.equal(h.requests.length, before, "no model request");
    assert.equal(h.assistantTurns()[3], "Sorry — what would you like to know?");
    const { agentClosedIn } = await import("../dispatch/call-runner");
    assert.equal(agentClosedIn(h.record.memory.history() as never), false, "a question, so the call is not closed on it");
  } finally {
    await h.stop();
  }
});

await test("R3. \"No, cancel it.\" after the close is NOT a goodbye — the model answers it", async () => {
  const h = startHarness({ prepare: true });
  try {
    await pastIdentity(h);
    h.pipeline.armScriptedClosing();
    const before = h.requests.length;
    h.say("No, cancel it.");
    await awaitReply(h, 3);
    assert.ok(h.requests.length > before, "the model was asked");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("W. THE CALLER RESUMES WHILE THE REPLY IS BEING GENERATED (real call d7f25cb6)");

await test("W1. \"We have already tried 2-3 times.\" … (pause) … \"but not successful\": the first reply is NEVER spoken; the whole thought is answered", async () => {
  const h = startHarness({ prepare: true, replyDelayMs: 900 });
  try {
    await pastIdentity(h);
    const spokenBefore = h.synthesized.length;
    h.say("Yes. We have already tried 2-3 times.");
    // Released; the model is still generating when the caller carries on.
    await sleep(500);
    h.sayInterim("but not successful");
    await sleep(300);
    h.say("But not successful, I wait.");
    await awaitReply(h, 3);
    const lastUserInRequest = h.requests[h.requests.length - 1]?.lastUser ?? "";
    assert.ok(/not successful/iu.test(lastUserInRequest), `the reply answered the whole thought, got "${lastUserInRequest}"`);
    const replies = h.assistantTurns().slice(2);
    assert.equal(replies.length, 1, `one reply, not one per fragment: ${JSON.stringify(replies)}`);
    const spoken = h.synthesized.slice(spokenBefore).map((s) => s.text);
    assert.equal(spoken.filter((t) => t.startsWith("Sure.")).length, 1, `the reply was spoken once: ${JSON.stringify(spoken)}`);
  } finally {
    await h.stop();
  }
});

await test("W2. a bare \"haan\" while the reply is being generated does NOT cancel it", async () => {
  const h = startHarness({ prepare: true, replyDelayMs: 900 });
  try {
    await pastIdentity(h);
    const spokenBefore = h.synthesized.length;
    h.say("We have already tried it before.");
    await sleep(500);
    h.sayInterim("haan");
    await awaitReply(h, 3);
    assert.equal(h.assistantTurns()[2], GENERATED, "the reply was kept and committed");
    const spoken = h.synthesized.slice(spokenBefore).map((s) => s.text);
    assert.equal(spoken.filter((t) => t.startsWith("Sure.")).length, 1, `spoken once: ${JSON.stringify(spoken)}`);
    assert.equal(h.requests[h.requests.length - 1]?.lastUser, "We have already tried it before.", "answered as said — the haan did not join the turn");
  } finally {
    await h.stop();
  }
});

/** Real call e54df29a: the caller carries on with "Okay…" while the reply is generated, and says more. */
async function okayThenMore(finish: boolean): Promise<{ spoken: string[]; lastUser: string; replies: string[] }> {
  const h = startHarness({ prepare: true, replyDelayMs: 900, finish });
  try {
    await pastIdentity(h);
    const spokenBefore = h.synthesized.length;
    h.say("Yeah, I've tried, but send me the details on WhatsApp.");
    await sleep(500);
    h.sayInterim("okay");
    // The reply's first sentence is ready at ~900ms; the caller is still talking.
    await sleep(600);
    h.sayInterim("okay but what is the price");
    await sleep(300);
    h.say("Okay, but what is the price?");
    await awaitReply(h, 3);
    await sleep(300);
    return {
      spoken: h.synthesized.slice(spokenBefore).map((s) => s.text),
      lastUser: h.requests[h.requests.length - 1]?.lastUser ?? "",
      replies: h.assistantTurns().slice(2),
    };
  } finally {
    await h.stop();
  }
}

await test("W3. e54df29a — the caller is mid-\"Okay…\" when the reply is ready: it waits, and answers their whole utterance, never talking over it", async () => {
  const run = await okayThenMore(true);
  assert.equal(run.spoken.filter((t) => t.startsWith("Sure.")).length, 1, `one reply spoken, not one over the caller: ${JSON.stringify(run.spoken)}`);
  assert.ok(/price/iu.test(run.lastUser), `the reply answered the whole utterance, got "${run.lastUser}"`);
  assert.equal(run.replies.length, 1, JSON.stringify(run.replies));
});

await test("W4. a bare \"haan\" that FINISHES while the reply waits: the reply is kept and spoken once", async () => {
  const h = startHarness({ prepare: true, replyDelayMs: 900, finish: true });
  try {
    await pastIdentity(h);
    const spokenBefore = h.synthesized.length;
    h.say("We have already tried it before.");
    await sleep(500);
    h.sayInterim("haan");
    await sleep(600);
    h.say("Haan.");
    await awaitReply(h, 3);
    assert.equal(h.assistantTurns()[2], GENERATED, "the reply was kept and committed");
    const spoken = h.synthesized.slice(spokenBefore).map((s) => s.text);
    assert.equal(spoken.filter((t) => t.startsWith("Sure.")).length, 1, `spoken once: ${JSON.stringify(spoken)}`);
  } finally {
    await h.stop();
  }
});

await test("W5. a caller who is silent while the reply is generated: no wait at all", async () => {
  const timeToFirstWord = async (finish: boolean) => {
    const h = startHarness({ prepare: true, replyDelayMs: 900, finish });
    try {
      await pastIdentity(h);
      const spokenBefore = h.synthesized.length;
      const saidAt = h.say("We have already tried it before.");
      await awaitReply(h, 3);
      return (h.synthesized[spokenBefore]?.atMs ?? Infinity) - saidAt;
    } finally {
      await h.stop();
    }
  };
  const off = await timeToFirstWord(false);
  const on = await timeToFirstWord(true);
  assert.ok(on - off < 150, `first word ${on}ms with the wait on vs ${off}ms off`);
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

// ═════════════════════════════════════════════════════════════════
section("C. THE FIRST REPLY IS REUSED ACROSS CALLS OF THE SAME SCRIPT (firstReplyCache)");

/** One whole call: the opening, a bare "Yes.", the first reply. Returns the harness, stopped. */
async function oneCall(input: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const h = startHarness(input);
  try {
    await answerOpening(h, "Yes.");
    await awaitReply(h, 2);
  } finally {
    await h.stop();
  }
  return h;
}

// The script names the contact, as real scripts do: the key must mask it.
const scriptFor = (name: string) => `TEST APPENDIX — you are calling ${name} about a free live workshop.`;

await test("C1. a second call of the same script, to a different person, makes NO model request and speaks the same reply", async () => {
  const cache = new FirstReplyCache();
  const first = await oneCall({ prepare: true, firstReplyCache: cache, namelessReplies: true, customerName: NAME, appendix: scriptFor(NAME) });
  assert.equal(first.requests.length, 2, "the first call generates it, once per language");
  const second = await oneCall({ prepare: true, firstReplyCache: cache, namelessReplies: true, customerName: "Rahul Verma", appendix: scriptFor("Rahul Verma") });
  assert.equal(second.requests.length, 0, "the second call asks the model for nothing");
  assert.equal(second.assistantTurns()[1], PREPARED_EN_NAMELESS, "and speaks the same reply, word for word");
  assert.equal(second.record.metrics.build().turnLatencies[0]?.replySource, "cached", "telemetry says where it came from");
});

await test("C2. a reply that says the contact's name is NEVER reused: the next caller gets their own", async () => {
  const cache = new FirstReplyCache();
  await oneCall({ prepare: true, firstReplyCache: cache, customerName: NAME, appendix: scriptFor(NAME) });
  const second = await oneCall({ prepare: true, firstReplyCache: cache, customerName: "Rahul Verma", appendix: scriptFor("Rahul Verma") });
  assert.equal(second.requests.length, 2, "\"Hi Sakshi, …\" was not kept, so it was generated again");
  assert.equal(second.record.metrics.build().turnLatencies[0]?.replySource, "prepared");
});

await test("C3. an edited script is a different key: the reply is generated fresh, nothing to invalidate", async () => {
  const cache = new FirstReplyCache();
  await oneCall({ prepare: true, firstReplyCache: cache, namelessReplies: true, appendix: scriptFor(NAME) });
  const edited = await oneCall({ prepare: true, firstReplyCache: cache, namelessReplies: true, appendix: `${scriptFor(NAME)} Now on Saturday.` });
  assert.equal(edited.requests.length, 2, "the edited script's reply is requested");
});

await test("C4. with the audio cache, the second call synthesizes none of the reply either", async () => {
  const cache = new FirstReplyCache();
  const audio = new TtsAudioCache(undefined);
  const first = await oneCall({ prepare: true, firstReplyCache: cache, ttsCache: audio, namelessReplies: true, appendix: scriptFor(NAME) });
  assert.ok(first.synthesized.some((s) => s.text.startsWith("Hi, I'm Rohan")), "the first call synthesized it");
  const second = await oneCall({ prepare: true, firstReplyCache: cache, ttsCache: audio, namelessReplies: true, customerName: "Rahul Verma", appendix: scriptFor("Rahul Verma") });
  assert.deepEqual(
    // The opening carries the name (spoken as "राहुल वर्मा"), so it is never cached.
    second.synthesized.filter((s) => !s.text.startsWith("Hello, am I speaking with")).map((s) => s.text),
    [],
    "only the opening (which carries the name) was synthesized",
  );
  assert.equal(second.assistantTurns()[1], PREPARED_EN_NAMELESS);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
process.exit();
