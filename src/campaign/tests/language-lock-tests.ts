/**
 * language-lock-tests.ts — `npm run test:language-lock`
 *
 * PHASE 1.3: THE LANGUAGE LOCK.
 *
 * THE DEFECT (MEETING_NOTES §"Prompt-Level Quality Fixes", roadmap
 * §4.3, audit §A row 3 / §B5). `detectLanguage` re-decided the reply
 * language on EVERY turn, by design — "the session switches languages
 * freely turn to turn". That is right for a per-turn hint and wrong for
 * a call: one English product name, one mis-scored romanized fragment,
 * one caller answering an English fixed line in English, and the agent
 * spends the rest of a Hindi call in English. The result feeds
 * `memory.currentLanguage`, which is read by the language-model hint,
 * the TTS request, the fixed hearing/attention lines, the
 * silence-recovery prompt AND the fallback greeting — so a single
 * mis-detected turn moves all of them.
 *
 * THE FIX. The call's language is fixed ONCE, on the caller's first
 * MEANINGFUL utterance, and held for the rest of the call
 * (`ConversationMemory.lockLanguage`, taken at the single site
 * `ConversationPipeline.commitTurnLanguage`). Until it is taken,
 * nothing changes: the per-turn detection runs and is used exactly as
 * it is today.
 *
 * WHAT "MEANINGFUL" MEANS, AND WHY EACH REFUSAL EXISTS — see
 * `qualifiesForLanguageLock`. Every clause delegates to a predicate or
 * constant that already existed (`utteranceTakesNoFloor`,
 * `SELF_ECHO_MIN_WORDS`, the attention-episode flags,
 * `isLockGradeEvidence`), so no second definition of "meaningful" was
 * introduced. This file asserts BOTH SIDES of each one.
 *
 * DEEPGRAM. No STT request parameter changed. The live socket already
 * runs Nova-3 with `language: "multi"` — Deepgram's own multilingual
 * language identification — and its observable output here is the
 * SCRIPT of the transcript, which the detector's `devanagari` /
 * `mixed-script` bases read. Section A pins that.
 *
 * SECTIONS
 *   A  the detector's evidence surface — additive, and what is
 *      lock-grade vs. merely hint-grade (including the explicit
 *      language-request refusal found in the adversarial pass)
 *   B  English first utterance -> English, and it stays English
 *   C  Hindi / Hinglish first utterance -> stays, including a mixed one
 *   D  no false locks: greeting, noise, backchannel, too-short,
 *      ambiguous — and the lock is not lost, only delayed
 *   E  hearing check / backchannel: no accidental switch either way
 *   F  everything else still works
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE. Every provider is a local fake; the
 * pipeline, the turn detector, the sentence chunker and the
 * conversation memory are all the real ones.
 */

import assert from "node:assert/strict";

const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { ConversationMemory } = await import("../../core/session/conversation-memory");
const { detectLanguage, isLockGradeEvidence } = await import("../../core/session/language-detector");
const { languageHintFor } = await import("../../core/session/system-prompt");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { SessionId } from "../../types/session.types";
import type { SupportedLanguage as Lang } from "../../types/enums";

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

const EN = SupportedLanguage.ENGLISH;
const HI = SupportedLanguage.HINDI;
const HI_EN = SupportedLanguage.HINGLISH;
const ALL_LANGUAGES: readonly Lang[] = [EN, HI, HI_EN];

/**
 * The two fixed hearing lines, per language, restated so a change to
 * either one fails a test rather than silently making section E
 * unobservable. Same reason `test:hearing-loop` restates them.
 */
const HEARING_ACK: Readonly<Record<string, string>> = {
  [EN]: "Hey, can you hear me okay?",
  [HI]: "हाँ, क्या आपको मेरी आवाज़ ठीक से सुनाई दे रही है?",
  [HI_EN]: "Haan, aap mujhe theek se sun paa rahe ho?",
};
const HEARING_FOLLOW_UP: Readonly<Record<string, string>> = {
  [EN]: "I just want to make sure you can hear me. Did you catch what I was saying?",
  [HI]: "बस कन्फ़र्म करना था कि आप मुझे सुन पा रहे हैं। जो मैंने अभी कहा, वो आपने सुना?",
  [HI_EN]:
    "Bas confirm karna tha ki aap mujhe sun paa rahe hain. Jo maine abhi kaha, woh aapne suna?",
};

/**
 * `LANGUAGE_LOCK_MIN_WORDS`, restated. It is derived in the pipeline
 * from `SELF_ECHO_MIN_WORDS`; raising either without raising this is
 * meant to fail.
 */
const MIN_LOCK_WORDS = 4;

// ═════════════════════════════════════════════════════════════════
// UTTERANCES — every one is pinned by section A before any pipeline
// test relies on how the detector reads it.
// ═════════════════════════════════════════════════════════════════

/** Plain English, well over the word floor, not one Hindi marker. */
const EN_MEANINGFUL = "Yes, tell me more about this workshop.";
/** A greeting with a real question attached — a turn, not a check. */
const EN_MEANINGFUL_2 = "Hello? What is this about exactly?";
/** Devanagari. The script settles it; Latin cannot be Devanagari. */
const HI_MEANINGFUL = "मुझे इसके बारे में जानकारी चाहिए।";
/** Romanized Hindi, five markers in seven words. */
const HI_ROMAN_MEANINGFUL = "Haan ji, mujhe iske baare mein bataiye.";
/** Genuine code-mixing: Devanagari plus enough Latin to be a mix. */
const MIXED_MEANINGFUL = "मुझे workshop की details chahiye please";
/** Below `LANGUAGE_LOCK_MIN_WORDS`, though its evidence is lock-grade. */
const HI_TOO_SHORT = "Ji boliye";
/** The detector's documented weak spot: English by fall-through, with a Hindi word in it. */
const AMBIGUOUS = "Aap tell me about the workshop please";
/** Four words, every one of them language-neutral. */
const NEUTRAL_ONLY = "Yes okay sure thanks";
/**
 * An explicit language REQUEST. Four clean English words, no Hindi
 * marker — lock-grade English by every other rule, and locking on it
 * would fix the call into the opposite of what the caller asked for.
 */
const ASKS_FOR_HINDI = "Please speak in Hindi";
/** The same thing the other way round, and in Devanagari. */
const ASKS_FOR_ENGLISH_HI = "कृपया अंग्रेज़ी में बात कीजिए";
/** The whole utterance is a presence check. */
const HEARING_CHECK = "Hello? Can you hear me?";
/**
 * The natural English answer to the fixed hearing line — the mimicry
 * case. Matches `HEARING_CONFIRMATION_ONLY`, so it takes the pipeline's
 * "the caller confirmed" branch rather than the contextual one.
 */
const HEARING_CONFIRMATION = "Yes, I can hear you.";
/**
 * The same mimicry in an utterance the confirmation table does NOT
 * match, so it takes the DECLINE branch instead — the other half of the
 * open-episode refusal.
 */
const HEARING_CONFIRMATION_FREEFORM = "Yes, I can hear you clearly.";

// ═════════════════════════════════════════════════════════════════
// THE HARNESS — the shape `test:hearing-loop` uses, plus a request log
// (the language HINT lives in the request, not in memory) and a
// synthesis log that records the language each clip was asked for.
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
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "fake",
  };
}

const healthy = (identifier: { category: unknown; id: string }) => ({
  identifier,
  isHealthy: true,
  checkedAt: new Date(),
});

interface LoggedRequest {
  readonly history: readonly ConversationTurn[];
  /** How many user turns memory held when the request was opened. */
  readonly userTurnsAtOpen: number;
}

interface Synthesized {
  readonly text: string;
  readonly language: Lang;
}

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: LoggedRequest[];
  readonly synthesized: Synthesized[];
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  waitForSpoken(text: string, timeoutMs?: number): Promise<void>;
  /** Say `text` and wait until that turn has been committed and answered. */
  settle(text: string, opts?: { isSpeechFinal?: boolean }): Promise<void>;
  history(): readonly ConversationTurn[];
  userTurns(): string[];
  lock(): Lang | undefined;
  language(): Lang;
  /** Language of the hint attached to the latest user turn of request `i`. */
  hintOf(i: number): Lang | undefined;
  lastHint(): Lang | undefined;
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly openingLine: string;
  readonly replies: readonly string[];
  /** What the SESSION was configured to open in — not what the caller speaks. */
  readonly configuredLanguage?: Lang;
}): Harness {
  const requests: LoggedRequest[] = [];
  const synthesized: Synthesized[] = [];
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

  const countUserTurns = (): number =>
    record.memory.history().filter((turn) => turn.role === "user").length;

  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async (request: CompletionRequest) => {
      requests.push({ history: request.history, userTurnsAtOpen: countUserTurns() });
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
      requests.push({ history: request.history, userTurnsAtOpen: countUserTurns() });
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(10);
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
    synthesize: async (task: { request: { text: string; language: Lang } }) => {
      synthesized.push({ text: task.request.text, language: task.request.language });
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
    "language-lock-test" as SessionId,
    {
      language: input.configuredLanguage ?? EN,
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

  const hintIn = (history: readonly ConversationTurn[]): Lang | undefined => {
    const latestUser = [...history].reverse().find((turn) => turn.role === "user");
    if (!latestUser) return undefined;
    return ALL_LANGUAGES.find((language) => latestUser.content.includes(languageHintFor(language)));
  };

  return {
    record,
    requests,
    synthesized,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({
        text,
        isFinal,
        isSpeechFinal: opts?.isSpeechFinal ?? isFinal,
        confidence: 0.95,
        language: EN,
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
    async waitForSpoken(text, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (synthesized.some((clip) => clip.text === text) && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for "${text}" — spoken: ${JSON.stringify(
          synthesized.map((clip) => clip.text),
        )}`,
      );
    },
    async settle(text, opts) {
      const before = record.memory.history().length;
      this.say(text, opts);
      // Committed, answered (an assistant turn of some kind followed),
      // and back to idle. Counting HISTORY LENGTH rather than replies
      // is what makes this correct for the fixed hearing lines too —
      // those commit an assistant turn just as a generated reply does.
      await this.waitFor(
        `the turn "${text}" to be committed and answered`,
        () => record.memory.history().length >= before + 2 && record.state === SessionState.LISTENING,
      );
      await sleep(150);
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
    lock() {
      return record.memory.languageLock;
    },
    language() {
      return record.memory.currentLanguage;
    },
    hintOf(i) {
      const request = requests[i];
      return request ? hintIn(request.history) : undefined;
    },
    lastHint() {
      const request = requests.at(-1);
      return request ? hintIn(request.history) : undefined;
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
const REPLY_1 = "Sure, let me explain.";
const REPLY_2 = "It is a short session.";
const REPLY_3 = "There is no charge for it.";
const REPLY_4 = "I can reserve a seat for you.";
const REPLIES = [REPLY_1, REPLY_2, REPLY_3, REPLY_4];

/** Greeting spoken in full, session LISTENING, nothing asked of the model yet. */
async function greetingDone(h: Harness): Promise<void> {
  await h.waitForReplies(1);
  assert.deepEqual(
    h.synthesized.map((c) => c.text),
    [OPENING],
    "only the greeting has been spoken",
  );
  assert.equal(h.requests.length, 0, "no conversational request has been made");
  assert.equal(h.lock(), undefined, "the greeting cannot lock anything — no caller has spoken");
}

/** Count the words the way the pipeline's lock floor does. */
const lockWordCount = (text: string): number =>
  text
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^a-z0-9ऀ-ॿ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

// ═════════════════════════════════════════════════════════════════
section("A — the detector's evidence surface (additive; lock-grade vs. hint-grade)");
// ═════════════════════════════════════════════════════════════════

await test("A1 — Devanagari is script evidence: `devanagari`, Hindi, lock-grade", () => {
  const r = detectLanguage(HI_MEANINGFUL, EN);
  assert.equal(r.language, HI);
  assert.equal(r.basis, "devanagari");
  assert.equal(r.script, "devanagari");
  assert.equal(isLockGradeEvidence(r), true);
});

await test("A2 — romanized Hindi is marker evidence: `roman-markers`, Hindi, lock-grade", () => {
  const r = detectLanguage(HI_ROMAN_MEANINGFUL, EN);
  assert.equal(r.language, HI);
  assert.equal(r.basis, "roman-markers");
  assert.ok(r.hindiMarkerHits > 0, "markers were actually found");
  assert.equal(isLockGradeEvidence(r), true);
});

await test("A3 — a genuinely mixed utterance is `mixed-script` HINGLISH, and lock-grade", () => {
  const r = detectLanguage(MIXED_MEANINGFUL, EN);
  assert.equal(r.language, HI_EN, "the architecture's answer for code-mixing is Hinglish, not a pure language");
  assert.equal(r.basis, "mixed-script");
  assert.equal(isLockGradeEvidence(r), true);
});

await test("A4 — clean English (no Hindi marker at all) is `default-english` and IS lock-grade", () => {
  const r = detectLanguage(EN_MEANINGFUL, HI);
  assert.equal(r.language, EN);
  assert.equal(r.basis, "default-english");
  assert.equal(r.hindiMarkerHits, 0, "not one of ~150 Hindi function words");
  assert.equal(isLockGradeEvidence(r), true, "otherwise an English call could never lock");
});

await test("A5 — English fall-through WITH a Hindi word in it is NOT lock-grade (audit §B5)", () => {
  const r = detectLanguage(AMBIGUOUS, HI);
  assert.equal(r.language, EN, "the per-turn answer is unchanged — still English");
  assert.equal(r.basis, "default-english");
  assert.equal(r.hindiMarkerHits, 1, "below HINGLISH_MARKER_RATIO but not clean English either");
  assert.equal(isLockGradeEvidence(r), false, "one recoverable English reply, never a locked call");
});

await test("A5b — an utterance that NAMES a language is refused as lock evidence, in either direction", () => {
  // ADVERSARIAL FINDING, phase 1.3. "Please speak in Hindi" is four
  // clean English words with no Hindi marker in it, so every other rule
  // here calls it lock-grade English — and locking a call to English
  // because the caller asked for HINDI is the one unrecoverable
  // outcome. The detector's own marker table already refuses to score
  // these words; the lock refuses to trust them.
  const askHindi = detectLanguage(ASKS_FOR_HINDI, HI);
  assert.equal(askHindi.language, EN, "the per-turn answer is UNCHANGED — still English, as today");
  assert.equal(askHindi.mentionsLanguage, true);
  assert.equal(isLockGradeEvidence(askHindi), false, "the call stays unlocked so their next turn decides");

  const askEnglish = detectLanguage(ASKS_FOR_ENGLISH_HI, EN);
  assert.equal(askEnglish.language, HI, "still detected exactly as before");
  assert.equal(askEnglish.mentionsLanguage, true);
  assert.equal(isLockGradeEvidence(askEnglish), false);

  for (const text of [
    "Can you switch to English?",
    "I want to change my language",
    "aap hindi mein boliye",
    "हिंदी में बात कीजिए",
  ]) {
    assert.equal(isLockGradeEvidence(detectLanguage(text, EN)), false, `${JSON.stringify(text)} must not lock`);
  }

  // The negative half: an ordinary utterance does NOT trip the flag.
  for (const text of [EN_MEANINGFUL, HI_MEANINGFUL, HI_ROMAN_MEANINGFUL, MIXED_MEANINGFUL]) {
    assert.equal(detectLanguage(text, EN).mentionsLanguage, false, `${JSON.stringify(text)} names no language`);
  }
});

await test("A6 — an all-neutral utterance carries no evidence: `neutral`, previous kept, not lock-grade", () => {
  for (const previous of ALL_LANGUAGES) {
    const r = detectLanguage(NEUTRAL_ONLY, previous);
    assert.equal(r.language, previous, "the language already in play is kept — unchanged behaviour");
    assert.equal(r.basis, "neutral");
    assert.equal(isLockGradeEvidence(r), false, "locking here would freeze the CONFIGURED language");
  }
});

await test("A7 — an empty utterance is `empty` and not lock-grade", () => {
  const r = detectLanguage("   ", HI);
  assert.equal(r.language, HI);
  assert.equal(r.basis, "empty");
  assert.equal(isLockGradeEvidence(r), false);
});

await test("A8 — ADDITIVE ONLY: language, confidence and script are unchanged for every shape", () => {
  // Pinned by value, from the rules as written before this change. If a
  // future edit moves any of these, it is changing detection, not the
  // lock, and must be argued on its own.
  const expected: ReadonlyArray<readonly [string, Lang, number, string]> = [
    [HI_MEANINGFUL, HI, 0.9, "devanagari"],
    [MIXED_MEANINGFUL, HI_EN, 0.85, "mixed"],
    ["अब आप हिंदी में बात कीजिए please", HI, 0.85, "mixed"],
    [HI_ROMAN_MEANINGFUL, HI, 0.88, "latin"],
    ["The workshop timing kya hai", HI_EN, 0.75, "latin"],
    [EN_MEANINGFUL, EN, 0.75, "latin"],
    [AMBIGUOUS, EN, 0.75, "latin"],
    [NEUTRAL_ONLY, EN, 0.5, "latin"],
    ["", EN, 0, "latin"],
  ];
  for (const [text, language, confidence, script] of expected) {
    const r = detectLanguage(text, EN);
    assert.equal(r.language, language, `language for ${JSON.stringify(text)}`);
    assert.equal(Number(r.confidence.toFixed(2)), confidence, `confidence for ${JSON.stringify(text)}`);
    assert.equal(r.script, script, `script for ${JSON.stringify(text)}`);
  }
});

await test("A9 — the word floor is what it claims to be, on the utterances the pipeline tests use", () => {
  assert.ok(lockWordCount(HI_TOO_SHORT) < MIN_LOCK_WORDS, "the short one really is short");
  assert.equal(isLockGradeEvidence(detectLanguage(HI_TOO_SHORT, EN)), true, "…and is blocked ONLY by length");
  for (const text of [EN_MEANINGFUL, EN_MEANINGFUL_2, HI_MEANINGFUL, HI_ROMAN_MEANINGFUL, MIXED_MEANINGFUL]) {
    assert.ok(lockWordCount(text) >= MIN_LOCK_WORDS, `${JSON.stringify(text)} clears the floor`);
  }
});

await test("A10 — the caller's explicit-language escape hatch is still stated in every hint", () => {
  // The lock is deliberately absolute in CODE. The one way a caller
  // overrides it is the route that already exists and is deliberately
  // NOT in this heuristic: the model reading their own words.
  assert.ok(
    languageHintFor(EN).includes("unless they have explicitly asked for a different language"),
    "the English hint still defers to an explicit request",
  );
  assert.ok(
    languageHintFor(HI).includes("an explicit language request from the caller always wins"),
    "the Hindi hint still defers to an explicit request",
  );
});

// ═════════════════════════════════════════════════════════════════
section("B — an English first utterance locks English, and it stays English");
// ═════════════════════════════════════════════════════════════════

await test("B1 — first meaningful utterance in English locks the call to English, overriding the CONFIGURED Hindi", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    assert.equal(h.language(), HI, "the session opened in its configured language");

    h.say(EN_MEANINGFUL);
    await h.waitForReplies(2);

    assert.equal(h.lock(), EN, "locked to what the caller actually spoke");
    assert.equal(h.language(), EN);
    assert.equal(h.lastHint(), EN, "and the model was told English for this very turn");
  } finally {
    await h.stop();
  }
});

await test("B2 — a later Hindi turn does NOT silently change the locked language", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES });
  try {
    await greetingDone(h);
    h.say(EN_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), EN);

    h.say(HI_MEANINGFUL);
    await h.waitForReplies(3);
    assert.equal(h.lock(), EN, "the lock is write-once");
    assert.equal(h.language(), EN, "and everything reading currentLanguage stays with it");
    assert.equal(h.lastHint(), EN, "the model is still told English — this is the whole point of §4.3");

    h.say(HI_ROMAN_MEANINGFUL);
    await h.waitForReplies(4);
    assert.equal(h.lock(), EN, "a romanized Hindi turn does not move it either");
    assert.equal(h.lastHint(), EN);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("C — a Hindi / Hinglish first utterance locks and stays");
// ═════════════════════════════════════════════════════════════════

await test("C1 — Devanagari first utterance locks Hindi; a later full English turn does not switch it", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    assert.equal(h.language(), EN, "the session opened in English");

    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI, "Deepgram multi-mode returned Devanagari; the script settled it");
    assert.equal(h.lastHint(), HI);

    h.say("Actually I would prefer if we speak about the timing.");
    await h.waitForReplies(3);
    assert.equal(h.lock(), HI, "THE reported defect: this used to flip the rest of the call to English");
    assert.equal(h.language(), HI);
    assert.equal(h.lastHint(), HI);
  } finally {
    await h.stop();
  }
});

await test("C2 — romanized Hinglish first utterance locks Hindi and holds", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_ROMAN_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI);

    h.say(EN_MEANINGFUL);
    await h.waitForReplies(3);
    assert.equal(h.lock(), HI);
    assert.equal(h.lastHint(), HI);
  } finally {
    await h.stop();
  }
});

await test("C3 — a MIXED first utterance locks HINGLISH, not one of the pure languages", async () => {
  // Verified against the architecture before implementing: HINGLISH is
  // a first-class SupportedLanguage whose prompt hint is "mirror their
  // mix naturally". Collapsing a mixed opener onto Hindi or English
  // would be a new policy; this is the existing one.
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(MIXED_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI_EN);
    assert.equal(h.lastHint(), HI_EN);

    h.say(EN_MEANINGFUL);
    await h.waitForReplies(3);
    assert.equal(h.lock(), HI_EN, "a following English turn does not collapse the mix");
    assert.equal(h.lastHint(), HI_EN);
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("D — no false locks (and the lock is delayed, never lost)");
// ═════════════════════════════════════════════════════════════════

await test("D1a — a 'Hello?' spoken WHILE the opening line plays is the pickup acknowledgement: not a turn, no lock", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    // Said into the greeting, which is what arms `pickupAckAllowance`.
    h.say("Hello?");
    await h.waitForReplies(1);
    await sleep(400);
    assert.deepEqual(h.userTurns(), [], "the pickup acknowledgement is dropped, exactly as today");
    assert.equal(h.lock(), undefined, "and so cannot have locked anything");
    assert.equal(h.language(), HI, "the configured language is untouched");

    await h.settle(HI_MEANINGFUL);
    assert.equal(h.lock(), HI, "the first real utterance still locks");
  } finally {
    await h.stop();
  }
});

await test("D1b — a bare greeting AFTER the opening line is a turn, but still takes no floor and locks nothing", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    await h.settle("Hello?");
    assert.ok(h.userTurns().includes("Hello?"), "it IS a committed turn — the pickup allowance is spent");
    assert.equal(h.lock(), undefined, "…and it still locks nothing: a bare greeting takes no floor");
    assert.equal(h.language(), HI, "the configured language is untouched");

    await h.settle(EN_MEANINGFUL);
    assert.equal(h.lock(), EN, "the first meaningful utterance locks — delayed, not lost");
  } finally {
    await h.stop();
  }
});

await test("D2 — a bare acknowledgement / all-neutral turn locks nothing", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    // Consume the one-per-call pickup allowance on something real, so
    // the acknowledgement below is judged on its own merits.
    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI);
  } finally {
    await h.stop();
  }

  // Same utterance, but FIRST — with a session configured to English,
  // so a false lock would be visible as English.
  const g = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(g);
    g.say("Actually hold on.");
    await g.waitForReplies(2);
    const lockAfterFiller = g.lock();

    g.say(NEUTRAL_ONLY);
    await sleep(400);
    assert.equal(g.lock(), lockAfterFiller, "an all-neutral turn changes nothing either way");
  } finally {
    await g.stop();
  }
});

await test("D3 — an utterance below the word floor does not lock, and does not prevent a later one", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_TOO_SHORT);
    await h.waitForReplies(2);
    assert.equal(h.lock(), undefined, "two words is below LANGUAGE_LOCK_MIN_WORDS — too short to trust");
    assert.equal(h.lastHint(), HI, "the per-turn hint is UNCHANGED from today: it still follows the detection");

    h.say(HI_ROMAN_MEANINGFUL);
    await h.waitForReplies(3);
    assert.equal(h.lock(), HI, "the next qualifying turn takes the lock — delayed, not lost");
  } finally {
    await h.stop();
  }
});

await test("D4 — the documented English fall-through is NOT made permanent (audit §B5 / §F.6)", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    h.say(AMBIGUOUS);
    await h.waitForReplies(2);
    assert.equal(h.lock(), undefined, "ambiguous evidence must not fix the call's language");
    assert.equal(
      h.lastHint(),
      EN,
      "existing per-turn behaviour is preserved exactly — this turn still gets the English hint",
    );

    h.say(HI_MEANINGFUL);
    await h.waitForReplies(3);
    assert.equal(h.lock(), HI, "and the call recovers on the next unambiguous turn, as it does today");
    assert.equal(h.lastHint(), HI);
  } finally {
    await h.stop();
  }
});

await test("D4b — an explicit request for Hindi does NOT lock the call into English", async () => {
  // The adversarial case in full. Before the refusal, this session
  // ended with `languageLock === "en"` — the caller asks for Hindi and
  // the hint, the synthesis language and every fixed line contradict
  // them for the rest of the call.
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    await h.settle(ASKS_FOR_HINDI);
    assert.equal(h.lock(), undefined, "an explicit request is not the caller choosing a language by speaking it");
    assert.equal(
      h.lastHint(),
      EN,
      "and the per-turn hint is untouched — the model still sees the request and answers it, exactly as today",
    );

    // Their next turn, spoken in what they actually wanted, decides.
    await h.settle(HI_MEANINGFUL);
    assert.equal(h.lock(), HI, "the call locks to Hindi, which is what they asked for");
    assert.equal(h.lastHint(), HI);
  } finally {
    await h.stop();
  }
});

await test("D5 — a greeting-plus-question IS a real turn and does lock (both sides of the floor test)", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    h.say(EN_MEANINGFUL_2);
    await h.waitForReplies(2);
    assert.equal(h.lock(), EN, "'Hello? What is this about exactly?' is a question, not a presence check");
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("E — hearing check and backchannel: no accidental switch");
// ═════════════════════════════════════════════════════════════════

await test("E1 — a presence check is answered in the LOCKED language and cannot re-lock", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI);
    const requestsBefore = h.requests.length;

    h.say(HEARING_CHECK);
    await h.waitForSpoken(HEARING_ACK[HI]!);
    assert.equal(h.lock(), HI, "an English-looking presence check does not touch the lock");
    assert.equal(h.language(), HI);
    assert.equal(h.requests.length, requestsBefore, "still answered without the language model");
  } finally {
    await h.stop();
  }
});

await test("E2 — the caller's English answer to the fixed hearing line cannot switch a Hindi call", async () => {
  // The mimicry case. The fixed line is a QUESTION, so the natural
  // reply repeats its words in its language — and if the line was
  // spoken in English (before the lock, or in an English call) a Hindi
  // caller's "Yes, I can hear you clearly." is six lock-grade English
  // words. `qualifiesForLanguageLock` refuses the whole open episode.
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI);

    h.say(HEARING_CHECK);
    await h.waitForSpoken(HEARING_ACK[HI]!);

    h.say(HEARING_CONFIRMATION);
    await h.waitForSpoken(HEARING_FOLLOW_UP[HI]!);
    assert.equal(h.lock(), HI, "the confirmation is an answer to OUR line, not a language choice");
    assert.equal(h.language(), HI);
  } finally {
    await h.stop();
  }
});

await test("E2b — the same mimicry on the DECLINE branch (free-form wording) also cannot switch the call", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    await h.settle(HI_MEANINGFUL);
    assert.equal(h.lock(), HI);

    h.say(HEARING_CHECK);
    await h.waitForSpoken(HEARING_ACK[HI]!);

    // Not in `HEARING_CONFIRMATION_ONLY`, so `handleAttentionCheck`
    // DECLINES it and the contextual path answers — six lock-grade
    // English words inside an open episode.
    await h.settle(HEARING_CONFIRMATION_FREEFORM);
    assert.equal(h.lock(), HI, "an open episode refuses the lock on every branch, not just the fixed ones");
    assert.equal(h.language(), HI);
  } finally {
    await h.stop();
  }
});

await test("E3 — an open hearing episode cannot take a FIRST lock either (nothing is locked yet)", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    // Open a hearing episode before any meaningful utterance is heard.
    h.say("Hello? Hello?");
    await h.waitForSpoken(HEARING_ACK[HI]!);
    assert.equal(h.lock(), undefined, "a presence check is not a meaningful utterance");

    // The caller's English answer to our Hindi fixed line: inside the
    // episode, so still no lock.
    await h.settle(HEARING_CONFIRMATION);
    assert.equal(h.lock(), undefined, "the reply to a fixed line does not choose the call's language");

    // And the episode is now closed, so the next real turn locks.
    await h.settle(EN_MEANINGFUL);
    assert.equal(h.lock(), EN, "bounded: the delay is one turn, never permanent");
  } finally {
    await h.stop();
  }
});

await test("E4 — a backchannel mid-call never moves a locked language", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_ROMAN_MEANINGFUL);
    await h.waitForReplies(2);
    assert.equal(h.lock(), HI);

    for (const backchannel of ["Okay.", "Yes yes.", "Hmm."]) {
      h.say(backchannel);
      await sleep(250);
      assert.equal(h.lock(), HI, `"${backchannel}" must not move the lock`);
      assert.equal(h.language(), HI);
    }
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
section("F — everything else still works");
// ═════════════════════════════════════════════════════════════════

await test("F1 — the pre-opened LLM request is still ADOPTED on the very turn that takes the lock", async () => {
  // If `commitTurnLanguage` returned anything other than what
  // `effectiveLanguageFor` returned at pre-open time, the hint would
  // differ, `adoptSpeculation` would reject, and every first meaningful
  // utterance in the campaign would pay full latency for a discarded
  // request. One request per turn is the assertion.
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: HI });
  try {
    await greetingDone(h);
    h.say(HI_MEANINGFUL, { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length >= 1, 2000);
    assert.equal(h.requests[0]!.userTurnsAtOpen, 0, "opened BEFORE the user turn was committed");

    await h.waitForReplies(2);
    assert.equal(h.requests.length, 1, "adopted — no second request at release");
    assert.equal(h.lock(), HI);
    assert.equal(h.hintOf(0), HI, "and the pre-opened request already carried the locked language");
  } finally {
    await h.stop();
  }
});

await test("F2 — TTS is asked for the locked language, for generated replies and fixed lines alike", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    assert.equal(h.synthesized[0]!.language, EN, "the greeting used the configured language");

    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    const afterLock = h.synthesized.slice(1);
    assert.ok(afterLock.length > 0, "something was spoken after the lock");
    for (const clip of afterLock) {
      assert.equal(clip.language, HI, `"${clip.text}" was synthesized in the locked language`);
    }

    h.say(EN_MEANINGFUL);
    await h.waitForReplies(3);
    for (const clip of h.synthesized.slice(1)) {
      assert.equal(clip.language, HI, "an English turn later in the call does not change synthesis language");
    }
  } finally {
    await h.stop();
  }
});

await test("F3 — conversation history, turn order and reply count are unchanged by the lock", async () => {
  const h = startHarness({ openingLine: OPENING, replies: REPLIES, configuredLanguage: EN });
  try {
    await greetingDone(h);
    h.say(HI_MEANINGFUL);
    await h.waitForReplies(2);
    h.say(EN_MEANINGFUL);
    await h.waitForReplies(3);

    assert.deepEqual(
      h.history().map((turn) => turn.content),
      [OPENING, HI_MEANINGFUL, REPLY_1, EN_MEANINGFUL, REPLY_2],
      "exactly the turns the pipeline committed before this change, in order",
    );
    assert.equal(h.requests.length, 2, "one language-model request per real turn — no extra, none lost");
  } finally {
    await h.stop();
  }
});

await test("F4 — ConversationMemory clamps a raw per-turn language once locked (the voicemail path's protection)", () => {
  // `hangUpOnVoicemail` and the main loop's voicemail branch record the
  // MACHINE's words as evidence for the outcome classifier. Neither may
  // move the call's language. Both go through `recordUserTurn`, so the
  // clamp is asserted there.
  const memory = new ConversationMemory(EN, "SYSTEM");
  assert.equal(memory.languageLock, undefined);

  memory.recordUserTurn("Yes tell me about it", EN);
  assert.equal(memory.currentLanguage, EN);

  assert.equal(memory.lockLanguage(EN), true, "first write takes the lock");
  assert.equal(memory.languageLock, EN);

  memory.recordUserTurn("मुझे इसके बारे में जानकारी चाहिए।", HI);
  assert.equal(memory.currentLanguage, EN, "a raw detection cannot move a locked call");

  assert.equal(memory.lockLanguage(HI), false, "a second lock is refused");
  assert.equal(memory.languageLock, EN);
  assert.equal(memory.currentLanguage, EN);
});

await test("F5 — an unlocked call still behaves exactly as it did: the language follows the detection", () => {
  const memory = new ConversationMemory(EN, "SYSTEM");
  memory.recordUserTurn(HI_MEANINGFUL, HI);
  assert.equal(memory.currentLanguage, HI, "no lock taken — the per-turn value is applied, as before");
  memory.recordUserTurn(EN_MEANINGFUL, EN);
  assert.equal(memory.currentLanguage, EN, "and it can still move, turn to turn, until a lock is taken");
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
