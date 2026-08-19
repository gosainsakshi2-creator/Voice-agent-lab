/**
 * contact-email.ts
 *
 * Finds the imported email address for a contact.
 *
 * There is no `contacts.email` column, and this file does not add one.
 * The importer claims exactly three columns — phone, name, call type
 * (see `column-mapper.ts`) — and preserves EVERY other column of the
 * source CSV verbatim into `contacts.metadata`, keyed by the header as
 * it was written in the file. An "Email" column is therefore already
 * being carried through the import; nothing reads it yet.
 *
 * So this resolves the real key rather than assuming one. `Email`,
 * `email`, `EMAIL ID`, `Email Address`, `E-mail` and `emailId` are all
 * the same column to the importer's own canonicalisation, and that is
 * the function reused here.
 */

import { canonical } from "../import/column-mapper";

/**
 * Header spellings that ARE the email column, most specific first.
 * Ordered so a file carrying both `Email` and `Alternate Email` is read
 * as the person's own address.
 */
const EMAIL_HEADER_CANDIDATES = [
  "email",
  "emailid",
  "emailaddress",
  "emailaddresses",
  "customeremail",
  "contactemail",
  "useremail",
  "leademail",
  "primaryemail",
  "mailid",
  "mail",
];

/**
 * Deliberately permissive: this decides whether a STRING is worth
 * putting in an Email cell, not whether an address is deliverable.
 * Rejecting a valid-but-unusual address would silently drop a
 * registrant's contact detail, which is the worse error here.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/u;

export interface ResolvedEmail {
  readonly email: string;
  /** The metadata key it came from, for the log line. Never a value. */
  readonly sourceColumn: string;
}

/**
 * Resolves in three passes, narrowest first:
 *
 *   1. a header that canonically IS an email header,
 *   2. a header that canonically CONTAINS "email"/"mail" — catches
 *      `Registered Email`, `Email (optional)`, `WhatsApp Mail`,
 *   3. nothing.
 *
 * A pass only accepts a value that looks like an address, so a column
 * called `Email Verified` holding `yes` cannot be mistaken for one.
 *
 * There is deliberately no fourth pass scanning every column for an
 * address-shaped value: on a list carrying a referrer's or an agent's
 * address, that would write the wrong person's email into the sheet.
 * Returning `undefined` and leaving the cell empty is recoverable;
 * writing somebody else's address is not.
 */
export function resolveContactEmail(
  metadata: Readonly<Record<string, string>>,
): ResolvedEmail | undefined {
  const entries = Object.entries(metadata).filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0,
  );
  if (entries.length === 0) return undefined;

  const byCanonical = new Map(entries.map(([key, value]) => [canonical(key), { key, value }]));

  for (const candidate of EMAIL_HEADER_CANDIDATES) {
    const hit = byCanonical.get(candidate);
    if (hit && LOOKS_LIKE_EMAIL.test(hit.value.trim())) {
      return { email: hit.value.trim(), sourceColumn: hit.key };
    }
  }

  for (const [key, value] of entries) {
    const canonicalKey = canonical(key);
    if (!canonicalKey.includes("email") && !canonicalKey.includes("mail")) continue;
    const trimmed = value.trim();
    if (LOOKS_LIKE_EMAIL.test(trimmed)) return { email: trimmed, sourceColumn: key };
  }

  return undefined;
}
