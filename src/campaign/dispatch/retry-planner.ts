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
 */

import type { CallStatus, FailureClass } from "../domain/call-status";
import type { RetryConfig } from "../config/dispatch.config";

export interface RetryDecision {
  readonly retry: boolean;
  /** Where the contact goes: back in the queue, or terminal. */
  readonly contactStatus: CallStatus;
  readonly nextAttemptAfter: Date | null;
  readonly reason: string;
}

export function planRetry(
  failureClass: FailureClass,
  attemptsSoFar: number,
  config: RetryConfig,
  now: Date = new Date(),
): RetryDecision {
  const terminal = (status: CallStatus, reason: string): RetryDecision => ({
    retry: false,
    contactStatus: status,
    nextAttemptAfter: null,
    reason,
  });

  // A finished conversation is never redialled, whatever the outcome
  // of the conversation was.
  if (failureClass === "COMPLETED") return terminal("COMPLETED", "conversation completed");
  if (failureClass === "INVALID_NUMBER") return terminal("FAILED", "number is not dialable");
  if (failureClass === "REJECTED" && !config.retryOnRejected) {
    return terminal("FAILED", "call was rejected and retryOnRejected is off");
  }
  if (failureClass === "USER_HANGUP" && !config.retryOnUserHangup) {
    return terminal("COMPLETED", "the person hung up and retryOnUserHangup is off");
  }

  if (attemptsSoFar >= config.maxAttempts) {
    return terminal(statusFor(failureClass), `retry limit of ${config.maxAttempts} reached`);
  }

  const delayMinutes = delayFor(failureClass, attemptsSoFar, config);
  if (delayMinutes === undefined) {
    return terminal(statusFor(failureClass), `no retry policy for ${failureClass}`);
  }

  return {
    retry: true,
    // Back to PENDING so the lane's claim query picks it up again —
    // filtered, as always, by its own assigned_provider.
    contactStatus: "PENDING",
    nextAttemptAfter: new Date(now.getTime() + delayMinutes * 60_000),
    reason: `retrying on the same provider in ${delayMinutes} minute(s)`,
  };
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
