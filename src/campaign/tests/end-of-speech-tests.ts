/**
 * end-of-speech-tests.ts — `npm run test:end-of-speech`
 *
 * ONE MEASURED DEFECT: DEEPGRAM'S END-OF-SPEECH CLAIM WAS BEING THROWN
 * AWAY, AND EVERY TURN IT HAPPENED ON PAID ~1.0-1.5s FOR IT.
 *
 * `speech_final: true` is set on whichever Results message Deepgram's
 * endpointer fires on. When it has already returned every word of the
 * utterance in an earlier `is_final` message, that message arrives with
 * an EMPTY transcript — the words and the "they have stopped talking"
 * claim come in TWO SEPARATE MESSAGES. The adapter filtered on
 * transcript text (correctly, for interim noise) and so discarded the
 * second one entirely, `speech_final` included.
 *
 * Downstream, `AdaptiveTurnDetector` then only ever saw a final with
 * `speech_final` absent — a CHUNK BOUNDARY, which claims nothing about
 * the caller having stopped. So a finished, fully-punctuated sentence
 * took the slow path:
 *
 *      full adaptive silence window   1100-1600ms
 *   +  chunk-boundary grace             700ms
 *   +  confirmation window              300-550ms
 *   =  2100-2850ms   after the words had already landed
 *
 * instead of the one confirmation window an endpointed complete thought
 * is supposed to get. That is the `stt-to-release` figure of ~3.9s in
 * the production logs, on top of Deepgram's own delivery lag.
 *
 * WHAT THE FIX IS ALLOWED TO DO, AND SECTION A2 IS THE HALF THAT
 * MATTERS: carry the claim through, and shorten the wait for EXACTLY
 * the class `feed` already releases early — an endpointed, interim-free,
 * complete thought. Every other class keeps the window it has today, and
 * a marker that arrives when nothing is being held does nothing at all.
 *
 * SECTION B is the pipeline: a marker is a SIGNAL, not a transcript. It
 * carries no text and no word timings, so it must reach the turn
 * detector's end-of-speech handler and NOTHING else — not the display
 * preview, not a turn, not the barge-in gates — and it must not disturb
 * playback or the adaptive threshold.
 *
 * Timings are wall-clock: the detector arms real `setTimeout`s, so a
 * release is measured the way a caller experiences it. Bounds are
 * asserted as ranges, never as exact values.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE.
 */

import assert from "node:assert/strict";

const { AdaptiveTurnDetector } = await import("../../core/session/turn-detection");
const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, TranscriptSegment } from "../../types/provider.types";
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

/** The detector's own documented windows, restated so a drift shows up here. */
const SILENCE_WINDOW_MS = 1_100;
const CONFIRMATION_MS = 300;
const OPEN_ENDED_CONFIRMATION_MS = 550;
const CHUNK_BOUNDARY_GRACE_MS = 700;
const CONTINUATION_GRACE_MS = 800;

/** Timer slack: a real `setTimeout` chain can only ever run late. */
const EARLY = 120;
const LATE = 450;

function within(actual: number, expected: number, what: string): void {
  assert.ok(
    actual >= expected - EARLY && actual <= expected + LATE,
    `${what}: expected ~${expected}ms (-${EARLY}/+${LATE}), measured ${actual}ms`,
  );
}

// ═════════════════════════════════════════════════════════════════
// SECTION A — the detector, in isolation
// ═════════════════════════════════════════════════════════════════

interface FedItem {
  readonly text: string;
  readonly isFinal?: boolean;
  readonly isSpeechFinal?: boolean;
  /** Feed a standalone end-of-speech MARKER instead of a segment. */
  readonly marker?: true;
  /** Wall-clock pause before this item, so a timer can fire between two of them. */
  readonly afterMs?: number;
}

/**
 * Feeds one utterance and reports how long the detector held it before
 * releasing, measured from the moment the LAST item was fed — exactly
 * the span `stt-to-release` covers after Deepgram's own lag.
 */
async function releaseDelayMs(
  items: readonly FedItem[],
  timeoutMs = 8_000,
): Promise<{ delayMs: number; text: string; silenceTimeoutMs: number }> {
  const detector = new AdaptiveTurnDetector();
  let fedAt = 0;
  let streamMs = 0;

  const released = new Promise<{ delayMs: number; text: string; silenceTimeoutMs: number }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no turn released within ${timeoutMs}ms`)),
        timeoutMs,
      );
      detector.onTurnEnd((event) => {
        clearTimeout(timer);
        resolve({
          delayMs: Date.now() - fedAt,
          text: event.text,
          silenceTimeoutMs: detector.getCurrentSilenceTimeoutMs(),
        });
      });
    },
  );

  for (const item of items) {
    if (item.afterMs !== undefined) await sleep(item.afterMs);
    if (item.marker) {
      detector.noteEndOfSpeech();
      fedAt = Date.now();
      continue;
    }
    streamMs += 1_000;
    detector.feed({
      text: item.text,
      isFinal: item.isFinal ?? true,
      confidence: 0.95,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: streamMs - 1_000,
      endedAtMs: streamMs,
      ...(item.isSpeechFinal === undefined ? {} : { isSpeechFinal: item.isSpeechFinal }),
    });
    fedAt = Date.now();
  }

  return released;
}

/** The production shape: the words arrive with `speech_final` ABSENT, the endpoint follows. */
const MARKER_GAP_MS = 150;
const wordsThenMarker = (text: string): readonly FedItem[] => [
  { text, isSpeechFinal: false },
  { text: "", marker: true, afterMs: MARKER_GAP_MS },
];

section("A. THE DETECTOR — the endpoint claim now arrives, and only shortens what it may");

// ── A1. What got faster ──────────────────────────────────────────

await test(
  "A1. a complete thought whose endpoint arrives SEPARATELY releases on the confirmation window",
  async () => {
    const { delayMs, text } = await releaseDelayMs(
      wordsThenMarker("I am going to attend the session."),
    );
    assert.equal(text, "I am going to attend the session.");
    // The marker lands mid-silence-window and re-arms to one
    // confirmation window; `emitTurnEnd` then applies the post-speech
    // confirmation for this text exactly as it does on the fast path.
    within(delayMs, CONFIRMATION_MS * 2, "complete thought, endpoint delivered separately");
    assert.ok(
      delayMs < SILENCE_WINDOW_MS,
      `the silence window must no longer be paid once the endpoint is known: measured ${delayMs}ms`,
    );
  },
);

await test(
  "A1b. the same turn WITHOUT the marker is unchanged — this is the defect, measured",
  async () => {
    const { delayMs } = await releaseDelayMs([
      { text: "I am going to attend the session.", isSpeechFinal: false },
    ]);
    within(
      delayMs,
      SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS + CONFIRMATION_MS,
      "chunk-boundary final with no endpoint claim",
    );
  },
);

await test("A1c. the marker is worth at least 900ms on that turn", async () => {
  const withMarker = await releaseDelayMs(wordsThenMarker("Yes I would like to attend today."));
  const without = await releaseDelayMs([
    { text: "Yes I would like to attend today.", isSpeechFinal: false },
  ]);
  const saved = without.delayMs - withMarker.delayMs;
  assert.ok(
    saved >= 900,
    `expected at least 900ms saved, measured ${saved}ms (${without.delayMs} -> ${withMarker.delayMs})`,
  );
});

await test("A1d. a short endpointed confirmation delivered in two messages releases at once", async () => {
  const { delayMs, text } = await releaseDelayMs(wordsThenMarker("Haan."));
  assert.equal(text, "Haan.");
  within(delayMs, CONFIRMATION_MS, "short complete turn, endpoint delivered separately");
});

// ── A2. What did NOT get faster, and must not ────────────────────

await test("A2. a MID-THOUGHT turn still gets the full silence window and its graces", async () => {
  const { delayMs, text } = await releaseDelayMs(
    wordsThenMarker("I was going to ask about the timing and"),
  );
  assert.equal(text, "I was going to ask about the timing and");
  assert.ok(
    delayMs > SILENCE_WINDOW_MS,
    `an unfinished thought must still be given room even once endpointed: measured ${delayMs}ms`,
  );
  // The chunk-boundary grace is correctly gone — Deepgram DID declare
  // end of speech — but both continuation graces remain. Measured from
  // the marker, so the silence window is short by the gap before it.
  within(
    delayMs,
    SILENCE_WINDOW_MS - MARKER_GAP_MS + CONTINUATION_GRACE_MS * 2 + CONFIRMATION_MS,
    "dangling-conjunction turn with a separate endpoint",
  );
});

await test("A2b. an UNPUNCTUATED turn still gets the full silence window", async () => {
  const { delayMs } = await releaseDelayMs(wordsThenMarker("the timing is what I wanted to know"));
  assert.ok(
    delayMs >= SILENCE_WINDOW_MS - MARKER_GAP_MS - EARLY,
    `no sentence-final punctuation must keep the silence window: measured ${delayMs}ms`,
  );
  within(
    delayMs,
    SILENCE_WINDOW_MS - MARKER_GAP_MS + OPEN_ENDED_CONFIRMATION_MS,
    "endpointed-by-marker turn with no sentence-final punctuation",
  );
});

await test("A2c. an OUTSTANDING INTERIM still holds the turn, marker or not", async () => {
  const { delayMs, text } = await releaseDelayMs([
    { text: "Yes that is right.", isSpeechFinal: false },
    { text: "and one more thing", isFinal: false },
    { text: "", marker: true, afterMs: 100 },
  ]);
  assert.equal(text, "Yes that is right.", "interim text must never be made into a turn");
  assert.ok(
    delayMs >= SILENCE_WINDOW_MS - 100 - EARLY,
    `words Deepgram has shown but not finalised must be waited for: measured ${delayMs}ms`,
  );
});

await test("A2d. a filler-only utterance is still dropped rather than answered", async () => {
  const { text } = await releaseDelayMs([
    { text: "Hmm.", isSpeechFinal: false },
    { text: "", marker: true, afterMs: 100 },
    { text: "Okay I will attend.", isSpeechFinal: true, afterMs: SILENCE_WINDOW_MS + 800 },
  ]);
  assert.equal(text, "Okay I will attend.", "the hesitation must be dropped, not answered");
});

await test("A2e. a hold phrase is still given its grace, not released", async () => {
  const { delayMs } = await releaseDelayMs(wordsThenMarker("Wait."));
  assert.ok(
    delayMs > SILENCE_WINDOW_MS,
    `a caller who asked for a moment must get one: measured ${delayMs}ms`,
  );
});

await test("A2f. a marker cannot shorten a confirmation window that is already running", async () => {
  // The words arrive already endpointed, so the fast path arms the
  // confirmation window itself. A marker landing inside it must be
  // inert: this is the in-flight-speech check, and it is 300ms.
  const { delayMs } = await releaseDelayMs([
    { text: "Yes I would like to attend the session today.", isSpeechFinal: true },
    { text: "", marker: true, afterMs: 120 },
  ]);
  assert.ok(
    delayMs >= CONFIRMATION_MS - 120 - EARLY,
    `the confirmation window must run its course: measured ${delayMs}ms after the marker`,
  );
});

// ── A3. A marker on its own is inert ─────────────────────────────

await test("A3. a marker with nothing held releases nothing and throws nothing", () => {
  const detector = new AdaptiveTurnDetector();
  let released = 0;
  detector.onTurnEnd(() => {
    released += 1;
  });
  detector.noteEndOfSpeech();
  detector.noteEndOfSpeech();
  assert.equal(released, 0, "an end-of-speech marker must never invent a turn");
});

await test("A3b. a marker never moves the adaptive silence threshold", async () => {
  const detector = new AdaptiveTurnDetector();
  const before = detector.getCurrentSilenceTimeoutMs();
  detector.feed({
    text: "I am going to attend.",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 1_000,
    endedAtMs: 2_000,
  });
  detector.noteEndOfSpeech();
  detector.noteEndOfSpeech();
  assert.equal(
    detector.getCurrentSilenceTimeoutMs(),
    before,
    "a text-less marker carries no word timings, so it must not be read as an inter-final gap",
  );
  // ...and the NEXT real final must not measure its gap back to a zero.
  const { silenceTimeoutMs } = await releaseDelayMs([
    { text: "One thing", isSpeechFinal: false },
    { text: "", marker: true, afterMs: 50 },
    { text: "and that is all.", isSpeechFinal: true, afterMs: 50 },
  ]);
  assert.ok(
    silenceTimeoutMs <= 1_600,
    `the threshold must stay inside its documented bounds: ${silenceTimeoutMs}ms`,
  );
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — the pipeline
//
// Same harness shape as `test:stt-clock`: the fake STT CONSUMES
// `request.audio`, so `inboundStreamMs` and the SPEAKING-phase snapshot
// taken from it are real. Audio is MULAW/8000 — one byte per sample, so
// a 160-byte frame is exactly 20ms.
// ═════════════════════════════════════════════════════════════════

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

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  feedAudioMs(ms: number): Promise<void>;
  /** A real transcript segment, as Deepgram delivers the words. */
  say(text: string, opts?: { isSpeechFinal?: boolean; isFinal?: boolean }): void;
  /** The standalone end-of-speech marker: no text, no word timings. */
  markEndOfSpeech(): void;
  bargedIn(): boolean;
  outboundBytes(): number;
  liveTranscript(): string;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  assistantTexts(): string[];
  userTexts(): string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
}): Harness {
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  const transitions: Array<{ readonly to: string; readonly reason: string }> = [];
  let closed = false;
  let replyIndex = 0;
  let outboundBytes = 0;
  let audioMsConsumed = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (request: {
      audio: AsyncIterable<AudioPayload>;
    }): AsyncIterable<TranscriptSegment> {
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
    generateCompletion: async () => ({
      turn: { role: "assistant" as const, content: "", timestamp: new Date() },
      latencyMs: 0,
    }),
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
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
    "end-of-speech-test" as SessionId,
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

  const pipeline = new ConversationPipeline(
    record,
    { telephony, stt, llm, tts } as never,
    host as never,
  );
  const loop = pipeline.run();

  // The reason the Vobiz bridge matches on to drop its outbound queue
  // and send `clearAudio` (see `vobiz-media-bridge.ts`).
  const isBargeInTransition = (t: { to: string; reason: string }): boolean =>
    t.to === String(SessionState.LISTENING) && /barge.?in/iu.test(t.reason);

  return {
    record,
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
    },
    say(text, opts) {
      record.lastCallerEnergyAt = Date.now();
      record.lastConversationActivityAt = Date.now();
      const isFinal = opts?.isFinal ?? true;
      segments.push({
        text,
        isFinal,
        isSpeechFinal: opts?.isSpeechFinal ?? false,
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: Math.max(0, audioMsConsumed - 300),
        endedAtMs: audioMsConsumed,
      });
      waiters.shift()?.();
    },
    markEndOfSpeech() {
      // Byte-for-byte the shape the Deepgram adapter emits.
      segments.push({
        text: "",
        isFinal: true,
        isSpeechFinal: true,
        isEndOfSpeechMarker: true,
        confidence: 0,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: 0,
        endedAtMs: 0,
      });
      waiters.shift()?.();
    },
    bargedIn: () => transitions.some(isBargeInTransition),
    outboundBytes: () => outboundBytes,
    liveTranscript: () => record.liveUserTranscript,
    async waitFor(what, predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(5);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
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
    userTexts: () =>
      record.memory
        .history()
        .filter((t) => t.role === "user")
        .map((t) => t.content),
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

const OPENING = "Hello Sakshi, this is Rohan calling from FlexiFunnels about the free AI workshop.";
const BLOCK =
  "The workshop runs for about two hours and covers how small businesses are using AI to answer customer questions, follow up on leads, and keep their calendars full without hiring anybody new.";

section("B. THE PIPELINE — a marker is a signal, and reaches nothing else");

await test("B1. the words are answered, and the marker never becomes a turn of its own", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure, I will explain."] });
  try {
    await h.waitForReplies(1);
    await h.feedAudioMs(600);
    h.say("I am going to attend the session.", { isSpeechFinal: false });
    h.markEndOfSpeech();
    await h.waitForReplies(2);

    assert.deepEqual(h.userTexts(), ["I am going to attend the session."]);
    assert.equal(
      h.assistantTexts().length,
      2,
      `the marker must not produce a second reply: ${JSON.stringify(h.assistantTexts())}`,
    );
  } finally {
    await h.stop();
  }
});

await test("B2. the marker measurably shortens turn release inside the real pipeline", async () => {
  const runOnce = async (withMarker: boolean): Promise<number> => {
    const h = startHarness({ openingLine: OPENING, replies: ["Sure, I will explain."] });
    try {
      await h.waitForReplies(1);
      await h.feedAudioMs(600);
      const fedAt = Date.now();
      h.say("I am going to attend the session.", { isSpeechFinal: false });
      if (withMarker) {
        await sleep(MARKER_GAP_MS);
        h.markEndOfSpeech();
      }
      await h.waitFor(
        "the turn to be released (the pipeline leaves LISTENING)",
        () => h.record.state !== SessionState.LISTENING,
      );
      return Date.now() - fedAt;
    } finally {
      await h.stop();
    }
  };

  const withMarker = await runOnce(true);
  const without = await runOnce(false);
  const saved = without - withMarker;
  assert.ok(
    saved >= 900,
    `expected at least 900ms saved end to end, measured ${saved}ms (${without} -> ${withMarker})`,
  );
});

await test("B3. a marker never interrupts a reply that is playing", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await h.waitForReplies(1);
    await h.feedAudioMs(600);
    h.say("Tell me more.", { isSpeechFinal: true });
    await h.waitFor(
      "the agent to be speaking its block",
      () => h.record.state === SessionState.SPEAKING,
    );

    const bytesBefore = h.outboundBytes();
    for (let i = 0; i < 5; i += 1) {
      h.markEndOfSpeech();
      await sleep(30);
    }
    assert.equal(h.bargedIn(), false, "an end-of-speech marker must never trigger a barge-in");
    assert.ok(h.outboundBytes() >= bytesBefore, "playback must not be discarded by a marker");

    // ...and the reply still completes normally.
    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      BLOCK,
      "the whole block must still be committed after a marker storm",
    );
    assert.equal(h.bargedIn(), false, "still no barge-in once the reply has finished");
  } finally {
    await h.stop();
  }
});

await test("B4. a marker never reaches the display preview", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure, I will explain."] });
  try {
    await h.waitForReplies(1);
    await h.feedAudioMs(600);
    h.say("So the timing", { isFinal: false, isSpeechFinal: false });
    await h.waitFor("the preview to show the interim", () => h.liveTranscript().length > 0);
    const preview = h.liveTranscript();
    h.markEndOfSpeech();
    await sleep(120);
    assert.equal(
      h.liveTranscript(),
      preview,
      "a text-less marker must neither blank nor overwrite the live transcript",
    );
  } finally {
    await h.stop();
  }
});

await test("B5. a caller who keeps talking after a marker is still heard, and answered once", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure.", "Of course."] });
  try {
    await h.waitForReplies(1);
    await h.feedAudioMs(600);
    h.say("I wanted to ask", { isSpeechFinal: false });
    h.markEndOfSpeech();
    await sleep(80);
    h.say("what time the session starts.", { isSpeechFinal: true });
    await h.waitForReplies(2);
    assert.deepEqual(
      h.userTexts(),
      ["I wanted to ask what time the session starts."],
      "the marker must not split one utterance into two turns",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
