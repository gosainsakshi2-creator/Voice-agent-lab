/**
 * csv-parser.ts
 *
 * Streaming CSV parsing with the header list surfaced separately, so
 * the platform can offer column mapping instead of assuming a layout.
 *
 * Streamed rather than read whole: the size ceiling below is a policy
 * limit, not a memory guarantee, and a streaming parser means the
 * ceiling can be raised later without the import turning into a
 * multi-hundred-megabyte allocation.
 */

import { Readable } from "node:stream";
import { parse } from "csv-parse";

import { getCsvImportLimits } from "../config/campaign.config";

export type CsvRow = Readonly<Record<string, string>>;

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
  /** True when parsing stopped at `maxRows`; the UI must say so rather than imply a complete import. */
  readonly truncated: boolean;
}

export class CsvImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "FILE_TOO_LARGE"
      | "UNSUPPORTED_TYPE"
      | "EMPTY_FILE"
      | "NO_HEADERS"
      | "MALFORMED_CSV",
  ) {
    super(message);
    this.name = "CsvImportError";
  }
}

/**
 * Rejects anything that is not a CSV before a byte is parsed.
 *
 * The filename is used for its extension only and never for a path:
 * `basename` strips any directory component a crafted upload might
 * carry, and nothing here ever writes the file to disk, so an
 * uploaded name cannot escape anywhere.
 */
export function assertUploadAcceptable(file: { name: string; size: number; type: string }): void {
  const limits = getCsvImportLimits();

  if (file.size === 0) {
    throw new CsvImportError("The uploaded file is empty.", "EMPTY_FILE");
  }
  if (file.size > limits.maxFileBytes) {
    const mb = (limits.maxFileBytes / (1024 * 1024)).toFixed(0);
    throw new CsvImportError(
      `File is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${mb} MB — split the list and import it in parts.`,
      "FILE_TOO_LARGE",
    );
  }

  const safeName = file.name.replace(/^.*[\\/]/, "");
  const extension = safeName.slice(safeName.lastIndexOf(".")).toLowerCase();
  const extensionOk = limits.allowedExtensions.includes(extension);
  const mimeOk = limits.allowedMimeTypes.includes(file.type.toLowerCase().split(";")[0] ?? "");

  if (!extensionOk || !mimeOk) {
    throw new CsvImportError(
      `Only .csv files are accepted. Received "${safeName}" (${file.type || "unknown type"}).`,
      "UNSUPPORTED_TYPE",
    );
  }
}

/**
 * Parses a CSV stream into rows keyed by header name.
 *
 * `relax_column_count` keeps a ragged row from aborting the whole
 * import — a single bad line in a 2,000-row list should be reported
 * as one rejected row, not lose the other 1,999. Missing cells arrive
 * as undefined and are normalised to "" so downstream code never has
 * to guard for it.
 */
export async function parseCsvStream(stream: Readable): Promise<ParsedCsv> {
  const limits = getCsvImportLimits();

  let headers: readonly string[] = [];
  const rows: CsvRow[] = [];
  let truncated = false;

  const parser = stream.pipe(
    parse({
      bom: true,
      columns: (header: string[]) => {
        headers = header.map((h) => h.trim());
        return headers as string[];
      },
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }),
  );

  try {
    for await (const record of parser) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        parser.destroy();
        break;
      }
      const raw = record as Record<string, string | undefined>;
      const row: Record<string, string> = {};
      for (const header of headers) row[header] = (raw[header] ?? "").trim();
      rows.push(row);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CsvImportError(`Could not read the CSV: ${message}`, "MALFORMED_CSV");
  }

  if (headers.length === 0) {
    throw new CsvImportError("The file has no header row.", "NO_HEADERS");
  }

  return { headers, rows, truncated };
}

/** Convenience wrapper for a Web `File` as delivered by `FormData`. */
export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  assertUploadAcceptable({ name: file.name, size: file.size, type: file.type });
  const nodeStream = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]);
  return parseCsvStream(nodeStream);
}

/** Parse an in-memory CSV string. Used by the tests. */
export async function parseCsvText(text: string): Promise<ParsedCsv> {
  return parseCsvStream(Readable.from([text]));
}
