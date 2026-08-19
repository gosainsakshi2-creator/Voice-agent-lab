/**
 * contact.repo.ts
 *
 * Contact persistence. The insert leans on the Phase 1 constraints
 * rather than duplicating them in TypeScript: duplicates are resolved
 * by `ON CONFLICT`, and the provider a row is created with is the
 * provider it keeps, because the database refuses to change it.
 */

import type { PoolClient } from "pg";

import { query } from "../client";
import type { CampaignTtsProvider } from "../../domain/campaign-types";

export interface InsertableContact {
  readonly name: string | null;
  readonly normalizedPhone: string;
  readonly originalPhone: string;
  readonly callType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly csvRowNumber: number;
  readonly assignedProvider: CampaignTtsProvider;
}

export interface BulkInsertResult {
  readonly inserted: number;
  /** Rows already present in this campaign — skipped, never duplicated, never reassigned. */
  readonly skippedExisting: number;
}

/**
 * Inserts contacts in batches inside the caller's transaction.
 *
 * `ON CONFLICT (campaign_id, normalized_phone) DO NOTHING` is what
 * makes a re-uploaded CSV, a double-submitted form, and two
 * simultaneous imports all safe: the unique constraint arbitrates, and
 * a number already in the campaign keeps the provider it was first
 * assigned. `RETURNING id` reports only the rows that were genuinely
 * created, so the skipped count is measured rather than assumed.
 *
 * Batched because a single statement with 10,000 rows would exceed
 * PostgreSQL's 65,535 bound-parameter limit at seven parameters each.
 */
const PARAMS_PER_ROW = 7;
const MAX_ROWS_PER_STATEMENT = Math.floor(65_000 / PARAMS_PER_ROW); // ~9,285

export async function bulkInsertContacts(
  client: PoolClient,
  campaignId: string,
  contacts: readonly InsertableContact[],
): Promise<BulkInsertResult> {
  let inserted = 0;

  for (let offset = 0; offset < contacts.length; offset += MAX_ROWS_PER_STATEMENT) {
    const batch = contacts.slice(offset, offset + MAX_ROWS_PER_STATEMENT);
    const values: unknown[] = [campaignId];
    const tuples: string[] = [];

    for (const contact of batch) {
      const base = values.length;
      values.push(
        contact.name,
        contact.normalizedPhone,
        contact.originalPhone,
        contact.callType,
        JSON.stringify(contact.metadata),
        contact.csvRowNumber,
        contact.assignedProvider,
      );
      tuples.push(
        `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`,
      );
    }

    const result = await client.query<{ id: string }>(
      `INSERT INTO contacts
         (campaign_id, name, normalized_phone, original_phone, call_type,
          metadata, csv_row_number, assigned_provider)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (campaign_id, normalized_phone) DO NOTHING
       RETURNING id`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }

  return { inserted, skippedExisting: contacts.length - inserted };
}

/** Per-provider totals, used by preflight and by incremental allocation. */
export async function countContactsByProvider(
  campaignId: string,
  client?: PoolClient,
): Promise<ReadonlyMap<CampaignTtsProvider, number>> {
  const sql = `SELECT assigned_provider, count(*)::int AS n
                 FROM contacts WHERE campaign_id = $1
                GROUP BY assigned_provider`;
  const result = client
    ? await client.query<{ assigned_provider: string; n: number }>(sql, [campaignId])
    : await query<{ assigned_provider: string; n: number }>(sql, [campaignId]);

  const counts = new Map<CampaignTtsProvider, number>();
  for (const row of result.rows) counts.set(row.assigned_provider as CampaignTtsProvider, row.n);
  return counts;
}

export async function countContacts(campaignId: string): Promise<number> {
  const result = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM contacts WHERE campaign_id = $1",
    [campaignId],
  );
  return result.rows[0]?.n ?? 0;
}

export interface ContactListItem {
  readonly id: string;
  readonly name: string | null;
  readonly normalizedPhone: string;
  readonly callType: string | null;
  readonly assignedProvider: string;
  readonly status: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly csvRowNumber: number | null;
}

export async function listContacts(
  campaignId: string,
  limit: number,
  offset: number,
): Promise<readonly ContactListItem[]> {
  const result = await query<{
    id: string;
    name: string | null;
    normalized_phone: string;
    call_type: string | null;
    assigned_provider: string;
    status: string;
    metadata: Record<string, string>;
    csv_row_number: number | null;
  }>(
    `SELECT id, name, normalized_phone, call_type, assigned_provider, status, metadata, csv_row_number
       FROM contacts WHERE campaign_id = $1
      ORDER BY csv_row_number NULLS LAST, normalized_phone
      LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    normalizedPhone: row.normalized_phone,
    callType: row.call_type,
    assignedProvider: row.assigned_provider,
    status: row.status,
    metadata: row.metadata,
    csvRowNumber: row.csv_row_number,
  }));
}

/** Contacts with no name — a blocker when the script speaks the name. */
export async function countContactsMissingName(campaignId: string): Promise<number> {
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts
      WHERE campaign_id = $1 AND (name IS NULL OR btrim(name) = '')`,
    [campaignId],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * A few contacts for the preflight preview. Phone numbers are masked
 * in SQL so an unmasked number never reaches the API layer at all.
 */
export async function previewContacts(
  campaignId: string,
  limit = 5,
): Promise<ReadonlyArray<{ name: string | null; maskedPhone: string; assignedProvider: string }>> {
  const result = await query<{ name: string | null; masked_phone: string; assigned_provider: string }>(
    `SELECT name,
            left(normalized_phone, 7) || repeat('*', greatest(length(normalized_phone) - 7, 0)) AS masked_phone,
            assigned_provider
       FROM contacts WHERE campaign_id = $1
      ORDER BY csv_row_number NULLS LAST, normalized_phone
      LIMIT $2`,
    [campaignId, limit],
  );
  return result.rows.map((row) => ({
    name: row.name,
    maskedPhone: row.masked_phone,
    assignedProvider: row.assigned_provider,
  }));
}
