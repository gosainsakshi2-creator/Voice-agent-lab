/**
 * campaign-audit.ts
 *
 * The post-campaign questions the results report cannot answer.
 *
 * `results/campaign-results.ts` already answers most of what an
 * operator asks after a run: how many were attempted, answered,
 * completed, classified, at what latency and cost, per provider. This
 * module adds only the gaps, and adds them as reads — no schema change,
 * no new write path, nothing that could affect a call:
 *
 *   - rejected calls as a first-class count (the status enum has no
 *     REJECTED; the failure CLASS does, and nothing surfaced it);
 *   - rate-limit failures separated out of TEMPORARY, which currently
 *     absorbs a 429 and a dropped socket into one bucket;
 *   - system errors, from the campaign event log rather than from
 *     terminal scrollback;
 *   - p95 latency, where the results report gives p50 and p90;
 *   - cost per successful outcome, not just cost per call;
 *   - duplicate-dial and cross-provider integrity, asserted against the
 *     database rather than trusted because a constraint exists;
 *   - stuck sessions, which is the one failure mode a campaign cannot
 *     see from its own totals.
 *
 * THE ONE RULE FROM results.repo.ts STILL HOLDS: no statement here
 * references both `call_metrics` and `dispatch_metrics`. Voice
 * measurements and orchestration measurements stay apart.
 */

import { query } from "../db/client";
import { CAMPAIGN_TTS_PROVIDERS } from "../domain/campaign-types";

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number | null, places = 3): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ── Funnel, including the statuses nothing else surfaces ────────────

export interface AuditFunnel {
  readonly attempted: number;
  /** Attempt rows the kill switch wrote without dialling. */
  readonly rehearsedNotDialled: number;
  readonly dialled: number;
  readonly answered: number;
  readonly completed: number;
  readonly noAnswer: number;
  readonly busy: number;
  readonly failed: number;
  /** By failure_class, which is where REJECTED, USER_HANGUP and INVALID_NUMBER live. */
  readonly byFailureClass: Readonly<Record<string, number>>;
  /** How many terminal statuses were deduced by our own timers rather than reported. */
  readonly inferredTerminal: number;
  readonly connectedSeconds: {
    readonly mean: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly samples: number;
  };
}

export async function auditFunnel(campaignId: string): Promise<AuditFunnel> {
  const totals = await query(
    `SELECT count(*)::int                                                     AS attempted,
            count(*) FILTER (WHERE status = 'CANCELLED')::int                 AS rehearsed,
            count(*) FILTER (WHERE status <> 'CANCELLED')::int                AS dialled,
            count(*) FILTER (WHERE answered_at IS NOT NULL)::int              AS answered,
            count(*) FILTER (WHERE status = 'COMPLETED')::int                 AS completed,
            count(*) FILTER (WHERE status = 'NO_ANSWER')::int                 AS no_answer,
            count(*) FILTER (WHERE status = 'BUSY')::int                      AS busy,
            count(*) FILTER (WHERE status = 'FAILED')::int                    AS failed,
            count(*) FILTER (WHERE status_source = 'inferred'
                               AND ended_at IS NOT NULL)::int                 AS inferred_terminal,
            count(duration_seconds)::int                                      AS duration_samples,
            avg(duration_seconds)                                             AS duration_mean,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_seconds)    AS duration_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_seconds)    AS duration_p95
       FROM call_attempts
      WHERE campaign_id = $1`,
    [campaignId],
  );

  const classes = await query(
    `SELECT COALESCE(failure_class, 'unset') AS failure_class, count(*)::int AS n
       FROM call_attempts WHERE campaign_id = $1 GROUP BY 1 ORDER BY 1`,
    [campaignId],
  );

  const row = totals.rows[0] ?? {};
  const byFailureClass: Record<string, number> = {};
  for (const classRow of classes.rows) {
    byFailureClass[String(classRow["failure_class"])] = int(classRow["n"]);
  }

  return {
    attempted: int(row["attempted"]),
    rehearsedNotDialled: int(row["rehearsed"]),
    dialled: int(row["dialled"]),
    answered: int(row["answered"]),
    completed: int(row["completed"]),
    noAnswer: int(row["no_answer"]),
    busy: int(row["busy"]),
    failed: int(row["failed"]),
    byFailureClass,
    inferredTerminal: int(row["inferred_terminal"]),
    connectedSeconds: {
      mean: round(num(row["duration_mean"])),
      p50: round(num(row["duration_p50"])),
      p95: round(num(row["duration_p95"])),
      samples: int(row["duration_samples"]),
    },
  };
}

// ── Integrity: duplicate dialing, cross-provider, provider lock ─────

export interface IntegrityReport {
  /** Attempts whose provider disagrees with the contact's lock. Must be 0. */
  readonly crossProviderAttempts: number;
  /** Contacts locked to a provider outside the campaign's three lanes. Must be 0. */
  readonly unknownProviderContacts: number;
  /** Two contact rows for the same number in this campaign. The unique index makes this 0. */
  readonly duplicateNumbersInCampaign: number;
  /** Contacts with more DIALLED attempts than the retry cap allows. */
  readonly contactsOverRetryCap: number;
  readonly maxAttemptsOnOneContact: number;
  /**
   * Numbers that also exist in another campaign AND are locked to a
   * different provider there. The Phase 1 uniqueness guarantee is
   * per-campaign, so this is legal in the schema and still breaks
   * "one number, one provider" if the same list is used for a
   * registration and a reminder campaign.
   */
  readonly numbersWithConflictingProviderElsewhere: number;
  /** Numbers dialled by this campaign that another campaign also dialled. */
  readonly numbersDialledByAnotherCampaign: number;
}

export async function auditIntegrity(
  campaignId: string,
  retryMaxAttempts: number,
): Promise<IntegrityReport> {
  const crossProvider = await query(
    `SELECT count(*)::int AS n
       FROM call_attempts a JOIN contacts c ON c.id = a.contact_id
      WHERE a.campaign_id = $1 AND a.provider <> c.assigned_provider`,
    [campaignId],
  );

  const unknownProvider = await query(
    `SELECT count(*)::int AS n FROM contacts
      WHERE campaign_id = $1 AND assigned_provider <> ALL($2::text[])`,
    [campaignId, [...CAMPAIGN_TTS_PROVIDERS]],
  );

  const duplicateNumbers = await query(
    `SELECT count(*)::int AS n FROM (
       SELECT normalized_phone FROM contacts WHERE campaign_id = $1
        GROUP BY normalized_phone HAVING count(*) > 1
     ) duplicated`,
    [campaignId],
  );

  const perContact = await query(
    `SELECT count(*) FILTER (WHERE dialled > $2)::int AS over_cap,
            COALESCE(max(dialled), 0)::int            AS max_dialled
       FROM (
         SELECT contact_id, count(*) FILTER (WHERE status <> 'CANCELLED')::int AS dialled
           FROM call_attempts WHERE campaign_id = $1 GROUP BY contact_id
       ) per_contact`,
    [campaignId, retryMaxAttempts],
  );

  const conflicting = await query(
    `SELECT count(DISTINCT mine.normalized_phone)::int AS n
       FROM contacts mine
       JOIN contacts other
         ON other.normalized_phone = mine.normalized_phone
        AND other.campaign_id <> mine.campaign_id
        AND other.assigned_provider <> mine.assigned_provider
      WHERE mine.campaign_id = $1`,
    [campaignId],
  );

  const dialledElsewhere = await query(
    `SELECT count(DISTINCT mine.normalized_phone)::int AS n
       FROM contacts mine
       JOIN contacts other
         ON other.normalized_phone = mine.normalized_phone
        AND other.campaign_id <> mine.campaign_id
       JOIN call_attempts a
         ON a.contact_id = other.id AND a.status <> 'CANCELLED'
      WHERE mine.campaign_id = $1`,
    [campaignId],
  );

  return {
    crossProviderAttempts: int(crossProvider.rows[0]?.["n"]),
    unknownProviderContacts: int(unknownProvider.rows[0]?.["n"]),
    duplicateNumbersInCampaign: int(duplicateNumbers.rows[0]?.["n"]),
    contactsOverRetryCap: int(perContact.rows[0]?.["over_cap"]),
    maxAttemptsOnOneContact: int(perContact.rows[0]?.["max_dialled"]),
    numbersWithConflictingProviderElsewhere: int(conflicting.rows[0]?.["n"]),
    numbersDialledByAnotherCampaign: int(dialledElsewhere.rows[0]?.["n"]),
  };
}

// ── Stuck sessions ──────────────────────────────────────────────────

export interface StuckReport {
  readonly staleMinutes: number;
  /** Attempts still in a live status long after they should have ended. */
  readonly liveAttemptsPastDeadline: number;
  /** Contacts claimed by a dispatcher and never released. */
  readonly contactsStuckClaimed: number;
  /** Attempts that ended without a metrics row, i.e. the persist step lost. */
  readonly endedAttemptsMissingDispatchMetrics: number;
  readonly heldDispatcherLocks: ReadonlyArray<{ owner: string; heartbeatAgeSeconds: number }>;
}

/**
 * @param staleMinutes How long past its start an attempt has to still
 *   be "live" before it counts as stuck. Derive it from
 *   CAMPAIGN_MAX_CALL_SECONDS plus headroom rather than guessing.
 */
export async function auditStuck(campaignId: string, staleMinutes: number): Promise<StuckReport> {
  const attempts = await query(
    `SELECT count(*)::int AS n FROM call_attempts
      WHERE campaign_id = $1
        AND status IN ('DIALING','RINGING','ANSWERED','IN_PROGRESS')
        AND created_at < now() - ($2 || ' minutes')::interval`,
    [campaignId, String(staleMinutes)],
  );

  const contacts = await query(
    `SELECT count(*)::int AS n FROM contacts
      WHERE campaign_id = $1 AND claimed_at IS NOT NULL
        AND claimed_at < now() - ($2 || ' minutes')::interval
        AND status IN ('QUEUED','DIALING','RINGING','ANSWERED','IN_PROGRESS')`,
    [campaignId, String(staleMinutes)],
  );

  // dispatch_metrics only. Never joined to call_metrics.
  const missingDispatch = await query(
    `SELECT count(*)::int AS n
       FROM call_attempts a
       LEFT JOIN dispatch_metrics d ON d.call_attempt_id = a.id
      WHERE a.campaign_id = $1 AND a.answered_at IS NOT NULL AND d.call_attempt_id IS NULL`,
    [campaignId],
  );

  const locks = await query(
    `SELECT owner, EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS age
       FROM dispatcher_locks WHERE scope = $1`,
    [`campaign:${campaignId}`],
  );

  return {
    staleMinutes,
    liveAttemptsPastDeadline: int(attempts.rows[0]?.["n"]),
    contactsStuckClaimed: int(contacts.rows[0]?.["n"]),
    endedAttemptsMissingDispatchMetrics: int(missingDispatch.rows[0]?.["n"]),
    heldDispatcherLocks: locks.rows.map((row) => ({
      owner: String(row["owner"]),
      heartbeatAgeSeconds: int(row["age"]),
    })),
  };
}

// ── Errors, separated by kind ───────────────────────────────────────

export interface ErrorReport {
  /** Attempts whose failure reason names a rate limit or a 429. */
  readonly rateLimitedAttempts: number;
  readonly rateLimitExamples: readonly string[];
  /** Attempts closed as TEMPORARY that are NOT rate limits. */
  readonly otherTemporaryFailures: number;
  readonly systemFailures: number;
  /** campaign_events at level 'error', by code. */
  readonly eventErrorsByCode: Readonly<Record<string, number>>;
  readonly eventWarningsByCode: Readonly<Record<string, number>>;
}

const RATE_LIMIT_PATTERN = "(429|rate limit|rate_limit|too many requests|quota)";

export async function auditErrors(campaignId: string): Promise<ErrorReport> {
  const attempts = await query(
    `SELECT count(*) FILTER (WHERE failure_reason ~* $2)::int                       AS rate_limited,
            count(*) FILTER (WHERE failure_class = 'TEMPORARY'
                               AND (failure_reason IS NULL
                                    OR failure_reason !~* $2))::int                 AS other_temporary,
            count(*) FILTER (WHERE failure_class = 'SYSTEM'
                               AND status <> 'CANCELLED')::int                      AS system_failures
       FROM call_attempts WHERE campaign_id = $1`,
    [campaignId, RATE_LIMIT_PATTERN],
  );

  const examples = await query(
    `SELECT DISTINCT left(failure_reason, 160) AS reason
       FROM call_attempts
      WHERE campaign_id = $1 AND failure_reason ~* $2
      LIMIT 5`,
    [campaignId, RATE_LIMIT_PATTERN],
  );

  const events = await query(
    `SELECT level, code, count(*)::int AS n
       FROM campaign_events
      WHERE campaign_id = $1 AND level IN ('error','warn')
      GROUP BY 1, 2`,
    [campaignId],
  );

  const eventErrorsByCode: Record<string, number> = {};
  const eventWarningsByCode: Record<string, number> = {};
  for (const row of events.rows) {
    const bucket = String(row["level"]) === "error" ? eventErrorsByCode : eventWarningsByCode;
    bucket[String(row["code"])] = int(row["n"]);
  }

  const row = attempts.rows[0] ?? {};
  return {
    rateLimitedAttempts: int(row["rate_limited"]),
    rateLimitExamples: examples.rows.map((example) => String(example["reason"])),
    otherTemporaryFailures: int(row["other_temporary"]),
    systemFailures: int(row["system_failures"]),
    eventErrorsByCode,
    eventWarningsByCode,
  };
}

// ── Latency: VOICE ONLY, from call_metrics ──────────────────────────

export interface LatencyRow {
  readonly provider: string;
  readonly calls: number;
  readonly sttP50: number | null;
  readonly sttP95: number | null;
  readonly llmP50: number | null;
  readonly llmP95: number | null;
  readonly ttsP50: number | null;
  readonly ttsP95: number | null;
  readonly totalP50: number | null;
  readonly totalP95: number | null;
  readonly totalMean: number | null;
}

/** Sourced from `call_metrics` alone — the p95 the results report does not carry. */
export async function auditLatency(campaignId: string): Promise<readonly LatencyRow[]> {
  const result = await query(
    `SELECT provider, count(*)::int AS calls,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY stt_p50_ms)   AS stt_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY stt_p50_ms)   AS stt_p95,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY llm_p50_ms)   AS llm_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY llm_p50_ms)   AS llm_p95,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY tts_p50_ms)   AS tts_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY tts_p50_ms)   AS tts_p95,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_p50_ms) AS total_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY total_p50_ms) AS total_p95,
            avg(total_p50_ms)                                          AS total_mean
       FROM call_metrics WHERE campaign_id = $1 GROUP BY provider ORDER BY provider`,
    [campaignId],
  );

  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    calls: int(row["calls"]),
    sttP50: round(num(row["stt_p50"]), 0),
    sttP95: round(num(row["stt_p95"]), 0),
    llmP50: round(num(row["llm_p50"]), 0),
    llmP95: round(num(row["llm_p95"]), 0),
    ttsP50: round(num(row["tts_p50"]), 0),
    ttsP95: round(num(row["tts_p95"]), 0),
    totalP50: round(num(row["total_p50"]), 0),
    totalP95: round(num(row["total_p95"]), 0),
    totalMean: round(num(row["total_mean"]), 0),
  }));
}

// ── Cost per provider and per successful outcome ────────────────────

export interface CostRow {
  readonly provider: string;
  readonly calls: number;
  readonly costTotalUsd: number | null;
  readonly costPerCallUsd: number | null;
  readonly successes: number;
  /** `null` when there are no successes — never 0, which would read as free. */
  readonly costPerSuccessUsd: number | null;
}

/**
 * Joins `call_metrics` to `call_outcomes`, which is allowed: the rule is
 * that a statement may not see both metrics tables. `dispatch_metrics`
 * is not referenced here.
 */
export async function auditCost(campaignId: string): Promise<readonly CostRow[]> {
  const result = await query(
    `SELECT m.provider,
            count(*)::int              AS calls,
            sum(m.cost_total_usd)      AS cost_total,
            count(*) FILTER (WHERE o.succeeded IS TRUE)::int AS successes,
            sum(m.cost_total_usd) FILTER (WHERE o.succeeded IS TRUE) AS cost_of_successes
       FROM call_metrics m
       LEFT JOIN call_outcomes o ON o.call_attempt_id = m.call_attempt_id
      WHERE m.campaign_id = $1
      GROUP BY m.provider ORDER BY m.provider`,
    [campaignId],
  );

  return result.rows.map((row) => {
    const calls = int(row["calls"]);
    const costTotal = num(row["cost_total"]);
    const successes = int(row["successes"]);
    return {
      provider: String(row["provider"]),
      calls,
      costTotalUsd: round(costTotal, 6),
      costPerCallUsd: calls > 0 && costTotal !== null ? round(costTotal / calls, 6) : null,
      successes,
      // Total campaign spend divided by successes — the figure that
      // answers "what did a registration cost", which is not the same
      // as the cost of the calls that succeeded.
      costPerSuccessUsd: successes > 0 && costTotal !== null ? round(costTotal / successes, 6) : null,
    };
  });
}

// ── Why they did not register ───────────────────────────────────────

export interface NonSuccessReason {
  readonly outcomeType: string;
  readonly primaryReason: string;
  readonly count: number;
}

export async function auditNonSuccessReasons(
  campaignId: string,
): Promise<readonly NonSuccessReason[]> {
  const result = await query(
    `SELECT outcome_type, COALESCE(primary_reason, 'unset') AS primary_reason, count(*)::int AS n
       FROM call_outcomes
      WHERE campaign_id = $1 AND (succeeded IS NOT TRUE)
      GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    outcomeType: String(row["outcome_type"]),
    primaryReason: String(row["primary_reason"]),
    count: int(row["n"]),
  }));
}

// ── Which provider called each number ───────────────────────────────

export interface NumberProviderRow {
  /** Masked in SQL. An unmasked number never leaves the database layer. */
  readonly maskedPhone: string;
  readonly provider: string;
  readonly dialledAttempts: number;
  readonly lastStatus: string | null;
}

export async function auditNumbers(
  campaignId: string,
  limit = 100,
): Promise<readonly NumberProviderRow[]> {
  const result = await query(
    `SELECT left(c.normalized_phone, 7) ||
              repeat('*', greatest(length(c.normalized_phone) - 7, 0)) AS masked_phone,
            c.assigned_provider,
            count(a.id) FILTER (WHERE a.status <> 'CANCELLED')::int AS dialled,
            c.status::text AS last_status
       FROM contacts c
       LEFT JOIN call_attempts a ON a.contact_id = c.id
      WHERE c.campaign_id = $1
      GROUP BY 1, 2, 4
      ORDER BY dialled DESC, 1
      LIMIT $2`,
    [campaignId, limit],
  );
  return result.rows.map((row) => ({
    maskedPhone: String(row["masked_phone"]),
    provider: String(row["assigned_provider"]),
    dialledAttempts: int(row["dialled"]),
    lastStatus: (row["last_status"] as string | null) ?? null,
  }));
}

// ── The whole audit ─────────────────────────────────────────────────

export interface CampaignAudit {
  readonly campaignId: string;
  readonly funnel: AuditFunnel;
  readonly integrity: IntegrityReport;
  readonly stuck: StuckReport;
  readonly errors: ErrorReport;
  readonly latency: readonly LatencyRow[];
  readonly cost: readonly CostRow[];
  readonly nonSuccessReasons: readonly NonSuccessReason[];
  /** Questions this data cannot answer, named rather than left blank. */
  readonly unanswerable: readonly string[];
  readonly generatedAt: Date;
}

export interface AuditOptions {
  readonly retryMaxAttempts: number;
  readonly staleMinutes: number;
}

export async function buildCampaignAudit(
  campaignId: string,
  options: AuditOptions,
): Promise<CampaignAudit> {
  const [funnel, integrity, stuck, errors, latency, cost, nonSuccessReasons] = await Promise.all([
    auditFunnel(campaignId),
    auditIntegrity(campaignId, options.retryMaxAttempts),
    auditStuck(campaignId, options.staleMinutes),
    auditErrors(campaignId),
    auditLatency(campaignId),
    auditCost(campaignId),
    auditNonSuccessReasons(campaignId),
  ]);

  const unanswerable = [
    "Voicemail vs human answer: no answering-machine detection exists, so an answered voicemail is still counted as an answered call. The pipeline does mute the agent when a voicemail greeting matches the transcript heuristic in `voicemail-detection.ts`, which saves the script but is not a carrier verdict and decides no status.",
    "Carrier-reported busy / rejected / hangup cause: no status callback is received, so BUSY and REJECTED appear only when the Call API's own error text says so.",
    "Event-loop starvation and audio-pump warnings are logged to the process stdout by the media bridge, not to the database. Read them from the deployment's logs for the run window.",
    "Process memory growth is not recorded anywhere; take it from the host's metrics for the run window.",
  ];

  return {
    campaignId,
    funnel,
    integrity,
    stuck,
    errors,
    latency,
    cost,
    nonSuccessReasons,
    unanswerable,
    generatedAt: new Date(),
  };
}
