/**
 * turn-release-tests.ts — `npm run test:turn-release`
 *
 * TWO CHANGES, MEASURED. Nothing here contacts a vendor, opens a
 * socket, places a call or touches the database.
 *
 * SECTION A — TURN RELEASE LATENCY (`AdaptiveTurnDetector`).
 *
 *   A completed turn used to wait a full adaptive silence window
 *   (1100ms by default, up to 1600ms once adapted) BEFORE its
 *   post-speech confirmation window, even when the final that ended it
 *   carried Deepgram's own `speech_final: true`. Deepgram had already
 *   waited out its `endpointing` window before sending that final, so
 *   the same silence was being measured twice — and the detector's
 *   clock only starts when the final ARRIVES, so its delivery lag was
 *   added on top. That is the `stt-to-release` figure of 2.3-2.8s in
 *   the production logs.
 *
 *   Only the redundant wait is gone. Every release guard still runs,
 *   and the classes for which the silence window is NOT redundant — a
 *   chunk-boundary final, an outstanding interim, a hesitation sound, a
 *   request for a moment, and text that reads as unfinished — keep
 *   exactly the timing they had. Those are the assertions that matter:
 *   this section exists as much to prove what did NOT get faster.
 *
 * SECTION B — BACKCHANNEL VOCABULARY (`isBareAcknowledgement`).
 *
 *   The predicate the pipeline uses to tell "ok, carry on" from a real
 *   interruption. Anything with content of its own, and every negation,
 *   must fall straight through it.
 *
 * Timings are wall-clock: the detector arms real `setTimeout`s, so a
 * release is measured the way a caller experiences it. Bounds are
 * asserted as ranges, never as exact values.
 */

import assert from "node:assert/strict";

const { AdaptiveTurnDetector, isBareAcknowledgement } = await import(
  "../../core/session/turn-detection"
);
const { SupportedLanguage } = await import("../../types/enums");

import type { TranscriptSegment } from "../../types/provider.types";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);

/** The detector's own documented windows, restated so a drift shows up here. */
const SILENCE_WINDOW_MS = 1_100;
const CONFIRMATION_MS = 300;
const OPEN_ENDED_CONFIRMATION_MS = 550;
const CHUNK_BOUNDARY_GRACE_MS = 700;
const CONTINUATION_GRACE_MS = 800;
const HOLD_GRACE_MS = 1_200;
/**
 * PHASE 2 — the tiered window for a turn whose completeness AND
 * end-of-speech are BOTH freshly evidenced (the provider's own
 * endpointer just fired, and the text independently reads as
 * finished). Before this phase, both direct call sites armed
 * `CONFIRMATION_MS` and left `stage` at `"silence"`, so `emitTurnEnd`
 * mistook that timer's own expiry for a fresh silence-window timeout
 * and re-ran the inference confirmation on top of it — 0 extra for a
 * short turn, but another full `CONFIRMATION_MS` for anything longer,
 * i.e. `CONFIRMATION_MS * 2` (~600ms) for a long complete sentence.
 * See `EVIDENCED_CONFIRMATION_SHORT_MS` in turn-detection.ts.
 */
const EVIDENCED_SHORT_MS = 150;
const EVIDENCED_LONG_MS = 250;

interface FedSegment {
  readonly text: string;
  readonly isFinal?: boolean;
  readonly isSpeechFinal?: boolean;
  /** Wall-clock pause before this segment is fed, so a timer can fire between two of them. */
  readonly afterMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Feeds one utterance and reports how long the detector held it before
 * releasing, measured from the moment the last segment was fed — i.e.
 * exactly the span `stt-to-release` covers after Deepgram's own lag.
 */
async function releaseDelayMs(
  segments: readonly FedSegment[],
  timeoutMs = 8_000,
): Promise<{ delayMs: number; text: string }> {
  const detector = new AdaptiveTurnDetector();
  let fedAt = 0;
  let streamMs = 0;

  const released = new Promise<{ delayMs: number; text: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no turn released within ${timeoutMs}ms`)),
      timeoutMs,
    );
    detector.onTurnEnd((event) => {
      clearTimeout(timer);
      resolve({ delayMs: Date.now() - fedAt, text: event.text });
    });
  });

  for (const segment of segments) {
    if (segment.afterMs !== undefined) await sleep(segment.afterMs);
    streamMs += 1_000;
    detector.feed({
      text: segment.text,
      isFinal: segment.isFinal ?? true,
      confidence: 0.95,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: streamMs - 1_000,
      endedAtMs: streamMs,
      ...(segment.isSpeechFinal === undefined ? {} : { isSpeechFinal: segment.isSpeechFinal }),
    });
    fedAt = Date.now();
  }

  return released;
}

/** Timer slack: a real `setTimeout` chain can only ever run late. */
const EARLY = 100;
const LATE = 400;

function within(actual: number, expected: number, what: string): void {
  assert.ok(
    actual >= expected - EARLY && actual <= expected + LATE,
    `${what}: expected ~${expected}ms (-${EARLY}/+${LATE}), measured ${actual}ms`,
  );
}

// ═════════════════════════════════════════════════════════════════
section("A. TURN RELEASE — the redundant silence window is gone, the necessary ones are not");

// ── A1. What got faster ──────────────────────────────────────────

await test(
  "an endpointed COMPLETE turn of more than four words releases on the confirmation window, not a silence window",
  async () => {
    const { delayMs, text } = await releaseDelayMs([
      { text: "Yes I would like to attend the session today.", isSpeechFinal: true },
    ]);
    assert.equal(text, "Yes I would like to attend the session today.");
    // Was SILENCE_WINDOW_MS + CONFIRMATION_MS (~1400ms) before Phase 1,
    // then CONFIRMATION_MS * 2 (~600ms) under Phase 1: the fast path
    // armed one CONFIRMATION_MS window but left `stage` at `"silence"`,
    // so `emitTurnEnd` paid a second one on top for any turn longer
    // than SHORT_COMPLETE_TURN_MAX_WORDS. Phase 2 collapses that into
    // the single EVIDENCED_LONG_MS window — see turn-detection.ts.
    within(delayMs, EVIDENCED_LONG_MS, "long complete endpointed turn");
    assert.ok(
      delayMs < SILENCE_WINDOW_MS,
      `must no longer pay a full silence window: measured ${delayMs}ms`,
    );
  },
);

await test("an endpointed complete QUESTION releases without a silence window", async () => {
  const { delayMs } = await releaseDelayMs([
    { text: "How do I join the session?", isSpeechFinal: true },
  ]);
  // Was CONFIRMATION_MS (~300ms). Phase 2: EVIDENCED_SHORT_MS.
  within(delayMs, EVIDENCED_SHORT_MS, "short endpointed question");
});

await test(
  "a question that ENDS ON A PREPOSITION is a finished question, not a mid-thought pause",
  async () => {
    // "about" is in the HARD continuation set, which is checked ahead of
    // a full stop on purpose. A question mark is now checked ahead of
    // BOTH — before this, an ordinary six-word question spent the
    // silence window plus two continuation graces (~2.7s) before it was
    // answered.
    const { delayMs, text } = await releaseDelayMs([
      { text: "What exactly is this event about?", isSpeechFinal: true },
    ]);
    assert.equal(text, "What exactly is this event about?");
    // Was CONFIRMATION_MS (~300ms). Phase 2: EVIDENCED_SHORT_MS.
    within(delayMs, EVIDENCED_SHORT_MS, "question ending on a HARD continuation word");
  },
);

await test(
  "a STATEMENT ending on a preposition is still a mid-thought pause",
  async () => {
    // The same word, without the question mark: unchanged, and still
    // given the full window plus both graces.
    const { delayMs } = await releaseDelayMs([
      { text: "It was something around.", isSpeechFinal: true },
    ]);
    assert.ok(
      delayMs > SILENCE_WINDOW_MS,
      `a dangling preposition in a statement must still be waited out: measured ${delayMs}ms`,
    );
  },
);

await test("a short endpointed confirmation is now the tightest evidenced window", async () => {
  // Was CONFIRMATION_MS (~300ms) under Phase 1. Phase 2:
  // EVIDENCED_SHORT_MS — the shortest hold this detector ever grants,
  // and only for a turn that is both endpointed and grammatically
  // complete.
  const { delayMs } = await releaseDelayMs([{ text: "Haan.", isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_SHORT_MS, "short complete endpointed turn");
});

// ── A2. What did NOT get faster, and must not ────────────────────

await test(
  "a MID-THOUGHT endpointed turn still gets the full silence window and both continuation graces",
  async () => {
    const { delayMs, text } = await releaseDelayMs([
      { text: "I was going to ask about the timing and", isSpeechFinal: true },
    ]);
    assert.equal(text, "I was going to ask about the timing and");
    // Trailing "and" is a HARD continuation word: full silence window,
    // then two continuation graces, then the confirmation window.
    within(
      delayMs,
      SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS * 2 + CONFIRMATION_MS,
      "dangling-conjunction turn",
    );
    assert.ok(
      delayMs > SILENCE_WINDOW_MS,
      `an unfinished thought must still be given room: measured only ${delayMs}ms`,
    );
  },
);

await test("an UNPUNCTUATED endpointed turn still gets the full silence window", async () => {
  const { delayMs } = await releaseDelayMs([
    { text: "the timing is what I wanted to know", isSpeechFinal: true },
  ]);
  within(
    delayMs,
    SILENCE_WINDOW_MS + OPEN_ENDED_CONFIRMATION_MS,
    "endpointed turn with no sentence-final punctuation",
  );
  assert.ok(
    delayMs >= SILENCE_WINDOW_MS,
    `no sentence-final punctuation must keep the silence window: measured ${delayMs}ms`,
  );
});

await test(
  "a CHUNK-BOUNDARY final (speech_final absent) still gets the silence window and its grace",
  async () => {
    const { delayMs } = await releaseDelayMs([
      { text: "I am going to attend the session.", isSpeechFinal: false },
    ]);
    within(
      delayMs,
      SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS + CONFIRMATION_MS,
      "non-endpointed final",
    );
    assert.ok(
      delayMs > SILENCE_WINDOW_MS,
      `Deepgram never declared end-of-speech, so the wait must remain: measured ${delayMs}ms`,
    );
  },
);

await test(
  "an OUTSTANDING INTERIM still holds the turn, and interim text never becomes one",
  async () => {
    const { delayMs, text } = await releaseDelayMs([
      { text: "Yes that is right.", isSpeechFinal: true },
      { text: "and one more thing", isFinal: false },
    ]);
    assert.equal(text, "Yes that is right.", "interim text must never be made into a turn");
    assert.ok(
      delayMs >= SILENCE_WINDOW_MS,
      `words Deepgram has shown but not finalised must be waited for: measured ${delayMs}ms`,
    );
  },
);

await test("a filler-only utterance is still dropped rather than answered", async () => {
  const { text } = await releaseDelayMs([
    { text: "Hmm.", isSpeechFinal: true },
    // Fed after the filler's own window has expired, so the detector
    // has already discarded it and this is a fresh turn.
    { text: "Okay I will attend.", isSpeechFinal: true, afterMs: SILENCE_WINDOW_MS + 400 },
  ]);
  assert.equal(text, "Okay I will attend.", "the hesitation must be dropped, not answered");
});

await test("a hold phrase is still given its longer grace, not released", async () => {
  const { delayMs } = await releaseDelayMs([{ text: "Wait.", isSpeechFinal: true }]);
  within(delayMs, SILENCE_WINDOW_MS + HOLD_GRACE_MS * 2, "caller asked for a moment");
  assert.ok(
    delayMs > SILENCE_WINDOW_MS,
    `a caller who asked for a moment must get one: measured ${delayMs}ms`,
  );
});

// ═════════════════════════════════════════════════════════════════
section("A3. PHASE 2 — more evidenced classes, and the pause protection they must not lose");

await test("a short evidenced 'yes' releases on the short evidenced window", async () => {
  const { delayMs, text } = await releaseDelayMs([{ text: "Yes.", isSpeechFinal: true }]);
  assert.equal(text, "Yes.");
  within(delayMs, EVIDENCED_SHORT_MS, "short evidenced affirmative");
});

await test("a short evidenced 'no' releases on the short evidenced window", async () => {
  const { delayMs, text } = await releaseDelayMs([{ text: "No.", isSpeechFinal: true }]);
  assert.equal(text, "No.");
  within(delayMs, EVIDENCED_SHORT_MS, "short evidenced negation");
});

await test(
  "a LONG evidenced question (more than SHORT_QUESTION_MAX_WORDS) gets the LONG tier, not the short one",
  async () => {
    const { delayMs, text } = await releaseDelayMs([
      {
        text: "Could you please tell me exactly what time the workshop is starting tomorrow?",
        isSpeechFinal: true,
      },
    ]);
    assert.equal(text, "Could you please tell me exactly what time the workshop is starting tomorrow?");
    // 12 words > SHORT_QUESTION_MAX_WORDS (8): must land on the LONG
    // tier, not fall through to the short one word count alone would
    // suggest for any other question.
    within(delayMs, EVIDENCED_LONG_MS, "long evidenced question");
  },
);

await test(
  "a LONG ANSWER WITH AN INTERNAL PAUSE keeps its continuation grace, then releases on the LONG evidenced window",
  async () => {
    // First half trails on "and" (a HARD continuation word) with NO
    // endpoint claim yet — this must still be read as mid-thought and
    // given the full continuation grace, exactly as before Phase 2.
    const { delayMs, text } = await releaseDelayMs([
      { text: "I wanted to ask about the pricing and", isSpeechFinal: false },
      // The pause: fed well inside CONTINUATION_GRACE_MS, so the grace
      // — not a fresh silence window — is what carries the turn across
      // it. If Phase 2 had weakened this, the turn would have already
      // released on the first half alone.
      {
        text: "also whether there is a discount for early registration.",
        isSpeechFinal: true,
        afterMs: 400,
      },
    ]);
    assert.equal(
      text,
      "I wanted to ask about the pricing and also whether there is a discount for early registration.",
    );
    // Measured from the SECOND segment: the pause already cost its own
    // grace before this was fed, so what remains is the ordinary long
    // evidenced window — not stacked on top of anything.
    within(delayMs, EVIDENCED_LONG_MS, "long answer, resumed after an internal pause");
  },
);

// ═════════════════════════════════════════════════════════════════
section("B. BACKCHANNEL VOCABULARY — what may be ignored while the agent is speaking");

await test("bare acknowledgements are recognised, in English, Hinglish and Devanagari", () => {
  for (const text of [
    "ok", "Okay.", "OK!", "ok ok", "okay okay", "Right.", "sure", "alright",
    "yes", "Yes.", "yeah", "yep", "hmm", "Hmm.", "hmm okay", "mhm",
    "haan", "Haan.", "haan haan", "ji", "ji haan", "theek hai", "achha",
    "got it", "I see.", "Correct.",
    "हाँ", "जी हाँ", "ठीक है", "अच्छा",
  ]) {
    assert.ok(isBareAcknowledgement(text), `must be an acknowledgement: ${JSON.stringify(text)}`);
  }
});

await test("anything carrying content of its own is NOT an acknowledgement", () => {
  for (const text of [
    "ok but what is the price",
    "ok, but",
    "okay so tell me",
    "haan kitna hai",
    "yes I will attend",
    "yes register me",
    "register me",
    "what is this",
    "hello",
    "Hello?",
    "wait",
    "actually",
    "",
    "   ",
  ]) {
    assert.ok(
      !isBareAcknowledgement(text),
      `must NOT be an acknowledgement: ${JSON.stringify(text)}`,
    );
  }
});

await test("no negation is ever an acknowledgement — an objection must always interrupt", () => {
  for (const text of [
    "no",
    "No.",
    "nope",
    "nahi",
    "nahin",
    "नहीं",
    "no thanks",
    "not interested",
  ]) {
    assert.ok(
      !isBareAcknowledgement(text),
      `must NOT be an acknowledgement: ${JSON.stringify(text)}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
console.log("No telephony, TTS, STT, LLM or database request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
