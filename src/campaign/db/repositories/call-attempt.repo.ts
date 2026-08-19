/**
 * call-attempt.repo.ts
 *
 * Contact claiming, attempt creation, and the dispatcher lock — the
 * three places where the campaign's safety guarantees are actually
 * enforced against the database rather than asserted in TypeScript.
 */

import type { PoolClient } from "pg";

import { query, withTransaction } from "../client";
import type { CallStatus, FailureClass } from "../../domain/call-status";
import type { CampaignTtsProvider } from "../../domain/campaign-types";

export interface ClaimedContact {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string | null;
  readonly normalizedPhone: string;
  readonly assignedProvider: CampaignTtsProvider;
  readonly attemptCount: number;
  readonly nextAttemptNumber: number;
}

/**
 * Atomically claims up to `limit` contacts for ONE provider lane.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes duplicate workers safe: two
 * dispatchers running this exact query get disjoint rows with no
 * coordination, and a crash mid-transaction releases the rows rather
 * than stranding them.
 *
 * The `assigned_provider = $2` predicate is the lane boundary. A
 * contact assigned to Cartesia is invisible to the Sarvam lane's
 * claim, so a cross-provider dial cannot even be attempted — and the
 * Phase 1 trigger would refuse the attempt row if it somehow were.
 *
 * The `final_disposition` predicate is the Phase 7 backstop. A contact
 * whose person has actually decided — registered, refused, opted out —
 * is unclaimable here even if some other code path put its status back
 * to PENDING. "Never call a registered person again" is then a property
 * of the query rather than of every writer that touches the row.
 */
export async function claimContacts(
  campaignId: string,
  provider: CampaignTtsProvider,
  limit: number,
  claimedBy: string,
): Promise<readonly ClaimedContact[]> {
  if (limit <= 0) return [];

  const result = await query<{
    id: string;
    campaign_id: string;
    name: string | null;
    normalized_phone: string;
    assigned_provider: string;
    attempt_count: number;
  }>(
    `UPDATE contacts SET status = 'QUEUED', claimed_by = $4, claimed_at = now(), last_status_at = now()
      WHERE id IN (
        SELECT id FROM contacts
         WHERE campaign_id = $1
           AND assigned_provider = $2
           AND status IN ('PENDING', 'ASSIGNED')
           AND (next_attempt_after IS NULL OR next_attempt_after <= now())
           AND (final_disposition IS NULL
                OR final_disposition NOT IN ('FINAL_YES', 'FINAL_NO'))
         ORDER BY next_attempt_after NULLS FIRST, csv_row_number
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING id, campaign_id, name, normalized_phone, assigned_provider, attempt_count`,
    [campaignId, provider, limit, claimedBy],
  );

  return result.rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    normalizedPhone: row.normalized_phone,
    assignedProvider: row.assigned_provider as CampaignTtsProvider,
    attemptCount: row.attempt_count,
    nextAttemptNumber: row.attempt_count + 1,
  }));
}

/** Puts a claimed contact back in the queue untouched — used by dry runs and shutdown. */
export async function releaseContact(contactId: string, status: CallStatus = "PENDING"): Promise<void> {
  await query(
    `UPDATE contacts SET status = $2, claimed_by = NULL, claimed_at = NULL, last_status_at = now()
      WHERE id = $1`,
    [contactId, status],
  );
}

export interface CreatedAttempt {
  readonly id: string;
  readonly attemptNumber: number;
}

/**
 * Creates the attempt row BEFORE the call is placed.
 *
 * Returns `undefined` when the unique constraint rejects it, which
 * means this attempt number already exists — a retried request, a
 * duplicated worker, or a dispatcher that restarted mid-dial. The
 * caller must then NOT dial. This is the idempotency guarantee, and it
 * is the database's decision rather than a check we could race.
 */
export async function createAttempt(
  campaignId: string,
  contact: ClaimedContact,
  telephonyProvider: string,
): Promise<CreatedAttempt | undefined> {
  const result = await query<{ id: string; attempt_number: number }>(
    `INSERT INTO call_attempts
       (campaign_id, contact_id, attempt_number, provider, telephony_provider, status)
     VALUES ($1, $2, $3, $4, $5, 'DIALING')
     ON CONFLICT (contact_id, attempt_number) DO NOTHING
     RETURNING id, attempt_number`,
    [campaignId, contact.id, contact.nextAttemptNumber, contact.assignedProvider, telephonyProvider],
  );
  const row = result.rows[0];
  return row ? { id: row.id, attemptNumber: row.attempt_number } : undefined;
}

export async function attachSessionId(attemptId: string, sessionId: string): Promise<void> {
  await query("UPDATE call_attempts SET session_id = $2, dialed_at = now() WHERE id = $1", [
    attemptId,
    sessionId,
  ]);
}

export async function markAnswered(attemptId: string): Promise<void> {
  await query(
    `UPDATE call_attempts
        SET status = 'IN_PROGRESS', answered_at = COALESCE(answered_at, now()),
            ring_seconds = COALESCE(ring_seconds, EXTRACT(EPOCH FROM (now() - dialed_at)))
      WHERE id = $1 AND status IN ('DIALING','RINGING','ANSWERED')`,
    [attemptId],
  );
}

export interface FinalizeInput {
  readonly attemptId: string;
  readonly contactId: string;
  readonly status: CallStatus;
  readonly failureClass: FailureClass;
  readonly failureReason?: string;
  readonly hangupReason?: string;
  /** 'observed' when we saw it, 'inferred' when deduced from a timeout. */
  readonly statusSource: "observed" | "inferred";
  readonly nextAttemptAfter: Date | null;
  readonly contactStatus: CallStatus;

  // ── Contact-level business outcome (Phase 7) ───────────────────────
  // Optional. Omitted when the outcome could not be classified, in
  // which case the existing columns are written exactly as before and
  // whatever disposition the contact already carried is left alone.

  /** FINAL_YES | FINAL_NO | RETRYABLE | UNRESOLVED | TECHNICAL_FAILURE. */
  readonly disposition?: string;
  /** The attempt-level outcome_type the disposition was projected from. */
  readonly lastOutcomeType?: string;
  /** True when no further attempt will be made for this contact. */
  readonly closed?: boolean;
  readonly closureReason?: string;
}

/**
 * Closes an attempt and moves the contact, in one transaction, so a
 * crash between the two cannot leave a contact permanently claimed
 * with a finished attempt.
 *
 * The contact's business disposition is written HERE, in that same
 * transaction, rather than by a later update. A contact that is closed
 * as a registration and a contact whose attempt says it registered must
 * become true together or not at all; two statements would leave a
 * window in which a crash produces a registered person who is still
 * dialable.
 */
export async function finalizeAttempt(input: FinalizeInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE call_attempts
          SET status = $2, ended_at = now(), failure_class = $3,
              failure_reason = $4, hangup_reason = $5, status_source = $6,
              duration_seconds = CASE WHEN answered_at IS NOT NULL
                                      THEN EXTRACT(EPOCH FROM (now() - answered_at)) END
        WHERE id = $1`,
      [
        input.attemptId,
        input.status,
        input.failureClass,
        input.failureReason ?? null,
        input.hangupReason ?? null,
        input.statusSource,
      ],
    );
    await client.query(
      `UPDATE contacts
          SET status = $2, attempt_count = attempt_count + 1,
              next_attempt_after = $3, claimed_by = NULL, claimed_at = NULL,
              last_status_at = now(),
              -- COALESCE, so an unclassified call leaves the contact's
              -- existing verdict standing rather than erasing it.
              final_disposition = COALESCE($4, final_disposition),
              last_outcome_type = COALESCE($5, last_outcome_type),
              closure_reason    = CASE WHEN $6 THEN COALESCE($7, closure_reason) ELSE closure_reason END,
              -- The open/closed flag. Cleared on a retry so "closed"
              -- always means "nothing further will be attempted".
              closed_at         = CASE WHEN $6 THEN COALESCE(closed_at, now()) ELSE NULL END
        WHERE id = $1`,
      [
        input.contactId,
        input.contactStatus,
        input.nextAttemptAfter,
        input.disposition ?? null,
        input.lastOutcomeType ?? null,
        input.closed ?? false,
        input.closureReason ?? null,
      ],
    );
  });
}

/** Voice-conversation metrics, verbatim from the existing collector. */
export async function saveCallMetrics(
  attemptId: string,
  campaignId: string,
  provider: string,
  metrics: Record<string, unknown>,
  promoted: {
    turnCount: number | null;
    conversationSeconds: number | null;
    sttP50: number | null;
    llmP50: number | null;
    ttsP50: number | null;
    totalP50: number | null;
    firstTurnTotal: number | null;
    cost: { telephony: number; stt: number; llm: number; tts: number; total: number };
  },
): Promise<void> {
  await query(
    `INSERT INTO call_metrics
       (call_attempt_id, campaign_id, provider, turn_count, conversation_seconds,
        stt_p50_ms, llm_p50_ms, tts_p50_ms, total_p50_ms, first_turn_total_ms,
        cost_telephony_usd, cost_stt_usd, cost_llm_usd, cost_tts_usd, cost_total_usd, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (call_attempt_id) DO NOTHING`,
    [
      attemptId, campaignId, provider,
      promoted.turnCount, promoted.conversationSeconds,
      promoted.sttP50, promoted.llmP50, promoted.ttsP50, promoted.totalP50, promoted.firstTurnTotal,
      promoted.cost.telephony, promoted.cost.stt, promoted.cost.llm, promoted.cost.tts, promoted.cost.total,
      JSON.stringify(metrics),
    ],
  );
}

/** Orchestration metrics. Deliberately a different table from call_metrics. */
export async function saveDispatchMetrics(
  attemptId: string,
  campaignId: string,
  provider: string,
  timings: Readonly<Record<string, number | null>>,
): Promise<void> {
  await query(
    `INSERT INTO dispatch_metrics
       (call_attempt_id, campaign_id, provider, queue_wait_ms, claim_to_dial_ms,
        dial_request_ms, dial_to_ring_ms, ring_to_answer_ms, answer_to_first_audio_ms, persist_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (call_attempt_id) DO NOTHING`,
    [
      attemptId, campaignId, provider,
      timings["queueWaitMs"] ?? null,
      timings["claimToDialMs"] ?? null,
      timings["dialRequestMs"] ?? null,
      timings["dialToRingMs"] ?? null,
      timings["ringToAnswerMs"] ?? null,
      timings["answerToFirstAudioMs"] ?? null,
      timings["persistMs"] ?? null,
    ],
  );
}

export async function logEvent(
  campaignId: string,
  code: string,
  message: string,
  data?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): Promise<void> {
  await query(
    `INSERT INTO campaign_events (campaign_id, level, code, message, data)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [campaignId, level, code, message, JSON.stringify(data ?? {})],
  );
}

// ── Dispatcher lock ───────────────────────────────────────────────

/**
 * One dispatcher per campaign, across restarts and duplicate deploys.
 * A stale heartbeat lets a restarted process take over rather than
 * leaving the campaign permanently locked by a dead owner.
 */
export async function acquireDispatcherLock(
  campaignId: string,
  owner: string,
  staleSeconds: number,
): Promise<boolean> {
  const result = await query<{ owner: string }>(
    `INSERT INTO dispatcher_locks (scope, owner)
     VALUES ($1, $2)
     ON CONFLICT (scope) DO UPDATE
        SET owner = EXCLUDED.owner, acquired_at = now(), heartbeat_at = now()
      WHERE dispatcher_locks.owner = EXCLUDED.owner
         OR dispatcher_locks.heartbeat_at < now() - ($3 || ' seconds')::interval
     RETURNING owner`,
    [`campaign:${campaignId}`, owner, String(staleSeconds)],
  );
  return result.rows.length > 0;
}

export async function heartbeatDispatcherLock(campaignId: string, owner: string): Promise<void> {
  await query(
    "UPDATE dispatcher_locks SET heartbeat_at = now() WHERE scope = $1 AND owner = $2",
    [`campaign:${campaignId}`, owner],
  );
}

export async function releaseDispatcherLock(campaignId: string, owner: string): Promise<void> {
  await query("DELETE FROM dispatcher_locks WHERE scope = $1 AND owner = $2", [
    `campaign:${campaignId}`,
    owner,
  ]);
}

// ── Recovery ──────────────────────────────────────────────────────

/**
 * Reconciles state left behind by a crash.
 *
 * Attempts stuck in a live status belong to sessions that no longer
 * exist (the manager is in-memory and died with the process), so they
 * are closed as SYSTEM failures and the retry planner decides what
 * happens next. Contacts stuck in QUEUED with no live attempt go back
 * to PENDING. Nothing is re-dialled blind.
 *
 * `attempt_count` is re-synchronised from the attempt rows, and that is
 * not cosmetic. It is only ever incremented by `finalizeAttempt`, so a
 * crash mid-call left the counter behind the highest attempt_number
 * that exists. The contact then came back as PENDING, was claimed,
 * derived the SAME attempt number, and lost the unique constraint — so
 * it was released, re-claimed and released again, consuming a slot of
 * the pilot ceiling on every pass and never actually being retried.
 * Taking the counter from the rows themselves makes the next attempt
 * number correct by construction.
 */
export async function recoverOrphans(campaignId: string): Promise<{ attempts: number; contacts: number }> {
  return withTransaction(async (client: PoolClient) => {
    const attempts = await client.query(
      `UPDATE call_attempts
          SET status = 'FAILED', failure_class = 'SYSTEM', status_source = 'inferred',
              failure_reason = 'dispatcher restarted while this call was in flight',
              ended_at = COALESCE(ended_at, now())
        WHERE campaign_id = $1
          AND status IN ('DIALING','RINGING','ANSWERED','IN_PROGRESS')`,
      [campaignId],
    );
    const contacts = await client.query(
      `UPDATE contacts c
          SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL, last_status_at = now(),
              attempt_count = GREATEST(
                c.attempt_count,
                COALESCE((SELECT max(a.attempt_number) FROM call_attempts a WHERE a.contact_id = c.id), 0)
              )
        WHERE c.campaign_id = $1
          AND c.status IN ('QUEUED','DIALING','RINGING','ANSWERED','IN_PROGRESS')`,
      [campaignId],
    );
    return { attempts: attempts.rowCount ?? 0, contacts: contacts.rowCount ?? 0 };
  });
}

export async function countPendingContacts(
  campaignId: string,
  provider?: CampaignTtsProvider,
): Promise<number> {
  const result = provider
    ? await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts
          WHERE campaign_id = $1 AND assigned_provider = $2
            AND status IN ('PENDING','ASSIGNED')
            AND (next_attempt_after IS NULL OR next_attempt_after <= now())
            AND (final_disposition IS NULL
                 OR final_disposition NOT IN ('FINAL_YES','FINAL_NO'))`,
        [campaignId, provider],
      )
    : await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts
          WHERE campaign_id = $1 AND status IN ('PENDING','ASSIGNED')
            AND (final_disposition IS NULL
                 OR final_disposition NOT IN ('FINAL_YES','FINAL_NO'))`,
        [campaignId],
      );
  return result.rows[0]?.n ?? 0;
}

export async function campaignProgress(campaignId: string): Promise<{
  byStatus: Record<string, number>;
  byProvider: Record<string, Record<string, number>>;
  attempts: number;
}> {
  const statuses = await query<{ status: string; n: number }>(
    "SELECT status::text AS status, count(*)::int AS n FROM contacts WHERE campaign_id=$1 GROUP BY 1",
    [campaignId],
  );
  const perProvider = await query<{ provider: string; status: string; n: number }>(
    `SELECT assigned_provider AS provider, status::text AS status, count(*)::int AS n
       FROM contacts WHERE campaign_id=$1 GROUP BY 1,2`,
    [campaignId],
  );
  const attempts = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM call_attempts WHERE campaign_id=$1",
    [campaignId],
  );

  const byStatus: Record<string, number> = {};
  for (const row of statuses.rows) byStatus[row.status] = row.n;

  const byProvider: Record<string, Record<string, number>> = {};
  for (const row of perProvider.rows) {
    const lane = (byProvider[row.provider] ??= {});
    lane[row.status] = row.n;
  }

  return { byStatus, byProvider, attempts: attempts.rows[0]?.n ?? 0 };
}
