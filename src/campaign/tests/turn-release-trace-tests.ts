/**
 * turn-release-trace-tests.ts — `npm run test:turn-release-trace`
 *
 * THE TURN-RELEASE TRACE IS TELEMETRY. THESE TESTS PROVE IT REPORTS
 * THE TRUTH, AND THAT ADDING IT CHANGED NOTHING.
 *
 * WHY IT EXISTS. A 2026-09-21 audit of a live call could establish from
 * the source that a caller turn ending on a dangling "because" is held
 * by `looksIncomplete` and then released anyway once
 * `MAX_CONTINUATION_GRACES` is spent. It could NOT establish from the
 * stored telemetry which mechanism produced the ~6.3s hold that was
 * actually observed, because three different paths release the same
 * turn and none of them was recorded:
 *
 *   - the grace cap being reached once;
 *   - the interim re-wait cap being reached;
 *   - `feed` zeroing `continuationGraces` on a late final, so the turn
 *     pays the whole cycle AGAIN — invisible in every stored field.
 *
 * So the trace records WHICH GUARD LET THE TURN THROUGH, whether the
 * released text still read as unfinished at that moment, and what the
 * grace counter did on the way. Section D is the half that matters
 * most: none of it may change a single release.
 *
 * SECTION E covers the other question the audit could not answer from
 * telemetry — whether a reply was interrupted while THINKING or while
 * SPEAKING. `TurnOutcome` already names the THINKING-side supersession
 * but collapses a SPEAKING-side barge-in into `"spoken"`, which is also
 * what an undisturbed reply reports.
 *
 * Timings are wall-clock: the detector arms real `setTimeout`s. Bounds
 * are asserted as ranges, never as exact values.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS
 * THE DATABASE OR TOUCHES GOOGLE.
 */

import assert from "node:assert/strict";

const { AdaptiveTurnDetector } = await import("../../core/session/turn-detection");
const { BargeInController } = await import("../../core/session/barge-in-controller");
const { SupportedLanguage } = await import("../../types/enums");

import type { TurnReleaseTrace } from "../../core/session/turn-detection";

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

/** The detector's own documented windows, restated so a drift shows up here. */
const SILENCE_WINDOW_MS = 1_100;
const CONTINUATION_GRACE_MS = 800;
const MAX_CONTINUATION_GRACES = 2;

/** Timer slack: a real `setTimeout` chain can only ever run late. */
const EARLY = 120;
const LATE = 450;

function within(actual: number, expected: number, what: string): void {
  assert.ok(
    actual >= expected - EARLY && actual <= expected + LATE,
    `${what}: expected ~${expected}ms (-${EARLY}/+${LATE}), measured ${actual}ms`,
  );
}

interface FedItem {
  readonly text: string;
  readonly isFinal?: boolean;
  readonly isSpeechFinal?: boolean;
  /** Feed a standalone end-of-speech MARKER instead of a segment. */
  readonly marker?: true;
  /** Wall-clock pause before this item, so a timer can fire between two of them. */
  readonly afterMs?: number;
}

interface Released {
  readonly delayMs: number;
  readonly text: string;
  readonly trace: TurnReleaseTrace | undefined;
}

/**
 * Feeds one utterance and reports how long the detector held it, the
 * text it released, and the trace it recorded for that release.
 *
 * The trace is consumed INSIDE the `onTurnEnd` listener, which is the
 * same place and the same ordering the pipeline reads it at — so a
 * snapshot/clear mistake shows up here rather than only in production.
 */
async function release(items: readonly FedItem[], timeoutMs = 12_000): Promise<Released> {
  const detector = new AdaptiveTurnDetector();
  let fedAt = 0;
  let streamMs = 0;

  const released = new Promise<Released>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no turn released within ${timeoutMs}ms`)),
      timeoutMs,
    );
    detector.onTurnEnd((event) => {
      clearTimeout(timer);
      resolve({
        delayMs: Date.now() - fedAt,
        text: event.text,
        trace: detector.consumeReleaseTrace(),
      });
    });
  });

  for (const item of items) {
    if (item.afterMs !== undefined) await sleep(item.afterMs);
    if (item.marker) {
      detector.noteEndOfSpeech();
      fedAt = Date.now();
      continue;
    }
    streamMs += 1_000;
    detector.feed({
      text: item.text,
      isFinal: item.isFinal ?? true,
      confidence: 0.95,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: streamMs - 1_000,
      endedAtMs: streamMs,
      ...(item.isSpeechFinal === undefined ? {} : { isSpeechFinal: item.isSpeechFinal }),
    });
    fedAt = Date.now();
  }

  return released;
}

function traceOf(r: Released): TurnReleaseTrace {
  assert.ok(r.trace !== undefined, "a streaming turn must always carry a release trace");
  return r.trace;
}

// ═════════════════════════════════════════════════════════════════
section("A. AN ORDINARY COMPLETED TURN — telemetry is emitted, and says 'nothing held this'");
// ═════════════════════════════════════════════════════════════════

await test("A1. a complete, endpointed thought reports reason=confirmed and no grace activity", async () => {
  const r = await release([{ text: "Yes, I will attend.", isSpeechFinal: true }]);
  const t = traceOf(r);
  assert.equal(t.releaseReason, "confirmed", "no guard wanted to hold a finished thought");
  assert.equal(t.heldTextReadsUnfinished, false);
  assert.equal(t.continuationGracesAtRelease, 0);
  assert.deepEqual(t.continuationGraceTrace, [], "no grace was ever armed");
  assert.deepEqual(t.continuationGraceResets, [], "nothing was discarded");
});

await test("A2. an unpunctuated but endpointed thought also reports reason=confirmed", async () => {
  // `looksIncomplete` is what holds a turn, not the absence of a full
  // stop — so this must NOT be reported as a denied hold.
  const r = await release([{ text: "main kal join karungi", isSpeechFinal: true }]);
  const t = traceOf(r);
  assert.equal(t.releaseReason, "confirmed");
  assert.equal(t.heldTextReadsUnfinished, false);
});

await test("A3. the trace is cleared on read — a second consume reports absence", async () => {
  const detector = new AdaptiveTurnDetector();
  const seen: (TurnReleaseTrace | undefined)[] = [];
  detector.onTurnEnd(() => {
    seen.push(detector.consumeReleaseTrace());
    seen.push(detector.consumeReleaseTrace());
  });
  detector.feed({
    text: "Yes.",
    isFinal: true,
    isSpeechFinal: true,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 500,
  });
  await sleep(SILENCE_WINDOW_MS + 900);
  assert.equal(seen.length, 2, "the listener must have run exactly once");
  assert.ok(seen[0] !== undefined, "the first read returns this turn's trace");
  assert.equal(seen[1], undefined, "the second read must not re-report it");
});

// ═════════════════════════════════════════════════════════════════
section("B. AN UNFINISHED TURN — the audit's exact case, now visible");
// ═════════════════════════════════════════════════════════════════

await test("B1. a turn ending on a dangling 'because' reports grace_cap_reached WITH readsUnfinished=true", async () => {
  // The live Turn 2 from the 2026-09-21 audit, in the shape Soniox
  // delivers it: a word-bearing final that is NOT an endpoint claim,
  // then the endpoint marker arriving separately.
  const r = await release([
    { text: "Anything different initially, because", isSpeechFinal: false },
    { text: "", marker: true, afterMs: 150 },
  ]);
  const t = traceOf(r);
  assert.equal(
    t.releaseReason,
    "grace_cap_reached",
    "the detector still WANTED to hold this; only the cap released it",
  );
  assert.equal(
    t.heldTextReadsUnfinished,
    true,
    "the released text still read as unfinished AT RELEASE — this pairing is the defect signature",
  );
  assert.equal(t.continuationGracesAtRelease, MAX_CONTINUATION_GRACES);
  assert.deepEqual(t.continuationGraceTrace, [1, 2], "both graces were armed, in order");
  assert.equal(r.text, "Anything different initially, because", "the text is released verbatim");
});

await test("B2. a caller who asks for a moment and then goes quiet also reports grace_cap_reached", async () => {
  const r = await release([{ text: "wait", isSpeechFinal: true }]);
  const t = traceOf(r);
  assert.equal(t.releaseReason, "grace_cap_reached");
  // "wait" reaches the grace through `askedForAMoment`, NOT through
  // `looksIncomplete` — so the two fields must disagree here. Recording
  // both is what keeps `grace_cap_reached + readsUnfinished` a clean
  // signature for the mid-sentence case rather than a catch-all.
  assert.equal(t.heldTextReadsUnfinished, false, "'wait' is a request for time, not a fragment");
  assert.deepEqual(t.continuationGraceTrace, [1, 2]);
});

await test("B2b. heldTextReadsUnfinished is looksIncomplete, NOT readsAsUnfinishedThought", async () => {
  // The documented divergence, pinned so a future refactor cannot
  // quietly swap the predicate: "hold on" ends on the dangling "on",
  // so `looksIncomplete` is true, while `readsAsUnfinishedThought`
  // filters hold phrases out first and reports false. The trace must
  // report the predicate the GUARD actually consults.
  const { readsAsUnfinishedThought } = await import("../../core/session/turn-detection");
  assert.equal(readsAsUnfinishedThought("hold on"), false, "the exported helper filters hold phrases");
  const r = await release([{ text: "hold on", isSpeechFinal: true }]);
  const t = traceOf(r);
  assert.equal(t.releaseReason, "grace_cap_reached");
  assert.equal(
    t.heldTextReadsUnfinished,
    true,
    "the trace reports looksIncomplete, which sees the dangling 'on'",
  );
});

await test("B3. a turn with no endpoint claim at all reports chunk_grace_cap_reached", async () => {
  // Complete text, so no continuation grace applies; `speech_final`
  // never arrives, so the chunk-boundary grace is the guard that runs
  // out. A different label from B1, on purpose.
  const r = await release([{ text: "I would like to join the session.", isSpeechFinal: false }]);
  const t = traceOf(r);
  assert.equal(t.releaseReason, "chunk_grace_cap_reached");
  assert.equal(t.heldTextReadsUnfinished, false);
  assert.deepEqual(t.continuationGraceTrace, [], "no continuation grace was involved");
});

// ═════════════════════════════════════════════════════════════════
section("C. A GRACE RESET IS OBSERVABLE — the mechanism no field could show");
// ═════════════════════════════════════════════════════════════════

await test("C1. a late final mid-grace records the discarded count AND the kind of final", async () => {
  // Spend both graces on "...because", then let a further final land.
  // `feed` zeroes `continuationGraces`, so the turn pays the whole
  // cycle again — which before this trace was indistinguishable from a
  // single pass.
  const r = await release([
    { text: "Anything different initially, because", isSpeechFinal: false },
    // Long enough for the silence window AND both graces to expire.
    {
      text: "we have to update everything",
      isSpeechFinal: false,
      afterMs: SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS * MAX_CONTINUATION_GRACES + 400,
    },
  ]);
  const t = traceOf(r);
  assert.equal(t.continuationGraceResets.length, 1, "exactly one reset discarded graces");
  assert.equal(
    t.continuationGraceResets[0]?.gracesDiscarded,
    MAX_CONTINUATION_GRACES,
    "both spent graces were thrown away by the late final",
  );
  assert.equal(
    t.continuationGraceResets[0]?.source,
    "chunk_final",
    "a final carrying `isSpeechFinal: false` — the Soniox shape — must be labelled as such",
  );
  assert.equal(r.text, "Anything different initially, because we have to update everything");
});

await test("C2. an ENDPOINTED late final is labelled differently from a chunk final", async () => {
  const r = await release([
    { text: "and I was going to", isSpeechFinal: false },
    {
      text: "ask about the timing.",
      isSpeechFinal: true,
      afterMs: SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS + 200,
    },
  ]);
  const t = traceOf(r);
  assert.ok(t.continuationGraceResets.length >= 1, "the late final discarded at least one grace");
  assert.equal(
    t.continuationGraceResets[0]?.source,
    "endpointed_final",
    "an endpointed final must not be reported as a chunk boundary",
  );
});

await test("C3. an ordinary turn records NO reset — the array is not noise", async () => {
  const r = await release([{ text: "Yes, that's right.", isSpeechFinal: true }]);
  assert.deepEqual(traceOf(r).continuationGraceResets, []);
});

// ═════════════════════════════════════════════════════════════════
section("D. BEHAVIOUR IS UNCHANGED — the trace observes, it does not decide");
// ═════════════════════════════════════════════════════════════════

await test("D1. a complete endpointed turn still releases on the evidenced window, not later", async () => {
  const r = await release([{ text: "Yes, I will attend.", isSpeechFinal: true }]);
  // The evidenced short tier (150ms) — unchanged by the trace. Asserted
  // as an upper bound: if the trace had perturbed a guard, this turn
  // would fall back to the full silence window and blow past it.
  assert.ok(
    r.delayMs < SILENCE_WINDOW_MS,
    `an evidenced release must not pay a silence window; measured ${r.delayMs}ms`,
  );
});

await test("D2. a mid-thought turn still pays exactly silence + both graces", async () => {
  const r = await release([
    { text: "Anything different initially, because", isSpeechFinal: false },
    { text: "", marker: true, afterMs: 150 },
  ]);
  // The marker sets `lastFinalWasEndpoint`, so the chunk-boundary grace
  // is skipped and the sequence is: silence window, grace, grace, then
  // the 300ms post-grace confirmation. Same arithmetic as before the
  // trace existed.
  within(
    r.delayMs,
    SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS * MAX_CONTINUATION_GRACES + 300 - 150,
    "mid-thought hold",
  );
});

await test("D3. the caller carrying on still CANCELS a pending release", async () => {
  // The confirmation stage's whole purpose. If the trace had disturbed
  // `stage` or the timer, this would release twice or release early.
  const r = await release([
    { text: "I wanted to ask", isSpeechFinal: true },
    { text: "what time the session starts.", isSpeechFinal: true, afterMs: 80 },
  ]);
  assert.equal(
    r.text,
    "I wanted to ask what time the session starts.",
    "both finals must land in ONE turn",
  );
});

await test("D4. a hesitation sound is still not a turn", async () => {
  // The filler is dropped by `emitTurnEnd`, so the silence window must
  // actually EXPIRE on it before the real words arrive. Fed sooner,
  // the two accumulate into one turn — which is also correct, and is
  // what D3 covers.
  const r = await release([
    { text: "umm", isSpeechFinal: true },
    { text: "yes I will join.", isSpeechFinal: true, afterMs: SILENCE_WINDOW_MS + 500 },
  ]);
  assert.equal(r.text, "yes I will join.", "the filler must have been dropped, not released");
});

await test("D5. forceEndTurn still releases immediately, and is labelled as forced", async () => {
  const detector = new AdaptiveTurnDetector();
  let trace: TurnReleaseTrace | undefined;
  let text = "";
  detector.onTurnEnd((event) => {
    text = event.text;
    trace = detector.consumeReleaseTrace();
  });
  detector.feed({
    text: "and I was going to",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.95,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  detector.forceEndTurn();
  assert.equal(text, "and I was going to", "force must bypass every guard, as it always has");
  assert.equal(trace?.releaseReason, "forced");
  // Still reported honestly: the text WAS unfinished, force or not.
  assert.equal(trace?.heldTextReadsUnfinished, true);
});

// ═════════════════════════════════════════════════════════════════
section("E. THINKING SUPERSESSION vs SPEAKING BARGE-IN — now distinguishable");
// ═════════════════════════════════════════════════════════════════

await test("E1. a barge-in during THINKING reports phase=thinking", () => {
  const c = new BargeInController();
  c.beginThinking();
  c.triggerBargeIn();
  assert.equal(c.consumeBargeInPhase(), "thinking");
});

await test("E2. a barge-in during SPEAKING reports phase=speaking", () => {
  const c = new BargeInController();
  c.beginThinking();
  c.beginSpeaking();
  c.triggerBargeIn();
  assert.equal(
    c.consumeBargeInPhase(),
    "speaking",
    "both handles are live while audio plays; the LATER phase is the one interrupted",
  );
});

await test("E3. the two are not conflated across consecutive replies", () => {
  const c = new BargeInController();
  c.beginThinking();
  c.beginSpeaking();
  c.triggerBargeIn();
  assert.equal(c.consumeBargeInPhase(), "speaking");
  c.reset();
  c.beginThinking();
  c.triggerBargeIn();
  assert.equal(c.consumeBargeInPhase(), "thinking", "the previous reply's phase must not leak");
});

await test("E4. a reply with NO barge-in reports absence, not a stale phase", () => {
  const c = new BargeInController();
  c.beginThinking();
  c.beginSpeaking();
  c.triggerBargeIn();
  assert.equal(c.consumeBargeInPhase(), "speaking");
  // Next reply, undisturbed.
  c.reset();
  c.beginThinking();
  c.beginSpeaking();
  assert.equal(c.consumeBargeInPhase(), undefined, "no barge-in means no label");
});

await test("E5. a barge-in OUTSIDE a turn cannot mislabel the next turn", () => {
  // The greeting is cancelled by the caller talking over it. That
  // barge-in belongs to no recorded turn, and `beginThinking` is the
  // reply-cycle boundary that must clear it.
  const c = new BargeInController();
  c.beginSpeaking();
  c.triggerBargeIn();
  c.reset();
  c.beginThinking();
  assert.equal(
    c.consumeBargeInPhase(),
    undefined,
    "the greeting's barge-in must not be attributed to the first real turn",
  );
});

await test("E6. the first trigger of a reply wins — the unwind cannot overwrite it", () => {
  const c = new BargeInController();
  c.beginThinking();
  c.beginSpeaking();
  c.triggerBargeIn();
  c.triggerBargeIn();
  assert.equal(c.consumeBargeInPhase(), "speaking");
});

await test("E7. triggering with nothing active is still the documented no-op", () => {
  const c = new BargeInController();
  assert.doesNotThrow(() => c.triggerBargeIn());
  assert.equal(c.consumeBargeInPhase(), "idle");
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
