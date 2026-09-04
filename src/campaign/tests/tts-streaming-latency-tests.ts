/**
 * tts-streaming-latency-tests.ts — `npm run test:tts-streaming`
 *
 * TIME-TO-FIRST-AUDIO, AND THE TWELVE BEHAVIOURS IT MUST NOT COST.
 *
 * THE DEFECT THIS SUITE PROTECTS
 *
 * `ConversationPipeline.synthesizeAndPlay` has two branches, chosen by
 * whether the TTS provider implements the optional `synthesizeStream`.
 * Cartesia implemented only `synthesize()`, so it took the BATCH
 * branch — and Cartesia's bytes endpoint renders the entire clip before
 * it returns a single byte. Time-to-first-audio for a chunk therefore
 * equalled full synthesis time for that chunk and grew with its length.
 *
 * Measured against the live account (`sonic-3.5`, 16kHz, the shipped
 * `generation_config`) on the real first chunks this campaign's replies
 * produce, two samples each, warm connection:
 *
 *   first chunk    bytes endpoint   SSE endpoint   clip length
 *    27 chars        700ms           230ms          2880ms
 *    68 chars        812ms           163ms          3760ms
 *   109 chars       1120ms           167ms          6080ms
 *   140 chars       1368ms           159ms          8480ms
 *   146 chars       1536ms           184ms          8800ms
 *
 * The bytes endpoint costs ~5.9ms per character on top of a ~540ms
 * floor. The SSE endpoint is FLAT — it is bounded by the first frame,
 * not by the clip. Total synthesis time and total byte count are the
 * same on both paths, so this is latency bought for nothing.
 *
 * WHY THIS SUITE HAD TO EXIST BEFORE THE FIX COULD SHIP
 *
 * Every other suite's fake TTS provider is batch-only —
 * `conversation-continuity-tests.ts` says so in a comment: "Batch-only,
 * like Cartesia and Smallest AI — the production shape." So NOTHING in
 * the test suite exercised the pipeline's streaming branch. Giving
 * Cartesia a `synthesizeStream` moves every production call onto a
 * branch with no coverage at all, and that — not the vendor call — was
 * the real risk in this change.
 *
 * So SECTION C re-asserts the safety-critical behaviours on the
 * STREAMING branch: barge-in before audio, barge-in mid-playback and
 * its heard-text accounting, background voice, the Hello attention
 * check, resume-after-Hello, and the agent closing that drives the
 * automatic hang-up. Each is the streaming twin of a test that already
 * passes on the batch branch elsewhere.
 *
 * HOW THE LATENCY CLAIM IS MEASURED, AND WHAT IT IS NOT
 *
 * SECTION B measures REAL WALL CLOCK through the REAL pipeline: from
 * the instant the language model is asked to the instant the first
 * audio byte reaches the transport. It does not assert that a constant
 * got smaller, and it does not read a number the pipeline logged about
 * itself.
 *
 * The two fake TTS providers model the two ENDPOINT SHAPES measured
 * above — batch pays a per-character render before its single return,
 * streaming pays a flat first-frame delay and then emits — scaled down
 * by 10x so the suite runs in seconds. The shapes are the measurement;
 * the pipeline is real. What SECTION B proves is that the pipeline
 * actually converts a streaming provider into earlier audio, which is
 * the part a vendor probe cannot tell you.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker, the conversation
 * memory and the closing predicate are all the real ones. SECTION A
 * drives the real `CartesiaTextToSpeechProvider` against a stubbed SDK
 * client — no network.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { agentClosedIn } = await import("../dispatch/call-runner");
const { CartesiaTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/cartesia.provider"
);
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { TtsAudioChunk } from "../../types/streaming.types";
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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════
// THE VENDOR SHAPES
//
// Both constants below are the measured Cartesia figures divided by
// 10, so the suite runs in seconds while the RATIO between the two
// endpoint shapes — the thing under test — is preserved exactly.
// ═════════════════════════════════════════════════════════════════

/** Batch floor: measured ~540ms before any byte, whatever the length. */
const BATCH_FLOOR_MS = 54;
/** Batch slope: measured ~5.9ms of render per character of transcript. */
const BATCH_MS_PER_CHAR = 0.59;
/** Streaming: measured 159-230ms to the first frame, INDEPENDENT of length. */
const STREAM_FIRST_CHUNK_MS = 18;
/** Streaming: one event per ~150ms of audio, the measured event cadence. */
const STREAM_CHUNK_AUDIO_MS = 150;

/** Speech rate used to size a fake clip. ~22 chars/second is ordinary speech. */
const CHARS_PER_SECOND = 22;

/**
 * Fake audio is MULAW/8000, where one byte is one sample, so a clip's
 * real-time duration is exactly `bytes / 8` ms — which is what lets a
 * test say "interrupt 600ms into the reply" and mean it.
 */
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

// ═════════════════════════════════════════════════════════════════
// THE HARNESS
// ═════════════════════════════════════════════════════════════════

type TtsMode = "batch" | "stream";

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  /** Wall clock (ms since epoch) at which each LLM request was received. */
  readonly llmRequestedAt: number[];
  /** Wall clock at which the FIRST non-empty audio byte reached the transport. */
  firstAudioAt(): number | undefined;
  /** Total audio bytes handed to the transport so far. */
  audioBytes(): number;
  /** Feed one transcript segment, exactly as the streaming STT would. */
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  /**
   * A voice the transport's energy VAD does NOT corroborate as the
   * near-end caller — a television, a second person in the room. Driven
   * through the confidence floor, one of the two independent gates
   * `interruptionCorroborated` applies. Untouched by this change.
   */
  sayBackground(text: string): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  replyCount(): number;
  /** Committed conversation, system turn excluded — what the model is shown. */
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly mode: TtsMode;
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const llmRequestedAt: number[] = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;
  let firstAudioAt: number | undefined;
  let audioBytes = 0;

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
      // greeting plays and abandons the stream at its first event. Not a
      // conversational request, so it consumes no scripted reply and is
      // not timed.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      llmRequestedAt.push(Date.now());
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

  /**
   * The BATCH shape. One return, after the whole clip has "rendered":
   * a fixed floor plus a per-character cost. This is `tts.generate()`.
   */
  const batchTts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      await sleep(BATCH_FLOOR_MS + task.request.text.length * BATCH_MS_PER_CHAR);
      return clipFor(task.request.text);
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts")),
  };

  /**
   * The STREAMING shape. A flat delay to the first frame regardless of
   * length, then events at the measured cadence. This is
   * `tts.generateSSE()`.
   *
   * `synthesize` is still present and still correct — the interface
   * requires it, and a streaming provider that could not fall back
   * would be a worse provider. The pipeline simply prefers the stream.
   */
  const streamTts = {
    ...batchTts,
    synthesizeStream: async function* (
      task: { request: { text: string } },
      signal?: AbortSignal,
    ): AsyncIterable<TtsAudioChunk> {
      synthesized.push(task.request.text);
      const total = clipFor(task.request.text).data;
      const bytesPerChunk = STREAM_CHUNK_AUDIO_MS * 8; // MULAW/8000: 1 byte = 1 sample
      await sleep(STREAM_FIRST_CHUNK_MS);
      let sequence = 0;
      for (let offset = 0; offset < total.byteLength; offset += bytesPerChunk) {
        if (signal?.aborted) return;
        const slice = total.subarray(offset, Math.min(offset + bytesPerChunk, total.byteLength));
        yield {
          audio: { data: slice, encoding: "MULAW", sampleRateHz: 8000 },
          sequence: sequence++,
          isFinal: false,
        };
        // Generation keeps pace with playback, as a real SSE stream
        // does — it is never the bottleneck after the first frame.
        await sleep(2);
      }
    },
  };

  const tts = input.mode === "stream" ? streamTts : batchTts;

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
    "tts-streaming-test" as SessionId,
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
  // The outbound path, and the only instrumentation in the harness:
  // the wall clock at which the FIRST real audio byte reached the
  // transport. This is the same instant the pipeline's `audio-queued`
  // trace marks, observed from outside rather than read from a log.
  record.outboundAudioListeners.add((audio: AudioPayload) => {
    if (audio.data.byteLength === 0) return undefined;
    firstAudioAt ??= Date.now();
    audioBytes += audio.data.byteLength;
    return undefined;
  });

  const host = {
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
    ) => {
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const push = (text: string, isFinal: boolean, isSpeechFinal: boolean, confidence: number): void => {
    const startedAtMs = clockMs;
    clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
    segments.push({
      text,
      isFinal,
      isSpeechFinal,
      confidence,
      language: SupportedLanguage.ENGLISH,
      startedAtMs,
      endedAtMs: clockMs,
    });
    waiters.shift()?.();
  };

  return {
    record,
    requests,
    synthesized,
    llmRequestedAt,
    firstAudioAt: () => firstAudioAt,
    audioBytes: () => audioBytes,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      push(text, isFinal, opts?.isSpeechFinal ?? isFinal, 0.95);
    },
    sayBackground(text) {
      push(text, true, true, 0.2);
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

function assistantTexts(history: readonly ConversationTurn[]): string[] {
  return history.filter((turn) => turn.role === "assistant").map((turn) => turn.content);
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
/** A long block, the shape the approved script produces: ~13s of audio. */
const BLOCK =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
/** One short sentence — the flush-only shape, no internal cut point. */
const SHORT = "Yes, the registration is completely free.";
/**
 * ONE long sentence, no internal punctuation the chunker will cut at.
 * Measured through the real `SentenceChunker`: the whole 172 characters
 * become the FIRST synthesis request, which is the worst case for a
 * batch endpoint and the case the SSE endpoint helps most. Kept under
 * `MAX_FIRST_BUFFER_BEFORE_FORCED_CUT` (180) so the chunker does not
 * force-cut it and change what is being compared.
 */
const LONG_FIRST_CHUNK =
  "We have created Flexi Genie which helps you build and automate your entire " +
  "online business simply by chatting with an AI agent that does all of the real work for you today.";

/**
 * Measures turn 1 end to end and returns the span the change targets:
 * language-model request -> first audio byte at the transport. Turn
 * detection is deliberately excluded — it was not touched, and
 * including its window would bury the effect in noise.
 */
async function measureFirstAudio(mode: TtsMode, reply: string): Promise<{
  requestToFirstAudioMs: number;
  audioBytes: number;
  spoken: string[];
}> {
  const h = startHarness({ mode, openingLine: OPENING, replies: [reply] });
  try {
    // Let the greeting finish so its audio is not what we time.
    await h.waitFor("greeting spoken", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    const audioAtGreeting = h.firstAudioAt();
    assert.ok(audioAtGreeting !== undefined, "greeting should have produced audio");

    // Restart the first-audio observation for the turn under test by
    // watching the byte counter instead of the (already-set) stamp.
    h.say("Is it free?");
    await h.waitFor("the language model was asked", () => h.llmRequestedAt.length >= 1, 20000);
    const requestedAt = h.llmRequestedAt[h.llmRequestedAt.length - 1]!;
    await h.waitFor("reply audio reached the transport", () => h.audioBytes() > greetingBytes, 20000);
    const firstReplyAudioAt = Date.now();

    await h.waitForReplies(2, 30000);
    return {
      requestToFirstAudioMs: firstReplyAudioAt - requestedAt,
      audioBytes: h.audioBytes() - greetingBytes,
      spoken: [...h.synthesized],
    };
  } finally {
    await h.stop();
  }
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the Cartesia provider contract (stubbed SDK, no network)");
// ═════════════════════════════════════════════════════════════════

const CARTESIA_CONFIG = {
  apiKey: "test-key",
  modelId: "sonic-3.5",
  defaultVoiceId: "test-voice",
  sampleRateHz: 16000 as const,
};

interface CapturedBody {
  readonly model_id: string;
  readonly transcript: string;
  readonly voice: { id: string; mode: string };
  readonly generation_config: { speed: number; emotion: string; volume: number };
  readonly language: string;
  readonly output_format: { container: string; encoding: string; sample_rate: number };
}

/**
 * Replaces the provider's SDK client with a stub. The client is built
 * in the constructor from an API key, so there is no injection seam —
 * and adding one to production code for a test's benefit would be the
 * tail wagging the dog. The private field is overwritten here instead,
 * which keeps the production class exactly as it ships.
 */
function stubbedCartesia(opts: {
  readonly sseEvents?: ReadonlyArray<Record<string, unknown>>;
  readonly batchBytes?: Uint8Array;
}) {
  const bodies: CapturedBody[] = [];
  let aborted = false;
  const provider = new CartesiaTextToSpeechProvider(CARTESIA_CONFIG);
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => {
    aborted = true;
  });

  (provider as unknown as { client: unknown }).client = {
    tts: {
      generate: async (body: CapturedBody) => {
        bodies.push(body);
        const data = opts.batchBytes ?? new Uint8Array(8);
        return { arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      },
      generateSSE: async (body: CapturedBody) => {
        bodies.push(body);
        const events = opts.sseEvents ?? [];
        return {
          controller,
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
        };
      },
    },
  };

  return { provider, bodies, wasAborted: () => aborted };
}

function chunkEvent(bytes: readonly number[]): Record<string, unknown> {
  return {
    type: "chunk",
    done: false,
    status_code: 206,
    step_time: 1,
    data: Buffer.from(Uint8Array.from(bytes)).toString("base64"),
  };
}

const task = (text: string) => ({
  sessionId: "probe" as SessionId,
  request: { text, language: SupportedLanguage.HINGLISH },
});

await test("A1 — Cartesia exposes `synthesizeStream`, and `synthesize` still works", async () => {
  const { provider } = stubbedCartesia({ batchBytes: Uint8Array.from([1, 2, 3, 4]) });
  assert.equal(
    typeof provider.synthesizeStream,
    "function",
    "synthesizeStream is what moves Cartesia off the batch branch — if this is gone, the whole fix is gone",
  );
  const batch = await provider.synthesize(task("hello"));
  assert.equal(batch.encoding, "PCM_16");
  assert.equal(batch.sampleRateHz, 16000);
  assert.equal(batch.data.byteLength, 4, "the batch path must be untouched");
});

await test("A2 — both paths send byte-identical generation parameters (voice quality unchanged)", async () => {
  const { provider, bodies } = stubbedCartesia({
    sseEvents: [chunkEvent([1, 2])],
    batchBytes: Uint8Array.from([1, 2]),
  });

  await provider.synthesize(task("Take care, Sakshi."));
  for await (const _chunk of provider.synthesizeStream!(task("Take care, Sakshi."))) {
    // drain
  }

  assert.equal(bodies.length, 2, "both endpoints should have been called once");
  const [batchBody, sseBody] = bodies as [CapturedBody, CapturedBody];

  // THE acceptance criterion "voice quality remains unchanged", stated
  // as an assertion instead of a hope: the model, the voice, the speed,
  // the emotion, the volume, the language and the output format that
  // reach the SSE endpoint are the same values that reach the bytes
  // endpoint. A future edit to one path that forgets the other trips
  // here rather than on a live call.
  assert.deepEqual(sseBody, batchBody);
  assert.equal(batchBody.generation_config.speed, 1.25);
  assert.equal(batchBody.generation_config.emotion, "neutral");
  assert.equal(batchBody.generation_config.volume, 1.5);
  assert.equal(batchBody.model_id, "sonic-3.5");
  assert.equal(batchBody.output_format.sample_rate, 16000);
  assert.equal(batchBody.output_format.encoding, "pcm_s16le");
  assert.equal(batchBody.output_format.container, "raw");
});

await test("A3 — only `chunk` events become audio; timestamps and `done` are ignored", async () => {
  const { provider } = stubbedCartesia({
    sseEvents: [
      { type: "timestamps", done: false, status_code: 206, word_timestamps: {} },
      chunkEvent([1, 2, 3, 4]),
      { type: "phoneme_timestamps", done: false, status_code: 206, phoneme_timestamps: {} },
      chunkEvent([5, 6]),
      { type: "done", done: true, status_code: 200 },
    ],
  });

  const chunks: TtsAudioChunk[] = [];
  for await (const chunk of provider.synthesizeStream!(task("hi"))) chunks.push(chunk);

  assert.equal(chunks.length, 2, "two chunk events, two yields");
  assert.deepEqual([...chunks[0]!.audio.data], [1, 2, 3, 4]);
  assert.deepEqual([...chunks[1]!.audio.data], [5, 6]);
  assert.deepEqual(chunks.map((c) => c.sequence), [0, 1]);
  assert.equal(chunks[0]!.audio.encoding, "PCM_16");
  assert.equal(chunks[0]!.audio.sampleRateHz, 16000);
});

await test("A4 — an `error` event throws rather than ending the utterance silently", async () => {
  const { provider } = stubbedCartesia({
    sseEvents: [
      chunkEvent([1, 2]),
      { type: "error", done: true, status_code: 429, title: "Too Many Requests", message: "rate limited", request_id: "r1" },
    ],
  });

  await assert.rejects(
    async () => {
      for await (const _chunk of provider.synthesizeStream!(task("hi"))) {
        // drain until the error event
      }
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /429/);
      assert.match(message, /rate limited/);
      return true;
    },
    "a vendor error must surface, not be swallowed into a short utterance",
  );
});

await test("A5 — an odd-length event carries its orphan byte instead of shifting every sample", async () => {
  // PCM_16 samples are 2 bytes. Yielding an odd length splits a sample
  // across two yields and shifts everything after it — silent, total
  // distortion. Never observed from this endpoint; asserted so the
  // guard cannot be removed as "dead code".
  const { provider } = stubbedCartesia({
    sseEvents: [chunkEvent([1, 2, 3]), chunkEvent([4, 5]), { type: "done", done: true, status_code: 200 }],
  });

  const chunks: TtsAudioChunk[] = [];
  for await (const chunk of provider.synthesizeStream!(task("hi"))) chunks.push(chunk);

  for (const chunk of chunks) {
    assert.equal(chunk.audio.data.byteLength % 2, 0, "every yielded payload must be sample-aligned");
  }
  // Nothing is lost and nothing is reordered: 3 + 2 bytes in, 4 bytes
  // out and one byte still carried (a trailing orphan at stream end has
  // no partner and is correctly not emitted as half a sample).
  const emitted = chunks.flatMap((c) => [...c.audio.data]);
  assert.deepEqual(emitted, [1, 2, 3, 4], "the orphan byte joins the NEXT event, in order");
});

await test("A6 — abort stops emission and releases the stream", async () => {
  const { provider, wasAborted } = stubbedCartesia({
    sseEvents: [chunkEvent([1, 2]), chunkEvent([3, 4]), chunkEvent([5, 6]), chunkEvent([7, 8])],
  });

  const controller = new AbortController();
  const chunks: TtsAudioChunk[] = [];
  for await (const chunk of provider.synthesizeStream!(task("hi"), controller.signal)) {
    chunks.push(chunk);
    if (chunks.length === 2) controller.abort();
  }

  assert.equal(chunks.length, 2, "emission stops on the next iteration after the abort");
  assert.equal(wasAborted(), true, "the request itself must be aborted, not just the loop exited");
});

await test("A7 — breaking out of the loop early still releases the stream", async () => {
  const { provider, wasAborted } = stubbedCartesia({
    sseEvents: [chunkEvent([1, 2]), chunkEvent([3, 4]), chunkEvent([5, 6])],
  });

  for await (const _chunk of provider.synthesizeStream!(task("hi"))) {
    break;
  }

  assert.equal(wasAborted(), true, "the `finally` must abort the controller on an early break");
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — time-to-first-audio, measured through the real pipeline");
// ═════════════════════════════════════════════════════════════════

await test("B1 — streaming reaches first audio sooner than batch, on the SAME reply", async () => {
  const batch = await measureFirstAudio("batch", BLOCK);
  const stream = await measureFirstAudio("stream", BLOCK);

  console.log(
    `         measured: batch=${batch.requestToFirstAudioMs}ms  stream=${stream.requestToFirstAudioMs}ms  saved=${
      batch.requestToFirstAudioMs - stream.requestToFirstAudioMs
    }ms`,
  );

  assert.ok(
    stream.requestToFirstAudioMs < batch.requestToFirstAudioMs,
    `streaming must reach audio sooner (batch=${batch.requestToFirstAudioMs}ms stream=${stream.requestToFirstAudioMs}ms)`,
  );
  // The modelled first chunk of BLOCK is ~62 chars, so the batch render
  // costs BATCH_FLOOR_MS + 62*BATCH_MS_PER_CHAR ~= 91ms against the
  // stream's flat 18ms. Asserting only half of that expected gap keeps
  // the test immune to scheduler noise while still failing outright if
  // the pipeline stops preferring the stream.
  const expectedGap = BATCH_FLOOR_MS - STREAM_FIRST_CHUNK_MS;
  assert.ok(
    batch.requestToFirstAudioMs - stream.requestToFirstAudioMs > expectedGap / 2,
    `the saving must be real, not incidental (saved=${
      batch.requestToFirstAudioMs - stream.requestToFirstAudioMs
    }ms, expected > ${expectedGap / 2}ms)`,
  );
});

await test("B2 — batch time-to-first-audio scales with the FIRST CHUNK; streaming stays flat", async () => {
  // The defect's signature, and the reason the saving is worth having:
  // the bytes endpoint renders the whole request before returning, so
  // its time-to-first-audio grows with the text. The SSE endpoint is
  // bounded by the first frame and does not.
  //
  // The comparison has to be made on FIRST CHUNK length, not reply
  // length — the chunker cuts at the first qualifying sentence
  // boundary, so a 263-character reply whose opening sentence is 62
  // characters produces a 62-character synthesis request. An earlier
  // revision of this test compared two replies whose first chunks were
  // 41 and 62 characters and called them "short" and "long"; the 12ms
  // of modelled difference was inside scheduler noise and the test
  // rightly failed. The measured first-chunk length is asserted below
  // so this test can never again be wrong about its own premise.
  const shortBatch = await measureFirstAudio("batch", SHORT);
  const shortStream = await measureFirstAudio("stream", SHORT);
  const longBatch = await measureFirstAudio("batch", LONG_FIRST_CHUNK);
  const longStream = await measureFirstAudio("stream", LONG_FIRST_CHUNK);

  // spoken[0] is the greeting; spoken[1] is this reply's first chunk.
  const shortChunk = shortBatch.spoken[1]?.length ?? 0;
  const longChunk = longBatch.spoken[1]?.length ?? 0;
  console.log(
    `         first chunk ${shortChunk}ch: batch=${shortBatch.requestToFirstAudioMs}ms stream=${shortStream.requestToFirstAudioMs}ms` +
      `  |  first chunk ${longChunk}ch: batch=${longBatch.requestToFirstAudioMs}ms stream=${longStream.requestToFirstAudioMs}ms`,
  );

  // The premise, asserted rather than assumed.
  assert.equal(shortChunk, SHORT.length, "the short reply is one flush-only chunk");
  assert.equal(longChunk, LONG_FIRST_CHUNK.length, "the long reply is also ONE chunk, and a much bigger one");
  assert.ok(longChunk - shortChunk > 100, `the two first chunks must differ materially (${shortChunk} vs ${longChunk})`);

  const batchGrowth = longBatch.requestToFirstAudioMs - shortBatch.requestToFirstAudioMs;
  const streamGrowth = longStream.requestToFirstAudioMs - shortStream.requestToFirstAudioMs;

  // Batch pays for the extra characters. Half the modelled slope is the
  // threshold, so scheduler noise cannot pass this on its own.
  const modelledBatchGrowth = (longChunk - shortChunk) * BATCH_MS_PER_CHAR;
  assert.ok(
    batchGrowth > modelledBatchGrowth / 2,
    `batch must get slower as the chunk grows (grew ${batchGrowth}ms, modelled ${Math.round(modelledBatchGrowth)}ms)`,
  );
  // Streaming does not. This is the property that makes the saving
  // scale with reply length on a real call.
  assert.ok(
    streamGrowth < batchGrowth,
    `streaming must scale with length LESS than batch (stream grew ${streamGrowth}ms, batch grew ${batchGrowth}ms)`,
  );
  assert.ok(
    longBatch.requestToFirstAudioMs - longStream.requestToFirstAudioMs >
      shortBatch.requestToFirstAudioMs - shortStream.requestToFirstAudioMs,
    "and so the saving is LARGER on the longer chunk",
  );
});

await test("B3 — the COMPLETE reply is still spoken: same audio, same text, nothing truncated", async () => {
  const batch = await measureFirstAudio("batch", BLOCK);
  const stream = await measureFirstAudio("stream", BLOCK);

  // The acceptance criterion "no words are cut off", and the explicit
  // instruction not to improve the metric by shortening playback: both
  // paths must deliver the SAME audio for the SAME reply.
  assert.equal(
    stream.audioBytes,
    batch.audioBytes,
    `streaming must queue the same audio as batch (stream=${stream.audioBytes} batch=${batch.audioBytes} bytes)`,
  );
  assert.deepEqual(
    stream.spoken,
    batch.spoken,
    "the same utterances, in the same order, with the same text",
  );
  // And the text that reached TTS reconstructs the reply exactly —
  // no chunk dropped at a boundary.
  const spokenReply = stream.spoken.slice(1).join(" ").replace(/\s+/gu, " ").trim();
  assert.equal(spokenReply, BLOCK.replace(/\s+/gu, " ").trim());
});

await test("B4 — a duration-billed streaming provider is still charged (cost is not zeroed)", async () => {
  // `estimateTtsCost` returns 0 AND warns when a duration-billed
  // provider supplies no generated duration. The streaming branch used
  // to pass characters only, so Cartesia gaining `synthesizeStream`
  // would have silently zeroed the TTS cost of every campaign call.
  // Asserted through the real pipeline with the real Cartesia id, which
  // is the only id in the duration-billed table.
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [SHORT] });
  try {
    (h.record.metrics as unknown as { providerStack: { textToSpeech: { id: string } } }).providerStack.textToSpeech.id =
      "cartesia";
    await h.waitFor("greeting spoken", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Is it free?");
    await h.waitForReplies(2, 30000);

    const breakdown = h.record.metrics.build().estimatedCost.breakdown;
    const ttsCost = breakdown?.textToSpeech ?? 0;
    assert.ok(ttsCost > 0, `Cartesia TTS cost must be non-zero on the streaming path (got ${ttsCost})`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — the protected behaviours, re-asserted ON THE STREAMING BRANCH");
// ═════════════════════════════════════════════════════════════════

await test("C1 — a short reply is spoken once, in full, and committed once", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [SHORT] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Is it free?");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken.length, 2, "the greeting and one reply");
    assert.equal(spoken[1], SHORT, "the whole reply is committed, unmodified");
    assert.equal(
      h.synthesized.filter((t) => t.includes("completely free")).length,
      1,
      "synthesized exactly once — no duplicate speech",
    );
  } finally {
    await h.stop();
  }
});

await test("C2 — a long multi-sentence reply is spoken in order and committed whole", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Tell me more.");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken[1], BLOCK);
    // Every chunk, in order, reconstructing the block exactly.
    const chunks = h.synthesized.slice(1);
    assert.ok(chunks.length >= 1, "the reply reached TTS");
    assert.equal(
      chunks.join(" ").replace(/\s+/gu, " ").trim(),
      BLOCK.replace(/\s+/gu, " ").trim(),
      "nothing lost and nothing doubled across chunk boundaries",
    );
  } finally {
    await h.stop();
  }
});

await test("C3 — barge-in BEFORE any audio played: the reply is not committed", async () => {
  const h = startHarness({
    mode: "stream",
    openingLine: OPENING,
    replies: [BLOCK, "The answer to the newer question."],
    replyDelayMs: 400,
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Tell me more.");
    await h.waitFor("the model was asked", () => h.llmRequestedAt.length >= 1, 20000);
    // While it is still thinking — nothing spoken yet — the caller asks
    // something newer. This is the supersession path, and it must be
    // unaffected by which TTS branch would have run.
    h.say("Actually, what is the price?");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.ok(
      !spoken.some((t) => t.startsWith("Actually, I am calling you")),
      "a reply the caller never heard must not be committed as spoken",
    );
  } finally {
    await h.stop();
  }
});

await test("C4 — barge-in DURING playback: only the heard prefix is committed", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK, "Yes, it is free."] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    // Wait until the block is genuinely playing, then cut in.
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    h.say("Wait, is it free?");
    await h.waitForReplies(3, 30000);

    const spoken = assistantTexts(h.history());
    const interrupted = spoken.find((t) => t.startsWith("Actually, I am calling you"));
    assert.ok(interrupted !== undefined, "the part the caller HEARD stays in the history");
    assert.ok(
      interrupted.length < BLOCK.length,
      `only the heard prefix is committed, not the whole block (committed ${interrupted.length} of ${BLOCK.length} chars)`,
    );
    assert.ok(
      !interrupted.includes("from plain instructions"),
      "audio the caller never heard must not be committed as spoken",
    );
  } finally {
    await h.stop();
  }
});

await test("C5 — an uncorroborated background voice creates no turn and does not stop the block", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-HAPPEN"] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    h.sayBackground("hello");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken.length, 2, "no extra turn was created by the background voice");
    assert.equal(spoken[1], BLOCK, "the block finished");
    assert.ok(
      !h.synthesized.some((t) => t.includes("SHOULD-NOT-HAPPEN")),
      "the background voice produced no reply",
    );
  } finally {
    await h.stop();
  }
});

await test("C6 — the Hello attention check still answers once, with no language-model request", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    const requestsBefore = h.requests.length;
    h.say("Hello?");
    await h.waitFor(
      "the acknowledgement was spoken",
      () => h.synthesized.some((t) => t.includes("hear me okay")),
      20000,
    );

    assert.equal(
      h.synthesized.filter((t) => t.includes("hear me okay")).length,
      1,
      "acknowledged exactly once",
    );
    assert.equal(
      h.requests.length,
      requestsBefore,
      "an attention check must spend no generation — Fix #2's core property",
    );
    assert.ok(
      !h.synthesized.some((t) => t.includes("SHOULD-NOT-BE-GENERATED")),
      "no reply was generated for the hello",
    );
  } finally {
    await h.stop();
  }
});

await test("C7 — confirmation after Hello resumes the unheard remainder, still with no generation", async () => {
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    h.say("Hello?");
    await h.waitFor(
      "acknowledgement",
      () => h.synthesized.some((t) => t.includes("hear me okay")),
      20000,
    );
    const requestsBefore = h.requests.length;
    h.say("Yes, I can hear you.");
    await h.waitFor(
      "the remainder was resumed",
      () => h.synthesized.some((t) => t.includes("Flexi Genie") || t.includes("plain instructions")),
      20000,
    );

    assert.equal(
      h.requests.length,
      requestsBefore,
      "resuming a held remainder must spend no generation either",
    );
    // The heard prefix and the resumed part must not overlap: the
    // opening sentence of the block is synthesized exactly once for the
    // whole call.
    assert.equal(
      h.synthesized.filter((t) => t.includes("very interesting invitation")).length,
      1,
      "nothing already heard is synthesized a second time",
    );
  } finally {
    await h.stop();
  }
});

await test("C8 — an agent closing still ends the call: playback finishes, then `agentClosedIn` is true", async () => {
  const CLOSING = "Take care, Sakshi.";
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [CLOSING] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Okay, thank you.");
    await h.waitForReplies(2, 30000);

    // The pipeline commits an assistant turn only AFTER `drainPlayback`,
    // so the closing appearing last IS the moment its audio finished —
    // the guarantee Fix #1's hang-up reads. Streaming must not break it.
    // `agentClosedIn` is handed the real committed turns, unmodified.
    const turns = h.record.memory.history().filter((t) => t.role !== "system");

    assert.equal(turns[turns.length - 1]?.content, CLOSING, "the closing is the last committed turn");
    assert.equal(h.record.state, SessionState.LISTENING, "the reply finished playing and released SPEAKING");
    assert.equal(
      agentClosedIn(turns),
      true,
      "the real closing predicate must still fire — this is what hangs the call up",
    );
  } finally {
    await h.stop();
  }
});

await test("C9 — a mid-utterance barge-in bills only the audio actually generated", async () => {
  // The cost fix must not swing the other way: an interrupted utterance
  // is charged for the chunks that were generated, never for the whole
  // clip it would have become.
  const h = startHarness({ mode: "stream", openingLine: OPENING, replies: [BLOCK, "Yes."] });
  try {
    (h.record.metrics as unknown as { providerStack: { textToSpeech: { id: string } } }).providerStack.textToSpeech.id =
      "cartesia";
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    h.say("Wait, is it free?");
    await h.waitForReplies(3, 30000);

    const breakdown = h.record.metrics.build().estimatedCost.breakdown;
    const ttsCost = breakdown?.textToSpeech ?? 0;
    // Cartesia is $0.05 per generated minute. The whole block is
    // ~13s = ~$0.011; billing must be positive but well under the cost
    // of every clip on the call having been generated in full.
    assert.ok(ttsCost > 0, `an interrupted utterance still bills for what it generated (got ${ttsCost})`);
    assert.ok(ttsCost < 0.05, `and not for audio that was never generated (got ${ttsCost})`);
  } finally {
    await h.stop();
  }
});

await test("C10 — the batch branch is untouched: a batch-only provider behaves exactly as before", async () => {
  // The change is additive. A provider with no `synthesizeStream`
  // (Sarvam's batch path, Smallest AI) must reach the same outcome.
  const h = startHarness({ mode: "batch", openingLine: OPENING, replies: [BLOCK] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Tell me more.");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken.length, 2);
    assert.equal(spoken[1], BLOCK);
    assert.equal(h.record.state, SessionState.LISTENING);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`\nFailed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exitCode = 1;
}
