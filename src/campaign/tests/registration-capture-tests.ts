/**
 * registration-capture-tests.ts — `npm run test:registration-capture`
 *
 * ROADMAP §5 B8 — REGISTRATION CAPTURE / RECONCILIATION REPORTING.
 *
 * B8 asks for a before/after comparison of registration conversion. The
 * conversion figure already exists and is correct, so the thing that was
 * missing is the OTHER half: of the people who said yes, how many
 * actually have a row in the sheet?
 *
 * The one mistake this block invites is the one every test below exists
 * to prevent — letting a delivery failure move a sales number, or a
 * sales number move a delivery one. So the suite proves three things:
 *
 *   1. the capture figures are correct against a deliberately mixed
 *      fixture, where every `sheet_sync` state is represented;
 *   2. the two rates have DIFFERENT denominators and are independent —
 *      breaking the sheet moves capture and leaves conversion exactly
 *      where it was;
 *   3. nothing an existing consumer of the results report reads has
 *      changed shape.
 *
 * Every figure is read through the REAL `buildCampaignResults` against
 * real PostgreSQL. Nothing is stubbed.
 *
 * NOTHING HERE PLACES A CALL, AND NOTHING HERE CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { buildCampaignResults } = await import("../results/campaign-results");
const { registrationCaptureCounts } = await import("../results/results.repo");
const { findScript, hashScript } = await import("../script/script-registry");
const { query, closeDbPool } = await import("../db/client");

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

/**
 * Every top-level key the report carried BEFORE this change, listed
 * literally rather than derived, so a key that disappears fails here
 * instead of in somebody's dashboard.
 */
const PRE_EXISTING_KEYS = [
  "campaign",
  "dialing",
  "contacts",
  "funnel",
  "providers",
  "outcomes",
  "contactOutcomes",
  "conversation",
  "voice",
  "orchestration",
  "dataHealth",
  "generatedAt",
] as const;

const hasDatabase = (process.env.DATABASE_URL ?? "").length > 0;
if (!hasDatabase) {
  console.log("  [SKIP] every section — DATABASE_URL is not set");
} else {
  const campaignId = randomUUID();
  const emptyCampaignId = randomUUID();
  const registrationScript = findScript("registration", "v1");
  assert.ok(registrationScript, "the approved registration script must be registered");
  const scriptHash = hashScript(registrationScript);

  async function makeCampaign(id: string, name: string): Promise<void> {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, $2, 'registration', 'READY', 'registration', 'v1', $3,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $4, '{"agent":{"gender":"female"}}'::jsonb)`,
      [id, name, scriptHash, `capture-${id}`],
    );
  }

  let row = 0;
  /** One contact, with a chosen final disposition and a chosen sheet_sync state. */
  async function makeContact(
    disposition: string | null,
    sheetState: "SYNCED" | "FAILED" | "PENDING" | null,
  ): Promise<{ id: string; phone: string }> {
    row += 1;
    const phone = `+9198222${String(row).padStart(5, "0")}`;
    const contact = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                             csv_row_number, status, attempt_count, metadata, final_disposition,
                             closed_at, closure_reason)
       VALUES ($1, $2, $3, $3, 'cartesia', $4, 'COMPLETED', 1,
               '{"Email":"person@example.com"}'::jsonb, $5,
               -- The schema refuses a FINAL_YES/FINAL_NO contact that is
               -- not closed (contacts_definitive_outcome_is_closed), so
               -- the fixture obeys the same rule production does.
               CASE WHEN $5 IN ('FINAL_YES','FINAL_NO') THEN now() END,
               CASE WHEN $5 IN ('FINAL_YES','FINAL_NO') THEN 'fixture' END)
       RETURNING id`,
      [campaignId, `Person ${row}`, phone, row, disposition],
    );
    const id = contact.rows[0]!.id;
    if (sheetState) await makeSheetRow(phone, id, sheetState);
    return { id, phone };
  }

  /** `sheet_sync` enforces `(state = 'SYNCED') = (synced_at IS NOT NULL)`, so both move together. */
  async function makeSheetRow(
    phone: string,
    contactId: string,
    state: "SYNCED" | "FAILED" | "PENDING",
  ): Promise<void> {
    await query(
      `INSERT INTO sheet_sync (campaign_id, normalized_phone, contact_id, spreadsheet_id, state, synced_at)
       VALUES ($1, $2, $3, 'test-spreadsheet', $4, CASE WHEN $4 = 'SYNCED' THEN now() END)`,
      [campaignId, phone, contactId, state],
    );
  }

  try {
    await makeCampaign(campaignId, "__registration_capture__");
    await makeCampaign(emptyCampaignId, "__registration_capture_empty__");

    // ── The fixture, chosen so every count below has a DIFFERENT
    //    value. Equal numbers would let a wrong field pass.
    //
    //    10 contacts:
    //      5 FINAL_YES  -> 2 SYNCED, 1 FAILED, 1 PENDING, 1 no row
    //      2 FINAL_NO   -> one of them carries a stray SYNCED row
    //      1 RETRYABLE, 2 unclassified
    await makeContact("FINAL_YES", "SYNCED");
    await makeContact("FINAL_YES", "SYNCED");
    await makeContact("FINAL_YES", "FAILED");
    await makeContact("FINAL_YES", "PENDING");
    await makeContact("FINAL_YES", null);
    // The drift case: a row in the sheet for somebody the classifier no
    // longer calls a registration. Real — a re-classification can do it.
    await makeContact("FINAL_NO", "SYNCED");
    await makeContact("FINAL_NO", null);
    await makeContact("RETRYABLE", null);
    await makeContact(null, null);
    await makeContact(null, null);

    const results = await buildCampaignResults(campaignId);
    assert.ok(results, "the fixture campaign must produce a report");

    // ═════════════════════════════════════════════════════════════
    section("A. THE CAPTURE FIGURES ARE CORRECT AGAINST A MIXED FIXTURE");

    await test("A1. confirmed counts the FINAL_YES contacts, and nothing else", () => {
      assert.equal(results.registrationCapture.confirmed, 5);
      assert.equal(
        results.registrationCapture.confirmed,
        results.contactOutcomes.byDisposition.FINAL_YES,
        "capture and the disposition block must read the same five people",
      );
    });

    await test("A2. synced, failed, pending and notAttempted are each correct", () => {
      const capture = results.registrationCapture;
      assert.equal(capture.synced, 2, "two registrations reached the sheet");
      assert.equal(capture.failed, 1, "one write was attempted and refused");
      assert.equal(capture.pending, 1, "one claim is in flight");
      assert.equal(capture.notAttempted, 1, "one was never presented to the sheet at all");
    });

    await test("A3. the four states split `confirmed` exhaustively — the reconciliation identity", () => {
      const c = results.registrationCapture;
      assert.equal(
        c.synced + c.failed + c.pending + c.notAttempted,
        c.confirmed,
        "a confirmed registration is in exactly one of the four states, always",
      );
    });

    await test("A4. totalContacts is every contact, and agrees with the contact block", () => {
      assert.equal(results.registrationCapture.totalContacts, 10);
      assert.equal(results.registrationCapture.totalContacts, results.contactOutcomes.total);
    });

    await test("A5. sheetRowsTotal sees rows the current verdicts no longer claim", () => {
      // 3 SYNCED rows exist; only 2 belong to a FINAL_YES contact.
      assert.equal(results.registrationCapture.sheetRowsTotal, 3);
      assert.equal(
        results.registrationCapture.sheetRowsTotal - results.registrationCapture.synced,
        1,
        "the drift between the sheet and the current verdicts must be visible, not hidden",
      );
    });

    await test("A6. the report and the repository agree exactly", async () => {
      const direct = await registrationCaptureCounts(campaignId);
      assert.deepEqual(direct, {
        confirmed: results.registrationCapture.confirmed,
        synced: results.registrationCapture.synced,
        failed: results.registrationCapture.failed,
        pending: results.registrationCapture.pending,
        notAttempted: results.registrationCapture.notAttempted,
        sheetRowsTotal: results.registrationCapture.sheetRowsTotal,
      });
    });

    await test("A7. the counts match a hand-written reconciliation of the two tables", async () => {
      const hand = await query<{ d: string; s: string | null; n: number }>(
        `SELECT c.final_disposition AS d, s.state AS s, count(*)::int AS n
           FROM contacts c
           LEFT JOIN sheet_sync s ON s.campaign_id = c.campaign_id
                                 AND s.normalized_phone = c.normalized_phone
          WHERE c.campaign_id = $1 AND c.final_disposition = 'FINAL_YES'
          GROUP BY 1, 2`,
        [campaignId],
      );
      const byState = new Map(hand.rows.map((r) => [r.s ?? "NONE", Number(r.n)]));
      const capture = results.registrationCapture;
      assert.equal(byState.get("SYNCED") ?? 0, capture.synced);
      assert.equal(byState.get("FAILED") ?? 0, capture.failed);
      assert.equal(byState.get("PENDING") ?? 0, capture.pending);
      assert.equal(byState.get("NONE") ?? 0, capture.notAttempted);
    });

    // ═════════════════════════════════════════════════════════════
    section("B. THE CAPTURE RATE AND THE CONVERSION RATE ARE DIFFERENT NUMBERS");

    await test("B1. the capture rate's denominator is CONFIRMED, never total contacts", () => {
      const captureRate = results.registrationCapture.captureRate;
      assert.equal(captureRate.numerator, 2, "synced");
      assert.equal(captureRate.denominator, 5, "FINAL_YES — not the 10 contacts");
      assert.equal(captureRate.value, 0.4);
    });

    await test("B2. the conversion rate's denominator is still TOTAL CONTACTS", () => {
      const conversion = results.contactOutcomes.conversionRate;
      assert.equal(conversion.numerator, 5, "FINAL_YES");
      assert.equal(conversion.denominator, 10, "every contact imported, including those never called");
      assert.equal(conversion.value, 0.5);
    });

    await test("B3. conversion is unchanged by this batch — it is still FINAL_YES over contacts", () => {
      const { conversionRate, finalYesRate, byDisposition, total } = results.contactOutcomes;
      assert.deepEqual(conversionRate, finalYesRate, "the two existing figures still agree");
      assert.equal(conversionRate.numerator, byDisposition.FINAL_YES);
      assert.equal(conversionRate.denominator, total);
      assert.notDeepEqual(
        conversionRate,
        results.registrationCapture.captureRate,
        "the two rates must not be the same object or the same number by accident",
      );
    });

    await test("B4. BREAKING THE SHEET MOVES CAPTURE AND LEAVES CONVERSION ALONE", async () => {
      const before = await buildCampaignResults(campaignId);
      assert.ok(before);

      // Google starts failing: one synced row becomes a failed one.
      // Nothing about what the PEOPLE decided has changed.
      const victim = await query<{ normalized_phone: string }>(
        `SELECT normalized_phone FROM sheet_sync
          WHERE campaign_id = $1 AND state = 'SYNCED'
            AND normalized_phone IN (SELECT normalized_phone FROM contacts
                                      WHERE campaign_id = $1 AND final_disposition = 'FINAL_YES')
          ORDER BY normalized_phone LIMIT 1`,
        [campaignId],
      );
      const phone = victim.rows[0]!.normalized_phone;
      await query(
        `UPDATE sheet_sync SET state = 'FAILED', synced_at = NULL, last_error = 'simulated outage'
          WHERE campaign_id = $1 AND normalized_phone = $2`,
        [campaignId, phone],
      );

      try {
        const after = await buildCampaignResults(campaignId);
        assert.ok(after);

        assert.deepEqual(
          after.contactOutcomes.conversionRate,
          before.contactOutcomes.conversionRate,
          "a Google outage must NOT move the conversion rate",
        );
        assert.deepEqual(
          after.contactOutcomes.byDisposition,
          before.contactOutcomes.byDisposition,
          "and must not move a single disposition count",
        );
        assert.equal(after.funnel.successes, before.funnel.successes, "nor the funnel's successes");

        assert.equal(after.registrationCapture.synced, before.registrationCapture.synced - 1);
        assert.equal(after.registrationCapture.failed, before.registrationCapture.failed + 1);
        assert.equal(after.registrationCapture.captureRate.value, 0.2, "capture fell from 2/5 to 1/5");
        assert.equal(
          after.registrationCapture.confirmed,
          before.registrationCapture.confirmed,
          "the number of people who said yes is untouched",
        );
      } finally {
        await query(
          `UPDATE sheet_sync SET state = 'SYNCED', synced_at = now(), last_error = NULL
            WHERE campaign_id = $1 AND normalized_phone = $2`,
          [campaignId, phone],
        );
      }
    });

    await test("B5. a campaign with no registrations reports a rate with no denominator", async () => {
      const empty = await buildCampaignResults(emptyCampaignId);
      assert.ok(empty);
      assert.equal(empty.registrationCapture.confirmed, 0);
      assert.equal(empty.registrationCapture.captureRate.value, null, "0/0 is not 0%, and not 100%");
      assert.equal(empty.registrationCapture.captureRate.denominator, 0);
      assert.equal(
        empty.contactOutcomes.conversionRate.value,
        null,
        "the existing rate behaves the same way, and still does",
      );
    });

    await test("B6. the note says out loud which denominator is which", () => {
      const note = results.registrationCapture.note;
      assert.match(note, /denominator/i);
      assert.match(note, /FINAL_YES/);
      assert.ok(
        results.contactOutcomes.note !== note,
        "the two blocks must not share a note that could be read as one rule",
      );
    });

    // ═════════════════════════════════════════════════════════════
    section("C. EXISTING CONSUMERS OF THE REPORT ARE UNAFFECTED");

    await test("C1. every pre-existing top-level key is still present", () => {
      for (const key of PRE_EXISTING_KEYS) {
        assert.ok(key in results, `the report lost "${key}"`);
      }
    });

    await test("C2. the only added top-level key is registrationCapture", () => {
      const added = Object.keys(results).filter(
        (key) => !(PRE_EXISTING_KEYS as readonly string[]).includes(key),
      );
      assert.deepEqual(added, ["registrationCapture"], "this batch must add exactly one block");
    });

    await test("C3. the block the dashboard reads is structurally untouched", () => {
      // The fields `campaign-results.tsx` reads by name today.
      const c = results.contactOutcomes;
      for (const key of [
        "total",
        "byDisposition",
        "totalAttempts",
        "conversionRate",
        "finalYesRate",
        "finalNoRate",
        "stillEligible",
        "permanentlyClosed",
        "perProvider",
        "note",
      ]) {
        assert.ok(key in c, `contactOutcomes lost "${key}"`);
      }
      for (const key of ["value", "numerator", "denominator"]) {
        assert.ok(key in c.conversionRate, `Rate lost "${key}"`);
      }
    });

    await test("C4. the report still serialises to JSON, which is how it reaches every consumer", () => {
      const json = JSON.parse(JSON.stringify(results)) as Record<string, unknown>;
      const capture = json["registrationCapture"] as Record<string, unknown>;
      assert.equal(capture["confirmed"], 5);
      assert.equal(capture["synced"], 2);
      assert.ok(json["contactOutcomes"], "and carries everything it carried before");
    });

    await test("C5. building the report writes nothing — the fixture is exactly as it was", async () => {
      const counts = await query<{ contacts: number; rows: number }>(
        `SELECT (SELECT count(*)::int FROM contacts WHERE campaign_id = $1) AS contacts,
                (SELECT count(*)::int FROM sheet_sync WHERE campaign_id = $1) AS rows`,
        [campaignId],
      );
      assert.equal(counts.rows[0]?.contacts, 10);
      // 4 rows for the FINAL_YES mix (SYNCED, SYNCED, FAILED, PENDING)
      // plus the one stray SYNCED row on a FINAL_NO contact.
      assert.equal(counts.rows[0]?.rows, 5);
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
    await query("DELETE FROM campaigns WHERE id = $1", [emptyCampaignId]).catch(() => undefined);
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
