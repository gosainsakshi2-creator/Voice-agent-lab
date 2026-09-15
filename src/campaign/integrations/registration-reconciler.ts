/**
 * registration-reconciler.ts
 *
 * SECOND CHANCES FOR A CONFIRMED REGISTRATION THAT IS NOT IN THE SHEET
 * — roadmap §5 B5/B6.
 *
 * ── The gap this closes ──────────────────────────────────────────
 *
 * `claimSheetSync` has always been willing to reclaim a FAILED row, and
 * `final-yes-sheet.ts` has always said the row "will be retried the
 * next time this contact is reprocessed". Nothing ever reprocessed one.
 * A FINAL_YES contact is unclaimable by the dispatcher by design — the
 * claim query and the retry planner both refuse it, which is the
 * guarantee that a registered person is never called again — so a
 * registration whose write failed sat FAILED forever, invisible.
 *
 * The same was true of a registration that was never presented at all:
 * a process killed between finalising the attempt and reaching the sync
 * leaves a FINAL_YES contact with no sheet_sync row and nothing that
 * would ever notice.
 *
 * This module is the thing that notices. It is the only new mechanism
 * in the batch, and it is deliberately thin: it SELECTS work and hands
 * each item to the existing writer.
 *
 * ── STRICTLY POST-CALL. This is the load-bearing property. ───────
 *
 * Nothing here is reachable from the voice path. It is not imported by
 * `conversation-pipeline.ts`, by either media bridge, by the session
 * manager or by `call-runner.ts`; it takes no session, no transcript
 * stream and no live call. Its two production call sites are both in
 * `Dispatcher.run()`:
 *
 *   before the lanes start   — nothing has been dialled yet in this run
 *   after `Promise.all(lanePromises)` — every lane has already awaited
 *                              `Promise.allSettled([...inFlight])`, so
 *                              every call of the run has ENDED
 *
 * There is therefore no instant at which this can issue a Google
 * request while a conversation this process owns is live, and it never
 * runs inside `runCall`, so it cannot delay a hangup or hold a
 * concurrency slot a call needs.
 *
 * ── It introduces no verdict and no second writer ────────────────
 *
 * Every registration it finds is passed to `syncFinalYesToSheet` — the
 * same function, the same gate, the same claim statement, the same
 * append, the same Batch A timing event. The stored classification is
 * handed back to the real `isFinalYes` rather than re-judged, so a row
 * this module presents is written only if it would have been written
 * live. If the stored verdict does not pass, nothing happens to it.
 *
 * ── It cannot throw ──────────────────────────────────────────────
 *
 * It is called from a `finally` block in the dispatcher. Every path is
 * wrapped, including the database read that finds the work, so a
 * reconciliation fault ends as a result object and a log line and can
 * never take down a dispatcher shutdown.
 */

import { getSheetSyncRetryPolicy, type SheetSyncRetryPolicy } from "../config/sheet.config";
import {
  countExhaustedSheetSyncs,
  findUnsyncedRegistrations,
  type UnsyncedRegistration,
} from "../db/repositories/sheet-sync.repo";
import { logEvent } from "../db/repositories/call-attempt.repo";
import { OUTCOME_SCHEMA_VERSION, type OutcomeClassification, type OutcomeType } from "../outcome/outcome-types";
import type { ContactDisposition } from "../outcome/disposition";
import { fromStoredTranscript, type StoredTranscript } from "../outcome/transcript";
import { syncFinalYesToSheet, type FinalYesSheetDeps } from "./final-yes-sheet";
import type { LogEventFn } from "./registration-timing";

/** The summary line. Its own code, so Batch A's three per-registration codes are untouched. */
export const REGISTRATION_RECONCILED = "REGISTRATION_RECONCILED";

export interface ReconcileResult {
  /** Registrations this pass looked at. */
  readonly examined: number;
  /** ...that are now in the sheet. */
  readonly synced: number;
  /** ...that were tried and refused again. */
  readonly failed: number;
  /** ...that the gate or the claim declined — already synced, unconfigured, contact gone. */
  readonly skipped: number;
  /**
   * Confirmed registrations that have used their whole retry budget and
   * are NOT retried by this pass. Reported every time so an exhausted
   * registration is visible rather than discarded; they stay FAILED in
   * `sheet_sync` and keep counting in the capture report's `failed`.
   */
  readonly exhausted: number;
  /** True when the batch size or the time budget cut the pass short. */
  readonly truncated: boolean;
}

const EMPTY: ReconcileResult = {
  examined: 0,
  synced: 0,
  failed: 0,
  skipped: 0,
  exhausted: 0,
  truncated: false,
};

export interface ReconcileDeps {
  readonly policy?: SheetSyncRetryPolicy;
  /** Passed straight through to the real writer. Used by the tests, never by production. */
  readonly sheet?: FinalYesSheetDeps;
  readonly logEvent?: LogEventFn;
  /** Injected so a test can drive the time budget without sleeping. */
  readonly now?: () => number;
}

/**
 * One bounded reconciliation pass over a campaign.
 *
 * Bounded three ways, because this runs unattended: the batch size caps
 * how many registrations are presented, the wall-clock budget caps how
 * long the pass may take whatever the batch size, and the per-row
 * attempt ceiling caps how many times any single registration is ever
 * tried. A campaign with more backlog than one pass allows is finished
 * by the next pass — `findUnsyncedRegistrations` orders by
 * `last_status_at`, so the oldest registration is always first in line.
 */
export async function reconcileRegistrationSheet(
  campaignId: string,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const policy = deps.policy ?? getSheetSyncRetryPolicy();
  const now = deps.now ?? Date.now;

  try {
    const backlog = await findUnsyncedRegistrations(campaignId, {
      maxAttempts: policy.maxAttempts,
      backoffMinutes: policy.backoffMinutes,
      limit: policy.reconcileBatchSize,
    });
    const exhausted = await countExhaustedSheetSyncs(campaignId, policy.maxAttempts);

    if (backlog.length === 0) {
      const result = { ...EMPTY, exhausted };
      // A quiet pass that found nothing to do says nothing, UNLESS
      // there are registrations nobody can retry any more — that is
      // the one thing an operator has to be told about repeatedly.
      if (exhausted > 0) emitSummary(campaignId, result, deps.logEvent);
      return result;
    }

    const startedAt = now();
    let synced = 0;
    let failed = 0;
    let skipped = 0;
    let examined = 0;
    let truncated = false;

    for (const registration of backlog) {
      if (now() - startedAt >= policy.reconcileMaxDurationMs) {
        truncated = true;
        break;
      }
      examined += 1;

      // Sequential on purpose. These are writes to one spreadsheet
      // through one service account, and a burst of parallel appends
      // buys nothing while making a rate-limit response more likely.
      const outcome = await presentOnce(campaignId, registration, deps);
      if (outcome === "synced") synced += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    }

    const result = {
      examined,
      synced,
      failed,
      skipped,
      exhausted,
      truncated: truncated || backlog.length >= policy.reconcileBatchSize,
    };
    emitSummary(campaignId, result, deps.logEvent);
    return result;
  } catch (error) {
    // The outermost guarantee, and the reason this is safe to call from
    // a `finally`: a reconciliation fault is a log line. It cannot fail
    // a dispatcher shutdown, a campaign status transition or a lock
    // release.
    // eslint-disable-next-line no-console
    console.error(
      `[sheet-reconcile] pass for campaign ${campaignId} failed and was ignored: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return EMPTY;
  }
}

/**
 * Hands ONE stored registration back to the live writer.
 *
 * Contained: a fault on one registration must not abandon the rest of
 * the pass.
 */
async function presentOnce(
  campaignId: string,
  registration: UnsyncedRegistration,
  deps: ReconcileDeps,
): Promise<"synced" | "failed" | "skipped"> {
  try {
    const transcript = storedTranscript(registration);
    const result = await syncFinalYesToSheet(
      {
        campaignId,
        contactId: registration.contactId,
        attemptId: registration.attemptId,
        classification: storedClassification(registration),
        disposition: registration.disposition as ContactDisposition,
        ...(transcript ? { transcript } : {}),
      },
      deps.sheet ?? {},
    );
    if (result.synced) return "synced";
    return result.reason === "write-failed" ? "failed" : "skipped";
  } catch {
    // `syncFinalYesToSheet` is documented never to throw, and this is
    // the belt to that braces: one unreadable row costs its own retry,
    // not the whole pass.
    return "skipped";
  }
}

/**
 * The verdict as it was stored, in the shape `isFinalYes` reads.
 *
 * NOT a re-classification. Every field is the column the classifier
 * wrote when the call ended; `detail` is carried through unchanged so
 * that the confirmation instant Batch A reports on a retry is the same
 * instant it would have reported live.
 */
function storedClassification(registration: UnsyncedRegistration): OutcomeClassification {
  const detail = (registration.detail ?? {}) as OutcomeClassification["detail"];
  return {
    outcomeType: registration.outcomeType as OutcomeType,
    succeeded: registration.succeeded,
    primaryReason: registration.primaryReason as OutcomeClassification["primaryReason"],
    classifier: "stored",
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    detail: {
      ...detail,
      // `signals` is what the confirmation instant is read from, and a
      // row written before that field existed has none. Defaulted to an
      // empty list so the reader degrades to "no confirmation instant"
      // instead of throwing.
      signals: Array.isArray(detail?.signals) ? detail.signals : [],
    },
  };
}

/** The stored transcript, rebuilt through the existing tolerant reader. */
function storedTranscript(registration: UnsyncedRegistration): StoredTranscript | undefined {
  const turns = fromStoredTranscript(registration.transcript);
  if (turns.length === 0) return undefined;
  return {
    turns,
    turnCount: turns.length,
    truncated: false,
    capturedAt: new Date().toISOString(),
    source: "conversation-memory",
  };
}

/** Fire-and-forget, like every other campaign event. Never throws, never awaited. */
function emitSummary(campaignId: string, result: ReconcileResult, log: LogEventFn = logEvent): void {
  const level = result.failed > 0 || result.exhausted > 0 ? "warn" : "info";
  const message =
    result.examined === 0
      ? `${result.exhausted} confirmed registration(s) have exhausted their sheet retry budget`
      : `Reconciled ${result.synced}/${result.examined} registration(s) into the sheet`;
  try {
    void log(campaignId, REGISTRATION_RECONCILED, message, { ...result }, level).catch(() => undefined);
  } catch {
    // See `recordRegistrationSync` — a logger that throws synchronously
    // never reaches the `.catch`, and nothing here may depend on it.
  }
}
