/**
 * registration-payload-tests.ts — `npm run test:registration-payload`
 *
 * BATCH C — THE CANONICAL REGISTRATION PAYLOAD (roadmap §5 B2).
 *
 * B2 asks for a canonical payload — "name, phone, email, campaign/
 * context, and any required metadata". The sheet carries three of those
 * and the spreadsheet's columns are a live business artefact, so the
 * payload is named in full and the sheet row is one deliberately lossy
 * PROJECTION of it.
 *
 * That makes two things worth proving, and they pull against each
 * other:
 *
 *   1. the payload is COMPLETE and its fields come from the
 *      authoritative imported record — never from the conversation;
 *   2. the sheet row is UNCHANGED — same three cells, same order, same
 *      trimming, byte for byte, because adding a column to a
 *      spreadsheet people already read is a business decision and has
 *      not been taken.
 *
 * Section D also pins the campaign-scoped identity that Batch B's retry
 * depends on: a retry is the same key, another campaign is a different
 * one, and neither was changed.
 *
 * NOTHING HERE PLACES A CALL, AND NOTHING HERE CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { buildRegistrationPayload, sheetRowFor, SHEET_COLUMNS, REGISTRATION_FIELD_SOURCES } = await import(
  "../integrations/registration-payload"
);
const { resolveContactEmail } = await import("../integrations/contact-email");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { syncFinalYesToSheet } = await import("../integrations/final-yes-sheet");
const { findScript, hashScript } = await import("../script/script-registry");
const { query, closeDbPool } = await import("../db/client");

import type { SheetSyncConfig } from "../config/sheet.config";
import type { AppendResult } from "../integrations/google-sheets.client";
import type { SheetContactDetail } from "../db/repositories/sheet-sync.repo";
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

const contactOf = (over: Partial<SheetContactDetail> = {}): SheetContactDetail => ({
  name: "Priya Sharma",
  normalizedPhone: "+919811100042",
  originalPhone: "9811100042",
  metadata: { Email: "priya@example.com", City: "Pune" },
  ...over,
});

const payloadOf = (contact: SheetContactDetail) =>
  buildRegistrationPayload({
    contact,
    campaignId: "campaign-1",
    contactId: "contact-1",
    attemptId: "attempt-1",
  });

/**
 * The row expression EXACTLY as `final-yes-sheet.ts` built it inline
 * before this batch, reproduced here as the reference the projection is
 * measured against. If the two ever disagree, the sheet's contract has
 * changed and this fails.
 */
function rowAsItWasBuiltBefore(contact: SheetContactDetail): string[] {
  const resolvedEmail = resolveContactEmail(contact.metadata);
  return [contact.name?.trim() ?? "", resolvedEmail?.email ?? "", contact.normalizedPhone];
}

// ═════════════════════════════════════════════════════════════════
section("A. THE SHEET ROW IS BYTE-IDENTICAL TO WHAT IT WAS");

await test("A1. the projection matches the pre-batch expression, cell for cell", () => {
  const cases: SheetContactDetail[] = [
    contactOf(),
    contactOf({ name: "  Rahul Verma  " }),
    contactOf({ name: null }),
    contactOf({ metadata: {} }),
    contactOf({ metadata: { "Email ID": "r@example.co.in" } }),
    contactOf({ metadata: { "Email Verified": "yes" } }),
    contactOf({ metadata: { "Alternate Email": "other@x.com", Email: "own@x.com" } }),
    contactOf({ name: "", metadata: { Email: "" } }),
  ];
  for (const contact of cases) {
    assert.deepEqual(
      sheetRowFor(payloadOf(contact)),
      rowAsItWasBuiltBefore(contact),
      `the row changed for ${JSON.stringify(contact.metadata)}`,
    );
  }
});

await test("A2. exactly three columns, in the documented order", () => {
  const row = sheetRowFor(payloadOf(contactOf()));
  assert.equal(row.length, 3, "a fourth column is a business decision, not a refactor");
  assert.equal(row.length, SHEET_COLUMNS.length, "the named contract and the row must agree");
  assert.deepEqual([...SHEET_COLUMNS], ["Name", "Email", "Phone"]);
  assert.deepEqual(row, ["Priya Sharma", "priya@example.com", "+919811100042"]);
});

await test("A3. the client still appends to A:C — the range was not widened", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/campaign/integrations/google-sheets.client.ts", "utf8");
  assert.ok(source.includes("'!A:C'") || source.includes("!A:C"), "the append range must still be A:C");
});

await test("A4. the name is trimmed and a missing one is an empty cell, never 'null'", () => {
  assert.equal(sheetRowFor(payloadOf(contactOf({ name: "  Priya  " })))[0], "Priya");
  assert.equal(sheetRowFor(payloadOf(contactOf({ name: null })))[0], "");
  assert.equal(sheetRowFor(payloadOf(contactOf({ name: "   " })))[0], "");
});

await test("A5. a missing email is an empty cell, and the row still goes", () => {
  const row = sheetRowFor(payloadOf(contactOf({ metadata: { City: "Pune" } })));
  assert.deepEqual(row, ["Priya Sharma", "", "+919811100042"]);
});

// ═════════════════════════════════════════════════════════════════
section("B. THE PAYLOAD USES THE AUTHORITATIVE IMPORTED RECORD");

await test("B1. every sheet-bound field comes from the stored contact", () => {
  const payload = payloadOf(contactOf());
  assert.equal(payload.name, "Priya Sharma", "contacts.name");
  assert.equal(payload.email, "priya@example.com", "contacts.metadata");
  assert.equal(payload.phone, "+919811100042", "contacts.normalized_phone");
  assert.equal(payload.emailSourceColumn, "Email", "and it records WHICH column it read");
});

await test("B2. the three imported fields are declared as imported, not collected", () => {
  assert.equal(REGISTRATION_FIELD_SOURCES["name"], "imported");
  assert.equal(REGISTRATION_FIELD_SOURCES["email"], "imported");
  assert.equal(REGISTRATION_FIELD_SOURCES["phone"], "imported");
});

await test("B3. THE CALL CANNOT REACH A CELL — the builder takes no conversation", async () => {
  // Structural, because this is the property that matters: there is no
  // parameter through which a transcript, a classification or an LLM
  // output could become a registration field.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/campaign/integrations/registration-payload.ts", "utf8");
  const inputStart = source.indexOf("export interface BuildRegistrationPayloadInput");
  const inputEnd = source.indexOf("}", inputStart);
  const inputBlock = source.slice(inputStart, inputEnd);
  for (const forbidden of ["transcript", "classification", "turns", "utterance", "Conversation"]) {
    assert.ok(
      !inputBlock.includes(forbidden),
      `the payload input must not accept "${forbidden}" — imported data is not overwritten by a call`,
    );
  }
});

await test("B4. the imported name is preserved verbatim, whatever was said on the call", () => {
  // A person whose imported name is "Priya Sharma" keeps it. Nothing in
  // the payload path can substitute a name heard on the phone, because
  // nothing in the payload path has one.
  const payload = payloadOf(contactOf({ name: "Priya Sharma" }));
  assert.equal(payload.name, "Priya Sharma");
  assert.equal(sheetRowFor(payload)[0], "Priya Sharma");
});

await test("B5. a referrer's address is never harvested into a registration", () => {
  const payload = payloadOf(contactOf({ metadata: { "Referred By": "agent@partner.com", City: "Pune" } }));
  assert.equal(payload.email, "", "writing somebody else's address is the unrecoverable error");
  assert.equal(payload.emailSourceColumn, undefined);
});

await test("B6. the context fields are on the payload, and are NOT in the row", () => {
  const payload = payloadOf(contactOf());
  assert.equal(payload.campaignId, "campaign-1");
  assert.equal(payload.contactId, "contact-1");
  assert.equal(payload.attemptId, "attempt-1");

  const row = sheetRowFor(payload);
  for (const value of ["campaign-1", "contact-1", "attempt-1"]) {
    assert.ok(!row.includes(value), `"${value}" must not be stuffed into a spreadsheet cell`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. CAMPAIGN CONTEXT REACHES THE OPERATOR THROUGH THE EXISTING ARCHITECTURE");

const GATE = "So Priya, should I reserve your free seat for the live event?";
const TURNS: readonly TranscriptTurn[] = [
  { role: "assistant", text: "Hi Priya, this is Ishita from Team FlexiFunnels.", at: null },
  { role: "assistant", text: GATE, at: null },
  { role: "user", text: "Yes, please reserve it.", at: null },
  { role: "assistant", text: "Perfect! I'll get your registration confirmed.", at: null },
];
const classification = classifyOutcome({
  campaignType: "registration",
  status: "COMPLETED",
  failureClass: "COMPLETED",
  answered: true,
  transcript: TURNS,
});
const { disposition } = dispositionFor({
  outcomeType: classification.outcomeType,
  failureClass: "COMPLETED",
});
assert.equal(disposition, "FINAL_YES", "the fixture must be a registration");

const STUB_CONFIG: SheetSyncConfig = {
  spreadsheetId: "test-spreadsheet",
  tabName: "Sheet1",
  clientEmail: "test@example.iam.gserviceaccount.com",
  privateKey: "not-a-real-key-and-never-used",
  isConfigured: true,
};

function makeAppender() {
  const rows: string[][] = [];
  return {
    rows,
    append: async (_c: SheetSyncConfig, values: readonly string[]): Promise<AppendResult> => {
      rows.push([...values]);
      return { updatedRange: `Sheet1!A${rows.length}:C${rows.length}` };
    },
  };
}

function makeRecorder() {
  const events: { code: string; campaignId: string; data: Record<string, unknown> }[] = [];
  return {
    events,
    log: async (
      campaignId: string,
      code: string,
      _m: string,
      data?: Record<string, unknown>,
    ): Promise<void> => {
      events.push({ code, campaignId, data: data ?? {} });
    },
  };
}

const hasDatabase = (process.env.DATABASE_URL ?? "").length > 0;
if (!hasDatabase) {
  console.log("  [SKIP] sections C and D — DATABASE_URL is not set");
} else {
  const campaignA = randomUUID();
  const campaignB = randomUUID();
  const script = findScript("registration", "v1");
  assert.ok(script);

  async function makeCampaign(id: string, name: string): Promise<void> {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1,$2,'registration','READY','registration','v1',$3,
               '{"cartesia":100}'::jsonb,'vobiz','en',$4,'{"agent":{"gender":"female"}}'::jsonb)`,
      [id, name, hashScript(script!), `payload-${id}`],
    );
  }

  async function makePerson(campaignId: string, phone: string, rowNumber: number) {
    const contact = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                             csv_row_number, status, attempt_count, metadata)
       VALUES ($1,'Priya Sharma',$2,$2,'cartesia',$3,'COMPLETED',1,
               '{"Email":"priya@example.com","City":"Pune"}'::jsonb)
       RETURNING id`,
      [campaignId, phone, rowNumber],
    );
    const contactId = contact.rows[0]!.id;
    const attempt = await query<{ id: string }>(
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                  status, dialed_at, answered_at, ended_at, failure_class)
       VALUES ($1,$2,1,'cartesia','vobiz','COMPLETED',now(),now(),now(),'COMPLETED')
       RETURNING id`,
      [campaignId, contactId],
    );
    return { contactId, attemptId: attempt.rows[0]!.id };
  }

  try {
    await makeCampaign(campaignA, "__payload_a__");
    await makeCampaign(campaignB, "__payload_b__");

    await test("C1. the written row is the three imported cells, through the real writer", async () => {
      const { contactId, attemptId } = await makePerson(campaignA, "+919811100042", 1);
      const google = makeAppender();
      const result = await syncFinalYesToSheet(
        { campaignId: campaignA, contactId, attemptId, classification, disposition },
        { config: STUB_CONFIG, append: google.append, logEvent: makeRecorder().log },
      );
      assert.equal(result.synced, true);
      assert.deepEqual(google.rows[0], ["Priya Sharma", "priya@example.com", "+919811100042"]);
      assert.equal(google.rows[0]!.length, 3);
    });

    await test("C2. the campaign/attempt/contact context is on the EVENT, not in the sheet", async () => {
      const { contactId, attemptId } = await makePerson(campaignA, "+919811100043", 2);
      const google = makeAppender();
      const recorder = makeRecorder();
      await syncFinalYesToSheet(
        { campaignId: campaignA, contactId, attemptId, classification, disposition },
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      await new Promise((r) => setImmediate(r));

      const event = recorder.events.find((e) => e.code === "REGISTRATION_SYNCED");
      assert.ok(event, "the registration must carry its context somewhere durable");
      assert.equal(event.campaignId, campaignA, "campaign");
      assert.equal(event.data["contactId"], contactId, "person");
      assert.equal(event.data["attemptId"], attemptId, "call");
      assert.equal(event.data["hasEmail"], true, "and whether the row went out with an address");

      assert.ok(!google.rows[0]!.includes(campaignA), "none of which is a spreadsheet cell");
    });

    await test("C3. the campaign row is the join for script and context — no copy is needed", async () => {
      const joined = await query<{ script_id: string; script_version: string; name: string }>(
        `SELECT script_id, script_version, name FROM campaigns WHERE id = $1`,
        [campaignA],
      );
      assert.equal(joined.rows[0]?.script_id, "registration");
      assert.equal(joined.rows[0]?.script_version, "v1");
      assert.ok(joined.rows[0]?.name, "reachable from the event's campaignId in one join");
    });

    // ═════════════════════════════════════════════════════════════
    section("D. CAMPAIGN-SCOPED IDENTITY IS UNCHANGED");

    await test("D1. the same person in ANOTHER campaign is a separate registration", async () => {
      const phone = "+919811100099";
      const a = await makePerson(campaignA, phone, 10);
      const b = await makePerson(campaignB, phone, 10);
      const google = makeAppender();

      const first = await syncFinalYesToSheet(
        { campaignId: campaignA, contactId: a.contactId, attemptId: a.attemptId, classification, disposition },
        { config: STUB_CONFIG, append: google.append, logEvent: makeRecorder().log },
      );
      const second = await syncFinalYesToSheet(
        { campaignId: campaignB, contactId: b.contactId, attemptId: b.attemptId, classification, disposition },
        { config: STUB_CONFIG, append: google.append, logEvent: makeRecorder().log },
      );

      assert.equal(first.synced, true);
      assert.equal(second.synced, true, "cross-campaign registrations must NOT be collapsed by this batch");
      assert.equal(google.rows.length, 2, "two campaigns, two rows — the existing policy, unchanged");
    });

    await test("D2. the same person in the SAME campaign is one registration, however often presented", async () => {
      const { contactId, attemptId } = await makePerson(campaignA, "+919811100044", 11);
      const google = makeAppender();
      const input = { campaignId: campaignA, contactId, attemptId, classification, disposition };
      const deps = { config: STUB_CONFIG, append: google.append, logEvent: makeRecorder().log };

      await syncFinalYesToSheet(input, deps);
      await syncFinalYesToSheet(input, deps);
      await syncFinalYesToSheet(input, deps);

      assert.equal(google.rows.length, 1, "a retry is the same key and cannot produce a second row");
    });

    await test("D3. the sheet_sync key is still (campaign_id, normalized_phone)", async () => {
      const key = await query<{ attname: string }>(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'sheet_sync'::regclass AND i.indisprimary
          ORDER BY a.attname`,
      );
      assert.deepEqual(
        key.rows.map((r) => r.attname),
        ["campaign_id", "normalized_phone"],
        "the identity policy is a business decision and was not changed by this batch",
      );
    });

    await test("D4. one person, two campaigns — two sheet_sync rows, neither shadowing the other", async () => {
      const rows = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sheet_sync
          WHERE normalized_phone = '+919811100099' AND campaign_id IN ($1,$2)`,
        [campaignA, campaignB],
      );
      assert.equal(rows.rows[0]?.n, 2);
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignA]).catch(() => undefined);
    await query("DELETE FROM campaigns WHERE id = $1", [campaignB]).catch(() => undefined);
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
