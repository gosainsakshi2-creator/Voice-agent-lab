/**
 * wire-trace-tests.ts — `npm run test:wire-trace`
 *
 * THE DEFECT THIS SUITE EXISTS FOR: `speech_final` IS NOT DELIVERED ON THE
 * WORDS WHEN THE LINE CARRIES ANYTHING OTHER THAN DIGITAL SILENCE.
 *
 * Every other STT test in this repo feeds the detector a CLEAN, invented
 * message sequence — words, then an endpoint. That is why none of them
 * could see this. Measured against the live Deepgram socket on this
 * codebase's own connect parameters, holding the utterance constant and
 * changing ONLY the trailing audio:
 *
 *   trailing audio        delivery lag   speech_final ON THE WORDS
 *   pure digital silence      878ms      true
 *   low-level line noise     1740ms      FALSE  (arrives +2289ms later,
 *                                               in its own empty message)
 *   faint background voice   1988ms      FALSE  (never arrives at all)
 *
 * `endpointing` is VAD-driven, and comfort noise defeats the VAD. So on a
 * real phone line the turn detector sees a chunk-boundary final, spends the
 * full adaptive silence window AND the 700ms chunk-boundary grace on it, and
 * releases the turn BEFORE the endpoint claim ever lands. Replayed through
 * the real detector, that is 3742ms of stt-to-release on a noisy line
 * against 1375ms on a clean one — and the §0c end-of-speech marker arrived
 * 146ms AFTER the turn had already been released, so it bought nothing.
 *
 * WHAT THE FIXTURES ARE. `TRACES` below are VERBATIM CAPTURES off the live
 * Deepgram socket — message order, wall-clock arrival times, transcripts,
 * `is_final`, `speech_final` and word-end timings, at 0.995-0.997x real-time
 * frame pacing. They are not hand-written sequences. That is the whole point:
 * a hand-written sequence is what hid this defect for three passes.
 *
 * SECTION A replays those traces through the REAL `AdaptiveTurnDetector`
 * with real `setTimeout`s, so a release is measured the way a caller
 * experiences it. Every latency test ASSERTS ITS OWN PREMISE — it replays
 * the same trace with the `UtteranceEnd` message removed and requires that
 * it WOULD have been slow — so none of them can quietly stop reproducing
 * the defect it exists for.
 *
 * SECTION B is the adapter's message -> segment mapping, as a pure
 * function, so `UtteranceEnd` becoming a MARKER (and `SpeechStarted`
 * becoming nothing) is asserted without a socket.
 *
 * SECTION C is the late-endpoint mechanism in isolation, and it is mostly
 * NEGATIVE assertions: a late marker must collapse the chunk-boundary
 * grace, and must NOT collapse a continuation grace, a hold grace, or a
 * running confirmation window. Those three are the mid-thought protections
 * the whole optimization is fenced by.
 *
 * Bounds are asserted as RANGES, never as exact values.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, READS THE
 * DATABASE OR TOUCHES GOOGLE.
 */

import assert from "node:assert/strict";

const { AdaptiveTurnDetector } = await import("../../core/session/turn-detection");
const { transcriptEventFromMessage } = await import("../../providers/speech-to-text/deepgram.provider");
const { SupportedLanguage } = await import("../../types/enums");

import type { TranscriptSegment } from "../../types/provider.types";

// ---------------------------------------------------------------
// Harness
// ---------------------------------------------------------------

let passed = 0;
let failed = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver the next message at its captured wall-clock, accurate to ~1ms.
 *
 * `setTimeout` granularity on Windows is ~15ms, and these traces are
 * genuinely tight: Deepgram emits an interim roughly once a second, so the
 * captured inter-message gaps are 1001-1033ms against the detector's
 * 1100ms silence window — about 70ms of headroom. A single sleep overshoot
 * is therefore enough to let the window expire mid-trace and split the
 * turn, which showed up as a ~1-in-7 flake in SECTION A.
 *
 * That was the HARNESS mis-delivering the capture, not the detector
 * misbehaving, so it is fixed here rather than by loosening a bound: the
 * same sleep-then-spin pacing the original wire capture was taken with,
 * so the replay is as faithful in time as it is in content.
 */
async function deliverAt(startMs: number, targetOffsetMs: number): Promise<void> {
  const target = startMs + targetOffsetMs;
  const coarse = target - Date.now() - 4;
  if (coarse > 0) await sleep(coarse);
  while (Date.now() < target) {
    /* spin out the last few ms */
  }
}

function section(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

/** Timer slop. The detector arms real timers, so a release can land a little late. */
const SLOP = 220;

function atMost(actualMs: number, boundMs: number, what: string): void {
  assert.ok(
    actualMs <= boundMs + SLOP,
    `${what}: expected at most ~${boundMs}ms, measured ${actualMs}ms`,
  );
}

function atLeast(actualMs: number, boundMs: number, what: string): void {
  assert.ok(actualMs >= boundMs - SLOP, `${what}: expected at least ~${boundMs}ms, measured ${actualMs}ms`);
}

// ---------------------------------------------------------------
// The captured wire traces
// ---------------------------------------------------------------

/**
 * One Deepgram message, exactly as it came off the socket.
 *
 * `t` is its arrival wall-clock in ms, measured from the first audio frame.
 * `kind` distinguishes the message TYPES the adapter has to tell apart —
 * a `Results` message and an `UtteranceEnd` message are not the same shape
 * and must not be replayed as if they were.
 */
interface WireMessage {
  readonly t: number;
  readonly kind: "Results" | "UtteranceEnd";
  readonly isFinal?: boolean;
  readonly speechFinal?: boolean;
  readonly text?: string;
  /** Deepgram's own audio clock, ms. `null` for a message with no words. */
  readonly lastWordEndMs?: number | null;
}

interface Trace {
  readonly label: string;
  /** Wall clock at which the caller's last speech frame was sent. */
  readonly speechEndWallMs: number;
  /** What the caller actually said, for the "nothing was lost" assertion. */
  readonly spoken: string;
  readonly wire: readonly WireMessage[];
}

const UTTERANCE = "Yeah, actually I wanted to tell you that I was interested in the webinar.";

/**
 * All three captured with `utterance_end_ms=1000` and `vad_events=true` on
 * the connection, at 0.995-0.997x real-time pacing. `SpeechStarted` and
 * `Metadata` messages are omitted from the fixtures because the adapter
 * maps them to nothing — SECTION B asserts that separately, so replaying
 * them here would only test the fixture.
 */
const TRACES: readonly Trace[] = [
  {
    label: "A. pure digital silence",
    speechEndWallMs: 3908,
    spoken: UTTERANCE,
    wire: [
      { t: 1368, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah.", lastWordEndMs: 400 },
      { t: 2490, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you", lastWordEndMs: 1920 },
      { t: 3742, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you that I was", lastWordEndMs: 2720 },
      { t: 4743, kind: "Results", isFinal: true, speechFinal: true, text: UTTERANCE, lastWordEndMs: 3680 },
      { t: 5853, kind: "UtteranceEnd", lastWordEndMs: 3680 },
    ],
  },
  {
    label: "B. low-level line noise",
    speechEndWallMs: 3900,
    spoken: UTTERANCE,
    wire: [
      { t: 1351, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah.", lastWordEndMs: 400 },
      { t: 2334, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you", lastWordEndMs: 1920 },
      { t: 3341, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you that I was", lastWordEndMs: 2720 },
      { t: 4350, kind: "Results", isFinal: false, speechFinal: false, text: UTTERANCE, lastWordEndMs: 3680 },
      // The words settle WITHOUT an endpoint claim. This is the defect.
      { t: 5383, kind: "Results", isFinal: true, speechFinal: false, text: UTTERANCE, lastWordEndMs: 3680 },
      // ...and the word-timing endpoint lands in the SAME millisecond.
      { t: 5383, kind: "UtteranceEnd", lastWordEndMs: 3680 },
      // Deepgram's own VAD endpoint, 2426ms late — after release, always.
      { t: 7809, kind: "Results", isFinal: true, speechFinal: true, text: "", lastWordEndMs: null },
    ],
  },
  {
    label: "C. faint background voice",
    speechEndWallMs: 3906,
    spoken: UTTERANCE,
    wire: [
      { t: 1385, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah.", lastWordEndMs: 400 },
      { t: 2379, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you", lastWordEndMs: 1920 },
      { t: 3331, kind: "Results", isFinal: false, speechFinal: false, text: "Yeah, actually I wanted to tell you that I was", lastWordEndMs: 2720 },
      { t: 4371, kind: "Results", isFinal: false, speechFinal: false, text: UTTERANCE, lastWordEndMs: 3680 },
      { t: 5341, kind: "Results", isFinal: true, speechFinal: false, text: UTTERANCE, lastWordEndMs: 3680 },
      // The background voice keeps the utterance open for another ~4s. This
      // is DEEPGRAM's lag, not ours, and no application change recovers it.
      { t: 5380, kind: "Results", isFinal: false, speechFinal: false, text: "No-no,", lastWordEndMs: 4930 },
      { t: 6406, kind: "Results", isFinal: false, speechFinal: false, text: "No-no, I told you already.", lastWordEndMs: 5810 },
      { t: 7376, kind: "Results", isFinal: false, speechFinal: false, text: "No-no, I told you already. The other thing is", lastWordEndMs: 6930 },
      { t: 8394, kind: "Results", isFinal: false, speechFinal: false, text: "No-no, I told you already. The other thing is completely", lastWordEndMs: 7730 },
      { t: 9341, kind: "Results", isFinal: true, speechFinal: false, text: "No-no, I told you already. The other thing is completely different from that.", lastWordEndMs: 7730 },
      { t: 9342, kind: "UtteranceEnd", lastWordEndMs: 7730 },
    ],
  },
];

/**
 * Replays a trace through the REAL detector using the SAME routing the
 * pipeline uses: an `UtteranceEnd`, and an empty `is_final + speech_final`
 * Results, both become `noteEndOfSpeech()`; every other empty message is
 * dropped; everything else is `feed()`.
 *
 * @param dropUtteranceEnd Replay without the `UtteranceEnd` messages —
 *   i.e. the behaviour before this fix. Used by every latency test to
 *   assert its own premise.
 */
async function replay(
  trace: Trace,
  dropUtteranceEnd = false,
): Promise<{ releases: { atMs: number; text: string }[] }> {
  const detector = new AdaptiveTurnDetector();
  const releases: { atMs: number; text: string }[] = [];
  const start = Date.now();
  detector.onTurnEnd((event) => releases.push({ atMs: Date.now() - start, text: event.text }));

  let previousWordEndMs = 0;
  for (const message of trace.wire) {
    await deliverAt(start, message.t);

    if (message.kind === "UtteranceEnd") {
      if (!dropUtteranceEnd) detector.noteEndOfSpeech();
      continue;
    }
    const text = (message.text ?? "").trim();
    if (text.length === 0) {
      // The adapter forwards an empty message ONLY as an endpoint marker.
      if (message.isFinal === true && message.speechFinal === true) detector.noteEndOfSpeech();
      continue;
    }
    detector.feed({
      text: message.text ?? "",
      isFinal: message.isFinal ?? false,
      isSpeechFinal: message.speechFinal ?? false,
      confidence: 0.92,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: previousWordEndMs,
      endedAtMs: message.lastWordEndMs ?? previousWordEndMs,
    });
    if (message.isFinal === true) previousWordEndMs = message.lastWordEndMs ?? previousWordEndMs;
  }

  // Long enough for every bounded hold in the detector to run out.
  await sleep(6500);
  return { releases };
}

/** Caller stopped talking -> the turn reached the pipeline. */
const sttToRelease = (trace: Trace, releaseAtMs: number): number => releaseAtMs - trace.speechEndWallMs;

// ═════════════════════════════════════════════════════════════════
// SECTION A — the captured traces, through the real detector
// ═════════════════════════════════════════════════════════════════

section("A. CAPTURED WIRE TRACES — stt-to-release, per line condition");

const traceA = TRACES[0] as Trace;
const traceB = TRACES[1] as Trace;
const traceC = TRACES[2] as Trace;

await test("A1. a CLEAN line is unchanged — speech_final already rides along", async () => {
  const withFix = await replay(traceA);
  const withoutFix = await replay(traceA, true);
  assert.equal(withFix.releases.length, 1, "exactly one turn");
  const a = sttToRelease(traceA, (withFix.releases[0] as { atMs: number }).atMs);
  const b = sttToRelease(traceA, (withoutFix.releases[0] as { atMs: number }).atMs);
  console.log(`        clean line: ${b}ms -> ${a}ms stt-to-release`);
  // On a clean line the endpoint is already on the words, so the turn has
  // released long before the UtteranceEnd lands. It must be a NO-OP here:
  // this is the test that catches the fix making a good case worse.
  assert.ok(
    Math.abs(a - b) <= SLOP,
    `a clean line must be unaffected by the fix: ${b}ms -> ${a}ms`,
  );
  atMost(a, 1500, "clean line stt-to-release");
});

await test("A2. a NOISY line: the word-timing endpoint releases the turn ~1.5s sooner", async () => {
  const withoutFix = await replay(traceB, true);
  const withFix = await replay(traceB);
  assert.equal(withFix.releases.length, 1, "exactly one turn");
  assert.equal(withoutFix.releases.length, 1, "exactly one turn without the fix too");
  const before = sttToRelease(traceB, (withoutFix.releases[0] as { atMs: number }).atMs);
  const after = sttToRelease(traceB, (withFix.releases[0] as { atMs: number }).atMs);
  console.log(`        noisy line: ${before}ms -> ${after}ms stt-to-release  (saved ${before - after}ms)`);
  // ASSERTS ITS OWN PREMISE: without the fix this trace MUST be slow.
  atLeast(before, 3400, "the defect must still reproduce without the fix");
  atMost(after, 2400, "noisy line stt-to-release with the fix");
  assert.ok(
    before - after >= 1000,
    `expected at least 1000ms saved on a noisy line, measured ${before - after}ms`,
  );
});

await test("A3. a BACKGROUND VOICE line also releases sooner, and Deepgram's own lag is left alone", async () => {
  const withoutFix = await replay(traceC, true);
  const withFix = await replay(traceC);
  const before = sttToRelease(traceC, (withoutFix.releases[0] as { atMs: number }).atMs);
  const after = sttToRelease(traceC, (withFix.releases[0] as { atMs: number }).atMs);
  console.log(`        background voice: ${before}ms -> ${after}ms stt-to-release  (saved ${before - after}ms)`);
  atLeast(before, 7000, "the defect must still reproduce without the fix");
  assert.ok(before - after >= 1000, `expected at least 1000ms saved, measured ${before - after}ms`);
  // Deepgram did not finalise the caller's words until 9341ms — 5435ms
  // after they stopped — because the background voice kept the utterance
  // open. That is the vendor's, and this fix must NOT be credited with it.
  atLeast(after, 5400, "the vendor's own delivery lag must remain visible, not be claimed as a saving");
});

await test("A4. every trace releases EXACTLY ONE turn — nothing is split at a pause", async () => {
  for (const trace of TRACES) {
    const { releases } = await replay(trace);
    assert.equal(releases.length, 1, `${trace.label}: expected one turn, got ${releases.length}`);
  }
});

await test("A5. the caller's words survive verbatim — the endpoint claim adds no text", async () => {
  for (const trace of TRACES) {
    const { releases } = await replay(trace);
    const text = (releases[0] as { text: string }).text;
    assert.ok(
      text.includes(trace.spoken),
      `${trace.label}: the released turn must contain what the caller said.\n  said:     "${trace.spoken}"\n  released: "${text}"`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — the adapter's message -> segment mapping
// ═════════════════════════════════════════════════════════════════

section("B. THE ADAPTER — UtteranceEnd becomes a MARKER, and SpeechStarted becomes nothing");

/** Minimal well-formed `Results` message. */
function resultsMessage(input: {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  words?: { start: number; end: number }[];
}): unknown {
  return {
    type: "Results",
    channel_index: [0],
    duration: 1,
    start: 0,
    is_final: input.isFinal,
    speech_final: input.speechFinal,
    channel: {
      alternatives: [
        {
          transcript: input.text,
          confidence: 0.93,
          words: input.words ?? [],
        },
      ],
    },
    metadata: {},
  };
}

const mapMessage = (message: unknown): TranscriptSegment | null =>
  transcriptEventFromMessage(message as never, SupportedLanguage.ENGLISH);

await test("B1. UtteranceEnd becomes the EXISTING end-of-speech marker shape", () => {
  const segment = mapMessage({ type: "UtteranceEnd", channel: [0], last_word_end: 3.68 });
  assert.ok(segment !== null, "an UtteranceEnd must be forwarded, not dropped");
  assert.equal(segment.isEndOfSpeechMarker, true, "it must be flagged as a marker");
  assert.equal(segment.text, "", "a marker carries NO text — it must never become a turn");
  assert.equal(segment.isFinal, true);
  assert.equal(segment.isSpeechFinal, true);
  // It carries no word timings, so it must not be readable as a position
  // on the STT stream clock or as an inter-final gap.
  assert.equal(segment.startedAtMs, 0, "a marker must carry no stream position");
  assert.equal(segment.endedAtMs, 0, "a marker must carry no stream position");
});

await test("B2. SpeechStarted is IGNORED — barge-in is not touched by this change", () => {
  assert.equal(
    mapMessage({ type: "SpeechStarted", channel: [0], timestamp: 0.18 }),
    null,
    "vad_events must not inject anything into the transcript stream",
  );
});

await test("B3. Metadata and unknown message types are ignored", () => {
  assert.equal(mapMessage({ type: "Metadata", request_id: "x" }), null);
  assert.equal(mapMessage({ type: "SomethingNew" }), null);
});

await test("B4. an EMPTY Results with is_final + speech_final is still a marker (§0c, unchanged)", () => {
  const segment = mapMessage(resultsMessage({ text: "", isFinal: true, speechFinal: true }));
  assert.ok(segment !== null, "the separately-delivered endpoint must still be forwarded");
  assert.equal(segment.isEndOfSpeechMarker, true);
  assert.equal(segment.text, "");
});

await test("B5. an EMPTY Results WITHOUT speech_final is still dropped (unchanged)", () => {
  assert.equal(mapMessage(resultsMessage({ text: "", isFinal: false, speechFinal: false })), null);
  assert.equal(
    mapMessage(resultsMessage({ text: "   ", isFinal: true, speechFinal: false })),
    null,
    "an empty chunk boundary carries no claim and no words",
  );
});

await test("B6. a Results WITH words maps to a real segment, carrying both claims separately", () => {
  const segment = mapMessage(
    resultsMessage({
      text: "Yes I would like to join.",
      isFinal: true,
      speechFinal: false,
      words: [
        { start: 1.0, end: 1.2 },
        { start: 1.2, end: 2.44 },
      ],
    }),
  );
  assert.ok(segment !== null);
  assert.equal(segment.text, "Yes I would like to join.");
  assert.equal(segment.isFinal, true);
  assert.equal(segment.isSpeechFinal, false, "a chunk boundary must NOT be reported as an endpoint");
  assert.equal(segment.isEndOfSpeechMarker, undefined, "a segment with words is not a marker");
  assert.equal(segment.startedAtMs, 1000);
  assert.equal(segment.endedAtMs, 2440);
});

await test("B7. no mapping can ever produce a marker that carries text", () => {
  const messages: unknown[] = [
    { type: "UtteranceEnd", channel: [0], last_word_end: 1 },
    resultsMessage({ text: "", isFinal: true, speechFinal: true }),
    resultsMessage({ text: "hello there", isFinal: true, speechFinal: true }),
  ];
  for (const message of messages) {
    const segment = mapMessage(message);
    if (segment?.isEndOfSpeechMarker === true) {
      assert.equal(segment.text, "", "a marker with text could be turned into a turn of its own");
    }
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION C — the late-endpoint mechanism, in isolation
// ═════════════════════════════════════════════════════════════════

section("C. LATE ENDPOINT — collapses the chunk-boundary grace, and NOTHING else");

/** Windows this section reasons about, mirrored from `turn-detection.ts`. */
const SILENCE_WINDOW_MS = 1100;
const CHUNK_BOUNDARY_GRACE_MS = 700;
const CONFIRMATION_MS = 300;
const CONTINUATION_GRACE_MS = 800;

/**
 * Feeds one chunk-boundary final (no endpoint claim), lets the silence
 * window expire so the CHUNK-BOUNDARY GRACE is the armed window, then
 * optionally delivers a late endpoint marker inside that grace.
 */
async function graceScenario(
  text: string,
  deliverMarker: boolean,
): Promise<{ delayMs: number; text: string }> {
  const detector = new AdaptiveTurnDetector();
  const start = Date.now();
  const released = new Promise<{ delayMs: number; text: string }>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error("no turn released within 9000ms")), 9_000);
    detector.onTurnEnd((event) => {
      clearTimeout(bail);
      resolve({ delayMs: Date.now() - start, text: event.text });
    });
  });

  detector.feed({
    text,
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });

  if (deliverMarker) {
    // Land 250ms INTO the grace, i.e. after the silence window expired.
    await deliverAt(start, SILENCE_WINDOW_MS + 250);
    detector.noteEndOfSpeech();
  }
  return released;
}

await test("C1. a marker arriving INSIDE the chunk-boundary grace collapses it", async () => {
  const text = "Yeah, actually I wanted to tell you that I was interested in the webinar.";
  const without = await graceScenario(text, false);
  const withMarker = await graceScenario(text, true);
  console.log(`        grace collapse: ${without.delayMs}ms -> ${withMarker.delayMs}ms`);
  // Without: silence window + the whole 700ms grace + a confirmation window.
  atLeast(
    without.delayMs,
    SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS,
    "the grace must still be paid when no endpoint claim ever arrives",
  );
  // With: the grace is abandoned the moment the claim lands; the
  // post-speech confirmation window is still applied.
  assert.ok(
    withMarker.delayMs < without.delayMs - 250,
    `the late marker must shorten the wait: ${without.delayMs}ms -> ${withMarker.delayMs}ms`,
  );
  atMost(withMarker.delayMs, SILENCE_WINDOW_MS + 250 + CONFIRMATION_MS, "collapsed grace");
  assert.equal(withMarker.text, text, "collapsing the grace must not alter the turn text");
});

await test("C2. it collapses the grace for an UNPUNCTUATED turn too — the case that got nothing before", async () => {
  // `isCompleteThought()` is FALSE here (no sentence-final punctuation), so
  // the old `noteEndOfSpeech` set `lastFinalWasEndpoint` and returned,
  // leaving the already-armed 700ms grace to run out for a claim that had
  // ALREADY arrived. This is the one behaviour change in the detector.
  const text = "yeah actually I wanted to tell you that I was interested in the webinar";
  const without = await graceScenario(text, false);
  const withMarker = await graceScenario(text, true);
  console.log(`        unpunctuated grace collapse: ${without.delayMs}ms -> ${withMarker.delayMs}ms`);
  assert.ok(
    without.delayMs - withMarker.delayMs >= 250,
    `expected the dead grace to be dropped: ${without.delayMs}ms -> ${withMarker.delayMs}ms`,
  );
});

await test("C3. a marker must NOT collapse a CONTINUATION grace — mid-thought stays protected", async () => {
  // A dangling conjunction. The silence window expires, `emitTurnEnd` takes
  // the CONTINUATION branch (checked before the chunk-boundary branch), and
  // a marker landing in that window must not cut the caller off: Deepgram
  // saying "they stopped" does not make "...and" a finished thought.
  const detector = new AdaptiveTurnDetector();
  const start = Date.now();
  let releasedAt = 0;
  detector.onTurnEnd(() => {
    releasedAt = Date.now() - start;
  });
  detector.feed({
    text: "I was going to ask about the timing and",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await deliverAt(start, SILENCE_WINDOW_MS + 250);
  detector.noteEndOfSpeech();
  await sleep(2_600);
  assert.ok(releasedAt > 0, "the turn must eventually be released");
  atLeast(
    releasedAt,
    SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS,
    "an unfinished thought must still be given its continuation grace",
  );
});

await test("C4. a marker must NOT collapse a HOLD grace — a caller who asked for a moment gets one", async () => {
  const detector = new AdaptiveTurnDetector();
  const start = Date.now();
  let releasedAt = 0;
  detector.onTurnEnd(() => {
    releasedAt = Date.now() - start;
  });
  detector.feed({
    text: "Wait.",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 500,
  });
  await deliverAt(start, SILENCE_WINDOW_MS + 250);
  detector.noteEndOfSpeech();
  await sleep(3_200);
  assert.ok(releasedAt > 0, "the turn must eventually be released");
  atLeast(releasedAt, SILENCE_WINDOW_MS + 1_200, "a hold phrase must keep its longer grace");
});

await test("C5. a marker still cannot shorten a RUNNING confirmation window", async () => {
  // The in-flight-speech check. The words arrive already endpointed, so the
  // fast path arms the confirmation window itself; a marker inside it is
  // inert. Re-asserted here because C1/C2 widen what a marker may do.
  const detector = new AdaptiveTurnDetector();
  detector.feed({
    text: "Yes I would like to attend the session today.",
    isFinal: true,
    isSpeechFinal: true,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_500,
  });
  const armedAt = Date.now();
  let releasedAt = 0;
  detector.onTurnEnd(() => {
    releasedAt = Date.now() - armedAt;
  });
  await sleep(120);
  detector.noteEndOfSpeech();
  await sleep(1_400);
  assert.ok(releasedAt > 0, "the turn must be released");
  atLeast(releasedAt, CONFIRMATION_MS, "the confirmation window must run its course");
});

await test("C6. a marker arriving AFTER the turn was released is inert", async () => {
  const detector = new AdaptiveTurnDetector();
  let releases = 0;
  detector.onTurnEnd(() => {
    releases += 1;
  });
  detector.feed({
    text: "Haan.",
    isFinal: true,
    isSpeechFinal: true,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 400,
  });
  await sleep(1_200);
  assert.equal(releases, 1, "the turn should already have been released");
  detector.noteEndOfSpeech();
  detector.noteEndOfSpeech();
  await sleep(500);
  assert.equal(releases, 1, "a late marker must never invent a second turn");
});

await test("C7. a marker never moves the adaptive silence threshold", async () => {
  const detector = new AdaptiveTurnDetector();
  const before = detector.getCurrentSilenceTimeoutMs();
  const start = Date.now();
  detector.feed({
    text: "One thing I wanted to ask",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await deliverAt(start, SILENCE_WINDOW_MS + 250);
  detector.noteEndOfSpeech();
  detector.noteEndOfSpeech();
  assert.equal(
    detector.getCurrentSilenceTimeoutMs(),
    before,
    "a text-less marker carries no word timings, so it must not be read as an inter-final gap",
  );
});

// ═════════════════════════════════════════════════════════════════
// SECTION D — the collapsed grace ANNOUNCES the window it arms
// ═════════════════════════════════════════════════════════════════

section("D. COLLAPSED GRACE — the evidenced window it arms is announced (P0-1)");

/**
 * The gap this section exists for. `noteEndOfSpeech` deliberately does
 * NOT decide the collapsed-grace case itself: it calls `rearmTimer(0)`
 * and hands the decision back to `emitTurnEnd`, so every guard —
 * filler, continuation, hold phrase, the interim re-wait — still runs.
 * That early return is BEFORE its own `notifyTurnPending()`, so the
 * evidenced window `emitTurnEnd` then arms on the identical evidence
 * used to be announced by nobody, and the observers that exist to
 * overlap work with that window (the speculative LLM pre-open and the
 * TTS transport hint) got nothing to overlap while the turn paid the
 * window anyway.
 *
 * Every test here asserts release TIMING as well as the notification,
 * because the whole claim of this change is that it moves no window.
 */

/** As `graceScenario`, but also reports what `onTurnPending` saw. */
async function gracePendingScenario(
  text: string,
  opts: { deliverMarker: boolean; isSpeechFinal?: boolean; interimAfterMarker?: boolean } = {
    deliverMarker: true,
  },
): Promise<{ delayMs: number; text: string; pending: string[] }> {
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  const start = Date.now();
  detector.onTurnPending((t) => pending.push(t));
  const released = new Promise<{ delayMs: number; text: string }>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error("no turn released within 9000ms")), 9_000);
    detector.onTurnEnd((event) => {
      clearTimeout(bail);
      resolve({ delayMs: Date.now() - start, text: event.text });
    });
  });

  detector.feed({
    text,
    isFinal: true,
    isSpeechFinal: opts.isSpeechFinal ?? false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });

  if (opts.deliverMarker) {
    // Land 250ms INTO the grace, i.e. after the silence window expired —
    // the same instant `graceScenario` above uses.
    await deliverAt(start, SILENCE_WINDOW_MS + 250);
    if (opts.interimAfterMarker) {
      detector.feed({
        text: "and one more",
        isFinal: false,
        confidence: 0.9,
        language: SupportedLanguage.ENGLISH,
        startedAtMs: 1_000,
        endedAtMs: 1_400,
      });
    }
    detector.noteEndOfSpeech();
  }
  const result = await released;
  return { ...result, pending };
}

await test("D1. a marker collapsing the grace ANNOUNCES the evidenced window it arms", async () => {
  const text = "Yeah, actually I wanted to tell you that I was interested in the webinar.";
  const r = await gracePendingScenario(text, { deliverMarker: true });
  // RE-POINTED for the grace-arm announcement (SECTION E): arming the
  // grace now announces too, a full silence window before the marker
  // lands. So this scenario announces TWICE — once for the grace, once
  // for the evidenced window that replaces it — and what D1 exists to
  // prove is the SECOND one. The count is what discriminates: D2 pairs
  // this against the same scenario with no marker, which announces once.
  assert.deepEqual(
    r.pending,
    [text, text],
    "grace-arm announces, then the collapse announces the evidenced window it arms",
  );
  assert.equal(r.text, text, "and the turn released is that same text");
});

await test("D2. the announcement changes NO timing — release is where C1 already measured it", async () => {
  const text = "Yeah, actually I wanted to tell you that I was interested in the webinar.";
  const without = await gracePendingScenario(text, { deliverMarker: false });
  const withMarker = await gracePendingScenario(text, { deliverMarker: true });
  console.log(`        collapse: ${without.delayMs}ms -> ${withMarker.delayMs}ms`);
  // Byte-for-byte the bounds C1 asserts. If announcing moved a window,
  // one of these would break.
  atLeast(
    without.delayMs,
    SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS,
    "the grace must still be paid when no endpoint claim ever arrives",
  );
  atMost(withMarker.delayMs, SILENCE_WINDOW_MS + 250 + CONFIRMATION_MS, "collapsed grace");
  // RE-POINTED for the grace-arm announcement (SECTION E). The claim
  // still adds an announcement — that is D's whole subject — and the
  // COUNT is now what proves it: one for the grace either way, plus a
  // second only when the claim arrives. Both timing bounds above are
  // untouched.
  assert.deepEqual(without.pending, [text], "no claim arrived: the grace-arm announcement only");
  assert.deepEqual(withMarker.pending, [text, text], "the claim adds the evidenced-window announcement");
});

await test("D3. it announces the UNPUNCTUATED collapse too — the C2 case", async () => {
  const text = "yeah actually I wanted to tell you that I was interested in the webinar";
  const r = await gracePendingScenario(text, { deliverMarker: true });
  // RE-POINTED for the grace-arm announcement — see D1.
  assert.deepEqual(r.pending, [text, text]);
  atMost(r.delayMs, SILENCE_WINDOW_MS + 250 + CONFIRMATION_MS, "collapsed grace, unpunctuated");
});

await test("D4. a MID-THOUGHT turn is never announced, however the grace ends", async () => {
  // `isReleasableThought()` is false for a dangling conjunction, so the
  // gate excludes it at every one of the three call sites. It takes its
  // continuation graces and is released by inference, unannounced —
  // which is the whole reason the gate is the predicate it is.
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  const start = Date.now();
  let releasedAt = 0;
  detector.onTurnPending((t) => pending.push(t));
  detector.onTurnEnd(() => {
    releasedAt = Date.now() - start;
  });
  detector.feed({
    text: "I was going to ask about the timing and",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await deliverAt(start, SILENCE_WINDOW_MS + 250);
  detector.noteEndOfSpeech();
  await sleep(3_400);
  assert.deepEqual(pending, [], "a mid-thought turn must never be announced as pending");
  assert.ok(releasedAt > 0, "the turn must eventually be released");
  atLeast(
    releasedAt,
    SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS,
    "…and it must still get its continuation grace, exactly as C3 asserts",
  );
});

await test("D5. a HOLD PHRASE is never announced either", async () => {
  const r = await gracePendingScenario("Wait.", { deliverMarker: true });
  assert.deepEqual(r.pending, [], "a caller who asked for a moment is not a pending turn");
  atLeast(r.delayMs, SILENCE_WINDOW_MS + 1_200, "and keeps its longer grace, as C4 asserts");
});

await test("D6. an OUTSTANDING INTERIM blocks the announcement — the `!pendingInterim` clause", async () => {
  // Deepgram has shown words it has not finalised, so the detector holds
  // less of this turn than the model would be asked about. The window is
  // still armed; announcing it would pre-open a request for half a
  // sentence.
  const text = "Yes that is right.";
  const r = await gracePendingScenario(text, { deliverMarker: true, interimAfterMarker: true });
  // RE-POINTED for the grace-arm announcement (SECTION E). The grace is
  // armed BEFORE the interim arrives, with no interim outstanding at
  // that instant, so that announcement is correct and expected. The
  // interim then lands, and the clause under test is what stops the
  // SECOND (evidenced) announcement: exactly one, not two.
  assert.deepEqual(
    r.pending,
    [text],
    "the grace-arm announcement stands; the interim blocks the evidenced one",
  );
});

await test("D7. the already-announcing routes are unchanged — still exactly one announcement each", async () => {
  // `feed`'s fast path: `speech_final` rides on the words, so the grace
  // is never armed and this branch is never reached.
  const fast = await gracePendingScenario("Haan.", { deliverMarker: false, isSpeechFinal: true });
  assert.deepEqual(fast.pending, ["Haan."], "feed's fast path still announces once");
  atMost(fast.delayMs, 150, "…and still releases on the short evidenced window");

  // `noteEndOfSpeech`'s own route: the marker lands while the ADAPTIVE
  // SILENCE window is armed, before any grace exists. It decides there
  // and announces there; `emitTurnEnd` must not announce a second time.
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  detector.onTurnPending((t) => pending.push(t));
  detector.feed({
    text: "Yes I would like to attend.",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await sleep(120);
  detector.noteEndOfSpeech();
  await sleep(900);
  assert.deepEqual(pending, ["Yes I would like to attend."], "exactly one announcement, not two");
});

// ═════════════════════════════════════════════════════════════════
// SECTION E — the QUIET announcement: the grace ARMING itself
// ═════════════════════════════════════════════════════════════════

section("E. GRACE ARMING — announced without an endpoint claim, releasing at the same instant");

/**
 * Section D announced the window that REPLACES the grace once the
 * endpoint claim arrives. This section announces the grace ITSELF, a
 * full adaptive silence window earlier — the only site that fires
 * without an endpoint claim in hand.
 *
 * What stands in the claim's place: the whole 1100ms silence window has
 * expired with no segment of any kind, and `emitTurnEnd` has already
 * run its filler, hold-phrase and mid-thought guards above the branch.
 *
 * EVERY test here pairs the run with an identical one that has NO
 * pending subscriber, and requires the release delays to match. That
 * pairing is the proof, not a bound: the two runs differ ONLY in
 * whether `notifyTurnPending` short-circuits on an empty listener set,
 * so a matching release time is direct evidence that announcing moves
 * no window.
 */

/** Release delays are real timers; two runs of the same scenario can differ by this much. */
const PAIR_TOLERANCE_MS = 200;

interface GraceRun {
  readonly delayMs: number;
  readonly text: string;
  readonly pending: string[];
}

/**
 * Feeds one chunk-boundary final (no endpoint claim) and lets the
 * silence window expire so the CHUNK-BOUNDARY GRACE is armed.
 *
 * @param subscribe when false, no `onTurnPending` listener is attached,
 *   so `notifyTurnPending` returns on its empty-set check — i.e. the
 *   code path as it behaved before this change.
 * @param markerAfterGraceArmMs deliver a late endpoint claim this long
 *   after the grace is armed (the P0-1 collapse), or omit for none.
 */
async function graceArmScenario(
  text: string,
  opts: { subscribe: boolean; markerAfterGraceArmMs?: number; resumeAfterGraceArmMs?: number },
): Promise<GraceRun> {
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  const start = Date.now();
  if (opts.subscribe) detector.onTurnPending((t) => pending.push(t));
  const released = new Promise<{ delayMs: number; text: string }>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error("no turn released within 9000ms")), 9_000);
    detector.onTurnEnd((event) => {
      clearTimeout(bail);
      resolve({ delayMs: Date.now() - start, text: event.text });
    });
  });

  detector.feed({
    text,
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });

  if (opts.resumeAfterGraceArmMs !== undefined) {
    await deliverAt(start, SILENCE_WINDOW_MS + opts.resumeAfterGraceArmMs);
    detector.feed({
      text: "and one more thing.",
      isFinal: true,
      isSpeechFinal: true,
      confidence: 0.92,
      language: SupportedLanguage.ENGLISH,
      startedAtMs: 1_400,
      endedAtMs: 2_000,
    });
  }
  if (opts.markerAfterGraceArmMs !== undefined) {
    await deliverAt(start, SILENCE_WINDOW_MS + opts.markerAfterGraceArmMs);
    detector.noteEndOfSpeech();
  }

  const result = await released;
  return { ...result, pending };
}

/** Runs the scenario twice — announced and unannounced — and proves release did not move. */
async function pairedGraceArm(
  what: string,
  text: string,
  opts: { markerAfterGraceArmMs?: number; resumeAfterGraceArmMs?: number } = {},
): Promise<GraceRun> {
  const announced = await graceArmScenario(text, { ...opts, subscribe: true });
  const silent = await graceArmScenario(text, { ...opts, subscribe: false });
  console.log(`        ${what}: release announced=${announced.delayMs}ms unannounced=${silent.delayMs}ms`);
  assert.ok(
    Math.abs(announced.delayMs - silent.delayMs) <= PAIR_TOLERANCE_MS,
    `${what}: announcing moved the release — ${silent.delayMs}ms -> ${announced.delayMs}ms`,
  );
  assert.equal(announced.text, silent.text, `${what}: announcing altered the turn text`);
  assert.deepEqual(silent.pending, [], `${what}: the unannounced control must observe nothing`);
  return announced;
}

const LONG_COMPLETE = "Yes I would like to attend the session today.";

await test("E1. arming the grace announces EXACTLY ONCE, with the held text", async () => {
  const r = await pairedGraceArm("plain grace", LONG_COMPLETE);
  assert.deepEqual(r.pending, [LONG_COMPLETE], "one announcement, carrying the held text");
  assert.equal(r.text, LONG_COMPLETE, "and the released turn is that same text");
});

await test("E2. release timing is unchanged — no claim ever arrives, the inference path stands", async () => {
  // silence window + the whole grace + the inferred confirmation window.
  // Byte-for-byte the path this turn took before the change; only the
  // announcement is new, and E1's pairing proves it costs nothing.
  const r = await pairedGraceArm("grace expires unclaimed", LONG_COMPLETE);
  atLeast(
    r.delayMs,
    SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS,
    "the grace must still be paid in full when no endpoint claim arrives",
  );
  atMost(
    r.delayMs,
    SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS + CONFIRMATION_MS,
    "…and the inferred confirmation window on top of it, and nothing more",
  );
});

await test("E3. a MID-THOUGHT turn reaching the grace is NOT announced", async () => {
  // A dangling conjunction exhausts BOTH continuation graces and then
  // falls through to the chunk-boundary branch. `isReleasableThought()`
  // is what declines it there — which is why the gate is not redundant
  // with the guards above the branch.
  const r = await pairedGraceArm("mid-thought", "I was going to ask about the timing and");
  assert.deepEqual(r.pending, [], "an unfinished thought must never be announced");
  atLeast(
    r.delayMs,
    SILENCE_WINDOW_MS + CONTINUATION_GRACE_MS * 2,
    "…and it must still be given both continuation graces",
  );
});

await test("E4. a HOLD PHRASE reaching the grace is NOT announced", async () => {
  const r = await pairedGraceArm("hold phrase", "Wait.");
  assert.deepEqual(r.pending, [], "a caller who asked for a moment is not a pending turn");
});

await test("E5. a FILLER never reaches the branch at all", async () => {
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  detector.onTurnPending((t) => pending.push(t));
  detector.feed({
    text: "Hmm.",
    isFinal: true,
    isSpeechFinal: false,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 400,
  });
  await sleep(SILENCE_WINDOW_MS + CHUNK_BOUNDARY_GRACE_MS + 400);
  assert.deepEqual(pending, [], "a hesitation sound is dropped, never announced");
});

await test("E6. grace-arm THEN the P0-1 collapse: two announcements, identical text, release unmoved", async () => {
  // The detector announces at both sites. That is correct and harmless:
  // the text is the same, and the pipeline's `startSpeculation` returns
  // early on `speculation.text === text`, so it is ONE request. That
  // half of the claim is asserted in `test:speculative-llm` B15, which
  // counts real requests through the real pipeline.
  const r = await pairedGraceArm("grace-arm + collapse", LONG_COMPLETE, {
    markerAfterGraceArmMs: 250,
  });
  assert.deepEqual(
    r.pending,
    [LONG_COMPLETE, LONG_COMPLETE],
    "both sites announce, and both carry the same text",
  );
  atMost(
    r.delayMs,
    SILENCE_WINDOW_MS + 250 + CONFIRMATION_MS,
    "the collapse still shortens the wait exactly as C1 measures it",
  );
});

await test("E7. the caller RESUMING inside the grace still cancels the pending turn", async () => {
  // The announcement claims nothing about the caller having finished.
  // New speech cancels the turn exactly as it always did, and the turn
  // that is eventually released is the MERGED one — a subscriber sees
  // the cancellation as `onTurnEnd` delivering different text, as
  // `onTurnPending` documents.
  const r = await pairedGraceArm("caller resumes", LONG_COMPLETE, { resumeAfterGraceArmMs: 250 });
  const merged = `${LONG_COMPLETE} and one more thing.`;
  assert.equal(r.pending[0], LONG_COMPLETE, "announced for the text held at the time");
  // The resuming segment carries `speech_final`, so `feed`'s fast path
  // announces the MERGED text — the pre-existing evidenced site, not
  // this change. What matters is the invariant `onTurnPending`
  // documents: an announcement is not a release, and the turn that IS
  // released is whatever the caller actually finished saying.
  assert.deepEqual(r.pending, [LONG_COMPLETE, merged], "the merged turn gets its own announcement");
  assert.equal(r.text, merged, "the released turn is the MERGED text, not the first announced text");
});

await test("E8. a provider reporting NO endpoint claim never reaches the branch", async () => {
  // `isSpeechFinal` absent means "assume endpointed", so
  // `lastFinalWasEndpoint` stays true and the chunk-boundary branch is
  // unreachable — such a provider is byte-for-byte unaffected.
  const detector = new AdaptiveTurnDetector();
  const pending: string[] = [];
  const start = Date.now();
  let releasedAt = 0;
  detector.onTurnPending((t) => pending.push(t));
  detector.onTurnEnd(() => {
    releasedAt = Date.now() - start;
  });
  detector.feed({
    text: LONG_COMPLETE,
    isFinal: true,
    confidence: 0.92,
    language: SupportedLanguage.ENGLISH,
    startedAtMs: 0,
    endedAtMs: 1_000,
  });
  await sleep(SILENCE_WINDOW_MS + CONFIRMATION_MS + 500);
  assert.ok(releasedAt > 0, "the turn must be released");
  atMost(
    releasedAt,
    SILENCE_WINDOW_MS + CONFIRMATION_MS,
    "no grace is taken, so no grace announcement is possible",
  );
  assert.deepEqual(pending, [], "an absent claim is not an endpoint claim and never was");
});

// ---------------------------------------------------------------

console.log(`\n${"=".repeat(78)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log("=".repeat(78));
if (failed > 0) process.exitCode = 1;
