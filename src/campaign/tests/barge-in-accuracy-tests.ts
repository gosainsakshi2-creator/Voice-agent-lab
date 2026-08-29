/**
 * barge-in-accuracy-tests.ts — `npm run test:barge-in`
 *
 * TWO REPORTED DEFECTS FROM A 100-CALL PILOT, AND THE BARGE-IN
 * BEHAVIOUR THAT MUST SURVIVE FIXING THEM.
 *
 * 1. THE AGENT WENT SILENT AND STAYED SILENT.
 *
 *    The caller says "hello" as they lift the handset — the commonest
 *    thing anybody says on a phone call. The opening line was ~120ms
 *    in; the transports' own energy VAD fired a barge-in, the outbound
 *    queue was dropped, and the caller was left listening to nothing
 *    while a reply was generated. Saying "hello" again cancelled THAT
 *    reply too, and the call could sit in that loop until they hung up.
 *
 *    The pipeline had always gated its OWN barge-in path behind
 *    `greetingDone` for exactly this reason. The transports reached the
 *    same cancellation without that gate. Section C is that gate, now
 *    applied at the single choke point both paths go through.
 *
 *    Section E is the other half, and it is the one that makes "the
 *    agent must never fall silent" true rather than merely likely: a
 *    barge-in does not always produce a turn to answer. A cough, a
 *    door, a half-word, a hesitation sound — the turn detector drops
 *    those by design — cancels the reply and leaves nothing behind to
 *    reply to. The unheard remainder is now resumed instead, with no
 *    LLM round trip, so the caller hears the rest of the sentence
 *    rather than dead air.
 *
 * 2. A BACKGROUND VOICE INTERRUPTED THE AGENT.
 *
 *    Deepgram is handed one mixed mono telephony channel and
 *    transcribes everything on it — a television, a second person
 *    across the room, our own audio echoing out of the caller's
 *    earpiece. Every one of those read as "the caller is talking over
 *    us" and cut the agent off mid-sentence.
 *
 *    Nothing in a transcript separates them from the caller. LOUDNESS
 *    does: the near-end speaker's mouth is centimetres from the
 *    microphone and the room is metres away. Section A is that
 *    measurement; Section D is the pipeline requiring the transcript
 *    and the loudness to AGREE before anything is interrupted.
 *
 * Section F is the guarantee neither fix may trade away: a real
 * interruption still interrupts, still wins, and is still answered
 * contextually by the language model rather than by any of the above.
 *
 * 3. THE AGENT PITCHED TO AN ANSWERING MACHINE.
 *
 *    A voicemail greeting opens the media stream exactly like a human
 *    answer, and there is no carrier verdict to consult, so the whole
 *    script was delivered to a recording. Sections G and H are the live
 *    gate: the same phrase table the outcome classifier has always used
 *    to keep a voicemail from becoming a registration, read DURING the
 *    call. The agent stops mid-word and the call is HUNG UP — there is
 *    nothing on the other end to talk to and no reason to hold the line
 *    open — and the window is bounded so it can never fire on somebody
 *    who has already spoken with the agent.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the VAD segmenter, the turn detector, the sentence chunker
 * and the conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { MulawVadSegmenter } = await import("../../server/vad-segmenter");
const { pcm16ToMulaw } = await import("../../server/audio-codec");
const { ConversationPipeline, unspokenTail } = await import(
  "../../core/session/conversation-pipeline"
);
const { voicemailPhraseIn } = await import("../../core/session/voicemail-detection");
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
section("SECTION A — the VAD's two energy gates (`MulawVadSegmenter`)");
// ═════════════════════════════════════════════════════════════════

/**
 * One 20ms μ-law frame at a given RMS amplitude. Alternating ±amplitude
 * makes the RMS exactly the amplitude before μ-law quantisation, which
 * costs a few percent — every amplitude used below is chosen to sit
 * clear of the thresholds it is being tested against.
 */
function frameAtRms(amplitude: number): Uint8Array {
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 2 === 0 ? amplitude : -amplitude;
  return pcm16ToMulaw(pcm);
}

const SILENT = frameAtRms(0);
/** Audible, but the sort of level a room away from the handset arrives at. */
const QUIET_SPEECH = frameAtRms(900);
/** Near-end speech on a phone line sits around RMS 2000-8000. */
const LOUD_SPEECH = frameAtRms(4000);

interface SegmenterProbe {
  readonly speechStarts: number;
  readonly loudRuns: number[];
  push(frame: Uint8Array, times?: number): void;
}

function probeSegmenter(options: Record<string, unknown> = {}): SegmenterProbe {
  const loudRuns: number[] = [];
  let speechStarts = 0;
  const segmenter = new MulawVadSegmenter(
    () => undefined,
    () => {
      speechStarts += 1;
    },
    {
      speechThreshold: 700,
      speechStartFrames: 6,
      loudSpeechThreshold: 1600,
      loudSpeechFrames: 4,
      onLoudSpeech: (loudMs: number) => loudRuns.push(loudMs),
      ...options,
    },
  );
  return {
    get speechStarts() {
      return speechStarts;
    },
    loudRuns,
    push(frame, times = 1) {
      for (let i = 0; i < times; i += 1) segmenter.push(frame);
    },
  };
}

await test("no `onLoudSpeech` supplied — the segmenter behaves exactly as before", () => {
  let speechStarts = 0;
  const segmenter = new MulawVadSegmenter(
    () => undefined,
    () => {
      speechStarts += 1;
    },
    { speechThreshold: 700, speechStartFrames: 6 },
  );
  // Loud audio, and no loud threshold configured: nothing extra can
  // fire, and the liveness onset is unchanged at 6 frames.
  for (let i = 0; i < 5; i += 1) segmenter.push(LOUD_SPEECH);
  assert.equal(speechStarts, 0, "5 frames is below the 6-frame onset");
  segmenter.push(LOUD_SPEECH);
  assert.equal(speechStarts, 1, "the 6th frame fires liveness");
});

await test("QUIET speech is liveness only — it never reports as near-end speech", () => {
  const probe = probeSegmenter();
  // A full second of it: the caller is audibly there, but this is not
  // somebody talking into the handset.
  probe.push(QUIET_SPEECH, 50);
  assert.equal(probe.speechStarts, 1, "liveness must still fire — the line is not silent");
  assert.deepEqual(probe.loudRuns, [], "quiet speech must never corroborate a barge-in");
});

await test("LOUD speech reports near-end speech, and reports how long it has lasted", () => {
  const probe = probeSegmenter();
  probe.push(LOUD_SPEECH, 3);
  assert.deepEqual(probe.loudRuns, [], "3 frames is below the 4-frame onset");
  probe.push(LOUD_SPEECH);
  assert.deepEqual(probe.loudRuns, [80], "the 4th frame reports an 80ms run");
  probe.push(LOUD_SPEECH, 2);
  assert.deepEqual(probe.loudRuns, [80, 100, 120], "the run is reported as it grows");
});

await test("a run long enough to barge in with no transcript is reachable through real speech", () => {
  const probe = probeSegmenter();
  // Loud vowels with 40ms dips between them — the shape of speech, and
  // the reason the run is gap-tolerant. Without that tolerance no run
  // could ever exceed ~100ms and the 700ms measurement the transports
  // barge in on would be unreachable.
  for (let i = 0; i < 12; i += 1) {
    probe.push(LOUD_SPEECH, 4);
    probe.push(SILENT, 2);
  }
  const longest = Math.max(...probe.loudRuns);
  assert.ok(longest >= 700, `a second of ordinary loud speech must reach 700ms, got ${longest}ms`);
});

await test("a gap longer than the tolerance ENDS the run — background chatter never accumulates", () => {
  const probe = probeSegmenter();
  // Bursts of loud audio separated by 200ms of quiet: exactly what an
  // intermittent background conversation looks like. Each burst may
  // corroborate at that instant, but no run may ever grow long enough
  // to barge in on its own.
  for (let i = 0; i < 10; i += 1) {
    probe.push(LOUD_SPEECH, 5);
    probe.push(SILENT, 10);
  }
  const longest = Math.max(...probe.loudRuns);
  assert.ok(longest < 700, `bursts must not accumulate into a sustained run, got ${longest}ms`);
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — the unheard remainder of an interrupted reply (`unspokenTail`)");
// ═════════════════════════════════════════════════════════════════

await test("the remainder is whatever follows what the caller heard", () => {
  const full = "First sentence. Second sentence. Third sentence.";
  assert.equal(unspokenTail(full, "First sentence."), "Second sentence. Third sentence.");
  assert.equal(unspokenTail(full, "First sentence. Second sentence."), "Third sentence.");
});

await test("whitespace differences do not matter — the utterances are joined, not sliced", () => {
  const full = "First sentence.\n\nSecond sentence.   Third sentence.";
  assert.equal(
    unspokenTail(full, "First sentence. Second sentence."),
    "Third sentence.",
    "the heard text is utterances joined by single spaces; the reply is not",
  );
});

await test("nothing heard means the whole reply is unheard", () => {
  assert.equal(unspokenTail("The whole thing.", ""), "The whole thing.");
  assert.equal(unspokenTail("The whole thing.", "   "), "The whole thing.");
});

await test("everything heard means there is nothing to resume", () => {
  assert.equal(unspokenTail("All of it.", "All of it."), "");
});

await test("divergence resumes NOTHING rather than guessing", () => {
  // Per-utterance speech formatting is not guaranteed to agree with
  // formatting applied to the whole reply. When the two do not line up,
  // saying nothing is correct and improvising is not.
  assert.equal(unspokenTail("First sentence. Second.", "Different words."), "");
  assert.equal(unspokenTail("Short.", "Short. But longer than the reply."), "");
});

// ═════════════════════════════════════════════════════════════════
// THE PIPELINE HARNESS
//
// Fakes stand in for the four vendors and nothing else. Audio is
// MULAW/8000, where one byte is one sample, so a clip's real-time
// duration is exactly `bytes / 8` ms — which is what lets a test say
// "interrupt 400ms into the reply" and mean it.
// ═════════════════════════════════════════════════════════════════

/** Speech rate used to size a fake clip. ~22 chars/second is ordinary speech. */
const CHARS_PER_SECOND = 22;

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
  readonly isSpeechFinal?: boolean;
  readonly confidence?: number;
  /**
   * What the TRANSPORT heard at the moment these words were recognised.
   * `"loud"` is the caller talking into the handset (the transports'
   * near-end gate fired); `"quiet"` is a voice the energy VAD does not
   * corroborate — a television, the room, our own echo; `"none"` is a
   * transport that reports no energy at all (the in-process fallback
   * and every other harness), which must keep the transcript-only
   * behaviour this had before the energy gate existed.
   */
  readonly heardBy?: "loud" | "quiet" | "none";
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  /** How many times the pipeline asked the manager to hang up. */
  hangupCount(): number;
  say(text: string, opts?: SayOptions): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  replyCount(): number;
  assistantTexts(): string[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;
  /** How many times the pipeline asked the manager to end the call. */
  let hangups = 0;

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
      // conversational request: not recorded, consumes no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(input.replyDelayMs ?? 10);
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
    "barge-in-test" as SessionId,
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
    // The real manager's `end`, reduced to what a test can observe: the
    // loop is aborted and the hangup is counted.
    end: async () => {
      hangups += 1;
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

  return {
    record,
    pipeline,
    requests,
    synthesized,
    hangupCount() {
      return hangups;
    },
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      // What the transport heard, stamped exactly as the bridges stamp
      // it — before the segment reaches the pipeline, because that is
      // the order the two arrive in on a real call (the energy VAD fires
      // at 80ms, the transcript lands hundreds of ms later).
      switch (opts?.heardBy ?? "loud") {
        case "loud":
          record.lastCallerEnergyAt = Date.now();
          break;
        case "quiet":
          // The energy VAD did not corroborate. Non-zero, so this is a
          // transport that DOES report energy — it just is not hearing
          // near-end speech right now. Stale by more than the window.
          record.lastCallerEnergyAt = Date.now() - 30_000;
          break;
        case "none":
          record.lastCallerEnergyAt = 0;
          break;
      }
      record.lastConversationActivityAt = Date.now();
      segments.push({
        text,
        isFinal,
        ...(opts?.isSpeechFinal !== undefined ? { isSpeechFinal: opts.isSpeechFinal } : { isSpeechFinal: isFinal }),
        confidence: opts?.confidence ?? 0.95,
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
    assistantTexts() {
      return record.memory
        .history()
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.content);
    },
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
/**
 * Two sentences, ~3.1s of fake audio. Short enough that an
 * acknowledgement landing 400ms in has under 4s of reply left, which is
 * what makes it a real barge-in rather than an ignored backchannel.
 */
const BLOCK = "We have created Flexi Genie, which automates your online business. It builds funnels and pages for you.";

// ═════════════════════════════════════════════════════════════════
section('SECTION C — the opening line is not interruptible, from ANY path');
// ═════════════════════════════════════════════════════════════════

await test('"hello" as the caller picks up does not truncate the opening line', async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["Sure, listen."] });
  try {
    // The transport's energy VAD fires 80ms into their "hello" — this is
    // the exact call the Plivo and Vobiz bridges make, and the one that
    // used to drop the outbound queue mid-greeting.
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    const accepted = h.pipeline.triggerExternalBargeIn();
    assert.equal(accepted, false, "a barge-in over the opening line must be DECLINED");

    // And the greeting completes: every word of it committed, and the
    // caller left listening to speech rather than to nothing.
    await h.waitForReplies(1);
    assert.deepEqual(h.assistantTexts(), [OPENING], "the whole opening line must be spoken");
  } finally {
    await h.stop();
  }
});

await test("the caller's words during the opening line are not lost — they are answered after it", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["It is a free AI workshop."] });
  try {
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    h.say("Hello? Who is this?");
    await h.waitForReplies(2);
    assert.deepEqual(
      h.assistantTexts(),
      [OPENING, "It is a free AI workshop."],
      "the buffered turn must be answered once the opening line finishes",
    );
  } finally {
    await h.stop();
  }
});

await test("once the opening line is done, a barge-in is accepted exactly as before", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    assert.equal(
      h.pipeline.triggerExternalBargeIn(),
      true,
      "a barge-in over a generated reply must still be accepted",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — a transcribed voice the transport does not corroborate");
// ═════════════════════════════════════════════════════════════════

await test("a background voice does NOT interrupt, and does NOT become a turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    const requestsBefore = h.requests.length;
    await sleep(400);

    // Words, over the agent, that the energy VAD does not corroborate.
    // On a real call this is a television or somebody across the room.
    h.say("and then he told her the whole story about it", { heardBy: "quiet" });

    // The block finishes — every sentence of it — and no reply is
    // generated for a voice that was never talking to us.
    await h.waitForReplies(2);
    assert.deepEqual(
      h.assistantTexts(),
      [OPENING, BLOCK],
      "the block must be committed WHOLE — nothing interrupted it",
    );
    assert.equal(
      h.requests.length,
      requestsBefore,
      "a background voice must not produce a turn for the model to answer",
    );
  } finally {
    await h.stop();
  }
});

await test("a LOW-CONFIDENCE transcript does not interrupt either", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    // Loud on the line, but the recogniser is barely guessing — the
    // signature of distant or overlapped speech.
    h.say("mumble something unclear", { heardBy: "loud", confidence: 0.12 });
    await h.waitForReplies(2);
    assert.deepEqual(h.assistantTexts(), [OPENING, BLOCK], "the block must be committed WHOLE");
  } finally {
    await h.stop();
  }
});

await test("a transport that reports NO energy keeps the transcript-only behaviour", async () => {
  // The in-process audio fallback, and every harness that is not a
  // telephony bridge. Corroboration is unavailable, not absent — so a
  // transcript over the agent must interrupt exactly as it always did.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.", { heardBy: "none" });
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    h.say("No, I am not interested at all.", { heardBy: "none" });
    await h.waitForReplies(3);
    const committed = h.assistantTexts()[1] ?? "";
    assert.ok(committed.length > 0, "the part the caller heard must be committed");
    assert.ok(
      committed.length < BLOCK.length,
      `the block must have been CUT SHORT: committed ${committed.length} of ${BLOCK.length} chars`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — a barge-in that produces no turn never leaves the caller in silence");
// ═════════════════════════════════════════════════════════════════

await test("a barge-in with no transcript at all RESUMES the unheard remainder", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    const requestsBefore = h.requests.length;

    // The transports' last-resort path: sustained loud energy over the
    // agent with no words behind it — a cough, a door, a chair, a
    // half-word Deepgram never finalises. The reply is cancelled and
    // there is NOTHING to answer, which is the state the caller used to
    // be abandoned in, listening to silence with the agent stopped
    // mid-sentence.
    assert.equal(h.pipeline.triggerExternalBargeIn(), true, "the barge-in must be accepted");

    // Two assistant turns after the opening: the part they heard, then
    // the part they did not.
    await h.waitForReplies(3);
    const spoken = h.assistantTexts();
    assert.equal(spoken[0], OPENING);
    assert.ok(
      spoken[1] !== undefined && BLOCK.startsWith(spoken[1]),
      `the heard part must be committed first, got ${JSON.stringify(spoken[1])}`,
    );
    assert.ok(
      spoken[2] !== undefined && spoken[2].length > 0 && BLOCK.endsWith(spoken[2]),
      `the resumed part must be the TAIL of the same block, got ${JSON.stringify(spoken[2])}`,
    );
    assert.ok(
      !spoken[2]!.startsWith("We have created"),
      "the resume must continue the block, never restart it",
    );
    assert.equal(
      h.requests.length,
      requestsBefore,
      "the resume must cost no language-model round trip — that is why it is fast",
    );
  } finally {
    await h.stop();
  }
});

await test("nothing heard at all still gets resumed rather than dropped", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "Sure."], replyDelayMs: 10 });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    // Interrupt as early as the pipeline can be caught speaking, so
    // almost none of the reply has played.
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    h.say("umm");
    await h.waitFor(
      "the agent to speak again",
      () => h.assistantTexts().some((text) => text.includes("It builds funnels")),
      10_000,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — a REAL interruption is untouched by all of the above");
// ═════════════════════════════════════════════════════════════════

await test("loud, confident, meaningful speech still interrupts and still wins", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, "No problem, I will not call again."],
  });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(400);
    const requestsBefore = h.requests.length;
    h.say("No, please do not call me again.");

    await h.waitForReplies(3);
    const spoken = h.assistantTexts();
    assert.ok(
      spoken[1] !== undefined && spoken[1].length < BLOCK.length,
      "the block must have been cut short by a real interruption",
    );
    assert.equal(
      spoken[2],
      "No problem, I will not call again.",
      `the interruption must be answered by the model, got ${JSON.stringify(spoken[2])}`,
    );
    assert.ok(
      h.requests.length > requestsBefore,
      "a real interruption must produce a language-model request",
    );
  } finally {
    await h.stop();
  }
});

await test("a backchannel is still ignored, and is still not a barge-in", async () => {
  const h = startHarness({
    openingLine: OPENING,
    // Long enough that "okay" lands with more than the backchannel
    // threshold of reply left to play.
    replies: [`${BLOCK} ${BLOCK} ${BLOCK}`, "Sure."],
  });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitFor("the block to start", () => h.record.state === SessionState.SPEAKING);
    await sleep(300);
    h.say("okay");
    await h.waitForReplies(2);
    assert.equal(
      h.assistantTexts()[1],
      `${BLOCK} ${BLOCK} ${BLOCK}`,
      "an acknowledgement must not interrupt, and must not truncate the reply",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION G — the voicemail phrase table (`voicemailPhraseIn`)");
// ═════════════════════════════════════════════════════════════════

await test("machine and carrier language is recognised, and the matched phrase is reported", () => {
  assert.equal(
    voicemailPhraseIn("Please leave a message after the beep."),
    "leave a message after",
  );
  assert.equal(voicemailPhraseIn("The person you are calling is not available right now."), "not available right now");
  assert.equal(voicemailPhraseIn("Your call has been forwarded to voicemail."), "has been forwarded to voicemail");
  assert.equal(voicemailPhraseIn("Beep ke baad apna sandesh record kijiye."), "sandesh record");
  assert.equal(voicemailPhraseIn("जिस व्यक्ति को आप कॉल कर रहे हैं वह उपलब्ध नहीं है।"), "उपलब्ध नहीं");
});

await test("punctuation and casing do not matter — the match is on words", () => {
  assert.equal(voicemailPhraseIn("...VOICE-MAIL..."), "voice mail");
  assert.equal(voicemailPhraseIn("after the beep!"), "after the beep");
});

await test("ordinary human speech is NOT a machine", () => {
  for (const said of [
    "Hello? Who is this?",
    "Yes, tell me about the workshop.",
    "Haan ji, main sun raha hoon.",
    "No, I am not interested, please do not call again.",
    "I am busy right now, call me tomorrow.",
    "",
    "   ",
  ]) {
    assert.equal(voicemailPhraseIn(said), undefined, `"${said}" must not read as a machine`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION H — the agent does not speak to a machine, it hangs up");
// ═════════════════════════════════════════════════════════════════

const MUST_NOT_BE_SPOKEN = "This is the pitch and a machine must never hear it.";

await test("a voicemail greeting stops the agent AND hangs the call up", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [MUST_NOT_BE_SPOKEN] });
  try {
    // The machine's greeting is the first thing on the line — which is
    // what actually happens: it starts the instant the stream opens,
    // and our opening line needs a synthesis round trip first.
    h.say("Hello, the person you are calling is not available right now. Please leave a message after the beep.");

    // Generous: long enough for the pipeline to have generated, spoken
    // and committed a whole reply if it were going to.
    await sleep(3000);

    assert.equal(h.requests.length, 0, "a machine must never reach the language model");
    assert.ok(
      !h.synthesized.some((text) => text.includes("pitch")),
      `nothing generated may be synthesized, got ${JSON.stringify(h.synthesized)}`,
    );
    assert.deepEqual(
      h.assistantTexts(),
      [],
      "no assistant turn may be committed — a machine heard no line of ours to record",
    );
    assert.ok(h.hangupCount() >= 1, "the call must be hung up, not held open in silence");
  } finally {
    await h.stop();
  }
});

await test("the machine's greeting IS recorded — it is what labels the call", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [MUST_NOT_BE_SPOKEN] });
  try {
    h.say("Please leave a message after the beep.");
    // Committed at the moment of detection, BEFORE the hangup: the
    // outcome classifier reads this transcript and the phrase is the
    // whole evidence for `suspected_voicemail`. Hanging up without it
    // would file the call as an ordinary silent one.
    await h.waitFor(
      "the machine's words to reach the transcript",
      () =>
        h.record.memory
          .history()
          .some((turn) => turn.role === "user" && turn.content.includes("leave a message")),
      8000,
    );
    assert.equal(h.requests.length, 0, "recording it must not mean answering it");
    assert.ok(h.hangupCount() >= 1, "and the call is ended once the evidence is recorded");
  } finally {
    await h.stop();
  }
});

await test("a voicemail greeting mid-way through our opening line cuts it off and ends the call", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [MUST_NOT_BE_SPOKEN] });
  try {
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    h.say("Sorry, the number you are calling is currently unavailable.");
    await sleep(2500);
    assert.deepEqual(
      h.assistantTexts(),
      [],
      "a line a machine cut short must not be committed as spoken",
    );
    assert.equal(h.requests.length, 0, "and nothing may be generated after it");
    assert.ok(h.hangupCount() >= 1, "and the line is released rather than held open");
  } finally {
    await h.stop();
  }
});

await test("a marker AFTER a real exchange can never silence a person", async () => {
  const h = startHarness({
    openingLine: OPENING,
    replies: ["The workshop is free and runs this Sunday.", "Sure, I will send the details."],
  });
  try {
    // One real exchange first: the person has now been answered, so the
    // detection window is closed for the rest of the call.
    await h.waitForReplies(1);
    h.say("Yes, tell me more.");
    await h.waitForReplies(2);

    // A person talking about their own phone. This must be answered
    // exactly like anything else they say.
    h.say("Okay, can you please leave a message on my voicemail as well?");
    await h.waitForReplies(3);
    assert.equal(
      h.assistantTexts()[2],
      "Sure, I will send the details.",
      "a person who has already spoken with the agent must still be answered",
    );
    assert.equal(h.hangupCount(), 0, "and must never be hung up on");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION I — the energy-only fallback fires only when STT is dead (`vobiz-media-bridge`)");
// ═════════════════════════════════════════════════════════════════
//
// The transport's LAST-RESORT barge-in — 700ms of loud near-end energy
// with no transcript — exists for a dead Deepgram socket. On live calls
// it fired with a healthy socket: ~700ms of loud NON-speech energy (our
// own audio echoing back, a line burst) that Deepgram correctly did not
// transcribe. It cleared the whole outbound queue (596 frames = 11.9s
// of already-generated Sarvam audio on the reported call) and aborted
// the TTS stream, and the caller heard the sentence stop. The bridge now
// asks the manager how recently STT delivered ANY segment, and stands
// down while that is fresh. Everything else — the energy gates, the
// pipeline's transcript-confirmed path, `clearOutboundPlayback` — is
// unchanged, and these tests pin each of those down.

const { attachVobizMediaBridge } = await import("../../server/vobiz-media-bridge");

interface BridgeSocketFake {
  readyState: number;
  readonly sent: string[];
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

function fakeBridgeSocket(): BridgeSocketFake {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

type StateListener = (sessionId: SessionId, transition: { from: unknown; to: unknown; reason?: string }) => void;

/**
 * The manager reduced to the hooks the bridge uses, with the one fact
 * under test — how long ago STT last delivered a segment — injectable.
 * `signalBargeIn` behaves like the real one: it accepts, and the
 * pipeline's SPEAKING -> LISTENING transition follows synchronously.
 */
function fakeBridgeManager(input: { sttEvidenceAgeMs: number | undefined; sessionId: SessionId }) {
  let stateListener: StateListener | undefined;
  let outbound: ((chunk: AudioPayload) => void) | undefined;
  const calls = { signalBargeIn: 0, noteCallerEnergy: 0 };
  const manager = {
    onOutboundAudio: (_sid: SessionId, listener: (chunk: AudioPayload) => void) => {
      outbound = listener;
      return () => undefined;
    },
    onStateChange: (listener: StateListener) => {
      stateListener = listener;
      return () => undefined;
    },
    setProviderCallId: () => undefined,
    confirmCallAnswered: () => undefined,
    pushInboundAudio: () => undefined,
    noteCallerSpeech: () => undefined,
    noteCallerEnergy: () => {
      calls.noteCallerEnergy += 1;
    },
    sttEvidenceAgeMs: () => input.sttEvidenceAgeMs,
    signalBargeIn: () => {
      calls.signalBargeIn += 1;
      stateListener?.(input.sessionId, {
        from: SessionState.SPEAKING,
        to: SessionState.LISTENING,
        reason: "external barge-in signal",
      });
      return true;
    },
    end: async () => undefined,
  };
  return {
    manager: manager as never,
    calls,
    /** The pipeline entering SPEAKING for a reply. */
    enterSpeaking() {
      stateListener?.(input.sessionId, { from: SessionState.THINKING, to: SessionState.SPEAKING, reason: "reply" });
    },
    /** The pipeline's own transcript-confirmed barge-in, as the bridge sees it. */
    transcriptConfirmedBargeIn() {
      stateListener?.(input.sessionId, {
        from: SessionState.SPEAKING,
        to: SessionState.LISTENING,
        reason: "external barge-in signal",
      });
    },
    /** Streaming TTS handing the bridge `seconds` of already-synthesized reply audio. */
    queueReplyAudio(seconds: number) {
      const pcm = new Int16Array(Math.round(8000 * seconds));
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 2 === 0 ? 3000 : -3000;
      outbound?.({ data: new Uint8Array(pcm.buffer), encoding: "PCM_16", sampleRateHz: 8000 });
    },
  };
}

function mediaEvent(frame: Uint8Array): string {
  return JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.from(frame).toString("base64") } });
}

function clearAudioCount(socket: BridgeSocketFake): number {
  return socket.sent.filter((raw) => (JSON.parse(raw) as { event?: string }).event === "clearAudio").length;
}

/** A reply is playing and the transport hears `frames` × 20ms of loud near-end energy over it. */
function speakingBridgeHearingLoudEnergy(input: { sttEvidenceAgeMs: number | undefined; frames: number }) {
  const sessionId = "sess_energy_only" as SessionId;
  const socket = fakeBridgeSocket();
  const fake = fakeBridgeManager({ sttEvidenceAgeMs: input.sttEvidenceAgeMs, sessionId });
  attachVobizMediaBridge(socket, sessionId, fake.manager);
  socket.emit("message", JSON.stringify({ event: "start", start: { streamId: "stream_1", callId: "call_1" } }));
  fake.enterSpeaking();
  fake.queueReplyAudio(12);
  for (let i = 0; i < input.frames; i += 1) socket.emit("message", mediaEvent(LOUD_SPEECH));
  return { socket, fake };
}

await test("I1. STT alive: 800ms of loud energy with no transcript does NOT barge in, and the queued reply survives", () => {
  const { socket, fake } = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: 1_500, frames: 40 });
  try {
    assert.ok(fake.calls.noteCallerEnergy > 0, "the loud gate must have fired — otherwise this test proves nothing");
    assert.equal(fake.calls.signalBargeIn, 0, "the energy-only fallback must stand down while STT is delivering");
    assert.equal(clearAudioCount(socket), 0, "and the outbound queue must not be cleared");
  } finally {
    socket.emit("close");
  }
});

await test("I2. STT dead (no segment for longer than the unhealthy window): the fallback still barges in and clears the queue", () => {
  const { socket, fake } = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: 45_000, frames: 40 });
  try {
    assert.ok(fake.calls.signalBargeIn >= 1, "the dead-STT fallback must still interrupt");
    assert.ok(clearAudioCount(socket) >= 1, "and still clear playback exactly as before");
  } finally {
    socket.emit("close");
  }
});

await test("I2b. STT never delivered anything on this call: previous behaviour is preserved (fallback fires)", () => {
  const { socket, fake } = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: undefined, frames: 40 });
  try {
    assert.ok(fake.calls.signalBargeIn >= 1, "no evidence STT is alive must keep the old fallback");
    assert.ok(clearAudioCount(socket) >= 1);
  } finally {
    socket.emit("close");
  }
});

await test("I3. STT alive: the pipeline's transcript-confirmed barge-in still clears playback through the bridge", () => {
  const { socket, fake } = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: 1_500, frames: 40 });
  try {
    assert.equal(fake.calls.signalBargeIn, 0, "precondition: the energy-only path stood down");
    fake.transcriptConfirmedBargeIn();
    assert.equal(clearAudioCount(socket), 1, "a genuine, transcript-confirmed interruption still stops playback");
  } finally {
    socket.emit("close");
  }
});

await test("I4. STT dead: the fallback fires exactly once — the loud frames that follow do not barge in again", () => {
  const { socket, fake } = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: undefined, frames: 40 });
  try {
    assert.equal(fake.calls.signalBargeIn, 1, "one barge-in per interruption");
    // The run continues for another second after the reply was cut.
    for (let i = 0; i < 50; i += 1) socket.emit("message", mediaEvent(LOUD_SPEECH));
    assert.equal(fake.calls.signalBargeIn, 1, "nothing is playing any more, so there is nothing to interrupt");
  } finally {
    socket.emit("close");
  }
});

await test("I5. below the 700ms energy-only threshold nothing fires, alive or dead — the threshold is unchanged", () => {
  const dead = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: undefined, frames: 30 });
  const alive = speakingBridgeHearingLoudEnergy({ sttEvidenceAgeMs: 1_500, frames: 30 });
  try {
    assert.equal(dead.fake.calls.signalBargeIn, 0);
    assert.equal(alive.fake.calls.signalBargeIn, 0);
    assert.ok(dead.fake.calls.noteCallerEnergy > 0, "the 80ms corroboration stamp is still reported either way");
  } finally {
    dead.socket.emit("close");
    alive.socket.emit("close");
  }
});

await test("I6. the pipeline stamps STT evidence for interim AND final segments, and nothing else changes for them", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["The workshop is free and runs this Sunday."] });
  try {
    await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
    assert.equal(h.record.lastSttEvidenceAt, 0, "nothing delivered yet: no evidence, so the fallback keeps its old behaviour");
    const before = Date.now();
    h.say("I was", { isFinal: false });
    await h.waitFor("an interim to be stamped", () => h.record.lastSttEvidenceAt >= before);
    const afterInterim = h.record.lastSttEvidenceAt;
    await sleep(30);
    h.say("I was wondering about the price.", { isFinal: true });
    await h.waitFor("a final to be stamped", () => h.record.lastSttEvidenceAt > afterInterim);
    // The stamp is observation only: the turn is still released and answered exactly as before.
    await h.waitForReplies(2);
    assert.equal(h.assistantTexts()[1], "The workshop is free and runs this Sunday.");
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
