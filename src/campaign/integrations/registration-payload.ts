/**
 * registration-payload.ts
 *
 * WHAT A CONFIRMED REGISTRATION IS — roadmap §5 B2.
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * The registration used to be an anonymous three-element array built
 * inline at the moment of the write:
 *
 *     const values = [name, email, phone];
 *
 * That is the SHEET'S row, not the registration. B2 asks for the
 * canonical payload — "name, phone, email, campaign/context, and any
 * required metadata" — and the distinction matters because the sheet
 * carries three of those fields and the rest have to live somewhere a
 * reader can still find them. So the payload is named here, in full,
 * and the sheet row is one deliberately lossy PROJECTION of it
 * (`sheetRowFor`).
 *
 * ── THE SHEET CONTRACT IS UNCHANGED ──────────────────────────────
 *
 * `sheetRowFor` produces exactly the three cells, in exactly the order,
 * with exactly the trimming, that `final-yes-sheet.ts` produced before
 * this file existed. No column is added, none is reordered, and the
 * `A:C` range in `google-sheets.client.ts` is untouched. Adding a
 * column to a live spreadsheet that people already read is a business
 * decision, not a refactor, and it has not been taken.
 *
 * The context fields therefore reach an operator through the
 * architecture that already carries them: `campaignId` / `attemptId` /
 * `contactId` are on every `REGISTRATION_SYNCED` event
 * (`registration-timing.ts`), and everything derived from them —
 * campaign name, script id and version, call timings, the transcript —
 * is one join away in the database. A copy in a spreadsheet cell would
 * be a second, staler source of the same facts.
 *
 * ── IMPORTED, NOT COLLECTED ──────────────────────────────────────
 *
 * Every field that reaches the sheet comes from the CONTACT RECORD the
 * CSV import wrote, read back out of the database at write time. None
 * of it comes from the conversation:
 *
 *     name     contacts.name              imported
 *     email    contacts.metadata          imported (see contact-email.ts)
 *     phone    contacts.normalized_phone  imported, then normalised
 *
 * This is enforced by the shape of the input rather than by a rule: the
 * builder is handed the stored contact and the call's identifiers, and
 * there is no parameter through which a transcript, an LLM output or
 * anything the caller said could reach a cell. The one thing the CALL
 * contributes to a registration is the fact that it happened and when —
 * `confirmedAt` — and that is carried on the event, not in the sheet.
 *
 * The call therefore cannot overwrite an imported detail. If a person
 * gives a different email on the phone, today's system does not capture
 * it anywhere, and this file does not pretend otherwise — see the
 * Phase 2 audit's B3 finding.
 */

import type { SheetContactDetail } from "../db/repositories/sheet-sync.repo";
import { resolveContactEmail } from "./contact-email";

/**
 * The sheet's columns, in order, as a named contract.
 *
 * Stated so that changing the row means changing a constant somebody
 * has to read, rather than editing an array literal in the middle of a
 * write. The length is asserted against `sheetRowFor` in the tests, and
 * `google-sheets.client.ts` appends to `A:C` — three columns, and these
 * are them.
 */
export const SHEET_COLUMNS = ["Name", "Email", "Phone"] as const;

/** Where a payload field came from. Recorded because B3 turns on the distinction. */
export type RegistrationFieldSource =
  /** Written by the CSV import and only ever read here. */
  | "imported"
  /** Established by the call itself. Never reaches the sheet. */
  | "call";

export const REGISTRATION_FIELD_SOURCES: Readonly<Record<string, RegistrationFieldSource>> = {
  name: "imported",
  email: "imported",
  phone: "imported",
  campaignId: "call",
  contactId: "call",
  attemptId: "call",
};

/**
 * The canonical registration.
 *
 * Complete in the roadmap's terms; the sheet takes three fields of it
 * and the event takes the rest.
 */
export interface RegistrationPayload {
  // ── The person. Imported, never collected. ───────────────────────
  /** `contacts.name`, trimmed. Empty string when the import carried none. */
  readonly name: string;
  /** The resolved address from `contacts.metadata`. Empty string when there was none. */
  readonly email: string;
  /** `contacts.normalized_phone`, E.164. The identity this schema uses. */
  readonly phone: string;

  // ── Context. Reaches the operator through the event and the DB. ──
  readonly campaignId: string;
  readonly contactId: string;
  readonly attemptId: string;

  // ── Metadata about the payload itself, for the log line and the
  //    event. Never a cell.
  /**
   * Which metadata key the address was read from, e.g. `"Email ID"`.
   * `undefined` when the import carried no address for this person —
   * which is not a failure: the row still goes, with an empty cell.
   */
  readonly emailSourceColumn: string | undefined;
}

export interface BuildRegistrationPayloadInput {
  /**
   * The stored contact, read back from the database at write time.
   * This is the authoritative record — deliberately not the in-memory
   * `ClaimedContact` the dispatcher holds, which carries no metadata
   * and therefore no email.
   */
  readonly contact: SheetContactDetail;
  readonly campaignId: string;
  readonly contactId: string;
  readonly attemptId: string;
}

/**
 * Builds the canonical payload from the authoritative stored record.
 *
 * Note what this function cannot do. It takes no transcript, no
 * classification and no conversation, so there is no path by which
 * something the caller said, or something a model produced, can end up
 * in a registration. A name is the imported name or it is empty.
 */
export function buildRegistrationPayload(
  input: BuildRegistrationPayloadInput,
): RegistrationPayload {
  const resolved = resolveContactEmail(input.contact.metadata);
  return {
    name: input.contact.name?.trim() ?? "",
    email: resolved?.email ?? "",
    phone: input.contact.normalizedPhone,
    campaignId: input.campaignId,
    contactId: input.contactId,
    attemptId: input.attemptId,
    emailSourceColumn: resolved?.sourceColumn,
  };
}

/**
 * The sheet's view of a registration: three cells, in the order
 * `SHEET_COLUMNS` names, byte-identical to what this integration has
 * appended since it shipped.
 *
 * Kept as its own function precisely so that the projection is a thing
 * that can be pointed at. The payload may grow; this must not, without
 * a decision about the spreadsheet.
 */
export function sheetRowFor(payload: RegistrationPayload): readonly string[] {
  return [payload.name, payload.email, payload.phone];
}
