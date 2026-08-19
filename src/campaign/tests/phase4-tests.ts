/**
 * phase4-tests.ts — `npm run test:phase4`
 *
 * Dispatcher tests. Every database test runs against the real
 * PostgreSQL and cleans up after itself; the call-runner tests use a
 * fake manager so the full lifecycle is exercised with ZERO telephony,
 * TTS, STT or LLM contact.
 *
 * NOTHING HERE PLACES A CALL.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { Semaphore, TokenBucket, LaneGate } = await import("../dispatch/concurrency");
const { planRetry } = await import("../dispatch/retry-planner");
const { classifyError, canTransition, isTerminal } = await import("../domain/call-status");
const { SessionObserver, classify } = await import("../dispatch/session-observer");
const { runCall } = await import("../dispatch/call-runner");
const { getDispatchConfig } = await import("../config/dispatch.config");
const {
  claimContacts, createAttempt, recoverOrphans, acquireDispatcherLock,
  releaseDispatcherLock, countPendingContacts,
} = await import("../db/repositories/call-attempt.repo");
const { query, withTransaction, closeDbPool } = await import("../db/client");
const { findScript, hashScript } = await import("../script/script-registry");

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
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 3).join("\n         ")}`);
  }
}

const section = (t: string) => console.log(`\n${t}`);
const config = getDispatchConfig();
const CARTESIA = "cartesia";
const SARVAM = "sarvam";

// ─────────────────────────────────────────────────────────────────
section("CONCURRENCY AND CPS");

await test("1. the semaphore never exceeds its capacity", async () => {
  const sem = new Semaphore(3);
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      (async () => {
        await sem.acquire();
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        sem.release();
      })(),
    ),
  );
  assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
  assert.equal(sem.active, 0, "every slot must be released");
});

await test("2. the token bucket paces call starts", async () => {
  const bucket = new TokenBucket(20, 1); // 20/s, burst 1
  const startedAt = Date.now();
  for (let i = 0; i < 5; i += 1) await bucket.take();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 150, `5 tokens at 20/s should take >=150ms, took ${elapsed}ms`);
});

await test("3. a lane is bounded by BOTH its own cap and the global cap", async () => {
  const globalSem = new Semaphore(2);
  const globalBucket = new TokenBucket(1000);
  const gate = new LaneGate(new Semaphore(5), new TokenBucket(1000), globalSem, globalBucket);
  assert.equal(gate.available, 2, "the tighter of lane(5) and global(2) wins");
  await gate.acquire();
  assert.equal(gate.active, 1);
  gate.release();
  assert.equal(gate.active, 0);
});

// ─────────────────────────────────────────────────────────────────
section("STATE MACHINE AND RETRY POLICY");

await test("4. the campaign state machine rejects illegal transitions", () => {
  assert.equal(canTransition("QUEUED", "DIALING"), true);
  assert.equal(canTransition("DIALING", "ANSWERED"), true);
  assert.equal(canTransition("COMPLETED", "DIALING"), false, "a finished attempt cannot be redialled");
  assert.equal(canTransition("PENDING", "IN_PROGRESS"), false, "cannot skip straight into a conversation");
  for (const terminal of ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED"] as const) {
    assert.equal(isTerminal(terminal), true);
  }
});

await test("5. a completed conversation is never retried", () => {
  const decision = planRetry("COMPLETED", 1, config.retry);
  assert.equal(decision.retry, false);
  assert.equal(decision.contactStatus, "COMPLETED");
});

await test("6. no answer and busy retry, invalid numbers never do", () => {
  const noAnswer = planRetry("NO_ANSWER", 1, config.retry);
  assert.equal(noAnswer.retry, true);
  assert.equal(noAnswer.contactStatus, "PENDING", "a retry goes back in the same lane's queue");
  assert.ok(noAnswer.nextAttemptAfter instanceof Date, "a retry must be scheduled, not immediate");

  assert.equal(planRetry("BUSY", 1, config.retry).retry, true);
  assert.equal(planRetry("INVALID_NUMBER", 1, config.retry).retry, false);
});

await test("7. the retry cap is enforced", () => {
  const exhausted = planRetry("NO_ANSWER", config.retry.maxAttempts, config.retry);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.contactStatus, "NO_ANSWER");
});

await test("8. the retry planner never chooses a provider at all", () => {
  // Structural: the decision carries no provider field, so there is no
  // value a caller could read to dial a different lane.
  const decision = planRetry("TEMPORARY", 1, config.retry);
  assert.equal("provider" in decision, false);
  assert.deepEqual(Object.keys(decision).sort(), ["contactStatus", "nextAttemptAfter", "reason", "retry"]);
});

await test("9. errors classify into retry classes conservatively", () => {
  assert.equal(classifyError(new Error("ECONNRESET")).failureClass, "TEMPORARY");
  assert.equal(classifyError(new Error("Calls to this destination region are barred")).failureClass, "INVALID_NUMBER");
  assert.equal(classifyError(new Error("line busy")).failureClass, "BUSY");
  assert.equal(classifyError(new Error("429 rate limit")).failureClass, "TEMPORARY");
  assert.equal(classifyError(new Error("something nobody predicted")).failureClass, "TEMPORARY",
    "an unrecognised error must not be treated as permanent");
});

// ─────────────────────────────────────────────────────────────────
section("SESSION OBSERVATION");

await test("10. one shared listener serves every call", () => {
  let listeners = 0;
  const fake = {
    onStateChange: () => {
      listeners += 1;
      return () => undefined;
    },
  };
  const observer = new SessionObserver(fake as never);
  const stops = Array.from({ length: 50 }, (_, i) => observer.watch(`s${i}`, () => undefined));
  assert.equal(listeners, 1, "50 calls must not add 50 listeners to the manager");
  assert.equal(observer.watching, 50);
  for (const stop of stops) stop();
  assert.equal(observer.watching, 0, "unwatching must not leak");
});

await test("11. session transitions map onto campaign phases", () => {
  const at = new Date();
  assert.equal(classify({ from: "CALLING", to: "LISTENING", at } as never), "answered");
  assert.equal(classify({ from: "ENDING", to: "IDLE", at } as never), "ended");
  assert.equal(classify({ from: "SPEAKING", to: "ERROR", at } as never), "errored");
  assert.equal(classify({ from: "LISTENING", to: "THINKING", at } as never), "activity");
});

// ─────────────────────────────────────────────────────────────────
section("DATABASE: CLAIMING, IDEMPOTENCY, RECOVERY");

const campaignId = randomUUID();
const script = findScript("registration", "v1");
assert.ok(script);

await query(
  `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                          provider_allocation, telephony_provider, language, idempotency_key)
   VALUES ($1, '__phase4__', 'registration', 'READY', 'registration', 'v1', $2,
           $3::jsonb, 'vobiz', 'en', $4)`,
  [campaignId, hashScript(script), JSON.stringify({ cartesia: 50, sarvam: 50 }), `phase4-${campaignId}`],
);

const contactIds: string[] = [];
for (let i = 0; i < 6; i += 1) {
  const provider = i % 2 === 0 ? CARTESIA : SARVAM;
  const row = await query<{ id: string }>(
    `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider)
     VALUES ($1, $2, $3, $3, $4) RETURNING id`,
    [campaignId, `Person ${i}`, `+9199000${String(10000 + i)}`, provider],
  );
  contactIds.push(row.rows[0]!.id);
}

try {
  await test("12. a lane claims only its own provider's contacts", async () => {
    const claimed = await claimContacts(campaignId, CARTESIA as never, 10, "test");
    assert.equal(claimed.length, 3, "3 of the 6 contacts are Cartesia's");
    assert.ok(claimed.every((c) => c.assignedProvider === CARTESIA), "no other lane's contact may be claimed");
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE campaign_id=$1", [campaignId]);
  });

  await test("13. SKIP LOCKED gives concurrent claimers disjoint rows", async () => {
    // Two claimers racing inside real transactions, as two dispatchers would.
    const claimInTx = (worker: string) =>
      withTransaction(async (client) => {
        const res = await client.query<{ id: string }>(
          `UPDATE contacts SET status='QUEUED', claimed_by=$2
            WHERE id IN (SELECT id FROM contacts
                          WHERE campaign_id=$1 AND assigned_provider='cartesia' AND status='PENDING'
                          FOR UPDATE SKIP LOCKED LIMIT 2)
            RETURNING id`,
          [campaignId, worker],
        );
        await new Promise((r) => setTimeout(r, 50));
        return res.rows.map((r) => r.id);
      });

    const [a, b] = await Promise.all([claimInTx("w1"), claimInTx("w2")]);
    const overlap = a.filter((id) => b.includes(id));
    assert.equal(overlap.length, 0, "two workers must never claim the same contact");
    assert.ok(a.length + b.length <= 3, "together they cannot claim more than exist");
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE campaign_id=$1", [campaignId]);
  });

  await test("14. a duplicate attempt number is refused by the database", async () => {
    const claimed = await claimContacts(campaignId, CARTESIA as never, 1, "test");
    const contact = claimed[0]!;
    const first = await createAttempt(campaignId, contact, "vobiz");
    assert.ok(first, "the first attempt must be created");
    const second = await createAttempt(campaignId, contact, "vobiz");
    assert.equal(second, undefined, "a second attempt with the same number must be refused");
    await query("DELETE FROM call_attempts WHERE campaign_id=$1", [campaignId]);
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE campaign_id=$1", [campaignId]);
  });

  await test("15. the database refuses an attempt on the wrong provider", async () => {
    const claimed = await claimContacts(campaignId, CARTESIA as never, 1, "test");
    const contact = claimed[0]!;
    await assert.rejects(
      () =>
        query(
          `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider)
           VALUES ($1, $2, 99, 'sarvam', 'vobiz')`,
          [campaignId, contact.id],
        ),
      (error: unknown) => (error as { code?: string }).code === "23514",
      "a cross-provider attempt must be rejected by the trigger, not by application code",
    );
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE campaign_id=$1", [campaignId]);
  });

  await test("16. crash recovery closes orphans and re-queues contacts", async () => {
    const claimed = await claimContacts(campaignId, CARTESIA as never, 2, "crashed-worker");
    for (const contact of claimed) await createAttempt(campaignId, contact, "vobiz");

    const recovered = await recoverOrphans(campaignId);
    assert.equal(recovered.attempts, 2, "in-flight attempts must be closed");
    assert.ok(recovered.contacts >= 2, "claimed contacts must be released");

    const stuck = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM call_attempts
        WHERE campaign_id=$1 AND status IN ('DIALING','RINGING','ANSWERED','IN_PROGRESS')`,
      [campaignId],
    );
    assert.equal(stuck.rows[0]?.n, 0, "nothing may remain in a live state after recovery");

    const orphanClass = await query<{ failure_class: string; status_source: string }>(
      "SELECT failure_class, status_source FROM call_attempts WHERE campaign_id=$1 LIMIT 1",
      [campaignId],
    );
    assert.equal(orphanClass.rows[0]?.failure_class, "SYSTEM");
    assert.equal(orphanClass.rows[0]?.status_source, "inferred", "recovery must not claim it observed this");

    await query("DELETE FROM call_attempts WHERE campaign_id=$1", [campaignId]);
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL, attempt_count=0 WHERE campaign_id=$1", [campaignId]);
  });

  await test("17. only one dispatcher may hold a campaign", async () => {
    assert.equal(await acquireDispatcherLock(campaignId, "owner-a", 90), true);
    assert.equal(await acquireDispatcherLock(campaignId, "owner-b", 90), false, "a second dispatcher must be refused");
    assert.equal(await acquireDispatcherLock(campaignId, "owner-a", 90), true, "the holder may re-acquire");
    // A stale heartbeat lets a restarted process take over.
    await query("UPDATE dispatcher_locks SET heartbeat_at = now() - interval '10 minutes' WHERE scope=$1", [`campaign:${campaignId}`]);
    assert.equal(await acquireDispatcherLock(campaignId, "owner-b", 90), true, "a stale lock must be reclaimable");
    await releaseDispatcherLock(campaignId, "owner-b");
  });

  // ───────────────────────────────────────────────────────────────
  section("KILL SWITCH AND CALL LIFECYCLE (fake manager — nothing dials)");

  await test("18. with dialing disabled, no session is ever created", async () => {
    const claimed = await claimContacts(campaignId, CARTESIA as never, 1, "test");
    const contact = claimed[0]!;
    let managerTouched = false;
    const fakeManager = {
      createSession: async () => { managerTouched = true; return { id: "s1" }; },
      warmUpProviders: async () => { managerTouched = true; },
      start: async () => { managerTouched = true; },
      end: async () => undefined,
      getBenchmarkMetrics: async () => ({}) as never,
      onStateChange: () => () => undefined,
    };
    const campaign = (await query("SELECT * FROM campaigns WHERE id=$1", [campaignId])).rows[0] as never;

    const outcome = await runCall(
      contact,
      {
        manager: fakeManager as never,
        observer: new SessionObserver(fakeManager as never),
        config: { ...config, dialingEnabled: false },
        campaign: { ...(campaign as object), id: campaignId, campaignType: "registration",
                    scriptHash: hashScript(script), telephonyProvider: "vobiz", language: "en" } as never,
        script,
      },
      Date.now(),
    );

    assert.equal(managerTouched, false, "the kill switch must stop execution BEFORE the voice agent is touched");
    assert.equal(outcome.dialled, false);
    assert.equal(outcome.reason, "dialing disabled");

    const attempt = await query<{ status: string; failure_reason: string }>(
      "SELECT status::text AS status, failure_reason FROM call_attempts WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 1",
      [campaignId],
    );
    assert.equal(attempt.rows[0]?.status, "CANCELLED", "the attempt is recorded, not hidden");
    assert.ok(attempt.rows[0]?.failure_reason.includes("CAMPAIGN_DIALING_ENABLED"));

    await query("DELETE FROM call_attempts WHERE campaign_id=$1", [campaignId]);
    await query("UPDATE contacts SET status='PENDING', claimed_by=NULL, attempt_count=0 WHERE campaign_id=$1", [campaignId]);
  });

  await test("19. the kill switch is off by default", () => {
    // Read from the environment as the dispatcher does.
    assert.equal(
      process.env["CAMPAIGN_DIALING_ENABLED"] === "true",
      config.dialingEnabled,
      "config must reflect the environment",
    );
    assert.equal(config.dialingEnabled, false, "dialing must be disabled until explicitly enabled");
  });

  await test("20. pending counts drive lane completion", async () => {
    const cartesia = await countPendingContacts(campaignId, CARTESIA as never);
    const sarvam = await countPendingContacts(campaignId, SARVAM as never);
    assert.equal(cartesia, 3);
    assert.equal(sarvam, 3);
    assert.equal(await countPendingContacts(campaignId), 6);
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
  await releaseDispatcherLock(campaignId, "owner-a").catch(() => undefined);
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
