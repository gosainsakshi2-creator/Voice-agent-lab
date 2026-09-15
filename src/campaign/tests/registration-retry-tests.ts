/**
 * registration-retry-tests.ts — `npm run test:registration-retry`
 *
 * BATCH B — POST-CALL SHEET SYNC RELIABILITY (roadmap §5 B5/B6).
 *
 * Before this batch a confirmed registration whose sheet write failed
 * was lost permanently: `claimSheetSync` was willing to reclaim a
 * FAILED row, but a FINAL_YES contact is unclaimable by the dispatcher
 * by design, so nothing ever presented one again. The same was true of
 * a registration that was never presented at all — a process killed
 * between finalising the attempt and reaching the sync.
 *
 * Four properties are worth proving, and the last one is the rule the
 * whole batch was constrained by:
 *
 *   1. a failure stays RECOVERABLE, and is actually recovered;
 *   2. the recovery is BOUNDED — it stops, and what it stops on stays
 *      visible instead of being discarded;
 *   3. no retry, however many times it runs, can produce a second row;
 *   4. NOTHING here talks to Google while a call is alive. Section C
 *      proves that against the real `runCall`, using the Batch A timing
 *      event as the instrument.
 *
 * Every write goes through the REAL `syncFinalYesToSheet` and the REAL
 * `claimSheetSync` against real PostgreSQL. Only Google and the event
 * sink are substituted.
 *
 * NOTHING HERE PLACES A CALL, AND NOTHING HERE CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { findScript, hashScript } = await import("../script/script-registry");
const { syncFinalYesToSheet } = await import("../integrations/final-yes-sheet");
const { reconcileRegistrationSheet, REGISTRATION_RECONCILED } = await import(
  "../integrations/registration-reconciler"
);
const { registrationCaptureCounts } = await import("../results/results.repo");
const { getSheetSyncRetryPolicy } = await import("../config/sheet.config");
const { claimSheetSync } = await import("../db/repositories/sheet-sync.repo");
const { query, closeDbPool } = await import("../db/client");

import type { SheetSyncConfig, SheetSyncRetryPolicy } from "../config/sheet.config";
import type { AppendResult } from "../integrations/google-sheets.client";
import type { TranscriptTurn } from "../outcome/transcript";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 5).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─────────────────────────────────────────────────────────────────
// Fixtures

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRM = "Perfect! I'll get your registration confirmed.";

const CALL_AT = Date.parse("2026-09-15T09:00:00.000Z");
const at = (s: number) => new Date(CALL_AT + s * 1000).toISOString();

const REGISTERED_TURNS: readonly TranscriptTurn[] = [
  { role: "assistant", text: GREETING, at: at(0) },
  { role: "user", text: "Hello.", at: at(3) },
  { role: "assistant", text: GATE, at: at(5) },
  { role: "user", text: "Yes, please reserve it.", at: at(9) },
  { role: "assistant", text: CONFIRM, at: at(11) },
];

const REFUSED_TURNS: readonly TranscriptTurn[] = [
  { role: "assistant", text: GREETING, at: at(0) },
  { role: "assistant", text: GATE, at: at(5) },
  { role: "user", text: "No, I'm not interested.", at: at(8) },
];

function settle(turns: readonly TranscriptTurn[]) {
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns,
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return {
    classification,
    disposition,
    transcript: {
      turns,
      turnCount: turns.length,
      truncated: false,
      capturedAt: at(30),
      source: "conversation-memory" as const,
    },
  };
}

const REGISTERED = settle(REGISTERED_TURNS);
const REFUSED = settle(REFUSED_TURNS);
assert.equal(REGISTERED.disposition, "FINAL_YES", "the fixture must actually be a registration");

const STUB_CONFIG: SheetSyncConfig = {
  spreadsheetId: "test-spreadsheet",
  tabName: "Sheet1",
  clientEmail: "test@example.iam.gserviceaccount.com",
  privateKey: "not-a-real-key-and-never-used",
  isConfigured: true,
};

/** Budget of 3, no waiting. The backoff itself is proven separately in B5. */
const FAST_POLICY: SheetSyncRetryPolicy = {
  maxAttempts: 3,
  backoffMinutes: [0],
  reconcileBatchSize: 25,
  reconcileMaxDurationMs: 60_000,
};

/** Stands in for Google. `failures` refusals first, then success. */
function makeAppender(failuresFirst = 0, delayMs = 0) {
  const rows: string[][] = [];
  let calls = 0;
  const calledAt: number[] = [];
  return {
    rows,
    calledAt,
    get calls() {
      return calls;
    },
    append: async (_c: SheetSyncConfig, values: readonly string[]): Promise<AppendResult> => {
      calls += 1;
      calledAt.push(Date.now());
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (calls <= failuresFirst) throw new Error(`simulated Google failure #${calls}`);
      rows.push([...values]);
      return { updatedRange: `Sheet1!A${rows.length}:C${rows.length}` };
    },
  };
}

interface RecordedEvent {
  code: string;
  data: Record<string, unknown>;
  level: string;
}
function makeRecorder() {
  const events: RecordedEvent[] = [];
  return {
    events,
    log: async (
      _campaignId: string,
      code: string,
      _message: string,
      data?: Record<string, unknown>,
      level?: "info" | "warn" | "error",
    ): Promise<void> => {
      events.push({ code, data: data ?? {}, level: level ?? "info" });
    },
  };
}

const hasDatabase = (process.env.DATABASE_URL ?? "").length > 0;
if (!hasDatabase) {
  console.log("  [SKIP] every section — DATABASE_URL is not set");
} else {
  const campaignId = randomUUID();
  const script = findScript("registration", "v1");
  assert.ok(script, "the approved registration script must be registered");

  let row = 0;
  async function makeRegistration(options: {
    registered?: boolean;
    sheet?: { state: "SYNCED" | "FAILED" | "PENDING"; attempts?: number; ageMinutes?: number };
  } = {}): Promise<{ contactId: string; attemptId: string; phone: string }> {
    const registered = options.registered ?? true;
    const settled = registered ? REGISTERED : REFUSED;
    row += 1;
    const phone = `+9198333${String(row).padStart(5, "0")}`;
    const disposition = registered ? "FINAL_YES" : "FINAL_NO";

    const contact = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                             csv_row_number, status, attempt_count, metadata, final_disposition,
                             closed_at, closure_reason)
       VALUES ($1, $2, $3, $3, 'cartesia', $4, 'COMPLETED', 1,
               '{"Email":"priya@example.com"}'::jsonb, $5, now(), 'fixture')
       RETURNING id`,
      [campaignId, `Priya ${row}`, phone, row, disposition],
    );
    const contactId = contact.rows[0]!.id;

    const attempt = await query<{ id: string }>(
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                  status, dialed_at, answered_at, ended_at, failure_class)
       VALUES ($1, $2, 1, 'cartesia', 'vobiz', 'COMPLETED', now(), now(), now(), 'COMPLETED')
       RETURNING id`,
      [campaignId, contactId],
    );
    const attemptId = attempt.rows[0]!.id;

    await query(
      `INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type, schema_version,
                                  succeeded, primary_reason, detail, classifier, transcript)
       VALUES ($1,$2,$3,1,$4,$5,$6::jsonb,'rules.v2',$7::jsonb)`,
      [
        attemptId,
        campaignId,
        settled.classification.outcomeType,
        settled.classification.succeeded,
        settled.classification.primaryReason,
        JSON.stringify(settled.classification.detail),
        JSON.stringify(settled.transcript),
      ],
    );

    if (options.sheet) {
      await query(
        `INSERT INTO sheet_sync (campaign_id, normalized_phone, contact_id, call_attempt_id,
                                 spreadsheet_id, state, attempts, claimed_at, synced_at, last_error)
         VALUES ($1,$2,$3,$4,'test-spreadsheet',$5,$6,
                 now() - ($7 || ' minutes')::interval,
                 CASE WHEN $5 = 'SYNCED' THEN now() END, 'fixture')`,
        [
          campaignId,
          phone,
          contactId,
          attemptId,
          options.sheet.state,
          options.sheet.attempts ?? 1,
          String(options.sheet.ageMinutes ?? 120),
        ],
      );
    }
    return { contactId, attemptId, phone };
  }

  const syncState = async (phone: string) => {
    const r = await query<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM sheet_sync WHERE campaign_id = $1 AND normalized_phone = $2",
      [campaignId, phone],
    );
    return r.rows[0];
  };

  const sheetRowCount = async (phone: string) => {
    const r = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sheet_sync WHERE campaign_id = $1 AND normalized_phone = $2",
      [campaignId, phone],
    );
    return r.rows[0]?.n ?? 0;
  };

  try {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__registration_retry__', 'registration', 'READY', 'registration', 'v1', $2,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
      [campaignId, hashScript(script), `retry-${campaignId}`],
    );

    // ═════════════════════════════════════════════════════════════
    section("A. THE RETRY BUDGET IS BOUNDED, AND THE BOUND IS THE CLAIM STATEMENT");

    await test("A1. a successful post-call sync still works exactly as before", async () => {
      const { contactId, attemptId, phone } = await makeRegistration();
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY, logEvent: makeRecorder().log },
      );

      assert.equal(result.synced, true);
      assert.deepEqual(google.rows[0], ["Priya " + row, "priya@example.com", phone]);
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("A2. a transient failure leaves the registration FAILED and recoverable", async () => {
      const { contactId, attemptId, phone } = await makeRegistration();
      const google = makeAppender(1);
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
        },
        { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY, logEvent: makeRecorder().log },
      );

      assert.equal(result.synced, false);
      const state = await syncState(phone);
      assert.equal(state?.state, "FAILED", "durably failed, not discarded");
      assert.equal(state?.attempts, 1, "one attempt used of the budget");
    });

    await test("A3. presenting it again succeeds, and the attempt counter advances", async () => {
      const { contactId, attemptId, phone } = await makeRegistration();
      const google = makeAppender(1);
      const deps = {
        config: STUB_CONFIG,
        append: google.append,
        retryPolicy: FAST_POLICY,
        logEvent: makeRecorder().log,
      };
      const input = {
        campaignId,
        contactId,
        attemptId,
        classification: REGISTERED.classification,
        disposition: REGISTERED.disposition,
      };

      assert.equal((await syncFinalYesToSheet(input, deps)).synced, false, "first attempt fails");
      const second = await syncFinalYesToSheet(input, deps);

      assert.equal(second.synced, true, "the second attempt recovers it");
      assert.equal(google.rows.length, 1, "exactly one row, from the attempt that worked");
      const state = await syncState(phone);
      assert.equal(state?.state, "SYNCED");
      assert.equal(state?.attempts, 2);
    });

    await test("A4. the budget STOPS it — attempt 4 of a 3-attempt budget never reaches Google", async () => {
      const { contactId, attemptId, phone } = await makeRegistration();
      const google = makeAppender(99); // always fails
      const deps = {
        config: STUB_CONFIG,
        append: google.append,
        retryPolicy: FAST_POLICY,
        logEvent: makeRecorder().log,
      };
      const input = {
        campaignId,
        contactId,
        attemptId,
        classification: REGISTERED.classification,
        disposition: REGISTERED.disposition,
      };

      for (let i = 0; i < 5; i += 1) await syncFinalYesToSheet(input, deps);

      assert.equal(google.calls, 3, "exactly maxAttempts Google requests, however many times it is presented");
      const state = await syncState(phone);
      assert.equal(state?.state, "FAILED", "exhausted, and still durably recorded");
      assert.equal(state?.attempts, 3);
    });

    await test("A5. a SYNCED row is never reclaimed, whatever the budget says", async () => {
      const { contactId, attemptId, phone } = await makeRegistration({
        sheet: { state: "SYNCED", attempts: 1 },
      });
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
        },
        { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY, logEvent: makeRecorder().log },
      );

      assert.equal(result.synced === false && result.reason, "already-synced");
      assert.equal(google.calls, 0, "a registration already in the sheet is never re-appended");
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("A6. the claim itself refuses past the ceiling — the guarantee is one statement", async () => {
      const { contactId, attemptId, phone } = await makeRegistration({
        sheet: { state: "FAILED", attempts: 3 },
      });
      const claimed = await claimSheetSync(
        { campaignId, normalizedPhone: phone, contactId, attemptId, spreadsheetId: "test-spreadsheet" },
        3,
      );
      assert.equal(claimed, false, "no code path can get past the ceiling by calling this directly");
    });

    await test("A7. the deployment's real policy is a bounded one", () => {
      const policy = getSheetSyncRetryPolicy();
      assert.ok(policy.maxAttempts >= 1 && Number.isFinite(policy.maxAttempts));
      assert.ok(policy.maxAttempts <= 10, "a 'bounded' retry that tries 100 times is not bounded");
      assert.ok(policy.backoffMinutes.length > 0, "a deferred retry needs a backoff table");
      assert.ok(policy.reconcileBatchSize > 0 && policy.reconcileMaxDurationMs > 0);
    });

    // ═════════════════════════════════════════════════════════════
    section("B. THE RECONCILER RECOVERS WHAT THE LIVE SYNC COULD NOT");

    await test("B1. a registration that was NEVER presented is found and written", async () => {
      const { phone } = await makeRegistration(); // no sheet_sync row at all
      const google = makeAppender();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });

      assert.ok(result.synced >= 1, "the never-presented case is exactly what nothing could see before");
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("B2. a FAILED registration past its backoff is retried and recovered", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "FAILED", attempts: 1, ageMinutes: 120 } });
      const google = makeAppender();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });

      assert.ok(result.synced >= 1);
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("B3. a registration already in the sheet is not touched", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "SYNCED", attempts: 1 } });
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      const state = await syncState(phone);
      assert.equal(state?.state, "SYNCED");
      assert.equal(state?.attempts, 1, "its attempt counter did not move, so it was never presented");
    });

    await test("B4. a contact who did NOT register is never reconciled into the sheet", async () => {
      const { phone } = await makeRegistration({ registered: false });
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      assert.equal(await sheetRowCount(phone), 0, "a FINAL_NO has no sheet row and never gains one");
    });

    await test("B5. the BACKOFF holds — a recent failure is left alone until it is due", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "FAILED", attempts: 1, ageMinutes: 1 } });
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        // 60 minutes before attempt 2; the row failed one minute ago.
        policy: { ...FAST_POLICY, backoffMinutes: [60] },
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      const state = await syncState(phone);
      assert.equal(state?.state, "FAILED");
      assert.equal(state?.attempts, 1, "not retried before its backoff elapsed");
    });

    await test("B6. a FRESH pending claim is left alone — another worker may be mid-write", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "PENDING", attempts: 1, ageMinutes: 1 } });
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      const state = await syncState(phone);
      assert.equal(state?.state, "PENDING");
      assert.equal(state?.attempts, 1, "a live write must never be duplicated by a sweep");
    });

    await test("B7. a STALE pending claim — a process killed holding it — IS recovered", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "PENDING", attempts: 1, ageMinutes: 60 } });
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("B8. an EXHAUSTED registration is reported, not retried, not discarded", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "FAILED", attempts: 3, ageMinutes: 120 } });
      const google = makeAppender();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });

      assert.ok(result.exhausted >= 1, "the operator is told it exists");
      const state = await syncState(phone);
      assert.equal(state?.state, "FAILED", "and it is still there to be fixed by hand");
      assert.equal(state?.attempts, 3, "and it was not tried again");
    });

    await test("B9. RUNNING IT TWICE PRODUCES EXACTLY ONE ROW", async () => {
      const { phone } = await makeRegistration();
      const google = makeAppender();
      const deps = {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      };
      const before = google.rows.length;
      await reconcileRegistrationSheet(campaignId, deps);
      const afterFirst = google.rows.length;
      await reconcileRegistrationSheet(campaignId, deps);
      const afterSecond = google.rows.length;

      assert.equal(afterFirst - before, 1, "the first pass wrote it");
      assert.equal(afterSecond - afterFirst, 0, "the second pass wrote nothing");
      assert.equal(await sheetRowCount(phone), 1, "one sheet_sync row for one person");
    });

    await test("B10. CONCURRENT passes produce exactly one row", async () => {
      const { phone } = await makeRegistration();
      const google = makeAppender();
      const deps = {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      };
      const before = google.rows.filter((r) => r[2] === phone).length;
      await Promise.all([
        reconcileRegistrationSheet(campaignId, deps),
        reconcileRegistrationSheet(campaignId, deps),
        reconcileRegistrationSheet(campaignId, deps),
      ]);
      const after = google.rows.filter((r) => r[2] === phone).length;

      assert.equal(after - before, 1, "the claim statement is the arbiter, not the sweep");
      assert.equal((await syncState(phone))?.state, "SYNCED");
    });

    await test("B11. the BATCH SIZE bounds one pass, and says it was truncated", async () => {
      await makeRegistration();
      await makeRegistration();
      await makeRegistration();
      const google = makeAppender();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: { ...FAST_POLICY, reconcileBatchSize: 2 },
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });

      assert.equal(result.examined, 2, "a pass never runs away with an unbounded campaign");
      assert.equal(result.truncated, true, "and it says so");
    });

    await test("B12. the TIME BUDGET bounds one pass", async () => {
      await makeRegistration();
      await makeRegistration();
      const google = makeAppender();
      let clock = 0;
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: { ...FAST_POLICY, reconcileMaxDurationMs: 10 },
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
        // First read starts the clock, the next is already past budget.
        now: () => (clock += 100),
      });
      assert.equal(result.examined, 0, "a pass that has run out of time stops");
      assert.equal(result.truncated, true);
    });

    await test("B13. the reconciler NEVER throws — a broken writer costs its own row only", async () => {
      await makeRegistration();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: {
          config: STUB_CONFIG,
          retryPolicy: FAST_POLICY,
          append: () => {
            throw new Error("thrown synchronously, before any promise exists");
          },
        },
        logEvent: makeRecorder().log,
      });
      assert.ok(result.examined >= 1, "it kept going");
      assert.ok(typeof result.failed === "number");
    });

    await test("B14. a campaign that does not exist is a quiet no-op, not a crash", async () => {
      const result = await reconcileRegistrationSheet(randomUUID(), {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: makeAppender().append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      assert.equal(result.examined, 0);
      assert.equal(result.synced, 0);
    });

    await test("B15. the stored verdict goes back through the REAL gate, not a second one", async () => {
      // A contact the DB calls FINAL_YES whose stored outcome is not a
      // gate confirmation. `isFinalYes` must refuse it.
      const { contactId, phone } = await makeRegistration();
      await query(
        `UPDATE call_outcomes SET primary_reason = 'affirmative_not_at_gate', succeeded = false
          WHERE call_attempt_id IN (SELECT id FROM call_attempts WHERE contact_id = $1)`,
        [contactId],
      );
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      assert.equal(await sheetRowCount(phone), 0, "the gate refused it, so nothing was written");
    });

    // ═════════════════════════════════════════════════════════════
    section("C. GOOGLE SHEETS REMAINS STRICTLY POST-CALL");

    await test("C1. the voice layer cannot reach the sheet — no import path exists", () => {
      const voiceFiles = [
        "src/core/session/conversation-pipeline.ts",
        "src/core/session/voice-session-manager.impl.ts",
        "src/core/session/turn-detection.ts",
        "src/server/vobiz-media-bridge.ts",
        "src/server/plivo-media-bridge.ts",
      ];
      for (const file of voiceFiles) {
        const source = readFileSync(file, "utf8");
        for (const forbidden of [
          "google-sheets.client",
          "final-yes-sheet",
          "registration-reconciler",
          "registration-payload",
          "sheet-sync.repo",
        ]) {
          assert.ok(
            !source.includes(forbidden),
            `${file} must not be able to reach "${forbidden}" — the sheet is post-call only`,
          );
        }
      }
    });

    await test("C2. the reconciler is not reachable from the call runner either", () => {
      const runner = readFileSync("src/campaign/dispatch/call-runner.ts", "utf8");
      assert.ok(
        !runner.includes("registration-reconciler"),
        "a sweep must never run inside a call; it belongs to the dispatcher",
      );
    });

    await test("C3. the dispatcher's two sweeps are both outside the lane loop", () => {
      const source = readFileSync("src/campaign/dispatch/dispatcher.ts", "utf8");
      const calls = source.split("reconcileRegistrationSheet(this.campaignId)").length - 1;
      assert.equal(calls, 2, "exactly two sweeps: before the lanes start, and after they have all drained");

      const laneStart = source.indexOf("private async runLane");
      assert.ok(laneStart > 0, "runLane must exist");
      const lane = source.slice(laneStart);
      assert.ok(
        !lane.includes("reconcileRegistrationSheet"),
        "no sweep may be issued from inside the lane that places calls",
      );
    });

    await test("C4. THROUGH THE REAL RUNNER: the registration is triggered only AFTER the call ends", async () => {
      // The Batch A timing event is the instrument. It records
      // `triggeredAt` at the first statement of the sync, so comparing
      // it to the instant the session actually ended is a direct
      // measurement of the architectural rule.
      const { runCall } = await import("../dispatch/call-runner");
      const { SessionObserver } = await import("../dispatch/session-observer");
      const { getDispatchConfig } = await import("../config/dispatch.config");
      const { claimContacts } = await import("../db/repositories/call-attempt.repo");
      const { getCampaign } = await import("../db/repositories/campaign.repo");

      // The runner uses the DEPLOYMENT's config, so the spreadsheet id
      // is cleared for the duration: the sync reports itself
      // unconfigured and returns without contacting Google, and still
      // emits its timing event.
      const saved = process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
      delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
      try {
        row += 1;
        const phone = `+9198334${String(row).padStart(5, "0")}`;
        await query(
          `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                                 csv_row_number, status)
           VALUES ($1, 'Priya', $2, $2, 'cartesia', $3, 'PENDING')`,
          [campaignId, phone, 9000 + row],
        );

        const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "retry-test");
        const contact = claimed.find((c) => c.normalizedPhone === phone);
        for (const other of claimed) {
          if (other.normalizedPhone !== phone) {
            await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [other.id]);
          }
        }
        assert.ok(contact, "the contact must be claimable");

        let endedAt = 0;
        const sessionId = `fake-${randomUUID()}`;
        let listener: ((id: string, t: unknown) => void) | undefined;
        const manager = {
          createSession: async () => ({ id: sessionId }),
          warmUpProviders: async () => undefined,
          start: async () => listener?.(sessionId, { from: "CALLING", to: "LISTENING", at: new Date() }),
          end: async () => {
            endedAt = Date.now();
            listener?.(sessionId, { from: "LISTENING", to: "IDLE", at: new Date() });
          },
          getBenchmarkMetrics: async () => ({
            sessionId,
            providerStack: {},
            timestamp: new Date(),
            callDuration: { seconds: 20, createdAt: new Date() },
            estimatedCost: {
              amount: 0,
              currency: "USD",
              isEstimate: true,
              breakdown: { telephony: 0, speechToText: 0, languageModel: 0, textToSpeech: 0 },
            },
            turnLatencies: [],
          }),
          getTranscript: () =>
            REGISTERED_TURNS.map((t) => ({ role: t.role, content: t.text, timestamp: new Date() })),
          onStateChange: (fn: (id: string, t: unknown) => void) => {
            listener = fn;
            return () => (listener = undefined);
          },
        };

        const campaign = await getCampaign(campaignId);
        assert.ok(campaign);
        const outcome = await runCall(
          contact,
          {
            manager: manager as never,
            observer: new SessionObserver(manager as never),
            config: {
              ...getDispatchConfig(),
              dialingEnabled: true,
              ringTimeoutSeconds: 5,
              maxCallSeconds: 60,
              maxSilenceSeconds: 30,
            },
            campaign,
            script,
          },
          Date.now(),
        );
        await flush();

        assert.ok(outcome.attemptId, "the call must have produced an attempt");
        assert.ok(endedAt > 0, "the session must actually have been ended");

        const event = await query<{ data: Record<string, unknown> }>(
          `SELECT data FROM campaign_events
            WHERE campaign_id = $1 AND code LIKE 'REGISTRATION_SYNC%'
              AND data->>'attemptId' = $2
            ORDER BY at DESC LIMIT 1`,
          [campaignId, outcome.attemptId],
        );
        const timing = event.rows[0]?.data?.["timing"] as Record<string, unknown> | undefined;
        assert.ok(timing, "the registration must have produced a durable timing event");

        const triggeredAt = Date.parse(String(timing["triggeredAt"]));
        assert.ok(
          triggeredAt >= endedAt,
          `the registration path was entered ${endedAt - triggeredAt}ms BEFORE the call ended — ` +
            `Google Sheets must never be reached while a conversation is live`,
        );
      } finally {
        if (saved !== undefined) process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = saved;
      }
    });

    // ═════════════════════════════════════════════════════════════
    section("D. BATCH A OBSERVABILITY AND REPORTING STILL WORK");

    await test("D1. every reconciled registration emits the Batch A timing event", async () => {
      await makeRegistration();
      const recorder = makeRecorder();
      const google = makeAppender();
      const result = await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY, logEvent: recorder.log },
        logEvent: makeRecorder().log,
      });
      await flush();

      const synced = recorder.events.filter((e) => e.code === "REGISTRATION_SYNCED");
      assert.equal(synced.length, result.synced, "one Batch A event per registration written");
      const timing = synced[0]?.data["timing"] as Record<string, unknown>;
      assert.ok(timing["triggeredAt"] && timing["requestStartedAt"] && timing["syncedAt"]);
    });

    await test("D2. a retry still reports the CONFIRMATION instant from the stored transcript", async () => {
      await makeRegistration({ sheet: { state: "FAILED", attempts: 1, ageMinutes: 120 } });
      const recorder = makeRecorder();
      const google = makeAppender();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: google.append, retryPolicy: FAST_POLICY, logEvent: recorder.log },
        logEvent: makeRecorder().log,
      });
      await flush();

      const synced = recorder.events.find((e) => e.code === "REGISTRATION_SYNCED");
      assert.ok(synced, "the recovered registration must have an event");
      const timing = synced.data["timing"] as Record<string, unknown>;
      assert.equal(
        timing["confirmedAt"],
        at(9),
        "the instant the person confirmed survives a retry — it is read from the STORED transcript",
      );
    });

    await test("D3. the reconciler writes its own summary line, and does not touch Batch A's codes", async () => {
      const recorder = makeRecorder();
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: makeAppender().append, retryPolicy: FAST_POLICY },
        logEvent: recorder.log,
      });
      await flush();

      const summary = recorder.events.find((e) => e.code === REGISTRATION_RECONCILED);
      assert.ok(summary, "an unattended sweep must leave a trace");
      for (const key of ["examined", "synced", "failed", "skipped", "exhausted", "truncated"]) {
        assert.ok(key in summary.data, `the summary must report "${key}"`);
      }
    });

    await test("D4. a failed registration is still visible to the B8 capture report", async () => {
      const counts = await registrationCaptureCounts(campaignId);
      assert.equal(
        counts.synced + counts.failed + counts.pending + counts.notAttempted,
        counts.confirmed,
        "the reconciliation identity still holds after everything this suite did",
      );
      assert.ok(counts.failed >= 1, "the exhausted registration from B8 is still counted as failed");
    });

    await test("D5. reconciliation moves a registration from failed to synced IN THE REPORT", async () => {
      const { phone } = await makeRegistration({ sheet: { state: "FAILED", attempts: 1, ageMinutes: 120 } });
      const before = await registrationCaptureCounts(campaignId);
      await reconcileRegistrationSheet(campaignId, {
        policy: FAST_POLICY,
        sheet: { config: STUB_CONFIG, append: makeAppender().append, retryPolicy: FAST_POLICY },
        logEvent: makeRecorder().log,
      });
      const after = await registrationCaptureCounts(campaignId);

      assert.equal((await syncState(phone))?.state, "SYNCED");
      assert.ok(after.synced > before.synced, "the capture rate is what recovery is measured by");
      assert.equal(after.confirmed, before.confirmed, "and how many people said yes did not change");
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
    await closeDbPool();
  }
}

// ─────────────────────────────────────────────────────────────────
console.log(
  failures.length === 0
    ? `\nALL PASSED — ${passed} passed, 0 failed`
    : `\n${passed} passed, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}`,
);
console.log("No telephony, TTS, STT or LLM request was made. No call was placed. Google was not contacted.");
if (failures.length > 0) process.exitCode = 1;
