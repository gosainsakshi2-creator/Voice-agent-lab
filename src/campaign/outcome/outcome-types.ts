/**
 * outcome-types.ts
 *
 * What a finished call MEANT, as opposed to what happened to it.
 *
 * `call_attempts.status` already records the mechanical result — the
 * phone rang, someone picked up, the conversation ended. None of that
 * says whether the person agreed to anything, and a campaign that
 * cannot answer that question has measured its telephony rather than
 * its script.
 *
 * Two rules shape everything below:
 *
 *   1. `succeeded` is allowed to be NULL. A call we genuinely cannot
 *      read is recorded as unreadable, not as a failure. Rounding
 *      "unclear" down to false would understate every provider by the
 *      same unknown amount and look like data.
 *
 *   2. The classifier that produced a row is stored with it. Every
 *      rule in `classifier.ts` is a guess about how people talk, and a
 *      better rubric later must be able to find the rows this one
 *      produced and re-run over the stored transcript instead of
 *      calling anyone back.
 */

import type { CampaignType } from "../domain/campaign-types";
import type { ConversationEvents } from "./conversation-events";
import type { ScriptAdherenceReport } from "./script-adherence";

/** Bumped when the meaning of a stored field changes, never for an added one. */
export const OUTCOME_SCHEMA_VERSION = 1;

/**
 * Recorded in `call_outcomes.classifier` on every row this produces.
 *
 * `rules.v2` reads a turn's SPEECH ACT before its keywords: a question
 * or an unfinished sentence is no longer allowed to supply the yes that
 * closes a contact. Rows written by `rules.v1` are still there and
 * still readable — that is what this field is for — and re-running the
 * current rubric over their stored transcripts is a query, not a round
 * of calls.
 */
export const RULES_CLASSIFIER_ID = "rules.v2";

export const OUTCOME_TYPES = [
  /** Never connected: no answer, busy, failed, cancelled. */
  "not_connected",
  /** Connected, but the person said nothing we could hear. */
  "no_engagement",
  /** Registration: agreed at the gate where the seat is reserved. */
  "registered_confirmed",
  /** Registration: engaged and positive, but never agreed at that gate. */
  "interested_not_confirmed",
  /** Reminder: confirmed they will attend. */
  "attendance_confirmed",
  /** Reminder: stayed on the call, never confirmed. */
  "acknowledged_not_confirmed",
  /** Said no. */
  "declined",
  /** Asked to be called at another time. */
  "callback_requested",
  /** Not the person we were calling. */
  "wrong_number",
  /** Asked not to be called again. Compliance-relevant, so it outranks everything else. */
  "do_not_call",
  /** Connected and spoke, with no signal decisive enough to call it. */
  "unclear",
] as const;

export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export const PRIMARY_REASONS = [
  "no_answer",
  "busy",
  "failed",
  "cancelled",
  "dialing_disabled",
  "system_error",
  "no_transcript",
  "no_customer_speech",
  /**
   * A voicemail greeting was RECOGNISED IN THE TRANSCRIPT. This is a
   * phrase heuristic over words the STT produced, not a carrier
   * answering-machine verdict — no AMD signal exists (see
   * external-limits.ts). Treated as "we do not know", never as a
   * human decision.
   */
  "suspected_voicemail",
  "confirmed_at_gate",
  "affirmative_not_at_gate",
  "explicit_no",
  "callback_requested",
  "wrong_person",
  "opt_out",
  "no_decisive_signal",
] as const;

export type PrimaryReason = (typeof PRIMARY_REASONS)[number];

/** How much weight the rule engine itself puts on the label it produced. */
export type OutcomeConfidence = "high" | "medium" | "low";

/** One phrase the classifier matched, kept so a human can audit the label. */
export interface OutcomeSignal {
  readonly kind: "affirmation" | "negation" | "callback" | "wrong_number" | "opt_out" | "voicemail";
  readonly phrase: string;
  readonly turnIndex: number;
  /** True when the phrase answered an assistant question that commits the person. */
  readonly atGate: boolean;
  /**
   * `false` when the phrase was matched but must NOT be read as an
   * answer — a "yes" inside a question, a "no" inside a sentence that
   * was cut off. Absent means decisive, which keeps every row written
   * before this field existed readable exactly as it was.
   */
  readonly decisive?: boolean;
}

export interface OutcomeClassification {
  readonly outcomeType: OutcomeType;
  /** `null` means "not determinable from this call", and is stored as NULL. */
  readonly succeeded: boolean | null;
  readonly primaryReason: PrimaryReason;
  readonly classifier: string;
  readonly schemaVersion: number;
  readonly detail: {
    readonly confidence: OutcomeConfidence;
    readonly campaignType: string;
    readonly customerTurns: number;
    readonly assistantTurns: number;
    /** Every phrase that moved the decision, with where it was said. */
    readonly signals: readonly OutcomeSignal[];
    /** One sentence a human can read next to the label. */
    readonly explanation: string;
    /**
     * True when a voicemail greeting was matched in the transcript.
     * A HEURISTIC over transcribed words — the platform has no
     * answering-machine detection, so this is never proof of a machine
     * and its absence is never proof of a human.
     */
    readonly suspectedVoicemail?: boolean;
    /**
     * What KIND of conversation this was: how often the person asked
     * something, objected, or was cut off mid-thought, and whether the
     * call ended on a question nobody answered.
     *
     * Reported so a campaign can tell an engaged caller from a decided
     * one. None of it is a verdict — a question is not a registration
     * and not a refusal, and these counts exist precisely so that
     * distinction is visible in the report instead of being smoothed
     * into the conversion rate.
     */
    readonly conversation?: ConversationEvents;
    /**
     * Whether the agent stayed on the approved script: no restart, no
     * invented question, no figure the script never gave it. Present
     * only when the caller supplied the script text.
     */
    readonly adherence?: ScriptAdherenceReport;
  };
}

/** The success label for a campaign type, and the "engaged but not committed" one. */
export function outcomeVocabulary(campaignType: string): {
  readonly success: OutcomeType;
  readonly partial: OutcomeType;
} {
  const type = campaignType as CampaignType;
  if (type === "reminder") {
    return { success: "attendance_confirmed", partial: "acknowledged_not_confirmed" };
  }
  return { success: "registered_confirmed", partial: "interested_not_confirmed" };
}

/** The outcomes that count as a business success. Read by every aggregate. */
export function isSuccessOutcome(outcome: OutcomeType): boolean {
  return outcome === "registered_confirmed" || outcome === "attendance_confirmed";
}
