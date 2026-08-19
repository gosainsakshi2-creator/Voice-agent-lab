/**
 * final-yes-sheet.ts
 *
 * Mirrors a definitive FINAL_YES into the registrations Google Sheet.
 *
 * ── This introduces NO second verdict system ─────────────────────────
 *
 * Every question about whether a person registered is already answered
 * upstream and is only READ here:
 *
 *   classifier.ts   decides `registered_confirmed` / `confirmed_at_gate`
 *                   at exactly one place, and only from an affirmation
 *                   that is `atGate` AND `decisive` AND not taken back
 *                   by a later negation. A "yes" inside a question is
 *                   marked `decisive: false` there and is excluded
 *                   before this file ever sees the row.
 *   disposition.ts  projects that onto the contact-level `FINAL_YES`.
 *
 * `isFinalYes` below is a conjunction of those existing facts. It
 * cannot promote anything: if all three disagree, nothing is written.
 * FINAL_NO, callback_requested, unclear, no_engagement, interested-
 * not-confirmed and every not-connected call fail it by construction.
 *
 * ── This can never change what a call meant ──────────────────────────
 *
 * The function is called AFTER `saveClassification`, and it swallows
 * everything: a missing credential, a revoked share, a Google outage, a
 * dead database connection all end as a log line. It returns a result
 * object rather than throwing, and its own body is wrapped, so there is
 * no path by which a sheet problem reaches the retry planner, the
 * disposition, the attempt row or the campaign's state.
 */

import { getSheetSyncConfig, missingSheetConfigKeys, type SheetSyncConfig } from "../config/sheet.config";
import { isSuccessOutcome, type OutcomeClassification } from "../outcome/outcome-types";
import type { ContactDisposition } from "../outcome/disposition";
import {
  claimSheetSync,
  findContactForSheet,
  markSheetFailed,
  markSheetSynced,
} from "../db/repositories/sheet-sync.repo";
import { appendSheetRow, type AppendResult } from "./google-sheets.client";
import { resolveContactEmail } from "./contact-email";

/** Why a sync did not happen. Every one of these is a normal, non-error outcome. */
export type SheetSyncSkipReason =
  | "not-final-yes"
  | "not-configured"
  | "contact-missing"
  | "already-synced"
  | "write-failed";

export type SheetSyncResult =
  | { readonly synced: true; readonly updatedRange: string | undefined }
  | { readonly synced: false; readonly reason: SheetSyncSkipReason };

export interface FinalYesSheetInput {
  readonly campaignId: string;
  readonly contactId: string;
  readonly attemptId: string;
  readonly classification: OutcomeClassification | undefined;
  readonly disposition: ContactDisposition | undefined;
}

/**
 * Seam for verification. Production leaves both undefined and gets the
 * real configuration and the real Google client; the idempotency test
 * substitutes an appender so the database guarantee can be exercised
 * without a network call or a credential.
 */
export interface FinalYesSheetDeps {
  readonly config?: SheetSyncConfig;
  readonly append?: (config: SheetSyncConfig, values: readonly string[]) => Promise<AppendResult>;
}

/**
 * The FINAL_YES test, stated as the conjunction of the three existing
 * upstream facts rather than as a new rule.
 *
 * All three are redundant with each other today — `classifier.ts` has
 * exactly one branch that produces a success outcome and it sets all
 * three together. That is the point: should a future branch ever
 * produce a success outcome for a softer reason, this stays closed
 * until someone deliberately opens it.
 */
export function isFinalYes(
  classification: OutcomeClassification | undefined,
  disposition: ContactDisposition | undefined,
): boolean {
  if (!classification || disposition !== "FINAL_YES") return false;
  return (
    isSuccessOutcome(classification.outcomeType) &&
    classification.succeeded === true &&
    classification.primaryReason === "confirmed_at_gate"
  );
}

/**
 * Never throws. Never returns a rejected promise. The caller's control
 * flow is identical whether the sheet is configured, misconfigured,
 * unreachable or working.
 */
export async function syncFinalYesToSheet(
  input: FinalYesSheetInput,
  deps: FinalYesSheetDeps = {},
): Promise<SheetSyncResult> {
  try {
    // ── 1. The gate. Read, never decided, here. ──────────────────
    if (!isFinalYes(input.classification, input.disposition)) {
      return { synced: false, reason: "not-final-yes" };
    }

    const config = deps.config ?? getSheetSyncConfig();
    if (!config.isConfigured) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sheet-sync] FINAL_YES on attempt ${input.attemptId} was NOT written to the sheet — ` +
          `missing configuration: ${missingSheetConfigKeys(config).join(", ")}. ` +
          `The registration itself is stored and unaffected.`,
      );
      return { synced: false, reason: "not-configured" };
    }

    // ── 2. The person's details ──────────────────────────────────
    const contact = await findContactForSheet(input.contactId);
    if (!contact) {
      // eslint-disable-next-line no-console
      console.warn(`[sheet-sync] contact ${input.contactId} disappeared before its row could be written`);
      return { synced: false, reason: "contact-missing" };
    }

    const resolvedEmail = resolveContactEmail(contact.metadata);
    if (!resolvedEmail) {
      // Not a failure: the row still carries the name and the number,
      // which are the two fields the import guarantees. Logged because
      // a whole campaign missing emails means the CSV had no email
      // column, and that IS worth an operator's attention.
      // eslint-disable-next-line no-console
      console.warn(
        `[sheet-sync] no email column found in contact metadata for ${maskPhone(contact.normalizedPhone)} ` +
          `(keys: ${Object.keys(contact.metadata).join(", ") || "none"}) — writing the row with an empty Email cell`,
      );
    }

    // ── 3. Claim the slot. THIS is the duplicate guarantee. ──────
    const claimed = await claimSheetSync({
      campaignId: input.campaignId,
      normalizedPhone: contact.normalizedPhone,
      contactId: input.contactId,
      attemptId: input.attemptId,
      spreadsheetId: config.spreadsheetId,
    });
    if (!claimed) {
      // eslint-disable-next-line no-console
      console.log(
        `[sheet-sync] ${maskPhone(contact.normalizedPhone)} is already in the sheet for this campaign — ` +
          `no second row written`,
      );
      return { synced: false, reason: "already-synced" };
    }

    // ── 4. Write, and settle the slot either way ─────────────────
    const values = [contact.name?.trim() ?? "", resolvedEmail?.email ?? "", contact.normalizedPhone];
    const append = deps.append ?? appendSheetRow;

    try {
      const result = await append(config, values);
      await markSheetSynced(input.campaignId, contact.normalizedPhone, result.updatedRange);
      // eslint-disable-next-line no-console
      console.log(
        `[sheet-sync] FINAL_YES written to sheet: ${maskPhone(contact.normalizedPhone)} ` +
          `name="${contact.name ?? ""}" email=${resolvedEmail ? `from "${resolvedEmail.sourceColumn}"` : "none"} ` +
          `range=${result.updatedRange ?? "unknown"} attempt=${input.attemptId}`,
      );
      return { synced: true, updatedRange: result.updatedRange };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(
        `[sheet-sync] FAILED to write FINAL_YES for ${maskPhone(contact.normalizedPhone)} ` +
          `(attempt ${input.attemptId}): ${message}. The registration is stored and unaffected; ` +
          `the row is marked FAILED and will be retried the next time this contact is reprocessed.`,
      );
      // Best-effort: if this UPDATE also fails the slot stays PENDING
      // and is reclaimable after the stale window, which is the same
      // recovery path a crashed process takes.
      await markSheetFailed(input.campaignId, contact.normalizedPhone, message).catch(() => undefined);
      return { synced: false, reason: "write-failed" };
    }
  } catch (error) {
    // The outermost guarantee: nothing from this module reaches the
    // dispatcher. A database that cannot be reached, a malformed
    // credential, anything at all — it is a log line and nothing else.
    // eslint-disable-next-line no-console
    console.error(
      `[sheet-sync] sheet sync failed for attempt ${input.attemptId} and was ignored: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { synced: false, reason: "write-failed" };
  }
}

/**
 * Log lines are shared with support and pasted into tickets. The same
 * masking rule the import layer already applies to numbers in its
 * validation report (see `phone-normalizer.ts`) applies here.
 */
function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 7)}${"*".repeat(phone.length - 7)}`;
}
