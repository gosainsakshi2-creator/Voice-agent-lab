/**
 * retry-planner.ts
 *
 * Decides whether a finished attempt becomes another attempt.
 *
 * The rule that matters: a retry is always on the SAME provider. This
 * module never chooses a provider at all — the contact's
 * `assigned_provider` is immutable in the database, the claim query
 * filters by it, and the attempt trigger rejects any mismatch. There
 * is no code path here that could send a failed Cartesia contact to
 * Sarvam, and three independent layers would refuse it if there were.
 *
 * Phase 7 adds a SECOND input: what the call meant. The rule that
 * matters there is that a customer decision outranks arithmetic. A
 * person who registered is never called again even with attempts left,
 * and a person who was never actually asked is not written off because
 * the line dropped. When no classification is available the planner
 * behaves exactly as it did before — a classifier fault must not be
 * able to change who gets dialled.
 */

import type { CallStatus, FailureClass } from "../domain/call-status";
import type { RetryConfig } from "../config/dispatch.config";
import { isDefinitive, type ContactDisposition } from "../outcome/disposition";
import type { OutcomeType } from "../outcome/outcome-types";

export interface RetryDecision {
  readonly retry: boolean;
  /** Where the contact goes: back in the queue, or terminal. */
  readonly contactStatus: CallStatus;
  readonly nextAttemptAfter: Date | null;
  readonly reason: string;
}

/**
 * What the finished call MEANT, as the planner needs it.
 *
 * Optional wherever it is accepted. `undefined` means "the outcome
 * could not be established", and selects the pre-Phase-7 behaviour.
 */
export interface RetryOutcome {
  readonly campaignType: string;
  readonly disposition: ContactDisposition;
  readonly outcomeType: OutcomeType;
}

const terminalDecision = (status: CallStatus, reason: string): RetryDecision => ({
  retry: false,
  contactStatus: status,
  nextAttemptAfter: null,
  reason,
});

const retryDecision = (delayMinutes: number, now: Date, reason: string): RetryDecision => ({
  retry: true,
  // Back to PENDING so the lane's claim query picks it up again —
  // filtered, as always, by its own assigned_provider.
  contactStatus: "PENDING",
  nextAttemptAfter: new Date(now.getTime() + delayMinutes * 60_000),
  reason,
});

export function planRetry(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
  now: Date = new Date(),
  outcome?: RetryOutcome,
): RetryDecision {
  // ── 1. A customer decision outranks the retry budget ────────────
  // Both directions. A registered person is not called again to be
  // sold the same seat, and a refusal is not called again to be asked
  // a second time. This is the only rule that ignores attempt counts.
  if (outcome && isDefinitive(outcome.disposition)) {
    return terminalDecision(
      statusFor(failureClass),
      `${outcome.disposition} (${outcome.outcomeType}) — definitive outcome, no further attempts`,
    );
  }

  // ── 2. Registration: retry until a decision or the ceiling ──────
  // Deliberately gated on the campaign type. A reminder campaign keeps
  // the telephony-only policy below, unchanged.
  if (outcome && isRegistration(outcome.campaignType)) {
    return planRegistrationRetry(failureClass, attemptsSoFar, config, now, outcome);
  }

  return planTelephonyRetry(failureClass, attemptsSoFar, config, now);
}

/**
 * The pre-Phase-7 planner, unchanged in behaviour.
 *
 * Reached by reminder campaigns and by any call whose outcome could not
 * be classified, which is what keeps the classifier non-load-bearing:
 * if it fails, dialling decisions are exactly what they were before it
 * existed.
 */
function planTelephonyRetry(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
  now: Date,
): RetryDecision {
  // A finished conversation is never redialled, whatever the outcome
  // of the conversation was.
  if (failureClass === "COMPLETED") return terminalDecision("COMPLETED", "conversation completed");
  if (failureClass === "INVALID_NUMBER") return terminalDecision("FAILED", "number is not dialable");
  if (failureClass === "REJECTED" && !config.retryOnRejected) {
    return terminalDecision("FAILED", "call was rejected and retryOnRejected is off");
  }
  if (failureClass === "USER_HANGUP" && !config.retryOnUserHangup) {
    return terminalDecision("COMPLETED", "the person hung up and retryOnUserHangup is off");
  }

  if (attemptsSoFar >= config.maxAttempts) {
    return terminalDecision(statusFor(failureClass), `retry limit of ${config.maxAttempts} reached`);
  }

  const delayMinutes = delayFor(failureClass, attemptsSoFar, config);
  if (delayMinutes === undefined) {
    return terminalDecision(statusFor(failureClass), `no retry policy for ${failureClass}`);
  }

  return retryDecision(delayMinutes, now, `retrying on the same provider in ${delayMinutes} minute(s)`);
}

/**
 * Registration policy: a contact stays eligible until the person
 * decides or the configured ceiling is reached.
 *
 * `failureClass === "COMPLETED"` is NOT terminal here. That is the
 * whole change: a conversation that ended without a decision — cut off
 * mid-sentence, "call me tomorrow", nothing decisive said — is a call
 * we still owe this person, not a result.
 */
function planRegistrationRetry(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
  now: Date,
  outcome: RetryOutcome,
): RetryDecision {
  // Hard blocks that survive any business reading of the call.
  if (failureClass === "INVALID_NUMBER") return terminalDecision("FAILED", "number is not dialable");
  if (failureClass === "REJECTED" && !config.retryOnRejected) {
    return terminalDecision("FAILED", "call was rejected and retryOnRejected is off");
  }

  const ceiling = config.registrationMaxAttempts;
  if (attemptsSoFar >= ceiling) {
    return terminalDecision(
      statusFor(failureClass),
      `registration retry limit of ${ceiling} attempt(s) reached with no definitive outcome ` +
        `(last: ${outcome.outcomeType})`,
    );
  }

  const delayMinutes = registrationDelayFor(failureClass, attemptsSoFar, config, outcome);
  if (delayMinutes === undefined) {
    return terminalDecision(
      statusFor(failureClass),
      `no registration retry policy for ${outcome.disposition} (${outcome.outcomeType})`,
    );
  }

  return retryDecision(
    delayMinutes,
    now,
    `${outcome.disposition} (${outcome.outcomeType}) — retrying on the same provider in ` +
      `${delayMinutes} minute(s), attempt ${attemptsSoFar + 1} of ${ceiling}`,
  );
}

/**
 * How long to wait before the next registration attempt.
 *
 * The existing telephony delays are preserved exactly: a no-answer
 * still waits `noAnswerDelayMinutes`, a busy line still waits
 * `busyDelayMinutes`, and a temporary failure still walks the existing
 * backoff. The two new waits apply only to the two new retry reasons.
 */
function registrationDelayFor(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
  outcome: RetryOutcome,
): number | undefined {
  if (outcome.outcomeType === "callback_requested") return config.callbackDelayMinutes;

  if (outcome.disposition === "UNRESOLVED") {
    return config.retryOnUnresolvedRegistration ? config.unresolvedDelayMinutes : undefined;
  }

  // RETRYABLE and TECHNICAL_FAILURE: the existing telephony policy
  // first, and the unresolved wait only for a class it has no entry for
  // (a conversation that ended undecided arrives as COMPLETED).
  return delayFor(failureClass, attemptsSoFar, config) ?? config.unresolvedDelayMinutes;
}

function isRegistration(campaignType: string): boolean {
  return campaignType === "registration";
}

function statusFor(failureClass: FailureClass): CallStatus {
  switch (failureClass) {
    case "NO_ANSWER":
      return "NO_ANSWER";
    case "BUSY":
      return "BUSY";
    case "COMPLETED":
      return "COMPLETED";
    default:
      return "FAILED";
  }
}

function delayFor(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
): number | undefined {
  switch (failureClass) {
    case "NO_ANSWER":
      return config.noAnswerDelayMinutes;
    case "BUSY":
      return config.busyDelayMinutes;
    case "REJECTED":
      return config.retryOnRejected ? config.busyDelayMinutes : undefined;
    case "USER_HANGUP":
      return config.retryOnUserHangup ? config.busyDelayMinutes : undefined;
    case "TEMPORARY":
    case "SYSTEM": {
      const backoff = config.temporaryBackoffMinutes;
      if (backoff.length === 0) return undefined;
      return backoff[Math.min(attemptsSoFar - 1, backoff.length - 1)] ?? backoff[backoff.length - 1];
    }
    default:
      return undefined;
  }
}
