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
 */
export async function claimSheetSync(target: SheetSyncTarget): Promise<boolean> {
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
      WHERE sheet_sync.state = 'FAILED'
         OR (sheet_sync.state = 'PENDING'
             AND sheet_sync.claimed_at < now() - ($6 || ' minutes')::interval)
     RETURNING 1`,
    [
      target.campaignId,
      target.normalizedPhone,
      target.contactId,
      target.attemptId,
      target.spreadsheetId,
      String(STALE_CLAIM_MINUTES),
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
