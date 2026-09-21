/**
 * backchannel-cue-tests.ts — `npm run test:backchannel-cue`
 *
 * ISSUE: A CALLER GIVING A LONG ANSWER HEARS DEAD AIR IN EVERY PAUSE.
 *
 * The pipeline now says "mm-hmm" / "okay" / "hmm" INTO a pause the turn
 * detector is already holding open for a mid-thought caller — see
 * `BACKCHANNEL_CUE_MIN_WORDS` in `conversation-pipeline.ts`. The cue is
 * a speech-side act, not a semantic turn, and this suite asserts every
 * property that makes it one:
 *
 *   A  a long turn that pauses mid-thought gets ONE lightweight cue,
 *      handed to the transport while the session is still LISTENING
 *   B  the cue is NOT an assistant turn: not in memory, not in the
 *      language model's history, no language-model request made for it
 *   C  the cue does not interrupt: no SPEAKING transition, no barge-in,
 *      the caller's turn is still released whole and answered normally
 *   D  short utterances never draw a cue; a request for a moment never
 *      draws a cue; the per-turn cap holds
 *   E  our own cue coming back up the inbound track as "Hmm." is
 *      dropped before the turn detector, so it can neither pollute the
 *      caller's turn text nor re-arm a window
 *   F  the vocabulary rotates and is non-committal
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the conversation memory and the
 * transport listener contract are the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline, selectBackchannelCue } = await import("../../core/session/conversation-pipeline");
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

/** The detector's windows, restated: a mid-thought hold is armed after the silence window. */
const SILENCE_WINDOW_MS = 1_100;
const CONTINUATION_GRACE_MS = 800;
/** How long to wait for a hold to be armed and a cue to be handed over. */
const CUE_WAIT_MS = SILENCE_WINDOW_MS + 1_200;

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — the same shape `attention-check-tests.ts` uses, plus
// an outbound listener that records what reached the transport and in
// which session state.
// ═════════════════════════════════════════════════════════════════

const CHARS_PER_SECOND = 22;

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

const healthy = (identifier: { category: unknown; id: string }) => ({ identifier, isHealthy: true, checkedAt: new Date() });

interface OutboundChunk {
  readonly bytes: number;
  readonly state: string;
  readonly atMs: number;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  readonly transitions: Array<{ readonly from: string; readonly to: string; readonly reason?: string | undefined }>;
  readonly outbound: OutboundChunk[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: { readonly replies: readonly string[]; readonly synthDelayMs?: number }): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const transitions: Array<{ readonly from: string; readonly to: string; readonly reason?: string | undefined }> = [];
  const outbound: OutboundChunk[] = [];
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
      await sleep(10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield { type: "final" as const, turn: { role: "assistant" as const, content: reply, timestamp: new Date() }, latencyMs: 1 };
    },
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      if (input.synthDelayMs) await sleep(input.synthDelayMs);
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
    "backchannel-test" as SessionId,
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
        openingLine: "Hi Sakshi, this is Rohan from Team FlexiFunnels.",
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );

  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  // The transport: records every chunk with the session state at the
  // moment it was handed over, which is how a cue in LISTENING is told
  // apart from a reply in SPEAKING.
  record.outboundAudioListeners.add((chunk) => {
    outbound.push({ bytes: chunk.data.byteLength, state: record.state, atMs: Date.now() });
  });

  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState], reason?: string) => {
      transitions.push({ from: r.state, to, reason });
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const push = (text: string, isFinal: boolean, isSpeechFinal: boolean): void => {
    const startedAtMs = clockMs;
    clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
    segments.push({ text, isFinal, isSpeechFinal, confidence: 0.95, language: SupportedLanguage.ENGLISH, startedAtMs, endedAtMs: clockMs });
    waiters.shift()?.();
  };

  return {
    record,
    requests,
    synthesized,
    transitions,
    outbound,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      push(text, isFinal, opts?.isSpeechFinal ?? isFinal);
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

const CUE_TEXTS = new Set(["Mm-hmm.", "Hmm.", "Right.", "Yeah."]);
const isCue = (text: string) => CUE_TEXTS.has(text);

/** Wait for the greeting to finish and the loop to be idle in LISTENING. */
async function ready(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  await sleep(150);
}

/** A caller mid-thought: long, and ending on a dangling conjunction. */
const LONG_MID_THOUGHT = "I have been running a small clothing shop in Pune for about two years now and";

// ═════════════════════════════════════════════════════════════════
section("A. A LONG MID-THOUGHT PAUSE GETS ONE LIGHTWEIGHT CUE, IN LISTENING");

await test("A1. the cue is synthesised and handed to the transport while the session is still LISTENING", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("a cue to be synthesised", () => h.synthesized.some(isCue), CUE_WAIT_MS);
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, 1_500);
    const cueChunk = h.outbound[outboundBefore]!;
    assert.equal(cueChunk.state, SessionState.LISTENING, "the cue must be played without leaving LISTENING");
    assert.ok(cueChunk.bytes > 0 && cueChunk.bytes <= 8000 * 1.5, `a cue is a short clip: ${cueChunk.bytes} bytes`);
    // The turn is still released afterwards and answered normally.
    await h.waitForReplies(2, 8_000);
  } finally {
    await h.stop();
  }
});

await test("A2. the cue lands in the caller's breath — before the turn is released, never as a release", async () => {
  // An endpointed final whose text reads unfinished IS the breath at a
  // comma (the provider measured ~400ms of silence to endpoint it), so
  // the cue is consulted on arrival rather than after the silence
  // window. The detector still holds the text for the full window.
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, CUE_WAIT_MS + 1_000);
    assert.equal(h.outbound[outboundBefore]!.state, SessionState.LISTENING);
    // No language-model request exists yet: the turn has not been released.
    assert.equal(h.requests.length, 0, "the cue precedes the release, so no request has been made yet");
    assert.equal(h.record.turnDetector.getPendingTurnText(), LONG_MID_THOUGHT, "the detector is still holding the caller's text");
    await h.waitForReplies(2, 8_000);
    assert.ok(h.requests.length >= 1, "...and the turn is still released and answered afterwards, by the detector alone");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. THE CUE IS NOT AN ASSISTANT TURN");

await test("B1. the cue is never committed to memory and never shown to the language model", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("a cue to be synthesised", () => h.synthesized.some(isCue), CUE_WAIT_MS);
    await h.waitForReplies(2, 8_000);
    const assistantTurns = h.history().filter((t) => t.role === "assistant").map((t) => t.content);
    assert.equal(assistantTurns.length, 2, "greeting + one reply, and nothing else");
    assert.ok(assistantTurns.every((t) => !isCue(t)), `no cue in history: ${JSON.stringify(assistantTurns)}`);
    for (const request of h.requests) {
      assert.ok(request.every((t) => !isCue(t.content)), "no cue in any language-model history");
    }
    // Exactly one language-model request: for the caller's turn.
    assert.equal(h.requests.length, 1, "the cue itself made no request");
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [LONG_MID_THOUGHT], "the caller's turn reached the model whole");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. THE CUE DOES NOT INTERRUPT OR BARGE IN");

await test("C1. no SPEAKING transition and no barge-in is caused by the cue", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const transitionsBefore = h.transitions.length;
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("a cue to be synthesised", () => h.synthesized.some(isCue), CUE_WAIT_MS);
    await sleep(200);
    // Between the caller's segment and the turn's release nothing may
    // have moved the state machine: the cue is not a reply.
    const during = h.transitions.slice(transitionsBefore);
    assert.equal(during.length, 0, `no transition may be caused by a cue: ${JSON.stringify(during)}`);
    assert.ok(h.transitions.every((t) => !/barge.?in/i.test(t.reason ?? "")), "no barge-in anywhere");
    await h.waitForReplies(2, 8_000);
  } finally {
    await h.stop();
  }
});

await test("C2. the caller resuming after the cue extends the SAME turn — nothing is lost, nothing is answered early", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("a cue to be synthesised", () => h.synthesized.some(isCue), CUE_WAIT_MS);
    // They carry on, inside the grace the detector is still holding.
    h.say("I want to start selling online as well.", { isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    assert.equal(h.requests.length, 1, "one turn, one request");
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [`${LONG_MID_THOUGHT} I want to start selling online as well.`]);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("D. SHORT UTTERANCES AND REQUESTS FOR A MOMENT NEVER DRAW A CUE; THE CAP HOLDS");

await test("D1. a short mid-thought pause draws no cue", async () => {
  // Four words ending on a dangling word: the detector holds it exactly
  // as it holds a long one, but a cue into a four-word pause is a
  // nudge, not a listener — the word floor is what keeps it out.
  const short = startHarness({ replies: ["Sure."] });
  try {
    await ready(short);
    short.say("Actually I wanted to", { isSpeechFinal: true });
    await short.waitForReplies(2, 8_000);
    assert.ok(!short.synthesized.some(isCue), `a four-word pause must draw no cue: ${JSON.stringify(short.synthesized)}`);
  } finally {
    await short.stop();
  }
});

await test("D2. a short complete answer draws no cue and is answered at once", async () => {
  const h = startHarness({ replies: ["Perfect."] });
  try {
    await ready(h);
    h.say("Yes.", { isSpeechFinal: true });
    await h.waitForReplies(2, 5_000);
    assert.ok(!h.synthesized.some(isCue), "no cue for a short answer");
    assert.equal(h.requests.length, 1);
  } finally {
    await h.stop();
  }
});

await test("D3. 'wait, one second' is answered with silence, never with 'okay'", async () => {
  const h = startHarness({ replies: ["Sure."] });
  try {
    await ready(h);
    h.say("Wait a second", { isSpeechFinal: true });
    await sleep(SILENCE_WINDOW_MS + 1_400);
    assert.ok(!h.synthesized.some(isCue), `a request for a moment must draw no cue: ${JSON.stringify(h.synthesized)}`);
  } finally {
    await h.stop();
  }
});

await test("D4. at most two cues into one turn, however long the caller keeps pausing", async () => {
  // The detector grants at most two continuation graces per turn, so a
  // caller who pauses and never resumes can draw at most two holds —
  // and the cue gap of 6s means only ONE of them is ever a cue. The cap
  // is asserted through the pipeline, not assumed from the detector.
  const h = startHarness({ replies: ["Great."] });
  try {
    await ready(h);
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitForReplies(2, 10_000);
    const cues = h.synthesized.filter(isCue);
    assert.ok(cues.length >= 1 && cues.length <= 2, `1-2 cues per turn, saw ${cues.length}`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. OUR OWN CUE COMING BACK UP THE INBOUND TRACK IS DROPPED");

await test("E1. a bare 'Hmm.' arriving right after a cue is not fed to the turn detector", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, CUE_WAIT_MS + 1_000);
    // The echo, as Deepgram would transcribe it, 300ms later.
    await sleep(300);
    h.say("Hmm.", { isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [LONG_MID_THOUGHT], `the echo must not enter the caller's turn: ${JSON.stringify(userTurns)}`);
  } finally {
    await h.stop();
  }
});

await test("E2. a caller's genuine continuation in the same window is NOT dropped", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    h.say(LONG_MID_THOUGHT, { isSpeechFinal: true });
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, CUE_WAIT_MS + 1_000);
    await sleep(300);
    h.say("I want to sell online too.", { isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [`${LONG_MID_THOUGHT} I want to sell online too.`]);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("G. A CONTINUOUS LONG SENTENCE — NO 1.1s PAUSE — STILL GETS ONE AUDIBLE CUE");

/** A long answer as Deepgram delivers it: chunk-boundary finals, no endpoint until the end. */
const CHUNKS = [
  "I have been running a small clothing shop",
  "in Pune for about two years now",
  "and mostly I sell to people in my own area",
  "but now I want to start selling online as well.",
];

await test("G1. chunk-boundary finals from a caller who never pauses produce one cue, sent to the outbound path in LISTENING, before the turn is released", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    // No gap here ever reaches the silence window: the hold trigger cannot fire.
    for (let i = 0; i < CHUNKS.length - 1; i += 1) {
      h.say(CHUNKS[i]!, { isFinal: true, isSpeechFinal: false });
      await sleep(350);
    }
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, 1_500);
    const cue = h.outbound[outboundBefore]!;
    assert.equal(cue.state, SessionState.LISTENING, "played without leaving LISTENING");
    assert.ok(cue.bytes > 0 && cue.bytes <= 8000 * 1.5, `a short clip: ${cue.bytes} bytes`);
    assert.equal(h.requests.length, 0, "no language-model request yet — the turn is still the caller's");
    assert.equal(h.history().filter((t) => t.role === "assistant").length, 1, "greeting only — the cue is not an assistant turn");
    // The caller finishes; the whole sentence is one turn, answered once.
    h.say(CHUNKS[CHUNKS.length - 1]!, { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    assert.equal(h.requests.length, 1);
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [CHUNKS.join(" ")], "nothing the caller said was lost or split");
    assert.ok(h.transitions.every((t) => !/barge.?in/i.test(t.reason ?? "")), "no barge-in");
  } finally {
    await h.stop();
  }
});

await test("G2. the cooldown holds — many chunk boundaries inside 6s are still ONE cue", async () => {
  const h = startHarness({ replies: ["Great."] });
  try {
    await ready(h);
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < CHUNKS.length - 1; i += 1) {
        h.say(CHUNKS[i]!, { isFinal: true, isSpeechFinal: false });
        await sleep(300);
      }
    }
    await sleep(400);
    assert.equal(h.synthesized.filter(isCue).length, 1, `one cue inside the cooldown, saw ${h.synthesized.filter(isCue).length}`);
    h.say(CHUNKS[CHUNKS.length - 1]!, { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
  } finally {
    await h.stop();
  }
});

await test("G3. short chunk-boundary finals draw no cue — the word floor still holds", async () => {
  const h = startHarness({ replies: ["Sure."] });
  try {
    await ready(h);
    h.say("I think", { isFinal: true, isSpeechFinal: false });
    await sleep(300);
    h.say("maybe on Sunday.", { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    assert.ok(!h.synthesized.some(isCue), `a six-word turn must draw no cue: ${JSON.stringify(h.synthesized)}`);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("G4-G11. A GENUINELY LONG UTTERANCE GETS SEVERAL SPARSE CUES AT ITS BREATH POINTS");

/** The reported utterance, as a caller actually delivers it: breath at the commas, chunks between. */
const LONG_UTTERANCE: ReadonlyArray<{ text: string; isSpeechFinal: boolean }> = [
  { text: "Yes, actually I'm interested in the event because I've been working on my business for quite some time now,", isSpeechFinal: true },
  { text: "but honestly I've been struggling to understand", isSpeechFinal: false },
  { text: "how I can use AI properly in my daily work,", isSpeechFinal: true },
  { text: "because there are so many different tools available", isSpeechFinal: false },
  // Reads as a complete clause, so a real breath here would (correctly)
  // release the turn — the caller runs straight on instead.
  { text: "and I'm not really sure", isSpeechFinal: false },
  { text: "which ones would actually be useful", isSpeechFinal: false },
  { text: "for my business and", isSpeechFinal: true },
  { text: "for the people I work with as well.", isSpeechFinal: true },
];
/** A realistic breath between clauses: well under the detector's release path (~3s after an unfinished endpoint). */
const BREATH_MS = 1_300;
const MAX_PER_TURN = 3;
const MIN_GAP_MS = 3_500;

async function driveLongUtterance(h: Harness): Promise<{ cues: OutboundChunk[]; requestsBeforeRelease: number }> {
  const outboundBefore = h.outbound.length;
  for (let i = 0; i < LONG_UTTERANCE.length - 1; i += 1) {
    h.say(LONG_UTTERANCE[i]!.text, { isFinal: true, isSpeechFinal: LONG_UTTERANCE[i]!.isSpeechFinal });
    await sleep(BREATH_MS);
  }
  const requestsBeforeRelease = h.requests.length;
  h.say(LONG_UTTERANCE[LONG_UTTERANCE.length - 1]!.text, { isFinal: true, isSpeechFinal: true });
  await h.waitForReplies(2, 10_000);
  return { cues: h.outbound.slice(outboundBefore).filter((c) => c.state === SessionState.LISTENING), requestsBeforeRelease };
}

await test("G4. a genuinely long multi-segment utterance with breath points produces MORE THAN ONE cue", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const { cues } = await driveLongUtterance(h);
    assert.ok(cues.length >= 2, `a ~65-word answer with breath points must draw more than one cue, saw ${cues.length}`);
    assert.ok(cues.length <= MAX_PER_TURN, `...and never more than ${MAX_PER_TURN}, saw ${cues.length}`);
  } finally {
    await h.stop();
  }
});

await test("G5. cues stay spaced — never inside the gap floor, and each one after fresh speech", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const { cues } = await driveLongUtterance(h);
    assert.ok(cues.length >= 2, `need at least two cues to measure spacing, saw ${cues.length}`);
    for (let i = 1; i < cues.length; i += 1) {
      const gap = cues[i]!.atMs - cues[i - 1]!.atMs;
      assert.ok(gap >= MIN_GAP_MS - 150, `cue ${i + 1} landed ${gap}ms after cue ${i}; the floor is ${MIN_GAP_MS}ms`);
    }
    // Rotation: no two consecutive cues are the same word.
    const spoken = h.synthesized.filter(isCue);
    for (let i = 1; i < spoken.length; i += 1) assert.notEqual(spoken[i], spoken[i - 1], "no mm-hmm... mm-hmm... pattern");
  } finally {
    await h.stop();
  }
});

await test("G6. every cue is played while the session is still LISTENING — no SPEAKING transition, no barge-in", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const transitionsBefore = h.transitions.length;
    const outboundBefore = h.outbound.length;
    for (let i = 0; i < LONG_UTTERANCE.length - 1; i += 1) {
      h.say(LONG_UTTERANCE[i]!.text, { isFinal: true, isSpeechFinal: LONG_UTTERANCE[i]!.isSpeechFinal });
      await sleep(BREATH_MS);
    }
    const during = h.outbound.slice(outboundBefore);
    assert.ok(during.length >= 2, `cues were played during the utterance, saw ${during.length}`);
    assert.ok(during.every((c) => c.state === SessionState.LISTENING), "every cue in LISTENING");
    assert.equal(h.transitions.length, transitionsBefore, `no state transition during the caller's utterance: ${JSON.stringify(h.transitions.slice(transitionsBefore))}`);
    assert.ok(h.transitions.every((t) => !/barge.?in/i.test(t.reason ?? "")), "no barge-in");
    h.say(LONG_UTTERANCE[LONG_UTTERANCE.length - 1]!.text, { isFinal: true, isSpeechFinal: true });
    await h.waitForReplies(2, 10_000);
  } finally {
    await h.stop();
  }
});

await test("G7. no cue releases the turn — the whole utterance is ONE turn, released by the detector at the end", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const { cues, requestsBeforeRelease } = await driveLongUtterance(h);
    assert.ok(cues.length >= 2);
    assert.equal(requestsBeforeRelease, 0, "nothing was released while the caller was talking");
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [LONG_UTTERANCE.map((s) => s.text).join(" ")], "one turn, every word kept, in order");
  } finally {
    await h.stop();
  }
});

await test("G8. no language-model request is caused by a cue — exactly one request, for the turn", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const { cues } = await driveLongUtterance(h);
    assert.ok(cues.length >= 2);
    assert.equal(h.requests.length, 1, "one request: the caller's completed turn");
    const assistantTurns = h.history().filter((t) => t.role === "assistant").map((t) => t.content);
    assert.equal(assistantTurns.length, 2, "greeting + one reply — no cue in history");
    assert.ok(assistantTurns.every((t) => !isCue(t)));
  } finally {
    await h.stop();
  }
});

await test("G9. short and medium utterances still draw nothing, or at most one where the caller is plainly continuing", async () => {
  for (const line of ["Yes.", "Okay.", "Yeah.", "Actually yes, I am interested."]) {
    const h = startHarness({ replies: ["Perfect."] });
    try {
      await ready(h);
      h.say(line, { isSpeechFinal: true });
      await h.waitForReplies(2, 5_000);
      assert.equal(h.synthesized.filter(isCue).length, 0, `"${line}" must draw no cue`);
    } finally {
      await h.stop();
    }
  }
  // A complete medium sentence, endpointed: the caller is done, so it is
  // not even consulted.
  const done = startHarness({ replies: ["Perfect."] });
  try {
    await ready(done);
    done.say("Yes, I would like to join the session on Sunday morning please.", { isSpeechFinal: true });
    await done.waitForReplies(2, 5_000);
    assert.equal(done.synthesized.filter(isCue).length, 0, "a finished medium answer draws no cue");
  } finally {
    await done.stop();
  }
  // A medium sentence that pauses at a comma and continues: one cue at most.
  const continuing = startHarness({ replies: ["Perfect."] });
  try {
    await ready(continuing);
    continuing.say("Yes, I would like to join the session on Sunday,", { isSpeechFinal: true });
    await sleep(BREATH_MS);
    continuing.say("if it is really free.", { isSpeechFinal: true });
    await continuing.waitForReplies(2, 8_000);
    assert.ok(continuing.synthesized.filter(isCue).length <= 1, "a normal sentence never gets several acknowledgements");
  } finally {
    await continuing.stop();
  }
});

await test("G10. echo protection still holds on the new trigger — our own 'Hmm.' after a breath-point cue is dropped", async () => {
  const h = startHarness({ replies: ["Great, that sounds like a good fit."] });
  try {
    await ready(h);
    const outboundBefore = h.outbound.length;
    h.say(LONG_UTTERANCE[0]!.text, { isSpeechFinal: true });
    await h.waitFor("the cue to reach the transport", () => h.outbound.length > outboundBefore, 2_000);
    await sleep(300);
    h.say("Hmm.", { isSpeechFinal: true });
    await sleep(200);
    h.say("but honestly I have been struggling with the tools.", { isSpeechFinal: true });
    await h.waitForReplies(2, 8_000);
    const userTurns = h.history().filter((t) => t.role === "user").map((t) => t.content);
    assert.deepEqual(userTurns, [`${LONG_UTTERANCE[0]!.text} but honestly I have been struggling with the tools.`], `the echo must not enter the turn: ${JSON.stringify(userTurns)}`);
  } finally {
    await h.stop();
  }
});

await test("G11. barge-in is unchanged — a caller talking over the reply still interrupts it, and no cue is played in SPEAKING", async () => {
  const longReply =
    "That is really good to hear, and it is exactly the kind of situation this event is built for, because we walk through the tools one at a time and show where each one fits into a normal working day.";
  const h = startHarness({ replies: [longReply, "Sure, go ahead."] });
  try {
    await ready(h);
    h.say(LONG_UTTERANCE[0]!.text, { isSpeechFinal: true });
    await h.waitFor("the reply to start playing", () => h.record.state === SessionState.SPEAKING, 8_000);
    await sleep(400);
    const outboundBefore = h.outbound.length;
    h.say("Wait, I have a question about the price.", { isSpeechFinal: true });
    await h.waitFor("the barge-in", () => h.transitions.some((t) => /barge.?in/i.test(t.reason ?? "")), 3_000);
    assert.ok(h.outbound.slice(outboundBefore).every((c) => c.state !== SessionState.LISTENING), "no cue was played around the interruption");
    await h.waitForReplies(3, 10_000);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("F. THE VOCABULARY");

const LANGS = [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH] as const;
const ctx = (
  freshText: string,
  lastCue: string | null = null,
  previousOpportunitySilent = false,
  language: (typeof LANGS)[number] = SupportedLanguage.ENGLISH,
) => selectBackchannelCue({ language, freshText, lastCue, previousOpportunitySilent });

await test("F1. every cue is one or two words, asks nothing, and is never the same word as the last cue", () => {
  const texts = [
    "and then I went to the shop and bought some cloth",
    "because the tools are all different and I do not know",
    "honestly I have been struggling with this for months",
    "so first I tried one tool and then another one after that",
    "mostly I sell to people in my own area and nearby",
  ];
  for (const language of LANGS) {
    for (const lastCue of [null, "Mm-hmm.", "Hmm.", "Right.", "Yeah.", "Achha.", "Sahi.", "हम्म।", "सही।"]) {
      for (const text of texts) {
        const cue = ctx(text, lastCue, false, language);
        if (cue === null) continue;
        assert.ok(cue.split(/\s+/).length <= 2, `${language}: a cue is one or two words: "${cue}"`);
        assert.ok(!cue.includes("?"), "a cue never asks anything");
        assert.notEqual(cue, lastCue, `${language}: "${cue}" must not repeat the last cue`);
      }
    }
  }
});

await test("F2. no cue is a committal word, in any language", () => {
  const committal = /\b(yes|correct|exactly|sure|true|absolutely|haan|bilkul|ji haan)\b/iu;
  for (const language of LANGS) {
    for (const text of ["and then", "because of that", "honestly I have been", "I think it is really hard and"]) {
      for (const lastCue of [null, "Right.", "Hmm."]) {
        const cue = ctx(text, lastCue, false, language);
        if (cue !== null) assert.ok(!committal.test(cue), `${language}: "${cue}" can be heard as agreeing with a proposition`);
      }
    }
  }
});

// ═════════════════════════════════════════════════════════════════
section("H. WHICH CUE — CONTEXT DECIDES, NOT A COUNTER");

const PLAIN = [
  "and then I went to the market with my brother to look at",
  "mostly I sell to the people who live near my shop and",
  "so on most days I open the shop around ten in the morning and",
  "we have a small place near the station where the customers come and",
];
const POINT = [
  "because there are so many different tools available and",
  "the problem is that none of them work with my accounts and",
  "first of all I tried one of them and then another one after that and",
  "which means I have to do everything twice every single day and",
];
const RECOGNITION = [
  "honestly I have been struggling to understand how to use AI properly and",
  "I think it is really hard to know which of these would actually help and",
  "I am interested in the event and I have been looking for something like this and",
  "in my experience most of these things are really difficult to set up and",
];

/** Walk a sequence of opportunities the way the pipeline does: last cue and silence carried forward. */
function walk(segments: readonly string[]): (string | null)[] {
  let last: string | null = null;
  let silent = false;
  const out: (string | null)[] = [];
  for (const seg of segments) {
    const cue = ctx(seg, last, silent);
    out.push(cue);
    if (cue === null) silent = true;
    else {
      last = cue;
      silent = false;
    }
  }
  return out;
}

await test("H1. there is no fixed sequence — the same opportunity index yields different cues for different words", () => {
  // First opportunity of a turn, three different callers: three different classes.
  assert.deepEqual([ctx(PLAIN[0]!), ctx(POINT[0]!), ctx(RECOGNITION[0]!)], ["Mm-hmm.", "Right.", "Yeah."]);
  // The old rotation's second/third slots are not slots at all: a
  // second opportunity after "Mm-hmm." is decided by its own words.
  assert.equal(ctx(POINT[1]!, "Mm-hmm."), "Right.");
  assert.equal(ctx(RECOGNITION[1]!, "Mm-hmm."), "Yeah.");
  assert.equal(ctx(PLAIN[1]!, "Mm-hmm."), null, "a plain continuation right after a plain acknowledgement is left silent");
  // Long utterances with different content produce different cue sequences.
  const a = walk([PLAIN[0]!, POINT[0]!, RECOGNITION[0]!]);
  const b = walk([RECOGNITION[1]!, PLAIN[1]!, POINT[1]!]);
  const c = walk([PLAIN[2]!, PLAIN[3]!, PLAIN[0]!]);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(b, c);
  assert.ok(c.includes(null), "a run of plain continuations includes silence");
});

await test("H2. ordinary continuation selects the listening cue (Mm-hmm / Hmm) on a first opportunity", () => {
  for (const text of PLAIN) {
    assert.ok(["Mm-hmm.", "Hmm."].includes(ctx(text) ?? ""), `"${text}" -> ${ctx(text)}`);
  }
  assert.ok(["Hmm.", "Achha."].includes(ctx("aur phir main dukaan par gaya aur wahan", null, false, SupportedLanguage.HINGLISH) ?? ""));
  assert.ok(["हम्म।", "अच्छा।"].includes(ctx("और फिर मैं दुकान पर गया और वहाँ पर", null, false, SupportedLanguage.HINDI) ?? ""));
});

await test("H3. explanatory / point-making language selects 'Right', and never right after 'Right'", () => {
  for (const text of POINT) {
    assert.equal(ctx(text), "Right.", `"${text}"`);
    assert.equal(ctx(text, "Mm-hmm."), "Right.");
    assert.notEqual(ctx(text, "Right."), "Right.", "never Right twice running");
  }
  assert.equal(ctx("kyunki mere paas time nahi hai aur", null, false, SupportedLanguage.HINGLISH), "Sahi.");
  assert.equal(ctx("क्योंकि मेरे पास समय नहीं है और", null, false, SupportedLanguage.HINDI), "सही।");
});

await test("H4. recognition language selects 'Yeah' conservatively — English only, never twice running, never for plain text", () => {
  for (const text of RECOGNITION) {
    assert.equal(ctx(text), "Yeah.", `"${text}"`);
    assert.notEqual(ctx(text, "Yeah."), "Yeah.", "never Yeah twice running");
  }
  for (const text of PLAIN) assert.notEqual(ctx(text), "Yeah.", `plain text must not draw Yeah: "${text}"`);
  // Hindi / Hinglish: the recognition class falls back to a non-committal cue.
  for (const language of [SupportedLanguage.HINDI, SupportedLanguage.HINGLISH]) {
    for (const text of RECOGNITION) {
      const cue = ctx(text, null, false, language);
      assert.ok(cue === null || !/yeah|haan|हाँ/iu.test(cue), `${language}: "${cue}"`);
    }
  }
});

await test("H5. silence is a real outcome, and never the first opportunity of a turn", () => {
  // Plain after plain, no silence yet: silent.
  assert.equal(ctx(PLAIN[0]!, "Mm-hmm."), null);
  assert.equal(ctx(PLAIN[0]!, "Hmm."), null);
  // Plain after plain, but the previous opportunity was already silent: speak, alternating the word.
  assert.equal(ctx(PLAIN[0]!, "Mm-hmm.", true), "Hmm.");
  assert.equal(ctx(PLAIN[0]!, "Hmm.", true), "Mm-hmm.");
  // A first opportunity is never silent, whatever the words.
  for (const text of [...PLAIN, ...POINT, ...RECOGNITION]) assert.notEqual(ctx(text), null, `first opportunity: "${text}"`);
  // The content hash leaves some plain opportunities silent even after a non-plain cue.
  const afterRight = PLAIN.concat([
    "and my cousin also has a shop in the next town where they",
    "and the customers usually come in the evening after work when",
    "and on Sundays we keep the shop closed so that the family can",
    "and the supplier sends the cloth every second week from Surat and",
    "and we also keep some ready-made items for the festival season when",
    "and my wife helps with the accounts in the evening after the",
  ]).map((t) => ctx(t, "Right."));
  assert.ok(afterRight.includes(null), `some plain opportunities after "Right." must be silent: ${JSON.stringify(afterRight)}`);
  assert.ok(afterRight.some((c) => c !== null), "...and not all of them");
});

await test("H6. the same cue is never mechanically repeated at every opportunity", () => {
  const out = walk([...PLAIN, ...PLAIN, ...PLAIN]);
  const spoken = out.filter((c): c is string => c !== null);
  assert.ok(spoken.length >= 2);
  assert.ok(spoken.length < out.length, "not every opportunity was acknowledged");
  for (let i = 1; i < spoken.length; i += 1) assert.notEqual(spoken[i], spoken[i - 1], "no word twice running");
});

console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. Telephony, Deepgram, the LLM, the TTS vendors and Google were not contacted.");
process.exit(failures.length === 0 ? 0 : 1);
