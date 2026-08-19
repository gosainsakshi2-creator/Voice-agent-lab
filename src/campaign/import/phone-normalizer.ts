/**
 * phone-normalizer.ts
 *
 * Phone parsing, validation and E.164 normalization, plus the masking
 * helper every log line and error message in the campaign layer uses.
 *
 * Real parsing, never string surgery. Prepending "+91" to whatever
 * digits a spreadsheet happened to contain would turn a landline, a
 * truncated number, or an already-international number into a
 * confident-looking wrong number — which at campaign scale means
 * calling strangers. `libphonenumber-js` knows India's numbering plan
 * (leading 0 trunk prefix, valid mobile prefixes, length rules) and is
 * the only thing here allowed to decide what a number is.
 */

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type PhoneNormalization =
  | { readonly ok: true; readonly e164: string; readonly country: string | undefined }
  | { readonly ok: false; readonly reason: "MISSING_PHONE" | "INVALID_PHONE"; readonly detail: string };

/**
 * Masks a phone number for display and logging: keeps enough to
 * recognise a record, hides enough that a log file is not a contact
 * list. `+919876543210` becomes `+919876******`.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return "(empty)";
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  const visible = Math.min(7, trimmed.length - 4);
  return trimmed.slice(0, visible) + "*".repeat(trimmed.length - visible);
}

/**
 * Strips the punctuation spreadsheets add without touching anything
 * that carries meaning. A leading `+` is preserved, and a leading
 * `00` international prefix is rewritten to `+` because
 * `libphonenumber-js` does not treat `00` as one on its own.
 */
function preClean(raw: string): string {
  let value = raw.trim().replace(/[\s\-(). ‐-―]/g, "");
  // Excel turns long numeric cells into scientific notation; that is
  // unrecoverable data loss, so it must be rejected rather than guessed at.
  if (/e\+?\d+$/i.test(value)) return value;
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  return value;
}

export function normalizePhone(rawValue: string | null | undefined, region: string): PhoneNormalization {
  if (rawValue === null || rawValue === undefined || rawValue.trim().length === 0) {
    return { ok: false, reason: "MISSING_PHONE", detail: "no phone number in this row" };
  }

  const cleaned = preClean(rawValue);

  if (/e\+?\d+$/i.test(cleaned)) {
    return {
      ok: false,
      reason: "INVALID_PHONE",
      detail: "value looks like Excel scientific notation — re-export the column as text",
    };
  }

  if (!/\d/.test(cleaned)) {
    return { ok: false, reason: "INVALID_PHONE", detail: "value contains no digits" };
  }

  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    parsed = parsePhoneNumberFromString(cleaned, region as CountryCode);
  } catch {
    // The library throws on an unknown region rather than returning
    // undefined; treat that as an invalid row, not a crashed import.
    return { ok: false, reason: "INVALID_PHONE", detail: `could not parse for region ${region}` };
  }

  if (!parsed) {
    return { ok: false, reason: "INVALID_PHONE", detail: "not a recognizable phone number" };
  }

  if (!parsed.isValid()) {
    return {
      ok: false,
      reason: "INVALID_PHONE",
      detail: "number is not valid for its country's numbering plan",
    };
  }

  return { ok: true, e164: parsed.number, country: parsed.country };
}
