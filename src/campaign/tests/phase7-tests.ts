/**
 * phase7-tests.ts — `npm run test:phase7`
 *
 * Registration retry semantics, contact-level final outcomes, and
 * contact-level analytics.
 *
 * The question every test here answers is the one Phase 7 exists for:
 * WHO GETS CALLED AGAIN. A person who registered must never be dialled
 * a second time; a person who said "call me tomorrow" must not be
 * written off as a refusal; and a conversation that dropped before
 * anyone decided anything is a call we still owe, not a result.
 *
 * The database tests run against the real PostgreSQL and clean up after
 * themselves. The end-to-end ones drive `runCall` with a FAKE manager
 * that returns canned transcripts, so the whole lifecycle — attempt,
 * classification, disposition, retry decision, contact state, analytics
 * — is exercised with ZERO telephony, TTS, STT or LLM contact.
 *
 * NOTHING HERE PLACES A CALL.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor, isDefinitive, CONTACT_DISPOSITIONS } = await import("../outcome/disposition");
const { planRetry } = await import("../dispatch/retry-planner");
const { getDispatchConfig } = await import("../config/dispatch.config");
const { runCall } = await import("../dispatch/call-runner");
const { SessionObserver } = await import("../dispatch/session-observer");
const { claimContacts, createAttempt, recoverOrphans } = await import(
  "../db/repositories/call-attempt.repo"
);
const { getCampaign } = await import("../db/repositories/campaign.repo");
const { buildCampaignResults } = await import("../results/campaign-results");
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

type Turn = { role: "assistant" | "user"; text: string; at: string | null };
const agent = (text: string): Turn => ({ role: "assistant", text, at: null });
const caller = (text: string): Turn => ({ role: "user", text, at: null });

const GATE = "So Priya, should I reserve your free seat for the live event?";
const REMINDER_GATE = "I've marked you as registered — will you be joining us live?";

function classifyConnected(transcript: readonly Turn[], campaignType = "registration") {
  return classifyOutcome({
    campaignType,
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
  });
}

/** A registration retry input, as the planner receives it from the runner. */
function registrationOutcome(outcomeType: string, disposition: string) {
  return {
    campaignType: "registration",
    disposition: disposition as never,
    outcomeType: outcomeType as never,
  };
}

// ═════════════════════════════════════════════════════════════════
section("DISPOSITION MODEL (no database, no network)");

await test("1. every outcome type maps to exactly one known disposition", () => {
  const types = [
    "not_connected", "no_engagement", "registered_confirmed", "interested_not_confirmed",
    "attendance_confirmed", "acknowledged_not_confirmed", "declined", "callback_requested",
    "wrong_number", "do_not_call", "unclear",
  ] as const;
  for (const outcomeType of types) {
    const result = dispositionFor({ outcomeType, failureClass: "COMPLETED" });
    assert.ok(
      (CONTACT_DISPOSITIONS as readonly string[]).includes(result.disposition),
      `${outcomeType} produced an unknown disposition`,
    );
    assert.ok(result.reason.length > 0, `${outcomeType} must carry a human-readable reason`);
  }
});

await test("2. a registration is FINAL_YES and a refusal, opt-out or wrong number is FINAL_NO", () => {
  assert.equal(dispositionFor({ outcomeType: "registered_confirmed", failureClass: "COMPLETED" }).disposition, "FINAL_YES");
  assert.equal(dispositionFor({ outcomeType: "attendance_confirmed", failureClass: "COMPLETED" }).disposition, "FINAL_YES");
  for (const outcomeType of ["declined", "do_not_call", "wrong_number"] as const) {
    assert.equal(
      dispositionFor({ outcomeType, failureClass: "COMPLETED" }).disposition,
      "FINAL_NO",
      `${outcomeType} must permanently close the contact`,
    );
  }
  assert.ok(isDefinitive("FINAL_YES") && isDefinitive("FINAL_NO"));
  assert.ok(!isDefinitive("RETRYABLE") && !isDefinitive("UNRESOLVED") && !isDefinitive("TECHNICAL_FAILURE"));
});

await test("3. a callback request is RETRYABLE and never a refusal", () => {
  const result = dispositionFor({ outcomeType: "callback_requested", failureClass: "COMPLETED" });
  assert.equal(result.disposition, "RETRYABLE");
  assert.ok(!isDefinitive(result.disposition), "a callback must not close a contact");
});

await test("4. an undecided conversation is UNRESOLVED, not a no", () => {
  for (const outcomeType of ["unclear", "interested_not_confirmed", "no_engagement", "acknowledged_not_confirmed"] as const) {
    assert.equal(
      dispositionFor({ outcomeType, failureClass: "COMPLETED" }).disposition,
      "UNRESOLVED",
      `${outcomeType} must stay open`,
    );
  }
});

await test("5. an undialable number is FINAL_NO and a broken call is TECHNICAL_FAILURE", () => {
  assert.equal(
    dispositionFor({ outcomeType: "not_connected", failureClass: "INVALID_NUMBER" }).disposition,
    "FINAL_NO",
  );
  assert.equal(
    dispositionFor({ outcomeType: "not_connected", failureClass: "SYSTEM" }).disposition,
    "TECHNICAL_FAILURE",
  );
  assert.equal(
    dispositionFor({ outcomeType: "not_connected", failureClass: "NO_ANSWER" }).disposition,
    "RETRYABLE",
  );
});

// ═════════════════════════════════════════════════════════════════
section("RETRY PLANNING (no database, no network)");

await test("6. a definitive YES stops the campaign for that contact with attempts still unspent", () => {
  const decision = planRetry(
    "COMPLETED", 1, config.retry, new Date(),
    registrationOutcome("registered_confirmed", "FINAL_YES"),
  );
  assert.equal(decision.retry, false, "a registered person must never be redialled");
  assert.equal(decision.contactStatus, "COMPLETED");
  assert.equal(decision.nextAttemptAfter, null);
  assert.ok(/FINAL_YES/.test(decision.reason));
});

await test("7. a definitive YES survives a technical failure on the same attempt", () => {
  // The call errored AFTER the person committed. The failure class says
  // "retry"; the transcript says "she registered". The transcript wins.
  for (const failureClass of ["TEMPORARY", "SYSTEM", "BUSY", "NO_ANSWER"] as const) {
    const decision = planRetry(
      failureClass, 1, config.retry, new Date(),
      registrationOutcome("registered_confirmed", "FINAL_YES"),
    );
    assert.equal(decision.retry, false, `${failureClass} after a YES must not redial`);
  }
});

await test("8. a definitive NO stops the campaign for that contact", () => {
  for (const [outcomeType, label] of [
    ["declined", "an explicit refusal"],
    ["do_not_call", "an opt-out"],
    ["wrong_number", "the wrong person"],
  ] as const) {
    const decision = planRetry(
      "COMPLETED", 1, config.retry, new Date(),
      registrationOutcome(outcomeType, "FINAL_NO"),
    );
    assert.equal(decision.retry, false, `${label} must not be asked again`);
    assert.equal(decision.nextAttemptAfter, null);
  }
});

await test("9. a callback request stays retryable and is scheduled, not closed", () => {
  const now = new Date("2026-01-01T10:00:00.000Z");
  const decision = planRetry(
    "COMPLETED", 1, config.retry, now,
    registrationOutcome("callback_requested", "RETRYABLE"),
  );
  assert.equal(decision.retry, true, "'call me later' is not a no");
  assert.equal(decision.contactStatus, "PENDING");
  assert.ok(decision.nextAttemptAfter, "a callback must be scheduled");
  assert.equal(
    decision.nextAttemptAfter.getTime() - now.getTime(),
    config.retry.callbackDelayMinutes * 60_000,
    "the callback wait comes from the configured policy",
  );
});

await test("10. an unclear or interrupted registration call stays retryable", () => {
  for (const outcomeType of ["unclear", "interested_not_confirmed", "no_engagement"] as const) {
    const decision = planRetry(
      "COMPLETED", 1, config.retry, new Date(),
      registrationOutcome(outcomeType, "UNRESOLVED"),
    );
    assert.equal(decision.retry, true, `${outcomeType} must not close a registration contact`);
    assert.equal(decision.contactStatus, "PENDING");
  }
});

await test("11. the registration ceiling still bounds a contact that never decides", () => {
  const ceiling = config.retry.registrationMaxAttempts;
  const withinBudget = planRetry(
    "COMPLETED", ceiling - 1, config.retry, new Date(),
    registrationOutcome("unclear", "UNRESOLVED"),
  );
  assert.equal(withinBudget.retry, true);

  const atCeiling = planRetry(
    "COMPLETED", ceiling, config.retry, new Date(),
    registrationOutcome("unclear", "UNRESOLVED"),
  );
  assert.equal(atCeiling.retry, false, "the budget still binds when nobody ever decides");
  assert.ok(/limit of/.test(atCeiling.reason));
});

await test("12. no-answer keeps its existing delay and its existing ceiling", () => {
  const now = new Date("2026-01-01T10:00:00.000Z");
  const decision = planRetry(
    "NO_ANSWER", 1, config.retry, now,
    registrationOutcome("not_connected", "RETRYABLE"),
  );
  assert.equal(decision.retry, true);
  assert.equal(
    decision.nextAttemptAfter?.getTime() ?? 0,
    now.getTime() + config.retry.noAnswerDelayMinutes * 60_000,
    "the existing no-answer wait must be unchanged",
  );

  // And identical without a classification, which is the legacy path.
  const legacy = planRetry("NO_ANSWER", 1, config.retry, now);
  assert.deepEqual(legacy.nextAttemptAfter, decision.nextAttemptAfter);
  assert.equal(planRetry("NO_ANSWER", config.retry.maxAttempts, config.retry).retry, false);
});

await test("13. an unclassified call falls back to the pre-Phase-7 policy exactly", () => {
  const now = new Date("2026-01-01T10:00:00.000Z");
  // No outcome argument: a completed conversation is terminal, as before.
  assert.deepEqual(planRetry("COMPLETED", 1, config.retry, now), {
    retry: false,
    contactStatus: "COMPLETED",
    nextAttemptAfter: null,
    reason: "conversation completed",
  });
  assert.equal(planRetry("INVALID_NUMBER", 1, config.retry, now).retry, false);
  assert.equal(planRetry("BUSY", 1, config.retry, now).retry, true);
  assert.equal(planRetry("TEMPORARY", 1, config.retry, now).retry, true);
});

await test("14. REMINDER campaigns keep the existing behaviour, registration rules and all", () => {
  const reminderUnresolved = planRetry(
    "COMPLETED", 1, config.retry, new Date(),
    { campaignType: "reminder", disposition: "UNRESOLVED" as never, outcomeType: "acknowledged_not_confirmed" as never },
  );
  assert.equal(
    reminderUnresolved.retry,
    false,
    "a reminder conversation that ended is still terminal — registration retries must not leak here",
  );
  assert.equal(reminderUnresolved.contactStatus, "COMPLETED");

  const reminderCallback = planRetry(
    "COMPLETED", 1, config.retry, new Date(),
    { campaignType: "reminder", disposition: "RETRYABLE" as never, outcomeType: "callback_requested" as never },
  );
  assert.equal(reminderCallback.retry, false, "reminder attempt behaviour is unchanged");

  // The one thing reminder DOES gain: a definitive answer closes it.
  const reminderYes = planRetry(
    "TEMPORARY", 1, config.retry, new Date(),
    { campaignType: "reminder", disposition: "FINAL_YES" as never, outcomeType: "attendance_confirmed" as never },
  );
  assert.equal(reminderYes.retry, false);

  // And a reminder no-answer still retries, exactly as before.
  assert.equal(
    planRetry("NO_ANSWER", 1, config.retry, new Date(), {
      campaignType: "reminder",
      disposition: "RETRYABLE" as never,
      outcomeType: "not_connected" as never,
    }).retry,
    true,
  );
});

await test("15. the planner never names a provider, so a retry cannot change lanes", () => {
  const decision = planRetry(
    "COMPLETED", 1, config.retry, new Date(),
    registrationOutcome("callback_requested", "RETRYABLE"),
  );
  assert.deepEqual(
    Object.keys(decision).sort(),
    ["contactStatus", "nextAttemptAfter", "reason", "retry"],
    "a provider field here would be the only way a retry could switch vendor",
  );
});

// ═════════════════════════════════════════════════════════════════
section("VOICEMAIL SAFETY (transcript heuristic only)");

await test("16. a voicemail greeting is not engagement and not a success", () => {
  const outcome = classifyConnected([
    agent("Hi Priya, this is Ishita from Team FlexiFunnels."),
    caller("The person you are calling has been forwarded to voicemail. Please leave a message after the tone."),
  ]);
  assert.equal(outcome.outcomeType, "no_engagement");
  assert.equal(outcome.primaryReason, "suspected_voicemail");
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.detail.suspectedVoicemail, true);
  assert.equal(outcome.detail.confidence, "low", "a heuristic must not present itself as certain");
  assert.ok(
    /no answering-machine detection|not confirmed/i.test(outcome.detail.explanation),
    "the explanation must say the platform cannot actually detect a machine",
  );
});

await test("17. a machine greeting cannot produce a false registration through the gate", () => {
  // The agent reached the commitment question while the greeting played,
  // and the greeting contains a bare affirmation token ("ji"). Before
  // Phase 7 this was a high-confidence registered_confirmed.
  const outcome = classifyConnected([
    agent(GATE),
    caller("Ji, aap jis vyakti ko call kar rahe hain abhi uplabdh nahi hai. Sandesh record kijiye."),
  ]);
  assert.notEqual(outcome.outcomeType, "registered_confirmed", "a machine must never register anyone");
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.primaryReason, "suspected_voicemail");
  assert.equal(
    dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" }).disposition,
    "UNRESOLVED",
    "a suspected voicemail leaves the contact retryable, not closed",
  );
});

await test("18. a real human yes at the gate is still a registration", () => {
  const english = classifyConnected([agent(GATE), caller("Yes, please reserve it.")]);
  assert.equal(english.outcomeType, "registered_confirmed");
  assert.equal(english.succeeded, true);
  assert.equal(english.detail.suspectedVoicemail, undefined);

  const hinglish = classifyConnected([agent(GATE), caller("Haan ji, kar dijiye")]);
  assert.equal(hinglish.outcomeType, "registered_confirmed", "the voicemail table must not break Hinglish");
});

await test("19. the existing outcome precedence is preserved around the new rule", () => {
  // Opt-out and wrong number still outrank everything, including a
  // greeting that happens to be transcribed in the same call.
  const optOut = classifyConnected([
    agent(GATE),
    caller("Remove my number, and leave a message after the tone."),
  ]);
  assert.equal(optOut.outcomeType, "do_not_call", "a compliance signal still comes first");

  const callback = classifyConnected([agent(GATE), caller("I am busy right now, call me later.")]);
  assert.equal(callback.outcomeType, "callback_requested");

  const declined = classifyConnected([agent(GATE), caller("No, not interested.")]);
  assert.equal(declined.outcomeType, "declined");
});

// ═════════════════════════════════════════════════════════════════
// Everything below needs the database.

if (!process.env["DATABASE_URL"]) {
  console.log("\n[SKIP] DATABASE_URL is not set — the database and end-to-end sections were skipped.");
} else {
  const registrationScript = findScript("registration", "v1");
  const reminderScript = findScript("reminder", "v1");
  assert.ok(registrationScript && reminderScript, "both scripts must be registered");

  const campaignId = randomUUID();
  const reminderCampaignId = randomUUID();

  async function seedCampaign(id: string, type: "registration" | "reminder", script: typeof registrationScript) {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__phase7__', $2, 'READY', $3, 'v1', $4,
               $5::jsonb, 'vobiz', 'en', $6, '{"agent":{"gender":"female"}}'::jsonb)`,
      [
        id,
        type,
        type,
        hashScript(script!),
        JSON.stringify({ cartesia: 34, sarvam: 33, "smallest-ai": 33 }),
        `phase7-${id}`,
      ],
    );
  }

  await seedCampaign(campaignId, "registration", registrationScript);
  await seedCampaign(reminderCampaignId, "reminder", reminderScript);

  let seedIndex = 0;
  async function seedContact(provider: string, name = "Priya", inCampaign = campaignId): Promise<string> {
    seedIndex += 1;
    const row = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
      [inCampaign, name, `+9198111${String(10000 + seedIndex)}`, provider, seedIndex],
    );
    return row.rows[0]!.id;
  }

  /** The contact row's business state, as the dashboard and the claim query see it. */
  async function contactState(contactId: string) {
    const row = await query<{
      status: string;
      attempt_count: number;
      final_disposition: string | null;
      last_outcome_type: string | null;
      closure_reason: string | null;
      closed_at: Date | null;
      next_attempt_after: Date | null;
      assigned_provider: string;
    }>(
      `SELECT status::text AS status, attempt_count, final_disposition, last_outcome_type,
              closure_reason, closed_at, next_attempt_after, assigned_provider
         FROM contacts WHERE id = $1`,
      [contactId],
    );
    return row.rows[0]!;
  }

  /**
   * A fake session manager. Contacts NOTHING: no telephony, no TTS, no
   * STT, no model. `endWith` chooses how the session terminates, which
   * is how an interrupted call and a pipeline error are reproduced
   * without breaking anything real.
   */
  function fakeManager(transcript: readonly Turn[], endWith: "idle" | "error" | "silent" = "idle") {
    let listener: ((sessionId: string, transition: unknown) => void) | undefined;
    const sessionId = `fake-${randomUUID()}`;
    return {
      createSession: async () => ({ id: sessionId }),
      warmUpProviders: async () => undefined,
      start: async () => {
        if (endWith === "silent") return; // never answers: the ring watchdog decides
        listener?.(sessionId, { from: "CALLING", to: "LISTENING", at: new Date() });
        setTimeout(() => {
          listener?.(
            sessionId,
            endWith === "error"
              ? { from: "SPEAKING", to: "ERROR", at: new Date() }
              : { from: "SPEAKING", to: "IDLE", at: new Date() },
          );
        }, 20);
      },
      end: async () => undefined,
      getBenchmarkMetrics: async () => ({
        sessionId,
        providerStack: {},
        timestamp: new Date(),
        callDuration: { seconds: 30, createdAt: new Date() },
        estimatedCost: {
          amount: 0.02,
          currency: "USD",
          isEstimate: true,
          breakdown: { telephony: 0.005, speechToText: 0.005, languageModel: 0.005, textToSpeech: 0.005 },
        },
        turnLatencies: [
          {
            turnIndex: 0,
            stt: { milliseconds: 200, measuredAt: new Date() },
            llm: { milliseconds: 400, measuredAt: new Date() },
            tts: { milliseconds: 150, measuredAt: new Date() },
            total: { milliseconds: 750, measuredAt: new Date() },
          },
        ],
      }),
      getTranscript: () =>
        transcript.map((turn) => ({ role: turn.role, content: turn.text, timestamp: new Date() })),
      onStateChange: (fn: (sessionId: string, transition: unknown) => void) => {
        listener = fn;
        return () => (listener = undefined);
      },
    };
  }

  /** Claims one specific contact and runs one call against the fake manager. */
  async function runOneCall(
    contactId: string,
    transcript: readonly Turn[],
    endWith: "idle" | "error" | "silent" = "idle",
    inCampaign = campaignId,
  ) {
    const contact = await claimOne(contactId, inCampaign);
    const manager = fakeManager(transcript, endWith);
    const campaign = await getCampaign(inCampaign);
    assert.ok(campaign);
    return runCall(
      contact,
      {
        manager: manager as never,
        observer: new SessionObserver(manager as never),
        config: { ...config, dialingEnabled: true, ringTimeoutSeconds: 1, maxCallSeconds: 5 },
        campaign,
        script: (inCampaign === campaignId ? registrationScript : reminderScript)!,
      },
      Date.now(),
    );
  }

  async function claimOne(contactId: string, inCampaign = campaignId) {
    const provider = (await contactState(contactId)).assigned_provider;
    const claimed = await claimContacts(inCampaign, provider as never, 50, "phase7");
    const contact = claimed.find((row) => row.id === contactId);
    // Contacts claimed alongside this one are released so a later test
    // still finds them where it left them.
    for (const other of claimed) {
      if (other.id !== contactId) {
        await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [other.id]);
      }
    }
    assert.ok(contact, "the contact must be claimable");
    return contact;
  }

  try {
    // ───────────────────────────────────────────────────────────────
    section("CONTACT STATE AFTER A CALL (fake manager, nothing dials)");

    await test("20. a YES closes the contact permanently and makes it unclaimable", async () => {
      const contactId = await seedContact(CARTESIA);
      const outcome = await runOneCall(contactId, [agent(GATE), caller("Yes, please reserve my seat.")]);
      assert.equal(outcome.failureClass, "COMPLETED");

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_YES");
      assert.equal(state.last_outcome_type, "registered_confirmed");
      assert.equal(state.status, "COMPLETED");
      assert.ok(state.closed_at, "a definitive outcome must close the contact");
      assert.equal(state.next_attempt_after, null, "a registered person must have no scheduled call");
      assert.ok(state.closure_reason && state.closure_reason.length > 0);

      const reclaimed = await claimContacts(campaignId, CARTESIA as never, 50, "phase7");
      assert.equal(
        reclaimed.some((row) => row.id === contactId),
        false,
        "a registered contact must be invisible to the dispatcher",
      );
      for (const row of reclaimed) {
        await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [row.id]);
      }
    });

    await test("21. a YES followed by a pipeline error still stops the campaign", async () => {
      const contactId = await seedContact(CARTESIA);
      // The person commits, then the session errors out. The failure
      // class alone would schedule a retry to someone already registered.
      await runOneCall(contactId, [agent(GATE), caller("Haan ji, kar dijiye")], "error");

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_YES", "the transcript outranks the failure class");
      assert.ok(state.closed_at);
      assert.equal(state.next_attempt_after, null, "no redial after an established YES");
    });

    await test("22. a NO closes the contact permanently", async () => {
      const contactId = await seedContact(SARVAM);
      await runOneCall(contactId, [agent(GATE), caller("No, I am not interested.")]);

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_NO");
      assert.equal(state.last_outcome_type, "declined");
      assert.ok(state.closed_at);
      assert.equal(state.next_attempt_after, null);
    });

    await test("23. an opt-out closes the contact permanently", async () => {
      const contactId = await seedContact(SARVAM);
      await runOneCall(contactId, [agent(GATE), caller("Stop calling me, remove my number.")]);

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_NO");
      assert.equal(state.last_outcome_type, "do_not_call");
      assert.ok(state.closed_at);
    });

    await test("24. 'call me later' stays open, scheduled, and on the same provider", async () => {
      const contactId = await seedContact(SMALLEST);
      await runOneCall(contactId, [agent(GATE), caller("I am busy right now, call me later please.")]);

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "RETRYABLE");
      assert.equal(state.last_outcome_type, "callback_requested");
      assert.equal(state.closed_at, null, "a callback request must never close a contact");
      assert.equal(state.status, "PENDING", "the contact goes back in its own lane's queue");
      assert.ok(state.next_attempt_after, "the callback must be scheduled");
      assert.ok(
        state.next_attempt_after.getTime() > Date.now(),
        "the scheduled time respects the configured wait rather than dialling immediately",
      );
      assert.equal(state.assigned_provider, SMALLEST, "the provider lock is untouched by a retry");
    });

    await test("25. an interrupted conversation stays open rather than being marked as a no", async () => {
      const contactId = await seedContact(CARTESIA);
      // The line drops mid-pitch: nothing decisive was ever said.
      await runOneCall(contactId, [
        agent("Hi Priya, this is Ishita from Team FlexiFunnels."),
        caller("Hello? Who is this, I can't hear you"),
      ]);

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "UNRESOLVED");
      assert.equal(state.closed_at, null, "an undecided call must not close the contact");
      assert.equal(state.status, "PENDING");
      assert.ok(state.next_attempt_after);
    });

    await test("26. a voicemail leaves the contact retryable and is not a registration", async () => {
      const contactId = await seedContact(CARTESIA);
      await runOneCall(contactId, [
        agent(GATE),
        caller("Has been forwarded to voicemail. Please record your message."),
      ]);

      const state = await contactState(contactId);
      assert.equal(state.last_outcome_type, "no_engagement");
      assert.equal(state.final_disposition, "UNRESOLVED");
      assert.equal(state.closed_at, null);

      const stored = await query<{ primary_reason: string; succeeded: boolean | null }>(
        `SELECT o.primary_reason, o.succeeded FROM call_outcomes o
           JOIN call_attempts a ON a.id = o.call_attempt_id
          WHERE a.contact_id = $1 ORDER BY a.attempt_number DESC LIMIT 1`,
        [contactId],
      );
      assert.equal(stored.rows[0]?.primary_reason, "suspected_voicemail");
      assert.equal(stored.rows[0]?.succeeded, false, "a machine is never a success");
    });

    await test("27. no answer still retries on the existing delay, on the same provider", async () => {
      const contactId = await seedContact(SARVAM);
      const before = Date.now();
      const outcome = await runOneCall(contactId, [], "silent");
      assert.equal(outcome.failureClass, "NO_ANSWER");

      const state = await contactState(contactId);
      assert.equal(state.status, "PENDING");
      assert.equal(state.final_disposition, "RETRYABLE");
      assert.equal(state.closed_at, null);
      assert.ok(state.next_attempt_after);
      const waitedMinutes = (state.next_attempt_after.getTime() - before) / 60_000;
      assert.ok(
        Math.abs(waitedMinutes - config.retry.noAnswerDelayMinutes) < 1,
        `the existing no-answer wait of ${config.retry.noAnswerDelayMinutes}m must be unchanged, saw ${waitedMinutes.toFixed(1)}m`,
      );
      assert.equal(state.assigned_provider, SARVAM);
    });

    await test("28. a retried contact takes its NEXT attempt number on its OWN provider", async () => {
      const contactId = await seedContact(CARTESIA);
      await runOneCall(contactId, [agent(GATE), caller("Call me tomorrow please.")]);
      // Clear the scheduled wait so the second attempt is claimable now.
      // The WAIT is what is being bypassed here, never the policy: the
      // disposition, the ceiling and the provider are all untouched.
      await query("UPDATE contacts SET next_attempt_after = NULL WHERE id = $1", [contactId]);

      await runOneCall(contactId, [agent(GATE), caller("Yes, go ahead and register me.")]);

      const attempts = await query<{ attempt_number: number; provider: string }>(
        "SELECT attempt_number, provider FROM call_attempts WHERE contact_id = $1 ORDER BY attempt_number",
        [contactId],
      );
      assert.deepEqual(
        attempts.rows.map((row) => row.attempt_number),
        [1, 2],
        "the retry is a new attempt row, not a resurrection of the first",
      );
      assert.deepEqual(
        [...new Set(attempts.rows.map((row) => row.provider))],
        [CARTESIA],
        "every attempt for a contact stays on that contact's locked provider",
      );

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_YES", "the second call settled it");
      assert.equal(state.attempt_count, 2);
    });

    // ───────────────────────────────────────────────────────────────
    section("SAFETY GUARANTEES");

    await test("29. a duplicate attempt for the same contact and number is refused", async () => {
      const contactId = await seedContact(SARVAM);
      const contact = await claimOne(contactId);

      const first = await createAttempt(campaignId, contact, "vobiz");
      assert.ok(first, "the first attempt is created");
      const second = await createAttempt(campaignId, contact, "vobiz");
      assert.equal(second, undefined, "the unique constraint must refuse the second — no duplicate call");

      // And a second runner holding a stale claim does not dial either.
      const stale = await runCall(
        contact,
        {
          manager: fakeManager([]) as never,
          observer: new SessionObserver(fakeManager([]) as never),
          config: { ...config, dialingEnabled: true },
          campaign: (await getCampaign(campaignId))!,
          script: registrationScript!,
        },
        Date.now(),
      );
      assert.equal(stale.dialled, false);
      assert.match(stale.reason, /already exists/);

      const count = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM call_attempts WHERE contact_id = $1",
        [contactId],
      );
      assert.equal(count.rows[0]?.n, 1, "exactly one attempt row exists");
      await query("DELETE FROM contacts WHERE id = $1", [contactId]);
    });

    await test("30. a cross-provider attempt is refused by the database itself", async () => {
      const contactId = await seedContact(CARTESIA);
      await assert.rejects(
        query(
          `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider, status)
           VALUES ($1, $2, 99, $3, 'vobiz', 'DIALING')`,
          [campaignId, contactId, SARVAM],
        ),
        /cross-provider attempt refused/,
        "a Cartesia contact must not be dialable through Sarvam",
      );
      await query("DELETE FROM contacts WHERE id = $1", [contactId]);
    });

    await test("31. a definitively closed contact cannot be resurrected into the queue", async () => {
      const contactId = await seedContact(CARTESIA);
      await runOneCall(contactId, [agent(GATE), caller("Yes, reserve it.")]);
      // Simulate a stray writer putting the row back to PENDING.
      await query("UPDATE contacts SET status='PENDING', next_attempt_after=NULL WHERE id=$1", [contactId]);

      const claimed = await claimContacts(campaignId, CARTESIA as never, 50, "phase7");
      assert.equal(
        claimed.some((row) => row.id === contactId),
        false,
        "the claim query itself must refuse a FINAL_YES contact",
      );
      for (const row of claimed) {
        await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [row.id]);
      }
    });

    await test("32. orphan recovery re-syncs the attempt counter so the contact is actually retried", async () => {
      const contactId = await seedContact(SMALLEST);
      // Exactly the state a crash mid-call leaves: attempt 1 in flight,
      // contact claimed, attempt_count still 0.
      await query(
        `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider, status)
         VALUES ($1, $2, 1, $3, 'vobiz', 'IN_PROGRESS')`,
        [campaignId, contactId, SMALLEST],
      );
      await query("UPDATE contacts SET status='QUEUED', claimed_by='dead-worker' WHERE id=$1", [contactId]);

      await recoverOrphans(campaignId);

      const state = await contactState(contactId);
      assert.equal(state.status, "PENDING", "the contact is re-queued");
      assert.equal(state.attempt_count, 1, "the counter is taken from the attempt rows, not left behind");

      const contact = await claimOne(contactId);
      assert.equal(contact.nextAttemptNumber, 2, "the next attempt number must not collide with the orphan");
      const retry = await createAttempt(campaignId, contact, "vobiz");
      assert.ok(retry, "the retry attempt is creatable — before this fix it deadlocked on the unique constraint");
      assert.equal(retry.attemptNumber, 2);
      await query("DELETE FROM contacts WHERE id = $1", [contactId]);
    });

    await test("33. a REMINDER campaign keeps its existing terminal behaviour", async () => {
      const contactId = await seedContact(CARTESIA, "Rahul", reminderCampaignId);
      // A reminder conversation that never confirmed. Under the
      // registration policy this would be retried; it must not be.
      await runOneCall(
        contactId,
        [agent(REMINDER_GATE), caller("Hmm, I will see how the day goes.")],
        "idle",
        reminderCampaignId,
      );

      const state = await contactState(contactId);
      assert.equal(state.status, "COMPLETED", "a finished reminder conversation is still terminal");
      assert.equal(state.next_attempt_after, null, "no registration-style retry was scheduled");
      assert.equal(state.final_disposition, "UNRESOLVED", "the disposition is recorded even where policy is unchanged");
      assert.ok(state.closed_at, "the reminder contact is closed, as it was before Phase 7");
    });

    await test("34. a REMINDER yes is recorded as a definitive outcome", async () => {
      const contactId = await seedContact(SARVAM, "Meera", reminderCampaignId);
      await runOneCall(contactId, [agent(REMINDER_GATE), caller("Yes, I will join.")], "idle", reminderCampaignId);

      const state = await contactState(contactId);
      assert.equal(state.final_disposition, "FINAL_YES");
      assert.equal(state.last_outcome_type, "attendance_confirmed");
      assert.ok(state.closed_at);
    });

    // ───────────────────────────────────────────────────────────────
    section("CONTACT-LEVEL ANALYTICS");

    await test("35. conversion is measured over unique contacts, never over attempts", async () => {
      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      const { contactOutcomes, funnel } = results;

      assert.ok(contactOutcomes.totalAttempts > contactOutcomes.total, "this campaign has retries in it");
      assert.equal(
        contactOutcomes.conversionRate.denominator,
        contactOutcomes.total,
        "the conversion denominator must be PEOPLE",
      );
      assert.notEqual(
        contactOutcomes.conversionRate.denominator,
        funnel.attempts,
        "the conversion denominator must NOT be attempts",
      );
      assert.equal(
        contactOutcomes.conversionRate.numerator,
        contactOutcomes.byDisposition.FINAL_YES,
        "the numerator is contacts that finally said yes",
      );
      assert.equal(contactOutcomes.totalAttempts, funnel.attempts, "the two views must agree on the attempt total");
    });

    await test("36. every requested contact-level figure is present and internally consistent", async () => {
      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      const c = results.contactOutcomes;

      const summed =
        c.byDisposition.FINAL_YES + c.byDisposition.FINAL_NO + c.byDisposition.RETRYABLE +
        c.byDisposition.UNRESOLVED + c.byDisposition.TECHNICAL_FAILURE + c.byDisposition.UNCLASSIFIED;
      assert.equal(summed, c.total, "every contact must appear in exactly one disposition");

      assert.ok(c.byDisposition.FINAL_YES >= 1, "the YES calls above must be counted");
      assert.ok(c.byDisposition.FINAL_NO >= 1, "the NO calls above must be counted");
      assert.ok(c.callbackRequested >= 1, "callback requests are reported separately from refusals");
      assert.ok(c.permanentlyClosed >= 2);
      assert.ok(c.stillEligible >= 1, "retryable contacts are still eligible");
      assert.ok(Object.keys(c.attemptsPerContact).length > 0, "the attempt distribution is reported");
      assert.equal(
        Object.values(c.attemptsPerContact).reduce((a, b) => a + b, 0),
        c.total,
        "the distribution must account for every contact",
      );

      // Per-provider, in people rather than calls.
      assert.ok(c.perProvider.length >= 2);
      for (const row of c.perProvider) {
        assert.equal(row.conversionRate.denominator, row.contacts, `${row.provider} must convert over its own contacts`);
        assert.equal(
          row.stillOpen,
          row.contacts - row.byDisposition.FINAL_YES - row.byDisposition.FINAL_NO,
          `${row.provider}: open contacts are those with no definitive answer`,
        );
      }
      assert.equal(
        c.perProvider.reduce((sum, row) => sum + row.contacts, 0),
        c.total,
        "the lanes must add up to the campaign",
      );
    });

    await test("37. the attempt-level metrics are still there and still attempt-level", async () => {
      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      assert.ok(results.funnel.attempts > 0, "the existing funnel is untouched");
      assert.ok(results.providers.length > 0, "per-provider attempt rows are untouched");
      assert.equal(
        results.funnel.successRateOfConnected.denominator,
        results.funnel.connected,
        "the existing attempt-level rate keeps its own denominator",
      );
      assert.ok(results.voice.perProvider.length > 0, "voice metrics are untouched");
      assert.ok(results.orchestration.perProvider.length > 0, "orchestration metrics are untouched");
    });

    await test("38. the report says out loud that voicemail cannot be detected", async () => {
      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      assert.ok(
        results.dataHealth.suspectedVoicemailAttempts >= 1,
        "the voicemail call above must be counted as suspected",
      );
      assert.ok(
        results.dataHealth.warnings.some((w) => /answering-machine detection/i.test(w)),
        "the report must state that no AMD exists rather than implying certainty",
      );
      assert.ok(
        results.dataHealth.warnings.some((w) => /contact-level|counts the same person/i.test(w)),
        "the report must warn that attempt-level success is not conversion",
      );
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [[campaignId, reminderCampaignId]]);
    await closeDbPool();
  }
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
