/**
 * hearing-check-loop-tests.ts — `npm run test:hearing-loop`
 *
 * PHASE 1.2: THE HEARING CHECK THAT NEVER ENDS.
 *
 * `handleAttentionCheck` answers a presence check with one of two FIXED
 * lines — the acknowledgement ("Hey, can you hear me okay?") and the
 * follow-up ("I just want to make sure you can hear me...") — and
 * neither says anything new: no script content, no language-model
 * request, nothing that advances the call. Nothing counted them, and
 * both lines are themselves QUESTIONS, so the caller's answer to one is
 * another presence check, which is answered with another fixed line.
 *
 * THE DEFECT, MEASURED THROUGH THE REAL PIPELINE BEFORE THE FIX.
 *
 *   before any block, caller "Hello? Hello?" x 4
 *     -> 4 acknowledgements, identical, one per utterance, forever
 *
 *   after a block, caller "Hello?" x 4
 *     -> acknowledgement, follow-up, acknowledgement, follow-up, forever
 *
 * Sustainable from BOTH sides. The fixed lines share their vocabulary
 * with `ATTENTION_PRESENCE_PHRASES`, so a FRAGMENT of our own line
 * coming back up the caller's inbound track ("Can you hear?", three
 * words — below `SELF_ECHO_MIN_WORDS`, so the self-echo guard may not
 * judge it at all) is a presence check too, and the agent answers its
 * own echo with no caller involved.
 *
 * THE FIX IS A CAP ON THE AGENT'S OWN CONTENTLESS LINES — not on the
 * caller's utterances, and NOT on the self-echo guard, which is
 * untouched. Two fixed hearing lines with nothing in between is the
 * most any existing path produces; the third and every one after it
 * takes the normal contextual path instead. The counter is reset by any
 * turn that is NOT answered with a fixed line — a real contribution, a
 * hearing confirmation, a resume or a repeat — so a genuine hearing
 * check later in the same call is answered exactly as it is today.
 *
 * SECTIONS
 *   A  the loop is bounded — before a block, and after one
 *   B  reset and recovery after a meaningful user turn
 *   C  self-echo: what the guard suppresses, and what the cap bounds
 *   D  every valid hearing-check behaviour, unchanged (the negative half)
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

/**
 * The two fixed lines, restated here so a change to either one fails a
 * test rather than silently making the cap uncountable.
 */
const ACK = "Hey, can you hear me okay?";
const FOLLOW_UP = "I just want to make sure you can hear me. Did you catch what I was saying?";
/**
 * EVERY language variant of those two lines. The cap counts the agent's
 * fixed hearing lines, and which language one is spoken in is decided
 * separately, by `detectLanguage` over the caller's own words — so a
 * caller whose utterance switches the call language ("haan ji") must
 * not be able to buy a fresh budget of acknowledgements by doing it.
 * Counting only the English forms would miss exactly that.
 */
const ALL_HEARING_LINES = [
  ACK,
  "हाँ, क्या आपको मेरी आवाज़ ठीक से सुनाई दे रही है?",
  "Haan, aap mujhe theek se sun paa rahe ho?",
  FOLLOW_UP,
  "बस कन्फ़र्म करना था कि आप मुझे सुन पा रहे हैं। जो मैंने अभी कहा, वो आपने सुना?",
  "Bas confirm karna tha ki aap mujhe sun paa rahe hain. Jo maine abhi kaha, woh aapne suna?",
];
/**
 * `MAX_HEARING_LINES_WITHOUT_PROGRESS`, restated for the same reason.
 * It is the production cap, not a test parameter: raising it in the
 * pipeline without raising it here is meant to fail.
 */
const MAX_LINES = 2;

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — the shape `attention-check-tests.ts` and
// `silence-recovery-tests.ts` use, plus a user-turn accessor (section
// C asserts that an echo produces NO turn, which is not observable
// from the reply count alone).
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

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /** Committed conversation, system turn excluded — what the model is shown. */
  history(): readonly ConversationTurn[];
  userTurns(): string[];
  replyCount(): number;
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
      // greeting plays and abandons the stream at its first event. Not
      // a conversational request, so it consumes no scripted reply.
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
    "hearing-loop-test" as SessionId,
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
    userTurns() {
      return record.memory
        .history()
        .filter((turn) => turn.role === "user")
        .map((turn) => turn.content);
    },
    replyCount() {
      return record.memory.history().filter((turn) => turn.role === "assistant").length;
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
/**
 * Deliberately ONE short sentence. The chunker splits a long reply into
 * several synthesis requests, and every assertion below counts how many
 * times a given text was spoken — a single sentence makes that count
 * exact instead of a prefix match.
 */
const BLOCK = "The workshop is tomorrow at eleven.";
const REPLY_2 = "It runs for about ninety minutes.";
const REPLY_3 = "There is no charge for it.";
const REPLY_4 = "I can reserve a seat for you.";
/**
 * Long enough that the caller can cut in a sentence into it, which is
 * what leaves an unheard remainder for the RESUME branch to speak.
 * The approved script's own shape, and the same text `test:attention`
 * uses for the same reason.
 */
const LONG_BLOCK =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

/** How many times a fixed line was handed to the TTS provider. */
const spokenCount = (h: Harness, text: string): number => h.synthesized.filter((t) => t === text).length;
/** Every fixed hearing line spoken, of either kind, in any language. */
const hearingLinesSpoken = (h: Harness): number =>
  h.synthesized.filter((t) => ALL_HEARING_LINES.includes(t)).length;

const assistantTexts = (h: Harness): string[] =>
  h
    .history()
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content.trim());

/** Greeting spoken in full, session LISTENING, nothing asked of the model yet. */
async function greetingDone(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  assert.deepEqual(h.synthesized, [OPENING], "only the greeting has been spoken");
  assert.equal(h.requests.length, 0, "no conversational request has been made");
}

/** The agent is a sentence into `LONG_BLOCK` and the caller cuts in. */
async function upToMidBlock(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  h.say("Yes, tell me.");
  await h.waitFor("the agent to start the block", () => h.record.state === SessionState.SPEAKING);
  await sleep(900);
}

/** Greeting, then one real answer, so a block has been delivered. */
async function blockDelivered(h: Harness): Promise<void> {
  await greetingDone(h);
  h.say("Hi, tell me.");
  await h.waitForReplies(2);
  assert.equal(h.requests.length, 1, "the real answer went to the model");
  assert.equal(spokenCount(h, BLOCK), 1, "the block was spoken once");
}

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the loop is bounded");
// ═════════════════════════════════════════════════════════════════

await test('A1 — before any block, "Hello? Hello?" four times produces at most TWO fixed lines', async () => {
  // THE DEFECT, from the side the caller drives. Before the fix every
  // one of the four utterances took the `hearingEpisodeBeforeBlock`
  // branch and got its own identical acknowledgement, with no exit.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await greetingDone(h);

    h.say("Hello? Hello?");
    await h.waitForReplies(2);
    h.say("Hello? Hello?");
    await h.waitForReplies(3);
    h.say("Hello? Hello?");
    await h.waitForReplies(4);
    h.say("Hello? Hello?");
    await h.waitForReplies(5);

    assert.equal(
      hearingLinesSpoken(h),
      MAX_LINES,
      `at most ${MAX_LINES} fixed hearing lines, spoken=${JSON.stringify(h.synthesized)}`,
    );
    // THE POINT: once the cap is reached the turn is answered by the
    // contextual path instead of a third canned line.
    assert.equal(h.requests.length, 2, "the third and fourth checks reached the language model");
    // And the fixed path never re-speaks the script it is protecting.
    assert.equal(spokenCount(h, OPENING), 1, "the opening line was spoken exactly once");
  } finally {
    await h.stop();
  }
});

await test('A2 — after a block, "Hello?" four times produces ONE acknowledgement and ONE follow-up, then stops', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4] });
  try {
    await blockDelivered(h);

    h.say("Hello?");
    await h.waitForReplies(3);
    h.say("Hello?");
    await h.waitForReplies(4);
    h.say("Hello?");
    await h.waitForReplies(5);
    h.say("Hello?");
    await h.waitForReplies(6);

    assert.equal(spokenCount(h, ACK), 1, `one acknowledgement, spoken=${JSON.stringify(h.synthesized)}`);
    assert.equal(spokenCount(h, FOLLOW_UP), 1, "one follow-up");
    assert.equal(h.requests.length, 3, "the third and fourth checks reached the language model");
    assert.equal(spokenCount(h, BLOCK), 1, "the block was never re-spoken");
    assert.equal(spokenCount(h, OPENING), 1, "the opening line was never re-spoken");
  } finally {
    await h.stop();
  }
});

await test('A3 — "Can you hear me?" repeated is bounded the same way as "Hello?"', async () => {
  // The presence-phrase half of the vocabulary, not just the greeting
  // half: both reach the same branches, so both must be capped.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await blockDelivered(h);

    h.say("Can you hear me?");
    await h.waitForReplies(3);
    h.say("Are you there?");
    await h.waitForReplies(4);
    h.say("Can you hear me?");
    await h.waitForReplies(5);

    assert.equal(hearingLinesSpoken(h), MAX_LINES, `spoken=${JSON.stringify(h.synthesized)}`);
    assert.equal(h.requests.length, 2, "the third check reached the language model");
  } finally {
    await h.stop();
  }
});

await test('A4 — an utterance that is BOTH a check and a confirmation ("haan ji") cannot re-open the loop', async () => {
  // ADVERSARIAL. "haan ji" is in `BARE_GREETING_ONLY`, so `isCheck` is
  // true for it, AND in `HEARING_CONFIRMATION_ONLY`, so `confirmsHearing`
  // is true for it inside an open episode. A cap that reset on "the
  // caller confirmed" would therefore reset on an utterance the handler
  // then answers with ANOTHER acknowledgement — the same loop, one
  // token longer. The counter is reset by the BRANCH TAKEN, never by a
  // predicate over the text, and this pins that.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2] });
  try {
    await greetingDone(h);

    h.say("Hello? Hello?");
    await h.waitForReplies(2);
    assert.equal(hearingLinesSpoken(h), 1);

    // Answered with the one word that is both. Still a check to this
    // branch, so it draws the second acknowledgement — and, because
    // "haan ji" also switches the call language, that one is the HINDI
    // form of the same line. It is the same line and it is counted.
    h.say("haan ji");
    await h.waitForReplies(3);
    assert.equal(hearingLinesSpoken(h), MAX_LINES, "it is answered as a repeated check");

    // ...and the cap must now hold.
    h.say("Hello? Hello?");
    await h.waitForReplies(4);
    assert.equal(
      hearingLinesSpoken(h),
      MAX_LINES,
      `the cap holds, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(h.requests.length, 1, "the capped check reached the language model");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — reset and recovery after a meaningful user turn");
// ═════════════════════════════════════════════════════════════════

await test("B1 — a real contribution resets the cap: a later hearing check is acknowledged again", async () => {
  // The cap must not be a per-call budget. A caller whose line drops
  // twice in one call is entitled to be asked twice — what it bounds is
  // fixed lines spoken with NOTHING in between.
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4],
  });
  try {
    await blockDelivered(h);

    // Doubled, so it qualifies on its own turn: the caller's previous
    // turn here is "Hi, tell me." (the one that drew the block), which
    // is not a bare greeting, so a single "Hello?" would now take the
    // contextual path. The cap, which is what this test is about, is
    // reached exactly as before once the pair has been spoken.
    h.say("Hello? Hello?");
    await h.waitForReplies(3);
    h.say("Hello?");
    await h.waitForReplies(4);
    assert.equal(hearingLinesSpoken(h), MAX_LINES, "the cap is now reached");

    // A MEANINGFUL USER TURN — the thing the counter is waiting for.
    h.say("Yes, I heard you. What is the workshop about?");
    await h.waitForReplies(5);
    assert.equal(h.requests.length, 2, "the real answer went to the model");

    // And now the line drops again.
    h.say("Hello? Hello?");
    await h.waitForReplies(6);
    assert.equal(
      spokenCount(h, ACK),
      2,
      `the acknowledgement is available again after a real turn, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(h.requests.length, 2, "and it did NOT reach the language model");
  } finally {
    await h.stop();
  }
});

await test("B2 — a hearing confirmation counts as progress: the cap is not consumed by it", async () => {
  // "Yes, I can hear you." is the answer the acknowledgement asks for.
  // Before any block it hands the floor back to the contextual path
  // (the pitch), and that is progress — so the next hearing check is
  // answered normally rather than declined.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await greetingDone(h);

    h.say("Hello? Hello?");
    await h.waitForReplies(2);
    assert.equal(spokenCount(h, ACK), 1);

    h.say("Yes, I can hear you.");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 1, "the confirmation went to the model, which pitches");

    // Doubled: the previous turn was the confirmation, not a greeting,
    // so this has to qualify on its own to reach the cap at all — which
    // is the point of the test.
    h.say("Hello? Hello?");
    await h.waitForReplies(4);
    assert.equal(spokenCount(h, ACK), 2, "acknowledged again — the confirmation reset the counter");
  } finally {
    await h.stop();
  }
});

await test("B3 — a RESUME is progress and does not consume the cap", async () => {
  // The resume speaks the interrupted reply itself — script content the
  // caller asked for — so it is not a contentless line and must not be
  // counted. `test:attention` section C owns the resume itself; the
  // assertion here is only that the cap stays out of its way.
  //
  // Without the reset at the RESUME branch this sequence stops one line
  // early and sends the fourth utterance to the model instead.
  const h = startHarness({ openingLine: OPENING, replies: [LONG_BLOCK, REPLY_2, REPLY_3] });
  try {
    await upToMidBlock(h);

    // Doubled: a single greeting over a held reply is now resumed
    // without the question (test:attention section L).
    h.say("Hello? Hello?");
    await h.waitFor("the acknowledgement", () => spokenCount(h, ACK) === 1);
    await h.waitForReplies(3);

    // Resumes the unheard tail — script content, not a fixed line.
    h.say("Yes.");
    await h.waitForReplies(4);

    h.say("Hello?");
    await h.waitForReplies(5);
    assert.equal(spokenCount(h, FOLLOW_UP), 1, "the follow-up hands the floor back");

    h.say("Hello?");
    await h.waitForReplies(6);
    assert.equal(
      spokenCount(h, ACK),
      2,
      `a third fixed line is still available, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(h.requests.length, 1, "and none of it reached the language model");
  } finally {
    await h.stop();
  }
});

await test("B4 — a REPEAT the caller hears none of spends a line, so repeated zero-progress repeats end at the existing cap", async () => {
  // C1 (read-only audit, 2026-09-22). The REPEAT branch neither counted
  // against the cap nor consulted it, so a caller who cut every replay
  // with another bare "No." was offered the whole block again per "No.",
  // without bound — measured through this harness before the fix: four
  // cut repeats, a fifth started, one model request. RESUME already
  // counts a zero-delivery resume; this pins the same accounting on
  // REPEAT, and only that:
  //
  //   - the FIRST repeat is still spoken (existing intended behaviour);
  //   - a repeat the caller hears none of spends one of the existing
  //     `MAX_HEARING_LINES_WITHOUT_PROGRESS` lines;
  //   - once they are spent, the next restart request takes the
  //     contextual path — the existing `declineExhaustedHearingCheck`
  //     fallback — and the block is not replayed again;
  //   - nothing reaches the model before the cap is met.
  //
  // Waits on state and on what was SYNTHESIZED, never on the committed
  // reply count: a cut inside the block's first sentence commits nothing
  // (delivered audio rounds down), which is exactly the "heard none of
  // it" case this test is about.
  const h = startHarness({ openingLine: OPENING, replies: [LONG_BLOCK, REPLY_2, REPLY_3] });
  try {
    await upToMidBlock(h);

    h.say("Hello? Hello?");
    await h.waitFor(
      "the acknowledgement to drain",
      () => spokenCount(h, ACK) === 1 && h.record.state === SessionState.LISTENING,
    );
    assert.equal(hearingLinesSpoken(h), 1, "one fixed line so far");

    // "No." to "can you hear me okay?" means "I could not": the cut-off
    // reply is REPEATED from its first word. The first one is spoken.
    h.say("No.");
    await h.waitFor(
      "the first repeat to start",
      () => spokenCount(h, LONG_BLOCK) === 1 && h.record.state === SessionState.SPEAKING,
    );
    assert.equal(h.requests.length, 1, "the repeat is not a model request");

    // Cut inside its first sentence, so none of it counts as heard.
    await sleep(700);
    h.say("No.");
    await h.waitFor("the repeat to be cut", () => h.record.state !== SessionState.SPEAKING);

    // That "No." is itself a restart request. Before the fix it drew a
    // second full repeat, and every one after it another. The
    // zero-delivery repeat has now spent the second line, so the cap is
    // met and this one takes the contextual path.
    await h.waitFor("the contextual fallback", () => h.requests.length === 2, 5000);
    assert.equal(
      spokenCount(h, LONG_BLOCK),
      1,
      `the block was repeated exactly once, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(hearingLinesSpoken(h), 1, "no further fixed hearing line was spoken");
    await h.waitFor("the fallback reply to drain", () => h.record.state === SessionState.LISTENING);

    // The episode is closed by the decline, so another "No." is an
    // ordinary turn — still no replay.
    h.say("No.");
    await h.waitFor("a further contextual turn", () => h.requests.length === 3, 5000);
    assert.equal(spokenCount(h, LONG_BLOCK), 1, "the block is still not replayed");
  } finally {
    await h.stop();
  }
});

await test('B5 — a REPEAT delivered IN FULL releases the reply, so a second bare "No." is an answer and not another replay', async () => {
  // THE C1 DEFECT, in the shape the zero-delivery cap cannot reach. The
  // caller lets the repeat play to its last word — so it is progress,
  // the counter resets, and the cap will never bite — and then answers
  // the question the block ended on with "No." Nothing cleared the
  // cut-off reply from the record, so that answer re-read as a restart
  // request and played the whole block again, once per "No.", for as
  // long as the caller kept saying it.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await upToMidBlock(h);
    h.say("Hello? Hello?");
    await h.waitFor(
      "the acknowledgement",
      () => spokenCount(h, ACK) === 1 && h.record.state === SessionState.LISTENING,
    );
    const requestsBefore = h.requests.length;

    // THE LEGITIMATE REPEAT, which must still work exactly as it does.
    h.say("No.");
    await h.waitFor("the block to be repeated", () => spokenCount(h, BLOCK) === 2);
    await h.waitFor("the repeat to drain", () => h.record.state === SessionState.LISTENING, 25_000);
    assert.equal(h.requests.length, requestsBefore, "the repeat costs no language-model request");

    // It reached its last word, so nothing is owed and no cut-off reply
    // is on record. This "No." is the answer to the question the block
    // ended on and belongs to the model.
    h.say("No.");
    await h.waitFor("the contextual path", () => h.requests.length === requestsBefore + 1, 25_000);
    assert.equal(
      spokenCount(h, BLOCK),
      2,
      `the block is never played a third time, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(hearingLinesSpoken(h), 1, "and no further fixed hearing line was spoken");
  } finally {
    await h.stop();
  }
});

await test("B6 — an episode with NOTHING to replay still answers its confirmation with the one follow-up", async () => {
  // THE BEHAVIOUR B5 AND B7 MUST NOT TAKE AWAY, and the reason the
  // episode is closed on a completed REPLAY rather than on what the
  // caller said. Here the block finished on its own, so the episode
  // speaks nothing but fixed lines: the acknowledgement, then the
  // follow-up that hands the floor back. `test:language-lock` E1/E2
  // pin the same exchange in the locked language, and A2/A4/D4 above
  // pin its bound.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await blockDelivered(h);
    const requestsBefore = h.requests.length;

    h.say("Hello? Hello?");
    await h.waitFor("the acknowledgement", () => spokenCount(h, ACK) === 1);
    await h.waitFor("it to drain", () => h.record.state === SessionState.LISTENING);

    h.say("Yes.");
    await h.waitFor("the follow-up", () => spokenCount(h, FOLLOW_UP) === 1, 25_000);
    assert.equal(h.requests.length, requestsBefore, "and neither line costs a language-model request");
    assert.equal(spokenCount(h, BLOCK), 1, "the block is not re-spoken by either of them");
  } finally {
    await h.stop();
  }
});

await test('B7 — ...but a bare "Yes." after that resume is an ANSWER, not one more hearing confirmation', async () => {
  // THE H1 DEFECT. The resumed block ends on the script\'s own question,
  // so the "Yes." that follows it is the answer to THAT — the one the
  // outcome classifier reads at the anchor. With the episode still
  // open it was consumed as a hearing confirmation instead and drew
  // "Did you catch what I was saying?", leaving the person\'s yes
  // unanswered by anything the script owns.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3] });
  try {
    await upToMidBlock(h);
    h.say("Hello? Hello?");
    await h.waitFor(
      "the acknowledgement",
      () => spokenCount(h, ACK) === 1 && h.record.state === SessionState.LISTENING,
    );
    const requestsBefore = h.requests.length;

    h.say("Yes.");
    await h.waitFor("the tail to be resumed", () => spokenCount(h, BLOCK) === 2);
    await h.waitFor("the resume to drain", () => h.record.state === SessionState.LISTENING, 25_000);
    assert.equal(h.requests.length, requestsBefore, "premise: the resume itself reached no model");

    h.say("Yes.");
    await h.waitFor("the contextual path", () => h.requests.length === requestsBefore + 1, 25_000);
    assert.equal(spokenCount(h, FOLLOW_UP), 0, `no follow-up, spoken=${JSON.stringify(h.synthesized)}`);
    assert.equal(spokenCount(h, BLOCK), 2, "and the block is not spoken again");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
await test("B8 — a NON-QUALIFYING check cannot hand the cap back: an alternating pattern still ends", async () => {
  // AUDIT M8. The counter's contract is stated at
  // `MAX_HEARING_LINES_WITHOUT_PROGRESS`: it is reset "by any turn that
  // is not answered with a fixed line — i.e. by the caller contributing
  // something meaningful". A turn that IS a presence check but merely
  // failed to QUALIFY for an acknowledgement — a single bare "Hello."
  // after a turn that was not a greeting — used to reset it anyway, and
  // that handed the whole budget back for nothing. Alternating a
  // qualifying check with a non-qualifying one then meant the cap was
  // never reached and the fixed lines could be drawn for the whole call.
  //
  // Asserted on the INVARIANT rather than on a fixed script of turns:
  // which particular utterance qualifies depends on what the previous
  // turn was (see `previousTurnWasBareGreeting`), and the cap has to
  // hold however the caller alternates. Nothing here changes the cap,
  // its value, or any increment — only that a non-qualifying check no
  // longer grants progress it did not make.
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4],
  });
  try {
    await blockDelivered(h);

    // Alternate the two shapes: a bare greeting (which qualifies only
    // when the PREVIOUS turn was one too) and a presence phrase (which
    // never leaves `lastTurnWasBareGreeting` set). Every second turn is
    // therefore non-qualifying, which is exactly the turn that used to
    // zero the counter.
    for (const said of ["Hello.", "Can you hear me?", "Hello.", "Can you hear me?", "Hello.", "Can you hear me?"]) {
      h.say(said);
      await sleep(2500);
    }

    assert.ok(
      hearingLinesSpoken(h) <= MAX_LINES,
      `at most ${MAX_LINES} fixed hearing lines however the caller alternates, ` +
        `got ${hearingLinesSpoken(h)}, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(spokenCount(h, BLOCK), 1, "and the block was never re-spoken");
    assert.equal(spokenCount(h, OPENING), 1, "nor was the opening line");
  } finally {
    await h.stop();
  }
});

await test("B9 — ...and a REAL contribution still hands the budget back", async () => {
  // The other side of B8, and the half that keeps the cap from becoming
  // a one-way trip. A turn with actual content resets the counter
  // exactly as it always did — that reset is the one at the top of
  // `handleAttentionCheck` and is untouched — so a caller who genuinely
  // cannot hear later in the call is acknowledged again rather than
  // being handed to the model for the rest of the call.
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4],
  });
  try {
    await blockDelivered(h);

    // Spend the budget.
    for (const said of ["Hello.", "Hello.", "Hello.", "Hello."]) {
      h.say(said);
      await sleep(2500);
    }
    const spent = hearingLinesSpoken(h);
    assert.equal(spent, MAX_LINES, `the budget is spent, spoken=${JSON.stringify(h.synthesized)}`);

    // A real question — meaningful, so the budget is genuinely handed
    // back and the next genuine check is acknowledged again.
    h.say("What time does it start?");
    await sleep(2500);
    for (const said of ["Hello.", "Hello."]) {
      h.say(said);
      await sleep(2500);
    }

    assert.ok(
      hearingLinesSpoken(h) > spent,
      `a real contribution resets the cap, spoken=${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — self-echo: what the guard suppresses, what the cap bounds");
// ═════════════════════════════════════════════════════════════════

await test("C1 — our own acknowledgement, echoed back whole, is still suppressed and never becomes a turn", async () => {
  // THE GUARD IS UNTOUCHED BY THIS FIX, and this asserts it for the one
  // line the fix is about: the acknowledgement is 6 words, so it clears
  // `SELF_ECHO_MIN_WORDS`, and every one of its word pairs is in the
  // audio the caller just heard.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "MUST-NOT-BE-SAID"] });
  try {
    await blockDelivered(h);
    // Doubled so it qualifies: the echo this test is about is of the
    // acknowledgement, so the acknowledgement has to be spoken first.
    h.say("Hello? Hello?");
    await h.waitForReplies(3);
    assert.equal(spokenCount(h, ACK), 1);

    const userTurnsBefore = h.userTurns().length;
    const repliesBefore = h.replyCount();
    // Our own audio, back up the caller's inbound track.
    h.say(ACK);
    await sleep(700);

    assert.equal(
      h.userTurns().length,
      userTurnsBefore,
      `the echo must not become a caller turn, got ${JSON.stringify(h.userTurns())}`,
    );
    assert.equal(h.replyCount(), repliesBefore, "and must not be answered");
    assert.equal(spokenCount(h, FOLLOW_UP), 0, "in particular, it must not draw the follow-up");
  } finally {
    await h.stop();
  }
});

await test("C2 — an echo FRAGMENT the guard cannot judge cannot sustain a loop either", async () => {
  // "Can you hear?" is three words — under `SELF_ECHO_MIN_WORDS`, which
  // is deliberately a floor no short utterance may fall below, so the
  // echo guard is not allowed to touch it however well it matches. It
  // is also an `ATTENTION_PRESENCE_PHRASES` entry, so it reaches the
  // hearing branches exactly like a caller's own check. That is the
  // agent answering its own echo, and the cap is what ends it: this
  // asserts the number of fixed lines, which is what the cap bounds,
  // NOT that the fragment was suppressed (it is not, by design).
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4] });
  try {
    await blockDelivered(h);

    h.say("Can you hear?");
    await h.waitForReplies(3);
    h.say("Can you hear?");
    await h.waitForReplies(4);
    h.say("Can you hear?");
    await h.waitForReplies(5);
    h.say("Can you hear?");
    await h.waitForReplies(6);

    assert.equal(
      hearingLinesSpoken(h),
      MAX_LINES,
      `an echo-driven check is capped like any other, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(spokenCount(h, BLOCK), 1, "and no script content is re-spoken by the fixed path");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — every valid hearing-check behaviour, unchanged");
// ═════════════════════════════════════════════════════════════════

await test('D1 — a single casual "Hello." before any block is still the caller answering the phone', async () => {
  // The roadmap's "avoid turning a single casual hello into a hearing
  // check". Unchanged by this fix — `isEmphaticHearingCheck` already
  // decides it — and asserted here so the cap cannot be mistaken for
  // the thing that handles it.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK] });
  try {
    await greetingDone(h);
    h.say("Hello.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "it goes to the model, which pitches");
    assert.equal(hearingLinesSpoken(h), 0, "and draws no fixed hearing line at all");
  } finally {
    await h.stop();
  }
});

await test('D2 — a REPEATED "Hello?" after a block still gets exactly one acknowledgement, with no model request', async () => {
  // ── WHAT CHANGED, AND WHAT DID NOT ───────────────────────────────
  //
  // This test used to say "a single Hello? after a block". That rule is
  // gone: one greeting out of a clear sky is a person saying hello, and
  // being answered with "Hey, can you hear me okay?" on the spot is the
  // robotic reading. The qualifying test is now an UNMISTAKABLE check
  // (a presence phrase, or the greeting doubled in one utterance) or a
  // bare greeting whose PREVIOUS turn was a bare greeting too.
  //
  // Everything this test exists to pin is unchanged and still asserted:
  // once it does qualify, the acknowledgement is spoken exactly ONCE,
  // makes no language-model request, and adds no script text.
  // `test:silence-recovery` I5 asserts the other side — that the single
  // greeting takes the contextual path instead.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, "MUST-NOT-BE-SAID"] });
  try {
    await blockDelivered(h);
    const requestsBefore = h.requests.length;

    h.say("Hello? Hello?");
    await h.waitForReplies(3);

    assert.equal(spokenCount(h, ACK), 1, "acknowledged once");
    assert.equal(h.requests.length, requestsBefore, "and never reached the language model");
    assert.deepEqual(assistantTexts(h), [OPENING, BLOCK, ACK]);
  } finally {
    await h.stop();
  }
});

await test('D3 — "Hello? What is this about?" is a real question and still takes the contextual path', async () => {
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2] });
  try {
    await blockDelivered(h);
    h.say("Hello? What is this about?");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "answered by the model");
    assert.equal(hearingLinesSpoken(h), 0, "no fixed hearing line");
  } finally {
    await h.stop();
  }
});

await test("D4 — the acknowledgement + follow-up pair still runs in full before the cap bites", async () => {
  // The exact sequence `test:silence-recovery` section I asserts. The
  // cap is set to the length of this sequence on purpose: it must
  // change nothing about it.
  const h = startHarness({ openingLine: OPENING, replies: [BLOCK, REPLY_2] });
  try {
    await blockDelivered(h);

    // Doubled so the pair starts; the second one reaches the follow-up
    // through the open episode, exactly as it always has.
    h.say("Hello? Hello?");
    await h.waitForReplies(3);
    h.say("Hello? Hello?");
    await h.waitForReplies(4);

    assert.deepEqual(assistantTexts(h), [OPENING, BLOCK, ACK, FOLLOW_UP]);
    assert.equal(h.requests.length, 1, "neither line reached the language model");

    h.say("Yes, I heard you. Tell me more.");
    await h.waitForReplies(5);
    assert.equal(h.requests.length, 2, "and the real answer goes to the model as before");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
