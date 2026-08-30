/**
 * silence-recovery-tests.ts — `npm run test:silence-recovery`
 *
 * FIX 2: A CALLER WHO GOES QUIET, OR WHO CAN ONLY SAY "HELLO?".
 *
 * Before this fix a caller who said nothing after a block heard dead
 * air until the campaign watchdog hung up 20s later, and a caller who
 * said only "Hello?" after a FINISHED block was answered by the language
 * model — which, given a completed block and a bare greeting, restarted
 * the script (real transcript, 2026-08-30 08:52 IST: the greeting spoken
 * twice).
 *
 * The fix speaks fixed lines through the existing attention-utterance
 * path and never reaches the model or the script:
 *
 *   silence 3s  -> "Hello, are you there?"      (once)
 *   silence 3s  -> "Hello, is anyone there?"    (once)
 *   silence 3s  -> host.end()                   (the existing hangup path)
 *
 * and answers a post-block "Hello?" with the existing acknowledgement
 * plus one follow-up, then hands the floor back.
 *
 * SECTIONS
 *   A  3s of silence -> the first prompt, exactly once, no LLM request
 *   B  3s more       -> the second prompt, exactly once
 *   C  3s more       -> the call is ended exactly once, nothing else spoken
 *   D  the caller speaks inside the window -> no prompt at all
 *   E  the caller answers the first prompt -> normal conversation, episode reset
 *   F  the caller answers the second prompt -> normal conversation, no hangup
 *   G  the window does not start until the assistant's audio has drained
 *   H  a long block is never truncated by recovery
 *   I  repeated "Hello?" after a finished block -> acknowledgement, follow-up, no script
 *   J  recovery itself makes zero language-model requests (asserted throughout)
 *   K  recovery prompts cannot produce FINAL_YES / a sheet row
 *   L  Fix 1: a backchannel over the block is not a barge-in and not a turn
 *   M  a genuine interruption is unchanged
 *   N  "haan ji" to the closing question still reaches the model and the classifier
 *   O  a remote hangup cancels pending recovery
 *   V  the strict hearing-check vocabulary, both sides
 *
 * TIMING. `SILENCE_RECOVERY_INTERVAL_MS` is 3000 in production and these
 * tests use the real constant, so each silence step is 3s of wall clock.
 * Audio is MULAW/8000 (one byte per sample), so a fake clip's playback
 * duration is exactly `bytes / 8` ms — which is what lets a test say
 * "the prompt came >= 3s after the block finished playing" and mean it.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the
 * conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline, isHearingCheck, isEmphaticHearingCheck, isAttentionCheck } = await import(
  "../../core/session/conversation-pipeline"
);
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { toStoredTranscript } = await import("../outcome/transcript");
const { isFinalYes } = await import("../integrations/final-yes-sheet");

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
const INTERVAL_MS = 3_000;
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
const GATE = "So Sakshi, would you like me to reserve your free seat for the workshop tomorrow at 11 AM?";
const CONFIRMED = "Perfect! I'll get your registration confirmed and send the joining details on WhatsApp.";
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

// ═════════════════════════════════════════════════════════════════
// V — the strict vocabulary boundary (pure functions, no pipeline)
// ═════════════════════════════════════════════════════════════════
section("V. the strict hearing-check vocabulary");

await test("V1 — pure greetings and presence checks ARE hearing checks", () => {
  for (const u of ["Hello?", "Hello. Hello hello", "Hello, can you hear me?", "can you hear me", "hello ji", "Are you there?", "Hello hello hello"]) {
    assert.equal(isHearingCheck(u), true, `expected a hearing check: "${u}"`);
  }
});

await test("V2 — an acknowledgement, a filler, or anything with content is NOT", () => {
  for (const u of ["haan ji", "haanji", "ji", "please", "okay", "yes", "Hello? What is this about?", "hello, price kya hai", "Yes, I'm here."]) {
    assert.equal(isHearingCheck(u), false, `expected NOT a hearing check: "${u}"`);
  }
});

await test("V4 — before any block only an EMPHATIC check qualifies: a presence phrase or a repeated greeting", () => {
  for (const u of ["Hello. Hello hello", "hello hello", "Can you hear me?", "Hello, are you there?", "sun rahe ho"]) {
    assert.equal(isEmphaticHearingCheck(u), true, `expected emphatic: "${u}"`);
  }
  for (const u of ["Hello.", "Hi", "Hello?", "haan ji", "hello ji", "Hello? What is this about?"]) {
    assert.equal(isEmphaticHearingCheck(u), false, `expected NOT emphatic: "${u}"`);
  }
});

await test("V3 — the pre-existing `isAttentionCheck` is byte-for-byte as before (\"haan ji\" still passes it)", () => {
  // Fix #2's remainder path still reads this; it is not this fix's to change.
  assert.equal(isAttentionCheck("haan ji"), true);
  assert.equal(isAttentionCheck("Hello?"), true);
  assert.equal(isAttentionCheck("Hello? What is this about?"), false);
});

// ═════════════════════════════════════════════════════════════════
// A, B, C, G, J — the full silence episode on one call
// ═════════════════════════════════════════════════════════════════
section("A/B/C/G/J. 3s -> prompt 1, 3s -> prompt 2, 3s -> the call ends");

await test("A — after 3s of silence, \"Hello, are you there?\" exactly once, and no language-model request", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [] });
  try {
    await greetingDone(h);
    const listeningAt = lastListeningAt(h);

    // Well inside the window: nothing yet.
    await sleep(INTERVAL_MS - 800);
    assert.deepEqual(texts(h.syntheses), [OPENING], "nothing spoken inside the window");

    await h.waitFor("first recovery prompt", () => count(h.syntheses, PROMPT_1) === 1, 3000);
    const prompt = h.syntheses.find((s) => s.text === PROMPT_1)!;
    // G — the window is measured from the moment audio drained.
    assert.ok(
      prompt.atMs - listeningAt >= INTERVAL_MS - SLACK_MS,
      `prompt came ${prompt.atMs - listeningAt}ms after LISTENING; expected >= ${INTERVAL_MS - SLACK_MS}`,
    );
    assert.equal(h.requests.length, 0, "J — recovery made no language-model request");
    // The prompt is a committed assistant turn (the model must see it later).
    await h.waitForReplies(2);
    assert.deepEqual(assistantTexts(h.history()), [OPENING, PROMPT_1]);
  } finally {
    await h.stop();
  }
});

await test("B/C — 3s more -> \"Hello, is anyone there?\" once; 3s more -> host.end() exactly once, nothing else spoken", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [] });
  try {
    await greetingDone(h);
    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    await h.waitForReplies(2);
    const listeningAfterPrompt1 = lastListeningAt(h);

    await h.waitFor("prompt 2", () => count(h.syntheses, PROMPT_2) === 1, INTERVAL_MS + 1500);
    const prompt2 = h.syntheses.find((s) => s.text === PROMPT_2)!;
    assert.ok(
      prompt2.atMs - listeningAfterPrompt1 >= INTERVAL_MS - SLACK_MS,
      `prompt 2 came ${prompt2.atMs - listeningAfterPrompt1}ms after prompt 1 drained`,
    );
    assert.equal(count(h.syntheses, PROMPT_1), 1, "prompt 1 was not repeated");
    await h.waitForReplies(3);
    const listeningAfterPrompt2 = lastListeningAt(h);

    assert.equal(h.endCalls(), 0, "not ended yet");
    await h.waitFor("host.end()", () => h.endCalls() === 1, INTERVAL_MS + 1500);
    const endedAt = Date.now();
    assert.ok(
      endedAt - listeningAfterPrompt2 >= INTERVAL_MS - SLACK_MS,
      `ended ${endedAt - listeningAfterPrompt2}ms after prompt 2 drained`,
    );
    // Nothing more: no third prompt, no script, no model, no second end.
    await sleep(600);
    assert.equal(h.endCalls(), 1, "ended exactly once");
    assert.deepEqual(texts(h.syntheses), [OPENING, PROMPT_1, PROMPT_2], "exactly the two prompts were spoken");
    assert.equal(h.requests.length, 0, "J — zero language-model requests across the whole episode");
    assert.equal(h.record.loopAbortController?.signal.aborted, true, "the loop was aborted by end()");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// D — the caller speaks inside the window
// ═════════════════════════════════════════════════════════════════
section("D. the caller speaks inside the first window");

await test("D — a turn 1.5s into the window -> answered normally, no recovery prompt", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    await sleep(1500);
    h.say("Hi, yes, tell me.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "one language-model request, for the caller's turn");
    assert.equal(count(h.syntheses, PROMPT_1), 0, "no recovery prompt");
    // And the window re-armed cleanly after the block: quiet again ->
    // prompt 1 comes ~3s after THAT block drained, not earlier.
    const blockListeningAt = lastListeningAt(h);
    await h.waitFor("prompt after the block", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    const prompt = h.syntheses.find((s) => s.text === PROMPT_1)!;
    assert.ok(prompt.atMs - blockListeningAt >= INTERVAL_MS - SLACK_MS, `prompt came ${prompt.atMs - blockListeningAt}ms after the block drained`);
  } finally {
    await h.stop();
  }
});

await test("D2 — an interim (not yet a turn) inside the window holds the prompt back", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [REPLY] });
  try {
    await greetingDone(h);
    await sleep(2200);
    // The caller has started a sentence; Deepgram has shown words but
    // not finalised. That is not silence.
    h.say("Actually I wanted to", { isFinal: false });
    await sleep(1500); // past the original deadline
    assert.equal(count(h.syntheses, PROMPT_1), 0, "no prompt while words are pending");
    h.say("Actually I wanted to ask something.", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2);
    assert.equal(count(h.syntheses, PROMPT_1), 0);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// E, F — the caller comes back after a prompt
// ═════════════════════════════════════════════════════════════════
section("E/F. the caller answers a recovery prompt");

await test("E — \"Yes, I'm here.\" after prompt 1 -> the model answers with the prompt in history; the script is not restarted; the episode resets", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [REPLY] });
  try {
    await greetingDone(h);
    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    await h.waitForReplies(2);
    h.say("Yes, I'm here.");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 1, "one request, for the caller's answer");
    const sent = h.requests[0]!.filter((t) => t.role !== "system");
    assert.deepEqual(
      sent.slice(0, 2).map((t) => `${t.role}:${t.content}`),
      [`assistant:${OPENING}`, `assistant:${PROMPT_1}`],
      "the model sees the prompt as an assistant turn",
    );
    assert.equal(sent.length, 3);
    assert.equal(sent[2]!.role, "user");
    assert.ok(sent[2]!.content.includes("Yes, I'm here."), `the caller's words were sent: ${sent[2]!.content}`);
    assert.deepEqual(assistantTexts(h.history()), [OPENING, PROMPT_1, REPLY]);
    assert.equal(count(h.syntheses, OPENING), 1, "the opening was never spoken again");
    assert.equal(count(h.syntheses, PROMPT_2), 0, "the second prompt never came");
    assert.equal(h.endCalls(), 0);
    // The episode counter reset with the turn: silence now begins a NEW
    // episode with prompt 1, not prompt 2.
    await h.waitFor("a fresh episode's prompt 1", () => count(h.syntheses, PROMPT_1) === 2, INTERVAL_MS + 1500);
    assert.equal(count(h.syntheses, PROMPT_2), 0);
  } finally {
    await h.stop();
  }
});

await test("F — \"Yes.\" after prompt 2 -> normal conversation, no hangup", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [REPLY] });
  try {
    await greetingDone(h);
    await h.waitFor("prompt 2", () => count(h.syntheses, PROMPT_2) === 1, 2 * INTERVAL_MS + 3000);
    await h.waitForReplies(3);
    h.say("Yes.");
    await h.waitForReplies(4);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(assistantTexts(h.history()), [OPENING, PROMPT_1, PROMPT_2, REPLY]);
    await sleep(INTERVAL_MS - 1000); // less than a full window after REPLY
    assert.equal(h.endCalls(), 0, "the call was not ended");
    assert.equal(count(h.syntheses, OPENING), 1, "the opening was never spoken again");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// G, H — recovery waits for the audio and never cuts it
// ═════════════════════════════════════════════════════════════════
section("G/H. the window starts only after the audio has drained; nothing is truncated");

await test("H — a ~13s block: committed IN FULL, never cancelled, and the prompt comes >= 3s after it drained", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    const blockMs = playbackMsOf(BLOCK);
    assert.ok(blockMs > 10_000, `the block should be long (${blockMs}ms of audio)`);
    // Wait through most of the block: the window must not fire mid-block.
    await h.waitFor("block synthesized", () => h.syntheses.some((s) => BLOCK.startsWith(s.text.slice(0, 20))), 5000);
    await sleep(Math.min(blockMs - 1500, 9000));
    assert.equal(count(h.syntheses, PROMPT_1), 0, "no prompt while the block is playing");
    assert.equal(h.record.state, SessionState.SPEAKING, "still SPEAKING — nothing drained early");

    await h.waitForReplies(2, blockMs + 5000);
    const blockListeningAt = lastListeningAt(h);
    assert.equal(h.history().filter((t) => t.role === "assistant").at(-1)?.content, BLOCK, "the WHOLE block is the committed turn");
    // The full block's audio really played before LISTENING.
    const speaking = [...h.transitions].reverse().find((t) => t.to === "SPEAKING")!;
    assert.ok(blockListeningAt - speaking.atMs >= blockMs - SLACK_MS, `SPEAKING lasted ${blockListeningAt - speaking.atMs}ms for ${blockMs}ms of audio`);

    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    const prompt = h.syntheses.find((s) => s.text === PROMPT_1)!;
    assert.ok(prompt.atMs - blockListeningAt >= INTERVAL_MS - SLACK_MS, `prompt came ${prompt.atMs - blockListeningAt}ms after the block drained`);
    // No transition ever left SPEAKING for a barge-in reason.
    assert.equal(
      h.transitions.filter((t) => t.from === "SPEAKING" && t.to === "LISTENING" && /barge/i.test(t.reason ?? "")).length,
      0,
      "no barge-in transition",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// I — repeated "Hello?" after a finished block
// ═════════════════════════════════════════════════════════════════
section("I. repeated \"Hello?\" after a finished block");

await test("I — \"Hello?\" -> the acknowledgement; \"Hello?\" -> one follow-up; then a real answer reaches the model; the block is never re-spoken", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitForReplies(2, 20_000);
    assert.equal(h.requests.length, 1);

    h.say("Hello?");
    await h.waitForReplies(3);
    assert.equal(count(h.syntheses, ACK), 1, "acknowledged once");
    assert.equal(h.requests.length, 1, "no language-model request for the hello");

    h.say("Hello? Hello?");
    await h.waitForReplies(4);
    assert.equal(count(h.syntheses, FOLLOW_UP), 1, "one follow-up");
    assert.equal(count(h.syntheses, ACK), 1, "still one acknowledgement");
    assert.equal(h.requests.length, 1, "still no language-model request");

    h.say("Yes, I heard you. Tell me more.");
    await h.waitForReplies(5);
    assert.equal(h.requests.length, 2, "the real answer went to the model");
    assert.deepEqual(assistantTexts(h.history()), [OPENING, BLOCK, ACK, FOLLOW_UP, REPLY]);
    assert.equal(h.syntheses.filter((s) => s.text === BLOCK || s.text.startsWith(BLOCK.slice(0, 40))).length, 1, "the block was spoken exactly once");
  } finally {
    await h.stop();
  }
});

await test("I3 — before any block, \"Hello. Hello hello\" -> acknowledged (the greeting is NOT re-spoken); \"yes\" -> the pitch from the model", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    h.say("Hello. Hello hello");
    await h.waitForReplies(2);
    assert.equal(count(h.syntheses, ACK), 1, "acknowledged");
    assert.equal(h.requests.length, 0, "not sent to the model");
    assert.equal(count(h.syntheses, OPENING), 1, "the opening was not spoken again");
    h.say("yes");
    await h.waitForReplies(3, 20_000);
    assert.equal(h.requests.length, 1, "the confirmation went to the model, which continues the pitch");
    assert.equal(count(h.syntheses, FOLLOW_UP), 0, "no 'did you catch what I was saying' when nothing had been said");
    assert.deepEqual(assistantTexts(h.history()), [OPENING, ACK, BLOCK]);
  } finally {
    await h.stop();
  }
});

await test("I4 — before any block, a single \"Hello.\" is the caller answering the phone and goes to the model, as before", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    h.say("Hello.");
    await h.waitForReplies(2, 20_000);
    assert.equal(h.requests.length, 1);
    assert.equal(count(h.syntheses, ACK), 0);
  } finally {
    await h.stop();
  }
});

await test("I2 — \"Hello? What is this about?\" is a real question and goes to the model, as before", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitForReplies(2, 20_000);
    h.say("Hello? What is this about?");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2);
    assert.equal(count(h.syntheses, ACK), 0);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// K — recovery prompts never become a campaign answer or a sheet row
// ═════════════════════════════════════════════════════════════════
section("K. a recovery prompt is not a campaign answer");

function classify(turns: readonly ConversationTurn[]) {
  const stored = toStoredTranscript(turns);
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: stored.turns,
  });
  const { disposition } = dispositionFor({ outcomeType: classification.outcomeType, failureClass: "COMPLETED" });
  return { classification, disposition };
}
const turn = (role: "assistant" | "user", content: string): ConversationTurn => ({ role, content, timestamp: new Date() });

await test("K1 — gate question, silence, both prompts, no answer -> not FINAL_YES, no sheet row", () => {
  const { classification, disposition } = classify([
    turn("assistant", OPENING),
    turn("user", "Hi."),
    turn("assistant", GATE),
    turn("assistant", PROMPT_1),
    turn("assistant", PROMPT_2),
  ]);
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false, "the sheet mirror would write nothing");
});

await test("K2 — \"Yes\" to \"Hello, are you there?\" answers THAT question, not the gate -> not FINAL_YES", () => {
  const { classification, disposition } = classify([
    turn("assistant", OPENING),
    turn("user", "Hi."),
    turn("assistant", GATE),
    turn("assistant", PROMPT_1),
    turn("user", "Yes."),
    turn("assistant", REPLY),
  ]);
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false);
});

// ═════════════════════════════════════════════════════════════════
// L, M — Fix 1 and genuine barge-in, unchanged
// ═════════════════════════════════════════════════════════════════
section("L/M. backchannel (Fix 1) and genuine interruption, unchanged");

await test("L — \"haan ji\" over the block is a backchannel: no barge-in, no turn, block committed in full, and the window still starts at drain", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitFor("block playing", () => h.record.state === SessionState.SPEAKING && h.syntheses.length > 1, 5000);
    await sleep(1500);
    h.say("haan ji", { isFinal: false });
    await sleep(300);
    h.say("haan ji", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2, 20_000);
    assert.equal(h.history().filter((t) => t.role === "assistant").at(-1)?.content, BLOCK, "the block was committed in full");
    assert.equal(h.history().filter((t) => t.role === "user" && /haan/i.test(t.content)).length, 0, "the backchannel became no turn");
    assert.equal(h.requests.length, 1, "no request for the backchannel");
    const blockListeningAt = lastListeningAt(h);
    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    const prompt = h.syntheses.find((s) => s.text === PROMPT_1)!;
    assert.ok(prompt.atMs - blockListeningAt >= INTERVAL_MS - SLACK_MS, `prompt came ${prompt.atMs - blockListeningAt}ms after drain`);
  } finally {
    await h.stop();
  }
});

await test("M — \"Wait, what is this about?\" over the block interrupts it and is answered by the model; no recovery prompt intervenes", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitFor("block playing", () => h.record.state === SessionState.SPEAKING && h.syntheses.length > 1, 5000);
    await sleep(1500);
    h.say("Wait, what is this about?");
    await h.waitFor("interrupting turn answered", () => h.requests.length === 2, 8000);
    await h.waitForReplies(3, 15_000);
    assert.equal(count(h.syntheses, PROMPT_1), 0, "no recovery prompt during the interruption");
    const committed = assistantTexts(h.history());
    assert.notEqual(committed[1], BLOCK, "the interrupted block was NOT committed in full");
    assert.equal(committed.at(-1), REPLY);
    assert.equal(h.history().some((t) => t.role === "user" && t.content === "Wait, what is this about?"), true);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// N — "haan ji" at the gate
// ═════════════════════════════════════════════════════════════════
section("N. \"haan ji\" to the closing question");

await test("N — \"haan ji\" after the gate reaches the model (no acknowledgement) and the classifier reads it as FINAL_YES", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [GATE, CONFIRMED] });
  try {
    await greetingDone(h);
    h.say("Hi.");
    await h.waitForReplies(2, 20_000);
    h.say("haan ji");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "the answer went to the model");
    assert.equal(count(h.syntheses, ACK), 0, "not treated as a hearing check");
    const { classification, disposition } = classify(h.history());
    assert.equal(disposition, "FINAL_YES");
    assert.equal(classification.primaryReason, "confirmed_at_gate");
    assert.equal(isFinalYes(classification, disposition), true);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
// O — remote hangup
// ═════════════════════════════════════════════════════════════════
section("O. a remote hangup cancels pending recovery");

await test("O — the loop aborted 1.5s into the window -> no prompt, no end() from the pipeline, loop exits", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [] });
  try {
    await greetingDone(h);
    await sleep(1500);
    h.abortLikeRemoteHangup();
    await sleep(INTERVAL_MS + 1000);
    assert.equal(count(h.syntheses, PROMPT_1), 0, "no recovery prompt after the hangup");
    assert.equal(h.endCalls(), 0, "the pipeline did not call end() itself");
    assert.equal(h.requests.length, 0);
  } finally {
    await h.stop();
  }
});

await test("O2 — aborted while prompt 1 is being spoken -> no prompt 2, no end() from the pipeline", async () => {
  const h = startHarness({ openingLine: OPENING, replies: [] });
  try {
    await greetingDone(h);
    await h.waitFor("prompt 1", () => count(h.syntheses, PROMPT_1) === 1, INTERVAL_MS + 1500);
    h.abortLikeRemoteHangup();
    await sleep(INTERVAL_MS + 1500);
    assert.equal(count(h.syntheses, PROMPT_2), 0);
    assert.equal(h.endCalls(), 0);
  } finally {
    await h.stop();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
