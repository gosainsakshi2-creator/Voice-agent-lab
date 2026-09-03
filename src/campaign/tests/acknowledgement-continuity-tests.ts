/**
 * acknowledgement-continuity-tests.ts — `npm run test:ack-continuity`
 *
 * "OKAY" / "ACHHA" / "HAAN JI" / "HMM" / "HELLO?" SAID WHILE THE AGENT
 * IS STILL SPEAKING.
 *
 * Two questions, and they are deliberately kept apart:
 *
 *   1. Does a PURE ACKNOWLEDGEMENT over a block interrupt it? It must
 *      not — the agent finishes its sentence, no turn is created, no
 *      language-model request is made, and the block is committed in
 *      full. That is the pre-existing backchannel rule (see
 *      `ConversationPipeline.isBackchannel`); these tests pin it for
 *      every word in the reported vocabulary so a change to the table
 *      or the gate fails here.
 *
 *   2. After a NON-SUBSTANTIVE utterance has cut the reply short, is
 *      the caller then treated as absent? They were not: they spoke.
 *      The reported defect is the agent answering its own
 *      acknowledgement with "Hello, are you there?" — the caller's
 *      "Hello?" read back to them as silence, with the rest of the
 *      block never spoken. `recoverFromSilence` now resumes the HELD
 *      script position at that expiry instead, which is what every
 *      other reader of `heldScriptRemainder` already does with it.
 *
 * AND THE TWO THINGS THAT MUST NOT MOVE:
 *
 *   - MEANINGFUL SPEECH still takes the floor. "Okay, but I have a
 *     question..." and "Achha, mujhe ... ek question hai" interrupt and
 *     reach the model exactly as they do today. An acknowledgement is
 *     only ever a whole utterance; a word of content anywhere in it
 *     makes it a turn.
 *   - GENUINE SILENCE still recovers on exactly today's schedule:
 *     prompt 1 at 8s, prompt 2 at 8s more, then the hangup. Including
 *     after a backchannel — a caller who says "okay" and then really
 *     does go quiet is still asked.
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

/** The production constant, restated here so a change to it fails a test rather than silently shifting one. */
const INTERVAL_MS = 8_000;
/** Timer slack: setTimeout on a loaded machine, plus the 25ms re-arm floor. */
const SLACK_MS = 250;

const PROMPT_1 = "Hello, are you there?";
const PROMPT_2 = "Hello, is anyone there?";
const ACK = "Hello, can you hear me?";
const FOLLOW_UP = "I just want to make sure you can hear me. Did you catch what I was saying?";

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — the shape `attention-check-tests.ts` uses, plus
// timestamps on every transition and synthesis, and a counted `end`.
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

/** Playback duration of the fake clip for `text`, in ms — bytes / 8 for MULAW/8000. */
function playbackMsOf(text: string): number {
  return clipFor(text).data.byteLength / 8;
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

interface Transition {
  readonly from: string;
  readonly to: string;
  readonly reason: string | undefined;
  readonly atMs: number;
}

interface Synthesis {
  readonly text: string;
  readonly atMs: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order, with its wall clock. */
  readonly syntheses: Synthesis[];
  readonly transitions: Transition[];
  /** How many times the pipeline asked the host to end the call. */
  endCalls(): number;
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Resolves once the given number of assistant turns are committed AND the session is LISTENING. */
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  /** The loop is aborted the way `manager.end()` aborts it (a remote hangup). */
  abortLikeRemoteHangup(): void;
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const syntheses: Synthesis[] = [];
  const transitions: Transition[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let endCalls = 0;
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
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays. Not a conversational request.
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
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      syntheses.push({ text: task.request.text, atMs: Date.now() });
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
    "silence-test" as SessionId,
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
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
      reason?: string,
    ) => {
      transitions.push({ from: String(r.state), to: String(to), reason, atMs: Date.now() });
      r.state = to;
    },
    markError: () => undefined,
    // What `DefaultVoiceSessionManager.end()` does to the loop: abort
    // it. The carrier-leg hangup is the manager's, not the pipeline's,
    // and is covered by `test:vobiz-call-control`.
    end: async () => {
      endCalls += 1;
      record.loopAbortController?.abort();
    },
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
    syntheses,
    transitions,
    endCalls: () => endCalls,
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
    abortLikeRemoteHangup() {
      record.loopAbortController?.abort();
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

const texts = (s: readonly Synthesis[]) => s.map((x) => x.text);
const count = (s: readonly Synthesis[], text: string) => s.filter((x) => x.text === text).length;
// `.trim()`: the pre-existing acknowledgement constant is committed with
// a trailing space (`attentionAcknowledgementFor`), while every TTS
// request is trimmed by `toSpokenText`.
const assistantTexts = (h: readonly ConversationTurn[]) =>
  h.filter((t) => t.role === "assistant").map((t) => t.content.trim());

/** The wall clock of the LAST `SPEAKING -> LISTENING` transition, i.e. the moment audio had drained. */
function lastListeningAt(h: Harness): number {
  const t = [...h.transitions].reverse().find((x) => x.from === "SPEAKING" && x.to === "LISTENING");
  assert.ok(t, "expected a SPEAKING -> LISTENING transition");
  return t.atMs;
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK =
  "I'm calling to personally invite you to a free live workshop we're doing tomorrow at 11 AM. " +
  "You'll actually see a complete online business being built live from a phone, including the website, product, checkout and payments. " +
  "Would you like me to reserve your free seat?";
const REPLY = "Great, so as I was saying, the workshop is tomorrow at 11 AM. Shall I reserve your seat?";

/**
 * Drives the call to the moment every silence test starts from: the
 * greeting has been spoken IN FULL and the session is LISTENING.
 */
async function greetingDone(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  assert.deepEqual(texts(h.syntheses), [OPENING], "only the greeting has been spoken");
  assert.equal(h.requests.length, 0, "no conversational request has been made");
}
/**
 * A three-sentence pitch block, sized so that a caller speaking 1.5s in
 * is speaking over the FIRST sentence with two more still to come. That
 * is the shape both halves of this file need: more reply left to speak
 * (so a bare acknowledgement is backchannel), and a real unheard
 * remainder to hold if something does cut it short.
 */
const PITCH =
  "I'm calling to invite you to a free live workshop tomorrow at 11 AM. " +
  "You'll see a complete online business being built live from a phone. " +
  "Would you like me to reserve your free seat?";

/** How far into the block every test below speaks. */
const SPEAK_AT_MS = 1_500;

/** Drives the call to "the greeting is done and the block is playing". */
async function blockPlaying(h: Harness): Promise<void> {
  await greetingDone(h);
  h.say("Hi.");
  await h.waitFor(
    "the block is playing",
    () => h.record.state === SessionState.SPEAKING && h.syntheses.length > 1,
    8_000,
  );
  await sleep(SPEAK_AT_MS);
}

/** Speaks `text` the way Deepgram delivers it: an interim, then the final. */
function utter(h: Harness, text: string): void {
  h.say(text, { isFinal: false });
  h.say(text, { isFinal: true, isSpeechFinal: true });
}

/** Every `SPEAKING -> LISTENING` transition the pipeline attributed to a barge-in. */
const bargeIns = (h: Harness) =>
  h.transitions.filter((t) => t.from === "SPEAKING" && (t.reason ?? "").includes("barge-in"));

const userTurns = (h: Harness) => h.history().filter((t) => t.role === "user").map((t) => t.content);

// ═════════════════════════════════════════════════════════════════
// 1-4 — A PURE ACKNOWLEDGEMENT OVER THE BLOCK IS NOT AN INTERRUPTION
//
// The reported "the agent pauses when I say okay". Every assertion is
// about the ABSENCE of a reaction: no barge-in, no turn, no request,
// and the block committed whole — which is also what keeps the
// commitment question inside it in the transcript the FINAL_YES gate
// reads.
// ═════════════════════════════════════════════════════════════════
section("1-4. a pure acknowledgement over the block: the agent just keeps talking");

for (const word of ["Okay", "Achha", "Haan ji", "Hmm"]) {
  await test(`"${word}" while SPEAKING — no barge-in, no turn, no request, the block is committed in full`, async () => {
    const h = startHarness({ openingLine: OPENING, replies: [PITCH] });
    try {
      await blockPlaying(h);
      utter(h, word);
      // Out to the end of the block's own audio, so the assertions are
      // about a block that finished on its own rather than one that
      // simply had not been cut yet.
      await h.waitForReplies(2, 20_000);

      assert.deepEqual(bargeIns(h), [], `"${word}" must not interrupt the block`);
      assert.equal(
        assistantTexts(h.history()).at(-1),
        PITCH,
        "the block was committed in full, so the next request can see it was said",
      );
      assert.deepEqual(userTurns(h), ["Hi."], `"${word}" became no user turn`);
      assert.equal(h.requests.length, 1, `no language-model request for "${word}"`);
      assert.deepEqual(
        texts(h.syntheses).filter((t) => t === PROMPT_1 || t === PROMPT_2 || t === ACK),
        [],
        "nothing from the attention or recovery family was spoken",
      );
    } finally {
      await h.stop();
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// 5 / 10 — "HELLO?" OVER THE BLOCK IS NOT SILENCE
//
// THE REPORTED DEFECT. "Hello?" over a playing reply interrupts it —
// that is deliberate and unchanged, because over audio the caller is
// hearing it means the line may have gone bad. What was wrong is what
// came next: the acknowledgement was spoken, the unheard rest of the
// block was HELD, and then the 8s silence window read the caller as
// absent and asked "Hello, are you there?" — their own presence check
// answered as an absence, with the block never finished.
//
// Now that expiry resumes the held position instead.
// ═════════════════════════════════════════════════════════════════
section('5/10. "Hello?" over the block — acknowledged once, then the block CARRIES ON');

await test('5 — "Hello?" while SPEAKING: acknowledged, then the held remainder is resumed and NO "are you there?" is spoken', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [PITCH] });
  try {
    await blockPlaying(h);
    utter(h, "Hello?");

    await h.waitFor("the acknowledgement", () => count(h.syntheses, ACK) === 1, 15_000);
    const ackAt = h.syntheses.find((s) => s.text === ACK)!.atMs;

    // The caller says nothing more. The window expires once.
    await h.waitFor(
      "the block to carry on from where it stopped",
      () => h.syntheses.some((s) => s.atMs > ackAt && PITCH.includes(s.text) && s.text !== PITCH),
      INTERVAL_MS + 15_000,
    );
    const resumed = h.syntheses.filter((s) => s.atMs > ackAt).at(-1)!;

    assert.ok(
      resumed.atMs - ackAt >= INTERVAL_MS - SLACK_MS,
      `the resume waited out the whole window (${resumed.atMs - ackAt}ms)`,
    );
    assert.ok(PITCH.endsWith(resumed.text), `what was resumed is the unheard TAIL of the block: "${resumed.text}"`);
    assert.equal(count(h.syntheses, PROMPT_1), 0, 'no "Hello, are you there?" — the caller had just spoken');
    assert.equal(count(h.syntheses, PROMPT_2), 0, "and no second prompt either");
    assert.equal(count(h.syntheses, ACK), 1, "the acknowledgement is still spoken exactly once");
    assert.equal(h.requests.length, 1, "neither the acknowledgement nor the resume reached the model");
    assert.deepEqual(userTurns(h), ["Hi.", "Hello?"], "the presence check is recorded as the turn it was");
    assert.equal(h.endCalls(), 0, "the call was not ended");
  } finally {
    await h.stop();
  }
});

await test('10 — the reported sequence: "Okay" (absorbed) then "Hello?" -> acknowledged, block carries on, no false recovery', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [PITCH] });
  try {
    await blockPlaying(h);
    utter(h, "Okay");
    await sleep(400);
    utter(h, "Hello?");

    await h.waitFor("the acknowledgement", () => count(h.syntheses, ACK) === 1, 15_000);
    const ackAt = h.syntheses.find((s) => s.text === ACK)!.atMs;
    await h.waitFor(
      "the block to carry on",
      () => h.syntheses.some((s) => s.atMs > ackAt && PITCH.includes(s.text) && s.text !== PITCH),
      INTERVAL_MS + 15_000,
    );

    assert.equal(count(h.syntheses, PROMPT_1), 0, 'no "Hello, are you there?" after the caller spoke twice');
    assert.deepEqual(
      userTurns(h),
      ["Hi.", "Hello?"],
      'the "Okay" was absorbed as backchannel; only the "Hello?" is a turn',
    );
    assert.equal(h.requests.length, 1, "no language-model request for either utterance");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// 6-7 — MEANINGFUL SPEECH IS UNCHANGED
//
// The whole safety case for the two sections above: an acknowledgement
// is only ever a WHOLE utterance. One word of content anywhere in it
// and it is a turn, it interrupts, and it reaches the model — in
// English and in Hinglish alike.
// ═════════════════════════════════════════════════════════════════
section("6-7. an acknowledgement with a question attached still takes the floor");

for (const utterance of [
  "Okay, but I have a question about the workshop.",
  "Achha, mujhe workshop ke baare mein ek question hai",
]) {
  await test(`"${utterance.slice(0, 34)}..." while SPEAKING — interrupts the block and is answered by the model`, async () => {
    const h = startHarness({ openingLine: OPENING, replies: [PITCH, REPLY] });
    try {
      await blockPlaying(h);
      utter(h, utterance);

      await h.waitFor("the turn to reach the model", () => h.requests.length === 2, 12_000);
      await h.waitForReplies(3, 15_000);

      assert.equal(bargeIns(h).length, 1, "the block was interrupted");
      assert.deepEqual(userTurns(h), ["Hi.", utterance], "the turn was recorded verbatim");
      assert.notEqual(
        assistantTexts(h.history())[1],
        PITCH,
        "the interrupted block was NOT committed in full",
      );
      assert.equal(assistantTexts(h.history()).at(-1), REPLY, "the model's answer was spoken");
      assert.equal(count(h.syntheses, ACK), 0, "not treated as a presence check");
      assert.equal(count(h.syntheses, PROMPT_1), 0, "no recovery prompt intervened");
    } finally {
      await h.stop();
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// 8-9 — ACTUAL SILENCE STILL RECOVERS, ON EXACTLY TODAY'S SCHEDULE
//
// The failing direction of the fix above would be a caller who really
// has gone quiet never being asked. 8 is the untouched baseline; 9 is
// the one that matters — a backchannel is not a licence to stop
// checking, because the caller can put the phone down right after it.
// ═════════════════════════════════════════════════════════════════
section("8-9. genuine silence is still recovered from, and a backchannel does not suppress it");

await test("8 — no caller speech at all: prompt 1 at 8s, prompt 2 at 8s more, then the call is ended once", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [PITCH] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitForReplies(2, 20_000);
    const drainedAt = lastListeningAt(h);

    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 4_000);
    const p1 = h.syntheses.find((s) => s.text === PROMPT_1)!;
    assert.ok(p1.atMs - drainedAt >= INTERVAL_MS - SLACK_MS, `prompt 1 came ${p1.atMs - drainedAt}ms after the drain`);

    await h.waitFor("prompt 2", () => count(h.syntheses, PROMPT_2) === 1, INTERVAL_MS + 4_000);
    await h.waitFor("the hangup", () => h.endCalls() === 1, INTERVAL_MS + 4_000);

    assert.equal(count(h.syntheses, PROMPT_1), 1, "prompt 1 exactly once");
    assert.equal(count(h.syntheses, PROMPT_2), 1, "prompt 2 exactly once");
    assert.equal(h.requests.length, 1, "recovery makes no language-model request");
  } finally {
    await h.stop();
  }
});

await test('9 — "Okay" over the block, then real silence: the block finishes AND prompt 1 still fires at 8s', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [PITCH] });
  try {
    await blockPlaying(h);
    utter(h, "Okay");
    await h.waitForReplies(2, 20_000);
    const drainedAt = lastListeningAt(h);

    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 4_000);
    const p1 = h.syntheses.find((s) => s.text === PROMPT_1)!;

    assert.deepEqual(bargeIns(h), [], "the backchannel did not interrupt the block");
    assert.equal(assistantTexts(h.history())[1], PITCH, "the block was committed in full");
    assert.ok(
      p1.atMs - drainedAt >= INTERVAL_MS - SLACK_MS,
      `prompt 1 still came a full window after the drain (${p1.atMs - drainedAt}ms)`,
    );
  } finally {
    await h.stop();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  FAILED: ${name}`);
  process.exit(1);
}
process.exit(0);
