/**
 * stt-clock-reset-tests.ts — `npm run test:stt-clock`
 *
 * ONE REPORTED DEFECT: THE CALLER SAYS "HELLO?" OVER THE AGENT,
 * DEEPGRAM TRANSCRIBES IT, AND THE AGENT TALKS STRAIGHT THROUGH IT.
 *
 * The interruption test in `startContinuousStt` asks "did these words
 * happen AFTER I started speaking", and answered it by comparing
 * Deepgram's word times against a snapshot of `inboundStreamMs`. Those
 * are two different clocks:
 *
 *   - `inboundStreamMs` counts every byte handed to the STT provider
 *     and is monotonic for the WHOLE CALL;
 *   - `segment.endedAtMs` is measured from the start of the audio the
 *     provider's CURRENT WEBSOCKET has received.
 *
 * `@deepgram/sdk` hands back a reconnecting socket and the provider
 * deliberately keeps the transcript stream alive across a reconnect —
 * ending it on the first blip used to kill the rest of the call. But a
 * reconnect is a NEW Deepgram stream, so its word clock restarts at
 * zero while `inboundStreamMs` keeps climbing. After that the test is
 * false for every segment and barge-in is dead for the remainder of the
 * call: silently, because a segment that fails it is not logged — it
 * falls through to the turn detector, so the caller is still
 * transcribed and still answered, just never able to interrupt.
 *
 * WHY THE EXISTING SUITE COULD NOT CATCH THIS. `test:barge-in`'s fake
 * `transcribeStream` never iterates `request.audio`, so `inboundStreamMs`
 * stays 0 there for the whole run and the comparison is trivially true
 * in every one of its assertions. THE HARNESS BELOW CONSUMES THE AUDIO,
 * which is what makes both clocks real, and models a reconnect the way
 * the transport actually produces one: `reconnectStt()` rebases the
 * reported word times to the audio received since that moment, exactly
 * as a fresh Deepgram stream does.
 *
 * The fix must not buy barge-in back by weakening anything: sections C,
 * D and E are the three protections that must read exactly as they did
 * before — words spoken BEFORE the agent started are still not an
 * interruption, a background voice is still not the caller, and the
 * fixed opening line is still not interruptible.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the
 * conversation memory are all the real ones.
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
// THE HARNESS
//
// Differs from `test:barge-in`'s in exactly one way that matters: the
// fake STT CONSUMES `request.audio`. That is what advances the
// pipeline's `inboundStreamMs`, which is one half of the comparison
// under test — without it the whole clock question is unobservable.
//
// Audio is MULAW/8000, one byte per sample, so a 160-byte frame is
// exactly 20ms and "feed 700ms" means 700ms on both clocks.
// ═════════════════════════════════════════════════════════════════

/** ~22 chars/second is ordinary speech — sizes a fake TTS clip. */
const CHARS_PER_SECOND = 22;
const FRAME_BYTES = 160;
const FRAME_MS = 20;

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
  readonly confidence?: number;
  /**
   * What the TRANSPORT heard when these words were recognised.
   * `"loud"` is the caller talking into the handset (the near-end gate
   * fired); `"quiet"` is a voice the energy VAD does not corroborate —
   * a television, the room, our own echo.
   */
  readonly heardBy?: "loud" | "quiet";
  /**
   * Override the reported word-end time, in the CURRENT STT stream's
   * own clock. Defaults to the live edge of that clock. `0` is what the
   * Deepgram adapter reports for a result carrying no word timings.
   */
  readonly endedAtMs?: number;
  /**
   * Override the reported FIRST-word time, in the CURRENT STT stream's
   * own clock. Defaults to 300ms before `endedAtMs`. `0` is what the
   * Deepgram adapter reports for a result carrying no word timings.
   */
  readonly startedAtMs?: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every state transition the pipeline asked for, with its reason. */
  readonly transitions: Array<{ readonly to: string; readonly reason: string }>;
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Audio (ms) the STT stream has actually consumed — the pipeline's `inboundStreamMs`. */
  audioMs(): number;
  /** The live edge of the CURRENT STT stream's own word clock (rewound by `reconnectStt`). */
  sttClockMs(): number;
  /** Push `ms` of inbound audio and wait until the STT stream has taken all of it. */
  feedAudioMs(ms: number): Promise<void>;
  /** The transport reconnected: the word clock restarts at the audio received from here. */
  reconnectStt(): void;
  say(text: string, opts?: SayOptions): void;
  /** True once a barge-in transition has been asked for — the signal the Vobiz bridge clears playback on. */
  bargedIn(): boolean;
  bargeInCount(): number;
  outboundBytes(): number;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForSpeakingWithAudio(timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  assistantTexts(): string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  const transitions: Array<{ readonly to: string; readonly reason: string }> = [];
  let closed = false;
  let replyIndex = 0;
  let outboundBytes = 0;
  /** Inbound audio the fake STT has taken off the queue, in ms. */
  let audioMsConsumed = 0;
  /** Where the CURRENT STT stream's clock has its zero, on the call-long timeline. */
  let sttClockBaseMs = 0;

  const sttClockNow = (): number => Math.max(0, audioMsConsumed - sttClockBaseMs);

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (request: {
      audio: AsyncIterable<AudioPayload>;
    }): AsyncIterable<TranscriptSegment> {
      // THE POINT OF THIS HARNESS. A real STT provider drains the audio
      // it is handed; the pipeline's byte counter — and therefore
      // `inboundStreamMs` and the SPEAKING-phase snapshot taken from it
      // — only advances because of this loop.
      void (async () => {
        for await (const chunk of request.audio) {
          if (closed) break;
          audioMsConsumed += (chunk.data.byteLength / FRAME_BYTES) * FRAME_MS;
        }
      })();

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
      // greeting plays and abandons the stream at its first event. Not
      // a conversational request: not recorded, consumes no reply.
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
    synthesize: async (task: { request: { text: string } }) => clipFor(task.request.text),
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
    "stt-clock-test" as SessionId,
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
  // Counts what reaches the transport, so a test can wait for playback
  // to have genuinely started rather than for the SPEAKING state alone.
  record.outboundAudioListeners.add((chunk) => {
    outboundBytes += chunk.data.byteLength;
  });

  const host = {
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
      reason?: string,
    ) => {
      transitions.push({ to: String(to), reason: reason ?? "" });
      r.state = to;
    },
    markError: () => undefined,
    end: async () => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      return undefined;
    },
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  // The reason the Vobiz bridge matches on to drop its outbound queue
  // and send `clearAudio` (see `vobiz-media-bridge.ts`). Asserting on it
  // is asserting that the EXISTING barge-in path was entered.
  const isBargeInTransition = (t: { to: string; reason: string }): boolean =>
    t.to === String(SessionState.LISTENING) && /barge.?in/iu.test(t.reason);

  return {
    record,
    transitions,
    requests,
    audioMs: () => audioMsConsumed,
    sttClockMs: () => sttClockNow(),
    async feedAudioMs(ms) {
      const target = audioMsConsumed + ms;
      for (let sent = 0; sent < ms; sent += FRAME_MS) {
        record.inboundAudioFallback.push({
          data: new Uint8Array(FRAME_BYTES),
          encoding: "MULAW",
          sampleRateHz: 8000,
        });
      }
      const deadline = Date.now() + 5_000;
      while (audioMsConsumed < target && Date.now() < deadline) await sleep(5);
      assert.ok(
        audioMsConsumed >= target,
        `the STT stream must consume the audio it is handed (wanted ${target}ms, took ${audioMsConsumed}ms)`,
      );
    },
    reconnectStt() {
      // A fresh Deepgram stream: word times from here on are measured
      // from the audio it receives from this instant, not from the
      // start of the call.
      sttClockBaseMs = audioMsConsumed;
    },
    say(text, opts) {
      const heardBy = opts?.heardBy ?? "loud";
      // Stamped BEFORE the segment reaches the pipeline, which is the
      // order the two arrive in on a real call: the energy VAD fires at
      // 80ms, the transcript lands hundreds of ms later.
      record.lastCallerEnergyAt = heardBy === "loud" ? Date.now() : Date.now() - 30_000;
      record.lastConversationActivityAt = Date.now();
      const endedAtMs = opts?.endedAtMs ?? sttClockNow();
      const isFinal = opts?.isFinal ?? true;
      segments.push({
        text,
        isFinal,
        isSpeechFinal: isFinal,
        confidence: opts?.confidence ?? 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: opts?.startedAtMs ?? Math.max(0, endedAtMs - 300),
        endedAtMs,
      });
      waiters.shift()?.();
    },
    bargedIn: () => transitions.some(isBargeInTransition),
    bargeInCount: () => transitions.filter(isBargeInTransition).length,
    outboundBytes: () => outboundBytes,
    async waitFor(what, predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async waitForSpeakingWithAudio(timeoutMs = 15_000) {
      const before = outboundBytes;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (record.state === SessionState.SPEAKING && outboundBytes > before) return;
        await sleep(10);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for SPEAKING with audio actually queued`);
    },
    async waitForReplies(n, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((t) => t.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(10);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${
          record.memory.history().filter((t) => t.role === "assistant").length
        }, state=${record.state})`,
      );
    },
    assistantTexts: () =>
      record.memory
        .history()
        .filter((t) => t.role === "assistant")
        .map((t) => t.content),
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

const OPENING =
  "Hello Sakshi, this is Rohan calling from FlexiFunnels about the free AI workshop this Sunday.";
/** Long enough that SPEAKING is held open for many seconds by `drainPlayback`. */
const BLOCK =
  "The workshop runs for about two hours and covers how small businesses are using AI to answer customer questions, follow up on leads, and keep their calendars full without hiring anybody new. There is a live demonstration in the second half, and the recording is shared with everyone who attends so nothing is missed.";
const SHORT = "Sure, I will explain.";

/**
 * Gets a fresh call to the point where a LONG reply is in flight and
 * audio is genuinely playing, with a known amount of audio consumed —
 * which is exactly the `speakingStartedAtStreamMs` snapshot, because no
 * audio is fed between the caller's turn and the reply starting.
 *
 * @returns the audio position SPEAKING began at.
 */
async function speakingAfterAudio(h: Harness, audioBeforeTurnMs: number): Promise<number> {
  await h.waitForReplies(1); // the fixed opening line is done
  await h.feedAudioMs(audioBeforeTurnMs);
  h.say("Haan ji, please tell me more about it.");
  await h.waitForSpeakingWithAudio();
  return h.audioMs();
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the harness itself measures what it claims to");
// ═════════════════════════════════════════════════════════════════

await test("the fake STT consumes the audio, so the pipeline's stream clock really advances", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [SHORT] });
  try {
    await h.waitForReplies(1);
    assert.equal(h.audioMs(), 0, "no audio has been fed yet");
    await h.feedAudioMs(1_000);
    assert.equal(h.audioMs(), 1_000, "1000ms fed must be 1000ms consumed");
    await h.feedAudioMs(500);
    assert.equal(h.audioMs(), 1_500, "the clock accumulates across feeds");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — barge-in, before and after the STT stream restarts");
// ═════════════════════════════════════════════════════════════════

await test("BEFORE a reconnect: a real interruption still interrupts, exactly as before", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);
    assert.equal(h.bargedIn(), false, "nothing has interrupted yet");

    await h.feedAudioMs(700);
    h.say("Hello? Are you still there?");

    await h.waitFor("the barge-in transition", () => h.bargedIn());
    assert.equal(h.bargeInCount(), 1, "exactly one barge-in");
    assert.ok(
      (h.assistantTexts()[1] ?? "").length < BLOCK.length,
      "the interrupted block must be committed CUT SHORT, not whole",
    );
  } finally {
    await h.stop();
  }
});

await test("AFTER a reconnect: the same \"Hello?\" still reaches the existing barge-in path", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    const speakingMark = await speakingAfterAudio(h, 5_000);
    assert.ok(speakingMark >= 5_000, "the reply started 5s of audio into the call");

    // The Deepgram socket drops and redials. Its word clock restarts at
    // zero; ours does not. Everything the caller says from here reports
    // a time far BELOW the mark this reply started at.
    h.reconnectStt();
    await h.feedAudioMs(700);

    // The caller, talking over an agent that is audibly speaking. On the
    // rewound clock this is 700ms; the reply began at 5000ms.
    h.say("Hello?");

    await h.waitFor(
      "the barge-in transition after the STT stream restarted",
      () => h.bargedIn(),
    );
    assert.equal(h.bargeInCount(), 1, "exactly one barge-in");
    assert.ok(
      (h.assistantTexts()[1] ?? "").length < BLOCK.length,
      "the reply must be cut short — the caller interrupted it",
    );
  } finally {
    await h.stop();
  }
});

await test("a repeated \"Hello?\" over a later reply still interrupts — the rebase is not one-shot", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);
    h.reconnectStt();
    await h.feedAudioMs(700);
    h.say("Hello?");
    await h.waitFor("the first barge-in", () => h.bargeInCount() === 1);

    // That interruption becomes a turn and is answered, so a SECOND
    // long reply is now playing — on a clock that is still rewound.
    await h.waitForSpeakingWithAudio();
    await h.feedAudioMs(700);
    h.say("Hello? Can you hear me?");

    await h.waitFor("the second barge-in", () => h.bargeInCount() === 2);
  } finally {
    await h.stop();
  }
});

await test("two reconnects in one call are handled, not compounded", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);
    h.reconnectStt();
    await h.feedAudioMs(700);
    h.say("Hello?");
    await h.waitFor("the first barge-in", () => h.bargeInCount() === 1);

    await h.waitForSpeakingWithAudio();

    // The socket cannot redial twice in the same breath — the SDK waits
    // 1-5s before each attempt — so the call runs on for a while first.
    // Something in the room is transcribed during it, which is what
    // carries the clock forward without interrupting anything.
    await h.feedAudioMs(3_000);
    h.say("someone talking on the television", { heardBy: "quiet" });
    await sleep(200);
    assert.equal(h.bargeInCount(), 1, "the room must not have interrupted");

    h.reconnectStt();
    await h.feedAudioMs(700);
    h.say("Hello? Are you there?");

    await h.waitFor("the barge-in after the SECOND reconnect", () => h.bargeInCount() === 2);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — words spoken BEFORE the reply are still not an interruption");
// ═════════════════════════════════════════════════════════════════

await test("a transcript whose words ended before SPEAKING began does NOT interrupt", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    const speakingMark = await speakingAfterAudio(h, 5_000);
    await h.feedAudioMs(700);

    // The caller spoke while we were still THINKING and the transcript
    // only lands now. Destroying the reply for it is the first-turn bug
    // the stream-clock comparison exists to prevent.
    h.say("Hello? Are you there?", { endedAtMs: speakingMark - 500 });

    await sleep(600);
    assert.equal(h.bargedIn(), false, "pre-speaking words must never cancel the reply");
    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], BLOCK, "the block must be committed WHOLE");
  } finally {
    await h.stop();
  }
});

await test("a result carrying NO word timings neither interrupts nor corrupts the clock", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    const speakingMark = await speakingAfterAudio(h, 5_000);
    await h.feedAudioMs(700);

    // The adapter reports `0` for "this result has no word timings",
    // NOT for "the start of the stream". Read as a rewind it would
    // re-base the clock onto the whole call and make every following
    // segment look like an interruption.
    h.say("Umm", { endedAtMs: 0 });
    await sleep(300);
    assert.equal(h.bargedIn(), false, "a result with no timings is not an interruption");

    // The clock must be untouched: pre-speaking words still do not interrupt...
    h.say("Hello? Are you there?", { endedAtMs: speakingMark - 500 });
    await sleep(300);
    assert.equal(h.bargedIn(), false, "and the pre-speaking protection must still hold");

    // ...and a genuine interruption still does.
    h.say("Hello? Can you hear me?");
    await h.waitFor("the genuine interruption", () => h.bargedIn());
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — a background voice is still not the caller");
// ═════════════════════════════════════════════════════════════════

await test("uncorroborated speech does not interrupt — including after a reconnect", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);
    h.reconnectStt();
    await h.feedAudioMs(700);

    // A television, or a second person across the room. Transcribed
    // perfectly; the transport's near-end energy gate does not
    // corroborate it. The rebased clock must not buy it a barge-in.
    h.say("Hello? Are you there?", { heardBy: "quiet" });

    await sleep(600);
    assert.equal(h.bargedIn(), false, "a background voice must not interrupt");
    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], BLOCK, "the block must be committed WHOLE");
    assert.equal(h.requests.length, 1, "and it must not have become a turn for the model to answer");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — the fixed opening line is still not interruptible");
// ═════════════════════════════════════════════════════════════════

await test("\"hello\" as the caller picks up still does not truncate the opening line", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [SHORT] });
  try {
    await h.waitForSpeakingWithAudio();
    await h.feedAudioMs(400);
    h.say("Hello? Who is this?");

    await sleep(500);
    assert.equal(h.bargedIn(), false, "the opening line must never be barged in on");
    await h.waitForReplies(1);
    assert.equal(h.assistantTexts()[0], OPENING, "the opening line must be spoken in full");
  } finally {
    await h.stop();
  }
});

await test("and those words are not lost — they are answered once the opening line finishes", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [SHORT] });
  try {
    await h.waitForSpeakingWithAudio();
    await h.feedAudioMs(400);
    h.say("Hello? Who is this?");

    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], SHORT, "the buffered turn must be answered after the opening line");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — words that BEGAN before the reply are the caller finishing, not interrupting");
// ═════════════════════════════════════════════════════════════════
//
// Deepgram's segments are cumulative within an utterance. A caller who
// was still talking when the reply began keeps extending the utterance
// the reply is answering, so its END crosses the speaking mark a few
// hundred ms in while its START predates it. On live Vobiz calls that
// cut replies off at their first sentence. The guard lives only in
// `interruptionCorroborated`, reads the existing re-base offset, and
// changes nothing when the result carries no word timings.

await test("F1. a segment that STARTED before SPEAKING and ENDED after it does NOT interrupt", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    const speakingMark = await speakingAfterAudio(h, 5_000);
    await h.feedAudioMs(700);

    // Loud, confident, ending 700ms into the reply — everything today's
    // test looks at says "interruption". But the first word was spoken
    // 400ms BEFORE we started: this is the tail of their own turn.
    h.say("please tell me more about it and the timing", {
      startedAtMs: speakingMark - 400,
      endedAtMs: h.sttClockMs(),
    });

    await sleep(600);
    assert.equal(h.bargedIn(), false, "the caller finishing their sentence must not cancel the reply");
    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], BLOCK, "the block must be committed WHOLE");
  } finally {
    await h.stop();
  }
});

await test("F2. a segment that STARTED after SPEAKING still interrupts — a genuine barge-in is untouched", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    const speakingMark = await speakingAfterAudio(h, 5_000);
    await h.feedAudioMs(700);

    h.say("No wait, stop.", { startedAtMs: speakingMark + 200, endedAtMs: h.sttClockMs() });

    await h.waitFor("the barge-in transition", () => h.bargedIn());
    assert.equal(h.bargeInCount(), 1, "exactly one barge-in");
    assert.ok((h.assistantTexts()[1] ?? "").length < BLOCK.length, "the block must be cut short");
  } finally {
    await h.stop();
  }
});

await test("F3. a segment with NO start timing (`startedAtMs` 0) keeps today's behaviour exactly", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);
    await h.feedAudioMs(700);

    // Only the end time is known and it is after the speaking mark —
    // which is the whole of what the existing test evaluates, so it
    // must still interrupt.
    h.say("No wait, stop.", { startedAtMs: 0, endedAtMs: h.sttClockMs() });

    await h.waitFor("the barge-in transition", () => h.bargedIn());
    assert.equal(h.bargeInCount(), 1, "exactly one barge-in");
  } finally {
    await h.stop();
  }
});

await test("F4. after an STT stream reconnect the start time is re-based too — both directions stay correct", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, BLOCK, SHORT] });
  try {
    await speakingAfterAudio(h, 5_000);

    // The word clock rewinds to zero mid-reply. On the raw clock every
    // start time is now tiny and would read as "before SPEAKING"; on the
    // re-based clock this speech began ~100ms after the reconnect, well
    // into the reply — a genuine interruption, and it must still fire.
    h.reconnectStt();
    await h.feedAudioMs(700);
    // (Not a bare "hello" — that is answered by the fixed attention line
    // rather than by the model, and this test needs the SECOND reply to
    // be the long block so it can check that block was not cut.)
    h.say("No wait, one question first.", { startedAtMs: 100, endedAtMs: h.sttClockMs() });
    await h.waitFor("the barge-in after the reconnect", () => h.bargeInCount() === 1);

    // That becomes a turn and a SECOND long reply starts, still on the
    // rewound clock. The caller was already talking when it began: the
    // start predates the new reply's mark on the SAME re-based clock,
    // so this one is their own sentence and must not interrupt.
    await h.waitForSpeakingWithAudio();
    const secondReplyClockMark = h.sttClockMs();
    await h.feedAudioMs(700);
    h.say("and I was also asking about the recording", {
      startedAtMs: Math.max(1, secondReplyClockMark - 400),
      endedAtMs: h.sttClockMs(),
    });
    await sleep(600);
    assert.equal(h.bargeInCount(), 1, "the caller finishing their sentence must not interrupt the second reply");
    await h.waitForReplies(3);
    assert.equal(h.assistantTexts()[2], BLOCK, "the second block must be committed WHOLE");
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
