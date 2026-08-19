/**
 * outcome.repo.ts
 *
 * Persistence for what a call MEANT. `call_outcomes` has existed since
 * Phase 1 and has never had a row written to it; this is the only
 * module that writes one.
 *
 * The upsert is deliberate. Re-classifying a stored transcript with a
 * better rubric must be a supported operation — the alternative is
 * either a second outcome row per call (and every aggregate silently
 * double-counting) or calling the same people again to get a label we
 * already have the words for.
 */

import { query } from "../client";
import type { OutcomeClassification } from "../../outcome/outcome-types";
import type { StoredTranscript } from "../../outcome/transcript";

export interface SaveOutcomeInput {
  readonly attemptId: string;
  readonly campaignId: string;
  readonly classification: OutcomeClassification;
  /** Omitted rather than null when a call produced no transcript at all. */
  readonly transcript?: StoredTranscript;
}

export async function saveOutcome(input: SaveOutcomeInput): Promise<void> {
  const { classification: outcome } = input;
  await query(
    `INSERT INTO call_outcomes
       (call_attempt_id, campaign_id, outcome_type, schema_version, succeeded,
        primary_reason, detail, classifier, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
     ON CONFLICT (call_attempt_id) DO UPDATE
        SET outcome_type   = EXCLUDED.outcome_type,
            schema_version = EXCLUDED.schema_version,
            succeeded      = EXCLUDED.succeeded,
            primary_reason = EXCLUDED.primary_reason,
            detail         = EXCLUDED.detail,
            classifier     = EXCLUDED.classifier,
            classified_at  = now(),
            -- A re-classification re-reads the stored transcript; it
            -- must never be able to erase it.
            transcript     = COALESCE(EXCLUDED.transcript, call_outcomes.transcript)`,
    [
      input.attemptId,
      input.campaignId,
      outcome.outcomeType,
      outcome.schemaVersion,
      outcome.succeeded,
      outcome.primaryReason,
      JSON.stringify(outcome.detail),
      outcome.classifier,
      input.transcript ? JSON.stringify(input.transcript) : null,
    ],
  );
}

/**
 * Records how long classification took, on the row that already holds
 * the orchestration timings.
 *
 * A separate UPDATE rather than a wider INSERT: classification happens
 * after the metrics row is written, and widening the existing insert
 * would mean either delaying it or holding the whole call's timings in
 * memory until the classifier finishes.
 */
export async function recordClassifyMs(attemptId: string, classifyMs: number): Promise<void> {
  await query("UPDATE dispatch_metrics SET classify_ms = $2 WHERE call_attempt_id = $1", [
    attemptId,
    Math.max(0, Math.round(classifyMs)),
  ]);
}

/** Attempts that connected but were never classified — the re-classification work list. */
export async function findUnclassifiedAttempts(
  campaignId: string,
  limit = 500,
): Promise<ReadonlyArray<{ attemptId: string; campaignType: string; status: string }>> {
  const result = await query<{ id: string; campaign_type: string; status: string }>(
    `SELECT a.id, c.campaign_type, a.status::text AS status
       FROM call_attempts a
       JOIN campaigns c ON c.id = a.campaign_id
       LEFT JOIN call_outcomes o ON o.call_attempt_id = a.id
      WHERE a.campaign_id = $1 AND o.call_attempt_id IS NULL AND a.ended_at IS NOT NULL
      ORDER BY a.created_at
      LIMIT $2`,
    [campaignId, limit],
  );
  return result.rows.map((row) => ({
    attemptId: row.id,
    campaignType: row.campaign_type,
    status: row.status,
  }));
}
