/**
 * disposition.ts
 *
 * The CONTACT-level meaning of an attempt-level outcome.
 *
 * `call_outcomes.outcome_type` says what one call meant. It does not
 * say whether the person is finished with us. A registration campaign
 * that closes a contact because a conversation ended has measured its
 * telephony rather than its registrations: "call me later" and "no,
 * never" are the same row to it.
 *
 * This module is the ONLY place that projection lives. It deliberately
 * introduces no second taxonomy — the eleven outcome types in
 * `outcome-types.ts` remain the source of truth, and these five
 * dispositions are a view over them:
 *
 *   FINAL_YES          the person committed. Never call again.
 *   FINAL_NO           the person refused, opted out, or is not them.
 *                      Never call again.
 *   RETRYABLE          nothing was decided and there is a concrete
 *                      reason to call back (no answer, callback asked
 *                      for, line never connected).
 *   UNRESOLVED         the call happened and decided nothing.
 *   TECHNICAL_FAILURE  our side or the carrier's side broke.
 *
 * A definitive disposition outranks the retry budget; the other three
 * are bounded by it. Which of them a campaign type is willing to redial
 * is a retry-policy question and is answered in `retry-planner.ts`, not
 * here — this file states meaning, not action.
 */

import type { FailureClass } from "../domain/call-status";
import type { OutcomeType } from "./outcome-types";

export const CONTACT_DISPOSITIONS = [
  "FINAL_YES",
  "FINAL_NO",
  "RETRYABLE",
  "UNRESOLVED",
  "TECHNICAL_FAILURE",
] as const;

export type ContactDisposition = (typeof CONTACT_DISPOSITIONS)[number];

export function isContactDisposition(value: string): value is ContactDisposition {
  return (CONTACT_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * A customer decision. Overrides any remaining attempts, in both
 * directions: a yes must not be redialled to be sold again, and a no
 * must not be redialled to be asked again.
 */
export function isDefinitive(disposition: ContactDisposition): boolean {
  return disposition === "FINAL_YES" || disposition === "FINAL_NO";
}

export interface DispositionInput {
  readonly outcomeType: OutcomeType;
  readonly failureClass: FailureClass;
}

export interface DispositionResult {
  readonly disposition: ContactDisposition;
  /** One sentence, stored on the contact as `closure_reason`. */
  readonly reason: string;
}

/**
 * Maps one classified attempt onto a contact-level disposition.
 *
 * Campaign-type independent on purpose. `registered_confirmed` and
 * `attendance_confirmed` are each their own campaign's success label
 * (see `outcomeVocabulary`), so both are FINAL_YES wherever they
 * appear, and neither can appear for the other campaign type.
 */
export function dispositionFor(input: DispositionInput): DispositionResult {
  switch (input.outcomeType) {
    // ── Definitive: the person decided ────────────────────────────
    case "registered_confirmed":
      return { disposition: "FINAL_YES", reason: "registration confirmed at the commitment question" };
    case "attendance_confirmed":
      return { disposition: "FINAL_YES", reason: "attendance confirmed at the commitment question" };
    case "declined":
      return { disposition: "FINAL_NO", reason: "the person declined explicitly" };
    case "do_not_call":
      return { disposition: "FINAL_NO", reason: "the person asked not to be contacted again" };
    case "wrong_number":
      return { disposition: "FINAL_NO", reason: "this number does not reach the intended person" };

    // ── Retryable: a concrete reason to call back ──────────────────
    case "callback_requested":
      return { disposition: "RETRYABLE", reason: "the person asked to be called at another time" };

    case "not_connected":
      // A number the carrier will never accept is not a retry.
      if (input.failureClass === "INVALID_NUMBER") {
        return { disposition: "FINAL_NO", reason: "the number is not dialable" };
      }
      if (input.failureClass === "SYSTEM" || input.failureClass === "TEMPORARY") {
        return { disposition: "TECHNICAL_FAILURE", reason: "the call failed before it connected" };
      }
      return { disposition: "RETRYABLE", reason: "the call did not connect" };

    // ── Unresolved: it happened and decided nothing ────────────────
    case "no_engagement":
      return {
        disposition: "UNRESOLVED",
        reason: "the call connected but produced no decision (possibly a machine)",
      };
    case "interested_not_confirmed":
      return { disposition: "UNRESOLVED", reason: "positive but never agreed at the commitment question" };
    case "acknowledged_not_confirmed":
      return { disposition: "UNRESOLVED", reason: "stayed on the call but never confirmed" };
    case "unclear":
      return { disposition: "UNRESOLVED", reason: "nothing in the conversation was decisive" };

    default: {
      // Exhaustive today. An outcome type added later without a
      // mapping must be UNRESOLVED — retryable within budget rather
      // than either silently closed or silently counted as a success.
      const unmapped: never = input.outcomeType;
      return { disposition: "UNRESOLVED", reason: `no disposition mapping for "${String(unmapped)}"` };
    }
  }
}
