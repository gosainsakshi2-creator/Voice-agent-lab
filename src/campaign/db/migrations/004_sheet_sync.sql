-- 004_sheet_sync.sql
--
-- One row per contact that has been mirrored to the registrations
-- Google Sheet.
--
-- The sheet is a DOWNSTREAM MIRROR of a decision this system has
-- already made and already persisted. Nothing here participates in
-- classification, disposition, retry or analytics: `call_outcomes`
-- remains the record of what a call meant and `contacts.final_disposition`
-- remains the record of what the person decided. This table only
-- answers one question — "has this contact already been written to the
-- sheet?" — and exists so that the answer is a database guarantee
-- rather than a hope about how many times the dispatcher ran.
--
-- WHY THE KEY IS (campaign_id, normalized_phone) AND NOT THE ATTEMPT
--
-- A contact can be dialled several times; only the attempt that
-- reaches the commitment question produces FINAL_YES, but a
-- re-classification of a stored transcript, a restarted dispatcher, or
-- an operator re-running a finished campaign can all present that same
-- FINAL_YES again. Keyed on the attempt, each of those would be a new
-- key and therefore a new row in the sheet. Keyed on the person —
-- which in this schema is exactly `(campaign_id, normalized_phone)`,
-- the same pair `contacts` is already UNIQUE on — the second and every
-- later presentation finds the key taken and does nothing.
--
-- STRICTLY ADDITIVE. No existing table, column, constraint or index is
-- touched.

CREATE TABLE sheet_sync (
  -- The person, in the only terms this schema treats as identity.
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  normalized_phone text NOT NULL,

  -- Provenance, for an operator reconciling a sheet row against a
  -- call. Nullable and ON DELETE SET NULL: losing the trail must not
  -- be able to delete the fact that the row was already written, which
  -- is the only thing standing between a re-run and a duplicate.
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  call_attempt_id  uuid REFERENCES call_attempts(id) ON DELETE SET NULL,

  -- Which spreadsheet the row went to. Recorded rather than assumed:
  -- if the target is ever repointed, the log still says where each
  -- historical row actually landed.
  spreadsheet_id   text NOT NULL,

  -- PENDING  a write is in flight (or the process died holding it)
  -- SYNCED   the row is in the sheet. TERMINAL — never re-claimed.
  -- FAILED   the write was attempted and refused; retryable.
  state            text NOT NULL DEFAULT 'PENDING',

  claimed_at       timestamptz NOT NULL DEFAULT now(),
  synced_at        timestamptz,
  -- Counts write ATTEMPTS, not calls. Purely diagnostic.
  attempts         integer NOT NULL DEFAULT 1,
  -- Truncated by the writer; a Google error body is not a place to
  -- store an unbounded string.
  last_error       text,

  PRIMARY KEY (campaign_id, normalized_phone)
);

ALTER TABLE sheet_sync
  ADD CONSTRAINT sheet_sync_state_known
    CHECK (state IN ('PENDING', 'SYNCED', 'FAILED'));

-- A synced row must say when, and only a synced row may. Enforced here
-- rather than trusted to the writer: "the same contact cannot create
-- two rows" is the guarantee this table exists for, and it should not
-- depend on one TypeScript branch being correct.
ALTER TABLE sheet_sync
  ADD CONSTRAINT sheet_sync_synced_has_timestamp
    CHECK ((state = 'SYNCED') = (synced_at IS NOT NULL));

-- Supports the operator query "what is still not in the sheet", which
-- is the only scan this table ever gets.
CREATE INDEX sheet_sync_state_idx
  ON sheet_sync (campaign_id, state);
