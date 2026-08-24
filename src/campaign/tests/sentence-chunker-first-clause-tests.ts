/**
 * sentence-chunker-first-clause-tests.ts
 *   npx tsx src/campaign/tests/sentence-chunker-first-clause-tests.ts
 *
 * FOCUSED REGRESSION SUITE for one defect in `SentenceChunker`:
 * the first-chunk clause escape tested only the FIRST clause boundary
 * in the buffer (`CLAUSE_BOUNDARY.exec` is non-global), so when the
 * opening clause was shorter than `MIN_FIRST_CLAUSE_LENGTH` (90) the
 * escape gave up on the whole reply — it never rescanned for a later
 * clause boundary that DID qualify. The approved script's sentences
 * open with a comma at ~40-60 characters, so the escape effectively
 * never fired and the caller waited for the full sentence end.
 *
 * This is the same bug class the sentence path already fixed (see the
 * long note on `firstQualifyingSentenceEnd` in sentence-chunker.ts);
 * the clause path was never given the same treatment.
 *
 * Run BEFORE the fix, the tests in the "DEFECT" section FAIL — that
 * failure is the proof the bug exists. Run AFTER the fix, everything
 * passes. Every test in the "UNCHANGED" sections passes on BOTH sides
 * of the fix — they pin all surrounding behaviour byte-for-byte:
 * `MIN_FIRST_CLAUSE_LENGTH` itself, sentence-boundary precedence,
 * forced-cut valves, whitespace requirements, non-first-chunk rules
 * and `flush()`.
 *
 * Pure unit tests over the real `SentenceChunker`. NOTHING HERE
 * PLACES A CALL, OPENS A SOCKET OR CONTACTS A VENDOR.
 */

import assert from "node:assert/strict";

const { SentenceChunker } = await import("../../core/session/sentence-chunker");

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);

// ═════════════════════════════════════════════════════════════════
// Shared fixtures. Lengths are asserted as PRECONDITIONS inside each
// test rather than trusted, so a miscounted string fails loudly as a
// bad fixture instead of silently testing the wrong thing.
//
// None of these contain sentence-final punctuation (. ! ? ।) unless a
// test is explicitly about the sentence path, so the clause escape is
// the only mechanism that can produce a cut.
// ═════════════════════════════════════════════════════════════════

/** Opening clause, comma at < 90 chars — the shape the approved script produces. */
const SHORT_OPEN = "We show Flexi Genie building your funnel live on screen,";
/** Second clause; cumulative length crosses MIN_FIRST_CLAUSE_LENGTH (90). */
const SECOND_CLAUSE = " it also automates your emails and payments,";
/** Run-on tail with no boundary of any kind. */
const TAIL = " with zero tools needed";

/** The prefix a correct clause escape must cut at (trailing space trimmed). */
const QUALIFYING_PREFIX = (SHORT_OPEN + SECOND_CLAUSE).trim();

function assertFixturePreconditions(): void {
  // First clause boundary is under the 90-char minimum.
  assert.ok(SHORT_OPEN.endsWith(","), "fixture: SHORT_OPEN must end at a clause boundary");
  assert.ok(SHORT_OPEN.length < 90, `fixture: SHORT_OPEN must be < 90 chars (is ${SHORT_OPEN.length})`);
  // Second clause boundary qualifies.
  assert.ok(QUALIFYING_PREFIX.endsWith(","), "fixture: second clause must end at a clause boundary");
  assert.ok(
    QUALIFYING_PREFIX.length >= 90,
    `fixture: qualifying prefix must be >= 90 chars (is ${QUALIFYING_PREFIX.length})`,
  );
  // The whole buffer stays under the first-chunk forced-cut valve
  // (180), so the ONLY thing that can cut is the clause escape.
  const whole = SHORT_OPEN + SECOND_CLAUSE + TAIL;
  assert.ok(whole.length < 180, `fixture: whole text must be < 180 chars (is ${whole.length})`);
  // No sentence-final punctuation anywhere.
  assert.ok(!/[.!?।]/u.test(whole), "fixture: text must contain no sentence-final punctuation");
}

// ═════════════════════════════════════════════════════════════════
section("THE DEFECT — a later qualifying clause must be found");
// These FAIL on the pre-fix implementation (the proof of the bug) and
// PASS after it.
// ═════════════════════════════════════════════════════════════════

await test("first clause < 90, later clause >= 90 → the later clause IS cut (was: no cut at all)", () => {
  assertFixturePreconditions();
  const chunker = new SentenceChunker();
  const chunks = chunker.push(SHORT_OPEN + SECOND_CLAUSE + TAIL);
  // Pre-fix: `chunks` is [] — CLAUSE_BOUNDARY.exec saw only the first
  // comma (< 90), gave up, and the forced-cut valve (180) was not
  // reached, so the caller kept waiting.
  assert.equal(chunks.length, 1, `expected exactly one chunk, got ${chunks.length}: ${JSON.stringify(chunks)}`);
});

await test("the chunk ends EXACTLY at the first qualifying clause boundary", () => {
  const chunker = new SentenceChunker();
  const chunks = chunker.push(SHORT_OPEN + SECOND_CLAUSE + TAIL);
  assert.deepEqual(chunks, [QUALIFYING_PREFIX]);
  // And the tail is still buffered, returned intact by flush().
  assert.equal(chunker.flush(), TAIL.trim());
});

await test("multiple qualifying clauses → the FIRST qualifying one is selected, not a later one", () => {
  // Clause boundaries at <90 (skipped), >=90 (selected), and a third
  // even later (must NOT be selected).
  const thirdTail = " with zero tools needed, and no coding either";
  assert.ok(!/[.!?।]/u.test(thirdTail), "fixture: no sentence punctuation");
  assert.ok((SHORT_OPEN + SECOND_CLAUSE + thirdTail).length < 180, "fixture: under forced-cut valve");
  const chunker = new SentenceChunker();
  const chunks = chunker.push(SHORT_OPEN + SECOND_CLAUSE + thirdTail);
  assert.deepEqual(chunks, [QUALIFYING_PREFIX]);
});

await test("clause characters other than comma qualify the same way (semicolon)", () => {
  const opening = "z".repeat(50) + ", ";
  const toSemicolon = "z".repeat(45) + ";";
  const text = opening + toSemicolon + " tail words";
  const prefix = (opening + toSemicolon).trim();
  assert.ok(opening.trim().length < 90, "fixture: first clause under minimum");
  assert.ok(prefix.length >= 90, `fixture: semicolon prefix must qualify (is ${prefix.length})`);
  assert.ok(text.length < 180, "fixture: under forced-cut valve");
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push(text), [prefix]);
});

await test("streaming delta-by-delta produces the same cut as one whole push", () => {
  const whole = SHORT_OPEN + SECOND_CLAUSE + TAIL;
  const chunker = new SentenceChunker();
  const chunks: string[] = [];
  for (let i = 0; i < whole.length; i += 3) {
    chunks.push(...chunker.push(whole.slice(i, i + 3)));
  }
  assert.deepEqual(chunks, [QUALIFYING_PREFIX]);
  assert.equal(chunker.flush(), TAIL.trim());
});

// ═════════════════════════════════════════════════════════════════
section("UNCHANGED — MIN_FIRST_CLAUSE_LENGTH is exactly 90, untouched");
// ═════════════════════════════════════════════════════════════════

await test("a clause whose prefix trims to exactly 89 chars is NOT cut", () => {
  // "x"*88 + "," = 89 trimmed chars at the boundary — one short.
  const chunker = new SentenceChunker();
  const chunks = chunker.push("x".repeat(88) + "," + " tail here");
  assert.deepEqual(chunks, []);
});

await test("a clause whose prefix trims to exactly 90 chars IS cut (both pre- and post-fix)", () => {
  // "x"*89 + "," = 90 trimmed chars at the boundary — exactly enough.
  // This is also the ONLY clause in the buffer, so it passes on the
  // pre-fix code too: it pins the constant, not the defect.
  const prefix = "x".repeat(89) + ",";
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push(prefix + " tail here"), [prefix]);
});

await test("no clause shorter than 90 can ever be selected, however many there are", () => {
  // Three clause boundaries, all with prefixes < 90, total < 180,
  // no sentence end: nothing may cut, and flush returns everything.
  const text = "short one, short two, short three here and some words after";
  assert.ok(text.length < 90, "fixture: even the whole text is under the minimum");
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push(text), []);
  assert.equal(chunker.flush(), text.trim());
});

// ═════════════════════════════════════════════════════════════════
section("UNCHANGED — sentence-boundary rules keep precedence");
// ═════════════════════════════════════════════════════════════════

await test("a qualifying sentence end in the buffer wins over an earlier qualifying clause", () => {
  const sentence = SHORT_OPEN + SECOND_CLAUSE + " and it saves you hours every single day.";
  const text = sentence + " Also more";
  assert.ok(sentence.length < 180, "fixture: under first-chunk forced-cut valve");
  const chunker = new SentenceChunker();
  // The sentence scan runs first and finds a full stop, so the cut is
  // the whole sentence — identical to pre-fix behaviour.
  assert.deepEqual(chunker.push(text), [sentence]);
  assert.equal(chunker.flush(), "Also more");
});

await test("a too-short opening sentence still merges into the next one (sentence scan-past)", () => {
  // "Perfect!" is 8 chars — under MIN_FIRST_CHUNK_LENGTH (40) — so the
  // scan skips it and cuts at the NEXT sentence end, exactly as the
  // existing firstQualifyingSentenceEnd note documents.
  const merged = "Perfect! We will show the funnel builder live today.";
  assert.ok(merged.length >= 40 && merged.length < 90, "fixture: merged sentence qualifies by length");
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push(merged + " Then questions come"), [merged]);
});

// ═════════════════════════════════════════════════════════════════
section("UNCHANGED — forced-cut valves when no clause qualifies");
// ═════════════════════════════════════════════════════════════════

await test("run-on with only a sub-90 clause: forced cut at 180 lands on that clause, as before", () => {
  const opening = "one two three four five six seven eight nine ten eleven twelve,";
  assert.ok(opening.trim().length < 90, "fixture: the only clause is under the minimum");
  const runOn = " word".repeat(30); // 150 chars, no punctuation
  const text = opening + runOn;
  assert.ok(text.length >= 180, `fixture: must trip the first-chunk forced-cut valve (is ${text.length})`);
  assert.ok(!/[.!?।;:]/u.test(text), "fixture: no other boundaries");
  const chunker = new SentenceChunker();
  const chunks = chunker.push(text);
  // Pre-fix AND post-fix: the escape declines (< 90), the valve fires
  // at 180 and prefers the last clause inside the window — the comma.
  assert.deepEqual(chunks, [opening]);
});

await test("run-on with no punctuation at all: forced cut at a word boundary, as before", () => {
  const text = "word ".repeat(40); // 200 chars, no punctuation anywhere
  const chunker = new SentenceChunker();
  const chunks = chunker.push(text);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.length <= 180, "cut must land inside the first-chunk window");
  assert.ok(chunks[0]!.endsWith("word"), "cut must land on a whole word");
});

// ═════════════════════════════════════════════════════════════════
section("UNCHANGED — punctuation/whitespace semantics");
// ═════════════════════════════════════════════════════════════════

await test("a clause boundary needs trailing whitespace — a comma at buffer end never cuts", () => {
  const prefix = "y".repeat(95) + ",";
  const chunker = new SentenceChunker();
  // The comma is the last character the stream has delivered; "the
  // buffer ends here" is not evidence the clause ended (same rule the
  // sentence boundary documents). No cut yet...
  assert.deepEqual(chunker.push(prefix), []);
  // ...until the following whitespace lands.
  assert.deepEqual(chunker.push(" next words"), [prefix]);
});

// ═════════════════════════════════════════════════════════════════
section("UNCHANGED — non-first chunks and flush()");
// ═════════════════════════════════════════════════════════════════

await test("the clause escape is FIRST-CHUNK ONLY: a >= 90 clause never cuts a later chunk", () => {
  const chunker = new SentenceChunker();
  // Emit a first chunk on an ordinary sentence end.
  const opening = "This is the opening sentence of the reply we cut.";
  assert.deepEqual(chunker.push(opening + " "), [opening]);
  // Now a non-first buffer: a qualifying clause, no sentence end,
  // under the 300-char non-first valve. Must NOT cut — later chunks
  // use the stricter sentence-only rule, exactly as before.
  const second = "m".repeat(120) + ", " + "tail words follow here";
  assert.ok(second.length < 300, "fixture: under the non-first forced-cut valve");
  assert.deepEqual(chunker.push(second), []);
  assert.equal(chunker.flush(), second.trim());
});

await test("flush() resets first-chunk state: the clause escape re-arms for the next reply", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push(SHORT_OPEN + SECOND_CLAUSE + TAIL), [QUALIFYING_PREFIX]);
  assert.equal(chunker.flush(), TAIL.trim());
  // A fresh reply through the SAME chunker instance behaves identically.
  assert.deepEqual(chunker.push(SHORT_OPEN + SECOND_CLAUSE + TAIL), [QUALIFYING_PREFIX]);
  assert.equal(chunker.flush(), TAIL.trim());
});

await test("flush() on an empty buffer returns undefined, as before", () => {
  const chunker = new SentenceChunker();
  assert.equal(chunker.flush(), undefined);
  chunker.push("   ");
  assert.equal(chunker.flush(), undefined);
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`\nFailed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exitCode = 1;
}
