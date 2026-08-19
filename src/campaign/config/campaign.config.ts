/**
 * campaign.config.ts
 *
 * Every campaign-layer limit, read from the environment through the
 * project's existing `providers/shared/env` helpers so a missing or
 * malformed value fails the same way it does everywhere else.
 *
 * Nothing here is a provider capability figure. Concurrency and CPS
 * belong to the dispatcher phase and are deliberately absent: the
 * real Vobiz, Deepgram, OpenAI and TTS limits have not been confirmed
 * yet, and inventing defaults for them here would make them look
 * settled.
 */

import { optionalEnv, optionalEnvNumber } from "../../providers/shared/env";

export interface CsvImportLimits {
  /** Hard ceiling on an uploaded file, checked before a byte is parsed. */
  readonly maxFileBytes: number;
  /** Ceiling on parsed data rows, so a small but pathological file cannot exhaust memory. */
  readonly maxRows: number;
  /** Rows returned in the validation preview. The counts are always complete; only the listing is capped. */
  readonly maxPreviewRows: number;
  /** Accepted upload content types and extensions. */
  readonly allowedExtensions: readonly string[];
  readonly allowedMimeTypes: readonly string[];
}

export function getCsvImportLimits(): CsvImportLimits {
  return {
    maxFileBytes: optionalEnvNumber("CAMPAIGN_CSV_MAX_BYTES", 10 * 1024 * 1024),
    maxRows: optionalEnvNumber("CAMPAIGN_CSV_MAX_ROWS", 50_000),
    maxPreviewRows: optionalEnvNumber("CAMPAIGN_CSV_MAX_PREVIEW_ROWS", 100),
    allowedExtensions: [".csv"],
    allowedMimeTypes: [
      "text/csv",
      "application/csv",
      "text/plain",
      "application/vnd.ms-excel",
      // Browsers frequently send an empty or generic type for a
      // drag-and-dropped file; the extension check still applies.
      "application/octet-stream",
      "",
    ],
  };
}

/** Default region used to interpret a national-format phone number. */
export function getDefaultPhoneRegion(): string {
  return optionalEnv("CAMPAIGN_DEFAULT_REGION", "IN").toUpperCase();
}

/**
 * Master switch for placing real calls. Dialing does not exist yet —
 * this is declared now so the flag is already in place, defaulted
 * off, before any code that could dial is written.
 */
export function isDialingEnabled(): boolean {
  return optionalEnv("CAMPAIGN_DIALING_ENABLED", "false") === "true";
}
