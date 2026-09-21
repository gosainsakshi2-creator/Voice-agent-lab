/**
 * call-analytics-tests.ts — `npm run test:call-analytics`
 *
 * The call-analytics read model, end to end, against the REAL SQL.
 *
 * Section A needs no database: filter parsing, bucket progression, the
 * CSV cell guard and the transcript flattener.
 *
 * Section B runs the production statements against TEMP TABLES that
 * carry the real tables' names and column shapes. A temp table shadows
 * the permanent one for the session that created it, and the session
 * additionally pins `search_path` to `pg_temp`, so every statement the
 * repo issues — the same text production runs — reads and writes only
 * rows this test seeded. The section proves the shadow is in place
 * (an empty `call_attempts`) before it seeds anything, and skips when
 * DATABASE_URL is unset.
 *
 * Section C is a static guard: nothing on the call path imports the
 * analytics module, so an analytics failure has no route to a live call.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET TO A VENDOR, OR READS OR
 * WRITES ANY PERMANENT CAMPAIGN TABLE.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadEnvFile } from "dotenv";

import {
  CSV_HEADERS,
  MAX_TRANSCRIPT_CHARS,
  countCallRecords,
  dailyCallAnalytics,
  exportCallAnalyticsCsv,
  exportFilename,
  flattenTranscript,
  listCallRecords,
  parseFilters,
  progressionBetween,
  progressionReport,
  recordToCsvRow,
  summarizeCallRecords,
  toCsv,
  transcriptForCall,
  type CallAnalyticsFilters,
  type SqlRunner,
} from "../analytics";

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

const UTC: CallAnalyticsFilters = { timeZone: "UTC" };

// ═════════════════════════════════════════════════════════════════
// A — pure functions
// ═════════════════════════════════════════════════════════════════

section("A. Filters, progression and CSV cells (no database)");

await test("A1 — parseFilters accepts every documented key and defaults the zone to UTC", () => {
  const filters = parseFilters(
    new URLSearchParams("from=2026-09-01&to=2026-09-21&response=YES&status=ANSWERED&bucket=GT30&outcome=declined&q=asha"),
  );
  assert.deepEqual(filters, {
    timeZone: "UTC",
    from: "2026-09-01",
    to: "2026-09-21",
    outcome: "declined",
    response: "YES",
    status: "ANSWERED",
    bucket: "GT30",
    search: "asha",
  });
});

await test("A2 — parseFilters refuses a misspelt response rather than exporting everything under a YES filename", () => {
  assert.throws(() => parseFilters(new URLSearchParams("response=yes")), /Unknown response/);
  assert.throws(() => parseFilters(new URLSearchParams("bucket=short")), /Unknown duration bucket/);
  assert.throws(() => parseFilters(new URLSearchParams("from=21-09-2026")), /YYYY-MM-DD/);
  assert.throws(() => parseFilters(new URLSearchParams("from=2026-09-22&to=2026-09-21")), /after/);
  assert.throws(() => parseFilters(new URLSearchParams("tz=Asia/Kolkata;DROP")), /time zone/);
  assert.throws(() => parseFilters(new URLSearchParams("campaignId=not-a-uuid")), /UUID/);
});

await test("A3 — progressionBetween: up, down, same, and null when either side has no bucket", () => {
  assert.deepEqual(progressionBetween("LE10", "GT30"), { from: "LE10", to: "GT30", direction: "UP" });
  assert.deepEqual(progressionBetween("GT30", "LE10"), { from: "GT30", to: "LE10", direction: "DOWN" });
  assert.deepEqual(progressionBetween("S11_20", "S11_20"), { from: "S11_20", to: "S11_20", direction: "SAME" });
  assert.equal(progressionBetween(null, "GT30"), null);
  assert.equal(progressionBetween("GT30", null), null);
});

await test("A4 — CSV cells defuse formulas and quote separators", () => {
  const csv = toCsv(["a", "b"], [["=cmd|' /C calc'!A0", 'plain, "quoted"']]);
  const [header, row] = csv.split("\r\n");
  assert.equal(header, "a,b");
  assert.equal(row, `"'=cmd|' /C calc'!A0","plain, ""quoted"""`);
});

await test("A5 — flattenTranscript labels roles, keeps order, and truncates with a visible marker", () => {
  const short = flattenTranscript({
    turns: [
      { role: "assistant", text: "Hello", at: "2026-09-20T10:00:01.000Z" },
      { role: "user", text: "Yes", at: null },
    ],
  });
  assert.equal(short, "[10:00:01] agent: Hello\ncaller: Yes");
  const long = flattenTranscript({ turns: [{ role: "user", text: "x".repeat(MAX_TRANSCRIPT_CHARS + 50), at: null }] });
  assert.ok(long.length < MAX_TRANSCRIPT_CHARS + 200);
  assert.match(long, /\[truncated for export/);
  assert.equal(flattenTranscript(null), "");
  assert.equal(flattenTranscript({ turns: "nope" }), "");
});

await test("A6 — exportFilename names the filter so a YES export cannot pass for the whole table", () => {
  assert.equal(exportFilename(UTC), "call-analytics.csv");
  assert.equal(
    exportFilename({ ...UTC, from: "2026-09-01", to: "2026-09-21", response: "YES" }),
    "call-analytics_2026-09-01_to_2026-09-21_response-yes.csv",
  );
  assert.equal(exportFilename({ ...UTC, status: "NO_ANSWER" }), "call-analytics_no_answer.csv");
});

// ═════════════════════════════════════════════════════════════════
// B — the production SQL against shadowing temp tables
// ═════════════════════════════════════════════════════════════════

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  console.log("\n[SKIP] section B — DATABASE_URL is not set");
} else {
  section("B. The canonical query over temp tables shaped like production");

  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    ssl:
      process.env["DATABASE_SSL"] === "disable"
        ? false
        : { rejectUnauthorized: process.env["DATABASE_SSL_REJECT_UNAUTHORIZED"] === "true" },
    connectionTimeoutMillis: 15_000,
    application_name: "call-analytics-tests",
  });
  await client.connect();

  // Column types copied from 001_init.sql, 003, 004, 005 and 006. Enum
  // columns become text: the repo only ever reads `status::text`.
  await client.query(`
    SET search_path TO pg_temp;
    CREATE TEMP TABLE campaigns (
      id uuid PRIMARY KEY, name text NOT NULL, campaign_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMP TABLE contacts (
      id uuid PRIMARY KEY, campaign_id uuid NOT NULL, name text,
      normalized_phone text NOT NULL, original_phone text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb, final_disposition text,
      CONSTRAINT contacts_one_number_per_campaign UNIQUE (campaign_id, normalized_phone)
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMP TABLE call_attempts (
      id uuid PRIMARY KEY, campaign_id uuid NOT NULL, contact_id uuid NOT NULL,
      attempt_number integer NOT NULL, provider text NOT NULL, telephony_provider text NOT NULL,
      llm_provider text, stt_provider text, session_id text, provider_call_id text,
      status text NOT NULL DEFAULT 'ASSIGNED', status_source text NOT NULL DEFAULT 'observed',
      dialed_at timestamptz, answered_at timestamptz, ended_at timestamptz,
      duration_seconds numeric(10,3), created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT call_attempts_contact_attempt_unique UNIQUE (contact_id, attempt_number)
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMP TABLE call_outcomes (
      call_attempt_id uuid PRIMARY KEY, campaign_id uuid NOT NULL,
      outcome_type text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
      succeeded boolean, primary_reason text, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      classifier text, classified_at timestamptz NOT NULL DEFAULT now(), transcript jsonb
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMP TABLE sheet_sync (
      campaign_id uuid NOT NULL, normalized_phone text NOT NULL, contact_id uuid, call_attempt_id uuid,
      state text NOT NULL DEFAULT 'PENDING', PRIMARY KEY (campaign_id, normalized_phone)
    ) ON COMMIT PRESERVE ROWS;
  `);

  // The shadow must be in place before anything else runs. If this
  // read returned production rows, every assertion below would be about
  // the wrong data — so the section refuses to continue instead.
  const shadowCheck = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM call_attempts");
  if (shadowCheck.rows[0]?.n !== "0") {
    throw new Error("temp tables did not shadow the permanent ones — refusing to run section B");
  }

  // One Client, so parallel repo queries are serialised here — the pool
  // does that for production; a bare client would interleave them.
  let chain: Promise<unknown> = Promise.resolve();
  const runner: SqlRunner = {
    query<T extends Record<string, unknown>>(text: string, params: readonly unknown[]) {
      const next = chain.then(() => client.query(text, [...params]));
      chain = next.catch(() => undefined);
      return next.then((result) => ({ rows: result.rows as T[] }));
    },
  };

  // ── Seed helpers ─────────────────────────────────────────────
  const campaignA = randomUUID();
  const campaignB = randomUUID();
  await client.query(`INSERT INTO campaigns (id, name, campaign_type) VALUES ($1, 'Campaign A', 'registration'), ($2, 'Campaign B', 'registration')`, [campaignA, campaignB]);

  const contactIds = new Map<string, string>();
  async function contact(campaignId: string, phone: string, name: string, metadata: Record<string, string> = {}, disposition: string | null = null): Promise<string> {
    const key = `${campaignId}:${phone}`;
    const existing = contactIds.get(key);
    if (existing) return existing;
    const id = randomUUID();
    await client.query(
      `INSERT INTO contacts (id, campaign_id, name, normalized_phone, original_phone, metadata, final_disposition)
       VALUES ($1, $2, $3, $4, $4, $5::jsonb, $6)`,
      [id, campaignId, name, phone, JSON.stringify(metadata), disposition],
    );
    contactIds.set(key, id);
    return id;
  }

  interface SeedCall {
    campaignId: string;
    phone: string;
    name: string;
    metadata?: Record<string, string>;
    disposition?: string | null;
    at: string;
    /** Undefined = never answered. */
    answeredSeconds?: number;
    status: string;
    outcome?: { type: string; reason: string; succeeded: boolean | null; transcript?: unknown };
  }

  const attemptCounters = new Map<string, number>();
  async function call(seed: SeedCall): Promise<string> {
    const contactId = await contact(seed.campaignId, seed.phone, seed.name, seed.metadata ?? {}, seed.disposition ?? null);
    const attemptNumber = (attemptCounters.get(contactId) ?? 0) + 1;
    attemptCounters.set(contactId, attemptNumber);
    const id = randomUUID();
    const dialed = new Date(seed.at);
    const answered = seed.answeredSeconds === undefined ? null : new Date(dialed.getTime() + 5_000);
    const ended =
      seed.status === "IN_PROGRESS" || seed.status === "DIALING"
        ? null
        : new Date((answered ?? dialed).getTime() + (seed.answeredSeconds ?? 20) * 1000);
    await client.query(
      `INSERT INTO call_attempts (id, campaign_id, contact_id, attempt_number, provider, telephony_provider, llm_provider, stt_provider,
                                  status, status_source, dialed_at, answered_at, ended_at, duration_seconds, created_at)
       VALUES ($1, $2, $3, $4, 'sarvam', 'vobiz', 'gpt-5.1', 'deepgram', $5, $6, $7, $8, $9, $10, $7)`,
      [
        id,
        seed.campaignId,
        contactId,
        attemptNumber,
        seed.status,
        seed.status === "NO_ANSWER" ? "inferred" : "observed",
        dialed,
        answered,
        ended,
        // Exactly the repo's rule: a duration exists only when answered.
        answered === null ? null : seed.answeredSeconds,
      ],
    );
    if (seed.outcome) {
      await client.query(
        `INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type, succeeded, primary_reason, detail, classifier, transcript)
         VALUES ($1, $2, $3, $4, $5, '{"confidence":"high","signals":[]}'::jsonb, 'rules.v2', $6::jsonb)`,
        [id, seed.campaignId, seed.outcome.type, seed.outcome.succeeded, seed.outcome.reason, seed.outcome.transcript ? JSON.stringify(seed.outcome.transcript) : null],
      );
    }
    return id;
  }

  const transcriptOf = (text: string) => ({
    turns: [
      { role: "assistant", text: "Hello, this is the agent.", at: "2026-09-20T10:00:01.000Z" },
      { role: "user", text, at: "2026-09-20T10:00:05.000Z" },
    ],
    turnCount: 2,
    truncated: false,
    capturedAt: "2026-09-20T10:01:00.000Z",
    source: "conversation-memory",
  });

  // ── The dataset ──────────────────────────────────────────────
  // Asha: 8s then a NO_ANSWER then 34s, all in campaign A → LE10 → GT30.
  const asha1 = await call({ campaignId: campaignA, phone: "+919000000001", name: "Asha", metadata: { Email: "asha@example.com" }, disposition: "FINAL_YES",
    at: "2026-09-18T04:30:00Z", answeredSeconds: 8, status: "COMPLETED",
    outcome: { type: "unclear", reason: "no_decisive_signal", succeeded: null, transcript: transcriptOf("Hmm, what is this about?") } });
  await call({ campaignId: campaignA, phone: "+919000000001", name: "Asha", at: "2026-09-19T04:30:00Z", status: "NO_ANSWER",
    outcome: { type: "not_connected", reason: "no_answer", succeeded: false } });
  const asha3 = await call({ campaignId: campaignA, phone: "+919000000001", name: "Asha", at: "2026-09-20T04:30:00Z", answeredSeconds: 34, status: "COMPLETED",
    outcome: { type: "registered_confirmed", reason: "confirmed_at_gate", succeeded: true, transcript: transcriptOf("Yes, please register me.") } });
  await client.query(`INSERT INTO sheet_sync (campaign_id, normalized_phone, call_attempt_id, state) VALUES ($1, '+919000000001', $2, 'SYNCED')`, [campaignA, asha3]);

  // Bala: 34s in campaign A, then 8s in campaign B (same phone, different contact row) → GT30 → LE10.
  await call({ campaignId: campaignA, phone: "+919000000002", name: "Bala", at: "2026-09-18T05:00:00Z", answeredSeconds: 34, status: "COMPLETED",
    outcome: { type: "interested_not_confirmed", reason: "affirmative_not_at_gate", succeeded: false } });
  await call({ campaignId: campaignB, phone: "+919000000002", name: "Bala", at: "2026-09-20T05:00:00Z", answeredSeconds: 8, status: "COMPLETED",
    outcome: { type: "declined", reason: "explicit_no", succeeded: false, transcript: transcriptOf("No, not interested.") } });

  // Boundary calls, one each, on 2026-09-20.
  const b10 = await call({ campaignId: campaignA, phone: "+919000000010", name: "Ten", at: "2026-09-20T06:00:00Z", answeredSeconds: 10, status: "COMPLETED",
    outcome: { type: "unclear", reason: "no_decisive_signal", succeeded: null } });
  const b104 = await call({ campaignId: campaignA, phone: "+919000000011", name: "TenPointFour", at: "2026-09-20T06:01:00Z", answeredSeconds: 10.4, status: "COMPLETED",
    outcome: { type: "unclear", reason: "no_decisive_signal", succeeded: null } });
  const b20 = await call({ campaignId: campaignA, phone: "+919000000012", name: "Twenty", at: "2026-09-20T06:02:00Z", answeredSeconds: 20, status: "COMPLETED",
    outcome: { type: "unclear", reason: "no_decisive_signal", succeeded: null } });
  const b25 = await call({ campaignId: campaignA, phone: "+919000000013", name: "TwentyFive", at: "2026-09-20T06:03:00Z", answeredSeconds: 25, status: "COMPLETED",
    outcome: { type: "no_engagement", reason: "no_customer_speech", succeeded: false } });
  const b301 = await call({ campaignId: campaignA, phone: "+919000000014", name: "ThirtyPointOne", at: "2026-09-20T06:04:00Z", answeredSeconds: 30.1, status: "COMPLETED",
    outcome: { type: "do_not_call", reason: "opt_out", succeeded: false } });
  // Answered but never classified (outcome write failed).
  const unclassified = await call({ campaignId: campaignA, phone: "+919000000015", name: "NoOutcome", at: "2026-09-20T06:05:00Z", answeredSeconds: 3, status: "COMPLETED" });
  // Never answered, short attempt: must not become ≤10s.
  const noAnswerShort = await call({ campaignId: campaignA, phone: "+919000000016", name: "Silent", at: "2026-09-20T06:06:00Z", status: "NO_ANSWER",
    outcome: { type: "not_connected", reason: "no_answer", succeeded: false } });
  // Busy, cancelled, and one still open.
  await call({ campaignId: campaignB, phone: "+919000000017", name: "Busy", at: "2026-09-20T06:07:00Z", status: "BUSY",
    outcome: { type: "not_connected", reason: "busy", succeeded: false } });
  await call({ campaignId: campaignB, phone: "+919000000018", name: "Cancelled", at: "2026-09-20T06:08:00Z", status: "CANCELLED" });
  await call({ campaignId: campaignB, phone: "+919000000019", name: "Live", at: "2026-09-20T06:09:00Z", status: "DIALING" });
  // Late evening UTC on the 20th = the 21st in Asia/Kolkata.
  const lateUtc = await call({ campaignId: campaignB, phone: "+919000000020", name: "LateNight", at: "2026-09-20T20:30:00Z", answeredSeconds: 12, status: "COMPLETED",
    outcome: { type: "callback_requested", reason: "callback_requested", succeeded: false } });

  // Asha ×3, Bala ×2, five boundary calls, one unclassified, one No
  // Answer, busy, cancelled, dialing, late-night = 16.
  const TOTAL_SEEDED = 16;

  const byId = async (filters: CallAnalyticsFilters = UTC) => {
    const rows = await listCallRecords(filters, 200, 0, runner);
    return new Map(rows.map((row) => [row.callId, row]));
  };

  await test("B0 — every seeded attempt is exactly one record, and the count agrees", async () => {
    const rows = await listCallRecords(UTC, 200, 0, runner);
    assert.equal(rows.length, TOTAL_SEEDED);
    assert.equal(new Set(rows.map((r) => r.callId)).size, TOTAL_SEEDED, "no attempt may appear twice (sheet_sync join must not fan out)");
    assert.equal(await countCallRecords(UTC, runner), TOTAL_SEEDED);
  });

  await test("B1 — a normal answered call is recorded as ANSWERED with its raw duration", async () => {
    const r = (await byId()).get(asha3);
    assert.ok(r);
    assert.equal(r.statusCategory, "ANSWERED");
    assert.equal(r.answered, true);
    assert.equal(r.durationSeconds, 34);
    assert.equal(r.callStatus, "COMPLETED");
    assert.equal(r.name, "Asha");
    assert.equal(r.email, "asha@example.com");
    assert.equal(r.phone, "+919000000001");
    assert.equal(r.campaignName, "Campaign A");
    assert.equal(r.contactDisposition, "FINAL_YES");
    assert.equal(r.registrationSheetState, "SYNCED");
  });

  await test("B2 — No Answer is its own status category, with no duration and no bucket", async () => {
    const r = (await byId()).get(noAnswerShort);
    assert.ok(r);
    assert.equal(r.statusCategory, "NO_ANSWER");
    assert.equal(r.answered, false);
    assert.equal(r.durationSeconds, null);
    assert.equal(r.durationBucket, null);
    assert.equal(r.customerResponse, "NOT_APPLICABLE");
    assert.equal(r.statusSource, "inferred");
  });

  await test("B3–B6 — duration buckets on the raw seconds: 8→≤10, 10→≤10, 10.4→11–20, 20→11–20, 25→21–30, 30.1→>30, 34→>30", async () => {
    const m = await byId();
    assert.equal(m.get(asha1)?.durationBucket, "LE10");
    assert.equal(m.get(b10)?.durationBucket, "LE10");
    assert.equal(m.get(b104)?.durationBucket, "S11_20");
    assert.equal(m.get(b20)?.durationBucket, "S11_20");
    assert.equal(m.get(b25)?.durationBucket, "S21_30");
    assert.equal(m.get(b301)?.durationBucket, "GT30");
    assert.equal(m.get(asha3)?.durationBucket, "GT30");
    assert.equal(m.get(unclassified)?.durationBucket, "LE10", "a bucket needs a duration, not an outcome row");
  });

  await test("B7 — YES is the confirmed_at_gate + succeeded conjunction and nothing softer", async () => {
    const m = await byId();
    assert.equal(m.get(asha3)?.customerResponse, "YES");
    assert.equal(m.get(asha3)?.callOutcome, "registered_confirmed");
    const bala1 = [...m.values()].find((r) => r.name === "Bala" && r.campaignId === campaignA);
    assert.equal(bala1?.customerResponse, "UNCLEAR", "an affirmative NOT at the gate is not a YES");
  });

  await test("B8 — NO is an explicit decline or an opt-out", async () => {
    const m = await byId();
    const bala2 = [...m.values()].find((r) => r.name === "Bala" && r.campaignId === campaignB);
    assert.equal(bala2?.customerResponse, "NO");
    assert.equal(m.get(b301)?.customerResponse, "NO");
  });

  await test("B9 — unknown stays UNCLEAR: no decisive signal, and answered-but-unclassified; silence is N/A", async () => {
    const m = await byId();
    assert.equal(m.get(b10)?.customerResponse, "UNCLEAR");
    assert.equal(m.get(unclassified)?.customerResponse, "UNCLEAR");
    assert.equal(m.get(unclassified)?.callOutcome, null);
    assert.equal(m.get(b25)?.customerResponse, "NOT_APPLICABLE", "no customer speech is not a response");
    assert.equal(m.get(lateUtc)?.customerResponse, "UNCLEAR", "a callback request is not a yes or a no");
  });

  await test("B10 — repeated calls to one phone stay separate records, numbered across campaigns", async () => {
    const m = await byId();
    const asha = [...m.values()].filter((r) => r.phone === "+919000000001").sort((a, b) => a.userCallIndex - b.userCallIndex);
    assert.equal(asha.length, 3);
    assert.deepEqual(asha.map((r) => r.userCallIndex), [1, 2, 3]);
    assert.ok(asha.every((r) => r.userCallCount === 3));
    assert.deepEqual(asha.map((r) => r.attemptNumber), [1, 2, 3]);
    const bala = [...m.values()].filter((r) => r.phone === "+919000000002").sort((a, b) => a.userCallIndex - b.userCallIndex);
    assert.equal(bala.length, 2, "same phone in two campaigns = two records, one person");
    assert.deepEqual(bala.map((r) => r.attemptNumber), [1, 1], "each campaign keeps its own attempt counter");
    assert.deepEqual(bala.map((r) => r.userCallIndex), [1, 2]);
    assert.notEqual(bala[0]?.contactId, bala[1]?.contactId);
  });

  await test("B11 — progression: ≤10s → >30s is UP, >30s → ≤10s is DOWN, and a No Answer in between is skipped", async () => {
    const m = await byId();
    const asha3r = m.get(asha3);
    assert.deepEqual(asha3r?.progression, { from: "LE10", to: "GT30", direction: "UP" });
    assert.equal(asha3r?.previousDurationSeconds, 8);
    assert.equal(asha3r?.previousDurationBucket, "LE10");
    assert.equal(asha3r?.previousStatusCategory, "NO_ANSWER", "the immediately previous ATTEMPT was the no-answer");
    assert.equal(m.get(asha1)?.progression, null, "the first answered call has nothing to progress from");
    assert.equal(m.get(asha1)?.previousDurationBucket, null);
    const bala2 = [...m.values()].find((r) => r.name === "Bala" && r.campaignId === campaignB);
    assert.deepEqual(bala2?.progression, { from: "GT30", to: "LE10", direction: "DOWN" });

    const report = await progressionReport(UTC, runner);
    assert.equal(report.usersWithRepeatAnswers, 2);
    assert.equal(report.movedUp, 1);
    assert.equal(report.movedDown, 1);
    assert.equal(report.stayed, 0);
    assert.deepEqual(
      report.transitions,
      [
        { from: "LE10", to: "GT30", users: 1 },
        { from: "GT30", to: "LE10", users: 1 },
      ],
    );
    assert.equal(report.firstVsLatest.latestLonger, 1);
    assert.equal(report.firstVsLatest.latestShorter, 1);
    assert.equal(report.registrations.repeatUsersWithFinalYes, 1, "Asha's FINAL_YES is read from the contact, not from her 34s");
    assert.equal(report.usersAnsweredOnce, 7, "the five boundary calls, the unclassified one and the late-night one");
  });

  await test("B12 — a transcript is read by its own call id, and a call without one says so", async () => {
    const t3 = await transcriptForCall(asha3, runner);
    assert.equal(t3?.available, true);
    assert.equal(t3?.turns[1]?.text, "Yes, please register me.");
    const t1 = await transcriptForCall(asha1, runner);
    assert.equal(t1?.turns[1]?.text, "Hmm, what is this about?");
    const none = await transcriptForCall(noAnswerShort, runner);
    assert.deepEqual(none, { callId: noAnswerShort, available: false, turns: [], turnCount: 0, truncated: false, capturedAt: null });
    assert.equal(await transcriptForCall("not-a-uuid", runner), null);
    assert.equal(await transcriptForCall(randomUUID(), runner), null);
    const m = await byId();
    assert.equal(m.get(asha3)?.transcriptAvailable, true);
    assert.equal(m.get(asha3)?.transcriptTurns, 2);
    assert.equal(m.get(noAnswerShort)?.transcriptAvailable, false);
  });

  await test("B13 — a duplicate completion cannot create a second record: the outcome PK and the attempt uniqueness refuse it", async () => {
    const before = await countCallRecords(UTC, runner);
    // The same statement `outcome.repo.ts` runs — an upsert keyed on the attempt id.
    await client.query(
      `INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type, succeeded, primary_reason, detail, classifier, transcript)
       VALUES ($1, $2, 'registered_confirmed', true, 'confirmed_at_gate', '{}'::jsonb, 'rules.v2', NULL)
       ON CONFLICT (call_attempt_id) DO UPDATE SET classified_at = now(), transcript = COALESCE(EXCLUDED.transcript, call_outcomes.transcript)`,
      [asha3, campaignA],
    );
    await assert.rejects(
      () => client.query(`INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type) VALUES ($1, $2, 'declined')`, [asha3, campaignA]),
      (error: unknown) => (error as { code?: string }).code === "23505",
      "a plain second insert must hit the primary key",
    );
    const ashaContact = contactIds.get(`${campaignA}:+919000000001`);
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO call_attempts (id, campaign_id, contact_id, attempt_number, provider, telephony_provider, status)
           VALUES ($1, $2, $3, 3, 'sarvam', 'vobiz', 'COMPLETED')`,
          [randomUUID(), campaignA, ashaContact],
        ),
      (error: unknown) => (error as { code?: string }).code === "23505",
      "attempt #3 for this contact already exists",
    );
    assert.equal(await countCallRecords(UTC, runner), before);
    const t = await transcriptForCall(asha3, runner);
    assert.equal(t?.turns[1]?.text, "Yes, please register me.", "the re-classification upsert must not erase the transcript");
  });

  await test("B14 — the CSV export respects each filter (YES, NO, No Answer, >30s, a day)", async () => {
    const parse = (csv: string) => csv.trim().split("\r\n").slice(1);
    const col = (name: string) => CSV_HEADERS.indexOf(name as (typeof CSV_HEADERS)[number]);
    const field = (line: string, name: string) => line.split(",")[col(name)];

    const yes = await exportCallAnalyticsCsv({ ...UTC, response: "YES" }, runner);
    assert.equal(yes.rows, 1);
    assert.ok(parse(yes.csv).every((line) => field(line, "customer_response") === "YES"));

    const no = await exportCallAnalyticsCsv({ ...UTC, response: "NO" }, runner);
    assert.equal(no.rows, 2);
    assert.ok(parse(no.csv).every((line) => field(line, "customer_response") === "NO"));

    const noAnswer = await exportCallAnalyticsCsv({ ...UTC, status: "NO_ANSWER" }, runner);
    assert.equal(noAnswer.rows, 2);
    assert.ok(parse(noAnswer.csv).every((line) => field(line, "call_status") === "NO_ANSWER" && field(line, "duration_bucket") === ""));

    const gt30 = await exportCallAnalyticsCsv({ ...UTC, bucket: "GT30" }, runner);
    assert.equal(gt30.rows, 3);
    assert.ok(parse(gt30.csv).every((line) => field(line, "duration_bucket") === ">30s"));

    const day = await exportCallAnalyticsCsv({ ...UTC, from: "2026-09-18", to: "2026-09-18" }, runner);
    assert.equal(day.rows, 2, "Asha #1 and Bala #1 were dialled on the 18th UTC");
    assert.ok(parse(day.csv).every((line) => field(line, "call_started_at")?.startsWith("2026-09-18")));

    const campaignOnly = await exportCallAnalyticsCsv({ ...UTC, campaignId: campaignB }, runner);
    assert.equal(campaignOnly.rows, 5, "Bala #2, busy, cancelled, dialing, late-night");
  });

  await test("B15 — an empty filter exports every record, with the transcript in the last column", async () => {
    const all = await exportCallAnalyticsCsv(UTC, runner);
    assert.equal(all.rows, TOTAL_SEEDED);
    assert.equal(all.capped, false);
    const lines = all.csv.trim().split("\r\n");
    assert.equal(lines[0], CSV_HEADERS.join(","));
    assert.equal(lines.length, TOTAL_SEEDED + 1);
    assert.match(all.csv, /Yes, please register me\./);
    assert.match(all.csv, /asha@example\.com/);
    // The row shape is the header shape, always.
    const m = await byId();
    const row = recordToCsvRow(m.get(asha3)!, transcriptOf("x"));
    assert.equal(row.length, CSV_HEADERS.length);
  });

  await test("B16 — No Answer never becomes a duration bucket, in the summary or under a bucket filter", async () => {
    const summary = await summarizeCallRecords(UTC, runner);
    assert.equal(summary.total, TOTAL_SEEDED);
    assert.equal(summary.noAnswer, 2);
    assert.equal(summary.answered, 11);
    assert.equal(summary.notConnected, 2, "busy + cancelled");
    assert.equal(summary.open, 1, "the DIALING orphan");
    const bucketSum = Object.values(summary.byBucket).reduce((a, b) => a + b, 0);
    assert.equal(bucketSum, summary.answered, "every answered call is in exactly one bucket, nothing else is");
    assert.deepEqual(summary.byBucket, { LE10: 4, S11_20: 3, S21_30: 1, GT30: 3 });
    assert.deepEqual(summary.byResponse, { YES: 1, NO: 2, UNCLEAR: 7, NOT_APPLICABLE: 6 });
    assert.equal(summary.byOutcome["unclassified"], 3, "no-outcome answered call + cancelled + dialing");
    const le10 = await listCallRecords({ ...UTC, bucket: "LE10" }, 200, 0, runner);
    assert.ok(le10.every((r) => r.statusCategory === "ANSWERED"), "a bucket filter can only ever return answered calls");
    assert.ok(le10.every((r) => r.callId !== noAnswerShort));
  });

  await test("B17 — daily rows: named denominators, and the day follows the requested zone", async () => {
    const utcDays = await dailyCallAnalytics(UTC, runner);
    const d20 = utcDays.find((d) => d.day === "2026-09-20");
    assert.ok(d20);
    assert.equal(d20.total, 13);
    assert.equal(d20.answered, 9);
    assert.equal(d20.noAnswer, 1);
    assert.equal(d20.noAnswerRate, Math.round((1 / 13) * 1000) / 10, "no-answer rate is over ALL attempts that day");
    assert.equal(d20.bucketPct.GT30, Math.round((2 / 9) * 1000) / 10, "bucket % is over ANSWERED calls that day");
    assert.equal(d20.yes, 1);
    assert.equal(d20.yesPct, Math.round((1 / 9) * 1000) / 10);
    assert.equal(d20.no, 2);
    assert.equal(utcDays.find((d) => d.day === "2026-09-21"), undefined, "nothing lands on the 21st in UTC");

    const istDays = await dailyCallAnalytics({ timeZone: "Asia/Kolkata" }, runner);
    assert.equal(istDays.find((d) => d.day === "2026-09-21")?.total, 1, "20:30 UTC on the 20th is 02:00 IST on the 21st");
    assert.equal(istDays.find((d) => d.day === "2026-09-20")?.total, 12);

    const istFilter = await countCallRecords({ timeZone: "Asia/Kolkata", from: "2026-09-21", to: "2026-09-21" }, runner);
    assert.equal(istFilter, 1, "the date filter and the daily view use the same day boundary");
  });

  await test("B18 — search matches name, phone and the email carried in contact metadata", async () => {
    assert.equal(await countCallRecords({ ...UTC, search: "asha@example" }, runner), 3);
    assert.equal(await countCallRecords({ ...UTC, search: "9000000002" }, runner), 2);
    assert.equal(await countCallRecords({ ...UTC, search: "bala" }, runner), 2);
    assert.equal(await countCallRecords({ ...UTC, search: "%" }, runner), 0, "wildcards are escaped, not interpreted");
  });

  await test("B19 — a database fault surfaces as a rejected promise, never as invented rows", async () => {
    const broken: SqlRunner = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    await assert.rejects(() => listCallRecords(UTC, 25, 0, broken), /connection refused/);
    await assert.rejects(() => summarizeCallRecords(UTC, broken), /connection refused/);
    await assert.rejects(() => exportCallAnalyticsCsv(UTC, broken), /connection refused/);
  });

  await client.end();
}

// ═════════════════════════════════════════════════════════════════
// C — the call path does not know analytics exists
// ═════════════════════════════════════════════════════════════════

section("C. Isolation from the live call");

await test("C1 — no call-path module imports the analytics module", async () => {
  const root = path.resolve("src");
  const callPath = [
    "campaign/dispatch/call-runner.ts",
    "campaign/dispatch/dispatcher.ts",
    "campaign/dispatch/session-observer.ts",
    "campaign/dispatch/run-launcher.ts",
    "campaign/db/repositories/call-attempt.repo.ts",
    "campaign/db/repositories/outcome.repo.ts",
    "core/session/voice-session-manager.ts",
    "core/session/conversation-pipeline.ts",
    "server/runtime.ts",
    "server/vobiz-media-bridge.ts",
    "server/plivo-media-bridge.ts",
  ];
  for (const relative of callPath) {
    let source: string;
    try {
      source = await readFile(path.join(root, relative), "utf8");
    } catch {
      continue; // a module that does not exist cannot import anything
    }
    assert.doesNotMatch(source, /campaign\/analytics|\.\.\/analytics|call-analytics/, `${relative} must not import analytics`);
  }
});

await test("C2 — the analytics module itself never writes", async () => {
  const dir = path.resolve("src/campaign/analytics");
  for (const file of ["call-analytics.repo.ts", "call-analytics-csv.ts", "call-analytics-types.ts"]) {
    const source = await readFile(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b\s+(INTO|TABLE|FROM|call_|contacts|campaigns|sheet_)/, `${file} must contain no write statement`);
  }
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
