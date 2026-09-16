/**
 * first-turn-total-persistence-tests.ts — `npm run test:first-turn-total`
 *
 * REGRESSION GUARD for the call-metrics persistence failure.
 *
 * `persistMetrics` in `call-runner.ts` passed the first turn's
 * end-to-end total straight into `call_metrics.first_turn_total_ms`,
 * which is a Postgres INTEGER. That total is back-dated by a fractional
 * STT lag, so it is routinely fractional (`3474.001953125` is a real
 * stored example). The driver sends such a value as the literal text
 * `2424.7`, Postgres rejects it for an integer with SQLSTATE 22P02, and
 * the throw landed AFTER `saveCallMetrics` but BEFORE
 * `saveDispatchMetrics` inside a single `try` whose `catch` was silent.
 *
 * One fractional millisecond therefore cost BOTH metrics rows — which
 * is why `answer_to_first_audio_ms` was missing on calls that had
 * completed perfectly normally. Every sibling latency was already safe
 * because it reaches the column through `median`, which rounds.
 *
 * Section A pins the Postgres type contract that makes the bug real.
 * Section B pins the ordering consequence: the dispatch write must
 * still execute after the metrics write. Both use a DEDICATED client
 * and TEMP tables mirroring `001_init.sql`, so nothing is written to
 * any real table; they skip when DATABASE_URL is unset.
 * Section C pins the production expression itself, and needs no
 * database.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS A VENDOR, OR
 * READS OR WRITES ANY REAL CAMPAIGN TABLE.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

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

/** The exact fractional total the brief names. */
const FRACTIONAL_TOTAL_MS = 2424.7;

// ═════════════════════════════════════════════════════════════════
// A + B — the Postgres contract and the ordering consequence.
// ═════════════════════════════════════════════════════════════════

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  console.log("\n[SKIP] sections A and B — DATABASE_URL is not set");
} else {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    ssl:
      process.env["DATABASE_SSL"] === "disable"
        ? false
        : { rejectUnauthorized: process.env["DATABASE_SSL_REJECT_UNAUTHORIZED"] === "true" },
    connectionTimeoutMillis: 15_000,
    application_name: "first-turn-total-regression-test",
  });
  await client.connect();

  // Temp tables live in this session's own schema and are dropped when
  // it closes. The column types are copied verbatim from 001_init.sql
  // so the contract under test is the real one.
  await client.query(`
    CREATE TEMP TABLE t_call_metrics (
      call_attempt_id     text PRIMARY KEY,
      turn_count          integer,
      first_turn_total_ms integer,
      raw                 jsonb NOT NULL
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMP TABLE t_dispatch_metrics (
      call_attempt_id          text PRIMARY KEY,
      answer_to_first_audio_ms integer
    ) ON COMMIT PRESERVE ROWS;
  `);

  const insertMetrics = (attemptId: string, firstTurnTotal: number | null) =>
    client.query(
      `INSERT INTO t_call_metrics (call_attempt_id, turn_count, first_turn_total_ms, raw)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [attemptId, 1, firstTurnTotal, JSON.stringify({ firstTurnTotalMs: firstTurnTotal })],
    );

  const insertDispatch = (attemptId: string, a2fa: number | null) =>
    client.query(
      `INSERT INTO t_dispatch_metrics (call_attempt_id, answer_to_first_audio_ms) VALUES ($1, $2)`,
      [attemptId, a2fa],
    );

  section("A. The Postgres type contract that made the bug real");

  await test("A1 — an UNROUNDED fractional total is rejected with SQLSTATE 22P02", async () => {
    await assert.rejects(
      () => insertMetrics("a1", FRACTIONAL_TOTAL_MS),
      (error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        assert.equal(
          code,
          "22P02",
          `expected Postgres to reject ${FRACTIONAL_TOTAL_MS} for an integer column with 22P02, got ${String(code)}`,
        );
        return true;
      },
      "a fractional millisecond must still be rejected by an integer column — this is the fault the fix routes around, not something the fix changes",
    );
  });

  await test("A2 — the ROUNDED total inserts, and reads back as an integer", async () => {
    const rounded = Math.round(FRACTIONAL_TOTAL_MS);
    await insertMetrics("a2", rounded);
    const { rows } = await client.query<{ first_turn_total_ms: number }>(
      `SELECT first_turn_total_ms FROM t_call_metrics WHERE call_attempt_id = 'a2'`,
    );
    assert.equal(rows.length, 1, "the rounded insert must produce exactly one row");
    const stored = rows[0]?.first_turn_total_ms;
    assert.equal(stored, 2425, "2424.7 must round to 2425");
    assert.ok(Number.isInteger(stored), `first_turn_total_ms must be an integer, got ${String(stored)}`);
  });

  section("B. The ordering consequence — the dispatch write must still run");

  await test("B1 — with the fix, BOTH the metrics row and the dispatch row persist", async () => {
    // The production sequence, in order: metrics first, then dispatch.
    const firstTurnTotalMs: number | undefined = FRACTIONAL_TOTAL_MS;
    await insertMetrics("b1", firstTurnTotalMs === undefined ? null : Math.round(firstTurnTotalMs));
    await insertDispatch("b1", 1936);

    const metrics = await client.query(`SELECT 1 FROM t_call_metrics WHERE call_attempt_id = 'b1'`);
    const dispatch = await client.query<{ answer_to_first_audio_ms: number }>(
      `SELECT answer_to_first_audio_ms FROM t_dispatch_metrics WHERE call_attempt_id = 'b1'`,
    );
    assert.equal(metrics.rowCount, 1, "the call_metrics row must persist");
    assert.equal(dispatch.rowCount, 1, "the dispatch_metrics row must persist AFTER the metrics row");
    assert.equal(
      dispatch.rows[0]?.answer_to_first_audio_ms,
      1936,
      "answer_to_first_audio_ms must survive — it was the collateral damage of the original fault",
    );
  });

  await test("B2 — the OLD behaviour loses BOTH rows, not just the metrics row", async () => {
    // Reproduces the original control flow to prove the collateral
    // damage was real: one try, dispatch strictly after metrics.
    let dispatchExecuted = false;
    let swallowed: unknown;
    try {
      await insertMetrics("b2", FRACTIONAL_TOTAL_MS); // throws 22P02
      dispatchExecuted = true;
      await insertDispatch("b2", 1936);
    } catch (error) {
      swallowed = error;
    }

    assert.ok(swallowed !== undefined, "the unrounded insert must throw");
    assert.equal(dispatchExecuted, false, "the dispatch write must never have been reached");
    const dispatch = await client.query(`SELECT 1 FROM t_dispatch_metrics WHERE call_attempt_id = 'b2'`);
    assert.equal(dispatch.rowCount, 0, "no dispatch row — this is why answer_to_first_audio_ms went missing");
  });

  await client.end();
}

// ═════════════════════════════════════════════════════════════════
// C — the production expression. No database required.
// ═════════════════════════════════════════════════════════════════
//
// `persistMetrics` is module-private and its two repository calls are
// imported directly rather than injected, so there is no seam through
// which a test can drive it without a full campaign fixture and live
// writes to real tables. These assertions therefore pin the source of
// the one expression the fix changed; they fail loudly if the rounding
// is reverted.

section("C. The production expression in call-runner.ts");

const callRunnerSource = await readFile(
  path.join(process.cwd(), "src/campaign/dispatch/call-runner.ts"),
  "utf8",
);

await test("C1 — firstTurnTotal is rounded before it reaches the integer column", () => {
  const line = callRunnerSource
    .split("\n")
    .find((l) => l.includes("firstTurnTotal:"));
  assert.ok(line !== undefined, "the firstTurnTotal persistence expression must exist");
  assert.ok(
    line.includes("Math.round("),
    `firstTurnTotal must be rounded — an unrounded fractional millisecond is rejected by Postgres with 22P02 and costs BOTH metrics rows. Found: ${line.trim()}`,
  );
});

await test("C2 — an absent first turn still persists NULL, never 0", () => {
  const line = callRunnerSource
    .split("\n")
    .find((l) => l.includes("firstTurnTotal:"));
  assert.ok(line !== undefined);
  assert.ok(
    line.includes("null"),
    `firstTurnTotal must keep its null branch: "no turn was measured" and "the turn took no time" are different facts. Found: ${line.trim()}`,
  );
  assert.ok(
    !/\?\?\s*0/.test(line),
    `firstTurnTotal must not fall back to 0. Found: ${line.trim()}`,
  );
});

await test("C3 — the metrics-persistence catch is no longer silent", () => {
  const index = callRunnerSource.indexOf("async function persistMetrics(");
  assert.ok(index >= 0, "persistMetrics must exist");
  // Bounded at the next top-level doc comment: `captureTranscript`
  // follows, and its own bare `catch` is legitimate — it deliberately
  // degrades to "no transcript" and must not be read as this one.
  const after = callRunnerSource.indexOf("\n/**", index);
  const body = callRunnerSource.slice(index, after > index ? after : callRunnerSource.length);
  assert.ok(
    !/\}\s*catch\s*\{/.test(body),
    "the bare `catch {` must be gone — it hid a 22P02 across 144 completed calls",
  );
  assert.ok(
    body.includes("console.error") && body.includes("metrics persistence FAILED"),
    "an unexpected metrics-persistence failure must be logged with context",
  );
});

await test("C4 — upstream latency precision is untouched (raw keeps the full value)", () => {
  assert.ok(
    callRunnerSource.includes("const firstTurnTotalMs = turns[0]?.total?.milliseconds;"),
    "the rounding must happen at the persistence boundary only, reading the unmodified upstream value",
  );
  assert.ok(
    !callRunnerSource.includes("Math.round(metrics"),
    "nothing in the metrics object itself may be rounded — `raw` must keep full precision",
  );
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM or Google request was made. No real campaign table was read or written.");
process.exit(failures.length === 0 ? 0 : 1);
