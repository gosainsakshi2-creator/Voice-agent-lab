/**
 * ending-transition-tests.ts — `npm run test:ending`
 *
 * H5: A HANGUP WHILE THE MODEL IS STILL GENERATING MUST NOT BECOME A
 * PIPELINE FAILURE.
 *
 * The session ends — the caller hangs up, or the pipeline's own
 * `host.end` fires on voicemail — while an LLM stream is still being
 * awaited. `end()` aborts the loop controller and moves the session to
 * ENDING. The generation then resolves, the reply's tail reaches
 * `enterSpeaking()`, and the state table has no ENDING -> SPEAKING edge:
 * the transition throws, the main loop reports it through `markError`,
 * the session observer reports "errored", and `call-runner.ts` finalizes
 * the attempt TEMPORARY — which `retry-planner.ts` then REDIALS. A
 * person who hung up gets called back because of a teardown race.
 *
 * WHAT THESE TESTS NEED THAT THE OTHER HARNESSES DO NOT. Every other
 * suite in this directory uses a fake host whose `transition` just
 * assigns the state, so an invalid transition is invisible to it. The
 * host here is the real rule: `SESSION_STATE_TRANSITIONS`, the same
 * table `VoiceSessionManagerImpl.canTransition` reads, and it throws on
 * anything the table does not allow — exactly as the manager does.
 *
 * And the ending is the real one, in the real order:
 * `VoiceSessionManagerImpl.end()` triggers the barge-in, aborts the loop
 * controller, and only THEN transitions to ENDING. That order is what
 * makes the abort flag a sound signal for "this session is ending".
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET OR CONTACTS A VENDOR.
 * Every provider is a local fake; the pipeline, the turn detector and
 * the conversation memory are the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SESSION_STATE_TRANSITIONS } = await import("../../constants/session-states.constants");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, TranscriptSegment } from "../../types/provider.types";
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

const section = (t: string): void => console.log(`\n${t}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ~22 chars/second is ordinary speech; one MULAW byte is one sample at 8kHz. */
const CHARS_PER_SECOND = 22;
const clipFor = (text: string): AudioPayload => ({
  data: new Uint8Array(Math.round(Math.max(0.05, text.length / CHARS_PER_SECOND) * 8000)),
  encoding: "MULAW",
  sampleRateHz: 8000,
});

const descriptor = (category: unknown, id: string): unknown => ({
  category,
  id,
  displayName: id,
  supportedLanguages: [SupportedLanguage.ENGLISH],
  version: "fake",
});
const healthy = (identifier: unknown): unknown => ({ identifier, isHealthy: true, checkedAt: new Date() });

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
/**
 * Deliberately ONE sentence with no internal full stop, so the chunker
 * reaches no sentence boundary while it is streaming and the WHOLE
 * reply arrives at the remainder path after `chunker.flush()` — which
 * is the `enterSpeaking()` call site the audit named.
 */
const REPLY = "The workshop is tomorrow at eleven in the morning and it runs for about ninety minutes";

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  /** Every `transition` the pipeline asked for that the table REFUSED. */
  readonly refusedTransitions: string[];
  /** Every `markError` the pipeline filed — a non-empty list is the TEMPORARY redial. */
  readonly errors: unknown[];
  /** Resolves the in-flight fake generation. */
  releaseGeneration(): void;
  /** True once the fake LLM is inside its await, i.e. the model is generating. */
  generating(): boolean;
  say(text: string): void;
  /** The manager's own `end()`, in its own order. */
  endLikeTheManager(): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

function startHarness(opts: { readonly onEndFromPipeline?: () => void } = {}): Harness {
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  const refusedTransitions: string[] = [];
  const errors: unknown[] = [];
  let closed = false;
  let clockMs = 0;
  let isGenerating = false;
  let release: (() => void) | undefined;
  const generationGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy({}),
    transcribeStream: async function* () {
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
    checkHealth: async () => healthy({}),
    generateCompletionStream: async function* (request: { history: readonly { role: string }[] }) {
      // The prefix-cache priming request (system turn only) must not be
      // the one the test drives — it is fired and forgotten at startup.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      // The text FIRST, and it reaches no sentence boundary, so the
      // chunker holds all of it and nothing has been spoken yet. That
      // is the audit's stated precondition for H5: a partial remainder
      // in hand when the session ends, which `chunker.flush()` then
      // hands to the reply's last `enterSpeaking()`.
      yield { type: "token" as const, delta: REPLY, index: 0 };
      isGenerating = true;
      // THE AWAIT BOUNDARY. The session ends while the pipeline is
      // sitting here, exactly as it does when a real provider is still
      // streaming.
      await generationGate;
      isGenerating = false;
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: REPLY, timestamp: new Date() },
        latencyMs: 1,
      };
    },
  };

  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => clipFor(task.request.text),
    checkHealth: async () => healthy({}),
  };

  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy({}),
  };

  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
  };

  const record = new SessionRecord(
    "ending-transition-test" as SessionId,
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
        openingLine: OPENING,
        systemPromptAppendix: "TEST APPENDIX",
      },
    } as never,
    stack as never,
  );
  record.loopAbortController = new AbortController();
  // The manager hands the pipeline a session that is already LISTENING
  // (see `voice-session-manager.impl.ts`), which is what makes the
  // greeting's LISTENING -> THINKING transition legal.
  record.state = SessionState.LISTENING;
  record.outboundAudioListeners.add(() => undefined);

  // ── THE REAL RULE, NOT A FAKE ONE ────────────────────────────────
  // `VoiceSessionManagerImpl.transition` throws on anything
  // `SESSION_STATE_TRANSITIONS` does not allow. Every other harness in
  // this directory assigns the state instead, which is why none of them
  // can see this defect.
  const host = {
    transition: (r: { state: string }, to: string, reason?: string) => {
      const allowed = SESSION_STATE_TRANSITIONS[r.state as keyof typeof SESSION_STATE_TRANSITIONS];
      if (!allowed || !allowed.includes(to as never)) {
        refusedTransitions.push(`${r.state} -> ${to} (${reason ?? "none"})`);
        throw new Error(`INVALID TRANSITION: ${r.state} -> ${to}`);
      }
      r.state = to;
    },
    markError: (_r: unknown, _source: string, error: unknown) => {
      errors.push(error);
    },
    end: async () => {
      opts.onEndFromPipeline?.();
    },
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const endLikeTheManager = (): void => {
    // The three steps of `VoiceSessionManagerImpl.end()`, in its order:
    // the abort flag is raised BEFORE the ENDING transition, which is
    // what any guard inside the pipeline can rely on.
    record.bargeIn.triggerBargeIn();
    record.loopAbortController?.abort();
    if (record.state !== SessionState.ENDING) {
      try {
        host.transition(record as never, SessionState.ENDING, "ending the call");
      } catch {
        // A session already in a terminal state — the manager tolerates
        // this too.
      }
    }
  };

  return {
    record,
    refusedTransitions,
    errors,
    releaseGeneration: () => release?.(),
    generating: () => isGenerating,
    say(text: string) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({
        text,
        isFinal: true,
        isSpeechFinal: true,
        confidence: 0.95,
        language: SupportedLanguage.ENGLISH,
        startedAtMs,
        endedAtMs: clockMs,
      } as never);
      waiters.shift()?.();
    },
    endLikeTheManager,
    async waitFor(what, predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async stop() {
      closed = true;
      release?.();
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(800)]).catch(() => undefined);
    },
  };
}

/** The greeting has been spoken and the agent is waiting to be spoken to. */
async function greetingDone(h: Harness): Promise<void> {
  await h.waitFor(
    "the greeting to finish",
    () => h.record.memory.history().some((t) => t.role === "assistant") && h.record.state === SessionState.LISTENING,
  );
}

// ═════════════════════════════════════════════════════════════════
section("A. A HANGUP DURING GENERATION IS AN ENDING, NOT A FAILURE");
// ═════════════════════════════════════════════════════════════════

await test("A1. the caller hangs up while the model is generating: no ENDING -> SPEAKING, and no pipeline error is filed", async () => {
  const h = startHarness();
  try {
    await greetingDone(h);

    h.say("Yes, tell me about it.");
    await h.waitFor("the model to start generating", () => h.generating());

    // The caller hangs up. The bridge closes, the manager's `end()`
    // runs, and the session is ENDING before the stream resolves.
    h.endLikeTheManager();
    assert.equal(h.record.state, SessionState.ENDING, "premise: the session is ending");

    // ...and only now does the provider finish.
    h.releaseGeneration();
    await sleep(600);

    assert.deepEqual(
      h.refusedTransitions,
      [],
      `nothing may be transitioned out of ENDING: ${JSON.stringify(h.refusedTransitions)}`,
    );
    assert.equal(h.record.state, SessionState.ENDING, "the session stays ENDING");
    assert.deepEqual(
      h.errors.map((e) => (e instanceof Error ? e.message : String(e))),
      [],
      "no pipeline error is filed — a filed error is the TEMPORARY redial",
    );
  } finally {
    await h.stop();
  }
});

await test("A2. VOICEMAIL — the pipeline's OWN host.end route also ends cleanly and files no error", async () => {
  // The audit named `host.end` as the second way into this lifecycle:
  // a machine answers, the marker lands while this turn's reply is
  // still being generated, `hangUpOnVoicemail` calls `host.end`, and
  // the manager's three steps run — leaving the session ENDING with the
  // generation in flight.
  //
  // MEASURED, AND HONEST ABOUT IT: this one passes with the guard and
  // without it, so it is a regression net rather than a reproduction.
  // The voicemail utterance is contentful, so it takes the floor and
  // supersedes the reply before `chunker.flush()` can hand a remainder
  // to `enterSpeaking()` — the throw site A1 reaches is skipped on this
  // route. What it does pin is that the route ends the call without
  // filing a pipeline error, which is the outcome that matters: a filed
  // error is the TEMPORARY redial, and a machine must never be dialled
  // back because of one.
  let ended = 0;
  let harness: Harness | undefined;
  const h = startHarness({
    onEndFromPipeline: () => {
      ended += 1;
      harness?.endLikeTheManager();
    },
  });
  harness = h;
  try {
    await greetingDone(h);

    h.say("Yes, tell me about it.");
    await h.waitFor("the model to start generating", () => h.generating());

    // A machine, not a person. `VOICEMAIL_MARKERS` carries both of
    // these phrases, and `turnIndex` is still 0 with the detection
    // window wide open, so the live gate fires.
    h.say("Please leave a message after the tone.");
    await h.waitFor("the pipeline to end its own call", () => ended > 0);
    assert.equal(h.record.state, SessionState.ENDING, "premise: the pipeline ended the call");

    // ...and only now does the provider finish.
    h.releaseGeneration();
    await sleep(600);

    assert.deepEqual(
      h.refusedTransitions,
      [],
      `nothing may be transitioned out of ENDING: ${JSON.stringify(h.refusedTransitions)}`,
    );
    assert.deepEqual(
      h.errors.map((e) => (e instanceof Error ? e.message : String(e))),
      [],
      "no pipeline error is filed — a filed error is the TEMPORARY redial",
    );
  } finally {
    await h.stop();
  }
});

console.log(`\n${"═".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
