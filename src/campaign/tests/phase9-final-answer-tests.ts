/**
 * phase9-final-answer-tests.ts — `npm run test:phase9`
 *
 * TWO DEFECTS, AND THE TWO GUARANTEES THAT REPLACE THEM.
 *
 * 1. THE SHEET WAS NEVER WRITTEN.
 *
 *    Not because the gate was wrong — `phase8` already proves the gate,
 *    the claim statement and the append are correct. Because the
 *    service-account credential was declared across several lines of
 *    `.env.local` without quotes, so the loader read the value as `{`,
 *    `JSON.parse` failed, `isConfigured` came back false, and every
 *    FINAL_YES ended as a "not-configured" log line. A second, quieter
 *    copy of the same defect had the tab name declared twice, the last
 *    one naming a tab that does not exist.
 *
 *    Neither could fail a test, because the only thing that read the
 *    live configuration printed it as a report. Section A asserts it.
 *
 * 2. THE CALL CARRIED ON AFTER THE PERSON HAD DECIDED.
 *
 *    A yes at the commitment question ended the conversation and
 *    nothing ended the CALL: the line stayed open until the silence
 *    watchdog closed it. Sections B and C are about hanging up at the
 *    right moment — and, more carefully, about NOT hanging up at every
 *    other moment.
 *
 * Section A reads configuration. Section B is pure. Section C drives
 * the real `runCall` against a fake manager and a real database.
 *
 * NOTHING HERE PLACES A CALL, AND NOTHING HERE CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile, parse as parseEnv } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { definitiveAnswerIn, runCall } = await import("../dispatch/call-runner");
const { SessionObserver } = await import("../dispatch/session-observer");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes, syncFinalYesToSheet } = await import("../integrations/final-yes-sheet");
const { getSheetSyncConfig } = await import("../config/sheet.config");
const { getDispatchConfig } = await import("../config/dispatch.config");
const { findScript, hashScript } = await import("../script/script-registry");
const { claimContacts } = await import("../db/repositories/call-attempt.repo");
const { getCampaign } = await import("../db/repositories/campaign.repo");
const { query, closeDbPool } = await import("../db/client");

import type { SheetSyncConfig } from "../config/sheet.config";
import type { AppendResult } from "../integrations/google-sheets.client";
import type { ConversationTurn } from "../../types/provider.types";

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

const turn = (role: "assistant" | "user", text: string): ConversationTurn => ({
  role,
  content: text,
  timestamp: new Date(),
});
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

const registrationScript = findScript("registration", "v1");
assert.ok(registrationScript, "the approved registration script must be registered");

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PERMISSION = "Can I tell you in 20 seconds why I think you should attend?";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
const CLOSING = "No problem at all, thanks for your time. Have a good day.";

// ═════════════════════════════════════════════════════════════════
section("A. THE DEPLOYMENT'S SHEET CONFIGURATION IS USABLE, NOT JUST PRESENT");

const ENV_FILE = ".env.local";
const SHEET_KEYS = [
  "CAMPAIGN_SHEET_SPREADSHEET_ID",
  "CAMPAIGN_SHEET_TAB_NAME",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
];

await test("A1. a declared service-account credential is one the loader can actually read", () => {
  // The defect: the JSON blob spanned 13 unquoted lines, so the value
  // that reached `process.env` was a single "{". Asserted against the
  // ENVIRONMENT rather than the file, so it holds for a hosting
  // dashboard as well as for a local `.env.local`.
  const blob = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] ?? "";
  if (blob.trim().length === 0) {
    console.log("         (no GOOGLE_SERVICE_ACCOUNT_JSON in this environment — nothing to read)");
    return;
  }

  let parsed: { client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(blob) as typeof parsed;
  } catch (error) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is set but is not parseable JSON (value begins "${blob.slice(0, 12)}", ` +
        `length ${blob.length}). A multi-line value must be quoted or put on one line. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert.equal(typeof parsed.client_email, "string", "the blob must carry client_email");
  assert.ok(String(parsed.client_email).includes("@"), "client_email must be an address");
  assert.ok(
    String(parsed.private_key).includes("BEGIN PRIVATE KEY"),
    "the blob must carry a PEM private_key",
  );
});

await test("A2. a deployment that declares the sheet is reported as CONFIGURED", () => {
  // The end of the chain the defect broke: this is the single boolean
  // `syncFinalYesToSheet` consults before it does anything at all.
  const declared =
    (process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] ?? "").length > 0 &&
    ((process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] ?? "").length > 0 ||
      (process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "").length > 0);
  if (!declared) {
    console.log("         (this deployment does not configure the sheet — a valid state, nothing to check)");
    return;
  }

  const config = getSheetSyncConfig();
  assert.equal(
    config.isConfigured,
    true,
    "the sheet is declared, so a FINAL_YES must not be skipped as not-configured",
  );
  assert.ok(config.tabName.length > 0, "a tab name is required to build the append range");
  assert.ok(!config.tabName.endsWith(" "), "a trailing space in the tab name breaks the range");
});

await test("A3. no sheet variable is declared twice in the env file", () => {
  // The tab-name defect: a stray duplicate block at the end of the file
  // re-declared the tab as one that does not exist, and the loader lets
  // the LAST declaration win. Two declarations of the same key is never
  // deliberate and is invisible in every other test.
  if (!existsSync(ENV_FILE)) {
    console.log(`         (no ${ENV_FILE} in this checkout — nothing to check)`);
    return;
  }
  const lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const key of SHEET_KEYS) {
    const declarations = lines.filter((line) => line.startsWith(`${key}=`));
    assert.ok(
      declarations.length <= 1,
      `${key} is declared ${declarations.length} times in ${ENV_FILE}; the last one silently wins`,
    );
  }
  // ...and the file must still parse into the same values the loader saw.
  const parsed = parseEnv(readFileSync(ENV_FILE));
  if (parsed["CAMPAIGN_SHEET_TAB_NAME"] !== undefined) {
    assert.equal(
      parsed["CAMPAIGN_SHEET_TAB_NAME"],
      process.env["CAMPAIGN_SHEET_TAB_NAME"],
      "the tab name in the file and the one in the environment must agree",
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. WHEN A CONVERSATION HAS REACHED A FINAL ANSWER");

const finalAnswer = (turns: readonly ConversationTurn[]) => definitiveAnswerIn(turns, "registration");

await test("B1. a yes at the gate, once the agent has confirmed it, is FINAL_YES", () => {
  assert.equal(
    finalAnswer([
      agent(GREETING),
      agent(PERMISSION),
      caller("Sure, go ahead."),
      agent(GATE),
      caller("Yes, please reserve it."),
      agent(CONFIRMED),
    ]),
    "FINAL_YES",
  );
});

await test("B2. the same yes is NOT acted on until the agent has replied to it", () => {
  // The person has just spoken. Hanging up here takes the confirmation
  // away from them and makes the call feel like it dropped.
  assert.equal(
    finalAnswer([agent(GREETING), agent(GATE), caller("Yes, please reserve it.")]),
    undefined,
  );
});

await test("B3. a caller still speaking is never hung up on", () => {
  // `getTranscript` appends the utterance in progress as a user turn.
  // The last-turn-must-be-the-agent rule is what keeps it out.
  assert.equal(
    finalAnswer([
      agent(GATE),
      caller("Yes, please reserve it."),
      agent(CONFIRMED),
      caller("Actually wait, one thing"),
    ]),
    undefined,
  );
});

await test("B4. a yes that is taken back afterwards is not a final answer", () => {
  assert.equal(
    finalAnswer([
      agent(GATE),
      caller("Yes, reserve it."),
      agent(CONFIRMED),
      caller("Sorry, I am not interested after all."),
      agent(CLOSING),
    ]),
    "FINAL_NO",
    "the refusal is now the person's answer, and it is still final",
  );
});

await test("B5. a question containing a yes-shaped word ends nothing", () => {
  for (const question of [
    "Yes, and is it free?",
    "Okay, and how long is it?",
    "Theek hai, par ye event kis time hai?",
  ]) {
    assert.equal(
      finalAnswer([agent(GATE), caller(question), agent("It is free, and it runs about 90 minutes.")]),
      undefined,
      `"${question}" is a question, not an answer`,
    );
  }
});

await test("B6. a courtesy yes away from the gate ends nothing", () => {
  assert.equal(
    finalAnswer([
      agent(GREETING),
      agent(PERMISSION),
      caller("Sure, go ahead."),
      agent("It is a live reveal of the Funnel Builder Agent."),
    ]),
    undefined,
  );
});

await test("B7. an unmistakable refusal is FINAL_NO", () => {
  for (const refusal of ["No, I'm not interested.", "No thanks.", "Mujhe nahi chahiye."]) {
    assert.equal(
      finalAnswer([agent(GATE), caller(refusal), agent(CLOSING)]),
      "FINAL_NO",
      `"${refusal}" is a refusal`,
    );
  }
});

await test("B8. a bare no to something that is not the question does NOT end the call", () => {
  // The whole reason FINAL_NO is narrowed. To the post-call classifier
  // any "no" is a refusal; mid-call it is as often "no, I hadn't heard
  // of it" — and a yes at the gate afterwards still outranks it, so
  // hanging up here would throw away a registration that was coming.
  const transcript = [
    agent("Have you heard about the FlexiFunnels live event?"),
    caller("No."),
    agent("It is a live reveal of the Funnel Builder Agent."),
  ];
  assert.equal(finalAnswer(transcript), undefined);

  // ...and the registration that follows is still reached.
  assert.equal(
    finalAnswer([...transcript, agent(GATE), caller("Yes, reserve it."), agent(CONFIRMED)]),
    "FINAL_YES",
  );
});

await test("B9. an opt-out and a wrong number are final the moment they are said", () => {
  assert.equal(
    finalAnswer([agent(GREETING), caller("Remove my number and do not call again."), agent(CLOSING)]),
    "FINAL_NO",
  );
  assert.equal(
    finalAnswer([agent(GREETING), caller("You have the wrong number."), agent(CLOSING)]),
    "FINAL_NO",
  );
});

await test("B10. a callback, a hesitation and an empty call are not final answers", () => {
  assert.equal(
    finalAnswer([agent(GATE), caller("I am busy right now, call me later."), agent(CLOSING)]),
    undefined,
    "a callback is a reason to call again, not an answer",
  );
  assert.equal(
    finalAnswer([agent(GATE), caller("Let me think about it and decide later."), agent(CLOSING)]),
    undefined,
  );
  assert.equal(finalAnswer([agent(GREETING)]), undefined, "nobody has said anything");
  assert.equal(finalAnswer([]), undefined);
});

await test("B11. the hangup and the sheet cannot disagree about a FINAL_YES", () => {
  // Both read `isFinalYes`. This is the property that makes "the call
  // hung up on a yes" and "a row was written" the same event.
  const transcript = [
    agent(GREETING),
    agent(GATE),
    caller("Haan ji, kar dijiye."),
    agent(CONFIRMED),
  ];
  assert.equal(finalAnswer(transcript), "FINAL_YES");

  const stored = transcript.map((t) => ({ role: t.role as "user" | "assistant", text: t.content, at: null }));
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: stored,
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  assert.equal(isFinalYes(classification, disposition), true, "the sheet gate must agree");
});

await test("B12. a suspected voicemail is never a final answer", () => {
  assert.equal(
    finalAnswer([
      agent(GATE),
      caller("Ji, aap jis vyakti ko call kar rahe hain abhi uplabdh nahi hai. Sandesh record kijiye."),
      agent(CONFIRMED),
    ]),
    undefined,
    "a machine must not be able to end a call as a decision",
  );
});

// ═════════════════════════════════════════════════════════════════
// Everything below needs the database.

if (!process.env["DATABASE_URL"]) {
  console.log("\n[SKIP] section C — DATABASE_URL is not set");
} else {
  section("C. THE CALL ACTUALLY ENDS, THROUGH THE REAL RUNNER");

  // The runner calls the sheet mirror with the deployment's own
  // configuration, and this suite must never touch the real
  // spreadsheet. Cleared for the duration of the section and restored
  // afterwards, so the sync reports itself unconfigured and returns.
  const savedSpreadsheetId = process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];

  const config = getDispatchConfig();
  const campaignId = randomUUID();
  let seedIndex = 0;

  /**
   * A session that ANSWERS AND NEVER ENDS BY ITSELF. That is the whole
   * point: before this change the call sat here until the silence
   * watchdog closed it, so a manager that never hangs up is exactly
   * the condition the fix has to survive.
   */
  function fakeManager(transcript: readonly ConversationTurn[]) {
    let listener: ((sessionId: string, transition: unknown) => void) | undefined;
    const sessionId = `fake-${randomUUID()}`;
    const state = { endCalls: 0 };
    return {
      state,
      createSession: async () => ({ id: sessionId }),
      warmUpProviders: async () => undefined,
      start: async () => {
        listener?.(sessionId, { from: "CALLING", to: "LISTENING", at: new Date() });
      },
      end: async () => {
        state.endCalls += 1;
        listener?.(sessionId, { from: "LISTENING", to: "IDLE", at: new Date() });
        return undefined;
      },
      getBenchmarkMetrics: async () => ({
        sessionId,
        providerStack: {},
        timestamp: new Date(),
        callDuration: { seconds: 42, createdAt: new Date() },
        estimatedCost: {
          amount: 0.02,
          currency: "USD",
          isEstimate: true,
          breakdown: { telephony: 0.005, speechToText: 0.005, languageModel: 0.005, textToSpeech: 0.005 },
        },
        turnLatencies: [],
      }),
      getTranscript: () => transcript,
      onStateChange: (fn: (sessionId: string, transition: unknown) => void) => {
        listener = fn;
        return () => (listener = undefined);
      },
    };
  }

  async function seedContact(): Promise<string> {
    seedIndex += 1;
    const row = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
       VALUES ($1, 'Priya', $2, $2, 'cartesia', $3) RETURNING id`,
      [campaignId, `+9198119${String(20000 + seedIndex)}`, seedIndex],
    );
    return row.rows[0]!.id;
  }

  async function runOneCall(
    contactId: string,
    transcript: readonly ConversationTurn[],
    maxSilenceSeconds: number,
  ) {
    const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "phase9");
    const contact = claimed.find((row) => row.id === contactId);
    for (const other of claimed) {
      if (other.id !== contactId) {
        await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [other.id]);
      }
    }
    assert.ok(contact, "the contact must be claimable");

    const campaign = await getCampaign(campaignId);
    assert.ok(campaign);
    const manager = fakeManager(transcript);
    const startedAt = Date.now();
    const outcome = await runCall(
      contact,
      {
        manager: manager as never,
        observer: new SessionObserver(manager as never),
        config: { ...config, dialingEnabled: true, ringTimeoutSeconds: 5, maxCallSeconds: 60, maxSilenceSeconds },
        campaign,
        script: registrationScript!,
      },
      Date.now(),
    );
    return { outcome, elapsedMs: Date.now() - startedAt, endCalls: manager.state.endCalls };
  }

  async function phoneOf(contactId: string): Promise<string> {
    const row = await query<{ normalized_phone: string }>(
      "SELECT normalized_phone FROM contacts WHERE id = $1",
      [contactId],
    );
    return row.rows[0]!.normalized_phone;
  }

  async function attemptRow(attemptId: string) {
    const row = await query<{ status: string; hangup_reason: string | null; failure_class: string | null }>(
      "SELECT status::text AS status, hangup_reason, failure_class FROM call_attempts WHERE id = $1",
      [attemptId],
    );
    return row.rows[0]!;
  }

  try {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__phase9__', 'registration', 'READY', 'registration', 'v1', $2,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
      [campaignId, hashScript(registrationScript!), `phase9-${campaignId}`],
    );

    await test("C1. a confirmed FINAL_YES ends the call instead of waiting out the silence", async () => {
      const contactId = await seedContact();
      // 30s of silence tolerance: if the hangup did not happen, this
      // test cannot pass inside its own runtime.
      const { outcome, elapsedMs, endCalls } = await runOneCall(
        contactId,
        [agent(GREETING), agent(GATE), caller("Yes, please reserve it."), agent(CONFIRMED)],
        30,
      );

      assert.equal(outcome.failureClass, "COMPLETED");
      assert.equal(endCalls, 1, "the call must be ended through the manager's public end()");
      assert.ok(elapsedMs < 5_000, `the call must end promptly, took ${elapsedMs}ms`);

      const attempt = await attemptRow(outcome.attemptId!);
      assert.equal(attempt.hangup_reason, "agent_hangup:final_yes", "who hung up, and why, is recorded");
      assert.equal(attempt.status, "COMPLETED");
    });

    await test("C2. the registration is stored exactly as it was before the early hangup", async () => {
      const contactId = await seedContact();
      const { outcome } = await runOneCall(
        contactId,
        [agent(GREETING), agent(GATE), caller("Haan ji, kar dijiye."), agent(CONFIRMED)],
        30,
      );

      const contact = await query<{
        final_disposition: string | null;
        last_outcome_type: string | null;
        status: string;
        closed_at: Date | null;
        next_attempt_after: Date | null;
      }>(
        `SELECT final_disposition, last_outcome_type, status::text AS status, closed_at, next_attempt_after
           FROM contacts WHERE id = $1`,
        [contactId],
      );
      const state = contact.rows[0]!;
      assert.equal(state.final_disposition, "FINAL_YES");
      assert.equal(state.last_outcome_type, "registered_confirmed");
      assert.equal(state.status, "COMPLETED");
      assert.ok(state.closed_at, "a definitive outcome still closes the contact");
      assert.equal(state.next_attempt_after, null, "a registered person is still never redialled");

      const outcomeRow = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM call_outcomes WHERE call_attempt_id = $1",
        [outcome.attemptId],
      );
      assert.equal(outcomeRow.rows[0]?.n, 1, "the outcome is still classified and stored");
    });

    await test("C3. a definitive refusal ends the call too, and is recorded as one", async () => {
      const contactId = await seedContact();
      const { outcome, elapsedMs, endCalls } = await runOneCall(
        contactId,
        [agent(GREETING), agent(GATE), caller("No, I'm not interested."), agent(CLOSING)],
        30,
      );

      assert.equal(endCalls, 1);
      assert.ok(elapsedMs < 5_000, `the call must end promptly, took ${elapsedMs}ms`);
      const attempt = await attemptRow(outcome.attemptId!);
      assert.equal(attempt.hangup_reason, "agent_hangup:final_no");

      const contact = await query<{ final_disposition: string | null }>(
        "SELECT final_disposition FROM contacts WHERE id = $1",
        [contactId],
      );
      assert.equal(contact.rows[0]?.final_disposition, "FINAL_NO");
    });

    await test("C4. an undecided call is NOT hung up early — it still runs its course", async () => {
      // The regression that would matter most: a person who has asked a
      // question and not answered must keep their call. With a 1s
      // silence tolerance the watchdog closes it, and the hangup reason
      // proves which of the two decided.
      const contactId = await seedContact();
      const { outcome } = await runOneCall(
        contactId,
        [agent(GATE), caller("Okay, and how long is it?"), agent("About 90 minutes.")],
        1,
      );

      const attempt = await attemptRow(outcome.attemptId!);
      assert.equal(attempt.hangup_reason, "watchdog:max_silence", "the final-answer hangup must not have fired");

      const contact = await query<{ final_disposition: string | null; status: string }>(
        "SELECT final_disposition, status::text AS status FROM contacts WHERE id = $1",
        [contactId],
      );
      assert.notEqual(contact.rows[0]?.final_disposition, "FINAL_YES");
      assert.notEqual(contact.rows[0]?.final_disposition, "FINAL_NO");
    });

    // ─────────────────────────────────────────────────────────────
    section("D. A FINAL_YES REACHES THE WRITER WITH THE DEPLOYMENT'S OWN CONFIGURATION");

    await test("D1. the real config, the real gate, the real claim — only Google is a stub", async () => {
      // `phase8` proves this with a hand-made config. The defect was in
      // the config itself, so this one uses the deployment's, which is
      // the only version of this test that could have caught it.
      if (savedSpreadsheetId === undefined || savedSpreadsheetId.length === 0) {
        console.log("         (this deployment does not configure the sheet — nothing to write)");
        return;
      }
      // Read the live configuration, then put the environment back the
      // way the rest of this section needs it: the runner below must
      // still find the sheet unconfigured, or it would append a test
      // row to a real spreadsheet.
      process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
      const liveConfig: SheetSyncConfig = getSheetSyncConfig();
      delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
      assert.equal(liveConfig.isConfigured, true, "the live configuration must be usable");

      const contactId = await seedContact();
      await query("UPDATE contacts SET metadata = '{\"Email\":\"priya@example.com\"}'::jsonb WHERE id = $1", [
        contactId,
      ]);
      const { outcome } = await runOneCall(
        contactId,
        [agent(GREETING), agent(GATE), caller("Yes, please reserve it."), agent(CONFIRMED)],
        30,
      );
      // The runner's own sync saw no spreadsheet id and returned. This
      // is the same FINAL_YES, put through the same function, with the
      // deployment's real configuration and only Google replaced.
      const rows: string[][] = [];
      const result = await syncFinalYesToSheet(
        {
          campaignId,
          contactId,
          attemptId: outcome.attemptId!,
          classification: classifyOutcome({
            campaignType: "registration",
            status: "COMPLETED",
            failureClass: "COMPLETED",
            answered: true,
            transcript: [
              { role: "assistant", text: GATE, at: null },
              { role: "user", text: "Yes, please reserve it.", at: null },
            ],
          }),
          disposition: "FINAL_YES",
        },
        {
          config: liveConfig,
          append: async (_c: SheetSyncConfig, values: readonly string[]): Promise<AppendResult> => {
            rows.push([...values]);
            return { updatedRange: "Sheet1!A99:C99" };
          },
        },
      );

      assert.equal(result.synced, true, "a FINAL_YES must reach the writer, not a not-configured skip");
      assert.deepEqual(rows[0], ["Priya", "priya@example.com", await phoneOf(contactId)]);
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
    if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
    else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
    await closeDbPool();
  }
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
console.log("No telephony, TTS, STT or LLM request was made. No call was placed. Google was not contacted.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
