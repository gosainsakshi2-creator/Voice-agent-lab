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
  opts: { readonly identityLine?: string; readonly pauseMs?: number } = {},
): Promise<{ spoken: string[]; llmRequests: number; lastUserSentToLlm: string | undefined }> {
  // `identityLine: ""` means "this call has no gate"; omitted means the
  // ordinary campaign gate.
  const line = opts.identityLine === undefined ? ID_LINE : opts.identityLine;
  const h = startHarness({
    openingLine: OPEN,
    ...(line.length > 0 ? { identityLine: line } : {}),
    replies: [PITCH, PITCH, PITCH, PITCH],
    replyDelayMs: 0,
  });
  try {
    // The caller's first "Hello." answers the phone and the pipeline
    // drops it as the pickup acknowledgement — the opening line is
    // already the answer to it. That is existing behaviour and not
    // this gate's business, so every case here starts after it.
    h.say("Hello.", { isFinal: true, isSpeechFinal: true });
    await sleep(3000);
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

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
