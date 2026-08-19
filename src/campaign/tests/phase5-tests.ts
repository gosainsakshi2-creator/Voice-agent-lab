/**
 * phase5-tests.ts — `npm run test:phase5`
 *
 * Results, outcomes, metrics and campaign controls.
 *
 * Every database test runs against the real PostgreSQL and cleans up
 * after itself. The one end-to-end call test drives `runCall` with a
 * FAKE manager that returns canned transcripts and metrics, so the
 * full lifecycle — attempt, session, metrics, classification, outcome
 * — is exercised with ZERO telephony, TTS, STT or LLM contact.
 *
 * NOTHING HERE PLACES A CALL.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { classifyOutcome } = await import("../outcome/classifier");
const { toStoredTranscript, fromStoredTranscript } = await import("../outcome/transcript");
const { isSuccessOutcome, RULES_CLASSIFIER_ID } = await import("../outcome/outcome-types");
const { describeCallCeiling, isPilotStage, pilotStageCeiling, PILOT_LADDER } = await import(
  "../domain/pilot-stage"
);
const { applyControl, CampaignControlWatcher } = await import("../dispatch/control-watcher");
const { getControl, setControl, setPilotStage } = await import("../db/repositories/control.repo");
const { saveOutcome, recordClassifyMs, findUnclassifiedAttempts } = await import(
  "../db/repositories/outcome.repo"
);
const { buildCampaignResults } = await import("../results/campaign-results");
const { exportAttemptsCsv, exportProvidersCsv } = await import("../results/export-csv");
const { listAttempts } = await import("../results/results.repo");
const { runCall } = await import("../dispatch/call-runner");
const { launchCampaignRun } = await import("../dispatch/run-launcher");
const { SessionObserver } = await import("../dispatch/session-observer");
const { getDispatchConfig } = await import("../config/dispatch.config");
const { claimContacts } = await import("../db/repositories/call-attempt.repo");
const { getCampaign } = await import("../db/repositories/campaign.repo");
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
const config = getDispatchConfig();
const CARTESIA = "cartesia";
const SARVAM = "sarvam";
const SMALLEST = "smallest-ai";

/** Shorthand for a transcript turn. */
type Turn = { role: "assistant" | "user"; text: string; at: string | null };
const agent = (text: string): Turn => ({ role: "assistant", text, at: null });
const caller = (text: string): Turn => ({ role: "user", text, at: null });

const REGISTRATION_GATE = "So Priya, should I reserve your free seat for the live event?";
const PERMISSION_GATE = "Can I tell you in 20 seconds why I think you should attend?";

function classifyConnected(transcript: readonly Turn[], campaignType = "registration") {
  return classifyOutcome({
    campaignType,
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
  });
}

// ─────────────────────────────────────────────────────────────────
section("OUTCOME CLASSIFICATION (no database, no network)");

await test("1. a call that never connected is not a business failure of the script", () => {
  const outcome = classifyOutcome({
    campaignType: "registration",
    status: "NO_ANSWER",
    failureClass: "NO_ANSWER",
    answered: false,
    transcript: [],
  });
  assert.equal(outcome.outcomeType, "not_connected");
  assert.equal(outcome.primaryReason, "no_answer");
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.classifier, RULES_CLASSIFIER_ID);
});

await test("2. a yes at the gate that commits is a registration", () => {
  const outcome = classifyConnected([
    agent("Hi Priya, this is Ishita from Team FlexiFunnels."),
    agent(REGISTRATION_GATE),
    caller("Yes, please reserve it."),
  ]);
  assert.equal(outcome.outcomeType, "registered_confirmed");
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(outcome.detail.confidence, "high");
  assert.ok(isSuccessOutcome(outcome.outcomeType));
});

await test("3. a yes to a question that commits NOTHING is not a registration", () => {
  const outcome = classifyConnected([agent(PERMISSION_GATE), caller("Sure, go ahead.")]);
  assert.equal(outcome.outcomeType, "interested_not_confirmed");
  assert.equal(outcome.succeeded, false, "interest must never be counted as a confirmation");
  assert.equal(outcome.primaryReason, "affirmative_not_at_gate");
});

await test("4. Hinglish and Devanagari agreement is understood", () => {
  const hinglish = classifyConnected([agent(REGISTRATION_GATE), caller("Haan ji, kar dijiye")]);
  assert.equal(hinglish.outcomeType, "registered_confirmed");

  const devanagari = classifyConnected([agent(REGISTRATION_GATE), caller("हाँ, ठीक है")]);
  assert.equal(devanagari.outcomeType, "registered_confirmed");
});

await test('5. "ji nahi" is a refusal, not the affirmation hiding inside it', () => {
  const outcome = classifyConnected([agent(REGISTRATION_GATE), caller("Ji nahi, mujhe nahi chahiye")]);
  assert.equal(outcome.outcomeType, "declined", "word order inside one turn must decide this");
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.primaryReason, "explicit_no");
});

await test('6. "no problem" does not end a call that is going well', () => {
  const outcome = classifyConnected([
    agent(REGISTRATION_GATE),
    caller("No problem, yes please book it."),
  ]);
  assert.equal(outcome.outcomeType, "registered_confirmed");
});

await test("7. a yes taken back afterwards is not a success", () => {
  const outcome = classifyConnected([
    agent(REGISTRATION_GATE),
    caller("Yes okay"),
    agent("Perfect, I will get your registration done."),
    caller("Actually no, cancel it, I am not interested."),
  ]);
  assert.equal(outcome.outcomeType, "declined");
  assert.equal(outcome.succeeded, false);
});

await test("8. an opt-out outranks every friendly word before it", () => {
  const outcome = classifyConnected([
    agent(REGISTRATION_GATE),
    caller("Yes sure"),
    agent("Great, I will send the details."),
    caller("Actually do not call me again, remove my number."),
  ]);
  assert.equal(outcome.outcomeType, "do_not_call", "a compliance signal must not be overwritable");
  assert.equal(outcome.primaryReason, "opt_out");
  assert.equal(outcome.succeeded, false);
});

await test("9. wrong number and callback are their own outcomes, not failures of the pitch", () => {
  const wrong = classifyConnected([agent("Hi Priya?"), caller("Wrong number, no Priya here.")]);
  assert.equal(wrong.outcomeType, "wrong_number");

  const callback = classifyConnected([
    agent(REGISTRATION_GATE),
    caller("I am busy right now, call me later."),
  ]);
  assert.equal(callback.outcomeType, "callback_requested");
  assert.equal(callback.succeeded, false);
});

await test("10. connected but silent is recorded as silence, not as a no", () => {
  const outcome = classifyConnected([agent("Hi Priya, this is Ishita."), agent("Hello?")]);
  assert.equal(outcome.outcomeType, "no_engagement");
  assert.equal(outcome.primaryReason, "no_customer_speech");
});

await test("11. an unreadable call is NULL, never false", () => {
  const outcome = classifyConnected([agent("Hi there."), caller("Hmm. What is this regarding.")]);
  assert.equal(outcome.outcomeType, "unclear");
  assert.equal(outcome.succeeded, null, "an unknown outcome must be stored as unknown");
  assert.equal(outcome.primaryReason, "no_decisive_signal");
});

await test("12. a reminder campaign gets a reminder vocabulary", () => {
  const outcome = classifyConnected(
    [agent("Will you attend the session tomorrow?"), caller("Yes, definitely.")],
    "reminder",
  );
  assert.equal(outcome.outcomeType, "attendance_confirmed");
  assert.equal(outcome.succeeded, true);
});

await test("13. every label carries the words that produced it", () => {
  const outcome = classifyConnected([agent(REGISTRATION_GATE), caller("Yes, absolutely.")]);
  assert.ok(outcome.detail.signals.length > 0, "signals must be stored for audit");
  assert.ok(outcome.detail.signals.some((signal) => signal.atGate), "the gate flag must be recorded");
  assert.ok(outcome.detail.explanation.length > 0);
  assert.equal(outcome.detail.customerTurns, 1);
});

await test("14. transcripts drop the system prompt and survive a JSONB round trip", () => {
  const stored = toStoredTranscript([
    { role: "system", content: "the entire master prompt", timestamp: new Date() },
    { role: "assistant", content: "Hi Priya", timestamp: new Date() },
    { role: "user", content: "Yes", timestamp: new Date() },
  ]);
  assert.equal(stored.turns.length, 2, "the system prompt is not stored once per call");
  assert.equal(stored.truncated, false);

  const revived = fromStoredTranscript(JSON.parse(JSON.stringify(stored)));
  assert.equal(revived.length, 2);
  assert.equal(revived[1]?.text, "Yes");
  assert.deepEqual(fromStoredTranscript("nonsense"), [], "malformed JSON must not throw");
});

// ─────────────────────────────────────────────────────────────────
section("CALL CEILING AND THE PILOT LADDER");

await test("15. the smallest ceiling wins, and the report says which one", () => {
  const envBinds = describeCallCeiling({ environmentMax: 10, pilotStage: 3, campaignControlMax: null });
  assert.equal(envBinds.effective, 10);
  assert.equal(envBinds.boundBy, "environment");
  assert.equal(envBinds.pilotStageMax, 500);

  const stageBinds = describeCallCeiling({ environmentMax: 1000, pilotStage: 0, campaignControlMax: null });
  assert.equal(stageBinds.effective, 10);
  assert.equal(stageBinds.boundBy, "pilot-stage");

  const operatorBinds = describeCallCeiling({ environmentMax: 1000, pilotStage: 4, campaignControlMax: 3 });
  assert.equal(operatorBinds.effective, 3);
  assert.equal(operatorBinds.boundBy, "campaign-control");
});

await test("16. the top of the ladder is still bounded by the environment", () => {
  assert.equal(pilotStageCeiling(4), null, "the last rung is the full list");
  const ceiling = describeCallCeiling({ environmentMax: 25, pilotStage: 4, campaignControlMax: null });
  assert.equal(ceiling.effective, 25, "'full list' must never mean 'unlimited'");
  assert.equal(ceiling.boundBy, "environment");
});

await test("17. a stage off the ladder is refused, never clamped", () => {
  assert.equal(isPilotStage(0), true);
  assert.equal(isPilotStage(PILOT_LADDER.length - 1), true);
  assert.equal(isPilotStage(PILOT_LADDER.length), false);
  assert.equal(isPilotStage(-1), false);
  assert.equal(isPilotStage(1.5), false);
});

// ─────────────────────────────────────────────────────────────────
section("CONTROL WATCHER (no database)");

await test("18. a control maps to exactly one dispatcher action", () => {
  const calls: string[] = [];
  const dispatcher = { pause: () => calls.push("pause"), stop: () => calls.push("stop") };
  assert.equal(applyControl(dispatcher, "PAUSE"), "paused");
  assert.equal(applyControl(dispatcher, "STOP"), "stopped");
  assert.equal(applyControl(dispatcher, "RUN"), "none", "RUN must never start anything from here");
  assert.deepEqual(calls, ["pause", "stop"]);
});

await test("19. an instruction is applied once, and a repeat is applied again", async () => {
  let pauses = 0;
  const dispatcher = { pause: () => (pauses += 1), stop: () => undefined };
  let revision = 1;
  const watcher = new CampaignControlWatcher("test", dispatcher, {
    readControl: async () =>
      ({
        campaignId: "test",
        desiredState: "PAUSE",
        maxCallsThisRun: null,
        revision,
        requestedBy: "test",
        reason: null,
        requestedAt: new Date(),
      }) as never,
  });

  assert.equal(await watcher.poll(), "paused");
  assert.equal(await watcher.poll(), "none", "the same instruction must not re-fire every tick");
  assert.equal(pauses, 1);

  revision = 2;
  assert.equal(await watcher.poll(), "paused", '"stop, I mean it" is a new instruction');
  assert.equal(pauses, 2);
  watcher.dispose();
});

await test("20. a database failure in the watcher never disturbs the run", async () => {
  const dispatcher = { pause: () => assert.fail("must not act on an error"), stop: () => undefined };
  const watcher = new CampaignControlWatcher("test", dispatcher, {
    readControl: async () => {
      throw new Error("connection terminated");
    },
  });
  assert.equal(await watcher.poll(), "none");
  watcher.dispose();
});

// ─────────────────────────────────────────────────────────────────
section("DATABASE: CONTROLS, OUTCOMES, RESULTS");

const campaignId = randomUUID();
const script = findScript("registration", "v1");
assert.ok(script);

await query(
  `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                          provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
   VALUES ($1, '__phase5__', 'registration', 'READY', 'registration', 'v1', $2,
           $3::jsonb, 'vobiz', 'en', $4, '{"agent":{"gender":"female"}}'::jsonb)`,
  [
    campaignId,
    hashScript(script),
    JSON.stringify({ cartesia: 34, sarvam: 33, "smallest-ai": 33 }),
    `phase5-${campaignId}`,
  ],
);

/** Seeds one contact and returns its id. */
async function seedContact(index: number, provider: string, name = `Person ${index}`): Promise<string> {
  const row = await query<{ id: string }>(
    `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [campaignId, name, `+9198000${String(10000 + index)}`, provider, index],
  );
  return row.rows[0]!.id;
}

/** Seeds a finished attempt with both metric families and an outcome. */
async function seedAttempt(input: {
  contactId: string;
  provider: string;
  attemptNumber?: number;
  status: string;
  answered: boolean;
  durationSeconds?: number;
  ttsP50?: number;
  sttP50?: number;
  llmP50?: number;
  totalP50?: number;
  costTotal?: number;
  persistMs?: number;
  queueWaitMs?: number;
  outcomeType?: string;
  succeeded?: boolean | null;
  statusSource?: string;
}): Promise<string> {
  const attempt = await query<{ id: string }>(
    `INSERT INTO call_attempts
       (campaign_id, contact_id, attempt_number, provider, telephony_provider, status, status_source,
        dialed_at, answered_at, ended_at, duration_seconds)
     VALUES ($1,$2,$3,$4,'vobiz',$5,$6, now() - interval '5 minutes',
             CASE WHEN $7::boolean THEN now() - interval '4 minutes' END,
             now(), $8)
     RETURNING id`,
    [
      campaignId,
      input.contactId,
      input.attemptNumber ?? 1,
      input.provider,
      input.status,
      input.statusSource ?? "observed",
      input.answered,
      input.durationSeconds ?? null,
    ],
  );
  const attemptId = attempt.rows[0]!.id;

  if (input.answered) {
    await query(
      `INSERT INTO call_metrics
         (call_attempt_id, campaign_id, provider, turn_count, conversation_seconds,
          stt_p50_ms, llm_p50_ms, tts_p50_ms, total_p50_ms, first_turn_total_ms,
          cost_telephony_usd, cost_stt_usd, cost_llm_usd, cost_tts_usd, cost_total_usd, raw)
       VALUES ($1,$2,$3,6,$4,$5,$6,$7,$8,$9,0.01,0.01,0.02,0.01,$10,'{"seeded":true}'::jsonb)`,
      [
        attemptId, campaignId, input.provider,
        input.durationSeconds ?? 60,
        input.sttP50 ?? 300, input.llmP50 ?? 500, input.ttsP50 ?? 200,
        input.totalP50 ?? 900, (input.totalP50 ?? 900) + 100,
        input.costTotal ?? 0.05,
      ],
    );
  }

  await query(
    `INSERT INTO dispatch_metrics
       (call_attempt_id, campaign_id, provider, queue_wait_ms, claim_to_dial_ms,
        dial_request_ms, ring_to_answer_ms, persist_ms)
     VALUES ($1,$2,$3,$4,120,240,$5,$6)`,
    [
      attemptId, campaignId, input.provider,
      input.queueWaitMs ?? 50,
      input.answered ? 4000 : null,
      input.persistMs ?? 30,
    ],
  );

  if (input.outcomeType) {
    await query(
      `INSERT INTO call_outcomes
         (call_attempt_id, campaign_id, outcome_type, succeeded, primary_reason, detail, classifier)
       VALUES ($1,$2,$3,$4,'seeded','{"confidence":"high"}'::jsonb,'rules.v1')`,
      [attemptId, campaignId, input.outcomeType, input.succeeded ?? null],
    );
  }
  return attemptId;
}

try {
  await test("21. a campaign nobody has controlled reads as RUN, not as an error", async () => {
    const control = await getControl(campaignId);
    assert.equal(control.desiredState, "RUN");
    assert.equal(control.revision, 0, "a default is revision 0 so any real instruction outranks it");
    assert.equal(control.maxCallsThisRun, null);
  });

  await test("22. controls are durable, and the revision always moves forward", async () => {
    const paused = await setControl({
      campaignId,
      desiredState: "PAUSE",
      requestedBy: "test",
      reason: "checking",
    });
    assert.equal(paused.desiredState, "PAUSE");
    assert.equal(paused.revision, 1);

    const again = await setControl({ campaignId, desiredState: "PAUSE", requestedBy: "test" });
    assert.equal(again.revision, 2, "a repeated instruction is a new instruction");

    // Read back through a fresh query: this is the cross-process path.
    const readBack = await getControl(campaignId);
    assert.equal(readBack.desiredState, "PAUSE");
    assert.equal(readBack.revision, 2);

    const logged = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM campaign_events WHERE campaign_id=$1 AND code='CONTROL_PAUSE'",
      [campaignId],
    );
    assert.equal(logged.rows[0]?.n, 2, "every control write must be in the audit log");
  });

  await test("23. a ceiling set once is not discarded by the next instruction", async () => {
    await setControl({ campaignId, desiredState: "RUN", requestedBy: "test", maxCallsThisRun: 3 });
    assert.equal((await getControl(campaignId)).maxCallsThisRun, 3);

    await setControl({ campaignId, desiredState: "PAUSE", requestedBy: "test" });
    assert.equal(
      (await getControl(campaignId)).maxCallsThisRun,
      3,
      "pausing must not silently raise the call ceiling",
    );

    await setControl({ campaignId, desiredState: "RUN", requestedBy: "test", maxCallsThisRun: null });
    assert.equal((await getControl(campaignId)).maxCallsThisRun, null, "null clears it explicitly");
  });

  await test("24. the pilot stage is stored, and an invalid one is refused", async () => {
    assert.equal(await setPilotStage(campaignId, 2, "test"), 2);
    assert.equal((await getCampaign(campaignId))?.pilotStage, 2);
    await assert.rejects(() => setPilotStage(campaignId, 9, "test"), /not on the ladder/);
    await setPilotStage(campaignId, 0, "test");
  });

  // ───────────────────────────────────────────────────────────────
  section("DATABASE: OUTCOME PERSISTENCE");

  const outcomeContact = await seedContact(1, CARTESIA, "Priya");
  const outcomeAttempt = await seedAttempt({
    contactId: outcomeContact,
    provider: CARTESIA,
    status: "COMPLETED",
    answered: true,
    durationSeconds: 75,
  });

  await test("25. an outcome is stored with its transcript, classifier and signals", async () => {
    const transcript = toStoredTranscript([
      { role: "assistant", content: REGISTRATION_GATE, timestamp: new Date() },
      { role: "user", content: "Yes, please reserve it", timestamp: new Date() },
    ]);
    const classification = classifyOutcome({
      campaignType: "registration",
      status: "COMPLETED",
      failureClass: "COMPLETED",
      answered: true,
      transcript: transcript.turns,
    });
    await saveOutcome({ attemptId: outcomeAttempt, campaignId, classification, transcript });

    const stored = await query<{
      outcome_type: string;
      succeeded: boolean;
      classifier: string;
      detail: { confidence: string; signals: unknown[] };
      transcript: unknown;
    }>(
      `SELECT outcome_type, succeeded, classifier, detail, transcript
         FROM call_outcomes WHERE call_attempt_id = $1`,
      [outcomeAttempt],
    );
    const row = stored.rows[0];
    assert.equal(row?.outcome_type, "registered_confirmed");
    assert.equal(row?.succeeded, true);
    assert.equal(row?.classifier, RULES_CLASSIFIER_ID);
    assert.equal(row?.detail.confidence, "high");
    assert.ok((row?.detail.signals?.length ?? 0) > 0);
    assert.equal(fromStoredTranscript(row?.transcript).length, 2, "the transcript must survive storage");
  });

  await test("26. re-classifying updates the row and cannot erase the transcript", async () => {
    const reclassified = {
      outcomeType: "unclear" as const,
      succeeded: null,
      primaryReason: "no_decisive_signal" as const,
      classifier: "rules.v2-experimental",
      schemaVersion: 1,
      detail: {
        confidence: "low" as const,
        campaignType: "registration",
        customerTurns: 1,
        assistantTurns: 1,
        signals: [],
        explanation: "re-run",
      },
    };
    // No transcript passed: a re-classification reads the stored one.
    await saveOutcome({ attemptId: outcomeAttempt, campaignId, classification: reclassified });

    const rows = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM call_outcomes WHERE call_attempt_id = $1",
      [outcomeAttempt],
    );
    assert.equal(rows.rows[0]?.n, 1, "re-classification must never create a second outcome row");

    const stored = await query<{ outcome_type: string; succeeded: boolean | null; classifier: string; transcript: unknown }>(
      "SELECT outcome_type, succeeded, classifier, transcript FROM call_outcomes WHERE call_attempt_id = $1",
      [outcomeAttempt],
    );
    assert.equal(stored.rows[0]?.outcome_type, "unclear");
    assert.equal(stored.rows[0]?.succeeded, null);
    assert.equal(stored.rows[0]?.classifier, "rules.v2-experimental");
    assert.equal(
      fromStoredTranscript(stored.rows[0]?.transcript).length,
      2,
      "the words the label was derived from must survive a re-run",
    );

    // Put the real label back for the aggregate tests below.
    await saveOutcome({
      attemptId: outcomeAttempt,
      campaignId,
      classification: classifyOutcome({
        campaignType: "registration",
        status: "COMPLETED",
        failureClass: "COMPLETED",
        answered: true,
        transcript: [agent(REGISTRATION_GATE), caller("Yes, please reserve it")],
      }),
    });
  });

  await test("27. classification time lands in the orchestration table, never the voice one", async () => {
    await recordClassifyMs(outcomeAttempt, 12.7);
    const dispatch = await query<{ classify_ms: number }>(
      "SELECT classify_ms FROM dispatch_metrics WHERE call_attempt_id = $1",
      [outcomeAttempt],
    );
    assert.equal(dispatch.rows[0]?.classify_ms, 13);

    const voiceColumns = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'call_metrics' AND column_name LIKE '%classify%'`,
    );
    assert.equal(voiceColumns.rows[0]?.n, 0, "no orchestration timing may exist in the voice table");
  });

  // ───────────────────────────────────────────────────────────────
  section("DATABASE: RESULTS AGGREGATION");

  // A small, deliberately lopsided campaign:
  //   cartesia    3 connected (one already seeded), 1 registration
  //   sarvam      2 connected, 2 registrations
  //   smallest-ai 1 no answer, 1 rehearsal cancelled by the kill switch
  const cartesia2 = await seedContact(2, CARTESIA);
  const cartesia3 = await seedContact(3, CARTESIA);
  const sarvam1 = await seedContact(4, SARVAM);
  const sarvam2 = await seedContact(5, SARVAM);
  const smallest1 = await seedContact(6, SMALLEST);
  const smallest2 = await seedContact(7, SMALLEST);

  await seedAttempt({
    contactId: cartesia2, provider: CARTESIA, status: "COMPLETED", answered: true,
    durationSeconds: 100, ttsP50: 300, totalP50: 1000, costTotal: 0.07,
    outcomeType: "declined", succeeded: false,
  });
  await seedAttempt({
    contactId: cartesia3, provider: CARTESIA, status: "COMPLETED", answered: true,
    durationSeconds: 50, ttsP50: 100, totalP50: 800, costTotal: 0.03,
    // A slow database write must not be able to move a TTS figure.
    persistMs: 99_000,
    outcomeType: "unclear", succeeded: null,
  });
  await seedAttempt({
    contactId: sarvam1, provider: SARVAM, status: "COMPLETED", answered: true,
    durationSeconds: 80, ttsP50: 400, totalP50: 1200, costTotal: 0.06,
    outcomeType: "registered_confirmed", succeeded: true,
  });
  await seedAttempt({
    contactId: sarvam2, provider: SARVAM, status: "COMPLETED", answered: true,
    durationSeconds: 90, ttsP50: 600, totalP50: 1400, costTotal: 0.08,
    outcomeType: "registered_confirmed", succeeded: true,
  });
  await seedAttempt({
    contactId: smallest1, provider: SMALLEST, status: "NO_ANSWER", answered: false,
    statusSource: "inferred", outcomeType: "not_connected", succeeded: false,
  });
  await seedAttempt({
    contactId: smallest2, provider: SMALLEST, status: "CANCELLED", answered: false,
  });

  await test("28. the funnel counts rehearsals separately from calls", async () => {
    const results = await buildCampaignResults(campaignId);
    assert.ok(results);
    assert.equal(results.funnel.attempts, 7, "every attempt row is counted");
    assert.equal(results.funnel.dialled, 6, "the kill switch's cancelled attempt is not a dial");
    assert.equal(results.funnel.connected, 5);

    const smallest = results.providers.find((row) => row.provider === SMALLEST);
    assert.equal(smallest?.rehearsedNotDialled, 1);
    assert.equal(smallest?.dialled, 1);
    assert.equal(smallest?.connected, 0);
  });

  await test("29. a rate with no denominator is null, never zero", async () => {
    const results = await buildCampaignResults(campaignId);
    const smallest = results?.providers.find((row) => row.provider === SMALLEST);
    assert.equal(smallest?.connectRate.value, 0, "0 of 1 connected is genuinely zero");

    const outcomes = results?.outcomes.perProvider.find((row) => row.provider === SMALLEST);
    assert.equal(
      outcomes?.successRateOfConnected.value,
      null,
      "a success rate over zero connected calls has no value to report",
    );
    assert.equal(outcomes?.successRateOfConnected.denominator, 0);
    assert.equal(smallest?.connectedSeconds.p50, null, "no connected call means no median duration");
    assert.equal(smallest?.connectedSeconds.samples, 0);
  });

  await test("30. success is counted from the outcome, over connected calls", async () => {
    const results = await buildCampaignResults(campaignId);
    const sarvam = results?.outcomes.perProvider.find((row) => row.provider === SARVAM);
    assert.equal(sarvam?.successes, 2);
    assert.equal(sarvam?.successRateOfConnected.value, 1);
    assert.equal(sarvam?.successRateOfConnected.denominator, 2);

    const cartesia = results?.outcomes.perProvider.find((row) => row.provider === CARTESIA);
    assert.equal(cartesia?.successes, 1, "one registration out of three connected");
    assert.equal(cartesia?.undetermined, 1, "an unclear call is neither a success nor a failure");
    assert.equal(cartesia?.successRateOfConnected.value, 1 / 3);
    assert.equal(results?.funnel.successes, 3);
  });

  await test("31. voice percentiles are computed from the voice table alone", async () => {
    const results = await buildCampaignResults(campaignId);
    const cartesia = results?.voice.perProvider.find((row) => row.provider === CARTESIA);
    // Seeded TTS medians: 200, 300, 100 -> median 200.
    assert.equal(cartesia?.ttsMs.p50, 200);
    assert.equal(cartesia?.ttsMs.samples, 3);
    assert.equal(cartesia?.calls, 3);

    const sarvam = results?.voice.perProvider.find((row) => row.provider === SARVAM);
    assert.equal(sarvam?.ttsMs.p50, 500, "400 and 600 interpolate to 500");
    assert.equal(sarvam?.costUsd.total, 0.14);
    assert.equal(sarvam?.costUsd.perCall, 0.07);
  });

  await test("32. a 99-second database write cannot appear in any voice figure", async () => {
    const results = await buildCampaignResults(campaignId);
    const voice = results?.voice.perProvider.find((row) => row.provider === CARTESIA);
    const dispatch = results?.orchestration.perProvider.find((row) => row.provider === CARTESIA);

    assert.equal(dispatch?.persistMs.p50, 30, "the slow write is visible where it belongs");
    assert.equal(dispatch?.persistMs.p90, 79_206, "and it dominates the orchestration tail");
    assert.equal(voice?.ttsMs.p50, 200, "and is nowhere near the TTS figure");
    assert.equal(voice?.totalMs.p50, 900);

    const voiceKeys = Object.keys(voice ?? {});
    for (const key of ["persistMs", "queueWaitMs", "claimToDialMs", "classifyMs"]) {
      assert.equal(voiceKeys.includes(key), false, `${key} must not exist on a voice row`);
    }
  });

  await test("33. no single statement may read both metric tables", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../results/results.repo.ts", import.meta.url)),
      "utf8",
    );
    const statements = source.match(/`[^`]*`/g) ?? [];
    const offenders = statements.filter(
      (sql) => sql.includes("call_metrics") && sql.includes("dispatch_metrics"),
    );
    assert.equal(
      offenders.length,
      0,
      "a query with both tables in scope is how a persist time ends up inside a TTS latency",
    );
    assert.ok(
      statements.some((sql) => sql.includes("call_metrics")),
      "the scan must actually be finding statements",
    );
  });

  await test("34. the report says out loud what it cannot support", async () => {
    const results = await buildCampaignResults(campaignId);
    const warnings = results?.dataHealth.warnings.join(" ") ?? "";
    assert.ok(warnings.includes("CAMPAIGN_DIALING_ENABLED"), "a rehearsal-only report must say so");
    assert.ok(/noise, not findings/.test(warnings), "5 calls is not a result");
    assert.ok(/DEDUCED/.test(warnings), "an inferred NO_ANSWER must not read as carrier-reported");
    assert.equal(results?.dataHealth.inferredTerminalStatuses, 1);
    assert.equal(results?.dialing.enabled, false);
    assert.ok(results?.voice.note.includes("call_metrics"));
    assert.ok(results?.orchestration.note.includes("dispatch_metrics"));
  });

  await test("35. the attempt listing masks phone numbers and carries the outcome", async () => {
    const attempts = await listAttempts(campaignId, 50, 0);
    assert.equal(attempts.length, 7);
    for (const attempt of attempts) {
      assert.match(attempt.maskedPhone, /\*/, "an unmasked number must never leave SQL");
    }
    const registration = attempts.find((attempt) => attempt.outcomeType === "registered_confirmed");
    assert.ok(registration);
    assert.equal(registration.succeeded, true);
  });

  await test("36. the CSV export keeps the two metric families in labelled columns", async () => {
    const csv = await exportAttemptsCsv(campaignId);
    const [header] = csv.split("\r\n");
    assert.ok(header?.includes("voice_tts_p50_ms"));
    assert.ok(header?.includes("dispatch_persist_ms"));
    assert.equal(header?.includes("latency,"), false, "there is no such thing as a combined latency");
    assert.equal(csv.split("\r\n").filter((line) => line.length > 0).length, 8, "7 attempts plus a header");
    assert.match(csv, /\*/, "masked numbers only");

    const providers = await exportProvidersCsv(campaignId);
    assert.ok(providers.includes("cartesia"));
    assert.ok(providers.includes("smallest-ai"));
  });

  await test("37. a name that looks like a formula is neutralised", async () => {
    const evilContact = await seedContact(99, CARTESIA, "=cmd|'/c calc'!A1");
    await seedAttempt({ contactId: evilContact, provider: CARTESIA, status: "FAILED", answered: false });
    const csv = await exportAttemptsCsv(campaignId);
    assert.ok(csv.includes(`"'=cmd|'/c calc'!A1"`), "a leading = must be quoted and defused");
    await query("DELETE FROM contacts WHERE id = $1", [evilContact]);
  });

  await test("38. unclassified finished calls are findable for a later re-run", async () => {
    const unclassified = await findUnclassifiedAttempts(campaignId);
    // The cancelled rehearsal has an ended_at and no outcome; that is
    // exactly the work list a backfill would read.
    assert.ok(unclassified.length >= 1);
    assert.equal(unclassified[0]?.campaignType, "registration");
  });

  // ───────────────────────────────────────────────────────────────
  section("END TO END WITH A FAKE MANAGER (nothing dials)");

  await test("39. a full call writes metrics, an outcome and a classify timing", async () => {
    const contactId = await seedContact(50, CARTESIA, "Priya");
    // The lane claims in CSV order, so ask for the whole lane and pick
    // this contact out of it rather than assuming it is claimed first.
    const claimed = await claimContacts(campaignId, CARTESIA as never, 20, "phase5");
    const contact = claimed.find((row) => row.id === contactId);
    assert.ok(contact, "the seeded contact must be claimable");

    // A FAKE manager. It contacts nothing: no telephony provider, no
    // TTS, no STT, no model. `dialingEnabled` below is set on a config
    // object handed to this fake, and cannot enable dialing anywhere
    // else — the real kill switch is still off in the environment.
    let listener: ((sessionId: string, transition: unknown) => void) | undefined;
    const sessionId = `fake-${randomUUID()}`;
    const fakeManager = {
      createSession: async () => ({ id: sessionId }),
      warmUpProviders: async () => undefined,
      start: async () => {
        listener?.(sessionId, { from: "CALLING", to: "LISTENING", at: new Date() });
        setTimeout(() => listener?.(sessionId, { from: "SPEAKING", to: "IDLE", at: new Date() }), 20);
      },
      end: async () => undefined,
      getBenchmarkMetrics: async () => ({
        sessionId,
        providerStack: {},
        timestamp: new Date(),
        callDuration: { seconds: 61.5, createdAt: new Date() },
        estimatedCost: {
          amount: 0.042,
          currency: "USD",
          isEstimate: true,
          breakdown: { telephony: 0.01, speechToText: 0.005, languageModel: 0.02, textToSpeech: 0.007 },
        },
        turnLatencies: [
          {
            turnIndex: 0,
            stt: { milliseconds: 280, measuredAt: new Date() },
            llm: { milliseconds: 540, measuredAt: new Date() },
            tts: { milliseconds: 190, measuredAt: new Date() },
            total: { milliseconds: 1010, measuredAt: new Date() },
          },
        ],
      }),
      getTranscript: () => [
        { role: "assistant" as const, content: REGISTRATION_GATE, timestamp: new Date() },
        { role: "user" as const, content: "Haan ji, kar dijiye", timestamp: new Date() },
      ],
      onStateChange: (fn: (sessionId: string, transition: unknown) => void) => {
        listener = fn;
        return () => (listener = undefined);
      },
    };

    const campaign = await getCampaign(campaignId);
    assert.ok(campaign);

    const outcome = await runCall(
      contact,
      {
        manager: fakeManager as never,
        observer: new SessionObserver(fakeManager as never),
        config: { ...config, dialingEnabled: true, ringTimeoutSeconds: 5, maxCallSeconds: 5 },
        campaign,
        script,
      },
      Date.now(),
    );

    assert.equal(outcome.failureClass, "COMPLETED");

    const attemptId = outcome.attemptId;
    assert.ok(attemptId);

    const stored = await query<{ status: string; outcome_type: string; succeeded: boolean; classify_ms: number; tts_p50_ms: number }>(
      `SELECT a.status::text AS status, o.outcome_type, o.succeeded, d.classify_ms, m.tts_p50_ms
         FROM call_attempts a
         JOIN call_outcomes o ON o.call_attempt_id = a.id
         JOIN dispatch_metrics d ON d.call_attempt_id = a.id
         JOIN call_metrics m ON m.call_attempt_id = a.id
        WHERE a.id = $1`,
      [attemptId],
    );
    const row = stored.rows[0];
    assert.ok(row, "the attempt must have voice metrics, dispatch metrics AND an outcome");
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.outcome_type, "registered_confirmed", "the Hinglish yes at the gate was understood");
    assert.equal(row.succeeded, true);
    assert.equal(row.tts_p50_ms, 190, "voice metrics come from the collector, verbatim");
    assert.ok(row.classify_ms >= 0, "classification time is recorded on the orchestration row");
  });

  await test("40. a rehearsal with the kill switch off produces no outcome at all", async () => {
    const contactId = await seedContact(51, SARVAM, "Rahul");
    const claimed = await claimContacts(campaignId, SARVAM as never, 20, "phase5");
    const contact = claimed.find((row) => row.id === contactId);
    assert.ok(contact);

    let managerTouched = false;
    const fakeManager = {
      createSession: async () => { managerTouched = true; return { id: "never" }; },
      warmUpProviders: async () => { managerTouched = true; },
      start: async () => { managerTouched = true; },
      end: async () => undefined,
      getBenchmarkMetrics: async () => ({}) as never,
      getTranscript: () => [],
      onStateChange: () => () => undefined,
    };
    const campaign = await getCampaign(campaignId);
    assert.ok(campaign);

    const outcome = await runCall(
      contact,
      {
        manager: fakeManager as never,
        observer: new SessionObserver(fakeManager as never),
        config: { ...config, dialingEnabled: false },
        campaign,
        script,
      },
      Date.now(),
    );

    assert.equal(managerTouched, false, "the kill switch still stops before the voice agent");
    assert.equal(outcome.dialled, false);
    const outcomeRows = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM call_outcomes WHERE call_attempt_id = $1",
      [outcome.attemptId],
    );
    assert.equal(
      outcomeRows.rows[0]?.n,
      0,
      "a rehearsal must never be classified — it would pollute the results with calls nobody received",
    );
  });

  await test("41. a refused start does not clear a stored STOP", async () => {
    // The campaign is READY, so the block comes from preflight rather
    // than from status — the same path a real refusal takes.
    await query("UPDATE campaigns SET status='DRAFT' WHERE id=$1", [campaignId]);
    const stopped = await setControl({ campaignId, desiredState: "STOP", requestedBy: "test" });

    const result = await launchCampaignRun({
      campaignId,
      manager: {
        createSession: async () => assert.fail("a refused start must not create a session"),
        warmUpProviders: async () => undefined,
        start: async () => undefined,
        end: async () => undefined,
        getBenchmarkMetrics: async () => ({}) as never,
        onStateChange: () => () => undefined,
      } as never,
      requestedBy: "test",
      intent: "start",
    });

    assert.equal(result.started, false, "a DRAFT campaign must not run");
    const after = await getControl(campaignId);
    assert.equal(after.desiredState, "STOP", "a failed request must never un-stop a campaign");
    assert.equal(after.revision, stopped.revision, "and must not even bump the revision");
    await query("UPDATE campaigns SET status='READY' WHERE id=$1", [campaignId]);
  });

  await test("42. the results report never claims a call was placed when dialing is off", async () => {
    const results = await buildCampaignResults(campaignId);
    assert.equal(results?.dialing.enabled, false);
    assert.match(results?.dialing.note ?? "", /no telephony provider was contacted/);
    assert.equal(config.dialingEnabled, false, "the environment kill switch is still off");
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  await closeDbPool();
}

console.log("");
console.log("=".repeat(48));
console.log(`${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("No telephony, TTS, STT or LLM request was made. No call was placed.");
process.exit(0);
