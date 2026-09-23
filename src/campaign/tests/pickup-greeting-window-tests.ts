/**
 * pickup-greeting-window-tests.ts — `npm run test:pickup-window`
 *
 * THE PICKUP "HELLO" THAT DEEPGRAM DELIVERS LATE.
 *
 * `pickupAckAllowance` already drops the caller's phone-answer "Hello"
 * so the opening line is not re-asked. Every existing case for it
 * (identity-gate D10, D10c, D10f, D10g, D10h) feeds that greeting's
 * TRANSCRIPT SEGMENT while the opening is still playing, which was the
 * only situation the allowance could be armed in: the STT listener set
 * it from `!greetingDone`, i.e. from when the transcript ARRIVED.
 *
 * On a real call those two instants are not the same instant. Deepgram
 * delivers a final 0.4-1.7s after the words (`endpointing=400`,
 * `utterance_end_ms=1000`), while the approved identity-first opening
 * ("Hi, am I speaking with Sakshi?") is only ~2s of audio. So a "Hello"
 * SPOKEN at +0.8s — squarely over the opening — routinely LANDS after
 * `greetingDone` has flipped. The allowance was then never armed, the
 * greeting reached `handleIdentityGate`, classified `unclear`, and drew
 * `identityReAskFor` — "Sorry — Am I speaking with Sakshi?" — over a
 * question the caller had only just heard. That is the reported defect,
 * and R1 below is its reproduction.
 *
 * THE WINDOW IS NOW A SPAN OF THE CALLER'S AUDIO, NOT OF OUR PROCESS.
 * `greetingDoneAtStreamMs` records where the opening finished on the
 * call-long audio clock, and a segment whose words BEGAN at or before
 * it arms the allowance however late it lands. Nothing else moves: the
 * same allowance, consumed by the same first acquired turn, dropped
 * only if the whole utterance passes the same `PICKUP_GREETING_ONLY`
 * table. No greeting spelling is added and no rule is relaxed.
 *
 * THE HARNESS FEEDS INBOUND AUDIO IN REAL TIME, which a live bridge
 * does from the instant the call is answered and which is what makes
 * that clock mean anything. A test therefore never invents a word
 * time: it CAPTURES the live position with `streamMs()` at the moment
 * the caller would have spoken, and stamps the segment with it when it
 * delivers it later. Wall-clock milliseconds are not interchangeable
 * with that clock — `setInterval` under load, and the queue between
 * the harness and the provider, both leave it behind — and a test
 * written against the wall clock silently stops testing anything.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET OR CONTACTS A VENDOR.
 * Every provider is a local fake; the pipeline, the turn detector, the
 * identity classifier and the conversation memory are the real ones.
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

// ═════════════════════════════════════════════════════════════════
// THE HARNESS
//
// The identity-gate harness, with two additions and nothing else:
//
//   - INBOUND AUDIO, pushed in real time from call-connect, so
//     `inboundStreamMs` advances the way it does on a live bridge and
//     a segment's word times can be compared against it.
//   - `say(text, { startedAtMs, endedAtMs })`, so a test can deliver a
//     segment LATE while saying the words were spoken EARLY. That gap
//     is Deepgram's delivery lag, and it is the whole subject here.
// ═════════════════════════════════════════════════════════════════

const CHARS_PER_SECOND = 22;

function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return { data: new Uint8Array(Math.round(seconds * 8000)), encoding: "MULAW", sampleRateHz: 8000 };
}

/** One 20ms MULAW/8000 frame — the shape every telephony bridge sends. */
const INBOUND_FRAME_MS = 20;
function inboundFrame(): AudioPayload {
  return { data: new Uint8Array(8 * INBOUND_FRAME_MS), encoding: "MULAW", sampleRateHz: 8000 };
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
  /**
   * Feed one transcript segment. `startedAtMs`/`endedAtMs` are the WORD
   * TIMES — where the caller's voice sits on the STT stream clock, in
   * ms from call-connect — and default to the harness's own monotonic
   * clock. A test that passes them explicitly is modelling the gap
   * between when the caller spoke and when Deepgram delivered it.
   */
  say(
    text: string,
    opts?: { isFinal?: boolean; isSpeechFinal?: boolean; endedAtStreamMs?: number },
  ): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  replyCount(): number;
  history(): readonly ConversationTurn[];
  /**
   * The harness's own position on the inbound audio clock — the SAME
   * clock the pipeline's `inboundStreamMs` counts and the same one
   * Deepgram's word times are reported on. Read to capture "where the
   * caller's voice is right now", so a test can deliver that utterance
   * later without inventing a number. Wall-clock ms are NOT
   * interchangeable with it: `setInterval` under load, and the queue
   * between the harness and the provider, both leave it behind.
   */
  streamMs(): number;
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  readonly replyDelayMs?: number;
  readonly identityLine?: string;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let micStreamMs = 0;
  let replyIndex = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (request: {
      readonly audio: AsyncIterable<AudioPayload>;
    }): AsyncIterable<TranscriptSegment> {
      // A real provider consumes the inbound audio, which is what
      // advances the pipeline's `inboundStreamMs` — the clock the word
      // times below are compared against. A fake that ignores it leaves
      // that clock pinned at zero and the whole subject unobservable.
      void (async () => {
        try {
          for await (const _chunk of request.audio) {
            if (closed) break;
          }
        } catch {
          /* the loop is aborting */
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
    generateCompletion: async (request: CompletionRequest) => {
      requests.push(request.history);
      return { turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays; it is not a conversational request.
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
    "pickup-window-test" as SessionId,
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
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => undefined);

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  // The caller's line, open from call-connect. Real time, so the
  // pipeline's audio clock and the word times below share an origin.
  const inbound = setInterval(() => {
    if (closed) return;
    micStreamMs += INBOUND_FRAME_MS;
    record.inboundAudioFallback.push(inboundFrame());
  }, INBOUND_FRAME_MS);
  const loop = pipeline.run();

  return {
    record,
    requests,
    synthesized,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      // Where the caller's voice sits on the audio clock. Defaults to
      // the live edge — "they are saying this now" — and a test that
      // passes `endedAtStreamMs` is saying "they said it back THEN, and
      // Deepgram is only delivering it now".
      const endedAtMs = opts?.endedAtStreamMs ?? micStreamMs;
      const startedAtMs = Math.max(0, endedAtMs - Math.max(200, (text.length / CHARS_PER_SECOND) * 1000));
      segments.push({
        text,
        isFinal,
        ...(opts?.isSpeechFinal !== undefined ? { isSpeechFinal: opts.isSpeechFinal } : { isSpeechFinal: isFinal }),
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs,
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
      throw new Error(`timed out waiting for ${n} replies`);
    },
    history() {
      return record.memory.history().filter((turn) => turn.role !== "system");
    },
    streamMs() {
      return micStreamMs;
    },
    async stop() {
      clearInterval(inbound);
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}


/** The approved identity-first opening: the opening line IS the question. */
const ID_FIRST_OPEN = "Hi, am I speaking with Sakshi?";
const ID_LINE = "Am I speaking with Sakshi?";
const PITCH =
  "I'm calling to invite you to a free live workshop this Sunday at 11 AM. " +
  "Have you tried putting something online before?";

const start = () =>
  startHarness({ openingLine: ID_FIRST_OPEN, identityLine: ID_LINE, replies: [PITCH, PITCH], replyDelayMs: 0 });

/**
 * How many times the GATE put the question again. `identityReAskFor` is
 * the ONLY thing that prefixes "Sorry — " on an English call, so this
 * counts exactly the reported symptom.
 */
const sorryReAsks = (spoken: readonly string[]) => spoken.filter((t) => t.startsWith("Sorry")).length;

/** Every committed user turn, in order — what the model was shown. */
const userTurns = (h: Harness) => h.history().filter((t) => t.role === "user").map((t) => t.content);

/**
 * Play the opening line out, having captured where the caller's pickup
 * "Hello" falls on the audio clock while it was still going.
 *
 * `spokenAtStreamMs` is a REAL position inside the opening — sampled
 * partway through its playback — so the words it stamps are ones the
 * caller said OVER the opening, however long the test then waits before
 * delivering them. That wait is Deepgram's delivery lag, and it is the
 * whole subject here.
 */
async function playOpening(h: Harness): Promise<{
  spokenAtStreamMs: number;
  openingEndedAtStreamMs: number;
}> {
  await h.waitFor("the opening line to start", () => h.record.state === SessionState.SPEAKING);
  // ~40% into the opening's ~1.5s of audio: unambiguously inside it,
  // with room on both sides for the clock to be coarse.
  await sleep(600);
  const spokenAtStreamMs = h.streamMs();
  await h.waitFor(
    "the opening line to finish",
    () => h.replyCount() >= 1 && h.record.state === SessionState.LISTENING,
  );
  return { spokenAtStreamMs, openingEndedAtStreamMs: h.streamMs() };
}

// ═════════════════════════════════════════════════════════════════
section("A. THE PICKUP HELLO, DELIVERED LATE — the reported defect");
// ═════════════════════════════════════════════════════════════════

await test("A1. REPRODUCTION: 'Hello' spoken over the opening, delivered after it finished, is still the pickup", async () => {
  const h = start();
  try {
    const { spokenAtStreamMs, openingEndedAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello.", { endedAtStreamMs: spokenAtStreamMs });
    await sleep(3000);
    assert.ok(
      spokenAtStreamMs < openingEndedAtStreamMs,
      `the words must fall INSIDE the opening (spoken at ${spokenAtStreamMs}ms, opening ended at ${openingEndedAtStreamMs}ms)`,
    );
    assert.equal(
      sorryReAsks(h.synthesized),
      0,
      `the pickup greeting must NOT draw "Sorry — ..."; spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.deepEqual(h.synthesized, [ID_FIRST_OPEN], "the opening is the ONLY thing spoken");
    assert.equal(h.requests.length, 0, "and it must not reach the language model either");
  } finally {
    await h.stop();
  }
});

await test("A2. it is CONSUMED ONCE: not committed, not replayed, and the real answer still confirms", async () => {
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello.", { endedAtStreamMs: spokenAtStreamMs });
    await sleep(2500);
    assert.deepEqual(userTurns(h), [], "the pickup hello is not a committed user turn");
    assert.equal(h.requests.length, 0, "nothing reached the model");
    assert.equal(h.record.liveUserTranscript, "", "and no display preview is left dangling");

    // The caller's real answer, spoken at the live edge, is untouched.
    h.say("Yes.");
    await h.waitForReplies(2);
    assert.deepEqual(userTurns(h), ["Yes."], "the answer is the first and only committed user turn");
    assert.equal(h.requests.length, 1, "exactly one request, after confirmation");
    assert.equal(sorryReAsks(h.synthesized), 0, "nothing was ever re-asked");
    assert.ok(
      !h.requests[0]!.some((t) => t.role === "user" && /hello/iu.test(t.content)),
      "the model never sees the pickup hello — not replayed from any buffer",
    );
  } finally {
    await h.stop();
  }
});

await test("A3. B — 'Hello' spoken AND delivered while the opening is still playing (unchanged behaviour)", async () => {
  const h = start();
  try {
    // No wait: the case every existing test covers, which the original
    // arrival-clock arming already handles. It must stay handled.
    h.say("Hello.");
    await playOpening(h);
    await sleep(2000);
    assert.equal(sorryReAsks(h.synthesized), 0, `no re-ask; spoken=${JSON.stringify(h.synthesized)}`);
    assert.equal(h.requests.length, 0, "nothing reached the model");
    assert.deepEqual(userTurns(h), [], "and nothing was committed");
  } finally {
    await h.stop();
  }
});

await test("A4. the late pickup cannot produce a SECOND identity question of any kind", async () => {
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello.", { endedAtStreamMs: spokenAtStreamMs });
    await sleep(3000);
    // Counts the question in ANY form — the gate's re-ask, a give-up
    // close, or a regenerated one — not just the "Sorry — " prefix.
    const asked = h.synthesized.filter((t) => /am i speaking with/iu.test(t)).length;
    assert.equal(
      asked,
      1,
      `the question is asked exactly once, by the opening; spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(
      h.synthesized.filter((t) => /I'll try again later/iu.test(t)).length,
      0,
      "and the give-up close is not reached — no re-ask was ever spent",
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. THE OTHER SIDE OF THE WINDOW — a real turn stays a real turn");
// ═════════════════════════════════════════════════════════════════

await test("B1. C — 'Hello?' SPOKEN after the opening is NOT the pickup: it is unclear and the question is put again", async () => {
  const h = start();
  try {
    const { openingEndedAtStreamMs } = await playOpening(h);
    await sleep(600);
    const spokenAtStreamMs = h.streamMs();
    h.say("Hello?");
    await sleep(3000);
    assert.ok(
      spokenAtStreamMs > openingEndedAtStreamMs,
      `the words must fall OUTSIDE the opening (spoken at ${spokenAtStreamMs}ms, opening ended at ${openingEndedAtStreamMs}ms)`,
    );
    assert.ok(
      sorryReAsks(h.synthesized) >= 1,
      `a hello out of a clear sky is not an answer — the question is put again; spoken=${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

await test("B2. D — a real identity answer after the opening is unchanged: it confirms and the model runs once", async () => {
  const h = start();
  try {
    await playOpening(h);
    await sleep(150);
    h.say("Yes, this is Sakshi.");
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "one request, after confirmation");
    assert.equal(sorryReAsks(h.synthesized), 0, "the gate never re-asked");
    assert.ok(h.synthesized.some((t) => t.includes("free live workshop")), "and the campaign followed");
  } finally {
    await h.stop();
  }
});

await test("B3. an answer SPOKEN over the opening is still an answer, not a pickup", async () => {
  // The identity-first bound `PICKUP_GREETING_ONLY` exists for exactly
  // this: the opening is a QUESTION, so anything that could answer it
  // reaches the gate however early it was said. Widening the window to
  // the audio clock must not widen what the window DROPS.
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Yes.", { endedAtStreamMs: spokenAtStreamMs });
    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "the answer reached the gate and opened it");
    assert.equal(sorryReAsks(h.synthesized), 0, "nothing re-asked");
    assert.deepEqual(userTurns(h), ["Yes."], "and it was committed as a real turn, not swallowed");
  } finally {
    await h.stop();
  }
});

await test("B4. 'Hello? Who is this?' over the opening is not a pickup: it carries a real question", async () => {
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello? Who is this?", { endedAtStreamMs: spokenAtStreamMs });
    await sleep(3000);
    assert.ok(
      sorryReAsks(h.synthesized) >= 1,
      `a greeting with a question attached is answered, not dropped; spoken=${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

await test("B5. a hello that STRADDLES the end of the opening is left to the ordinary path", async () => {
  // The boundary, asserted as the conservative choice it is: the WHOLE
  // utterance must be inside the opening. One still being spoken as the
  // opening ends is as much a first answer as a pickup, and nothing
  // here can tell them apart — so it is answered, which costs the
  // caller hearing the question twice rather than losing their words.
  // This is also what keeps a turn the pipeline must ANSWER out of the
  // allowance (buffered-turn D1/D2/D5/D6, whose "Hello." ends just
  // after the opening does).
  const h = start();
  try {
    const { openingEndedAtStreamMs } = await playOpening(h);
    await sleep(150);
    // Ends just AFTER the opening did — i.e. it was still being said.
    h.say("Hello.", { endedAtStreamMs: openingEndedAtStreamMs + 60 });
    await sleep(3000);
    assert.ok(
      sorryReAsks(h.synthesized) >= 1,
      `a straddling hello takes the ordinary path; spoken=${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. F — THE CONSUMED GREETING CANNOT COME BACK");
// ═════════════════════════════════════════════════════════════════

await test("C1. a late pickup followed by a genuine 'Hello?' drops ONE and answers the other", async () => {
  // The reported loop, in one call: the pickup reflex, then a real
  // "Hello?" once the caller has heard the opening. Exactly one of them
  // is the pickup, and the allowance is spent on it.
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello.", { endedAtStreamMs: spokenAtStreamMs });
    await sleep(2500);
    assert.equal(sorryReAsks(h.synthesized), 0, "the pickup drew nothing");
    // At the live edge: a genuine one, long after the opening.
    h.say("Hello?");
    await sleep(3000);
    assert.equal(
      sorryReAsks(h.synthesized),
      1,
      `the genuine one is a real turn and is answered once; spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.deepEqual(userTurns(h), ["Hello?"], "and only the genuine one was committed");
  } finally {
    await h.stop();
  }
});

await test("C2. the late pickup is not re-delivered by the silence/retry path", async () => {
  const h = start();
  try {
    const { spokenAtStreamMs } = await playOpening(h);
    await sleep(150);
    h.say("Hello.", { endedAtStreamMs: spokenAtStreamMs });
    // Long enough for the detector, the buffered-turn path and the main
    // loop to have had every chance to hand it over a second time.
    await sleep(6000);
    assert.deepEqual(
      userTurns(h),
      [],
      "the pickup hello never becomes a user turn, however long the line stays open",
    );
    assert.equal(h.requests.length, 0, "and it never reaches the model");
    assert.equal(sorryReAsks(h.synthesized), 0, "and never re-asks the question");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
if (failures.length > 0) {
  console.log(`\n${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} passed`);
}
