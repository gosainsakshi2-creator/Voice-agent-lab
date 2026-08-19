/**
 * verify-constraints.ts
 *
 * Proves the campaign schema's safety guarantees against the real
 * database: `npm run db:verify`.
 *
 * These are the guarantees the campaign design rests on, and asserting
 * them in TypeScript would prove nothing — TypeScript is exactly the
 * layer we are refusing to trust. Each test therefore issues a
 * statement that MUST be rejected by PostgreSQL and fails if the
 * statement succeeds.
 *
 * Everything runs inside a single transaction that is always rolled
 * back, with one SAVEPOINT per test so an expected constraint
 * violation does not abort the rest of the run. Nothing is left in
 * the database, so this is safe to run against the campaign database
 * at any time — including between real campaigns.
 *
 * No telephony, TTS, STT or LLM provider is contacted. Nothing dials.
 */

import type { PoolClient } from "pg";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { getDbPool, closeDbPool } = await import("./client");
const { TEXT_TO_SPEECH_PROVIDER_IDS } = await import("../../constants/providers.constants");

const CARTESIA = TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA;
const SARVAM = TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM;
const SMALLEST = TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI;

interface TestResult {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

const results: TestResult[] = [];
let savepointCounter = 0;

function record(id: string, description: string, passed: boolean, detail: string): void {
  results.push({ id, description, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id}  ${description}`);
  console.log(`         ${detail}`);
}

/** The statement MUST be rejected. Succeeding is a test failure. */
async function expectRejection(
  client: PoolClient,
  id: string,
  description: string,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  savepointCounter += 1;
  const savepoint = `sp_${savepointCounter}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, [...params]);
    record(id, description, false, "NOT REJECTED — the database accepted a statement it must refuse");
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    const firstLine = (pgError.message ?? String(error)).split("\n")[0] ?? "";
    record(id, description, true, `rejected with SQLSTATE ${pgError.code ?? "?"} — ${firstLine}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

/** Control case: the statement must be accepted, or the rule is too broad. */
async function expectSuccess(
  client: PoolClient,
  id: string,
  description: string,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  savepointCounter += 1;
  const savepoint = `sp_${savepointCounter}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await client.query(sql, [...params]);
    record(id, description, true, `accepted — ${result.rowCount ?? 0} row(s) affected`);
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    const firstLine = (pgError.message ?? String(error)).split("\n")[0] ?? "";
    record(id, description, false, `WRONGLY REJECTED — SQLSTATE ${pgError.code ?? "?"} — ${firstLine}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

/** Row count assertion, for the ON CONFLICT DO NOTHING strategies. */
async function expectRowCount(
  client: PoolClient,
  id: string,
  description: string,
  expected: number,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  savepointCounter += 1;
  const savepoint = `sp_${savepointCounter}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await client.query(sql, [...params]);
    const actual = result.rowCount ?? 0;
    record(
      id,
      description,
      actual === expected,
      actual === expected
        ? `inserted ${actual} row(s) as expected — duplicate silently ignored`
        : `expected ${expected} row(s), got ${actual}`,
    );
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    const firstLine = (pgError.message ?? String(error)).split("\n")[0] ?? "";
    record(id, description, false, `unexpected error — SQLSTATE ${pgError.code ?? "?"} — ${firstLine}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

async function main(): Promise<void> {
  const client = await getDbPool().connect();

  try {
    // One outer transaction, always rolled back — no fixture survives.
    await client.query("BEGIN");

    // ── Fixtures ────────────────────────────────────────────────
    const campaign = await client.query<{ id: string }>(
      `INSERT INTO campaigns
         (name, campaign_type, script_id, script_version, script_hash,
          provider_allocation, telephony_provider, language)
       VALUES ('__verify__', 'registration', 'placeholder', 'v0', 'none',
               $1::jsonb, 'vobiz', 'en')
       RETURNING id`,
      [JSON.stringify({ [CARTESIA]: 33.34, [SARVAM]: 33.33, [SMALLEST]: 33.33 })],
    );
    const campaignId = campaign.rows[0]?.id;
    if (!campaignId) throw new Error("fixture campaign was not created");

    const otherCampaign = await client.query<{ id: string }>(
      `INSERT INTO campaigns
         (name, campaign_type, script_id, script_version, script_hash,
          provider_allocation, telephony_provider, language)
       VALUES ('__verify_other__', 'reminder', 'placeholder', 'v0', 'none',
               '{}'::jsonb, 'vobiz', 'en')
       RETURNING id`,
      [],
    );
    const otherCampaignId = otherCampaign.rows[0]?.id;
    if (!otherCampaignId) throw new Error("fixture campaign #2 was not created");

    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts
         (campaign_id, name, normalized_phone, original_phone, call_type, assigned_provider)
       VALUES ($1, 'Verify Fixture', '+919999000001', '9999000001', 'registration', $2)
       RETURNING id`,
      [campaignId, CARTESIA],
    );
    const contactId = contact.rows[0]?.id;
    if (!contactId) throw new Error("fixture contact was not created");

    console.log("");
    console.log(`Fixtures created inside a transaction that will be rolled back.`);
    console.log(`  contact locked to provider: ${CARTESIA}`);
    console.log("");

    // ── TEST 1 — provider immutability ──────────────────────────
    console.log("TEST 1 — assigned_provider is immutable");
    await expectRejection(
      client,
      "1a",
      `${CARTESIA} -> ${SARVAM} must be rejected`,
      "UPDATE contacts SET assigned_provider = $1 WHERE id = $2",
      [SARVAM, contactId],
    );
    await expectRejection(
      client,
      "1b",
      `${CARTESIA} -> ${SMALLEST} must be rejected`,
      "UPDATE contacts SET assigned_provider = $1 WHERE id = $2",
      [SMALLEST, contactId],
    );
    await expectSuccess(
      client,
      "1c",
      "control: updating a non-provider column still works",
      "UPDATE contacts SET status = 'QUEUED', claimed_by = 'verify' WHERE id = $1",
      [contactId],
    );
    await expectSuccess(
      client,
      "1d",
      "control: rewriting the SAME provider is not blocked",
      "UPDATE contacts SET assigned_provider = $1 WHERE id = $2",
      [CARTESIA, contactId],
    );

    // ── TEST 2 — cross-provider attempt guard ───────────────────
    console.log("");
    console.log("TEST 2 — call_attempts may not use a different provider");
    await expectRejection(
      client,
      "2a",
      `attempt on ${SARVAM} for a ${CARTESIA} contact must be rejected`,
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [campaignId, contactId, SARVAM],
    );
    await expectRejection(
      client,
      "2b",
      `attempt on ${SMALLEST} for a ${CARTESIA} contact must be rejected`,
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [campaignId, contactId, SMALLEST],
    );
    await expectRejection(
      client,
      "2c",
      "attempt claiming the wrong campaign must be rejected",
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [otherCampaignId, contactId, CARTESIA],
    );
    await expectSuccess(
      client,
      "2d",
      "control: attempt on the assigned provider is accepted",
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [campaignId, contactId, CARTESIA],
    );

    // ── TEST 3 — one number per campaign ────────────────────────
    console.log("");
    console.log("TEST 3 — duplicate phone number within a campaign");
    await expectRejection(
      client,
      "3a",
      "same campaign + same normalized_phone must be rejected",
      `INSERT INTO contacts (campaign_id, normalized_phone, original_phone, assigned_provider)
       VALUES ($1, '+919999000001', '9999000001', $2)`,
      [campaignId, SARVAM],
    );
    await expectRowCount(
      client,
      "3b",
      "ON CONFLICT DO NOTHING inserts nothing for a duplicate (import strategy)",
      0,
      `INSERT INTO contacts (campaign_id, normalized_phone, original_phone, assigned_provider)
       VALUES ($1, '+919999000001', '9999000001', $2)
       ON CONFLICT (campaign_id, normalized_phone) DO NOTHING`,
      [campaignId, SARVAM],
    );
    await expectSuccess(
      client,
      "3c",
      "control: the same number in a DIFFERENT campaign is allowed",
      `INSERT INTO contacts (campaign_id, normalized_phone, original_phone, assigned_provider)
       VALUES ($1, '+919999000001', '9999000001', $2)`,
      [otherCampaignId, SARVAM],
    );

    // ── TEST 4 — duplicate attempt number ───────────────────────
    console.log("");
    console.log("TEST 4 — duplicate attempt_number for the same contact");
    // Commit attempt #1 into the outer transaction so 4a has something to collide with.
    await client.query(
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [campaignId, contactId, CARTESIA],
    );
    await expectRejection(
      client,
      "4a",
      "second attempt_number = 1 for the same contact must be rejected",
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 1, $3, 'vobiz')`,
      [campaignId, contactId, CARTESIA],
    );
    await expectSuccess(
      client,
      "4b",
      "control: attempt_number = 2 (a real retry) is accepted",
      `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
       VALUES ($1, $2, 2, $3, 'vobiz')`,
      [campaignId, contactId, CARTESIA],
    );

    // ── TEST 5 — webhook deduplication ──────────────────────────
    console.log("");
    console.log("TEST 5 — webhook event deduplication");
    await client.query(
      `INSERT INTO webhook_events (source, event_type, dedupe_key, payload)
       VALUES ('vobiz', 'call_status', 'verify-dedupe-key', '{}'::jsonb)`,
      [],
    );
    await expectRejection(
      client,
      "5a",
      "same (source, event_type, dedupe_key) must be rejected",
      `INSERT INTO webhook_events (source, event_type, dedupe_key, payload)
       VALUES ('vobiz', 'call_status', 'verify-dedupe-key', '{}'::jsonb)`,
      [],
    );
    await expectRowCount(
      client,
      "5b",
      "ON CONFLICT DO NOTHING inserts nothing for a redelivery (handler strategy)",
      0,
      `INSERT INTO webhook_events (source, event_type, dedupe_key, payload)
       VALUES ('vobiz', 'call_status', 'verify-dedupe-key', '{}'::jsonb)
       ON CONFLICT (source, event_type, dedupe_key) DO NOTHING
       RETURNING id`,
      [],
    );

    // ── Extra: campaign idempotency ─────────────────────────────
    console.log("");
    console.log("TEST 6 — campaign idempotency key");
    await client.query(
      `INSERT INTO campaigns
         (name, campaign_type, script_id, script_version, script_hash,
          provider_allocation, telephony_provider, language, idempotency_key)
       VALUES ('__verify_idem__', 'registration', 'placeholder', 'v0', 'none',
               '{}'::jsonb, 'vobiz', 'en', 'verify-idem-key')`,
      [],
    );
    await expectRejection(
      client,
      "6a",
      "reusing an idempotency_key must be rejected (refresh/retry protection)",
      `INSERT INTO campaigns
         (name, campaign_type, script_id, script_version, script_hash,
          provider_allocation, telephony_provider, language, idempotency_key)
       VALUES ('__verify_idem_dup__', 'registration', 'placeholder', 'v0', 'none',
               '{}'::jsonb, 'vobiz', 'en', 'verify-idem-key')`,
      [],
    );

    // Nothing above is kept.
    await client.query("ROLLBACK");
    console.log("");
    console.log("All fixtures rolled back — the database is unchanged.");
  } finally {
    client.release();
    await closeDbPool();
  }
}

console.log("");
console.log("Campaign schema constraint verification");
console.log("=======================================");

try {
  await main();
} catch (error) {
  console.error("");
  console.error(`[verify] harness error: ${error instanceof Error ? error.message : String(error)}`);
  await closeDbPool().catch(() => undefined);
  process.exit(1);
}

const failed = results.filter((r) => !r.passed);
console.log("");
console.log("=======================================");
console.log(`${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
  console.error("");
  console.error("FAILED CHECKS:");
  for (const failure of failed) console.error(`  ${failure.id}  ${failure.description} — ${failure.detail}`);
  process.exit(1);
}

console.log("Every database-level guarantee held.");
process.exit(0);
