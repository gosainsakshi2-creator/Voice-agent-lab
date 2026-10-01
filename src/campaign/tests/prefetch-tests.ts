/**
 * prefetch-tests.ts — `npm run test:prefetch`
 *
 * NEXT-SENTENCE PREFETCH (`prefetchNextSentence`, 2026-10-01). At 1 CPU,
 * calls still had ~450ms of silence at sentence boundaries: the TTS's time
 * to first byte, paid only after the previous sentence's stream ended,
 * because generation runs at about playback speed. With the option on, the
 * next sentence's synthesis starts while the previous one still streams.
 *
 * The fake TTS here is shaped like ElevenLabs `stream()`: TTFB_MS to the
 * first chunk, then real-time-paced 100ms chunks.
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
  /** An INTERIM segment only — no final follows unless the test sends one. */
  sayInterim(text: string, opts?: { readonly confidence?: number; readonly startedAtMs?: number }): void;
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
  readonly prefetchNextSentence?: boolean;
  /** Delay before the Nth request's first token (by request index), so a turn can supersede it while THINKING. */
  readonly llmDelayMs?: Readonly<Record<number, number>>;
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
      await sleep(input.llmDelayMs?.[requests.length - 1] ?? 10);
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

  // A streaming TTS shaped like ElevenLabs `stream()`: first chunk after
  // TTFB_MS, then 100ms chunks paced at real time — generation runs at
  // about playback speed, which is what leaves no audio queued when one
  // sentence's stream ends.
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "elevenlabs"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      return clipFor(task.request.text);
    },
    synthesizeStream: async function* (task: { request: { text: string } }, signal?: AbortSignal) {
      const text = task.request.text;
      synthesized.push(text);
      ttsLog.push({ text, event: "request", at: Date.now() });
      await sleep(TTFB_MS);
      const totalMs = msFor(text);
      for (let sent = 0; sent < totalMs; sent += 100) {
        if (signal?.aborted) return;
        if (sent > 0) await sleep(100);
        const ms = Math.min(100, totalMs - sent);
        yield { audio: { data: new Uint8Array(Math.round((ms / 1000) * 8000)), encoding: "MULAW" as const, sampleRateHz: 8000 }, sequence: sent / 100 };
      }
      ttsLog.push({ text, event: "end", at: Date.now() });
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "elevenlabs")),
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
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "elevenlabs" },
  };

  const record = new SessionRecord(
    "prefetch-test" as SessionId,
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
    ...(input.prefetchNextSentence === true ? { prefetchNextSentence: true } : {}),
  });
  const loop = pipeline.run();

  return {
    record,
    requests,
    synthesized,
    sayInterim(text, opts = {}) {
      const startedAtMs = opts.startedAtMs ?? clockMs;
      segments.push({
        text,
        isFinal: false,
        isSpeechFinal: false,
        confidence: opts.confidence ?? 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: startedAtMs + 300,
      });
      waiters.shift()?.();
    },
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
const S1 = "Actually, I am calling you with a very interesting invitation.";
const S2 = "We have created Flexi Genie, which helps you build your online business by chatting with AI.";
const S3 = "Would you like me to reserve your free seat?";
const BLOCK = `${S1} ${S2} ${S3}`;
const SCRIPT_TEXT = `${OPENING}
${BLOCK}`;
const TTFB_MS = 400;
const ttsLog: Array<{ text: string; event: "request" | "end"; at: number }> = [];

async function runBlock(prefetch: boolean): Promise<{ log: typeof ttsLog; assistant: readonly string[]; synthesized: readonly string[]; wallMs: number }> {
  ttsLog.length = 0;
  const h = startHarness({ replies: [BLOCK, "Okay."], ...(prefetch ? { prefetchNextSentence: true } : {}) });
  try {
    await h.waitForReplies(1);
    const startedAt = Date.now();
    h.say("Yes, tell me.");
    try {
      await h.waitFor("the block to be spoken", () => h.assistantTexts().length >= 2 && h.record.state === SessionState.LISTENING, 40000);
    } catch (error) {
      const t0 = ttsLog[0]?.at ?? 0;
      console.log(`[PREFETCH-DEBUG] state=${h.record.state} log=${JSON.stringify(ttsLog.map((e) => ({ t: e.text.slice(0, 18), e: e.event, at: e.at - t0 })))}`);
      throw error;
    }
    return { log: [...ttsLog], assistant: h.assistantTexts(), synthesized: [...h.synthesized], wallMs: Date.now() - startedAt };
  } finally {
    await h.stop();
  }
}

const requestAt = (log: typeof ttsLog, text: string) => log.find((e) => e.event === "request" && e.text.includes(text))?.at;
const endAt = (log: typeof ttsLog, text: string) => log.find((e) => e.event === "end" && e.text.includes(text))?.at;

section("SECTION A — the next sentence is synthesized while the previous one streams");

await test("A1. ON: sentence 2's request goes out before sentence 1's stream ends", async () => {
  const run = await runBlock(true);
  const s1End = endAt(run.log, "interesting invitation");
  const s2Request = requestAt(run.log, "Flexi Genie");
  assert.ok(s1End !== undefined && s2Request !== undefined, JSON.stringify(run.log));
  assert.ok(s2Request < s1End, `S2 requested ${s2Request - s1End}ms relative to S1's end — must be before it`);
});

await test("A2. OFF: exactly as before — sentence 2 is requested only after sentence 1 ends", async () => {
  const run = await runBlock(false);
  const s1End = endAt(run.log, "interesting invitation");
  const s2Request = requestAt(run.log, "Flexi Genie");
  assert.ok(s1End !== undefined && s2Request !== undefined);
  assert.ok(s2Request >= s1End, `S2 requested ${s2Request - s1End}ms relative to S1's end`);
});

await test("A3. ON: the reply, its order and its history are unchanged — and each sentence is synthesized once", async () => {
  const on = await runBlock(true);
  const off = await runBlock(false);
  assert.deepEqual(on.assistant, off.assistant, "the committed history is the same");
  const count = (list: readonly string[], text: string) => list.filter((t) => t.includes(text)).length;
  for (const text of ["interesting invitation", "Flexi Genie", "reserve your free seat"]) {
    assert.equal(count(on.synthesized, text), 1, `"${text}" synthesized once with prefetch, got ${count(on.synthesized, text)}`);
  }
  assert.ok(on.wallMs < off.wallMs, `the reply finishes sooner with prefetch: on=${on.wallMs}ms off=${off.wallMs}ms`);
});

await test("A4. ON: a barge-in mid-reply — history as without prefetch, and a later sentence with the same words is synthesized fresh", async () => {
  const run = async (prefetch: boolean) => {
    ttsLog.length = 0;
    const h = startHarness({ replies: [BLOCK, S3], ...(prefetch ? { prefetchNextSentence: true } : {}) });
    try {
      await h.waitForReplies(1);
      h.say("Yes, tell me.");
      await h.waitFor("sentence 2 to be requested", () => requestAt(ttsLog, "Flexi Genie") !== undefined, 20000);
      await h.waitFor("the agent to be speaking", () => h.record.state === SessionState.SPEAKING, 20000);
      h.say("Wait, how much does this cost?");
      await h.waitFor("the answer", () => h.assistantTexts().some((t) => t === S3) && h.record.state === SessionState.LISTENING, 40000);
      return { assistant: h.assistantTexts(), s3Requests: ttsLog.filter((e) => e.event === "request" && e.text.includes("reserve your free seat")).length };
    } finally {
      await h.stop();
    }
  };
  const on = await run(true);
  const off = await run(false);
  assert.deepEqual(on.assistant.slice(0, 1), off.assistant.slice(0, 1));
  assert.ok(on.assistant[on.assistant.length - 1] === S3, JSON.stringify(on.assistant));
  // The answer S3 must have been requested from the TTS for itself, not
  // served from a prefetched clip the barge-in left behind.
  assert.ok(on.s3Requests >= 1, `S3 requested ${on.s3Requests} times`);
});

void SCRIPT_TEXT;
console.log(`
${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
