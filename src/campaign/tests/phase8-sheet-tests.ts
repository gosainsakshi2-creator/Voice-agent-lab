/**
 * phase8-sheet-tests.ts — `npm run test:phase8`
 *
 * THE REGISTRATIONS SHEET.
 *
 * A FINAL_YES is mirrored into a Google Sheet. That is a side effect on
 * a system outside this one, so the two things worth proving are the
 * two things that cannot be undone by hand at scale:
 *
 *   1. only a definitive FINAL_YES is ever written — a question
 *      containing "yes", a refusal, a callback, an undecided call and
 *      an interrupted call must all write nothing;
 *   2. the same person cannot produce two rows, however many times the
 *      call is retried, reclassified or reprocessed.
 *
 * Sections A and B are PURE: no database, no network, and the verdicts
 * come from the REAL classifier rather than hand-written outcome
 * objects, so they prove the gate reads what the classifier actually
 * produces.
 *
 * Section C exercises the real `syncFinalYesToSheet` against the real
 * PostgreSQL claim statement, with the Google call replaced by a
 * counting stub. The stub is the only substitution: the gate, the
 * email resolution, the claim SQL and the settle SQL are all the
 * production ones. That is what makes "exactly one row" a statement
 * about this code rather than about a mock.
 *
 * NOTHING HERE PLACES A CALL, AND NOTHING HERE CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { findScript, hashScript, defaultScriptFor } = await import("../script/script-registry");
const { isFinalYes, syncFinalYesToSheet } = await import("../integrations/final-yes-sheet");
const { resolveContactEmail } = await import("../integrations/contact-email");
const { countSheetSyncStates } = await import("../db/repositories/sheet-sync.repo");
const { query, closeDbPool } = await import("../db/client");
const { getSheetSyncConfig, missingSheetConfigKeys } = await import("../config/sheet.config");

import type { SheetSyncConfig } from "../config/sheet.config";
import type { AppendResult } from "../integrations/google-sheets.client";

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

type Turn = { role: "assistant" | "user"; text: string; at: string | null };
const agent = (text: string): Turn => ({ role: "assistant", text, at: null });
const caller = (text: string): Turn => ({ role: "user", text, at: null });

const registrationScript = findScript("registration", "v1");
assert.ok(registrationScript, "the approved registration script must be registered");
const SCRIPT_TEXT = registrationScript.systemPromptAppendix;

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PERMISSION = "Can I tell you in 20 seconds why I think you should attend?";
const GATE = "So Priya, should I reserve your free seat for the live event?";

function classify(transcript: readonly Turn[]) {
  return classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
    scriptText: SCRIPT_TEXT,
  });
}

/** The classifier's verdict plus the disposition the call-runner would store. */
function settle(transcript: readonly Turn[]) {
  const classification = classify(transcript);
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return { classification, disposition };
}

// ═════════════════════════════════════════════════════════════════
section("A. ONLY A DEFINITIVE FINAL_YES OPENS THE GATE");

await test("A1. a yes at the commitment question is a FINAL_YES and is written", () => {
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(PERMISSION),
    caller("Sure, go ahead."),
    agent(GATE),
    caller("Yes, please reserve it."),
  ]);

  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), true);
});

await test("A1b. the APPROVED v3 script's own gate line is a gate", () => {
  // The regression this covers: v1/v2 asked "would you like me to
  // register you...", which COMMIT_ANCHORS matched on "register you".
  // v3 re-worded that line to "Would you be interested to attend?" and
  // no anchor matched it, so a real "Yes." to the approved gate settled
  // as `affirmative_not_at_gate` / UNRESOLVED — one label short of the
  // FINAL_YES that the registrations sheet and the end-of-call check
  // both read. Taken from the v3 script itself, so a future re-wording
  // of the gate fails here rather than in production.
  const v3 = findScript("registration", "v3");
  assert.ok(v3, "the approved registration v3 script must be registered");
  const V3_GATE = "Would you be interested to attend?";
  assert.ok(
    v3.systemPromptAppendix.includes(V3_GATE),
    "this test's gate line must be the one in the approved v3 script",
  );

  const { classification, disposition } = settle([
    agent(GREETING),
    agent(
      "We're doing a LIVE demo of this Funnel Builder Agent today at 7:30 pm, where you'll actually " +
        `see it building things live. ${V3_GATE} The registration is completely FREE.`,
    ),
    caller("Yes."),
    agent("Perfect! I'll get your registration done and send the details to you on WhatsApp."),
  ]);

  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), true);
});

await test("A1c. an INTEREST question with the same words is still not a gate", () => {
  // The anchor added for A1b is a commitment question, not the word
  // "attend": a yes to "can I tell you why you should attend" commits
  // to nothing and must stay unresolved.
  const { classification, disposition } = settle([
    agent(GREETING),
    agent("Can I tell you in 20 seconds why I think you should attend?"),
    caller("Yes."),
    agent("Great — it's a live demo of the Funnel Builder Agent."),
  ]);

  assert.notEqual(classification.primaryReason, "confirmed_at_gate");
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A1d. the APPROVED v4 script's own gate line is a gate, and v4 is the default", () => {
  // Same regression class as A1b, for the next approved version. v4's
  // gate was deliberately worded "reserve your free seat" because that
  // phrase is an existing COMMIT_ANCHORS entry; had it been "reserve a
  // free seat for you" no anchor would match and a real "Yes." would
  // settle one label short of FINAL_YES. Read from the script itself so
  // a future re-wording fails here, not on a live campaign.
  const v4 = findScript("registration", "v4");
  assert.ok(v4, "the approved registration v4 script must be registered");
  assert.equal(defaultScriptFor("registration").version, "v4", "v4 must be the default registration script");
  const V4_GATE = "Would you like me to reserve your free seat?";
  assert.ok(
    v4.systemPromptAppendix.includes(V4_GATE),
    "this test's gate line must be the one in the approved v4 script",
  );

  const { classification, disposition } = settle([
    agent(GREETING),
    agent(
      "I'm calling to personally invite you to a free live workshop we're doing tomorrow, Sunday, " +
        "30th August at 11 AM. You'll actually see a complete online business being built live from " +
        `a phone, including the website, product, checkout and payments. ${V4_GATE}`,
    ),
    caller("Yes."),
    agent("Perfect! I'll get your registration confirmed and send the joining details to you on WhatsApp and email."),
  ]);

  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), true);
});

await test("A1e. a NO to the v4 gate is FINAL_NO and is not written", () => {
  const V4_GATE = "Would you like me to reserve your free seat?";
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(V4_GATE),
    caller("No, not interested."),
  ]);

  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A2. an explicit no is FINAL_NO and is not written", () => {
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(GATE),
    caller("No, I'm not interested."),
  ]);

  assert.equal(disposition, "FINAL_NO");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A3. a callback request is not written", () => {
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(GATE),
    caller("Can you call me back tomorrow?"),
  ]);

  assert.equal(classification.outcomeType, "callback_requested");
  assert.equal(disposition, "RETRYABLE");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A4. a 'yes' inside a QUESTION is not a registration and is not written", () => {
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(PERMISSION),
    caller("Yes, but is the session free?"),
  ]);

  assert.notEqual(classification.outcomeType, "registered_confirmed");
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A5. an interrupted / undecided call is not written", () => {
  const { classification, disposition } = settle([
    agent(GREETING),
    agent(PERMISSION),
    caller("I was actually in the middle of"),
  ]);

  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(isFinalYes(classification, disposition), false);
});

await test("A6. the gate cannot be opened by a disposition alone, or an outcome alone", () => {
  const { classification } = settle([agent(GREETING), agent(GATE), caller("Yes, please reserve it.")]);
  const declined = settle([agent(GREETING), agent(GATE), caller("No, I'm not interested.")]);

  // FINAL_YES disposition but a non-success outcome: refused.
  assert.equal(isFinalYes(declined.classification, "FINAL_YES"), false);
  // Success outcome but no FINAL_YES disposition: refused.
  assert.equal(isFinalYes(classification, "UNRESOLVED"), false);
  assert.equal(isFinalYes(undefined, "FINAL_YES"), false);
  assert.equal(isFinalYes(classification, undefined), false);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE EMAIL COMES FROM THE IMPORTED COLUMN, WHATEVER IT WAS CALLED");

await test("B1. the real header is resolved, not assumed", () => {
  for (const header of ["Email", "email", "EMAIL ID", "Email Address", "E-mail", "customer_email"]) {
    const resolved = resolveContactEmail({ [header]: "priya@example.com", City: "Pune" });
    assert.equal(resolved?.email, "priya@example.com", `header "${header}" must resolve`);
    assert.equal(resolved?.sourceColumn, header, "the log must name the real source column");
  }
});

await test("B2. a non-address value in an email-ish column is not used", () => {
  assert.equal(resolveContactEmail({ "Email Verified": "yes" }), undefined);
  assert.equal(resolveContactEmail({ Email: "" }), undefined);
  assert.equal(resolveContactEmail({}), undefined);
});

await test("B3. an unrelated column holding an address is never harvested", () => {
  // A referrer's address must not become the registrant's.
  assert.equal(resolveContactEmail({ "Referred By": "agent@partner.com", City: "Pune" }), undefined);
});

await test("B4. the person's own address wins over a secondary one", () => {
  const resolved = resolveContactEmail({
    "Alternate Email": "other@example.com",
    Email: "priya@example.com",
  });
  assert.equal(resolved?.email, "priya@example.com");
});

// ═════════════════════════════════════════════════════════════════
section("C. EXACTLY ONE ROW PER CONTACT, AGAINST THE REAL CLAIM STATEMENT");

const STUB_CONFIG: SheetSyncConfig = {
  spreadsheetId: "test-spreadsheet",
  tabName: "Sheet1",
  clientEmail: "test@example.iam.gserviceaccount.com",
  privateKey: "not-a-real-key-and-never-used",
  isConfigured: true,
};

/** Stands in for Google. Records what would have been appended. */
function makeAppender() {
  const rows: string[][] = [];
  return {
    rows,
    append: async (_config: SheetSyncConfig, values: readonly string[]): Promise<AppendResult> => {
      rows.push([...values]);
      return { updatedRange: `Sheet1!A${rows.length}:C${rows.length}` };
    },
  };
}

const hasDatabase = (process.env.DATABASE_URL ?? "").length > 0;
if (!hasDatabase) {
  console.log("  [SKIP] section C — DATABASE_URL is not set");
} else {
  const campaignId = randomUUID();
  try {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__phase8__', 'registration', 'READY', 'registration', 'v1', $2,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
      [campaignId, hashScript(registrationScript), `phase8-${campaignId}`],
    );

    // One person, imported from a CSV that carried an "Email ID" column
    // alongside two columns nothing reads.
    const contact = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                             csv_row_number, status, attempt_count, metadata)
       VALUES ($1, 'Priya Sharma', '+919811100042', '+919811100042', 'cartesia', 1, 'COMPLETED', 2,
               '{"Email ID":"priya.sharma@example.com","City":"Pune","Source":"webinar"}'::jsonb)
       RETURNING id`,
      [campaignId],
    );
    const contactId = contact.rows[0]!.id;

    const attemptIds: string[] = [];
    for (const attemptNumber of [1, 2]) {
      const attempt = await query<{ id: string }>(
        `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                    status, dialed_at, answered_at, ended_at, failure_class)
         VALUES ($1, $2, $3, 'cartesia', 'vobiz', 'COMPLETED', now(), now(), now(), 'COMPLETED')
         RETURNING id`,
        [campaignId, contactId, attemptNumber],
      );
      attemptIds.push(attempt.rows[0]!.id);
    }

    const registered = settle([
      agent(GREETING),
      agent(PERMISSION),
      caller("Sure, go ahead."),
      agent(GATE),
      caller("Yes, please reserve it."),
    ]);
    const refused = settle([agent(GREETING), agent(GATE), caller("No, I'm not interested.")]);

    await test("C1. a FINAL_YES writes exactly one row, with name, email and phone", async () => {
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: attemptIds[0]!,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        { config: STUB_CONFIG, append: google.append },
      );

      assert.equal(result.synced, true, "the first FINAL_YES must be written");
      assert.equal(google.rows.length, 1, "exactly one row");
      assert.deepEqual(google.rows[0], [
        "Priya Sharma",
        "priya.sharma@example.com",
        "+919811100042",
      ]);

      const counts = await countSheetSyncStates(campaignId);
      assert.deepEqual(counts, { synced: 1, pending: 0, failed: 0 });
    });

    await test("C2. reprocessing the SAME FINAL_YES writes nothing further", async () => {
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: attemptIds[0]!,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        { config: STUB_CONFIG, append: google.append },
      );

      assert.equal(result.synced, false);
      assert.equal(result.synced === false && result.reason, "already-synced");
      assert.equal(google.rows.length, 0, "no second append");
    });

    await test("C3. a LATER ATTEMPT on the same contact still writes nothing further", async () => {
      // The duplicate guard is keyed on the person, not the attempt —
      // a retry that also ends in FINAL_YES is the same registration.
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: attemptIds[1]!,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        { config: STUB_CONFIG, append: google.append },
      );

      assert.equal(result.synced, false);
      assert.equal(google.rows.length, 0, "a second attempt must not add a second row");

      const total = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM sheet_sync WHERE campaign_id = $1",
        [campaignId],
      );
      assert.equal(total.rows[0]?.n, 1, "one contact, one sheet_sync row");
    });

    await test("C4. ten concurrent syncs of the same contact still produce one row", async () => {
      const google = makeAppender();
      await Promise.all(
        Array.from({ length: 10 }, () =>
          syncFinalYesToSheet(
            {
              campaignId,
              contactId,
              attemptId: attemptIds[1]!,
              classification: registered.classification,
              disposition: registered.disposition,
            },
            { config: STUB_CONFIG, append: google.append },
          ),
        ),
      );
      assert.equal(google.rows.length, 0, "the SYNCED row is never re-claimed, under any concurrency");
    });

    await test("C5. a FINAL_NO on the same contact reaches neither the sheet nor the log table", async () => {
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: attemptIds[1]!,
          classification: refused.classification,
          disposition: refused.disposition,
        },
        { config: STUB_CONFIG, append: google.append },
      );

      assert.equal(result.synced, false);
      assert.equal(result.synced === false && result.reason, "not-final-yes");
      assert.equal(google.rows.length, 0);
    });

    await test("C6. a Google failure leaves the outcome alone and the row retryable", async () => {
      // A different contact, so the SYNCED row above is not involved.
      const other = await query<{ id: string }>(
        `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                               csv_row_number, status, attempt_count, metadata)
         VALUES ($1, 'Rahul Verma', '+919811100043', '+919811100043', 'cartesia', 2, 'COMPLETED', 1,
                 '{"Email":"rahul@example.com"}'::jsonb)
         RETURNING id`,
        [campaignId],
      );
      const otherId = other.rows[0]!.id;
      const otherAttempt = await query<{ id: string }>(
        `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                    status, dialed_at, answered_at, ended_at, failure_class)
         VALUES ($1, $2, 1, 'cartesia', 'vobiz', 'COMPLETED', now(), now(), now(), 'COMPLETED')
         RETURNING id`,
        [campaignId, otherId],
      );

      const failing = async (): Promise<AppendResult> => {
        throw new Error("simulated Google Sheets 403");
      };

      // Must RESOLVE, not reject: this is the property the call-runner
      // depends on.
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId: otherId,
          attemptId: otherAttempt.rows[0]!.id,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        { config: STUB_CONFIG, append: failing },
      );

      assert.equal(result.synced, false);
      assert.equal(result.synced === false && result.reason, "write-failed");

      const counts = await countSheetSyncStates(campaignId);
      assert.equal(counts.failed, 1, "the failed write is recorded, not lost");
      assert.equal(counts.synced, 1, "the earlier success is untouched");

      // ...and a later reprocess is allowed to retry it, exactly once.
      const google = makeAppender();
      const retry = await syncFinalYesToSheet(
        {
          campaignId,
          contactId: otherId,
          attemptId: otherAttempt.rows[0]!.id,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        { config: STUB_CONFIG, append: google.append },
      );
      assert.equal(retry.synced, true, "a FAILED row is retryable");
      assert.equal(google.rows.length, 1);
      assert.deepEqual(google.rows[0], ["Rahul Verma", "rahul@example.com", "+919811100043"]);

      const after = await countSheetSyncStates(campaignId);
      assert.deepEqual(after, { synced: 2, pending: 0, failed: 0 });
    });

    await test("C7. an unconfigured deployment writes nothing and reports what is missing", async () => {
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: attemptIds[0]!,
          classification: registered.classification,
          disposition: registered.disposition,
        },
        {
          config: { ...STUB_CONFIG, spreadsheetId: "", isConfigured: false },
          append: google.append,
        },
      );

      assert.equal(result.synced, false);
      assert.equal(result.synced === false && result.reason, "not-configured");
      assert.equal(google.rows.length, 0);
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
    await closeDbPool();
  }
}

// ─────────────────────────────────────────────────────────────────
section("D. DEPLOYMENT CONFIGURATION, AS CURRENTLY SET");
const liveConfig = getSheetSyncConfig();
const missing = missingSheetConfigKeys(liveConfig);
console.log(
  missing.length === 0
    ? `  sheet sync is CONFIGURED (spreadsheet ${liveConfig.spreadsheetId}, tab "${liveConfig.tabName}")`
    : `  sheet sync is NOT configured — still required: ${missing.join(", ")}`,
);
console.log("  (this is a report, not an assertion — an unconfigured deployment is a valid one)");

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
console.log("No telephony, TTS, STT or LLM request was made. No call was placed. Google was not contacted.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
