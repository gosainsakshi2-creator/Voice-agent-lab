/**
 * importer.ts
 *
 * Orchestrates parse → map → validate → allocate → persist.
 *
 * Two modes on purpose. `dryRun` performs every step except the
 * write, so the operator sees the exact counts, the exact rejections
 * and the exact provider split before committing — and a wrong column
 * mapping costs nothing. A commit repeats the work and writes it in a
 * single transaction.
 *
 * NOTHING HERE DIALS. No telephony, TTS, STT or LLM provider is
 * imported by this module or anything it calls.
 */

import { Readable } from "node:stream";

import { withTransaction } from "../db/client";
import { setCampaignStatus, setTotalContacts } from "../db/repositories/campaign.repo";
import {
  bulkInsertContacts,
  countContactsByProvider,
  type InsertableContact,
} from "../db/repositories/contact.repo";
import { getDefaultPhoneRegion } from "../config/campaign.config";
import { assignProviders, validateAllocation } from "./provider-allocator";
import { parseCsvStream, type ParsedCsv } from "./csv-parser";
import { resolveMapping, suggestMapping, type ColumnMapping } from "./column-mapper";
import { validateRows } from "./validator";
import type {
  CampaignRecord,
  CampaignTtsProvider,
  ValidationResult,
} from "../domain/campaign-types";
import { getCsvImportLimits } from "../config/campaign.config";

export interface ImportRequest {
  readonly campaign: CampaignRecord;
  readonly csv: Readable;
  readonly mapping: Partial<ColumnMapping>;
  readonly requireName: boolean;
  readonly dryRun: boolean;
  /** Overrides the environment default; falls back to it when absent. */
  readonly region?: string;
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly headers: readonly string[];
  readonly mapping: ColumnMapping;
  readonly metadataColumns: readonly string[];
  readonly region: string;
  readonly truncated: boolean;
  readonly validation: ValidationResult;
  /** Provider split of the rows this import would create (or did). */
  readonly plannedAllocation: Readonly<Record<string, number>>;
  /** Populated on a committed import only. */
  readonly persisted?: {
    readonly inserted: number;
    readonly skippedAlreadyInCampaign: number;
    readonly totalContactsInCampaign: number;
    readonly allocationInCampaign: Readonly<Record<string, number>>;
  };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

function mapToObject(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()]);
}

export async function runImport(request: ImportRequest): Promise<ImportReport> {
  const { campaign, dryRun, requireName } = request;
  const region = (request.region ?? getDefaultPhoneRegion()).toUpperCase();

  // Refuse to import into a campaign that is past preparation. A
  // campaign that has started must not have its contact list change
  // underneath the dispatcher.
  if (campaign.status !== "DRAFT" && campaign.status !== "READY" && campaign.status !== "IMPORTING") {
    throw new ImportError(
      `Campaign is ${campaign.status}. Contacts can only be imported while it is DRAFT or READY.`,
    );
  }

  validateAllocation(campaign.providerAllocation);

  const parsed: ParsedCsv = await parseCsvStream(request.csv);
  const mapping = resolveMapping(parsed.headers, request.mapping);
  const suggestion = suggestMapping(parsed.headers);

  const validation = validateRows(parsed.rows, {
    headers: parsed.headers,
    mapping,
    region,
    requireName,
  });

  // Allocation is computed against what the campaign already holds, so
  // a second import steers the totals back toward the configured split
  // instead of re-applying the percentages to the new rows alone.
  const existingByProvider = dryRun
    ? await countContactsByProvider(campaign.id)
    : new Map<CampaignTtsProvider, number>();

  const assignments = assignProviders(
    validation.valid,
    campaign.providerAllocation,
    dryRun ? existingByProvider : new Map(),
  );

  const plannedAllocation: Record<string, number> = {};
  for (const provider of assignments.values()) {
    plannedAllocation[provider] = (plannedAllocation[provider] ?? 0) + 1;
  }

  const baseReport: Omit<ImportReport, "persisted"> = {
    dryRun,
    headers: parsed.headers,
    mapping,
    metadataColumns: suggestion.metadataColumns.filter(
      (column) => column !== mapping.phone && column !== mapping.name && column !== mapping.callType,
    ),
    region,
    truncated: parsed.truncated,
    validation,
    plannedAllocation,
  };

  if (dryRun) return baseReport;

  if (validation.valid.length === 0) {
    throw new ImportError(
      "No valid rows to import. Check the column mapping and the rejected-row reasons.",
    );
  }

  const limits = getCsvImportLimits();
  if (validation.valid.length > limits.maxRows) {
    throw new ImportError(`Too many rows: ${validation.valid.length} exceeds the ${limits.maxRows} limit.`);
  }

  // ── The whole write is one transaction ─────────────────────────
  // Status, contacts and total all commit together or not at all, so a
  // failure can never leave a campaign marked READY with half a list.
  const persisted = await withTransaction(async (client) => {
    await setCampaignStatus(client, campaign.id, "IMPORTING");

    // Re-read inside the transaction: the counts used for allocation
    // must be the ones that hold at write time, not at request time.
    const priorCounts = await countContactsByProvider(campaign.id, client);
    const finalAssignments = assignProviders(
      validation.valid,
      campaign.providerAllocation,
      priorCounts,
    );

    const rows: InsertableContact[] = validation.valid.map((row) => {
      const provider = finalAssignments.get(row.normalizedPhone);
      if (!provider) {
        throw new ImportError(`Contact on row ${row.rowNumber} was not assigned a provider.`);
      }
      return {
        name: row.name,
        normalizedPhone: row.normalizedPhone,
        originalPhone: row.originalPhone,
        callType: row.callType,
        metadata: row.metadata,
        csvRowNumber: row.rowNumber,
        assignedProvider: provider,
      };
    });

    const result = await bulkInsertContacts(client, campaign.id, rows);

    const totalResult = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM contacts WHERE campaign_id = $1",
      [campaign.id],
    );
    const total = totalResult.rows[0]?.n ?? 0;

    await setTotalContacts(client, campaign.id, total);
    await setCampaignStatus(client, campaign.id, "READY");

    await client.query(
      `INSERT INTO campaign_events (campaign_id, level, code, message, data)
       VALUES ($1, 'info', 'CONTACTS_IMPORTED', $2, $3::jsonb)`,
      [
        campaign.id,
        `Imported ${result.inserted} contact(s); ${result.skippedExisting} already present.`,
        JSON.stringify({
          totalRows: validation.summary.totalRows,
          validRows: validation.summary.validRows,
          invalidRows: validation.summary.invalidRows,
          duplicateRowsInFile: validation.summary.duplicateRowsInFile,
          inserted: result.inserted,
          skippedExisting: result.skippedExisting,
          region,
        }),
      ],
    );

    const allocationInCampaign = await countContactsByProvider(campaign.id, client);

    return {
      inserted: result.inserted,
      skippedAlreadyInCampaign: result.skippedExisting,
      totalContactsInCampaign: total,
      allocationInCampaign: mapToObject(allocationInCampaign),
    };
  });

  return { ...baseReport, persisted };
}
