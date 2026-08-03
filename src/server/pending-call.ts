/**
 * pending-call.ts
 *
 * `PlivoTelephonyProvider.startCall` (Provider Layer, unmodified)
 * places the call via Plivo's REST API and returns a
 * `TelephonyCallHandle` that is internal to the
 * `VoiceSessionManager` — it is not part of `SessionSnapshot` and
 * is never exposed to the Dashboard or this integration layer.
 * Meanwhile Plivo's Answer-URL webhook is a single, static URL
 * (`PLIVO_ANSWER_URL`, required by the Provider Layer's own env
 * config) shared by every call, and it must know which session's
 * Media Stream to open.
 *
 * The Dashboard only ever runs one active call at a time (see
 * `ACTIVE_SESSION_STATES`/`ConfigPanel`'s disabled-while-active
 * behavior), so a small FIFO queue reliably correlates "the session
 * that just called start()" with "the next answer webhook Plivo
 * fires" without needing to reach into any internal handle.
 */

import type { SessionId } from "../types/session.types";

const pendingQueue: SessionId[] = [];
const callUuidToSession = new Map<string, SessionId>();

export function registerPendingCall(sessionId: SessionId): void {
  // At most one call is ever legitimately pending at a time (see
  // header comment above). If an entry is still sitting here when a
  // new call starts, it belongs to a previous attempt that was never
  // answered (failed, no-answer, or abandoned) — leaving it in place
  // would let the next unrelated answer webhook wrongly claim it via
  // shift() instead of this new call.
  pendingQueue.length = 0;
  pendingQueue.push(sessionId);
}

/** Called by the Answer-URL webhook to resolve the pending call. Safe to call more than once for the same CallUUID — Plivo can retry a webhook delivery if a prior response was slow, and a retry must not steal the next unrelated session's pending slot. */
export function claimPendingSession(callUuid: string | undefined): SessionId | undefined {
  if (callUuid) {
    const alreadyClaimed = callUuidToSession.get(callUuid);
    if (alreadyClaimed) return alreadyClaimed;
  }

  const sessionId = pendingQueue.shift();
  if (sessionId && callUuid) {
    callUuidToSession.set(callUuid, sessionId);
  }
  return sessionId;
}

/** Used by later Plivo webhooks (e.g. hangup callbacks) keyed by CallUUID instead of order. */
export function resolveSessionForCall(callUuid: string): SessionId | undefined {
  return callUuidToSession.get(callUuid);
}

export function forgetCall(callUuid: string): void {
  callUuidToSession.delete(callUuid);
}