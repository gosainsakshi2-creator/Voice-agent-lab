/**
 * turn-completion-tests.ts — `npm run test:turn-completion`
 *
 * ISSUE: THE AGENT ANSWERS BEFORE THE CALLER HAS FINISHED A LONG
 * THOUGHT.
 *
 * The turn detector's evidenced fast path releases a turn ~150-300ms
 * after Deepgram's `speech_final`, which Deepgram sends after ~400ms of
 * silence. For a short answer that is conclusive. For a long
 * explanation it is not: a caller draws breath at a clause boundary
 * that happens to read as complete — no dangling word, no comma — and
 * the reply lands on the second half of their sentence ~650ms after
 * their last word.
 *
 * THE FIX IS ONE TIER, ON ONE PATH. A turn that is already long (by
 * word count, or by how long the caller has been speaking) takes a
 * wider evidenced confirmation window on the `feed` fast path —
 * `EVIDENCED_CONFIRMATION_LONG_TURN_MS` — and nothing else changes.
 * Short turns keep every window they had.
 *
 * WHAT THIS SUITE IS FOR, per the requirement:
 *
 *   A  a short answer still releases on the tightest window
 *   B  a long, complete, endpointed answer waits the long-turn window
 *   C  several STT segments belonging to one turn are ONE turn
 *   D  a brief mid-sentence pause inside a long turn does not release
 *   E  a genuinely completed long turn still releases, bounded
 *   F  the vocabulary and paths barge-in relies on are untouched here;
 *      the barge-in suites themselves are the assertion for that
 *
 * Timings are wall-clock: the detector arms real `setTimeout`s, so a
 * release is measured the way a caller experiences it. Bounds are
 * asserted as ranges, never exact values. Nothing here contacts a
 * vendor, opens a socket, places a call or touches the database.
 */

import assert from "node:assert/strict";

const { AdaptiveTurnDetector } = await import("../../core/session/turn-detection");
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The detector's own documented windows, restated so a drift shows up here. */
const EVIDENCED_SHORT_MS = 150;
const EVIDENCED_LONG_MS = 250;
const EVIDENCED_OPEN_MS = 300;
const EVIDENCED_LONG_TURN_MS = 600;
/**
 * 2026-09-21 — a complete sentence of more than four words that is not
 * a question takes this on the `feed` fast path instead of the 250/300ms
 * tier, so a natural pause between two sentences of one thought no
 * longer splits the turn. See `EVIDENCED_CONFIRMATION_SENTENCE_MS`.
 */
const EVIDENCED_SENTENCE_MS = 600;
const SILENCE_WINDOW_MS = 1_100;
const CONTINUATION_GRACE_MS = 800;
const LONG_TURN_MIN_WORDS = 12;

/** Timer slack: a real `setTimeout` chain can only ever run late. */
const EARLY = 100;
const LATE = 400;

function within(actual: number, expected: number, what: string): void {
  assert.ok(
    actual >= expected - EARLY && actual <= expected + LATE,
    `${what}: expected ~${expected}ms (-${EARLY}/+${LATE}), measured ${actual}ms`,
  );
}

interface FedSegment {
  readonly text: string;
  readonly isFinal?: boolean;
  readonly isSpeechFinal?: boolean;
  /** Wall-clock pause BEFORE this segment is fed. */
  readonly afterMs?: number;
}

/**
 * Feeds the segments and reports how long after the LAST one the turn
 * released, plus every release observed (so a premature one is visible
 * as a second event rather than hidden).
 */
async function drive(
  segments: readonly FedSegment[],
  settleMs: number,
): Promise<{ releases: Array<{ text: string; atMs: number }>; lastFedAt: number }> {
  const detector = new AdaptiveTurnDetector();
  const releases: Array<{ text: string; atMs: number }> = [];
  let streamMs = 0;
  let lastFedAt = 0;
  detector.onTurnEnd((event) => releases.push({ text: event.text, atMs: Date.now() }));

  for (const segment of segments) {
    if (segment.afterMs !== undefined) await sleep(segment.afterMs);
    streamMs += 1_000;
    const fed: TranscriptSegment = {
      text: segment.text,
      isFinal: segment.isFinal ?? true,
      confidence: 0.95,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: streamMs - 1_000,
      endedAtMs: streamMs,
      ...(segment.isSpeechFinal === undefined ? {} : { isSpeechFinal: segment.isSpeechFinal }),
    };
    detector.feed(fed);
    lastFedAt = Date.now();
  }
  await sleep(settleMs);
  detector.reset();
  return { releases, lastFedAt };
}

async function releaseDelayMs(segments: readonly FedSegment[]): Promise<{ delayMs: number; text: string }> {
  const { releases, lastFedAt } = await drive(segments, 3_500);
  assert.equal(releases.length, 1, `expected exactly one release, saw ${releases.length}: ${JSON.stringify(releases.map((r) => r.text))}`);
  return { delayMs: releases[0]!.atMs - lastFedAt, text: releases[0]!.text };
}

const LONG_COMPLETE =
  "I have been running a small clothing shop in Pune for about two years now and I want to sell online.";
assert.ok(LONG_COMPLETE.split(/\s+/).length >= LONG_TURN_MIN_WORDS, "fixture must be a long turn");

// ═════════════════════════════════════════════════════════════════
section("A. A SHORT ANSWER STILL RESPONDS AT ONCE");

await test("A1. 'Yes.' releases on the shortest evidenced window — unchanged", async () => {
  const { delayMs, text } = await releaseDelayMs([{ text: "Yes.", isSpeechFinal: true }]);
  assert.equal(text, "Yes.");
  within(delayMs, EVIDENCED_SHORT_MS, "short evidenced yes");
});

await test("A2. 'Haan, kar dijiye.' and 'Okay.' keep the same window", async () => {
  for (const line of ["Haan, kar dijiye.", "Okay.", "Theek hai."]) {
    const { delayMs } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
    within(delayMs, EVIDENCED_SHORT_MS, `short confirmation "${line}"`);
  }
});

await test("A3. a short QUESTION keeps the short window", async () => {
  const { delayMs } = await releaseDelayMs([{ text: "What time does it start?", isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_SHORT_MS, "short question");
});

await test("A4. a medium complete sentence under the long-turn threshold takes the sentence window (was the 250ms tier)", async () => {
  const line = "Yes I would like to attend the session today.";
  assert.ok(line.split(/\s+/).length < LONG_TURN_MIN_WORDS);
  const { delayMs } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_SENTENCE_MS, "medium complete turn");
  assert.ok(delayMs > EVIDENCED_LONG_MS + EARLY, `must be wider than the 250ms tier: ${delayMs}ms`);
});

await test("A5. a medium UNPUNCTUATED sentence takes the sentence window too (was the 300ms open tier)", async () => {
  const line = "haan main kal join karungi zaroor";
  assert.ok(line.split(/\s+/).length < LONG_TURN_MIN_WORDS);
  const { delayMs } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_SENTENCE_MS, "medium unpunctuated turn");
  assert.ok(delayMs > EVIDENCED_OPEN_MS + EARLY, `must be wider than the 300ms tier: ${delayMs}ms`);
});

await test("A6. a medium QUESTION keeps the short tier — a finished question is a finished thought", async () => {
  const line = "Can you tell me what the webinar covers?";
  assert.ok(line.split(/\s+/).length > 4);
  const { delayMs } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_SHORT_MS, "medium question");
});

// ═════════════════════════════════════════════════════════════════
section("B. A LONG CONTINUOUS ANSWER WAITS FOR COMPLETION");

await test("B1. a long, complete, endpointed answer waits the long-turn window instead of 250ms", async () => {
  const { delayMs, text } = await releaseDelayMs([{ text: LONG_COMPLETE, isSpeechFinal: true }]);
  assert.equal(text, LONG_COMPLETE);
  within(delayMs, EVIDENCED_LONG_TURN_MS, "long complete endpointed turn");
  assert.ok(delayMs > EVIDENCED_LONG_MS + EARLY, `must be wider than the 250ms tier: ${delayMs}ms`);
  assert.ok(delayMs < SILENCE_WINDOW_MS, `must not become a full silence window: ${delayMs}ms`);
});

await test("B2. a long UNPUNCTUATED answer takes the same long-turn window", async () => {
  const line = "main pune mein ek chhoti kapde ki dukaan chalata hoon pichhle do saal se aur online bechna chahta hoon";
  assert.ok(line.split(/\s+/).length >= LONG_TURN_MIN_WORDS);
  const { delayMs } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
  within(delayMs, EVIDENCED_LONG_TURN_MS, "long unpunctuated endpointed turn");
});

await test("B3. a turn that BECOMES long across segments is long when it is judged", async () => {
  // Two chunk-boundary finals (no endpoint claim) and then the
  // endpointed one: the word count at the moment of the endpoint is
  // what decides the tier, not the size of the last fragment.
  const { delayMs, text } = await releaseDelayMs([
    { text: "I have been running a small clothing shop", isSpeechFinal: false },
    { text: "in Pune for about two years now", isSpeechFinal: false, afterMs: 150 },
    { text: "and I want to sell online.", isSpeechFinal: true, afterMs: 150 },
  ]);
  assert.equal(text, "I have been running a small clothing shop in Pune for about two years now and I want to sell online.");
  within(delayMs, EVIDENCED_LONG_TURN_MS, "turn assembled from three finals");
});

// ═════════════════════════════════════════════════════════════════
section("C. SEVERAL STT SEGMENTS OF ONE TURN ARE ONE TURN");

await test("C1. chunk-boundary finals accumulate into one turn text and release once", async () => {
  const { releases } = await drive(
    [
      { text: "So basically what happened was", isSpeechFinal: false },
      { text: "I saw your ad on Instagram last week", isSpeechFinal: false, afterMs: 200 },
      { text: "and I wanted to know more about it.", isSpeechFinal: true, afterMs: 200 },
    ],
    3_000,
  );
  assert.equal(releases.length, 1, `one caller thought must be one turn, saw ${releases.length}`);
  assert.equal(
    releases[0]!.text,
    "So basically what happened was I saw your ad on Instagram last week and I wanted to know more about it.",
  );
});

await test("C2. an interim in flight is never released as a turn on its own", async () => {
  const { releases } = await drive(
    [
      { text: "I have been running a", isFinal: false, isSpeechFinal: false },
      { text: "I have been running a small shop in Pune", isFinal: false, isSpeechFinal: false, afterMs: 300 },
      { text: "I have been running a small shop in Pune for two years.", isFinal: true, isSpeechFinal: true, afterMs: 300 },
    ],
    2_500,
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.text, "I have been running a small shop in Pune for two years.");
});

// ═════════════════════════════════════════════════════════════════
section("D. A BRIEF MID-SENTENCE PAUSE DOES NOT GET A PREMATURE REPLY");

await test("D1. a long turn that pauses at a complete-looking clause and resumes 450ms later is ONE turn", async () => {
  // The reported shape. The first half reads as finished — no dangling
  // word, no comma — and Deepgram endpoints it after 400ms of breath.
  // Before this change it was released ~250ms later; the caller's
  // second half then arrived to find their thought already answered.
  const { releases } = await drive(
    [
      { text: "I have been running a small clothing shop in Pune for about two years now.", isSpeechFinal: true },
      { text: "And I want to start selling my products online as well.", isSpeechFinal: true, afterMs: 450 },
    ],
    3_000,
  );
  assert.equal(
    releases.length,
    1,
    `the pause must not split the thought — saw ${releases.length} releases: ${JSON.stringify(releases.map((r) => r.text))}`,
  );
  assert.equal(
    releases[0]!.text,
    "I have been running a small clothing shop in Pune for about two years now. And I want to start selling my products online as well.",
  );
});

await test("D2. ...and a second such pause inside the same turn is absorbed too", async () => {
  const { releases } = await drive(
    [
      { text: "I have been running a small clothing shop in Pune for about two years now.", isSpeechFinal: true },
      { text: "Mostly I sell to people in my area.", isSpeechFinal: true, afterMs: 450 },
      { text: "And now I want to go online.", isSpeechFinal: true, afterMs: 450 },
    ],
    3_000,
  );
  assert.equal(releases.length, 1, `saw ${releases.length} releases`);
  assert.ok(releases[0]!.text.endsWith("And now I want to go online."));
});

await test("D3. the same pause inside a SHORT exchange is deliberately unchanged", async () => {
  // Two short complete confirmations 450ms apart were two turns before
  // this change and still are: protecting a short opener would cost
  // every short answer its prompt reply. Stated here so the trade-off
  // is a tested decision, not an accident.
  const { releases } = await drive(
    [
      { text: "Yes.", isSpeechFinal: true },
      { text: "Go ahead.", isSpeechFinal: true, afterMs: 450 },
    ],
    2_000,
  );
  assert.equal(releases.length, 2, "short answers keep today's behaviour exactly");
});

// ═════════════════════════════════════════════════════════════════
section("E. A GENUINELY COMPLETED TURN RELEASES");

await test("E1. a long finished thought is released — once, and inside one second", async () => {
  const { releases, lastFedAt } = await drive([{ text: LONG_COMPLETE, isSpeechFinal: true }], 2_000);
  assert.equal(releases.length, 1);
  const delayMs = releases[0]!.atMs - lastFedAt;
  assert.ok(delayMs < 1_000, `a finished long turn must still be answered promptly: ${delayMs}ms`);
});

await test("E2. a long turn with NO endpoint claim keeps the full inference path — nothing got slower there", async () => {
  // Chunk boundary only: the silence window, then the chunk-boundary
  // grace (700ms), then the inferred confirmation. Unchanged.
  const { delayMs } = await releaseDelayMs([{ text: LONG_COMPLETE, isSpeechFinal: false }]);
  assert.ok(delayMs > SILENCE_WINDOW_MS, `a chunk-boundary final must still wait out the silence window: ${delayMs}ms`);
});

await test("E3. a long MID-THOUGHT turn still gets the silence window and both graces — unchanged", async () => {
  const line = "I have been running a small clothing shop in Pune for about two years now and";
  const { delayMs, text } = await releaseDelayMs([{ text: line, isSpeechFinal: true }]);
  assert.equal(text, line);
  assert.ok(
    delayMs > SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS,
    `a dangling conjunction must still be given room: ${delayMs}ms`,
  );
});

// ═════════════════════════════════════════════════════════════════
section("F. THE OBSERVER HOOK DECIDES NOTHING");

await test("F1. `onContinuationHold` fires only for a mid-thought grace, and the release timing is unchanged with a subscriber", async () => {
  const detector = new AdaptiveTurnDetector();
  const holds: string[] = [];
  const releases: string[] = [];
  detector.onContinuationHold((event) => holds.push(event.text));
  detector.onTurnEnd((event) => releases.push(event.text));
  const fedAt = Date.now();
  detector.feed({
    text: "I have been running a small clothing shop in Pune for about two years now and",
    isFinal: true,
    isSpeechFinal: true,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await sleep(SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS * 2 + 900);
  assert.equal(holds.length, 2, `one hold per continuation grace, saw ${holds.length}`);
  assert.equal(releases.length, 1, "the turn was still released, once");
  void fedAt;
  detector.reset();
});

await test("F2. a complete short turn and a complete long turn never notify a hold", async () => {
  for (const line of ["Yes.", LONG_COMPLETE]) {
    const detector = new AdaptiveTurnDetector();
    let holds = 0;
    detector.onContinuationHold(() => (holds += 1));
    detector.onTurnEnd(() => undefined);
    detector.feed({
      text: line,
      isFinal: true,
      isSpeechFinal: true,
      confidence: 0.95,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: 0,
      endedAtMs: 1_000,
    });
    await sleep(EVIDENCED_LONG_TURN_MS + 500);
    assert.equal(holds, 0, `"${line}" is not a mid-thought pause`);
    detector.reset();
  }
});

console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No call was placed. No vendor, socket or database was touched.");
process.exit(failures.length === 0 ? 0 : 1);
