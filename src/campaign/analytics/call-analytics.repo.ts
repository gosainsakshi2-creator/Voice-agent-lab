/**
 * call-analytics.repo.ts
 *
 * ONE query, five projections.
 *
 * `ANALYTICS_CTE` joins the tables the call runner already writes into a
 * single row per call attempt and computes, in SQL, every derived field
 * the analytics screen shows: the status category, the duration bucket,
 * the customer response, and the per-person history (previous call,
 * previous bucket, first call) via window functions over the phone
 * number. The list, the count, the summary tiles, the daily table, the
 * progression report and the CSV export all `SELECT` from that CTE with
 * the SAME filter predicate, built once by `whereClause`. That is what
 * guarantees "Response = YES" is one predicate everywhere rather than
 * four datasets that can drift.
 *
 * Read-only. No function here writes, and nothing on the call path
 * imports this module — a query that is slow or broken can make this
 * screen slow or broken and nothing else.
 *
 * The classification rules live here, in SQL, on purpose. Bucket and
 * response are filter predicates as much as they are display values,
 * so a second TypeScript copy for the table would be a second source of
 * truth. The tests run this SQL against temp tables with the production
 * column shapes instead.
 *
 * `SqlRunner` is injectable so those tests can point the same statements
 * at a session whose temp tables shadow the real ones; production uses
 * the campaign pool.
 */

import { query as poolQuery } from "../db/client";
import { fromStoredTranscript } from "../outcome/transcript";
import {
  DURATION_BUCKETS,
  CUSTOMER_RESPONSES,
  progressionBetween,
  isDurationBucket,
  isCallStatusCategory,
  isCustomerResponse,
  type BucketTransition,
  type CallAnalyticsFilters,
  type CallAnalyticsRecord,
  type CallAnalyticsSummary,
  type CallStatusCategory,
  type CustomerResponse,
  type DailyAnalyticsRow,
  type DurationBucket,
  type ProgressionReport,
  type TranscriptView,
} from "./call-analytics-types";

export interface SqlRunner {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

const defaultRunner: SqlRunner = {
  async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[]) {
    const result = await poolQuery(text, params);
    return { rows: result.rows as T[] };
  },
};

/** Header spellings the importer canonicalises to "the email column" — mirrors `contact-email.ts`. */
const EMAIL_KEYS =
  "'email','emailid','emailaddress','emailaddresses','customeremail','contactemail','useremail','leademail','primaryemail','mailid','mail'";

/**
 * The canonical row. Column comments are the definitions the UI quotes.
 *
 * Window `w` orders every call to a phone; `wa` does the same over
 * answered calls only, so `previous_duration_*` always means "the last
 * time this person actually picked up", not "the last time we dialled".
 */
const ANALYTICS_CTE = `
WITH base AS (
  SELECT
    a.id                                     AS call_id,
    a.session_id,
    a.provider_call_id,
    a.campaign_id,
    camp.name                                AS campaign_name,
    camp.campaign_type,
    a.contact_id,
    c.normalized_phone                       AS phone,
    c.name,
    e.email,
    coalesce(a.dialed_at, a.created_at)      AS started_at,
    a.answered_at,
    a.ended_at,
    a.duration_seconds::float8               AS duration_seconds,
    a.status::text                           AS call_status,
    a.status_source,
    a.attempt_number,
    a.provider                               AS tts_provider,
    a.llm_provider,
    a.stt_provider,
    a.telephony_provider,
    (a.answered_at IS NOT NULL)              AS answered,
    CASE
      WHEN a.answered_at IS NOT NULL          THEN 'ANSWERED'
      WHEN a.status::text = 'NO_ANSWER'       THEN 'NO_ANSWER'
      WHEN a.ended_at IS NULL                 THEN 'OPEN'
      ELSE                                         'NOT_CONNECTED'
    END                                      AS status_category,
    -- A bucket exists only for an answered call with a stored duration.
    CASE
      WHEN a.answered_at IS NULL OR a.duration_seconds IS NULL THEN NULL
      WHEN a.duration_seconds <= 10            THEN 'LE10'
      WHEN a.duration_seconds <= 20            THEN 'S11_20'
      WHEN a.duration_seconds <= 30            THEN 'S21_30'
      ELSE                                          'GT30'
    END                                      AS duration_bucket,
    o.outcome_type                           AS call_outcome,
    o.primary_reason,
    o.succeeded,
    o.detail->>'confidence'                  AS confidence,
    (o.transcript IS NOT NULL)               AS transcript_available,
    (o.transcript->>'turnCount')::int        AS transcript_turns,
    -- Read from the stored verdict. YES is the registrations-sheet
    -- conjunction; nothing here reads duration or sentiment.
    CASE
      WHEN a.answered_at IS NULL                                        THEN 'NOT_APPLICABLE'
      WHEN o.call_attempt_id IS NULL                                    THEN 'UNCLEAR'
      WHEN o.primary_reason = 'confirmed_at_gate' AND o.succeeded IS TRUE THEN 'YES'
      WHEN o.outcome_type IN ('declined', 'do_not_call')                THEN 'NO'
      WHEN o.outcome_type IN ('not_connected', 'no_engagement', 'wrong_number') THEN 'NOT_APPLICABLE'
      ELSE                                                                   'UNCLEAR'
    END                                      AS customer_response,
    c.final_disposition                      AS contact_disposition,
    s.state                                  AS sheet_state
  FROM call_attempts a
  JOIN contacts  c    ON c.id = a.contact_id
  JOIN campaigns camp ON camp.id = a.campaign_id
  LEFT JOIN call_outcomes o ON o.call_attempt_id = a.id
  LEFT JOIN sheet_sync    s ON s.campaign_id = a.campaign_id AND s.normalized_phone = c.normalized_phone
  LEFT JOIN LATERAL (
    SELECT m.value AS email
      FROM jsonb_each_text(c.metadata) m
     WHERE regexp_replace(lower(m.key), '[^a-z]', '', 'g') IN (${EMAIL_KEYS})
       AND m.value ~ '^[^[:space:]@]+@[^[:space:]@.]+[.][^[:space:]@]+$'
     ORDER BY array_position(ARRAY[${EMAIL_KEYS}], regexp_replace(lower(m.key), '[^a-z]', '', 'g'))
     LIMIT 1
  ) e ON true
),
history AS (
  SELECT
    b.*,
    row_number() OVER w                                    AS user_call_index,
    count(*) OVER (PARTITION BY b.phone)                   AS user_call_count,
    first_value(b.started_at) OVER w                       AS first_call_at,
    lag(b.started_at)       OVER w                         AS previous_call_at,
    lag(b.status_category)  OVER w                         AS previous_status_category,
    CASE WHEN b.duration_bucket IS NOT NULL THEN lag(b.duration_seconds) OVER wa END AS previous_duration_seconds,
    CASE WHEN b.duration_bucket IS NOT NULL THEN lag(b.duration_bucket)  OVER wa END AS previous_duration_bucket
  FROM base b
  WINDOW
    w  AS (PARTITION BY b.phone ORDER BY b.started_at, b.call_id),
    wa AS (PARTITION BY b.phone, (b.duration_bucket IS NOT NULL) ORDER BY b.started_at, b.call_id)
)
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** IANA zone names, or a fixed offset. Anything else is refused before it reaches SQL. */
const TIME_ZONE = /^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|[+-]\d{2}(?::?\d{2})?)$/;

export class AnalyticsFilterError extends Error {
  override readonly name = "AnalyticsFilterError";
}

/**
 * Turns query-string values into a validated filter object. Unknown
 * values are errors, not silently dropped — a typo in `response=` must
 * not export the whole table under a filename that says YES.
 */
export function parseFilters(params: URLSearchParams): CallAnalyticsFilters {
  const read = (key: string): string | undefined => {
    const value = params.get(key)?.trim();
    return value ? value : undefined;
  };

  const timeZone = read("tz") ?? "UTC";
  if (!TIME_ZONE.test(timeZone)) throw new AnalyticsFilterError(`Unrecognised time zone "${timeZone}".`);

  const from = read("from");
  if (from !== undefined && !ISO_DAY.test(from)) throw new AnalyticsFilterError(`"from" must be YYYY-MM-DD.`);
  const to = read("to");
  if (to !== undefined && !ISO_DAY.test(to)) throw new AnalyticsFilterError(`"to" must be YYYY-MM-DD.`);
  if (from !== undefined && to !== undefined && from > to) {
    throw new AnalyticsFilterError(`"from" (${from}) is after "to" (${to}).`);
  }

  const campaignId = read("campaignId");
  if (campaignId !== undefined && !UUID.test(campaignId)) throw new AnalyticsFilterError("campaignId must be a UUID.");

  const response = read("response");
  if (response !== undefined && !isCustomerResponse(response)) {
    throw new AnalyticsFilterError(`Unknown response "${response}". One of ${CUSTOMER_RESPONSES.join(", ")}.`);
  }
  const status = read("status");
  if (status !== undefined && !isCallStatusCategory(status)) {
    throw new AnalyticsFilterError(`Unknown status "${status}".`);
  }
  const bucket = read("bucket");
  if (bucket !== undefined && !isDurationBucket(bucket)) {
    throw new AnalyticsFilterError(`Unknown duration bucket "${bucket}". One of ${DURATION_BUCKETS.join(", ")}.`);
  }
  const outcome = read("outcome");
  if (outcome !== undefined && !/^[a-z_]{1,64}$/.test(outcome)) {
    throw new AnalyticsFilterError(`Unknown outcome "${outcome}".`);
  }
  const search = read("q")?.slice(0, 200);

  return {
    timeZone,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(campaignId !== undefined ? { campaignId } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(bucket !== undefined ? { bucket } : {}),
    ...(search !== undefined ? { search } : {}),
  };
}

/** Positional parameter collector, so every predicate is bound and none is interpolated. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * The single filter predicate. `scopeOnly` keeps the date, campaign and
 * search filters but drops bucket/response/status/outcome — the
 * progression report uses that, because "how did people move between
 * buckets" is meaningless once a bucket filter has removed the others.
 */
function whereClause(filters: CallAnalyticsFilters, params: Params, scopeOnly = false): string {
  const clauses: string[] = [];
  // Bound lazily: Postgres refuses a statement whose parameter is never
  // referenced, and the zone is only needed when a day bound is present.
  let tzParam: string | undefined;
  const tz = () => (tzParam ??= `${params.add(filters.timeZone)}::text`);

  if (filters.from !== undefined) {
    clauses.push(`h.started_at >= (${params.add(filters.from)}::date::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.to !== undefined) {
    clauses.push(`h.started_at < ((${params.add(filters.to)}::date + 1)::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.campaignId !== undefined) {
    clauses.push(`h.campaign_id = ${params.add(filters.campaignId)}::uuid`);
  }
  if (filters.search !== undefined) {
    const escaped = filters.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = params.add(`%${escaped}%`);
    clauses.push(`(h.name ILIKE ${like} OR h.phone ILIKE ${like} OR h.email ILIKE ${like})`);
  }
  if (!scopeOnly) {
    if (filters.status !== undefined) clauses.push(`h.status_category = ${params.add(filters.status)}`);
    if (filters.response !== undefined) clauses.push(`h.customer_response = ${params.add(filters.response)}`);
    if (filters.bucket !== undefined) clauses.push(`h.duration_bucket = ${params.add(filters.bucket)}`);
    if (filters.outcome !== undefined) {
      clauses.push(
        filters.outcome === "unclassified"
          ? "h.call_outcome IS NULL"
          : `h.call_outcome = ${params.add(filters.outcome)}`,
      );
    }
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

// ── Row readers ───────────────────────────────────────────────────

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  return num(value) ?? 0;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function date(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function bucketOf(value: unknown): DurationBucket | null {
  return typeof value === "string" && isDurationBucket(value) ? value : null;
}

function categoryOf(value: unknown): CallStatusCategory {
  return typeof value === "string" && isCallStatusCategory(value) ? value : "NOT_CONNECTED";
}

function responseOf(value: unknown): CustomerResponse {
  return typeof value === "string" && isCustomerResponse(value) ? value : "UNCLEAR";
}

function toRecord(row: Record<string, unknown>): CallAnalyticsRecord {
  const durationBucket = bucketOf(row["duration_bucket"]);
  const previousDurationBucket = bucketOf(row["previous_duration_bucket"]);
  const previousCategory = row["previous_status_category"];
  return {
    callId: String(row["call_id"]),
    sessionId: str(row["session_id"]),
    providerCallId: str(row["provider_call_id"]),
    campaignId: String(row["campaign_id"]),
    campaignName: String(row["campaign_name"] ?? ""),
    campaignType: String(row["campaign_type"] ?? ""),
    contactId: String(row["contact_id"]),
    phone: String(row["phone"]),
    name: str(row["name"]),
    email: str(row["email"]),
    callStartedAt: date(row["started_at"]) ?? new Date(0),
    answeredAt: date(row["answered_at"]),
    callEndedAt: date(row["ended_at"]),
    durationSeconds: num(row["duration_seconds"]),
    callStatus: String(row["call_status"]),
    statusSource: String(row["status_source"] ?? "observed"),
    statusCategory: categoryOf(row["status_category"]),
    answered: row["answered"] === true,
    durationBucket,
    customerResponse: responseOf(row["customer_response"]),
    callOutcome: str(row["call_outcome"]),
    primaryReason: str(row["primary_reason"]),
    succeeded: row["succeeded"] === null || row["succeeded"] === undefined ? null : Boolean(row["succeeded"]),
    confidence: str(row["confidence"]),
    contactDisposition: str(row["contact_disposition"]),
    registrationSheetState: str(row["sheet_state"]),
    transcriptAvailable: row["transcript_available"] === true,
    transcriptTurns: num(row["transcript_turns"]),
    attemptNumber: int(row["attempt_number"]),
    userCallIndex: int(row["user_call_index"]),
    userCallCount: int(row["user_call_count"]),
    firstCallAt: date(row["first_call_at"]) ?? (date(row["started_at"]) ?? new Date(0)),
    previousCallAt: date(row["previous_call_at"]),
    previousStatusCategory:
      typeof previousCategory === "string" && isCallStatusCategory(previousCategory) ? previousCategory : null,
    previousDurationSeconds: num(row["previous_duration_seconds"]),
    previousDurationBucket,
    progression: progressionBetween(previousDurationBucket, durationBucket),
    ttsProvider: String(row["tts_provider"] ?? ""),
    llmProvider: str(row["llm_provider"]),
    sttProvider: str(row["stt_provider"]),
    telephonyProvider: String(row["telephony_provider"] ?? ""),
  };
}

// ── Projections ───────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 200;

export async function listCallRecords(
  filters: CallAnalyticsFilters,
  limit: number,
  offset: number,
  runner: SqlRunner = defaultRunner,
): Promise<readonly CallAnalyticsRecord[]> {
  const params = new Params();
  const where = whereClause(filters, params);
  const result = await runner.query(
    `${ANALYTICS_CTE}
     SELECT h.* FROM history h
     ${where}
     ORDER BY h.started_at DESC, h.call_id DESC
     LIMIT ${params.add(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE))} OFFSET ${params.add(Math.max(offset, 0))}`,
    params.values,
  );
  return result.rows.map(toRecord);
}

export async function countCallRecords(
  filters: CallAnalyticsFilters,
  runner: SqlRunner = defaultRunner,
): Promise<number> {
  const params = new Params();
  const where = whereClause(filters, params);
  const result = await runner.query(
    `${ANALYTICS_CTE} SELECT count(*)::int AS n FROM history h ${where}`,
    params.values,
  );
  return int(result.rows[0]?.["n"]);
}

function emptyBuckets(): Record<DurationBucket, number> {
  return { LE10: 0, S11_20: 0, S21_30: 0, GT30: 0 };
}

export async function summarizeCallRecords(
  filters: CallAnalyticsFilters,
  runner: SqlRunner = defaultRunner,
): Promise<CallAnalyticsSummary> {
  const params = new Params();
  const where = whereClause(filters, params);
  const [totals, outcomes] = await Promise.all([
    runner.query(
      `${ANALYTICS_CTE}
       SELECT count(*)::int                                                   AS total,
              count(*) FILTER (WHERE h.status_category = 'ANSWERED')::int      AS answered,
              count(*) FILTER (WHERE h.status_category = 'NO_ANSWER')::int     AS no_answer,
              count(*) FILTER (WHERE h.status_category = 'NOT_CONNECTED')::int AS not_connected,
              count(*) FILTER (WHERE h.status_category = 'OPEN')::int          AS open,
              count(*) FILTER (WHERE h.duration_bucket = 'LE10')::int          AS le10,
              count(*) FILTER (WHERE h.duration_bucket = 'S11_20')::int        AS s11_20,
              count(*) FILTER (WHERE h.duration_bucket = 'S21_30')::int        AS s21_30,
              count(*) FILTER (WHERE h.duration_bucket = 'GT30')::int          AS gt30,
              count(*) FILTER (WHERE h.customer_response = 'YES')::int         AS yes,
              count(*) FILTER (WHERE h.customer_response = 'NO')::int          AS no,
              count(*) FILTER (WHERE h.customer_response = 'UNCLEAR')::int     AS unclear,
              count(*) FILTER (WHERE h.customer_response = 'NOT_APPLICABLE')::int AS not_applicable,
              count(*) FILTER (WHERE h.transcript_available)::int             AS with_transcript
         FROM history h ${where}`,
      params.values,
    ),
    runner.query(
      `${ANALYTICS_CTE}
       SELECT coalesce(h.call_outcome, 'unclassified') AS outcome, count(*)::int AS n
         FROM history h ${where}
        GROUP BY 1 ORDER BY 2 DESC`,
      params.values,
    ),
  ]);
  const t = totals.rows[0] ?? {};
  const byOutcome: Record<string, number> = {};
  for (const row of outcomes.rows) byOutcome[String(row["outcome"])] = int(row["n"]);
  return {
    total: int(t["total"]),
    answered: int(t["answered"]),
    noAnswer: int(t["no_answer"]),
    notConnected: int(t["not_connected"]),
    open: int(t["open"]),
    byBucket: { LE10: int(t["le10"]), S11_20: int(t["s11_20"]), S21_30: int(t["s21_30"]), GT30: int(t["gt30"]) },
    byResponse: {
      YES: int(t["yes"]),
      NO: int(t["no"]),
      UNCLEAR: int(t["unclear"]),
      NOT_APPLICABLE: int(t["not_applicable"]),
    },
    byOutcome,
    withTranscript: int(t["with_transcript"]),
  };
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 10 : null;
}

/** One row per calendar day (in the filter's zone) that had at least one attempt. */
export async function dailyCallAnalytics(
  filters: CallAnalyticsFilters,
  runner: SqlRunner = defaultRunner,
  limitDays = 400,
): Promise<readonly DailyAnalyticsRow[]> {
  const params = new Params();
  const where = whereClause(filters, params);
  const tz = `${params.add(filters.timeZone)}::text`;
  const result = await runner.query(
    `${ANALYTICS_CTE}
     SELECT to_char((h.started_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')      AS day,
            count(*)::int                                                       AS total,
            count(*) FILTER (WHERE h.status_category = 'ANSWERED')::int          AS answered,
            count(*) FILTER (WHERE h.status_category = 'NO_ANSWER')::int         AS no_answer,
            count(*) FILTER (WHERE h.status_category = 'NOT_CONNECTED')::int     AS not_connected,
            count(*) FILTER (WHERE h.status_category = 'OPEN')::int              AS open,
            count(*) FILTER (WHERE h.duration_bucket = 'LE10')::int              AS le10,
            count(*) FILTER (WHERE h.duration_bucket = 'S11_20')::int            AS s11_20,
            count(*) FILTER (WHERE h.duration_bucket = 'S21_30')::int            AS s21_30,
            count(*) FILTER (WHERE h.duration_bucket = 'GT30')::int              AS gt30,
            count(*) FILTER (WHERE h.customer_response = 'YES')::int             AS yes,
            count(*) FILTER (WHERE h.customer_response = 'NO')::int              AS no,
            count(*) FILTER (WHERE h.customer_response = 'UNCLEAR')::int         AS unclear
       FROM history h ${where}
      GROUP BY 1 ORDER BY 1 DESC
      LIMIT ${params.add(limitDays)}`,
    params.values,
  );
  return result.rows.map((row) => {
    const answered = int(row["answered"]);
    const total = int(row["total"]);
    const byBucket = { LE10: int(row["le10"]), S11_20: int(row["s11_20"]), S21_30: int(row["s21_30"]), GT30: int(row["gt30"]) };
    const yes = int(row["yes"]);
    const no = int(row["no"]);
    return {
      day: String(row["day"]),
      total,
      answered,
      noAnswer: int(row["no_answer"]),
      notConnected: int(row["not_connected"]),
      open: int(row["open"]),
      noAnswerRate: pct(int(row["no_answer"]), total),
      byBucket,
      bucketPct: {
        LE10: pct(byBucket.LE10, answered),
        S11_20: pct(byBucket.S11_20, answered),
        S21_30: pct(byBucket.S21_30, answered),
        GT30: pct(byBucket.GT30, answered),
      },
      yes,
      no,
      unclear: int(row["unclear"]),
      yesPct: pct(yes, answered),
      noPct: pct(no, answered),
    };
  });
}

/**
 * First answered call versus latest answered call, per phone, over the
 * SCOPE filters only (date, campaign, search). Duration movement is
 * reported as movement; the actual registrations among the same people
 * are read from the stored contact verdicts and shown beside it, never
 * derived from it.
 */
export async function progressionReport(
  filters: CallAnalyticsFilters,
  runner: SqlRunner = defaultRunner,
): Promise<ProgressionReport> {
  const params = new Params();
  const where = whereClause(filters, params, true);
  const usersCte = `
    ${ANALYTICS_CTE},
    users AS (
      SELECT h.phone,
             count(*) FILTER (WHERE h.duration_bucket IS NOT NULL)::int AS answered_calls,
             (array_agg(h.duration_bucket  ORDER BY h.started_at,      h.call_id)      FILTER (WHERE h.duration_bucket IS NOT NULL))[1] AS first_bucket,
             (array_agg(h.duration_bucket  ORDER BY h.started_at DESC, h.call_id DESC) FILTER (WHERE h.duration_bucket IS NOT NULL))[1] AS latest_bucket,
             (array_agg(h.duration_seconds ORDER BY h.started_at,      h.call_id)      FILTER (WHERE h.duration_bucket IS NOT NULL))[1] AS first_duration,
             (array_agg(h.duration_seconds ORDER BY h.started_at DESC, h.call_id DESC) FILTER (WHERE h.duration_bucket IS NOT NULL))[1] AS latest_duration,
             bool_or(h.contact_disposition = 'FINAL_YES') AS any_final_yes,
             bool_or(h.contact_disposition = 'FINAL_NO')  AS any_final_no
        FROM history h ${where}
       GROUP BY h.phone
    )`;

  const [transitions, totals] = await Promise.all([
    runner.query(
      `${usersCte}
       SELECT first_bucket, latest_bucket, count(*)::int AS users
         FROM users WHERE answered_calls >= 2
        GROUP BY 1, 2`,
      params.values,
    ),
    runner.query(
      `${usersCte}
       SELECT count(*) FILTER (WHERE answered_calls >= 2)::int                                   AS repeat_users,
              count(*) FILTER (WHERE answered_calls = 1)::int                                    AS once,
              count(*) FILTER (WHERE answered_calls >= 2 AND latest_duration > first_duration)::int AS longer,
              count(*) FILTER (WHERE answered_calls >= 2 AND latest_duration < first_duration)::int AS shorter,
              count(*) FILTER (WHERE answered_calls >= 2 AND latest_duration = first_duration)::int AS equal,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY first_duration)  FILTER (WHERE answered_calls >= 2) AS median_first,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latest_duration) FILTER (WHERE answered_calls >= 2) AS median_latest,
              count(*) FILTER (WHERE answered_calls >= 2 AND any_final_yes)::int                 AS repeat_final_yes,
              count(*) FILTER (WHERE answered_calls >= 2 AND any_final_no)::int                  AS repeat_final_no
         FROM users`,
      params.values,
    ),
  ]);

  const rows: BucketTransition[] = [];
  let movedUp = 0;
  let movedDown = 0;
  let stayed = 0;
  for (const row of transitions.rows) {
    const from = bucketOf(row["first_bucket"]);
    const to = bucketOf(row["latest_bucket"]);
    if (!from || !to) continue;
    const users = int(row["users"]);
    rows.push({ from, to, users });
    const move = progressionBetween(from, to);
    if (move?.direction === "UP") movedUp += users;
    else if (move?.direction === "DOWN") movedDown += users;
    else stayed += users;
  }
  rows.sort((a, b) => DURATION_BUCKETS.indexOf(a.from) - DURATION_BUCKETS.indexOf(b.from) || DURATION_BUCKETS.indexOf(a.to) - DURATION_BUCKETS.indexOf(b.to));

  const t = totals.rows[0] ?? {};
  return {
    usersWithRepeatAnswers: int(t["repeat_users"]),
    usersAnsweredOnce: int(t["once"]),
    transitions: rows,
    movedUp,
    movedDown,
    stayed,
    firstVsLatest: {
      latestLonger: int(t["longer"]),
      latestShorter: int(t["shorter"]),
      equal: int(t["equal"]),
      medianFirstSeconds: num(t["median_first"]),
      medianLatestSeconds: num(t["median_latest"]),
    },
    registrations: {
      repeatUsersWithFinalYes: int(t["repeat_final_yes"]),
      repeatUsersWithFinalNo: int(t["repeat_final_no"]),
    },
    note:
      "A person is a phone number. Movement is between the FIRST answered call's bucket and the LATEST answered call's bucket; " +
      "a longer call is a behavioural change, not a registration. Registrations are the stored FINAL_YES verdicts, counted separately. " +
      "Bucket, response, status and outcome filters are ignored here; date, campaign and search apply.",
  };
}

/** The transcript stored with one call, or an explicit "unavailable". Never invents one. */
export async function transcriptForCall(
  callId: string,
  runner: SqlRunner = defaultRunner,
): Promise<TranscriptView | null> {
  if (!UUID.test(callId)) return null;
  const result = await runner.query(
    `SELECT a.id, o.transcript
       FROM call_attempts a
       LEFT JOIN call_outcomes o ON o.call_attempt_id = a.id
      WHERE a.id = $1::uuid`,
    [callId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const stored = row["transcript"];
  if (stored === null || stored === undefined) {
    return { callId, available: false, turns: [], turnCount: 0, truncated: false, capturedAt: null };
  }
  const meta = stored as { turnCount?: unknown; truncated?: unknown; capturedAt?: unknown };
  return {
    callId,
    available: true,
    turns: fromStoredTranscript(stored),
    turnCount: num(meta.turnCount) ?? 0,
    truncated: meta.truncated === true,
    capturedAt: typeof meta.capturedAt === "string" ? meta.capturedAt : null,
  };
}

/** The same filtered rows with their transcripts attached, bounded, for the CSV. */
export async function exportCallRecords(
  filters: CallAnalyticsFilters,
  maxRows: number,
  runner: SqlRunner = defaultRunner,
): Promise<ReadonlyArray<{ record: CallAnalyticsRecord; transcript: unknown }>> {
  const params = new Params();
  const where = whereClause(filters, params);
  const result = await runner.query(
    `${ANALYTICS_CTE}
     SELECT h.*, o.transcript
       FROM history h
       LEFT JOIN call_outcomes o ON o.call_attempt_id = h.call_id
     ${where}
     ORDER BY h.started_at DESC, h.call_id DESC
     LIMIT ${params.add(Math.max(1, maxRows))}`,
    params.values,
  );
  return result.rows.map((row) => ({ record: toRecord(row), transcript: row["transcript"] ?? null }));
}
