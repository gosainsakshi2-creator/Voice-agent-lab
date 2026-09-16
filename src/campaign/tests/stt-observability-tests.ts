/**
 * stt-observability-tests.ts — `npm run test:stt-observability`
 *
 * PHASE 3 BATCH 3 — RAW STT OBSERVABILITY. Instrumentation only: this
 * batch adds five ABSOLUTE wall-clock observations and derives no new
 * latency from them.
 *
 * They exist because `sttMs` is computed on the AUDIO-STREAM clock
 * (`inboundStreamMs - segment.endedAtMs`) and therefore cannot separate
 * Deepgram processing from transport delay from the configured
 * `endpointing` hold from audio-clock drift. Production measured that
 * boundary at p50 1040ms / p90 2350ms / max 3300ms without being able
 * to attribute any of it.
 *
 *   lastInboundAudioAtMs        caller audio chunk received (wall clock)
 *   lastInterimTranscriptAtMs   latest non-empty interim
 *   lastFinalTranscriptAtMs     latest non-empty final
 *   endpointEvidenceAtMs        endpoint evidence arrival
 *   endpointEvidenceKind        speech_final | utterance_end
 *
 * Sections A-E and H drive the REAL `ConversationPipeline` against
 * local fakes, so the stamps are asserted where they are actually
 * written. F and G use the REAL `SessionMetricsCollector` directly,
 * matching `latency-boundary-telemetry-tests.ts`.
 *
 * The property under test is the one this whole metrics layer rests
 * on: A MEASUREMENT THAT DOES NOT EXIST IS ABSENT, NEVER ZERO. For an
 * epoch stamp a substituted 0 would read as 1970.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, OR
 * TOUCHES THE DATABASE.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId, ProviderStackSelection } from "../../types/session.types";
import type { TurnLatencyInput } from "../../core/session/metrics-collector";
import type { TurnLatencyBreakdown } from "../../types/benchmark.types";

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
// Harness — same shape as `turn-timing-telemetry-tests.ts`, with one
// addition: the fake STT DRAINS `request.audio`, which is what makes
// the pipeline's inbound byte counter (and therefore the inbound
// wall-clock stamp) run at all.
// ═════════════════════════════════════════════════════════════════

const SID = "stt-observability-test";
const CHARS_PER_SECOND = 22;

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
function clipFor(text: string) {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return {
    data: new Uint8Array(Math.round(seconds * 8000)),
    encoding: "MULAW" as const,
    sampleRateHz: 8000,
  };
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  /** An end-of-speech MARKER — what the Deepgram adapter emits for `UtteranceEnd`. */
  sayEndOfSpeechMarker(): void;
  pushAudio(): void;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  turns(): readonly TurnLatencyBreakdown[];
  stop(): Promise<void>;
}

function startHarness(input: { openingLine: string; replies: readonly string[] }): Harness {
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (request: {
      audio: AsyncIterable<unknown>;
    }): AsyncIterable<TranscriptSegment> {
      // Drain the wrapped audio source in the background. The pipeline
      // counts bytes (and stamps the wall clock) inside that wrapper,
      // so without a consumer neither ever runs.
      void (async () => {
        try {
          for await (const _chunk of request.audio) {
            void _chunk;
          }
        } catch {
          /* closed */
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
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      const text = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(10);
      if (signal?.aborted) return;
      for (const delta of text.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: text, timestamp: new Date() },
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
  } as unknown as ProviderStackSelection;

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
    } as never,
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

  const push = (segment: TranscriptSegment): void => {
    segments.push(segment);
    waiters.shift()?.();
  };

  return {
    record,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      push({
        text,
        isFinal,
        isSpeechFinal: opts?.isSpeechFinal ?? isFinal,
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      });
    },
    sayEndOfSpeechMarker() {
      // Exactly what `transcriptEventFromMessage` builds for an
      // `UtteranceEnd` message: no text, no word timings.
      push({
        text: "",
        isFinal: true,
        isSpeechFinal: true,
        isEndOfSpeechMarker: true,
        confidence: 0,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: 0,
        endedAtMs: 0,
      } as TranscriptSegment);
    },
    pushAudio() {
      record.inboundAudioFallback.push({
        data: new Uint8Array(160),
        encoding: "MULAW",
        sampleRateHz: 8000,
      } as never);
    },
    async waitForReplies(n, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const count = record.memory.history().filter((t) => t.role === "assistant").length;
        if (count >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${n} replies`);
    },
    turns() {
      return record.metrics.build().turnLatencies ?? [];
    },
    async stop() {
      closed = true;
      for (const w of waiters.splice(0)) w();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

/** Drives one caller turn to completion and returns its recorded telemetry. */
async function oneTurn(opts: {
  readonly viaMarker: boolean;
  readonly withInterim: boolean;
  readonly withAudio: boolean;
}): Promise<TurnLatencyBreakdown> {
  const h = startHarness({ openingLine: "Hello, this is Rohan.", replies: ["Sure, happy to help."] });
  try {
    await h.waitForReplies(1);
    if (opts.withAudio) {
      for (let i = 0; i < 5; i += 1) {
        h.pushAudio();
        await sleep(5);
      }
      await sleep(30);
    }
    if (opts.withInterim) {
      h.say("Tell me about", { isFinal: false });
      await sleep(40);
    }
    if (opts.viaMarker) {
      // A chunk-boundary final (Deepgram withheld `speech_final`),
      // then the endpoint arriving separately as `UtteranceEnd`.
      h.say("Tell me about the workshop.", { isFinal: true, isSpeechFinal: false });
      await sleep(60);
      h.sayEndOfSpeechMarker();
    } else {
      h.say("Tell me about the workshop.", { isSpeechFinal: true });
    }
    await h.waitForReplies(2);
    const turns = h.turns();
    const turn = turns.at(-1);
    assert.ok(turn !== undefined, "expected at least one recorded turn");
    return turn;
  } finally {
    await h.stop();
  }
}

// ═════════════════════════════════════════════════════════════════
section("A-C. The three transcript/audio wall-clock stamps");

await test("A — inbound audio arrival is stamped on the wall clock", async () => {
  const turn = await oneTurn({ viaMarker: false, withInterim: true, withAudio: true });
  assert.ok(
    turn.lastInboundAudioAtMs !== undefined,
    "lastInboundAudioAtMs must be recorded once caller audio has been received",
  );
  assert.ok(
    turn.lastInboundAudioAtMs > 1_600_000_000_000,
    `must be an absolute epoch stamp, got ${turn.lastInboundAudioAtMs}`,
  );
});

await test("B — the latest interim transcript is stamped", async () => {
  const turn = await oneTurn({ viaMarker: false, withInterim: true, withAudio: true });
  assert.ok(turn.lastInterimTranscriptAtMs !== undefined, "lastInterimTranscriptAtMs must be recorded");
  assert.ok(
    turn.lastInterimTranscriptAtMs > 1_600_000_000_000,
    `must be an absolute epoch stamp, got ${turn.lastInterimTranscriptAtMs}`,
  );
});

await test("C — the latest non-empty final transcript is stamped", async () => {
  const turn = await oneTurn({ viaMarker: false, withInterim: true, withAudio: true });
  assert.ok(turn.lastFinalTranscriptAtMs !== undefined, "lastFinalTranscriptAtMs must be recorded");
  assert.ok(
    turn.lastFinalTranscriptAtMs > 1_600_000_000_000,
    `must be an absolute epoch stamp, got ${turn.lastFinalTranscriptAtMs}`,
  );
  assert.ok(
    turn.lastInterimTranscriptAtMs === undefined ||
      turn.lastFinalTranscriptAtMs >= turn.lastInterimTranscriptAtMs,
    "the final must not predate the interim that preceded it",
  );
});

// ═════════════════════════════════════════════════════════════════
section("D-E. The two endpoint paths are told apart");

await test("D — speech_final records endpointEvidenceKind 'speech_final'", async () => {
  const turn = await oneTurn({ viaMarker: false, withInterim: false, withAudio: true });
  assert.equal(turn.endpointEvidenceKind, "speech_final");
  assert.ok(turn.endpointEvidenceAtMs !== undefined, "its arrival must be stamped too");
});

await test("E — an UtteranceEnd marker records kind 'utterance_end', NOT speech_final", async () => {
  const turn = await oneTurn({ viaMarker: true, withInterim: false, withAudio: true });
  assert.equal(
    turn.endpointEvidenceKind,
    "utterance_end",
    "a marker must never be recorded as speech_final — they have different delivery characteristics",
  );
  assert.ok(turn.endpointEvidenceAtMs !== undefined, "its arrival must be stamped too");
});

// ═════════════════════════════════════════════════════════════════
section("H. Both endpoint paths still release the turn, unchanged");

await test("H — speech_final and UtteranceEnd both produce a reply", async () => {
  // `oneTurn` already waits for the SECOND reply, so reaching this
  // point at all means the turn was released down both paths. Asserted
  // explicitly so the guarantee is stated, not implied.
  const viaSpeechFinal = await oneTurn({ viaMarker: false, withInterim: false, withAudio: true });
  const viaMarker = await oneTurn({ viaMarker: true, withInterim: false, withAudio: true });
  assert.equal(viaSpeechFinal.turnIndex, viaMarker.turnIndex, "both paths record one turn");
  assert.ok(
    viaSpeechFinal.endpointToReleaseMs !== undefined && viaMarker.endpointToReleaseMs !== undefined,
    "both paths must still produce an evidenced release",
  );
});

// ═════════════════════════════════════════════════════════════════
section("F-G. Collector contract: existing metrics unchanged, absence preserved");

const STACK = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
} as unknown as ProviderStackSelection;

const baseInput: TurnLatencyInput = {
  turnIndex: 0,
  sttMs: 1040,
  llmMs: 900,
  ttsMs: 160,
  totalMs: 2700,
  llmGenerationMs: 1200,
  ttsSynthesisMs: 2000,
  userSpeechMs: 1500,
  endpointToReleaseMs: 250,
  speechEndToReleaseMs: 1290,
  playbackStartupMs: 20,
  sttCostUsd: 0,
  llmCostUsd: 0,
  ttsCostUsd: 0,
  promptTokens: undefined,
  cachedPromptTokens: undefined,
  reasoningTokens: undefined,
};

function collect(extra: Partial<TurnLatencyInput>): TurnLatencyBreakdown {
  const c = new SessionMetricsCollector("s" as SessionId, STACK);
  c.recordTurn({ ...baseInput, ...extra });
  const turn = c.build().turnLatencies[0];
  assert.ok(turn !== undefined);
  return turn;
}

await test("F — every pre-existing metric is byte-for-byte unchanged", () => {
  const before = collect({});
  const after = collect({
    lastInboundAudioAtMs: 1_700_000_000_000,
    lastInterimTranscriptAtMs: 1_700_000_000_100,
    lastFinalTranscriptAtMs: 1_700_000_000_200,
    endpointEvidenceAtMs: 1_700_000_000_300,
    endpointEvidenceKind: "speech_final",
  });
  for (const key of [
    "stt",
    "llm",
    "tts",
    "total",
    "llmGenerationMs",
    "ttsSynthesisMs",
    "userSpeechMs",
    "endpointToReleaseMs",
    "speechEndToReleaseMs",
    "playbackStartupMs",
  ] as const) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(after[key] ?? null)),
      JSON.parse(JSON.stringify(before[key] ?? null)),
      `${key} must be unaffected by the new fields`,
    );
  }
  assert.equal(before.endpointToReleaseMs, 250, "sanity: the existing boundary still reports");
  assert.equal(before.stt?.milliseconds, 1040, "sanity: the stream-clock lag is still reported");
});

await test("G — absent observations stay ABSENT, never 0 (a 0 epoch stamp is 1970)", () => {
  const turn = collect({});
  for (const key of [
    "lastInboundAudioAtMs",
    "lastInterimTranscriptAtMs",
    "lastFinalTranscriptAtMs",
    "endpointEvidenceAtMs",
    "endpointEvidenceKind",
  ] as const) {
    assert.equal(turn[key], undefined, `${key} must be undefined when not observed`);
    assert.ok(!(key in turn), `${key} must be OMITTED from the object, not present as undefined`);
  }
});

await test("G2 — a non-finite or negative stamp is dropped rather than stored", () => {
  const turn = collect({
    lastInboundAudioAtMs: Number.NaN,
    lastInterimTranscriptAtMs: -1,
    lastFinalTranscriptAtMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(turn.lastInboundAudioAtMs, undefined, "NaN must not be stored");
  assert.equal(turn.lastInterimTranscriptAtMs, undefined, "a negative stamp must not be stored");
  assert.equal(turn.lastFinalTranscriptAtMs, undefined, "a non-finite stamp must not be stored");
});

await test("G3 — an unrecognised endpointEvidenceKind is dropped, not stored", () => {
  const turn = collect({ endpointEvidenceKind: "something_else" as never });
  assert.equal(
    turn.endpointEvidenceKind,
    undefined,
    "the field may only ever hold a claim the pipeline actually makes",
  );
});

await test("G4 — both valid kinds round-trip", () => {
  assert.equal(collect({ endpointEvidenceKind: "speech_final" }).endpointEvidenceKind, "speech_final");
  assert.equal(collect({ endpointEvidenceKind: "utterance_end" }).endpointEvidenceKind, "utterance_end");
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
