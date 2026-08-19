/**
 * results.repo.ts
 *
 * Every read the results page performs.
 *
 * THE ONE RULE IN THIS FILE: no single statement here may reference
 * both `call_metrics` and `dispatch_metrics`.
 *
 * They are separate tables because a database write and a TTS
 * synthesis are separate things, and the comparison this campaign
 * exists to produce is ruined the moment a slow persist can hide
 * inside a provider's latency. Keeping them apart in the schema and
 * then joining them in a query would give exactly that result while
 * looking correct. So the voice figures and the orchestration figures
 * are fetched by different statements, kept in different structures,
 * and merged nowhere — including in the CSV export, which reads each
 * table separately and lines the rows up by attempt id in TypeScript
 * with prefixed column names.
 *
 * Aggregation happens in PostgreSQL rather than in Node: a campaign of
 * 10,000 calls should not stream 10,000 rows into a web request to
 * compute a median.
 */

import { query } from "../db/client";
import type { Percentiles } from "./results-types";

/** `pg` returns numeric/bigint as strings; this is where that stops. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  return num(value) ?? 0;
}

function percentiles(p50: unknown, p90: unknown, samples: unknown): Percentiles {
  const count = int(samples);
  return count === 0
    ? { p50: null, p90: null, samples: 0 }
    : { p50: round(num(p50)), p90: round(num(p90)), samples: count };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

// ── Attempts ──────────────────────────────────────────────────────

export interface AttemptAggregateRow {
  readonly provider: string;
  readonly attempts: number;
  readonly rehearsedNotDialled: number;
  readonly dialled: number;
  readonly connected: number;
  readonly completed: number;
  readonly noAnswer: number;
  readonly busy: number;
  readonly failed: number;
  readonly inferredTerminal: number;
  readonly connectedSeconds: Percentiles;
}

/**
 * Per-provider attempt counts.
 *
 * `dialled` excludes CANCELLED attempts: those are the rows the kill
 * switch wrote when it refused to place the call, and counting a
 * rehearsal as a dial would overstate every rate below it.
 */
export async function attemptAggregates(campaignId: string): Promise<readonly AttemptAggregateRow[]> {
  const result = await query(
    `SELECT provider,
            count(*)::int                                              AS attempts,
            count(*) FILTER (WHERE status = 'CANCELLED')::int           AS rehearsed,
            count(*) FILTER (WHERE status <> 'CANCELLED')::int          AS dialled,
            count(*) FILTER (WHERE answered_at IS NOT NULL)::int        AS connected,
            count(*) FILTER (WHERE status = 'COMPLETED')::int           AS completed,
            count(*) FILTER (WHERE status = 'NO_ANSWER')::int           AS no_answer,
            count(*) FILTER (WHERE status = 'BUSY')::int                AS busy,
            count(*) FILTER (WHERE status = 'FAILED')::int              AS failed,
            count(*) FILTER (WHERE status_source = 'inferred'
                               AND ended_at IS NOT NULL)::int           AS inferred_terminal,
            count(duration_seconds)::int                                AS duration_samples,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS duration_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_seconds) AS duration_p90
       FROM call_attempts
      WHERE campaign_id = $1
      GROUP BY provider
      ORDER BY provider`,
    [campaignId],
  );

  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    attempts: int(row["attempts"]),
    rehearsedNotDialled: int(row["rehearsed"]),
    dialled: int(row["dialled"]),
    connected: int(row["connected"]),
    completed: int(row["completed"]),
    noAnswer: int(row["no_answer"]),
    busy: int(row["busy"]),
    failed: int(row["failed"]),
    inferredTerminal: int(row["inferred_terminal"]),
    connectedSeconds: percentiles(row["duration_p50"], row["duration_p90"], row["duration_samples"]),
  }));
}

// ── Outcomes ──────────────────────────────────────────────────────

export interface OutcomeAggregateRow {
  readonly provider: string;
  readonly outcomeType: string;
  readonly succeeded: boolean | null;
  readonly count: number;
}

export async function outcomeAggregates(campaignId: string): Promise<readonly OutcomeAggregateRow[]> {
  const result = await query(
    `SELECT a.provider, o.outcome_type, o.succeeded, count(*)::int AS n
       FROM call_outcomes o
       JOIN call_attempts a ON a.id = o.call_attempt_id
      WHERE o.campaign_id = $1
      GROUP BY 1, 2, 3
      ORDER BY 1, 2`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    outcomeType: String(row["outcome_type"]),
    succeeded: row["succeeded"] === null ? null : Boolean(row["succeeded"]),
    count: int(row["n"]),
  }));
}

/** Which classifier produced the stored labels, and how many each. */
export async function classifierCounts(campaignId: string): Promise<Readonly<Record<string, number>>> {
  const result = await query(
    `SELECT COALESCE(classifier, 'unknown') AS classifier, count(*)::int AS n
       FROM call_outcomes WHERE campaign_id = $1 GROUP BY 1`,
    [campaignId],
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) counts[String(row["classifier"])] = int(row["n"]);
  return counts;
}

// ── VOICE metrics — `call_metrics` only ───────────────────────────

export interface VoiceAggregateRow {
  readonly provider: string;
  readonly calls: number;
  readonly sttMs: Percentiles;
  readonly llmMs: Percentiles;
  readonly ttsMs: Percentiles;
  readonly totalMs: Percentiles;
  readonly firstTurnTotalMs: Percentiles;
  readonly turnsPerCall: Percentiles;
  readonly conversationSeconds: Percentiles;
  readonly costTotalUsd: number | null;
  readonly costTelephonyUsd: number | null;
  readonly costSttUsd: number | null;
  readonly costLlmUsd: number | null;
  readonly costTtsUsd: number | null;
}

export async function voiceAggregates(campaignId: string): Promise<readonly VoiceAggregateRow[]> {
  const result = await query(
    `SELECT provider,
            count(*)::int AS calls,

            count(stt_p50_ms)::int AS stt_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY stt_p50_ms) AS stt_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY stt_p50_ms) AS stt_p90,

            count(llm_p50_ms)::int AS llm_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY llm_p50_ms) AS llm_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY llm_p50_ms) AS llm_p90,

            count(tts_p50_ms)::int AS tts_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY tts_p50_ms) AS tts_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY tts_p50_ms) AS tts_p90,

            count(total_p50_ms)::int AS total_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_p50_ms) AS total_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY total_p50_ms) AS total_p90,

            count(first_turn_total_ms)::int AS first_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY first_turn_total_ms) AS first_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY first_turn_total_ms) AS first_p90,

            count(turn_count)::int AS turns_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_count) AS turns_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY turn_count) AS turns_p90,

            count(conversation_seconds)::int AS secs_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY conversation_seconds) AS secs_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY conversation_seconds) AS secs_p90,

            sum(cost_total_usd)     AS cost_total,
            sum(cost_telephony_usd) AS cost_telephony,
            sum(cost_stt_usd)       AS cost_stt,
            sum(cost_llm_usd)       AS cost_llm,
            sum(cost_tts_usd)       AS cost_tts
       FROM call_metrics
      WHERE campaign_id = $1
      GROUP BY provider
      ORDER BY provider`,
    [campaignId],
  );

  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    calls: int(row["calls"]),
    sttMs: percentiles(row["stt_p50"], row["stt_p90"], row["stt_n"]),
    llmMs: percentiles(row["llm_p50"], row["llm_p90"], row["llm_n"]),
    ttsMs: percentiles(row["tts_p50"], row["tts_p90"], row["tts_n"]),
    totalMs: percentiles(row["total_p50"], row["total_p90"], row["total_n"]),
    firstTurnTotalMs: percentiles(row["first_p50"], row["first_p90"], row["first_n"]),
    turnsPerCall: percentiles(row["turns_p50"], row["turns_p90"], row["turns_n"]),
    conversationSeconds: percentiles(row["secs_p50"], row["secs_p90"], row["secs_n"]),
    costTotalUsd: round(num(row["cost_total"])),
    costTelephonyUsd: round(num(row["cost_telephony"])),
    costSttUsd: round(num(row["cost_stt"])),
    costLlmUsd: round(num(row["cost_llm"])),
    costTtsUsd: round(num(row["cost_tts"])),
  }));
}

// ── ORCHESTRATION metrics — `dispatch_metrics` only ───────────────

export interface DispatchAggregateRow {
  readonly provider: string;
  readonly calls: number;
  readonly queueWaitMs: Percentiles;
  readonly claimToDialMs: Percentiles;
  readonly dialRequestMs: Percentiles;
  readonly ringToAnswerMs: Percentiles;
  readonly persistMs: Percentiles;
  readonly classifyMs: Percentiles;
}

export async function dispatchAggregates(campaignId: string): Promise<readonly DispatchAggregateRow[]> {
  const result = await query(
    `SELECT provider,
            count(*)::int AS calls,

            count(queue_wait_ms)::int AS queue_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_wait_ms) AS queue_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY queue_wait_ms) AS queue_p90,

            count(claim_to_dial_ms)::int AS claim_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY claim_to_dial_ms) AS claim_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY claim_to_dial_ms) AS claim_p90,

            count(dial_request_ms)::int AS dial_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY dial_request_ms) AS dial_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY dial_request_ms) AS dial_p90,

            count(ring_to_answer_ms)::int AS ring_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ring_to_answer_ms) AS ring_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY ring_to_answer_ms) AS ring_p90,

            count(persist_ms)::int AS persist_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY persist_ms) AS persist_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY persist_ms) AS persist_p90,

            count(classify_ms)::int AS classify_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY classify_ms) AS classify_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY classify_ms) AS classify_p90
       FROM dispatch_metrics
      WHERE campaign_id = $1
      GROUP BY provider
      ORDER BY provider`,
    [campaignId],
  );

  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    calls: int(row["calls"]),
    queueWaitMs: percentiles(row["queue_p50"], row["queue_p90"], row["queue_n"]),
    claimToDialMs: percentiles(row["claim_p50"], row["claim_p90"], row["claim_n"]),
    dialRequestMs: percentiles(row["dial_p50"], row["dial_p90"], row["dial_n"]),
    ringToAnswerMs: percentiles(row["ring_p50"], row["ring_p90"], row["ring_n"]),
    persistMs: percentiles(row["persist_p50"], row["persist_p90"], row["persist_n"]),
    classifyMs: percentiles(row["classify_p50"], row["classify_p90"], row["classify_n"]),
  }));
}

// ── Coverage ──────────────────────────────────────────────────────

export interface CoverageCounts {
  readonly endedAttempts: number;
  readonly missingVoiceMetrics: number;
  readonly missingOutcome: number;
  readonly inferredTerminal: number;
}

/**
 * How much of the campaign the report cannot see.
 *
 * Two separate statements, one per metrics table, for the reason at
 * the top of this file — even a count must not be produced by a query
 * that has both tables in scope.
 */
export async function coverage(campaignId: string): Promise<CoverageCounts> {
  const attempts = await query(
    `SELECT count(*) FILTER (WHERE ended_at IS NOT NULL AND status <> 'CANCELLED')::int AS ended,
            count(*) FILTER (WHERE status_source = 'inferred' AND ended_at IS NOT NULL)::int AS inferred
       FROM call_attempts WHERE campaign_id = $1`,
    [campaignId],
  );

  const missingMetrics = await query(
    `SELECT count(*)::int AS n
       FROM call_attempts a
       LEFT JOIN call_metrics m ON m.call_attempt_id = a.id
      WHERE a.campaign_id = $1 AND a.answered_at IS NOT NULL AND m.call_attempt_id IS NULL`,
    [campaignId],
  );

  const missingOutcome = await query(
    `SELECT count(*)::int AS n
       FROM call_attempts a
       LEFT JOIN call_outcomes o ON o.call_attempt_id = a.id
      WHERE a.campaign_id = $1 AND a.ended_at IS NOT NULL
        AND a.status <> 'CANCELLED' AND o.call_attempt_id IS NULL`,
    [campaignId],
  );

  return {
    endedAttempts: int(attempts.rows[0]?.["ended"]),
    inferredTerminal: int(attempts.rows[0]?.["inferred"]),
    missingVoiceMetrics: int(missingMetrics.rows[0]?.["n"]),
    missingOutcome: int(missingOutcome.rows[0]?.["n"]),
  };
}

// ── CONTACT-level outcomes ────────────────────────────────────────
// A separate family of reads from everything above, and the separation
// is the point. Every aggregate before this line counts ATTEMPTS: one
// contact called three times appears three times. These count PEOPLE.
// A conversion rate computed over attempts is not a conversion rate at
// all — three registrations out of twenty attempts across ten contacts
// is 30% of the people, not 15% of anything a business cares about.

export interface ContactDispositionAggregateRow {
  readonly provider: string;
  /** NULL disposition (a contact never called, or never classified) reports as 'UNCLASSIFIED'. */
  readonly disposition: string;
  readonly contacts: number;
}

export async function contactDispositionAggregates(
  campaignId: string,
): Promise<readonly ContactDispositionAggregateRow[]> {
  const result = await query(
    `SELECT assigned_provider AS provider,
            COALESCE(final_disposition, 'UNCLASSIFIED') AS disposition,
            count(*)::int AS n
       FROM contacts
      WHERE campaign_id = $1
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    provider: String(row["provider"]),
    disposition: String(row["disposition"]),
    contacts: int(row["n"]),
  }));
}

export interface ContactStateCounts {
  readonly total: number;
  readonly callbackRequested: number;
  /** Contacts the claim query could still pick up — the same predicate, deliberately. */
  readonly stillEligible: number;
  readonly permanentlyClosed: number;
  readonly neverAttempted: number;
  readonly totalAttempts: number;
}

/**
 * Contact-level state counts.
 *
 * `stillEligible` repeats the claim query's predicate rather than
 * approximating it. A dashboard that says "4 contacts still to call"
 * while the dispatcher can only see 2 is worse than no figure, so the
 * two must be the same condition — status, disposition and all.
 */
export async function contactStateCounts(campaignId: string): Promise<ContactStateCounts> {
  const result = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE last_outcome_type = 'callback_requested')::int AS callback,
            count(*) FILTER (WHERE status IN ('PENDING','ASSIGNED')
                               AND (final_disposition IS NULL
                                    OR final_disposition NOT IN ('FINAL_YES','FINAL_NO')))::int AS eligible,
            count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed,
            count(*) FILTER (WHERE attempt_count = 0)::int AS never_attempted,
            COALESCE(sum(attempt_count), 0)::int AS total_attempts
       FROM contacts
      WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  return {
    total: int(row?.["total"]),
    callbackRequested: int(row?.["callback"]),
    stillEligible: int(row?.["eligible"]),
    permanentlyClosed: int(row?.["closed"]),
    neverAttempted: int(row?.["never_attempted"]),
    totalAttempts: int(row?.["total_attempts"]),
  };
}

/**
 * How many attempts each contact has had, as a distribution.
 *
 * The figure that makes the attempt/contact distinction visible instead
 * of merely correct: "10 contacts, 20 attempts" says nothing about
 * whether one contact was called eleven times.
 */
export async function attemptsPerContact(
  campaignId: string,
): Promise<Readonly<Record<string, number>>> {
  const result = await query(
    `SELECT attempt_count AS attempts, count(*)::int AS n
       FROM contacts WHERE campaign_id = $1
      GROUP BY 1 ORDER BY 1`,
    [campaignId],
  );
  const distribution: Record<string, number> = {};
  for (const row of result.rows) distribution[String(int(row["attempts"]))] = int(row["n"]);
  return distribution;
}

/**
 * Attempts whose transcript matched a voicemail greeting.
 *
 * Reported so the report can say out loud that an unknown number of its
 * "answered" calls were machines. This counts only the ones the phrase
 * heuristic caught; it is a floor, not a measurement, because no
 * answering-machine detection exists.
 */
export async function suspectedVoicemailAttempts(campaignId: string): Promise<number> {
  const result = await query(
    `SELECT count(*)::int AS n FROM call_outcomes
      WHERE campaign_id = $1 AND primary_reason = 'suspected_voicemail'`,
    [campaignId],
  );
  return int(result.rows[0]?.["n"]);
}

/**
 * The conversational shape of a campaign's calls.
 *
 * Read from `call_outcomes.detail`, which is JSONB and GIN-indexed
 * precisely so a field the classifier started recording is queryable
 * without a migration.
 *
 * These are ATTEMPT counts and they are deliberately kept out of every
 * rate in this file. A question is not a conversion event: a person who
 * asked four things and never decided belongs in UNRESOLVED, and the
 * only reason to count their questions is so the report can show that
 * the call was engaged rather than dead. Nothing here may ever end up
 * in a numerator over contacts.
 */
export interface ConversationEventAggregates {
  readonly attemptsRead: number;
  readonly attemptsWithQuestions: number;
  readonly customerQuestions: number;
  readonly attemptsWithObjections: number;
  readonly objections: number;
  /** Calls that ended while the person was still asking something. */
  readonly interruptedOnQuestion: number;
  readonly callbackAttempts: number;
  /** Attempts whose transcript was checked against the approved script. */
  readonly adherenceChecked: number;
  readonly scriptRestarts: number;
  readonly offScriptQuestionAttempts: number;
  readonly unsupportedFigureAttempts: number;
}

export async function conversationEventAggregates(
  campaignId: string,
): Promise<ConversationEventAggregates> {
  const result = await query(
    `SELECT count(*) FILTER (WHERE detail ? 'conversation')::int AS attempts_read,
            count(*) FILTER (WHERE (detail->'conversation'->>'customerQuestions')::int > 0)::int
              AS attempts_with_questions,
            COALESCE(sum((detail->'conversation'->>'customerQuestions')::int), 0)::int
              AS customer_questions,
            count(*) FILTER (WHERE (detail->'conversation'->>'objections')::int > 0)::int
              AS attempts_with_objections,
            COALESCE(sum((detail->'conversation'->>'objections')::int), 0)::int AS objections,
            count(*) FILTER (WHERE (detail->'conversation'->>'endedOnCustomerQuestion')::boolean)::int
              AS interrupted_on_question,
            count(*) FILTER (WHERE outcome_type = 'callback_requested')::int AS callback_attempts,
            count(*) FILTER (WHERE detail ? 'adherence')::int AS adherence_checked,
            count(*) FILTER (WHERE (detail->'adherence'->>'restartedScript')::boolean)::int
              AS script_restarts,
            count(*) FILTER (
              WHERE jsonb_array_length(COALESCE(detail->'adherence'->'offScriptQuestions', '[]'::jsonb)) > 0
            )::int AS off_script_question_attempts,
            count(*) FILTER (
              WHERE jsonb_array_length(COALESCE(detail->'adherence'->'unsupportedFigures', '[]'::jsonb)) > 0
            )::int AS unsupported_figure_attempts
       FROM call_outcomes
      WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  return {
    attemptsRead: int(row?.["attempts_read"]),
    attemptsWithQuestions: int(row?.["attempts_with_questions"]),
    customerQuestions: int(row?.["customer_questions"]),
    attemptsWithObjections: int(row?.["attempts_with_objections"]),
    objections: int(row?.["objections"]),
    interruptedOnQuestion: int(row?.["interrupted_on_question"]),
    callbackAttempts: int(row?.["callback_attempts"]),
    adherenceChecked: int(row?.["adherence_checked"]),
    scriptRestarts: int(row?.["script_restarts"]),
    offScriptQuestionAttempts: int(row?.["off_script_question_attempts"]),
    unsupportedFigureAttempts: int(row?.["unsupported_figure_attempts"]),
  };
}

export async function contactStatusCounts(
  campaignId: string,
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const result = await query(
    "SELECT status::text AS status, count(*)::int AS n FROM contacts WHERE campaign_id = $1 GROUP BY 1",
    [campaignId],
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    const n = int(row["n"]);
    byStatus[String(row["status"])] = n;
    total += n;
  }
  return { total, byStatus };
}

// ── Per-attempt listing ───────────────────────────────────────────

export interface AttemptListItem {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly customerName: string | null;
  /** Masked in SQL. An unmasked number never reaches this layer. */
  readonly maskedPhone: string;
  readonly status: string;
  readonly statusSource: string;
  readonly failureClass: string | null;
  readonly hangupReason: string | null;
  readonly durationSeconds: number | null;
  readonly dialedAt: Date | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
  readonly outcomeType: string | null;
  readonly succeeded: boolean | null;
  readonly primaryReason: string | null;
  readonly confidence: string | null;
}

export async function listAttempts(
  campaignId: string,
  limit: number,
  offset: number,
): Promise<readonly AttemptListItem[]> {
  const result = await query(
    `SELECT a.id, a.attempt_number, a.provider, a.status::text AS status, a.status_source,
            a.failure_class, a.hangup_reason, a.duration_seconds,
            a.dialed_at, a.answered_at, a.ended_at,
            c.name,
            left(c.normalized_phone, 7) ||
              repeat('*', greatest(length(c.normalized_phone) - 7, 0)) AS masked_phone,
            o.outcome_type, o.succeeded, o.primary_reason, o.detail->>'confidence' AS confidence
       FROM call_attempts a
       JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN call_outcomes o ON o.call_attempt_id = a.id
      WHERE a.campaign_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset],
  );

  return result.rows.map((row) => ({
    attemptId: String(row["id"]),
    attemptNumber: int(row["attempt_number"]),
    provider: String(row["provider"]),
    customerName: (row["name"] as string | null) ?? null,
    maskedPhone: String(row["masked_phone"]),
    status: String(row["status"]),
    statusSource: String(row["status_source"]),
    failureClass: (row["failure_class"] as string | null) ?? null,
    hangupReason: (row["hangup_reason"] as string | null) ?? null,
    durationSeconds: num(row["duration_seconds"]),
    dialedAt: (row["dialed_at"] as Date | null) ?? null,
    answeredAt: (row["answered_at"] as Date | null) ?? null,
    endedAt: (row["ended_at"] as Date | null) ?? null,
    outcomeType: (row["outcome_type"] as string | null) ?? null,
    succeeded: row["succeeded"] === null || row["succeeded"] === undefined ? null : Boolean(row["succeeded"]),
    primaryReason: (row["primary_reason"] as string | null) ?? null,
    confidence: (row["confidence"] as string | null) ?? null,
  }));
}

export async function countAttempts(campaignId: string): Promise<number> {
  const result = await query("SELECT count(*)::int AS n FROM call_attempts WHERE campaign_id = $1", [
    campaignId,
  ]);
  return int(result.rows[0]?.["n"]);
}

// ── Per-attempt metric rows for the CSV export ────────────────────
// Two functions, two statements, one table each. Merged by attempt id
// in `export-csv.ts` under prefixed column names, so a reader of the
// file can always tell which clock a number came from.

export async function voiceMetricsByAttempt(
  campaignId: string,
): Promise<ReadonlyMap<string, Record<string, number | null>>> {
  const result = await query(
    `SELECT call_attempt_id, turn_count, conversation_seconds,
            stt_p50_ms, llm_p50_ms, tts_p50_ms, total_p50_ms, first_turn_total_ms,
            cost_total_usd
       FROM call_metrics WHERE campaign_id = $1`,
    [campaignId],
  );
  const byAttempt = new Map<string, Record<string, number | null>>();
  for (const row of result.rows) {
    byAttempt.set(String(row["call_attempt_id"]), {
      turnCount: num(row["turn_count"]),
      conversationSeconds: num(row["conversation_seconds"]),
      sttP50Ms: num(row["stt_p50_ms"]),
      llmP50Ms: num(row["llm_p50_ms"]),
      ttsP50Ms: num(row["tts_p50_ms"]),
      totalP50Ms: num(row["total_p50_ms"]),
      firstTurnTotalMs: num(row["first_turn_total_ms"]),
      costTotalUsd: num(row["cost_total_usd"]),
    });
  }
  return byAttempt;
}

export async function dispatchMetricsByAttempt(
  campaignId: string,
): Promise<ReadonlyMap<string, Record<string, number | null>>> {
  const result = await query(
    `SELECT call_attempt_id, queue_wait_ms, claim_to_dial_ms, dial_request_ms,
            ring_to_answer_ms, persist_ms, classify_ms
       FROM dispatch_metrics WHERE campaign_id = $1`,
    [campaignId],
  );
  const byAttempt = new Map<string, Record<string, number | null>>();
  for (const row of result.rows) {
    byAttempt.set(String(row["call_attempt_id"]), {
      queueWaitMs: num(row["queue_wait_ms"]),
      claimToDialMs: num(row["claim_to_dial_ms"]),
      dialRequestMs: num(row["dial_request_ms"]),
      ringToAnswerMs: num(row["ring_to_answer_ms"]),
      persistMs: num(row["persist_ms"]),
      classifyMs: num(row["classify_ms"]),
    });
  }
  return byAttempt;
}
