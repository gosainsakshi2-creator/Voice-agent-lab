/**
 * identity-gate-tests.ts — `npm run test:identity`
 *
 * WHO PICKED UP, AND WHY THE PITCH MUST WAIT FOR THE ANSWER.
 *
 * A real call: the agent asked "Am I speaking with Sakshi?", the caller
 * talked over it, a hearing check followed and succeeded, and the agent
 * went into the pitch — having confirmed only that it could be heard.
 *
 * Identity was not a thing the system knew. It was a sentence the
 * prompt asked the model to say, with nothing recording whether it was
 * ever answered, so nothing could refuse to go on. These tests assert
 * the gate that now does, and they assert it the only way that means
 * anything: by counting LANGUAGE-MODEL REQUESTS. While the gate is
 * shut the model is never asked for a reply, so there is no pitch to
 * speak — "no pitch before identity is confirmed" is a statement about
 * which code runs, not about which instruction a model chose to follow.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET OR CONTACTS A VENDOR.
 * Every provider is a local fake; the pipeline, the turn detector, the
 * identity classifier and the conversation memory are the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { definitiveAnswerIn } = await import("../dispatch/call-runner");
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
// Fakes stand in for the four vendors and nothing else. Audio is
// MULAW/8000, where one byte is one sample, so a clip's real-time
// duration is exactly `bytes / 8` ms — which is what lets a test say
// "interrupt 600ms into the reply" and mean it.
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

/**
 * A scripted call.
 *
 * `replies` is what the fake language model returns, in order — one
 * entry per request it receives. `replyDelayMs` is how long it waits
 * before its first token, which is the window a test uses to make the
 * caller say something newer while the agent is still thinking.
 */
interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  /** Every history the language model was handed, in request order. */
  readonly requests: Array<readonly ConversationTurn[]>;
  /** Every text handed to the text-to-speech provider, in order. */
  readonly synthesized: string[];
  /** Feed one transcript segment, exactly as the streaming STT would. */
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  /** Wait until `predicate` holds, or fail after `timeoutMs`. */
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Wait until `n` assistant turns are committed AND the agent is listening again. */
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  /** How many assistant turns are committed so far. */
  replyCount(): number;
  /** Committed conversation, system turn excluded — what the model is shown. */
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
  /** The pipeline-owned identity line; omit for a call with no gate. */
  readonly identityLine?: string;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  /** Monotonic stream clock for segment timestamps, in ms. */
  let clockMs = 0;
  let replyIndex = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      // greeting plays and abandons the stream at its first event. It is
      // not a conversational request, so it is not recorded and consumes
      // no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
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

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    // Batch-only, like Cartesia and Smallest AI — the production shape.
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
    "continuity-test" as SessionId,
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
        ...(input.identityLine !== undefined ? { identityLine: input.identityLine } : {}),
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );

  record.loopAbortController = new AbortController();
  // The real pipeline is handed a session that has just been answered:
  // it speaks the greeting and only then enters LISTENING. Starting in
  // LISTENING would let a test's first utterance land during the
  // greeting, which is a different scenario entirely.
  record.state = SessionState.CALLING;
  // An outbound path must exist or `waitForOutboundReady` burns 500ms
  // before the first clip. No backpressure: the fake transport is
  // instant, and `drainPlayback` is what paces the reply.
  record.outboundAudioListeners.add(() => undefined);

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
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
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({
        text,
        isFinal,
        ...(opts?.isSpeechFinal !== undefined ? { isSpeechFinal: opts.isSpeechFinal } : { isSpeechFinal: isFinal }),
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      });
      const waiter = waiters.shift();
      waiter?.();
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

/** The last user turn of a captured request, minus the internal per-turn note. */
function lastUserContent(history: readonly ConversationTurn[]): string {
  const userTurns = history.filter((turn) => turn.role === "user");
  return userTurns[userTurns.length - 1]?.content ?? "";
}

function assistantTexts(history: readonly ConversationTurn[]): string[] {
  return history.filter((turn) => turn.role === "assistant").map((turn) => turn.content);
}

// The approved script's own shape: an opening the caller has already
// heard, then a block long enough that a caller can interrupt the
// middle of it. Sized so one block is ~5s of audio.
const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
/**
 * PHASE 2 — pause before a caller "carries on" while an earlier reply
 * is still generating, used by tests A/B/E/F/I below.
 *
 * Those tests race a follow-up fragment against a stale reply's
 * arrival: the fragment must be FED (even unfinished, see
 * `newerUserTurnWaiting`) before `replyDelayMs` elapses on the earlier
 * turn, or the stale reply is spoken before there is anything to
 * supersede it with. It was `1500`, tuned to Phase 1's turn-release
 * latency (300-600ms for the short turn-1 utterances these tests use).
 * Phase 2 collapsed that to a single evidenced window
 * (150-250ms — see `EVIDENCED_CONFIRMATION_SHORT_MS` in
 * turn-detection.ts), so a turn-1 reply is now ready ~150-350ms
 * SOONER and `1500` no longer reliably lands before it — it isn't a
 * race the pipeline is meant to lose, it is a wall-clock constant that
 * assumed the old latency. Shortened with headroom under the fastest
 * remaining case (an evidenced-short turn-1: ~150ms release +
 * `replyDelayMs` 1200ms = ~1350ms).
 */
const CARRY_ON_PAUSE_MS = 900;
const BLOCK_B =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

// ═════════════════════════════════════════════════════════════════
const { classifyIdentityAnswer } = await import("../domain/identity-answer");
const { buildCampaignContext } = await import("../domain/campaign-context");
const { defaultScriptFor, hashScript } = await import("../script/script-registry");

const OPEN = "Hello, this is Ishita from Team FlexiFunnels.";
const ID_LINE = "Am I speaking with Sakshi?";
const PITCH =
  "I'm calling to invite you to a free live workshop this Sunday at 11 AM. " +
  "Have you tried putting something online before?";

/**
 * Drive a call through the gate and report what the pipeline did.
 *
 * `llmRequests` is the assertion that matters: every reply the campaign
 * could possibly speak comes from the language model, so zero requests
 * is proof that no pitch was spoken — stronger than checking the words,
 * which would only prove THIS fake's words were not spoken.
 */
async function run(
  turns: readonly string[],
  opts: {
    readonly identityLine?: string;
    readonly pauseMs?: number;
    /**
     * IDENTITY-FIRST (`registration v8`): the opening line IS the
     * identity question, so the gate starts `outstanding` rather than
     * `unasked` and the caller's first utterance is the ANSWER.
     * Omitted, this is the v1-v7 opening and every existing case below
     * runs exactly as it did.
     */
    readonly openingLine?: string;
    /**
     * Skip the leading pickup "Hello.". An identity-first call has no
     * pickup turn to skip past — the first thing the caller says is
     * their answer, and the pipeline must not eat it.
     */
    readonly skipPickup?: boolean;
    /**
     * Wait until the opening line has finished playing and the agent is
     * LISTENING before the first turn is said. Omitted, the first turn
     * lands WHILE the opening is still being spoken — the pickup window.
     */
    readonly afterOpening?: boolean;
  } = {},
): Promise<{
  spoken: string[];
  llmRequests: number;
  lastUserSentToLlm: string | undefined;
  /** The identity gate's own verdict at the end of the call — see section F. */
  identityDenied: boolean;
}> {
  // `identityLine: ""` means "this call has no gate"; omitted means the
  // ordinary campaign gate.
  const line = opts.identityLine === undefined ? ID_LINE : opts.identityLine;
  const h = startHarness({
    openingLine: opts.openingLine ?? OPEN,
    ...(line.length > 0 ? { identityLine: line } : {}),
    replies: [PITCH, PITCH, PITCH, PITCH],
    replyDelayMs: 0,
  });
  try {
    // The caller's first "Hello." answers the phone and the pipeline
    // drops it as the pickup acknowledgement — the opening line is
    // already the answer to it. That is existing behaviour and not
    // this gate's business, so every case here starts after it.
    if (opts.skipPickup !== true) {
      h.say("Hello.", { isFinal: true, isSpeechFinal: true });
      await sleep(3000);
    }
    if (opts.afterOpening === true) {
      await h.waitFor(
        "the opening line to finish",
        () => h.replyCount() >= 1 && h.record.state === SessionState.LISTENING,
      );
      // Past the drain, so nothing said from here was heard over the opening.
      await sleep(200);
    }
    for (const text of turns) {
      h.say(text, { isFinal: true, isSpeechFinal: true });
      await sleep(opts.pauseMs ?? 4000);
    }
    const last = h.requests[h.requests.length - 1];
    const lastUser = last ? [...last].reverse().find((t) => t.role === "user") : undefined;
    return {
      spoken: [...h.synthesized],
      llmRequests: h.requests.length,
      lastUserSentToLlm: lastUser?.content.split("\n").pop(),
      identityDenied: h.pipeline.identityDenied(),
    };
  } finally {
    await h.stop();
  }
}

/** Did the agent speak the pitch? */
const pitched = (spoken: readonly string[]) => spoken.some((t) => t.includes("free live workshop"));
/** How many times did it ask who picked up? */
const idAsks = (spoken: readonly string[]) =>
  spoken.filter((t) => t.includes("Am I speaking with Sakshi")).length;

// ═════════════════════════════════════════════════════════════════
section("A. THE CLASSIFIER — HEARING AND IDENTITY ARE DIFFERENT ANSWERS");

await test("A1. an identity answer is confirmed", () => {
  for (const said of [
    "Yes, this is Sakshi.",
    "Haan ji.",
    "Ji.",
    "Speaking.",
    "Haan, Sakshi bol rahi hoon.",
    "जी हाँ.",
    "Sakshi.",
    "Haan ji, bol rahi hoon.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "confirmed", `"${said}"`);
  }
});

await test("A2. a denial is denied", () => {
  for (const said of [
    "Nahi, main Sakshi nahi hoon.",
    "No, wrong number.",
    "गलत नंबर.",
    "She is not here.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "denied", `"${said}"`);
  }
});

await test("A3. a HEARING answer is never an identity answer", () => {
  // The defect, in one assertion. Every one of these is an
  // affirmation, and not one of them says who is on the line.
  for (const said of [
    "Yes, I can hear you.",
    "Yes I can hear you now.",
    "Haan, sunai de raha hai.",
    "आवाज़ आ रही है.",
    "Loud and clear.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "unclear", `"${said}"`);
  }
});

await test("A4. a greeting, a question back, or noise is unclear", () => {
  for (const said of ["Hello?", "Hello, hello?", "Can you hear me?", "Kaun bol raha hai?", "Hmm.", ""]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "unclear", `"${said}"`);
  }
});

await test("A6. the natural English confirmations are confirmed (§4.5 F3)", () => {
  // `normaliseText` reduces every non-letter to a space, so "That's
  // me." arrives as " that s me " and the table's "thats me" matched
  // nothing a caller ever says — the commonest English answer to "Am I
  // speaking with Sakshi?" read as `unclear`, cost a re-ask, and three
  // of those end the call on the right person.
  //
  // "this is she" / "this is he" are the nominative forms of "this is
  // her" / "this is him", which were already here.
  for (const said of [
    "That's me.",
    "Yes, that's me.",
    "That's me, yes.",
    "This is she.",
    "This is he.",
    // Already worked, via "right" in CONFIRMATIONS. Pinned so a future
    // edit to that table cannot quietly take it away.
    "That's right.",
    // The spellings that already worked, asserted alongside so the two
    // forms can never diverge again.
    "Thats me.",
    "That is me.",
    "This is her.",
    "This is him.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "confirmed", `"${said}"`);
  }
});

await test("A6b. ...and the denial they contain still wins", () => {
  // `DENIALS` is checked BEFORE the self-identification table, so a
  // sentence that contains "that s me" and a negation is still a
  // denial. That ordering is the existing design; adding a spelling
  // must not invert it.
  for (const said of ["That's not me.", "No, that's not me."]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "denied", `"${said}"`);
  }
  // PRE-EXISTING GAP, recorded rather than fixed: `DENIALS` carries
  // "not me", "she is not" and "he is not", but not "not her" / "not
  // him", so "That's not her." reads `unclear` and costs a re-ask. It
  // read `unclear` before §4.5 F3 too — none of the three spellings
  // that batch added occurs in it — so this is a note for a later
  // vocabulary batch, not a regression. Pinned so the day someone fixes
  // it, they see this line.
  assert.equal(classifyIdentityAnswer("That's not her.", "Sakshi"), "unclear");
});

await test("A6c. a hearing answer wrapped around one of them is still not an identity answer", () => {
  // "That's right, I can hear you." answers the HEARING question. The
  // hearing exclusion runs before the bare confirmations and must keep
  // doing so, or the identity gate reopens the defect this file exists
  // for.
  assert.equal(classifyIdentityAnswer("That's right, I can hear you.", "Sakshi"), "unclear");
});

await test("A6d. the ambiguous \"No, I'm busy.\" is deliberately UNCHANGED", () => {
  // Out of scope by decision (§4.5 audit): a bare "No" to "Am I
  // speaking with Sakshi?" is a genuine denial far more often than it
  // is a brush-off, and nothing in one turn separates them. Pinned so
  // the current behaviour is a recorded decision rather than an
  // accident, and so a later batch that changes it has to do so
  // deliberately.
  assert.equal(classifyIdentityAnswer("No, I'm busy.", "Sakshi"), "denied");
});

await test('A7. a positive construction that CONTAINS "no" is not a denial', () => {
  // `DENIALS` is whole-word containment and a denial wins outright, so
  // "Yes, no problem." — an unmistakable yes — settled `denied`, and
  // the right person was told we had the wrong number. The device is
  // the one `classifier.ts` has carried for the same words since a "no
  // problem" could end a call that was going well.
  for (const said of [
    "Yes, no problem.",
    "Yes no problem bol rahi hoon.",
    "Haan, koi problem nahi.",
    "No worries, speaking.",
  ]) {
    assert.notEqual(classifyIdentityAnswer(said, "Sakshi"), "denied", `"${said}" must not be a denial`);
  }
});

await test("A7b. ...and every genuine denial still denies", () => {
  // The other side of A7, on the exact forms the table exists for. Not
  // one of them contains an exception phrase, so not one of them moves.
  for (const said of [
    "No.",
    "Nahi.",
    "Wrong number.",
    "No, this isn't Sakshi.",
    "She is not here.",
    "गलत नंबर.",
    // Pinned by A6d as a deliberate decision; it must stay one.
    "No, I'm busy.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "denied", `"${said}"`);
  }
});

await test('A8. "Right, who\'s this?" is a question back, not a confirmation', () => {
  // `normaliseText` turns "who's" into "who s", which matched neither
  // spelling in `QUESTIONS_BACK` — so the turn fell through to
  // `CONFIRMATIONS`, where "right" is an entry, and a caller asking who
  // was calling CONFIRMED their own identity.
  for (const said of ["Right, who's this?", "Who's this?", "Sorry, who's this?"]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "unclear", `"${said}"`);
  }
  // The spellings that already worked, asserted alongside so the three
  // forms cannot diverge again.
  assert.equal(classifyIdentityAnswer("Who is this?", "Sakshi"), "unclear");
  assert.equal(classifyIdentityAnswer("Whos this?", "Sakshi"), "unclear");
  // ...and a bare "Right." is still the confirmation A6 pins.
  assert.equal(classifyIdentityAnswer("That's right.", "Sakshi"), "confirmed");
});

await test("A5. one turn that answers BOTH questions confirms identity", () => {
  // "Yes, I can hear you, this is Sakshi" carries a hearing answer and
  // an identity answer. Reading only the first would re-ask a question
  // they just answered — which real callers do say in one breath, and
  // which the turn detector merges into one turn anyway.
  for (const said of [
    "Yes, I can hear you, this is Sakshi.",
    "Haan sunai de raha hai, Sakshi bol rahi hoon.",
  ]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "confirmed", `"${said}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. THE GATE — NO PITCH BEFORE IDENTITY IS CONFIRMED");

await test("B1. the first turn is answered with the identity question, not the model", async () => {
  const r = await run(["Hello"]);
  assert.equal(r.llmRequests, 0, "the language model must not be reached before identity");
  assert.equal(idAsks(r.spoken), 1, "the identity question is asked once");
  assert.equal(pitched(r.spoken), false);
});

await test("B2. 'Hello' to the identity question leaves it unresolved", async () => {
  const r = await run(["Hello", "Hello?"]);
  assert.equal(r.llmRequests, 0, "still no language-model request");
  assert.equal(pitched(r.spoken), false, "and no pitch");
});

await test("B3. 'Yes, I can hear you' leaves it unresolved, and re-asks", async () => {
  const r = await run(["Hello", "Yes, I can hear you"]);
  assert.equal(r.llmRequests, 0, "hearing confirmation must not reach the model");
  assert.equal(pitched(r.spoken), false, "hearing confirmation must not unlock the pitch");
  assert.ok(idAsks(r.spoken) >= 2, "the unanswered question is put again");
});

await test("B4. 'Haan ji' confirms, and only then does the model run", async () => {
  const r = await run(["Hello", "Haan ji"]);
  assert.equal(r.llmRequests, 1, "exactly one request, after confirmation");
  assert.equal(r.lastUserSentToLlm, "Haan ji");
  assert.equal(pitched(r.spoken), true);
});

await test("B5. 'Yes, this is Sakshi' confirms", async () => {
  const r = await run(["Hello", "Yes, this is Sakshi"]);
  assert.equal(r.llmRequests, 1);
  assert.equal(pitched(r.spoken), true);
});

await test("B6. a DENIAL never reaches the pitch", async () => {
  const r = await run(["Hello", "Nahi, main Sakshi nahi hoon"]);
  // The turn goes to the model — the wrong-person close is script
  // content — but the gate stays shut for the rest of the call, so
  // nothing can reopen it.
  assert.equal(r.lastUserSentToLlm, "Nahi, main Sakshi nahi hoon");
});

await test("B7. THE REPORTED CALL — hearing recovery does not open the gate", async () => {
  //   opening -> "Hello." -> identity question -> "Hello" over it
  //   -> hearing line -> "Yes, I can hear you" -> identity AGAIN
  //   -> "Yes, this is Sakshi" -> only now, the pitch.
  const r = await run(["Hello", "Hello", "Yes, I can hear you", "Yes, this is Sakshi"]);
  assert.equal(r.llmRequests, 1, "exactly one request in the whole call");
  assert.equal(
    r.lastUserSentToLlm,
    "Yes, this is Sakshi",
    "and it carried the identity confirmation, not the hearing one",
  );
  assert.ok(idAsks(r.spoken) >= 2, "the agent returned to the unanswered question");
  assert.equal(pitched(r.spoken), true, "and the pitch came only after it was answered");
  // The pitch is the LAST thing spoken — never before the confirmation.
  const pitchAt = r.spoken.findIndex((t) => t.includes("free live workshop"));
  const lastAskAt = r.spoken.map((t) => t.includes("Am I speaking with Sakshi")).lastIndexOf(true);
  assert.ok(pitchAt > lastAskAt, "the pitch must come after the last identity question");
});

await test('B7b. a BARE "Yes" to the hearing line is a hearing answer too — it must not open the gate', async () => {
  // B7 above pins the explicit form ("Yes, I can hear you"), which
  // `identity-answer.ts` can see for itself. This is the form it
  // cannot: four letters that answer "can you hear me okay?" and "am I
  // speaking with Sakshi?" identically, told apart only by which
  // question was actually asked — which the pipeline knows and the
  // classifier does not.
  const r = await run(["Hello", "Hello", "Yes", "Yes, this is Sakshi"]);
  assert.equal(r.llmRequests, 1, "exactly one request in the whole call");
  assert.equal(
    r.lastUserSentToLlm,
    "Yes, this is Sakshi",
    "and it carried the identity confirmation, not the hearing one",
  );
  assert.ok(idAsks(r.spoken) >= 2, "the unanswered identity question was put again");
  const pitchAt = r.spoken.findIndex((t) => t.includes("free live workshop"));
  const lastAskAt = r.spoken.map((t) => t.includes("Am I speaking with Sakshi")).lastIndexOf(true);
  assert.ok(pitchAt > lastAskAt, "the pitch must come after the last identity question");
});

await test('B7c. the same bare "Yes" OUTSIDE a hearing episode still confirms', async () => {
  // The narrowness of B7b, from the other side: nothing about bare
  // affirmations changed. A "Yes" to the identity question, asked and
  // answered with no hearing line in between, confirms exactly as it
  // always has.
  const r = await run(["Hello", "Yes"]);
  assert.equal(r.llmRequests, 1, "the confirmation reached the model");
  assert.equal(r.lastUserSentToLlm, "Yes");
  assert.equal(pitched(r.spoken), true, "and the pitch followed it");
});

await test("B8. repeated interruption does not lose the identity state", async () => {
  const r = await run(["Hello", "Hello", "Hello?", "Hello", "Hello?"]);
  assert.equal(r.llmRequests, 0, "no amount of 'hello' opens the gate");
  assert.equal(pitched(r.spoken), false);
});

await test("B9. the gate gives up rather than pitching at an unknown caller", async () => {
  // Three asks with no answer. The call ends; it does not proceed.
  const r = await run(["Hello", "Kya chahiye?", "Kaun bol raha hai?", "Hmm."]);
  assert.equal(r.llmRequests, 0, "never reached the model");
  assert.equal(pitched(r.spoken), false, "and never pitched");
});

await test("B10. a call with NO identity line is unchanged", async () => {
  // Every non-campaign session, and any script that does not require a
  // name: the gate starts open and the first turn goes to the model
  // exactly as it always did.
  const r = await run(["Hello"], { identityLine: "" });
  assert.equal(r.llmRequests, 1, "no gate, no change");
});

// ═════════════════════════════════════════════════════════════════
section("C. THE LINE ITSELF");

await test("C1. the campaign supplies it, interpolated, for name-requiring scripts", () => {
  const script = defaultScriptFor("registration");
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script,
    provider: "smallest-ai",
    customerName: "Sakshi",
    expectedScriptHash: hashScript(script),
  });
  assert.equal(context.identityLine, "Am I speaking with Sakshi?");
  assert.ok(!context.identityLine.includes("{{"), "no placeholder may survive");
});

await test("C2. it is a question about them and commits them to nothing", async () => {
  const { classifyOutcome } = await import("../outcome/classifier");
  const { dispositionFor } = await import("../outcome/disposition");
  for (const said of ["Haan.", "Haan ji.", "Yes.", "Yes, this is Sakshi."]) {
    const outcome = classifyOutcome({
      campaignType: "registration",
      status: "COMPLETED",
      failureClass: "COMPLETED",
      answered: true,
      transcript: [
        { role: "assistant", text: OPEN },
        { role: "assistant", text: "Am I speaking with Sakshi?" },
        { role: "user", text: said },
      ] as never,
    });
    const disposition = dispositionFor({
      outcomeType: outcome.outcomeType,
      failureClass: "COMPLETED",
    }).disposition;
    assert.notEqual(disposition, "FINAL_YES", `"${said}" to the identity line must not register`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. IDENTITY FIRST — the opening ASKS, the introduction waits");
// ═════════════════════════════════════════════════════════════════
//
// `registration v8`: the opening line is the identity question, and the
// agent introduces itself in its FIRST REPLY, which only happens after
// the gate is `confirmed`.
//
//     AGENT:  "Hello, am I speaking with Sakshi?"
//     CALLER: "Yes."
//     AGENT:  "I'm Rohan from Team FlexiFunnels. I'm calling to invite…"
//
// The gate, the classifier, the re-ask, the three-strike give-up and the
// denied path are the SAME ones section B exercises — the only
// difference is that the question has already been spoken when the first
// caller turn arrives. `llmRequests` remains the assertion that matters:
// the introduction and everything after it come from the model, so zero
// requests is proof that nothing was introduced or pitched.

/** v8's opening: the identity question, with nothing else in it. */
const ID_FIRST_OPEN = "Hello, am I speaking with Sakshi?";

const idFirst = (
  turns: readonly string[],
  extra: { readonly pauseMs?: number } = {},
): ReturnType<typeof run> =>
  run(turns, { openingLine: ID_FIRST_OPEN, skipPickup: true, ...extra });

// `idAsks` matches "Am I speaking with Sakshi" case-sensitively, so on
// these identity-first calls it counts the times the GATE put the
// question — the lowercase "am" in the opening line is deliberately not
// one of them. Zero is therefore the success case here: the opening
// asked, and the gate never had to ask again.

await test("D1. English: the opening asks, 'Yes.' confirms, and ONLY then does the model run", async () => {
  const r = await idFirst(["Yes."]);
  assert.equal(r.spoken[0], ID_FIRST_OPEN, "the call opens with the question");
  assert.equal(r.llmRequests, 1, "exactly one request, after confirmation");
  assert.equal(r.lastUserSentToLlm, "Yes.", "and it carried the identity confirmation");
  assert.equal(pitched(r.spoken), true, "the introduction and purpose follow");
  assert.equal(idAsks(r.spoken), 0, "the gate never re-asks — the opening already asked");
});

await test("D2. Hinglish: 'Haan ji.' confirms the same way, through the same classifier", async () => {
  const r = await idFirst(["Haan ji."]);
  assert.equal(r.llmRequests, 1);
  assert.equal(pitched(r.spoken), true);
  assert.equal(idAsks(r.spoken), 0, "not re-asked");
});

await test("D3. the caller's bare 'Haan.' is an ANSWER, not a pickup acknowledgement", async () => {
  // The regression this flow creates if `pickupAckAllowance` is left
  // alone: "Haan." / "Okay." matches `isBareAcknowledgement`, so the
  // first turn of an identity-first call would be DROPPED and the
  // caller re-asked a question they had just answered.
  const r = await idFirst(["Haan."]);
  assert.equal(r.llmRequests, 1, "the answer reached the gate and opened it");
  assert.equal(idAsks(r.spoken), 0, "it was NOT swallowed and re-asked");
});

await test("D4. the introduction does not exist until identity is confirmed", async () => {
  // Nothing said at all after the opening.
  const r = await idFirst([]);
  assert.equal(r.llmRequests, 0, "no language-model request, so no introduction and no pitch");
  assert.deepEqual(r.spoken, [ID_FIRST_OPEN], "the opening line is the ONLY thing spoken");
});

await test("D5. NO SCRIPT DUMP: the opening is the question and carries no event facts", async () => {
  const r = await idFirst([]);
  const opening = r.spoken[0] ?? "";
  assert.equal(opening, ID_FIRST_OPEN);
  for (const leak of ["workshop", "invite", "Zoom", "free", "event", "September", "FlexiFunnels"]) {
    assert.equal(
      opening.toLowerCase().includes(leak.toLowerCase()),
      false,
      `the opening must not carry "${leak}" — it asks one question and stops`,
    );
  }
});

await test("D6. 'No.' is denied: the gate shuts and never re-opens", async () => {
  const r = await idFirst(["No.", "Yes, this is Sakshi"]);
  // As B6: the denial itself goes to the model, because the
  // wrong-person close is script content. What must not happen is the
  // gate re-opening on the later confirmation.
  assert.equal(idAsks(r.spoken), 0, "a denied gate does not ask again");
});

await test("D7. 'No, this isn't Sakshi.' is denied", async () => {
  const r = await idFirst(["No, this isn't Sakshi."]);
  assert.equal(r.lastUserSentToLlm, "No, this isn't Sakshi.", "the denial reaches the wrong-person close");
  assert.equal(idAsks(r.spoken), 0, "a denied gate does not ask again");
});

await test("D8. 'Wrong number.' is denied", async () => {
  const r = await idFirst(["Wrong number."]);
  assert.equal(r.lastUserSentToLlm, "Wrong number.");
  assert.equal(idAsks(r.spoken), 0, "a denied gate does not ask again");
});

await test("D9. 'Who is this?' is UNCLEAR: no introduction, and the question is put again", async () => {
  const r = await idFirst(["Who is this?"]);
  assert.equal(r.llmRequests, 0, "an unclear answer must not unlock the introduction");
  assert.equal(pitched(r.spoken), false);
  assert.ok(idAsks(r.spoken) >= 1, "the gate puts the unanswered question again");
});

await test("D10. a 'Hello' heard WHILE the opening plays is the pickup, not an answer: no re-ask, and 'Yes.' then confirms", async () => {
  // Real calls: 24 of the 60 most recent opened with the caller's bare
  // "Hello" and every one drew "Sorry — Am I speaking with…?". The
  // opening line is the answer to a pickup greeting on every script;
  // on an identity-first script the greeting is simply not the answer
  // to the question, so it is dropped rather than read as `unclear`.
  const r = await idFirst(["Hello", "Yes."]);
  assert.equal(r.llmRequests, 1, "one request, and only after the real answer");
  assert.equal(r.lastUserSentToLlm, "Yes.");
  assert.equal(idAsks(r.spoken), 0, "the pickup greeting must NOT re-ask the question the caller is still hearing");
  assert.equal(r.spoken.filter((t) => t.startsWith("Sorry")).length, 0, "no 'Sorry —' re-ask at all");
});

await test("D10b. a 'Hello' said AFTER the opening finished is still unclear and still re-asked (scope: the pickup window only)", async () => {
  const r = await run(["Hello", "Yes."], { openingLine: ID_FIRST_OPEN, skipPickup: true, afterOpening: true });
  assert.equal(r.llmRequests, 1, "one request, and only after the real answer");
  assert.equal(r.lastUserSentToLlm, "Yes.");
  assert.ok(idAsks(r.spoken) >= 1, "a hello out of a clear sky, after the question, is not an answer — the question is put again");
});

await test("D10c. 'Hello hello' over the opening is also the pickup", async () => {
  const r = await idFirst(["Hello hello.", "Yes."]);
  assert.equal(idAsks(r.spoken), 0, "not re-asked");
  assert.equal(r.llmRequests, 1);
});

await test("D10d. 'Yes, hello' over the opening carries the answer and is NOT dropped — it confirms", async () => {
  const r = await idFirst(["Yes, hello."]);
  assert.equal(r.llmRequests, 1, "the yes reached the gate and opened it");
  assert.equal(idAsks(r.spoken), 0, "nothing re-asked");
  assert.equal(pitched(r.spoken), true);
});

await test("D10e. 'Hello? Who is this?' over the opening is not a pickup: it is unclear and re-asked, as before", async () => {
  const r = await idFirst(["Hello? Who is this?"]);
  assert.equal(r.llmRequests, 0);
  assert.ok(idAsks(r.spoken) >= 1, "a real question back is not a greeting");
});

await test("D10f. 'Hi' over the opening is the pickup too", async () => {
  const r = await idFirst(["Hi.", "Yes."]);
  assert.equal(idAsks(r.spoken), 0, "not re-asked");
  assert.equal(r.llmRequests, 1);
  assert.equal(r.lastUserSentToLlm, "Yes.");
});

await test("D10g. DEEPGRAM'S OWN SPELLINGS of the pickup hello are the pickup — the STT runs `language: multi` and writes 'hello' in whatever language it guesses", async () => {
  // Real call 09b85194 (2026-09-21 13:48 UTC): opening → "ഹലോ." →
  // "Sorry — Am I speaking with Sakshi Gosain?". Across 1,024 stored
  // calls the first caller utterance was "aló" 31 times, "¿aló" 12,
  // "ഹലോ" 7, "allô" 4, "ಹಲೋ" and "हॅलो" — every one the caller saying
  // hello, every one rejected by a Latin-and-Devanagari table.
  for (const rendering of ["ഹലോ.", "ഹലോ .", "Aló.", "¿Aló?", "Aló, ¿aló?", "Allô.", "ಹಲೋ.", "हॅलो.", "Hola."]) {
    const r = await idFirst([rendering, "Yes."]);
    assert.equal(idAsks(r.spoken), 0, `"${rendering}" over the opening must not re-ask the question`);
    assert.equal(r.spoken.filter((t) => t.startsWith("Sorry")).length, 0, `no "Sorry —" after "${rendering}"`);
    assert.equal(r.llmRequests, 1, `"${rendering}" then "Yes." opens the gate once`);
    assert.equal(r.lastUserSentToLlm, "Yes.");
  }
});

await test("D10h. the consumed pickup greeting has ONE lifecycle: it is never committed, replayed, or shown to the model", async () => {
  const h = startHarness({ openingLine: ID_FIRST_OPEN, identityLine: ID_LINE, replies: [PITCH], replyDelayMs: 0 });
  try {
    h.say("Hello.", { isFinal: true, isSpeechFinal: true });
    await h.waitFor("the opening to finish", () => h.replyCount() >= 1 && h.record.state === SessionState.LISTENING);
    await sleep(1500);
    assert.deepEqual(
      h.history().filter((t) => t.role === "user").map((t) => t.content),
      [],
      "the pickup hello is not a committed user turn",
    );
    assert.equal(h.requests.length, 0, "nothing reached the model");
    assert.equal(idAsks(h.synthesized), 0, "nothing was re-asked");
    h.say("Yes.", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2);
    assert.deepEqual(h.history().filter((t) => t.role === "user").map((t) => t.content), ["Yes."], "the answer is the first and only committed turn");
    assert.equal(h.requests.length, 1);
    assert.ok(
      !h.requests[0]!.some((t) => t.role === "user" && /hello/iu.test(t.content)),
      "the model never sees the pickup hello — not replayed from any buffer",
    );
  } finally {
    await h.stop();
  }
});

await test("D10j. THE REPRODUCTION: a post-opening 'हेलो।' on an ENGLISH campaign is re-asked in ENGLISH, not Hindi", async () => {
  // Real call aa0f2e03 (2026-09-21 14:56 UTC): Soniox wrote the caller's
  // English "Hello" as "हेलो।"; the re-ask came back as "माफ़ कीजिए — …"
  // because the bare greeting moved the per-turn language to Hindi even
  // though the lock had refused it as evidence.
  const r = await run(["हेलो।", "Yes."], { openingLine: ID_FIRST_OPEN, skipPickup: true, afterOpening: true });
  assert.ok(idAsks(r.spoken) >= 1, "a hello after the question is still not an answer — the question is put again");
  assert.ok(r.spoken.some((t) => t.startsWith("Sorry")), "…in ENGLISH");
  assert.equal(r.spoken.filter((t) => t.startsWith("माफ़")).length, 0, "never in Hindi on an English call for a bare greeting");
  assert.equal(r.llmRequests, 1, "and the English 'Yes.' then opens the gate");
});

await test("D10i. a 'Hello' LATER in the call is not a pickup: it is committed and handled on the normal path", async () => {
  const h = startHarness({ openingLine: ID_FIRST_OPEN, identityLine: ID_LINE, replies: [PITCH, "Yes, I'm here — shall I continue?"], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.replyCount() >= 1 && h.record.state === SessionState.LISTENING);
    await sleep(200);
    h.say("Yes.", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2);
    h.say("Hello.", { isFinal: true, isSpeechFinal: true });
    await h.waitFor("the later hello to be committed", () =>
      h.history().some((t) => t.role === "user" && t.content === "Hello."),
    );
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "the later hello took the ordinary path (one request for it)");
    assert.equal(idAsks(h.synthesized), 0, "the confirmed gate never re-asks");
  } finally {
    await h.stop();
  }
});

await test("D10k. the pickup window still holds under the SONIOX LANGUAGE RESTRICTION (hi + en)", async () => {
  // Verification, not a new mechanism. `language_hints_strict` confines
  // Soniox to Hindi and English, so the pickup "hello" can now only
  // arrive in Latin or Devanagari — the Malayalam/Kannada/Gurmukhi/
  // Bengali/Spanish renderings D10g pins become unreachable on this
  // provider (they stay in the table for Deepgram's `multi`, which is
  // untouched). These are the renderings that remain reachable.
  for (const rendering of ["Hello.", "हेलो।", "हैलो।", "हॅलो.", "नमस्ते।", "Hi."]) {
    const r = await idFirst([rendering, "Yes."]);
    assert.equal(idAsks(r.spoken), 0, `"${rendering}" over the opening must not re-ask`);
    assert.equal(r.spoken.filter((t) => t.startsWith("Sorry")).length, 0, `no "Sorry —" after "${rendering}"`);
    assert.equal(r.llmRequests, 1, `"${rendering}" then "Yes." opens the gate once`);
    assert.equal(r.lastUserSentToLlm, "Yes.");
  }
  // AND THE OTHER HALF: the restriction narrows the scripts, it does
  // not widen what counts as a pickup. Anything carrying an answer, a
  // name or a question is NOT a bare greeting and must still reach the
  // gate — consuming it would be the swallowed-turn defect, which this
  // fix must not introduce in either script.
  //
  // A consumed pickup leaves the opening as the ONLY thing ever spoken
  // and runs no model request (that is precisely what D10/D10h pin), so
  // "the gate saw it" is exactly "something followed the opening".
  //
  // NOT asserted here: WHICH language the re-ask comes back in. A bare
  // Devanagari "यस।" moves the per-turn language and is re-asked in
  // Hindi — a separate, already-known defect of the wrong-script
  // transcript itself, and the thing `language_hints_strict` exists to
  // stop producing upstream. It is not the pickup window's business.
  for (const answer of ["यस।", "हाँ जी।", "Yes, hello.", "हेलो, कौन बोल रहा है?", "Hello Rohan."]) {
    const r = await idFirst([answer]);
    assert.ok(
      r.spoken.length > 1 || r.llmRequests > 0,
      `"${answer}" must reach the gate, never be consumed as a bare pickup greeting`,
    );
  }
});

await test("D11. a repeated 'Yes.' does not ask, introduce or pitch twice", async () => {
  const r = await idFirst(["Yes.", "Yes."]);
  assert.equal(idAsks(r.spoken), 0, "the confirmed gate never asks again");
  assert.equal(r.llmRequests, 2, "the second turn is ordinary conversation, answered once");
});

await test("D12. silence after the opening leaves the gate shut", async () => {
  // No turn at all: the gate cannot open on nothing, and the silence
  // recovery ladder is a different mechanism entirely.
  const r = await idFirst([], { pauseMs: 0 });
  assert.equal(r.llmRequests, 0);
  assert.equal(pitched(r.spoken), false);
});

// ═════════════════════════════════════════════════════════════════
section("E. THE v8 SCRIPT — identity first, introduction in the first reply");
// ═════════════════════════════════════════════════════════════════

await test("E1. v8's opening line IS the identity question the pipeline supplies", async () => {
  const { findScript } = await import("../script/script-registry");
  const v8 = findScript("registration", "v8");
  assert.ok(v8, "registration v8 must be registered");
  const context = buildCampaignContext({
    campaignId: "e1",
    campaignType: "registration",
    script: v8,
    provider: "smallest-ai",
    customerName: "Sakshi",
    expectedScriptHash: hashScript(v8),
  });
  assert.equal(context.openingLine, "Hello, am I speaking with Sakshi?");
  assert.equal(context.identityLine, "Am I speaking with Sakshi?");
  // THE COUPLING THE PIPELINE RELIES ON. `openingLineAsksIdentity`
  // marks the gate `outstanding` because the opening contains the
  // identity line; if this ever stops being true the caller is asked
  // the same question twice in a row.
  assert.ok(
    context.openingLine.toLowerCase().includes(context.identityLine.toLowerCase()),
    "the opening must contain the identity line verbatim",
  );
  assert.ok(!context.openingLine.includes("{{"), "no placeholder may survive");
});

await test("E2. v8 introduces the agent in the FIRST REPLY, not in the opening", async () => {
  const { findScript } = await import("../script/script-registry");
  const v8 = findScript("registration", "v8")!;
  assert.equal(
    v8.openingLineTemplate.includes("{{agent_name}}"),
    false,
    "the agent's name must NOT be in the opening — that is the whole change",
  );
  assert.ok(
    v8.openingLineTemplate.includes("{{customer_name}}"),
    "the opening asks for the CUSTOMER by name",
  );
  assert.ok(
    v8.systemPromptAppendix.includes("I'm {{agent_name}} from Team FlexiFunnels."),
    "the introduction moved into the first reply's instruction",
  );
});

await test("E3. v8 keeps v7's commitment gate, discovery question and event facts WORD FOR WORD", async () => {
  const { findScript } = await import("../script/script-registry");
  const v7 = findScript("registration", "v7")!;
  const v8 = findScript("registration", "v8")!;
  for (const carried of [
    "Would you like me to reserve your free seat?",
    "Are you currently running a business, or are you looking to start something online?",
    "Saturday 19th and Sunday 20th September 2026",
    "the 2-Day AI Income Blueprint Event",
    "There isn't a guaranteed income amount.",
  ]) {
    assert.ok(v7.systemPromptAppendix.includes(carried), `premise: v7 contains "${carried}"`);
    assert.ok(v8.systemPromptAppendix.includes(carried), `v8 must carry "${carried}" unchanged`);
  }
});

await test("E4. v7 is untouched, and v8 is still not the default", async () => {
  const { findScript, defaultScriptFor } = await import("../script/script-registry");
  const v7 = findScript("registration", "v7")!;
  assert.equal(
    v7.openingLineTemplate,
    "Hello, this is {{agent_name}} from Team FlexiFunnels.",
    "v7's opening must stay exactly as approved — campaigns are pinned to its hash",
  );
  // The default is the workshop script — v6 when v8 shipped, v15 since.
  // What must never happen is v8 becoming it.
  assert.equal(defaultScriptFor("registration").version, "v15", "v8 must not become the default");
});

await test("E5. answering v8's opening does not register anybody", async () => {
  // The identity answer is a yes, and the classifier must not read it
  // as a yes to the commitment gate.
  const { classifyOutcome } = await import("../outcome/classifier");
  const { dispositionFor } = await import("../outcome/disposition");
  for (const said of ["Yes.", "Haan ji.", "Speaking."]) {
    const outcome = classifyOutcome({
      campaignType: "registration",
      status: "COMPLETED",
      failureClass: "COMPLETED",
      answered: true,
      transcript: [
        { role: "assistant", text: "Hello, am I speaking with Sakshi?" },
        { role: "user", text: said },
      ] as never,
    });
    const disposition = dispositionFor({
      outcomeType: outcome.outcomeType,
      failureClass: "COMPLETED",
    }).disposition;
    assert.notEqual(disposition, "FINAL_YES", `"${said}" to the v8 opening must not register`);
    assert.notEqual(outcome.primaryReason, "confirmed_at_gate");
  }
});

// ═════════════════════════════════════════════════════════════════
section("F. A DENIED IDENTITY MUST NOT BECOME A REGISTRATION");
// ═════════════════════════════════════════════════════════════════
//
// THE GATE'S VERDICT USED TO STOP AT THE GATE. `identityState =
// "denied"` kept the identity question from being reopened, and that
// was the whole of it. Everything the campaign does with a finished
// call is read back out of the TRANSCRIPT by `classifyOutcome`:
//
//   stored outcome / confirmed_at_gate   classifier.ts rule 4
//   FINAL_YES disposition / retry        disposition.ts, retry-planner
//   registrations sheet                  isFinalYes(classification, …)
//   live hangup                          definitiveAnswerIn -> verdictFrom
//
// All four read the SAME label, and the transcript does not record
// which sentence was the identity question — so a denial whose words
// are not in the classifier's own (deliberately narrow) WRONG_NUMBER
// table was invisible to every one of them. Reproduced against the real
// classifier on 2026-09-23:
//
//   agent   "Am I speaking with Sakshi?"
//   caller  "No."
//   agent   "…should I reserve your free seat for Sunday?"
//   caller  "Yes."
//   -> registered_confirmed / confirmed_at_gate / succeeded / FINAL_YES
//      -> a sheet row, a closed contact, and an early hangup, for
//         somebody who had just said they were not the person.
//
// The gate's verdict is now carried to that one function (see
// `ClassifyOutcomeInput.identityDenied`), where the repository's own
// existing category for it already sits ABOVE the commitment gate:
// `wrong_number` / `wrong_person` -> FINAL_NO. No new outcome type, no
// new reason, no new disposition, no new retry rule and no new hangup
// rule — the fact is simply made visible where the decisions are taken.

const { classifyOutcome: classifyF } = await import("../outcome/classifier");
const { dispositionFor: dispositionForF } = await import("../outcome/disposition");
const { isFinalYes: isFinalYesF } = await import("../integrations/final-yes-sheet");

const GATE_LINE = "Great — should I reserve your free seat for Sunday?";

/** Every campaign consequence of one transcript, read through the real code. */
function consequencesOf(
  turns: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
  identityDenied: boolean,
) {
  const classification = classifyF({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns as never,
    ...(identityDenied ? { identityDenied: true } : {}),
  });
  const { disposition } = dispositionForF({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return {
    // 1. the stored outcome row
    outcomeType: classification.outcomeType,
    primaryReason: classification.primaryReason,
    succeeded: classification.succeeded,
    // 2. the contact disposition the retry planner reads
    disposition,
    // 3. the registrations-sheet mirror
    sheetRow: isFinalYesF(classification, disposition),
    // 4. the live hangup
    liveVerdict: definitiveAnswerIn(
      turns.map((t) => ({ role: t.role, content: t.text })) as never,
      "registration",
      identityDenied,
    ),
  };
}

/** The reported shape: denied, then a generic yes to the commitment question. */
const DENIED_THEN_YES = (denial: string) => [
  { role: "assistant" as const, text: ID_LINE },
  { role: "user" as const, text: denial },
  { role: "assistant" as const, text: GATE_LINE },
  { role: "user" as const, text: "Yes." },
  { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
];

await test("F1. END TO END: a genuine denial leaves the gate DENIED, through the real pipeline", async () => {
  for (const denial of ["No.", "Nahi, main Sakshi nahi hoon", "Wrong number.", "No, this isn't Sakshi."]) {
    const r = await idFirst([denial]);
    assert.equal(r.identityDenied, true, `"${denial}" must leave the gate denied`);
    assert.equal(idAsks(r.spoken), 0, `"${denial}": a denied gate does not ask again`);
  }
});

await test("F2. (A) a genuine denial does not enter the confirmed campaign path — all four consequences", async () => {
  // The words differ; the verdict does not. Every one of these is a
  // denial the gate already understands (section A/D), and not one of
  // them may produce a registration in any of the four places.
  for (const denial of ["No.", "Nahi, main Sakshi nahi hoon", "No, this isn't Sakshi.", "नहीं"]) {
    const c = consequencesOf(DENIED_THEN_YES(denial), true);
    assert.equal(c.outcomeType, "wrong_number", `"${denial}" -> stored outcome`);
    assert.equal(c.primaryReason, "wrong_person", `"${denial}" -> primary reason`);
    assert.equal(c.succeeded, false, `"${denial}" -> succeeded`);
    assert.notEqual(c.primaryReason, "confirmed_at_gate");
    assert.equal(c.disposition, "FINAL_NO", `"${denial}" -> disposition`);
    assert.notEqual(c.disposition, "FINAL_YES");
    assert.equal(c.sheetRow, false, `"${denial}" must not be mirrored to the registrations sheet`);
    assert.notEqual(c.liveVerdict, "FINAL_YES", `"${denial}" must not hang up as a registration`);
  }
});

await test("F3. (B) a genuine confirmation still enters the confirmed path, unchanged", async () => {
  // The other side of F2, and the one that proves the fix is narrow:
  // the identical transcript with the gate CONFIRMED still registers.
  const confirmed = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "Yes, this is Sakshi." },
    { role: "assistant" as const, text: GATE_LINE },
    { role: "user" as const, text: "Yes." },
    { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
  ];
  const c = consequencesOf(confirmed, false);
  assert.equal(c.outcomeType, "registered_confirmed");
  assert.equal(c.primaryReason, "confirmed_at_gate");
  assert.equal(c.succeeded, true);
  assert.equal(c.disposition, "FINAL_YES");
  assert.equal(c.sheetRow, true, "a real registration still reaches the sheet");
  assert.equal(c.liveVerdict, "FINAL_YES", "and still ends the call as one");

  // ...and end to end: a confirming turn never sets the denied verdict.
  for (const said of ["Yes.", "Haan ji.", "Speaking.", "Yes, this is Sakshi"]) {
    const r = await idFirst([said]);
    assert.equal(r.identityDenied, false, `"${said}" must not be read as a denial`);
  }
});

await test("F4. (C) unclear stays unclear — it is not a denial, and nothing downstream moves", async () => {
  // The gate re-asks an unclear answer and gives up on the third; it
  // never sets `denied`. Asserted through the pipeline, because that is
  // where the distinction lives, and then downstream, because the whole
  // risk of this fix would be `unclear` quietly becoming a denial.
  for (const said of ["Who is this?", "Kya chahiye?", "Hmm.", "Yes, I can hear you"]) {
    const r = await idFirst([said]);
    assert.equal(r.identityDenied, false, `"${said}" is unclear, not denied`);
  }
  // Three unclear answers end the call (B9/D12) and still do not deny.
  const gaveUp = await idFirst(["Kya chahiye?", "Kaun bol raha hai?", "Hmm."]);
  assert.equal(gaveUp.identityDenied, false, "giving up is not a denial");
  assert.equal(gaveUp.llmRequests, 0, "and it still never reached the model");
});

await test("F5. (D) a later generic 'Yes' cannot override a prior denial", async () => {
  // THE REPORTED SHAPE, in full. The person said they are not Sakshi;
  // everything after that is a conversation with somebody else, and a
  // "Yes." in it is not their agreement to anything.
  const c = consequencesOf(DENIED_THEN_YES("No."), true);
  assert.equal(c.outcomeType, "wrong_number");
  assert.equal(c.disposition, "FINAL_NO");
  assert.equal(c.sheetRow, false);
  assert.notEqual(c.liveVerdict, "FINAL_YES");

  // ...and the Hinglish twin, where the gate yes is "Haan ji" — the
  // single commonest yes on these calls.
  const hinglish = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "Nahi, main Sakshi nahi hoon." },
    { role: "assistant" as const, text: GATE_LINE },
    { role: "user" as const, text: "Haan ji." },
    { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
  ];
  const h = consequencesOf(hinglish, true);
  assert.equal(h.outcomeType, "wrong_number");
  assert.equal(h.disposition, "FINAL_NO");
  assert.equal(h.sheetRow, false);
  assert.notEqual(h.liveVerdict, "FINAL_YES");

  // The repository's flow has no branch that re-opens a denied gate —
  // `handleIdentityGate` returns early on `denied` for the rest of the
  // call — so there is no permitted way for this to be overridden, and
  // the pipeline agrees: the gate is still denied after the later yes.
  const r = await idFirst(["No.", "Yes, this is Sakshi", "Yes."]);
  assert.equal(r.identityDenied, true, "no later turn re-opens a denied gate");
  assert.equal(idAsks(r.spoken), 0, "and it is never asked again");
});

await test("F6. THE DEFECT ITSELF: the same transcript WITHOUT the verdict is what it always was", async () => {
  // The proof that nothing in the classifier moved except the new
  // input. With the gate's verdict absent — every non-campaign caller,
  // every re-scoring of a stored row, every call whose gate confirmed
  // or stayed unclear — this transcript still classifies exactly as it
  // did before the fix existed, defect and all.
  const before = consequencesOf(DENIED_THEN_YES("No."), false);
  assert.equal(before.outcomeType, "registered_confirmed", "unchanged when nothing is passed");
  assert.equal(before.primaryReason, "confirmed_at_gate");
  assert.equal(before.disposition, "FINAL_YES");
  assert.equal(before.sheetRow, true);
});

await test("F7. the live hangup and the stored outcome cannot disagree", async () => {
  // Both readings are made from the same two facts — the transcript and
  // the gate's verdict — so a call can never hang up as a registration
  // and then be stored as a wrong number.
  const turns = DENIED_THEN_YES("No.");
  const c = consequencesOf(turns, true);
  assert.equal(c.liveVerdict === "FINAL_YES", c.sheetRow, "hangup and sheet agree");
  assert.equal(c.liveVerdict === "FINAL_YES", c.disposition === "FINAL_YES", "hangup and disposition agree");
});

await test("F8. compliance still outranks it", async () => {
  // A person who says they are not Sakshi AND asks never to be called
  // again is an opt-out, exactly as before: the new rule sits UNDER the
  // compliance rule, so a do-not-call request cannot be relabelled by it.
  const optOut = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "No. Do not call me again." },
  ];
  const c = consequencesOf(optOut, true);
  assert.equal(c.outcomeType, "do_not_call");
  assert.equal(c.primaryReason, "opt_out");
  assert.equal(c.disposition, "FINAL_NO");
});

await test("F9. a call with NO identity gate is untouched", async () => {
  // Every non-campaign session and every script that does not require a
  // name: the gate never exists, the verdict is never true, and the
  // classification is the one it always was.
  const r = await run(["Hello"], { identityLine: "" });
  assert.equal(r.identityDenied, false, "no gate, no denial");
  assert.equal(r.llmRequests, 1, "and no change to the call");
});


console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
