/**
 * registration-timing.ts
 *
 * The DURABLE record of when a confirmed registration reached the
 * registrations sheet — roadmap §5 B7.
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * B7 asks us to verify a four-point chain from logs:
 *
 *     user confirmation -> registration trigger -> Sheets HTTP request
 *     -> call end
 *
 * `final-yes-sheet.ts` already narrates every one of those moments, but
 * only to `console`. Stdout on the deployment is ephemeral, so the one
 * question B7 exists to answer — "how long after somebody said yes did
 * their row actually land?" — could be answered for a call that was
 * being watched and for no other. This module puts the same moments in
 * `campaign_events`, which is already the repository's append-only
 * operations log, through the existing `logEvent`. No new table, no new
 * transport, no second logging system.
 *
 * ── Every timestamp here is CAPTURED, not reconstructed ──────────
 *
 * `triggeredAt`, `requestStartedAt` and the settle instant are read
 * from the clock at the exact statement they name, inside the sync
 * itself. `confirmedAt` is the one that is not taken here, because it
 * cannot be: the moment the person said yes is stamped by the pipeline
 * when it commits the turn, long before this code runs. So it is READ
 * from that turn rather than inferred from anything downstream — see
 * `confirmationInstantFrom`.
 *
 * ── It cannot affect a call, a registration, or a sheet row ──────
 *
 * `recordRegistrationSync` returns `void`, never `Promise`. It cannot
 * be awaited, so no caller can accidentally make a call wait for it. It
 * swallows a synchronous throw and a rejected promise alike, so a
 * broken logger, a dead database connection or a full disk is a
 * no-operation. This is the same guarantee `final-yes-sheet.ts` gives
 * the dispatcher, held one level further in.
 */

import { logEvent } from "../db/repositories/call-attempt.repo";
import type { OutcomeClassification } from "../outcome/outcome-types";
import type { StoredTranscript } from "../outcome/transcript";

/**
 * The shape of the existing `logEvent`. Named so it can be substituted
 * in a test without importing the repository — the same seam
 * `FinalYesSheetDeps` already uses for the Google client.
 */
export type LogEventFn = (
  campaignId: string,
  code: string,
  message: string,
  data?: Record<string, unknown>,
  level?: "info" | "warn" | "error",
) => Promise<void>;

/**
 * One event code per outcome, so an operator can find all three with a
 * prefix and each one on its own. SCREAMING_SNAKE, matching the codes
 * already in use (`CALL_FAILED`, `DISPATCH_STARTED`, `RECOVERY`).
 */
export const REGISTRATION_SYNCED = "REGISTRATION_SYNCED";
export const REGISTRATION_SYNC_FAILED = "REGISTRATION_SYNC_FAILED";
export const REGISTRATION_SYNC_SKIPPED = "REGISTRATION_SYNC_SKIPPED";

/** Every code this module can write. Read by the reporting tests. */
export const REGISTRATION_SYNC_CODES = [
  REGISTRATION_SYNCED,
  REGISTRATION_SYNC_FAILED,
  REGISTRATION_SYNC_SKIPPED,
] as const;

/**
 * The instant the person committed, as the pipeline recorded it.
 *
 * `turnIndex` and `phrase` travel with it deliberately: they are what
 * lets an operator open the stored transcript and check that the
 * timestamp belongs to the turn they think it does, rather than
 * trusting this module's choice of turn.
 */
export interface ConfirmationInstant {
  /** ISO-8601, straight off the transcript turn. */
  readonly at: string;
  /** Index into the SAME stored transcript the classifier read. */
  readonly turnIndex: number;
  /** The phrase the classifier matched, for audit. Never re-matched here. */
  readonly phrase: string;
}

/**
 * Finds the turn the registration was given on, and returns the
 * timestamp the pipeline stamped on it.
 *
 * NO VERDICT IS TAKEN HERE. The decision that this call is a
 * registration was made by `classifier.ts` and is only read: the
 * signals it already stored carry `kind`, `turnIndex` and `atGate`, and
 * `atGate` is set on an affirmation only when that affirmation was both
 * at the commitment question AND decisive (see the `record` helper in
 * `classifier.ts`). This function re-matches no phrase, consults no
 * vocabulary table and can never disagree about whether somebody
 * registered — if the classification is not `confirmed_at_gate` it
 * returns nothing at all.
 *
 * WHICH TURN, when there is more than one. The classifier's own
 * explanation quotes `gateAffirmations[0]` — the FIRST surviving
 * at-gate affirmation — so the first one is taken here too. The single
 * case where the two can differ is a call that was retracted and then
 * re-confirmed, where the classifier drops the retracted yes and this
 * does not; the timestamp is then the earlier yes rather than the later
 * one. That is why `turnIndex` and `phrase` are reported next to it:
 * the event says which turn it read, and the stored transcript settles
 * any disagreement. Recomputing retraction positions here would mean
 * copying classifier logic into an integration, which is the one thing
 * this module must not do.
 *
 * Returns `undefined` — never throws — when the transcript is absent,
 * the index is out of range, the turn carries no timestamp (JSONB
 * round-tripping allows `null`), or the classification is not a gate
 * confirmation.
 */
export function confirmationInstantFrom(
  classification: OutcomeClassification | undefined,
  transcript: StoredTranscript | undefined,
): ConfirmationInstant | undefined {
  if (!classification || !transcript) return undefined;
  if (classification.primaryReason !== "confirmed_at_gate") return undefined;

  const signal = classification.detail.signals.find(
    (candidate) => candidate.kind === "affirmation" && candidate.atGate,
  );
  if (!signal) return undefined;

  const turn = transcript.turns[signal.turnIndex];
  if (!turn || turn.role !== "user" || !turn.at) return undefined;

  return { at: turn.at, turnIndex: signal.turnIndex, phrase: signal.phrase };
}

/** What happened to the registration, in the three terms the sheet sync already has. */
export type RegistrationSyncOutcome = "synced" | "failed" | "skipped";

export interface RegistrationSyncRecord {
  // ── Correlation. Every identifier an operator needs to join this
  //    event to the campaign, the call, the person and the sheet row.
  readonly campaignId: string;
  readonly contactId: string;
  readonly attemptId: string;
  readonly spreadsheetId?: string;
  /** Where the row landed, e.g. `Sheet1!A7:C7`. Success only. */
  readonly updatedRange?: string;

  readonly outcome: RegistrationSyncOutcome;
  /** The skip reason, or the error message. Truncated before storage. */
  readonly reason?: string;
  /** Whether the row went out with an Email cell. Never the address itself. */
  readonly hasEmail?: boolean;

  // ── The chain B7 asks for. Epoch ms, taken at the named statement.
  readonly confirmation?: ConfirmationInstant;
  readonly triggeredAtMs: number;
  readonly requestStartedAtMs?: number;
  readonly settledAtMs: number;
}

/** Google's error bodies are echoed into `reason`; `campaign_events` is not a place for an unbounded string. */
const MAX_REASON_CHARS = 500;

/**
 * Writes one event, fire-and-forget.
 *
 * Deliberately returns `void`: there is no promise for a caller to
 * await, so no code path can be written that makes a call, a hangup or
 * a sheet write wait on the operations log.
 */
export function recordRegistrationSync(
  record: RegistrationSyncRecord,
  log: LogEventFn = logEvent,
): void {
  try {
    const { code, level, message } = describe(record);
    // `void` + `.catch` is the established fire-and-forget shape in this
    // repository — see `run-launcher.ts`, which logs control and
    // calling-window transitions exactly this way.
    void log(record.campaignId, code, message, buildData(record), level).catch(() => undefined);
  } catch {
    // A logger that throws SYNCHRONOUSLY never reaches the `.catch`
    // above. Nothing about a registration may depend on this call, so
    // the failure ends here and is not re-reported — re-reporting it
    // would mean logging about the logger.
  }
}

function describe(record: RegistrationSyncRecord): {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
} {
  const elapsed = record.confirmation
    ? `${record.settledAtMs - Date.parse(record.confirmation.at)}ms after the person confirmed`
    : `${record.settledAtMs - record.triggeredAtMs}ms after the registration was triggered`;

  switch (record.outcome) {
    case "synced":
      return {
        code: REGISTRATION_SYNCED,
        level: "info",
        message: `Registration written to the sheet ${elapsed}`,
      };
    case "failed":
      return {
        code: REGISTRATION_SYNC_FAILED,
        level: "error",
        message: `Registration was NOT written to the sheet: ${record.reason ?? "unknown error"}`,
      };
    default:
      return {
        code: REGISTRATION_SYNC_SKIPPED,
        level: "warn",
        message: `Registration was not written to the sheet: ${record.reason ?? "skipped"}`,
      };
  }
}

/**
 * The event body.
 *
 * NO PERSONAL DETAIL. The name, the email address and the phone number
 * are already in `contacts` and in the sheet; repeating them in an
 * append-only operations log that is read for timing would put them in
 * a third place for no benefit. `contactId` is the correlation
 * identifier, and it joins to everything else.
 *
 * A duration is present only when BOTH of its endpoints were captured,
 * so a missing field always means "not observed" and never "zero".
 */
function buildData(record: RegistrationSyncRecord): Record<string, unknown> {
  const confirmedAtMs = record.confirmation ? Date.parse(record.confirmation.at) : Number.NaN;
  const hasConfirmation = Number.isFinite(confirmedAtMs);

  const timing: Record<string, unknown> = {
    confirmedAt: record.confirmation?.at,
    triggeredAt: new Date(record.triggeredAtMs).toISOString(),
    requestStartedAt:
      record.requestStartedAtMs !== undefined
        ? new Date(record.requestStartedAtMs).toISOString()
        : undefined,
    // The settle instant is named for what it IS on this row, so a
    // reader never has to check `outcome` to know what the timestamp
    // means.
    ...(record.outcome === "synced"
      ? { syncedAt: new Date(record.settledAtMs).toISOString() }
      : { failedAt: new Date(record.settledAtMs).toISOString() }),

    // Durations, for the comparison B8 makes. Derived from the four
    // instants above and stored next to them rather than instead of
    // them: the instants are the evidence, these are the convenience.
    confirmationToTriggerMs: hasConfirmation ? record.triggeredAtMs - confirmedAtMs : undefined,
    triggerToRequestMs:
      record.requestStartedAtMs !== undefined
        ? record.requestStartedAtMs - record.triggeredAtMs
        : undefined,
    // The Google round trip on its own. This is the figure that makes a
    // vendor timeout visible as a vendor timeout.
    requestMs:
      record.requestStartedAtMs !== undefined
        ? record.settledAtMs - record.requestStartedAtMs
        : undefined,
    // End to end: the number B7 exists to produce.
    confirmationToSettledMs: hasConfirmation ? record.settledAtMs - confirmedAtMs : undefined,
  };

  return {
    attemptId: record.attemptId,
    contactId: record.contactId,
    outcome: record.outcome,
    spreadsheetId: record.spreadsheetId,
    updatedRange: record.updatedRange,
    hasEmail: record.hasEmail,
    reason: record.reason?.slice(0, MAX_REASON_CHARS),
    confirmation: record.confirmation,
    timing,
    // The call's own end instant is NOT captured here. It is written by
    // `finalizeAttempt` as `call_attempts.ended_at`, one step before the
    // sheet sync runs, and is reachable from this event by `attemptId`.
    // Capturing a second copy would mean threading a new value through
    // the call runner's lifecycle for a fact the database already holds.
    callEndedAtSource: "call_attempts.ended_at",
  };
}
