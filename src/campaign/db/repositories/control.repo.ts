/**
 * control.repo.ts
 *
 * Reads and writes the operator's intent for a campaign.
 *
 * Every write goes to `campaign_controls` AND appends to
 * `campaign_events`, in one transaction. The table answers "what is
 * this campaign supposed to be doing"; the event log answers "who
 * asked for that, and when". Losing either one would leave a
 * post-mortem unable to say whether a campaign stopped because
 * someone stopped it.
 *
 * Note what is NOT here: nothing in this file starts, ends or affects
 * a call. A control write records a decision; the watcher and the
 * dispatcher act on it.
 */

import { query, withTransaction } from "../client";
import { isPilotStage } from "../../domain/pilot-stage";

export type ControlState = "RUN" | "PAUSE" | "STOP";

export interface CampaignControl {
  readonly campaignId: string;
  readonly desiredState: ControlState;
  readonly maxCallsThisRun: number | null;
  readonly revision: number;
  readonly requestedBy: string;
  readonly reason: string | null;
  readonly requestedAt: Date;
}

interface ControlRow {
  campaign_id: string;
  desired_state: ControlState;
  max_calls_this_run: number | null;
  revision: string | number;
  requested_by: string;
  reason: string | null;
  requested_at: Date;
}

function toControl(row: ControlRow): CampaignControl {
  return {
    campaignId: row.campaign_id,
    desiredState: row.desired_state,
    maxCallsThisRun: row.max_calls_this_run,
    // bigint arrives as a string from `pg`; a revision that silently
    // became "1" > "10" lexically would make a watcher miss an
    // instruction, so it is narrowed to a number here, once.
    revision: Number(row.revision),
    requestedBy: row.requested_by,
    reason: row.reason,
    requestedAt: row.requested_at,
  };
}

const SELECT_COLUMNS =
  "campaign_id, desired_state, max_calls_this_run, revision, requested_by, reason, requested_at";

/**
 * The campaign's current instruction.
 *
 * A campaign that has never been controlled has no row, and that is
 * reported as RUN at revision 0 rather than as an error: "nobody has
 * paused this" and "someone explicitly resumed this" mean the same
 * thing to a dispatcher, and inventing a difference would make the
 * first start of every campaign a special case.
 */
export async function getControl(campaignId: string): Promise<CampaignControl> {
  const result = await query<ControlRow>(
    `SELECT ${SELECT_COLUMNS} FROM campaign_controls WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  if (row) return toControl(row);
  return {
    campaignId,
    desiredState: "RUN",
    maxCallsThisRun: null,
    revision: 0,
    requestedBy: "default",
    reason: null,
    requestedAt: new Date(0),
  };
}

export interface SetControlInput {
  readonly campaignId: string;
  readonly desiredState: ControlState;
  readonly requestedBy: string;
  readonly reason?: string | null;
  /**
   * `undefined` leaves any existing ceiling alone; `null` clears it.
   * The two are genuinely different instructions — "pause" must not
   * quietly discard a ceiling the operator set earlier.
   */
  readonly maxCallsThisRun?: number | null;
}

/**
 * Records an instruction and bumps the revision.
 *
 * The revision is incremented even when the desired state is
 * unchanged, so a watcher can distinguish a repeated instruction from
 * a re-read of the same one.
 */
export async function setControl(input: SetControlInput): Promise<CampaignControl> {
  return withTransaction(async (client) => {
    const result = await client.query<ControlRow>(
      `INSERT INTO campaign_controls
         (campaign_id, desired_state, max_calls_this_run, requested_by, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (campaign_id) DO UPDATE
          SET desired_state      = EXCLUDED.desired_state,
              max_calls_this_run = CASE WHEN $6::boolean
                                        THEN EXCLUDED.max_calls_this_run
                                        ELSE campaign_controls.max_calls_this_run END,
              requested_by       = EXCLUDED.requested_by,
              reason             = EXCLUDED.reason,
              requested_at       = now(),
              revision           = campaign_controls.revision + 1
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.campaignId,
        input.desiredState,
        input.maxCallsThisRun ?? null,
        input.requestedBy,
        input.reason ?? null,
        input.maxCallsThisRun !== undefined,
      ],
    );

    await client.query(
      `INSERT INTO campaign_events (campaign_id, level, code, message, data)
       VALUES ($1, 'info', $2, $3, $4::jsonb)`,
      [
        input.campaignId,
        `CONTROL_${input.desiredState}`,
        input.reason ?? `Campaign control set to ${input.desiredState}`,
        JSON.stringify({
          requestedBy: input.requestedBy,
          maxCallsThisRun: input.maxCallsThisRun ?? null,
        }),
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error("Control write returned no row.");
    return toControl(row);
  });
}

/**
 * Moves a campaign along the pilot ladder.
 *
 * Refused rather than clamped when the stage is out of range: a typo
 * that silently became "the highest rung" is the one mistake this
 * ladder exists to prevent.
 */
export async function setPilotStage(
  campaignId: string,
  stage: number,
  requestedBy: string,
): Promise<number> {
  if (!isPilotStage(stage)) {
    throw new Error(`Pilot stage ${stage} is not on the ladder.`);
  }
  return withTransaction(async (client) => {
    const result = await client.query<{ pilot_stage: number }>(
      "UPDATE campaigns SET pilot_stage = $2 WHERE id = $1 RETURNING pilot_stage",
      [campaignId, stage],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Campaign not found.");
    await client.query(
      `INSERT INTO campaign_events (campaign_id, level, code, message, data)
       VALUES ($1, 'info', 'PILOT_STAGE_SET', $2, $3::jsonb)`,
      [campaignId, `Pilot stage set to ${stage}`, JSON.stringify({ stage, requestedBy })],
    );
    return row.pilot_stage;
  });
}

/** Recent operator-visible activity, newest first. Used by the controls panel. */
export async function recentEvents(
  campaignId: string,
  limit = 20,
): Promise<
  ReadonlyArray<{
    readonly at: Date;
    readonly level: string;
    readonly code: string;
    readonly message: string | null;
  }>
> {
  const result = await query<{ at: Date; level: string; code: string; message: string | null }>(
    `SELECT at, level, code, message FROM campaign_events
      WHERE campaign_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [campaignId, limit],
  );
  return result.rows;
}
