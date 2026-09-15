/**
 * sheet-sync.repo.ts
 *
 * Persistence for "has this contact already been written to the
 * registrations sheet?".
 *
 * The idempotency guarantee lives in `claimSheetSync`'s single
 * statement, not in a read-then-write the dispatcher's lanes could
 * race. `sheet_sync`'s primary key is `(campaign_id, normalized_phone)`
 * — the same pair `contacts` is UNIQUE on — so a second presentation of
 * the same FINAL_YES is a primary-key conflict, and the conflict clause
 * refuses to reopen a row that already reached `SYNCED`. A contact can
 * therefore produce at most one sheet row for the life of the campaign,
 * however many times it is dialled, reclassified or reprocessed.
 */

import { query } from "../client";

/** Minutes a `PENDING` claim is honoured before another worker may take it over. */
const STALE_CLAIM_MINUTES = 10;

/**
 * The ceiling used when a caller supplies none.
 *
 * Deliberately large rather than the policy's own default: this file is
 * the persistence layer and must not become a second place the retry
 * budget is decided. The real number comes from
 * `getSheetSyncRetryPolicy()` and is passed in at every production call
 * site; this exists only so that an older caller keeps the effectively
 * unbounded behaviour it was written against instead of silently
 * acquiring a limit it never asked for.
 */
const UNBOUNDED_ATTEMPTS = Number.MAX_SAFE_INTEGER;

export interface SheetSyncTarget {
  readonly campaignId: string;
  readonly normalizedPhone: string;
  readonly contactId: string;
  readonly attemptId: string;
  readonly spreadsheetId: string;
}

/**
 * Takes the write slot for one contact, or reports that it is taken.
 *
 * Returns `true` only to the caller that may now append. Returns
 * `false` when the row is already `SYNCED` (the duplicate-prevention
 * case — this is the normal outcome of a re-run) or when another worker
 * holds a fresh `PENDING` claim.
 *
 * A `PENDING` claim older than `STALE_CLAIM_MINUTES` is reclaimable so
 * that a process killed between claiming and appending does not strand
 * a registration outside the sheet forever. `SYNCED` is never
 * reclaimable, under any age.
 *
 * `maxAttempts` BOUNDS the retry (roadmap §5 B5). A row that has
 * already been attempted that many times is refused here, so the retry
 * budget is enforced by the same single statement that enforces the
 * duplicate guarantee rather than by a counter somebody has to
 * remember to check. The row is left FAILED and stays visible to the
 * capture report; it is never deleted and never silently dropped.
 *
 * NOTHING ABOUT IDENTITY CHANGES. The conflict target is still
 * `(campaign_id, normalized_phone)`: a retry of the same registration
 * is the same key and is refused or reclaimed here, while the same
 * person in a different campaign is a different key and is untouched by
 * any of this.
 */
export async function claimSheetSync(
  target: SheetSyncTarget,
  maxAttempts: number = UNBOUNDED_ATTEMPTS,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO sheet_sync
       (campaign_id, normalized_phone, contact_id, call_attempt_id, spreadsheet_id, state)
     VALUES ($1,$2,$3,$4,$5,'PENDING')
     ON CONFLICT (campaign_id, normalized_phone) DO UPDATE
        SET state           = 'PENDING',
            claimed_at      = now(),
            contact_id      = EXCLUDED.contact_id,
            call_attempt_id = EXCLUDED.call_attempt_id,
            spreadsheet_id  = EXCLUDED.spreadsheet_id,
            attempts        = sheet_sync.attempts + 1,
            synced_at       = NULL
      WHERE sheet_sync.attempts < $7
        AND (sheet_sync.state = 'FAILED'
             OR (sheet_sync.state = 'PENDING'
                 AND sheet_sync.claimed_at < now() - ($6 || ' minutes')::interval))
     RETURNING 1`,
    [
      target.campaignId,
      target.normalizedPhone,
      target.contactId,
      target.attemptId,
      target.spreadsheetId,
      String(STALE_CLAIM_MINUTES),
      maxAttempts,
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

/** Marks the slot written. Terminal: no later claim can reopen it. */
export async function markSheetSynced(
  campaignId: string,
  normalizedPhone: string,
  updatedRange: string | undefined,
): Promise<void> {
  await query(
    `UPDATE sheet_sync
        SET state      = 'SYNCED',
            synced_at  = now(),
            last_error = $3
      WHERE campaign_id = $1 AND normalized_phone = $2`,
    [campaignId, normalizedPhone, updatedRange ? `appended at ${updatedRange}` : null],
  );
}

/**
 * Releases the slot after a failed write so a later run can retry it.
 * The row is kept rather than deleted: "we tried and Google said this"
 * is the only place an operator can read why a registration is missing
 * from the sheet.
 */
export async function markSheetFailed(
  campaignId: string,
  normalizedPhone: string,
  error: string,
): Promise<void> {
  await query(
    `UPDATE sheet_sync
        SET state = 'FAILED', synced_at = NULL, last_error = $3
      WHERE campaign_id = $1 AND normalized_phone = $2`,
    [campaignId, normalizedPhone, error.slice(0, 500)],
  );
}

export interface SheetContactDetail {
  readonly name: string | null;
  readonly normalizedPhone: string;
  readonly originalPhone: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The contact's sheet-facing fields, read only when a FINAL_YES is
 * actually being mirrored.
 *
 * Deliberately a separate read rather than a widening of
 * `claimContacts`: the claim query is the dispatcher's hot path and its
 * `FOR UPDATE SKIP LOCKED` semantics are load-bearing for every call
 * placed, whereas this runs at most once per registration, after the
 * call has already ended.
 */
export async function findContactForSheet(contactId: string): Promise<SheetContactDetail | undefined> {
  const result = await query<{
    name: string | null;
    normalized_phone: string;
    original_phone: string | null;
    metadata: Record<string, string> | null;
  }>(
    "SELECT name, normalized_phone, original_phone, metadata FROM contacts WHERE id = $1",
    [contactId],
  );

  const row = result.rows[0];
  if (!row) return undefined;
  return {
    name: row.name,
    normalizedPhone: row.normalized_phone,
    originalPhone: row.original_phone,
    metadata: row.metadata ?? {},
  };
}

/**
 * A confirmed registration that is NOT in the sheet, with everything
 * needed to present it to the existing writer again.
 *
 * The fields are the STORED verdict, read back verbatim. Nothing here
 * decides that this person registered — `isFinalYes` is applied to
 * these values by the reconciler, exactly as it is applied to the
 * in-memory classification after a live call, so there is one gate and
 * not two.
 */
export interface UnsyncedRegistration {
  readonly contactId: string;
  readonly normalizedPhone: string;
  readonly attemptId: string;
  /** `contacts.final_disposition`, as `dispositionFor` computed it when the call ended. */
  readonly disposition: string;
  readonly outcomeType: string;
  readonly succeeded: boolean | null;
  readonly primaryReason: string | null;
  /** `call_outcomes.detail`, so the confirmation instant survives into a retry's event. */
  readonly detail: unknown;
  /** `call_outcomes.transcript`, for the same reason. */
  readonly transcript: unknown;
  /** `NULL` when no sheet_sync row exists at all — the never-presented case. */
  readonly syncState: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * THE RECOVERY QUERY — roadmap §5 B5.
 *
 * "Which confirmed registrations are not in the sheet, and may be tried
 * again right now?" Three populations, and the first is the one no
 * previous mechanism could see at all:
 *
 *   no row       the registration was never presented to the sheet.
 *                A process that died between finalising the attempt
 *                and reaching the sync leaves exactly this, and so
 *                does every FINAL_YES recorded before the integration
 *                existed. Always eligible.
 *   FAILED       presented, and Google refused. Eligible once the
 *                backoff for its attempt count has elapsed and the
 *                attempt ceiling is not yet reached.
 *   PENDING      a claim nobody settled, i.e. a process killed holding
 *                it. Eligible on the SAME stale window `claimSheetSync`
 *                already honours, so this can never offer up a write
 *                that is genuinely still in flight.
 *
 * `SYNCED` is absent by construction: it is terminal, and a row that
 * reached it can never appear here however this is called.
 *
 * This is a SELECTOR, not a guarantee. Two dispatchers running this at
 * the same moment may both see the same row; only one of them can then
 * win `claimSheetSync`, which is the single statement that decides. The
 * split is deliberate and matches how the dispatcher claims contacts.
 */
export async function findUnsyncedRegistrations(
  campaignId: string,
  options: { maxAttempts: number; backoffMinutes: readonly number[]; limit: number },
): Promise<readonly UnsyncedRegistration[]> {
  // An empty or all-zero table means "no wait", which the array index
  // below would turn into a NULL interval. Normalised to one 0 entry.
  const backoff = options.backoffMinutes.length > 0 ? [...options.backoffMinutes] : [0];

  const result = await query<{
    contact_id: string;
    normalized_phone: string;
    call_attempt_id: string;
    final_disposition: string;
    outcome_type: string;
    succeeded: boolean | null;
    primary_reason: string | null;
    detail: unknown;
    transcript: unknown;
    state: string | null;
    attempts: number | null;
    last_error: string | null;
  }>(
    `SELECT c.id                AS contact_id,
            c.normalized_phone,
            o.call_attempt_id,
            c.final_disposition,
            o.outcome_type, o.succeeded, o.primary_reason, o.detail, o.transcript,
            s.state, s.attempts, s.last_error
       FROM contacts c
       -- The registration is on the contact's most recent attempt: a
       -- FINAL_YES contact is unclaimable by the dispatcher, so no
       -- later attempt can exist. Should that ever stop being true,
       -- isFinalYes refuses the row rather than writing the wrong one.
       JOIN LATERAL (
            SELECT o2.call_attempt_id, o2.outcome_type, o2.succeeded,
                   o2.primary_reason, o2.detail, o2.transcript
              FROM call_outcomes o2
              JOIN call_attempts a ON a.id = o2.call_attempt_id
             WHERE a.contact_id = c.id
             ORDER BY a.created_at DESC
             LIMIT 1
       ) o ON true
       LEFT JOIN sheet_sync s
              ON s.campaign_id = c.campaign_id
             AND s.normalized_phone = c.normalized_phone
      WHERE c.campaign_id = $1
        AND c.final_disposition = 'FINAL_YES'
        AND (s.state IS NULL OR s.state <> 'SYNCED')
        AND (
              s.state IS NULL
              OR (
                   s.attempts < $2
                   AND (
                         (s.state = 'FAILED'
                          AND s.claimed_at < now() - (
                                COALESCE(($3::int[])[s.attempts],
                                         ($3::int[])[array_length($3::int[], 1)],
                                         0)::text || ' minutes')::interval)
                      OR (s.state = 'PENDING'
                          AND s.claimed_at < now() - ($4 || ' minutes')::interval)
                       )
                 )
            )
      ORDER BY c.last_status_at
      LIMIT $5`,
    [campaignId, options.maxAttempts, backoff, String(STALE_CLAIM_MINUTES), options.limit],
  );

  return result.rows.map((row) => ({
    contactId: row.contact_id,
    normalizedPhone: row.normalized_phone,
    attemptId: row.call_attempt_id,
    disposition: row.final_disposition,
    outcomeType: row.outcome_type,
    succeeded: row.succeeded,
    primaryReason: row.primary_reason,
    detail: row.detail,
    transcript: row.transcript,
    syncState: row.state,
    attempts: row.attempts ?? 0,
    lastError: row.last_error,
  }));
}

/**
 * Confirmed registrations that have run out of retry budget.
 *
 * Reported rather than retried: B5 requires that an exhausted
 * registration stays durably visible instead of being discarded, and
 * this is the query an operator or a summary line reads to see them.
 */
export async function countExhaustedSheetSyncs(
  campaignId: string,
  maxAttempts: number,
): Promise<number> {
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM sheet_sync s
       JOIN contacts c ON c.campaign_id = s.campaign_id
                      AND c.normalized_phone = s.normalized_phone
      WHERE s.campaign_id = $1
        AND s.state = 'FAILED'
        AND s.attempts >= $2
        AND c.final_disposition = 'FINAL_YES'`,
    [campaignId, maxAttempts],
  );
  return result.rows[0]?.n ?? 0;
}

export interface SheetSyncCounts {
  readonly synced: number;
  readonly pending: number;
  readonly failed: number;
}

/** Operator view: how much of this campaign has reached the sheet. */
export async function countSheetSyncStates(campaignId: string): Promise<SheetSyncCounts> {
  const result = await query<{ state: string; n: number }>(
    "SELECT state, count(*)::int AS n FROM sheet_sync WHERE campaign_id = $1 GROUP BY state",
    [campaignId],
  );
  const byState = new Map(result.rows.map((row) => [row.state, row.n]));
  return {
    synced: byState.get("SYNCED") ?? 0,
    pending: byState.get("PENDING") ?? 0,
    failed: byState.get("FAILED") ?? 0,
  };
}
