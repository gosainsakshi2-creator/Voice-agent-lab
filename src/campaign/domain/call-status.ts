/**
 * call-status.ts
 *
 * The campaign call state machine — deliberately SEPARATE from the
 * voice agent's own `SessionState`. The two describe different things
 * (a campaign contact's dialling lifecycle vs a live conversation's
 * phase) and `session-states.constants.ts` is never touched.
 *
 * Same data-driven shape the core already uses, so the rules live in a
 * table rather than scattered conditionals.
 */

export type CallStatus =
  | "PENDING"
  | "ASSIGNED"
  | "QUEUED"
  | "DIALING"
  | "RINGING"
  | "ANSWERED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "NO_ANSWER"
  | "BUSY"
  | "FAILED"
  | "CANCELLED";

export const CAMPAIGN_CALL_TRANSITIONS: Readonly<Record<CallStatus, readonly CallStatus[]>> = {
  PENDING: ["ASSIGNED", "QUEUED", "CANCELLED"],
  ASSIGNED: ["QUEUED", "CANCELLED"],
  QUEUED: ["DIALING", "PENDING", "CANCELLED"],
  DIALING: ["RINGING", "ANSWERED", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED"],
  RINGING: ["ANSWERED", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED"],
  ANSWERED: ["IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "FAILED", "CANCELLED"],
  // Terminal for the attempt. A retry is a NEW attempt row, never a
  // resurrection of this one — which is what keeps attempt_number
  // monotonic and the idempotency constraint meaningful.
  COMPLETED: [],
  NO_ANSWER: [],
  BUSY: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "CANCELLED",
];

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return CAMPAIGN_CALL_TRANSITIONS[from].includes(to);
}

/**
 * Why an attempt ended, which is what the retry planner reads. Kept
 * separate from the status so "FAILED" alone never decides whether to
 * dial again.
 */
export type FailureClass =
  | "COMPLETED"
  | "NO_ANSWER"
  | "BUSY"
  | "REJECTED"
  | "USER_HANGUP"
  | "INVALID_NUMBER"
  | "TEMPORARY"
  | "SYSTEM";

/**
 * Maps a thrown error to a retry class. Conservative by design: an
 * error we do not recognise is TEMPORARY rather than permanent, so a
 * transient outage does not silently discard a contact — but the retry
 * cap still bounds it.
 */
export function classifyError(error: unknown): { failureClass: FailureClass; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (/invalid.*(number|destination)|not a valid number|barred|blacklist/.test(lower)) {
    return { failureClass: "INVALID_NUMBER", reason: message };
  }
  if (/\bbusy\b/.test(lower)) return { failureClass: "BUSY", reason: message };
  if (/no.?answer|not answered|timeout|timed out/.test(lower)) {
    return { failureClass: "NO_ANSWER", reason: message };
  }
  if (/reject|declined|denied|forbidden|403/.test(lower)) {
    return { failureClass: "REJECTED", reason: message };
  }
  if (/econnreset|etimedout|enotfound|socket|network|502|503|504|rate limit|429/.test(lower)) {
    return { failureClass: "TEMPORARY", reason: message };
  }
  if (/provider|configuration|not registered|missing required environment/.test(lower)) {
    return { failureClass: "SYSTEM", reason: message };
  }
  return { failureClass: "TEMPORARY", reason: message };
}
