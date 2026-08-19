-- 003_contact_final_outcome.sql
--
-- The contact-level final outcome.
--
-- Until now the only thing a contact carried was `status`, which is a
-- call_status: it records WHAT HAPPENED TO THE LAST PHONE CALL, not
-- what the person decided. 'COMPLETED' therefore meant all of "she
-- registered", "he refused", "call me tomorrow", "the line dropped
-- mid-sentence" and "we reached an answering machine" — and the claim
-- query treats all five as finished. For a registration campaign that
-- is not a small imprecision; it is the difference between a
-- conversion rate and a call log.
--
-- STRICTLY ADDITIVE. No column is dropped or renamed, no enum is
-- altered, and `contacts.status` keeps exactly the meaning it has
-- today. Existing rows get NULL, which reads as "no business outcome
-- has been recorded for this contact yet" and is honest about the rows
-- that predate this migration rather than back-filling a guess.
--
-- The five dispositions are a PROJECTION of the eleven attempt-level
-- outcome types in outcome/outcome-types.ts, computed by
-- outcome/disposition.ts. They are not a second taxonomy: nothing is
-- classified into them directly, and the transcript remains the
-- appealable record.

ALTER TABLE contacts
  -- The contact-level verdict, projected from the latest attempt's
  -- outcome. Text rather than an enum: a new disposition must not
  -- require an ALTER TYPE against a live campaign, and the CHECK below
  -- still refuses an unknown value.
  ADD COLUMN final_disposition text,

  -- One sentence, from the retry planner, saying why this contact is
  -- where it is. Read by an operator asking "why did this number stop
  -- being called" without reading five tables.
  ADD COLUMN closure_reason text,

  -- Set when, and only when, no further attempt will be made. NULL is
  -- the load-bearing state: it means the contact is still open, and it
  -- is cleared again if a decision is ever re-opened.
  ADD COLUMN closed_at timestamptz,

  -- The attempt-level outcome_type behind the disposition, kept so the
  -- contact-level figure can always be traced to the vocabulary that
  -- produced it (callback_requested vs declined, both once closed).
  ADD COLUMN last_outcome_type text;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_final_disposition_known
    CHECK (
      final_disposition IS NULL
      OR final_disposition IN ('FINAL_YES', 'FINAL_NO', 'RETRYABLE', 'UNRESOLVED', 'TECHNICAL_FAILURE')
    );

-- A definitive outcome must be a closed contact, and a closed contact
-- must have a reason to be closed. Enforced here rather than trusted to
-- the writer: "never call a registered person again" is the guarantee
-- this whole phase exists for, and it should not depend on one
-- TypeScript branch being correct.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_definitive_outcome_is_closed
    CHECK (
      final_disposition IS NULL
      OR final_disposition NOT IN ('FINAL_YES', 'FINAL_NO')
      OR closed_at IS NOT NULL
    );

-- Supports the contact-level analytics (counts per disposition, per
-- provider) and the claim query's new "not definitively closed"
-- predicate, which reads the same column.
CREATE INDEX contacts_final_disposition_idx
  ON contacts (campaign_id, final_disposition);

CREATE INDEX contacts_provider_disposition_idx
  ON contacts (campaign_id, assigned_provider, final_disposition);
