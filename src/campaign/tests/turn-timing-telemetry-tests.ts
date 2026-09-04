/**
 * turn-timing-telemetry-tests.ts — `npm run test:turn-timing-telemetry`
 *
 * FIX #7A — READ-ONLY LATENCY INSTRUMENTATION. Covers the telemetry
 * added to `conversation-pipeline.ts` for finding where end-to-end
 * turn latency actually goes: `TurnTimer.printLatencyBreakdown` (the
 * `[TIMING:sid] TURN#N` / `... DELTAS` blocks), the response-length
 * telemetry line (`[RESPONSE-LEN:sid] TURN#N ...`), and the new
 * Deepgram endpoint-evidence capture that feeds both.
 *
 * This suite asserts exactly the four properties Phase #7A's own test
 * requirements call for:
 *
 *   1. timestamps are monotonic (T1)
 *   2. each printed delta is the difference of its OWN two timestamps,
 *      never a derived total (T2)
 *   3. a boundary with nothing to measure prints
 *      "NOT DIRECTLY MEASURABLE" rather than a fabricated number (T3, T4)
 *   4. attention-check and barge-in behaviour — and the per-turn
 *      telemetry guards resetting across a barge-in — are unchanged
 *      (T6, T7)
 *
 * Every provider here is a local fake; the pipeline, turn detector,
 * sentence chunker and conversation memory are the real ones. NOTHING
 * HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR OR TOUCHES
 * GOOGLE.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { ConversationTurn, TranscriptSegment } from "../../types/provider.types";
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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════
// LOG CAPTURE — the telemetry under test IS console output, so the
// harness intercepts `console.log` and hands every test its own
// buffer instead of asserting against stdout.
// ═════════════════════════════════════════════════════════════════

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = console.log;
  const lines: string[] = [];
  // eslint-disable-next-line no-console
  console.log = ((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

/** Finds the multi-line console.log call whose FIRST line is exactly `header`. */
function findBlock(lines: readonly string[], header: string): string[] | undefined {
  const found = lines.find((l) => l.split("\n")[0] === header);
  return found?.split("\n");
}

function fieldsOf(blockLines: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!blockLines) return map;
  for (const line of blockLines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

function parseTs(value: string | undefined): number | undefined {
  if (value === undefined || value.startsWith("NOT DIRECTLY MEASURABLE")) return undefined;
  const iso = value.split(" ")[0]!;
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `not a valid ISO timestamp: "${value}"`);
  return ms;
}

function parseDelta(value: string | undefined): number | undefined {
  if (value === undefined || value === "NOT DIRECTLY MEASURABLE") return undefined;
  const m = /^(-?\d+)ms$/.exec(value);
  assert.ok(m, `not a valid delta value: "${value}"`);
  return Number(m![1]);
}

function findResponseLenLine(lines: readonly string[], sid: string, turnIndex: number): string | undefined {
  return lines.find((l) => l.startsWith(`[RESPONSE-LEN:${sid}] TURN#${turnIndex} `));
}

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — same shape as `attention-check-tests.ts` /
// `end-of-speech-tests.ts`: streaming STT, streaming LLM, batch TTS
// (so `synthesized` records one entry per sentence chunk exactly like
// Cartesia/Smallest AI's batch fallback does).
// ═════════════════════════════════════════════════════════════════

const CHARS_PER_SECOND = 22;

function clipFor(text: string) {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return {
    data: new Uint8Array(Math.round(seconds * 8000)),
    encoding: "MULAW" as const,
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

interface ScriptedReply {
  readonly text: string;
  /** Simulates the OpenAI usage chunk's `completion_tokens`, when present. */
  readonly completionTokens?: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly synthesized: string[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

const SID = "telemetry-test";

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: ReadonlyArray<string | ScriptedReply>;
}): Harness {
  const replies: ScriptedReply[] = input.replies.map((r) => (typeof r === "string" ? { text: r } : r));
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
      const reply = replies[replyIndex] ?? { text: "Okay." };
      replyIndex += 1;
      await sleep(10);
      if (signal?.aborted) return;
      for (const delta of reply.text.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: reply.text, timestamp: new Date() },
        latencyMs: 1,
        ...(reply.completionTokens !== undefined ? { completionTokens: reply.completionTokens } : {}),
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
    SID as SessionId,
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
    synthesized,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      push(text, isFinal, opts?.isSpeechFinal ?? isFinal, 0.95);
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
        const count = record.memory.history().filter((turn) => turn.role === "assistant").length;
        if (count >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${n} replies`);
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

/** The fixed English attention-check acknowledgement, as the pipeline speaks it (see `speakAttentionUtterance`). */
function isAck(text: string): boolean {
  return text.toLowerCase().includes("hear me okay");
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK_SENTENCE_1 = "Actually, I am calling you with a very interesting invitation.";
const BLOCK_SENTENCE_2 =
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";
const BLOCK_SENTENCE_3 =
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";
const BLOCK = `${BLOCK_SENTENCE_1} ${BLOCK_SENTENCE_2} ${BLOCK_SENTENCE_3}`;

async function upToMidBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me more.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(900);
}

// ═════════════════════════════════════════════════════════════════
section("T1/T2 — a normal turn's TIMING trace is monotonic, and every delta is its own subtraction");
// ═════════════════════════════════════════════════════════════════

await test("T1 — every measured stage of a multi-sentence turn advances, never goes backward", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    const { lines } = await withCapturedLogs(async () => {
      await h.waitForReplies(1);
      h.say("Tell me about the workshop.", { isSpeechFinal: true });
      await h.waitForReplies(2);
    });

    const trace = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#0`));
    assert.ok(trace.size > 0, "expected a TURN#0 TIMING block");

    const order = [
      "speech-end",
      "endpoint-evidence",
      "turn-release",
      "llm-request",
      "llm-first-token",
      "first-sentence-ready",
      "tts-request",
      "tts-first-audio",
      "audio-queued",
    ];
    const stamps = order.map((k) => ({ k, ms: parseTs(trace.get(k)) }));
    for (const { k, ms } of stamps) {
      assert.ok(ms !== undefined, `expected "${k}" to be directly measured for a multi-sentence BLOCK reply`);
    }
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(
        stamps[i]!.ms! >= stamps[i - 1]!.ms!,
        `"${stamps[i]!.k}" (${stamps[i]!.ms}) must not precede "${stamps[i - 1]!.k}" (${stamps[i - 1]!.ms})`,
      );
    }
  } finally {
    await h.stop();
  }
});

await test("T2 — each printed DELTA equals the difference of its own two timestamps, not a derived total", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    const { lines } = await withCapturedLogs(async () => {
      await h.waitForReplies(1);
      h.say("Tell me about the workshop.", { isSpeechFinal: true });
      await h.waitForReplies(2);
    });

    const trace = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#0`));
    const deltas = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#0 DELTAS`));
    assert.ok(deltas.size > 0, "expected a TURN#0 DELTAS block");

    const pairs: Array<[string, string, string]> = [
      ["endpoint-to-release", "endpoint-evidence", "turn-release"],
      ["release-to-llm-request", "turn-release", "llm-request"],
      ["llm-to-first-token", "llm-request", "llm-first-token"],
      ["first-token-to-sentence", "llm-first-token", "first-sentence-ready"],
      ["sentence-to-tts", "first-sentence-ready", "tts-request"],
      ["tts-to-first-audio", "tts-request", "tts-first-audio"],
      ["first-audio-to-queue", "tts-first-audio", "audio-queued"],
      ["speech-end-to-audio", "speech-end", "audio-queued"],
    ];
    for (const [deltaKey, fromKey, toKey] of pairs) {
      const printed = parseDelta(deltas.get(deltaKey));
      const recomputed =
        parseTs(trace.get(fromKey)) !== undefined && parseTs(trace.get(toKey)) !== undefined
          ? parseTs(trace.get(toKey))! - parseTs(trace.get(fromKey))!
          : undefined;
      assert.equal(
        printed,
        recomputed,
        `"${deltaKey}" printed ${printed}ms but "${toKey}" - "${fromKey}" is ${recomputed}ms`,
      );
    }
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("T3/T4 — a boundary with nothing to measure says so, and never fabricates a number");
// ═════════════════════════════════════════════════════════════════

await test('T3 — a short reply that never reaches the chunker\'s "ready" path reports first-sentence-ready as NOT DIRECTLY MEASURABLE', async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure."] });
  try {
    const { lines } = await withCapturedLogs(async () => {
      await h.waitForReplies(1);
      h.say("Is it free?", { isSpeechFinal: true });
      await h.waitForReplies(2);
    });

    const trace = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#0`));
    const deltas = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#0 DELTAS`));

    assert.equal(trace.get("first-sentence-ready"), "NOT DIRECTLY MEASURABLE");
    assert.equal(deltas.get("first-token-to-sentence"), "NOT DIRECTLY MEASURABLE");
    assert.equal(deltas.get("sentence-to-tts"), "NOT DIRECTLY MEASURABLE");

    // The stages either side of the gap are genuinely measured — this
    // is a real gap in the chunker's output, not every field failing.
    assert.notEqual(trace.get("llm-first-token"), "NOT DIRECTLY MEASURABLE");
    assert.notEqual(trace.get("tts-request"), "NOT DIRECTLY MEASURABLE");
    assert.notEqual(trace.get("tts-first-audio"), "NOT DIRECTLY MEASURABLE");
    assert.notEqual(trace.get("audio-queued"), "NOT DIRECTLY MEASURABLE");
  } finally {
    await h.stop();
  }
});

await test("T4 — reportedCompletionTokens is the provider's real number when supplied, and NOT DIRECTLY MEASURABLE when it is not", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [
      { text: "Sure, that works.", completionTokens: 7 },
      { text: "Sure, that works too." },
    ],
  });
  try {
    const { lines } = await withCapturedLogs(async () => {
      await h.waitForReplies(1);
      h.say("Is it free?", { isSpeechFinal: true });
      await h.waitForReplies(2);
      h.say("What time does it start?", { isSpeechFinal: true });
      await h.waitForReplies(3);
    });

    const turn0 = findResponseLenLine(lines, SID, 0);
    const turn1 = findResponseLenLine(lines, SID, 1);
    assert.ok(turn0?.includes("reportedCompletionTokens=7"), `expected reportedCompletionTokens=7, got: ${turn0}`);
    assert.ok(
      turn1?.includes("reportedCompletionTokens=NOT DIRECTLY MEASURABLE"),
      `expected NOT DIRECTLY MEASURABLE when the provider supplied no usage, got: ${turn1}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("T5 — response-length telemetry reads real counts, never generation");
// ═════════════════════════════════════════════════════════════════

await test("T5 — userChars/assistantChars/ttsChunks are exact, and an explicit brevity request is detected", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    const userText = "Can you keep it short please?";
    await h.waitForReplies(1);
    // Baseline AFTER the greeting: the greeting itself is a `synthesizeAndPlay`
    // call too (`OPENING`), so it must not be counted as one of THIS
    // turn's chunks.
    const synthesizedBeforeTurn = h.synthesized.length;
    const { lines } = await withCapturedLogs(async () => {
      h.say(userText, { isSpeechFinal: true });
      await h.waitForReplies(2);
    });
    const turnSynthesisCalls = h.synthesized.length - synthesizedBeforeTurn;

    const line = findResponseLenLine(lines, SID, 0);
    assert.ok(line, "expected a RESPONSE-LEN line for TURN#0");
    assert.ok(line!.includes(`userChars=${userText.length}`), line);
    assert.ok(line!.includes(`assistantChars=${BLOCK.length}`), line);
    // Cross-check the printed ttsChunks count against the provider-facing
    // call count actually observed, rather than a guessed absolute number
    // — how many chunks the real SentenceChunker cuts BLOCK into is its
    // own business, untouched by this fix.
    const ttsChunksMatch = /ttsChunks=(\d+)/.exec(line!);
    assert.ok(ttsChunksMatch, line);
    assert.equal(Number(ttsChunksMatch![1]), turnSynthesisCalls);
    assert.ok(turnSynthesisCalls >= 2, "BLOCK has 3 sentences and must not collapse into one chunk");
    assert.ok(line!.includes("briefRequested=true"), line);
    assert.ok(line!.includes('matchedPhrase="short"'), line);
  } finally {
    await h.stop();
  }
});

await test("T5b — briefRequested is false when the caller never asked for brevity", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure."] });
  try {
    const { lines } = await withCapturedLogs(async () => {
      await h.waitForReplies(1);
      h.say("Is it free?", { isSpeechFinal: true });
      await h.waitForReplies(2);
    });
    const line = findResponseLenLine(lines, SID, 0);
    assert.ok(line?.includes("briefRequested=false"), line);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("T6 — attention-check behaviour is unchanged: still fixed, still no LLM request");
// ═════════════════════════════════════════════════════════════════

await test("T6 — a mid-block 'Hello?' still gets the fixed acknowledgement, and its trace is honest that no LLM ran", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"] });
  try {
    await upToMidBlock(h);

    const { lines } = await withCapturedLogs(async () => {
      h.say("Hello?");
      await h.waitForReplies(3);
    });

    const spoken = assistantTexts(h.history());
    assert.ok(isAck(spoken[2] ?? ""), `expected the fixed acknowledgement, got ${JSON.stringify(spoken[2])}`);

    // Behaviour: unchanged from `test:attention` — the attention check
    // must never reach the language model, so BLOCK's already-spoken
    // sentences are the only real generations; "SHOULD-NOT-BE-GENERATED"
    // must never appear.
    assert.ok(
      !h.synthesized.includes("SHOULD-NOT-BE-GENERATED"),
      "the attention check must not have triggered a new LLM-generated reply",
    );

    // Telemetry: this turn is TURN#1 (TURN#0 was "Yes, tell me more.").
    // It still went through real STT endpointing and turn release, so
    // that stage IS measured on the TURN# trace — but the fixed
    // acknowledgement is spoken under `speakAttentionUtterance`'s OWN
    // "ATTENTION"-labelled TurnTimer (a separate object; see
    // `beginTurnTiming`), exactly the "label them separately" the fix
    // asked for. So the TURN#1 trace itself must show NOT ONLY the LLM
    // stages but also TTS/audio as unmeasured — nothing here ran under
    // this timer — and the real TTS measurement must show up instead
    // on the ATTENTION timer's own summary line.
    const trace = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#1`));
    assert.ok(trace.size > 0, "expected a TURN#1 TIMING block");
    assert.notEqual(trace.get("turn-release"), "NOT DIRECTLY MEASURABLE");
    for (const stage of ["llm-request", "llm-first-token", "first-sentence-ready", "tts-request", "tts-first-audio", "audio-queued"]) {
      assert.equal(
        trace.get(stage),
        "NOT DIRECTLY MEASURABLE",
        `TURN#1's own trace must not fabricate "${stage}" — the attention reply runs under a separate ATTENTION timer`,
      );
    }
    const attentionSummary = lines.find(
      (l) => l.startsWith(`[TIMING:${SID}] ATTENTION SUMMARY`) && l.includes("tts-request=") && l.includes("audio-queued="),
    );
    assert.ok(
      attentionSummary,
      "expected the ATTENTION timer's own summary to show the fixed acknowledgement's real tts-request/audio-queued marks",
    );

    // And the response-length telemetry — which reads the LLM's
    // reply/token accounting — must not print for a turn that never
    // called the LLM at all.
    assert.equal(
      findResponseLenLine(lines, SID, 1),
      undefined,
      "RESPONSE-LEN must only print for a turn that actually went through runThinkingAndSpeaking",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("T7 — barge-in behaviour is unchanged, and the next turn's telemetry guards reset");
// ═════════════════════════════════════════════════════════════════

await test("T7 — a real interruption still commits only what was heard, and the NEXT turn's marks are fresh, not stuck", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure, that is fine."] });
  try {
    await upToMidBlock(h);

    const { lines } = await withCapturedLogs(async () => {
      h.say("Wait, who are you?", { isSpeechFinal: true });
      await h.waitForReplies(3);
    });

    // Behaviour: unchanged from `test:barge-in` / attention-check G1/G2
    // — only the part of BLOCK actually heard before the interruption
    // is committed, and the model answers the interruption itself.
    const history = h.history();
    const heardBlock = assistantTexts(history)[1] ?? "";
    assert.ok(heardBlock.length > 0 && heardBlock.length < BLOCK.length, "only the heard prefix of BLOCK must be committed");
    assert.equal(assistantTexts(history)[2], "Sure, that is fine.");

    // Telemetry: TURN#0 is the interrupted BLOCK reply — its guards
    // (`markedTtsRequestThisTurn` etc.) got set to `true` partway
    // through. TURN#1 is the answer to "Wait, who are you?" and must
    // show its OWN fresh measurements, not "already marked" gaps
    // silently inherited from TURN#0's guards never being reset.
    const turn1 = fieldsOf(findBlock(lines, `[TIMING:${SID}] TURN#1`));
    assert.ok(turn1.size > 0, "expected a fresh TURN#1 TIMING block after the barge-in");
    for (const stage of ["llm-request", "llm-first-token", "tts-request", "tts-first-audio", "audio-queued"]) {
      assert.notEqual(
        turn1.get(stage),
        "NOT DIRECTLY MEASURABLE",
        `TURN#1's "${stage}" must be freshly measured, not inherited from the interrupted TURN#0`,
      );
    }
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
