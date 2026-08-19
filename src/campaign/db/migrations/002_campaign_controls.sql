-- 002_campaign_controls.sql
--
-- Durable campaign controls.
--
-- Phase 4's pause and stop live in the dispatcher object, which lives
-- in one process's memory. That is enough to pause a campaign you can
-- reach, and nothing at all if the process holding it has restarted,
-- if a second replica is serving the request, or if the operator
-- refreshed the page after the dispatcher finished. "Stop the calls"
-- is the one instruction that must not depend on which process
-- received it.
--
-- So the operator's INTENT is written here, in the database, and the
-- dispatcher's in-memory state becomes a follower of it rather than
-- the record of it. A watcher polls this row and drives the local
-- dispatcher; a dispatcher that starts later reads it before it claims
-- anything. A PAUSE that arrives while no dispatcher is running is
-- therefore still in force when one starts.
--
-- One row per campaign, not an event stream: the question this table
-- answers is "what is this campaign supposed to be doing right now",
-- which has exactly one answer. The audit trail of who asked for what
-- and when already exists in campaign_events, which every control
-- write also appends to.
--
-- Nothing here is read or written by the voice pipeline.

CREATE TYPE campaign_control_state AS ENUM ('RUN', 'PAUSE', 'STOP');

CREATE TABLE campaign_controls (
  campaign_id   uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,

  desired_state campaign_control_state NOT NULL DEFAULT 'RUN',

  /*
   * An operator-set ceiling on calls for the NEXT run, independent of
   * the deployment-wide CAMPAIGN_STAGE_MAX_CALLS and of the pilot
   * ladder. NULL means "no campaign-specific ceiling"; the smallest
   * of the three that applies is the one that binds, so this can only
   * ever lower the number of calls placed, never raise it.
   */
  max_calls_this_run integer,

  /*
   * Monotonic. A watcher that has already acted on revision N can see
   * revision N+1 as a NEW instruction even when the desired state is
   * unchanged — "stop, I mean it" is a different event from a re-read
   * of the same stop.
   */
  revision      bigint NOT NULL DEFAULT 1,

  requested_by  text NOT NULL,
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_controls_max_calls_positive
    CHECK (max_calls_this_run IS NULL OR max_calls_this_run >= 1)
);

-- ── Outcome lookup by attempt-facing analytics ───────────────────
-- call_outcomes already indexes (campaign_id, outcome_type, succeeded)
-- for aggregate reads. The results page also lists attempts newest
-- first with their outcome attached, which walks call_attempts by
-- campaign and time; without this it is a sort of the whole campaign
-- on every page of the listing.
CREATE INDEX IF NOT EXISTS call_attempts_campaign_created_idx
  ON call_attempts (campaign_id, created_at DESC);
