/**
 * validator.ts
 *
 * Turns parsed CSV rows into a validation result: which rows are
 * usable, which are not, and — in words a person can act on — why.
 *
 * Nothing here writes to the database. Validation is deliberately a
 * separate step so the operator sees exactly what will be imported
 * before anything is committed, and so a bad column mapping is caught
 * while it is still free to fix.
 *
 * Phone numbers never leave this module unmasked except on the valid
 * path, where they are needed. Every rejection message is built from
 * `maskPhone`, so the validation report and any log line derived from
 * it are safe to share.
 */

import type { CsvRow } from "./csv-parser";
import type { ColumnMapping } from "./column-mapper";
import { metadataColumnsFor } from "./column-mapper";
import { maskPhone, normalizePhone } from "./phone-normalizer";
import type {
  RejectedRow,
  ValidatedRow,
  ValidationResult,
  ValidationSummary,
} from "../domain/campaign-types";

export interface ValidationOptions {
  readonly headers: readonly string[];
  readonly mapping: ColumnMapping;
  readonly region: string;
  /** Set when the selected campaign script interpolates the contact's name. */
  readonly requireName: boolean;
}

/** Row numbers are 1-based data rows — row 1 is the first line under the header. */
export function validateRows(rows: readonly CsvRow[], options: ValidationOptions): ValidationResult {
  const { mapping, region, requireName, headers } = options;
  const metadataColumns = metadataColumnsFor(headers, mapping);

  const valid: ValidatedRow[] = [];
  const rejected: RejectedRow[] = [];
  /** normalized phone -> the row that claimed it first. */
  const seen = new Map<string, number>();

  let emptyPhoneRows = 0;
  let malformedPhoneRows = 0;
  let duplicateRowsInFile = 0;
  let missingNameRows = 0;
  let emptyRows = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;

    // A trailing blank line, or a row of stray commas, is noise rather
    // than a data error — counted separately so it does not inflate
    // the invalid figure the operator has to investigate.
    if (Object.values(row).every((value) => value.trim().length === 0)) {
      emptyRows += 1;
      rejected.push({
        rowNumber,
        reason: "EMPTY_ROW",
        message: "Row is blank.",
        maskedPhone: null,
      });
      return;
    }

    const rawPhone = row[mapping.phone] ?? "";
    const normalization = normalizePhone(rawPhone, region);

    if (!normalization.ok) {
      if (normalization.reason === "MISSING_PHONE") {
        emptyPhoneRows += 1;
        rejected.push({
          rowNumber,
          reason: "MISSING_PHONE",
          message: `No phone number in column "${mapping.phone}".`,
          maskedPhone: null,
        });
      } else {
        malformedPhoneRows += 1;
        rejected.push({
          rowNumber,
          reason: "INVALID_PHONE",
          message: `Not a valid number for region ${region} — ${normalization.detail}.`,
          maskedPhone: maskPhone(rawPhone),
        });
      }
      return;
    }

    const firstSeenAt = seen.get(normalization.e164);
    if (firstSeenAt !== undefined) {
      duplicateRowsInFile += 1;
      rejected.push({
        rowNumber,
        reason: "DUPLICATE_IN_FILE",
        message: `Same number as row ${firstSeenAt}; only the first is imported.`,
        maskedPhone: maskPhone(normalization.e164),
        duplicateOfRow: firstSeenAt,
      });
      return;
    }

    const name = mapping.name ? (row[mapping.name] ?? "").trim() : "";
    if (requireName && name.length === 0) {
      missingNameRows += 1;
      rejected.push({
        rowNumber,
        reason: "MISSING_REQUIRED_NAME",
        message: "This campaign's script uses the contact's name, and this row has none.",
        maskedPhone: maskPhone(normalization.e164),
      });
      return;
    }

    // Every column the mapping did not claim is carried through
    // verbatim, so nothing in the source file is silently discarded.
    const metadata: Record<string, string> = {};
    for (const column of metadataColumns) {
      const value = row[column];
      if (value !== undefined && value.length > 0) metadata[column] = value;
    }

    seen.set(normalization.e164, rowNumber);
    valid.push({
      rowNumber,
      name: name.length > 0 ? name : null,
      originalPhone: rawPhone.trim(),
      normalizedPhone: normalization.e164,
      callType: mapping.callType ? (row[mapping.callType] ?? "").trim() || null : null,
      metadata,
    });
  });

  const summary: ValidationSummary = {
    totalRows: rows.length,
    validRows: valid.length,
    invalidRows: emptyPhoneRows + malformedPhoneRows + missingNameRows + emptyRows,
    duplicateRowsInFile,
    emptyPhoneRows,
    malformedPhoneRows,
    missingNameRows,
    emptyRows,
  };

  return { summary, valid, rejected };
}
