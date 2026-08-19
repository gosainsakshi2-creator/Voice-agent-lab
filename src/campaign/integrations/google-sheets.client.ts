/**
 * google-sheets.client.ts
 *
 * Appends one row to a Google Sheet as a service account.
 *
 * WHY NO SDK. `googleapis` is a ~50MB dependency that exists to cover
 * every Google API; the whole of what this integration needs is one
 * signed assertion, one token exchange and one `values.append` call.
 * The project already talks to Sarvam and Smallest AI over `fetch`
 * against their published REST APIs for the same reason (see
 * `providers/shared/http.ts`), so this follows that established
 * fallback rather than adding a dependency to the deployment.
 *
 * AUTH. Google's documented server-to-server flow: build a JWT
 * asserting "this service account wants this scope", sign it with the
 * account's RSA private key, exchange it at the token endpoint for a
 * bearer token. The key is read from configuration at call time and is
 * never logged, never included in an error message, and never leaves
 * this module.
 */

import { createSign } from "node:crypto";

import type { SheetSyncConfig } from "../config/sheet.config";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
/**
 * The narrowest scope that can append a row. `spreadsheets.readonly`
 * cannot write and `drive` would grant this account the user's whole
 * Drive, which it has no business holding.
 */
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Google issues one-hour tokens; renew early so a request never races the expiry. */
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class GoogleSheetsError extends Error {
  constructor(
    readonly stage: "token" | "append",
    readonly status: number,
    bodyText: string,
  ) {
    // Google's error bodies echo the request but never the assertion,
    // so this is safe to log. Truncated regardless.
    super(`Google Sheets ${stage} call failed: HTTP ${status} — ${bodyText.slice(0, 300)}`);
    this.name = "GoogleSheetsError";
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The signed assertion. `iat`/`exp` are seconds, and Google rejects a
 * lifetime over an hour — 3600 exactly is the documented maximum and
 * what its own client libraries send.
 */
function buildAssertion(clientEmail: string, privateKey: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64Url(signer.sign(privateKey))}`;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  /** Cache is per service account, so a credential change invalidates it. */
  readonly clientEmail: string;
}

/**
 * Process-wide, because the dispatcher runs many lanes in one process
 * and a token exchange per FINAL_YES would be a needless round trip on
 * a path that already has one.
 */
let cachedToken: CachedToken | undefined;

async function getAccessToken(config: SheetSyncConfig): Promise<string> {
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.clientEmail === config.clientEmail &&
    cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now
  ) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildAssertion(config.clientEmail, config.privateKey, now),
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new GoogleSheetsError("token", response.status, await safeReadText(response));
  }

  const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new GoogleSheetsError("token", response.status, "response carried no access_token");
  }

  const lifetimeSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  cachedToken = {
    accessToken: parsed.access_token,
    expiresAtMs: now + lifetimeSeconds * 1000,
    clientEmail: config.clientEmail,
  };
  return cachedToken.accessToken;
}

/** Where the appended row landed, e.g. `Sheet1!A7:C7`. Logged, and stored for audit. */
export interface AppendResult {
  readonly updatedRange: string | undefined;
}

/**
 * Appends one row after the last populated row of `tabName`.
 *
 * `INSERT_ROWS` rather than `OVERWRITE`: overwrite would write into a
 * row that merely looks empty to the API (a trailing formula, a
 * formatted-but-blank row), which on a registrations sheet means
 * destroying somebody's record instead of adding one.
 *
 * `RAW` rather than `USER_ENTERED`: a phone number in E.164 starts with
 * a `+`, which `USER_ENTERED` parses as a formula and Sheets then
 * renders as an error. `RAW` stores exactly the string handed over.
 */
export async function appendSheetRow(
  config: SheetSyncConfig,
  values: readonly string[],
): Promise<AppendResult> {
  const accessToken = await getAccessToken(config);
  // The tab name is user-supplied configuration and may contain spaces
  // or quotes, so it is A1-quoted before being URL-encoded.
  const range = `'${config.tabName.replace(/'/g, "''")}'!A:C`;
  const url =
    `${SHEETS_API_BASE}/${encodeURIComponent(config.spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [values] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // A 401 here almost always means the token was fine but the sheet
    // was never shared with the service account. Drop the cache so a
    // genuinely expired token is not remembered either way.
    if (response.status === 401) cachedToken = undefined;
    throw new GoogleSheetsError("append", response.status, await safeReadText(response));
  }

  const parsed = (await response.json()) as { updates?: { updatedRange?: unknown } };
  const updatedRange = parsed.updates?.updatedRange;
  return { updatedRange: typeof updatedRange === "string" ? updatedRange : undefined };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}
