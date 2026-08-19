/**
 * sheet.config.ts
 *
 * Where the registrations Google Sheet lives and which service account
 * may write to it — read from the environment, exactly like
 * `dispatch.config.ts`, and never from source.
 *
 * NOTHING HERE IS A SECRET IN THE REPOSITORY. The private key is a
 * credential: it is read from the environment at call time, is never
 * defaulted, is never logged, and does not appear in this file or in
 * `.env.local`'s committed form. `isConfigured` is deliberately the
 * only thing the rest of the code asks about — an unconfigured
 * deployment must run campaigns exactly as it did before this
 * integration existed, not fail them.
 */

import { optionalEnv } from "../../providers/shared/env";

export interface SheetSyncConfig {
  /** The spreadsheet's document id (the long token in its URL). */
  readonly spreadsheetId: string;
  /** Tab name the row is appended to. */
  readonly tabName: string;
  /** Service-account address, e.g. `campaign-writer@<project>.iam.gserviceaccount.com`. */
  readonly clientEmail: string;
  /** PEM private key for that service account. Never logged. */
  readonly privateKey: string;
  /**
   * False when any of the four above is absent. The sync then reports
   * itself as unconfigured and returns — no call, no outcome and no
   * campaign state is affected by the sheet being unavailable.
   */
  readonly isConfigured: boolean;
}

/**
 * Google hands the key out inside a downloaded JSON file. Most hosting
 * dashboards (Render included) only take flat strings, so both shapes
 * are accepted: the whole JSON blob in one variable, or the two fields
 * it contains as their own variables. The blob wins when both are set,
 * because it is the form that cannot drift out of sync with itself.
 */
interface ServiceAccountFields {
  readonly clientEmail: string;
  readonly privateKey: string;
}

function readServiceAccount(): ServiceAccountFields {
  const blob = optionalEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
  if (blob.trim().length > 0) {
    try {
      const parsed = JSON.parse(blob) as { client_email?: unknown; private_key?: unknown };
      return {
        clientEmail: typeof parsed.client_email === "string" ? parsed.client_email : "",
        privateKey: typeof parsed.private_key === "string" ? normalizePem(parsed.private_key) : "",
      };
    } catch {
      // A malformed blob is reported as "not configured" by the caller
      // rather than thrown: this module is read on a path that must not
      // be able to fail a call.
      return { clientEmail: "", privateKey: "" };
    }
  }

  return {
    clientEmail: optionalEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", ""),
    privateKey: normalizePem(optionalEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "")),
  };
}

/**
 * A PEM key survives a `.env` file or a hosting dashboard as a single
 * line with literal backslash-n between the armour and the body. Node's
 * signer needs the real newlines back. Surrounding quotes are stripped
 * for the same reason — some dashboards keep them.
 */
function normalizePem(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
}

export function getSheetSyncConfig(): SheetSyncConfig {
  const { clientEmail, privateKey } = readServiceAccount();
  const spreadsheetId = optionalEnv("CAMPAIGN_SHEET_SPREADSHEET_ID", "");
  // Google's own default first tab. Overridden when the registrations
  // tab has been renamed.
  const tabName = optionalEnv("CAMPAIGN_SHEET_TAB_NAME", "Sheet1");

  return {
    spreadsheetId,
    tabName,
    clientEmail,
    privateKey,
    isConfigured:
      spreadsheetId.length > 0 && clientEmail.length > 0 && privateKey.length > 0 && tabName.length > 0,
  };
}

/**
 * What an operator has to set, named exactly, for the "sheet sync is
 * not configured" log line. Reports which variables are MISSING; never
 * reports a value.
 */
export function missingSheetConfigKeys(config: SheetSyncConfig): readonly string[] {
  const missing: string[] = [];
  if (config.spreadsheetId.length === 0) missing.push("CAMPAIGN_SHEET_SPREADSHEET_ID");
  if (config.clientEmail.length === 0) missing.push("GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_SERVICE_ACCOUNT_EMAIL)");
  if (config.privateKey.length === 0) missing.push("GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)");
  if (config.tabName.length === 0) missing.push("CAMPAIGN_SHEET_TAB_NAME");
  return missing;
}
