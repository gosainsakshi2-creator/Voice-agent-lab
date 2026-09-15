/**
 * registration-timing-tests.ts — `npm run test:registration-timing`
 *
 * ROADMAP §5 B7 — DURABLE REGISTRATION TIMING.
 *
 * B7 asks us to be able to verify, from logs, the chain
 *
 *     user confirmation -> registration trigger -> Sheets HTTP request
 *     -> call end
 *
 * for a registration that has already happened. Everything below is
 * about two properties of that record, and they pull in opposite
 * directions:
 *
 *   1. it has to be COMPLETE — the instants, and enough correlation to
 *      join the event to the campaign, the call, the person and the
 *      sheet row;
 *   2. it has to be UNABLE TO MATTER — a broken logger must not change
 *      a registration, a sheet row, a return value or a call.
 *
 * Sections A and B are PURE: no database, no network. Sections C, D and
 * E run the REAL `syncFinalYesToSheet` against the REAL PostgreSQL
 * claim statement with only Google and the event sink substituted, so
 * "the event says what the write did" is a statement about production
 * code rather than about a mock.
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
const { findScript, hashScript } = await import("../script/script-registry");
const { syncFinalYesToSheet } = await import("../integrations/final-yes-sheet");
const {
  confirmationInstantFrom,
  recordRegistrationSync,
  REGISTRATION_SYNCED,
  REGISTRATION_SYNC_FAILED,
  REGISTRATION_SYNC_SKIPPED,
  REGISTRATION_SYNC_CODES,
} = await import("../integrations/registration-timing");
const { query, closeDbPool } = await import("../db/client");

import type { SheetSyncConfig } from "../config/sheet.config";
import type { AppendResult } from "../integrations/google-sheets.client";
import type { StoredTranscript, TranscriptTurn } from "../outcome/transcript";

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

/** The event sink is fire-and-forget, so give the microtask queue a turn before reading it. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─────────────────────────────────────────────────────────────────
// Fixtures. The transcript carries REAL timestamps, because the whole
// point of `confirmedAt` is that it is the instant the pipeline stamped
// on the turn rather than anything measured later.

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PITCH = "It is a free live workshop. Have you tried putting something online before?";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRM = "Perfect! I'll get your registration confirmed and send you the joining details.";

const CALL_STARTED_AT = Date.parse("2026-09-15T09:00:00.000Z");
const at = (secondsIn: number) => new Date(CALL_STARTED_AT + secondsIn * 1000).toISOString();

const agent = (text: string, secondsIn: number): TranscriptTurn => ({
  role: "assistant",
  text,
  at: at(secondsIn),
});
const caller = (text: string, secondsIn: number): TranscriptTurn => ({
  role: "user",
  text,
  at: at(secondsIn),
});

/** Wraps turns exactly as `toStoredTranscript` does, so signal indices line up as they do in production. */
function stored(turns: readonly TranscriptTurn[]): StoredTranscript {
  return {
    turns,
    turnCount: turns.length,
    truncated: false,
    capturedAt: at(60),
    source: "conversation-memory",
  };
}

/**
 * The classifier's verdict and the disposition the call-runner would
 * store, over the SAME array the transcript wrapper carries — which is
 * exactly what `finalize` passes in production.
 */
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
  return { classification, disposition, transcript: stored(turns) };
}

/** A person who registered 18 seconds into the call. */
const REGISTERED_TURNS: readonly TranscriptTurn[] = [
  agent(GREETING, 0),
  caller("Hello.", 4),
  agent(PITCH, 6),
  caller("No, not really.", 14),
  agent(GATE, 15),
  caller("Yes, please reserve it.", 18),
  agent(CONFIRM, 20),
];
const REGISTERED = settle(REGISTERED_TURNS);

const REFUSED = settle([agent(GREETING, 0), agent(GATE, 6), caller("No, I'm not interested.", 9)]);

interface RecordedEvent {
  campaignId: string;
  code: string;
  message: string;
  data: Record<string, unknown>;
  level: string;
}

function makeRecorder() {
  const events: RecordedEvent[] = [];
  return {
    events,
    log: async (
      campaignId: string,
      code: string,
      message: string,
      data?: Record<string, unknown>,
      level?: "info" | "warn" | "error",
    ): Promise<void> => {
      events.push({ campaignId, code, message, data: data ?? {}, level: level ?? "info" });
    },
  };
}

const timingOf = (event: RecordedEvent) => event.data["timing"] as Record<string, unknown>;

// ═════════════════════════════════════════════════════════════════
section("A. THE CONFIRMATION INSTANT IS READ FROM THE TURN, NOT INVENTED");

await test("A1. the timestamp is the one the pipeline stamped on the turn the person said yes", () => {
  const instant = confirmationInstantFrom(REGISTERED.classification, REGISTERED.transcript);
  assert.ok(instant, "a confirmed registration must yield a confirmation instant");
  assert.equal(instant.at, at(18), "the caller's yes was at +18s and nothing else is");
  assert.equal(instant.turnIndex, 5, "turn 5 is the caller's yes");
  assert.equal(
    REGISTERED.transcript.turns[instant.turnIndex]?.role,
    "user",
    "the instant must come from something the CALLER said",
  );
});

await test("A2. the phrase travels with it, so an operator can check the turn", () => {
  const instant = confirmationInstantFrom(REGISTERED.classification, REGISTERED.transcript);
  assert.ok(instant);
  assert.ok(instant.phrase.length > 0, "the matched phrase must be reported");
  assert.ok(
    REGISTERED.transcript.turns[instant.turnIndex]!.text.toLowerCase().includes(instant.phrase),
    `the reported phrase "${instant.phrase}" must actually occur in the turn it names`,
  );
});

await test("A3. it takes no verdict of its own — a refusal yields nothing", () => {
  assert.equal(confirmationInstantFrom(REFUSED.classification, REFUSED.transcript), undefined);
});

await test("A4. a missing transcript, a missing classification and a timestampless turn all yield nothing", () => {
  assert.equal(confirmationInstantFrom(REGISTERED.classification, undefined), undefined);
  assert.equal(confirmationInstantFrom(undefined, REGISTERED.transcript), undefined);

  const noTimestamps = REGISTERED_TURNS.map((turn) => ({ ...turn, at: null }));
  assert.equal(
    confirmationInstantFrom(REGISTERED.classification, stored(noTimestamps)),
    undefined,
    "a turn the pipeline never stamped must not be given an invented time",
  );
});

await test("A5. a truncated transcript cannot produce an out-of-range read", () => {
  // The signal indexes a turn the wrapper no longer carries.
  const instant = confirmationInstantFrom(
    REGISTERED.classification,
    stored(REGISTERED_TURNS.slice(0, 2)),
  );
  assert.equal(instant, undefined);
});

// ═════════════════════════════════════════════════════════════════
section("B. WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT");

await test("B1. a call that is not a registration records NOTHING", async () => {
  const recorder = makeRecorder();
  const result = await syncFinalYesToSheet(
    {
      campaignId: randomUUID(),
      contactId: randomUUID(),
      attemptId: randomUUID(),
      classification: REFUSED.classification,
      disposition: REFUSED.disposition,
      transcript: REFUSED.transcript,
    },
    { logEvent: recorder.log },
  );
  await flush();

  assert.equal(result.synced, false);
  assert.equal(result.synced === false && result.reason, "not-final-yes");
  assert.equal(recorder.events.length, 0, "every non-registration call would otherwise flood the log");
});

await test("B2. a registration an unconfigured deployment cannot write is recorded as a skip", async () => {
  const recorder = makeRecorder();
  const campaignId = randomUUID();
  const contactId = randomUUID();
  const attemptId = randomUUID();

  const result = await syncFinalYesToSheet(
    {
      campaignId,
      contactId,
      attemptId,
      classification: REGISTERED.classification,
      disposition: REGISTERED.disposition,
      transcript: REGISTERED.transcript,
    },
    {
      config: {
        spreadsheetId: "",
        tabName: "Sheet1",
        clientEmail: "",
        privateKey: "",
        isConfigured: false,
      },
      logEvent: recorder.log,
    },
  );
  await flush();

  assert.equal(result.synced === false && result.reason, "not-configured");
  assert.equal(recorder.events.length, 1, "a lost registration must leave exactly one durable line");

  const event = recorder.events[0]!;
  assert.equal(event.code, REGISTRATION_SYNC_SKIPPED);
  assert.equal(event.level, "warn");
  assert.equal(event.campaignId, campaignId, "the campaign is the event's own column");
  assert.equal(event.data["contactId"], contactId);
  assert.equal(event.data["attemptId"], attemptId);
  assert.match(
    String(event.data["reason"]),
    /CAMPAIGN_SHEET_SPREADSHEET_ID/,
    "the operator must be told WHICH setting is missing",
  );
});

await test("B3. every code this module writes is one of the three it declares", () => {
  assert.deepEqual(
    [...REGISTRATION_SYNC_CODES].sort(),
    [REGISTRATION_SYNCED, REGISTRATION_SYNC_FAILED, REGISTRATION_SYNC_SKIPPED].sort(),
  );
});

await test("B4. no name, no email address and no phone number is copied into the event", async () => {
  const recorder = makeRecorder();
  await syncFinalYesToSheet(
    {
      campaignId: randomUUID(),
      contactId: randomUUID(),
      attemptId: randomUUID(),
      classification: REGISTERED.classification,
      disposition: REGISTERED.disposition,
      transcript: REGISTERED.transcript,
    },
    {
      config: { spreadsheetId: "", tabName: "Sheet1", clientEmail: "", privateKey: "", isConfigured: false },
      logEvent: recorder.log,
    },
  );
  await flush();

  const body = JSON.stringify(recorder.events[0]);
  assert.ok(!body.includes("@"), "an email address must never reach the operations log");
  assert.ok(!/\+\d{10,}/.test(body), "a phone number must never reach the operations log");
});

await test("B5. recordRegistrationSync returns void — no caller can await it", () => {
  const recorder = makeRecorder();
  const returned = recordRegistrationSync(
    {
      campaignId: randomUUID(),
      contactId: randomUUID(),
      attemptId: randomUUID(),
      outcome: "synced",
      triggeredAtMs: Date.now(),
      settledAtMs: Date.now(),
    },
    recorder.log,
  );
  assert.equal(returned, undefined, "returning a promise would let a call be made to wait on the log");
});

// ═════════════════════════════════════════════════════════════════
section("C. THE FULL CHAIN, THROUGH THE REAL SYNC AND THE REAL CLAIM STATEMENT");

const STUB_CONFIG: SheetSyncConfig = {
  spreadsheetId: "test-spreadsheet",
  tabName: "Sheet1",
  clientEmail: "test@example.iam.gserviceaccount.com",
  privateKey: "not-a-real-key-and-never-used",
  isConfigured: true,
};

/** Stands in for Google, and takes a measurable amount of time doing it. */
function makeAppender(delayMs = 0) {
  const rows: string[][] = [];
  return {
    rows,
    append: async (_config: SheetSyncConfig, values: readonly string[]): Promise<AppendResult> => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      rows.push([...values]);
      return { updatedRange: `Sheet1!A${rows.length}:C${rows.length}` };
    },
  };
}

const hasDatabase = (process.env.DATABASE_URL ?? "").length > 0;
if (!hasDatabase) {
  console.log("  [SKIP] sections C, D and E — DATABASE_URL is not set");
} else {
  const campaignId = randomUUID();
  const registrationScript = findScript("registration", "v1");
  assert.ok(registrationScript, "the approved registration script must be registered");

  try {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__registration_timing__', 'registration', 'READY', 'registration', 'v1', $2,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
      [campaignId, hashScript(registrationScript), `timing-${campaignId}`],
    );

    /** A fresh person per test, so no test depends on another's claim. */
    let nextPhone = 200;
    async function makeContact(withEmail: boolean): Promise<{ contactId: string; attemptId: string }> {
      nextPhone += 1;
      const phone = `+9198111${String(nextPhone).padStart(5, "0")}`;
      const metadata = withEmail ? '{"Email":"priya@example.com","City":"Pune"}' : '{"City":"Pune"}';
      const contact = await query<{ id: string }>(
        `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                               csv_row_number, status, attempt_count, metadata)
         VALUES ($1, 'Priya Sharma', $2, $2, 'cartesia', $3, 'COMPLETED', 1, $4::jsonb)
         RETURNING id`,
        [campaignId, phone, nextPhone, metadata],
      );
      const contactId = contact.rows[0]!.id;
      const attempt = await query<{ id: string }>(
        `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                    status, dialed_at, answered_at, ended_at, failure_class)
         VALUES ($1, $2, 1, 'cartesia', 'vobiz', 'COMPLETED', now(), now(), now(), 'COMPLETED')
         RETURNING id`,
        [campaignId, contactId],
      );
      return { contactId, attemptId: attempt.rows[0]!.id };
    }

    await test("C1. a successful registration records the whole B7 chain", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const recorder = makeRecorder();
      const google = makeAppender(25);

      const before = Date.now();
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      const after = Date.now();
      await flush();

      assert.equal(result.synced, true);
      assert.equal(recorder.events.length, 1);

      const event = recorder.events[0]!;
      assert.equal(event.code, REGISTRATION_SYNCED);
      assert.equal(event.level, "info");

      const timing = timingOf(event);
      assert.equal(timing["confirmedAt"], at(18), "link 1: the instant the person said yes");
      assert.ok(timing["triggeredAt"], "link 2: the registration trigger");
      assert.ok(timing["requestStartedAt"], "link 3: the Sheets request going out");
      assert.ok(timing["syncedAt"], "link 4: the Sheets request settling");
      assert.equal(timing["failedAt"], undefined, "a success must not carry a failure instant");

      // Link 5, the call end, is not copied here — it is written by
      // finalizeAttempt as call_attempts.ended_at and reached through
      // attemptId. Assert the pointer exists rather than inventing a
      // second copy of the instant.
      assert.equal(event.data["callEndedAtSource"], "call_attempts.ended_at");
      const ended = await query<{ ended_at: Date | null }>(
        "SELECT ended_at FROM call_attempts WHERE id = $1",
        [attemptId],
      );
      assert.ok(ended.rows[0]?.ended_at, "the attempt the event names must carry the call's end instant");

      const triggeredAtMs = Date.parse(String(timing["triggeredAt"]));
      assert.ok(
        triggeredAtMs >= before && triggeredAtMs <= after,
        "the trigger instant must be taken during this call, not derived afterwards",
      );
    });

    await test("C2. the instants are ordered, and the durations agree with them", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const recorder = makeRecorder();
      const google = makeAppender(30);

      await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      await flush();

      const timing = timingOf(recorder.events[0]!);
      const confirmed = Date.parse(String(timing["confirmedAt"]));
      const triggered = Date.parse(String(timing["triggeredAt"]));
      const requested = Date.parse(String(timing["requestStartedAt"]));
      const synced = Date.parse(String(timing["syncedAt"]));

      assert.ok(confirmed < triggered, "the person confirms before the registration is triggered");
      assert.ok(triggered <= requested, "the trigger precedes the HTTP request");
      assert.ok(requested <= synced, "the request precedes its own settlement");

      assert.equal(timing["confirmationToTriggerMs"], triggered - confirmed);
      assert.equal(timing["triggerToRequestMs"], requested - triggered);
      assert.equal(timing["requestMs"], synced - requested);
      assert.equal(timing["confirmationToSettledMs"], synced - confirmed);
      assert.ok(
        Number(timing["requestMs"]) >= 25,
        "requestMs must measure the vendor round trip — the stub slept 30ms",
      );
    });

    await test("C3. correlation: campaign, attempt, contact, confirmation and sheet row are all present", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const recorder = makeRecorder();
      const google = makeAppender();

      await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      await flush();

      const event = recorder.events[0]!;
      assert.equal(event.campaignId, campaignId, "campaign");
      assert.equal(event.data["attemptId"], attemptId, "call");
      assert.equal(event.data["contactId"], contactId, "person");
      assert.equal(event.data["spreadsheetId"], STUB_CONFIG.spreadsheetId, "which sheet");
      assert.ok(String(event.data["updatedRange"]).startsWith("Sheet1!"), "which row");
      assert.equal(event.data["hasEmail"], true, "whether the row went out with an email");

      const confirmation = event.data["confirmation"] as Record<string, unknown>;
      assert.equal(confirmation["at"], at(18), "confirmation instant");
      assert.equal(confirmation["turnIndex"], 5, "the turn it was read from, so it can be checked");
    });

    await test("C4. a registration with no imported email is recorded as such, and still written", async () => {
      const { contactId, attemptId } = await makeContact(false);
      const recorder = makeRecorder();
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
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      await flush();

      assert.equal(result.synced, true, "a missing email is not a failure");
      assert.equal(recorder.events[0]!.data["hasEmail"], false);
      assert.deepEqual(google.rows[0]?.[1], "", "the Email cell is empty, and the row still goes");
    });

    await test("C5. a Google failure records a FAILED event carrying the vendor's own message", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const recorder = makeRecorder();

      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        {
          config: STUB_CONFIG,
          append: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("The operation was aborted due to timeout");
          },
          logEvent: recorder.log,
        },
      );
      await flush();

      assert.equal(result.synced, false);
      assert.equal(result.synced === false && result.reason, "write-failed");

      const event = recorder.events[0]!;
      assert.equal(event.code, REGISTRATION_SYNC_FAILED);
      assert.equal(event.level, "error");
      assert.match(String(event.data["reason"]), /aborted due to timeout/);

      const timing = timingOf(event);
      assert.ok(timing["failedAt"], "a failure must carry its own settle instant");
      assert.equal(timing["syncedAt"], undefined, "and must not claim a success one");
      assert.ok(
        Number(timing["requestMs"]) >= 20,
        "the time the vendor took before failing is the whole point of recording this",
      );
      assert.equal(timing["confirmedAt"], at(18), "the chain is still complete up to the failure");
    });

    await test("C6. a second presentation of the same registration is recorded as already-synced", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const first = makeRecorder();
      const second = makeRecorder();

      await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: makeAppender().append, logEvent: first.log },
      );
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
        { config: STUB_CONFIG, append: google.append, logEvent: second.log },
      );
      await flush();

      assert.equal(result.synced === false && result.reason, "already-synced");
      assert.equal(google.rows.length, 0, "no second row");
      assert.equal(second.events[0]!.code, REGISTRATION_SYNC_SKIPPED);
      assert.equal(second.events[0]!.data["reason"], "already-synced");
    });

    await test("C7. a registration whose contact has vanished is recorded as a skip", async () => {
      const { contactId, attemptId } = await makeContact(true);
      await query("DELETE FROM contacts WHERE id = $1", [contactId]);
      const recorder = makeRecorder();

      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: makeAppender().append, logEvent: recorder.log },
      );
      await flush();

      assert.equal(result.synced === false && result.reason, "contact-missing");
      assert.equal(recorder.events[0]!.code, REGISTRATION_SYNC_SKIPPED);
      assert.equal(recorder.events[0]!.data["reason"], "contact-missing");
    });

    await test("C8. a registration with no transcript still records the rest of the chain", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const recorder = makeRecorder();
      const google = makeAppender();

      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          // No transcript — an older caller, or a call whose transcript
          // could not be captured.
        },
        { config: STUB_CONFIG, append: google.append, logEvent: recorder.log },
      );
      await flush();

      assert.equal(result.synced, true, "the row is written exactly as before");
      const timing = timingOf(recorder.events[0]!);
      assert.equal(timing["confirmedAt"], undefined, "a link we do not have is absent, never guessed");
      assert.equal(timing["confirmationToTriggerMs"], undefined, "and no duration is derived from it");
      assert.ok(timing["triggeredAt"] && timing["requestStartedAt"] && timing["syncedAt"]);
    });

    // ═════════════════════════════════════════════════════════════
    section("D. OBSERVABILITY CANNOT AFFECT A REGISTRATION OR A CALL");

    await test("D1. a logger that REJECTS changes nothing about the registration", async () => {
      const { contactId, attemptId } = await makeContact(true);
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
        {
          config: STUB_CONFIG,
          append: google.append,
          logEvent: async () => {
            throw new Error("campaign_events is unreachable");
          },
        },
      );
      await flush();

      assert.equal(result.synced, true, "the registration is unaffected");
      assert.equal(google.rows.length, 1, "the row was still written");
      const state = await query<{ state: string }>(
        "SELECT state FROM sheet_sync WHERE campaign_id = $1 AND contact_id = $2",
        [campaignId, contactId],
      );
      assert.equal(state.rows[0]?.state, "SYNCED", "and the slot was still settled");
    });

    await test("D2. a logger that throws SYNCHRONOUSLY changes nothing either", async () => {
      const { contactId, attemptId } = await makeContact(true);
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
        {
          config: STUB_CONFIG,
          append: google.append,
          // Not an async function: this throws before any promise exists,
          // so a `.catch()` alone would not contain it.
          logEvent: (() => {
            throw new Error("thrown before a promise could be returned");
          }) as never,
        },
      );
      await flush();

      assert.equal(result.synced, true);
      assert.equal(google.rows.length, 1);
    });

    await test("D3. an unhandled rejection is never produced by the event sink", async () => {
      const seen: unknown[] = [];
      const onUnhandled = (reason: unknown) => seen.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const { contactId, attemptId } = await makeContact(true);
        await syncFinalYesToSheet(
          {
            campaignId,
            contactId,
            attemptId,
            classification: REGISTERED.classification,
            disposition: REGISTERED.disposition,
            transcript: REGISTERED.transcript,
          },
          {
            config: STUB_CONFIG,
            append: makeAppender().append,
            logEvent: async () => {
              throw new Error("campaign_events is unreachable");
            },
          },
        );
        // Unhandled rejections are reported a macrotask later.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(seen, [], "a rejected log write must never crash the dispatcher process");
    });

    // ═════════════════════════════════════════════════════════════
    section("E. THE EXISTING SHEET-SYNC BEHAVIOUR IS UNCHANGED");

    await test("E1. the appended row is byte-identical with and without an event sink", async () => {
      const withLog = await makeContact(true);
      const withoutLog = await makeContact(true);
      const a = makeAppender();
      const b = makeAppender();

      const withResult = await syncFinalYesToSheet(
        {
          campaignId,
          contactId: withLog.contactId,
          attemptId: withLog.attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: a.append, logEvent: makeRecorder().log },
      );
      const withoutResult = await syncFinalYesToSheet(
        {
          campaignId,
          contactId: withoutLog.contactId,
          attemptId: withoutLog.attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        // No logEvent dep at all — the production default path.
        { config: STUB_CONFIG, append: b.append },
      );

      assert.equal(withResult.synced, true);
      assert.equal(withoutResult.synced, true);
      // Only the phone differs, because they are two different people.
      assert.equal(a.rows[0]?.[0], b.rows[0]?.[0], "same name column");
      assert.equal(a.rows[0]?.[1], b.rows[0]?.[1], "same email column");
      assert.equal(a.rows[0]?.length, 3, "still exactly three columns");
      assert.equal(b.rows[0]?.length, 3, "still exactly three columns");
    });

    await test("E2. the transcript is read, never written back, and never reaches the sheet", async () => {
      const { contactId, attemptId } = await makeContact(true);
      const google = makeAppender();
      const snapshot = JSON.stringify(REGISTERED.transcript);

      await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId,
          classification: REGISTERED.classification,
          disposition: REGISTERED.disposition,
          transcript: REGISTERED.transcript,
        },
        { config: STUB_CONFIG, append: google.append, logEvent: makeRecorder().log },
      );

      assert.equal(JSON.stringify(REGISTERED.transcript), snapshot, "the transcript is not mutated");
      assert.ok(
        !google.rows[0]!.some((cell) => cell.includes("reserve")),
        "no transcript text may leak into the sheet row",
      );
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
