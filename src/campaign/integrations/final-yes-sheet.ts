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
 *
 * ── The timing record (roadmap §5 B7) ────────────────────────────
 *
 * Every exit past the gate also writes one durable `campaign_events`
 * row through `registration-timing.ts`, carrying the instants this
 * function is the only place that can observe: when the registration
 * was triggered, when the Sheets request went out, and when it settled.
 * It is fire-and-forget and returns `void`, so it cannot be awaited,
 * cannot delay a write, and cannot fail one. WHEN the write happens is
 * unchanged — this records the existing timing, it does not alter it.
 */

import {
  getSheetSyncConfig,
  getSheetSyncRetryPolicy,
  missingSheetConfigKeys,
  type SheetSyncConfig,
  type SheetSyncRetryPolicy,
} from "../config/sheet.config";
import { isSuccessOutcome, type OutcomeClassification } from "../outcome/outcome-types";
import type { ContactDisposition } from "../outcome/disposition";
import {
  claimSheetSync,
  findContactForSheet,
  markSheetFailed,
  markSheetSynced,
} from "../db/repositories/sheet-sync.repo";
import { appendSheetRow, type AppendResult } from "./google-sheets.client";
import { buildRegistrationPayload, sheetRowFor } from "./registration-payload";
import {
  confirmationInstantFrom,
  recordRegistrationSync,
  type LogEventFn,
} from "./registration-timing";
import type { StoredTranscript } from "../outcome/transcript";

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
  /**
   * The stored transcript this classification was made from, read for
   * ONE value: the timestamp the pipeline stamped on the turn the
   * person confirmed (roadmap §5 B7). Optional, and nothing about the
   * sheet row depends on it — a sync without it writes exactly the same
   * row and reports one fewer timestamp.
   */
  readonly transcript?: StoredTranscript;
}

/**
 * Seam for verification. Production leaves all three undefined and gets
 * the real configuration, the real Google client and the real
 * `logEvent`; the idempotency test substitutes an appender so the
 * database guarantee can be exercised without a network call or a
 * credential, and the timing test substitutes a recorder so the event
 * body can be asserted without reading it back out of the database.
 */
export interface FinalYesSheetDeps {
  readonly config?: SheetSyncConfig;
  readonly append?: (config: SheetSyncConfig, values: readonly string[]) => Promise<AppendResult>;
  readonly logEvent?: LogEventFn;
  /**
   * The retry budget (roadmap §5 B5). Production leaves it undefined
   * and gets the deployment's policy; a test substitutes one to drive
   * the ceiling without waiting for a real backoff.
   */
  readonly retryPolicy?: SheetSyncRetryPolicy;
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
  // THE REGISTRATION TRIGGER, taken before anything can fail so the
  // outermost catch below can still report it. `Date.now()` cannot
  // throw, so this line adds no failure mode to the sync.
  const triggeredAtMs = Date.now();
  // Captured as the write proceeds and read only by `emit`. Left
  // undefined on every path that did not reach the statement they name.
  let confirmation: ReturnType<typeof confirmationInstantFrom>;
  let requestStartedAtMs: number | undefined;
  let spreadsheetId: string | undefined;
  let hasEmail: boolean | undefined;
  /**
   * Whether this call is a registration at all. Read by the outermost
   * catch, so a fault on a call that was never a FINAL_YES stays as
   * silent as its normal path is.
   */
  let pastGate = false;

  /**
   * One durable event per registration that reached this function past
   * the gate. Fire-and-forget by construction — `recordRegistrationSync`
   * returns void — so no branch below can be made to wait on it, and a
   * logging fault cannot change what this function returns.
   */
  const emit = (
    outcome: "synced" | "failed" | "skipped",
    extra: { reason?: string; updatedRange?: string; settledAtMs?: number } = {},
  ): void => {
    recordRegistrationSync(
      {
        campaignId: input.campaignId,
        contactId: input.contactId,
        attemptId: input.attemptId,
        outcome,
        // The caller passes the instant the SHEET call settled where
        // one exists, so `requestMs` measures Google and not the
        // bookkeeping that follows it. Skips have no request to time
        // and settle when they are decided, which is now.
        settledAtMs: extra.settledAtMs ?? Date.now(),
        triggeredAtMs,
        ...(confirmation ? { confirmation } : {}),
        ...(requestStartedAtMs !== undefined ? { requestStartedAtMs } : {}),
        ...(spreadsheetId ? { spreadsheetId } : {}),
        ...(hasEmail !== undefined ? { hasEmail } : {}),
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        ...(extra.updatedRange !== undefined ? { updatedRange: extra.updatedRange } : {}),
      },
      deps.logEvent,
    );
  };

  try {
    // ── 1. The gate. Read, never decided, here. ──────────────────
    if (!isFinalYes(input.classification, input.disposition)) {
      // Deliberately silent. Every call that is not a registration
      // reaches this line, and an event for each would bury the
      // registrations in the log this exists to make readable.
      return { synced: false, reason: "not-final-yes" };
    }

    // Past the gate, so this call IS a registration. From here every
    // exit is worth a durable line, including the ones that write
    // nothing — "this person registered and their row is missing
    // because X" is the question B7 and B8 both have to answer.
    pastGate = true;
    confirmation = confirmationInstantFrom(input.classification, input.transcript);

    const config = deps.config ?? getSheetSyncConfig();
    if (config.spreadsheetId.length > 0) spreadsheetId = config.spreadsheetId;
    if (!config.isConfigured) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sheet-sync] FINAL_YES on attempt ${input.attemptId} was NOT written to the sheet — ` +
          `missing configuration: ${missingSheetConfigKeys(config).join(", ")}. ` +
          `The registration itself is stored and unaffected.`,
      );
      emit("skipped", {
        reason: `not-configured: missing ${missingSheetConfigKeys(config).join(", ")}`,
      });
      return { synced: false, reason: "not-configured" };
    }

    // ── 2. The person's details ──────────────────────────────────
    const contact = await findContactForSheet(input.contactId);
    if (!contact) {
      // eslint-disable-next-line no-console
      console.warn(`[sheet-sync] contact ${input.contactId} disappeared before its row could be written`);
      emit("skipped", { reason: "contact-missing" });
      return { synced: false, reason: "contact-missing" };
    }

    // The canonical registration (§5 B2), built from the authoritative
    // stored contact and nothing else. Built HERE rather than at the
    // write below so the email warning and the log line read the same
    // resolution the row is made from, instead of resolving twice.
    const payload = buildRegistrationPayload({
      contact,
      campaignId: input.campaignId,
      contactId: input.contactId,
      attemptId: input.attemptId,
    });
    hasEmail = payload.emailSourceColumn !== undefined;
    if (!hasEmail) {
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

    // ── 3. Claim the slot. THIS is the duplicate guarantee, and it
    //      is now also where the retry budget is enforced. ─────────
    // One statement decides both: a registration already in the sheet
    // is refused because SYNCED is terminal, and one that has used its
    // whole budget is refused because `attempts` has reached the
    // ceiling. Neither can be got past by calling this again.
    const retryPolicy = deps.retryPolicy ?? getSheetSyncRetryPolicy();
    const claimed = await claimSheetSync(
      {
        campaignId: input.campaignId,
        normalizedPhone: contact.normalizedPhone,
        contactId: input.contactId,
        attemptId: input.attemptId,
        spreadsheetId: config.spreadsheetId,
      },
      retryPolicy.maxAttempts,
    );
    if (!claimed) {
      // eslint-disable-next-line no-console
      console.log(
        `[sheet-sync] ${maskPhone(contact.normalizedPhone)} is already in the sheet for this campaign, ` +
          `is being written by another worker, or has used its ${retryPolicy.maxAttempts} sync attempts — ` +
          `no second row written`,
      );
      emit("skipped", { reason: "already-synced" });
      return { synced: false, reason: "already-synced" };
    }

    // ── 4. Write, and settle the slot either way ─────────────────
    // The sheet's three-column projection of the payload above —
    // byte-identical to the array this line used to build inline.
    // `registration-payload.ts` owns the contract now, so the columns
    // are a thing somebody has to change on purpose.
    const values = sheetRowFor(payload);
    const append = deps.append ?? appendSheetRow;

    try {
      // THE SHEETS HTTP REQUEST INSTANT. Taken on the statement before
      // the call and nowhere else, so `requestMs` in the event is the
      // vendor round trip and nothing of ours.
      requestStartedAtMs = Date.now();
      const result = await append(config, values);
      // THE SETTLE INSTANT, taken the moment Google answered — before
      // the bookkeeping below, so none of it lands inside `requestMs`.
      const syncedAtMs = Date.now();
      await markSheetSynced(input.campaignId, contact.normalizedPhone, result.updatedRange);
      // eslint-disable-next-line no-console
      console.log(
        `[sheet-sync] FINAL_YES written to sheet: ${maskPhone(contact.normalizedPhone)} ` +
          `name="${contact.name ?? ""}" email=${payload.emailSourceColumn ? `from "${payload.emailSourceColumn}"` : "none"} ` +
          `range=${result.updatedRange ?? "unknown"} attempt=${input.attemptId}`,
      );
      emit("synced", {
        settledAtMs: syncedAtMs,
        ...(result.updatedRange !== undefined ? { updatedRange: result.updatedRange } : {}),
      });
      return { synced: true, updatedRange: result.updatedRange };
    } catch (error) {
      // Taken before the message is built, for the same reason the
      // success instant is taken before its log line.
      const failedAtMs = Date.now();
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
      emit("failed", { settledAtMs: failedAtMs, reason: message });
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
    if (pastGate) {
      emit("failed", { reason: error instanceof Error ? error.message : String(error) });
    }
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
