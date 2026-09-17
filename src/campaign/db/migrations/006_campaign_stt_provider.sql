-- 006_campaign_stt_provider.sql
--
-- WHICH SPEECH-TO-TEXT PROVIDER A CAMPAIGN USES, AND WHICH ONE
-- ACTUALLY RAN EACH CALL.
--
-- Until now STT was the one dimension with no choice in it: a single
-- provider was registered and `resolveCallProviderStack` returned the
-- `'deepgram'` literal, so "what was configured" and "what ran" were
-- the same sentence for every call ever placed. A second real-time
-- provider (Soniox) makes that false, and this migration adds the two
-- columns that keep the question answerable — one for the CHOICE, one
-- for the OBSERVATION, exactly as 005 did for the language model.
--
-- NOT AN ALLOCATION. `campaigns.stt_provider` is a single id, not a
-- percentage map like `provider_allocation`. STT is chosen per
-- campaign, not split across contacts: there is no hash, no lane and
-- no per-contact variation, and nothing here introduces one.
--
-- ADDITIVE AND NON-DESTRUCTIVE:
--
--   - Both columns are NULLABLE with NO default and NO backfill. A
--     campaign created before this migration did not record a choice,
--     and NULL says exactly that — the runtime reads NULL as "use the
--     default", which is still Deepgram. Backfilling 'deepgram' would
--     be a guess written into a column meant to hold a decision, and
--     it would make a campaign that never chose indistinguishable
--     from one that chose Deepgram deliberately.
--   - `call_attempts.stt_provider` is the same shape as the
--     `llm_provider` column 005 added: the provider that ACTUALLY
--     handled the call, resolved at dial time. NULL on historical
--     rows means "not recorded", never "deepgram".
--   - No column is dropped, renamed, retyped or re-constrained.
--   - No trigger is added or altered. The existing
--     call_attempts_provider_guard, which locks the contact's TTS
--     lane, is untouched and still refuses cross-provider writes.
--
-- Re-runnable: every statement is IF NOT EXISTS / OR REPLACE.

-- ── The campaign's CHOICE ────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS stt_provider text;

COMMENT ON COLUMN campaigns.stt_provider IS
  'Canonical id of the speech-to-text provider this campaign is configured to use (e.g. ''deepgram'', ''soniox''). A SINGLE id, never a percentage allocation — STT is not split across contacts. NULL means no explicit choice was made, which the runtime resolves to the platform default (Deepgram).';

-- ── What ACTUALLY ran ────────────────────────────────────────────

ALTER TABLE call_attempts
  ADD COLUMN IF NOT EXISTS stt_provider text;

COMMENT ON COLUMN call_attempts.stt_provider IS
  'Canonical id of the speech-to-text provider that ACTUALLY ran this call, resolved at dial time. NULL for attempts predating STT attribution. Never the configured choice — the observation.';

-- Supports "group the stack by STT", which is the question this column
-- exists for. Partial, so the NULL historical rows cost nothing.
CREATE INDEX IF NOT EXISTS call_attempts_stt_provider_idx
  ON call_attempts (campaign_id, stt_provider, status)
  WHERE stt_provider IS NOT NULL;

-- ── The stack view gains its fourth dimension ────────────────────
--
-- Recreated with stt_provider added beside the other three actual
-- providers. Every existing column keeps its name, its prefix and its
-- source table, so no query written against the previous definition
-- changes meaning. The conversation/orchestration separation that
-- 001_init.sql mandates is preserved: nothing is blended, and no new
-- total is computed.

CREATE OR REPLACE VIEW call_stack_stats AS
SELECT
  a.id                            AS call_attempt_id,
  a.campaign_id,
  a.contact_id,
  a.attempt_number,
  a.status,
  a.hangup_reason,
  a.failure_class,

  -- The actual providers. The grouping keys. (stt_provider is the
  -- fourth and is appended at the end of this list — see the note there.)
  a.provider                      AS tts_provider,
  a.llm_provider,
  a.telephony_provider,

  -- Call level.
  a.dialed_at,
  a.answered_at,
  a.ended_at,
  a.duration_seconds,
  a.ring_seconds,
  m.turn_count,
  m.conversation_seconds,

  -- Turn level, median across the call.
  m.stt_p50_ms,
  m.llm_p50_ms,
  m.tts_p50_ms,
  m.total_p50_ms,
  m.first_turn_total_ms,

  -- Cost. cost_llm_usd is NULL, not 0, for a model with no confirmed
  -- commercial rate — do not COALESCE it to 0 in a report.
  m.cost_telephony_usd,
  m.cost_stt_usd,
  m.cost_llm_usd,
  m.cost_tts_usd,
  m.cost_total_usd,

  -- Orchestration. Prefixed so no query can confuse a dispatcher
  -- timing with a conversation timing.
  d.queue_wait_ms                 AS dispatch_queue_wait_ms,
  d.claim_to_dial_ms              AS dispatch_claim_to_dial_ms,
  d.dial_request_ms               AS dispatch_dial_request_ms,
  d.ring_to_answer_ms             AS dispatch_ring_to_answer_ms,
  d.answer_to_first_audio_ms      AS dispatch_answer_to_first_audio_ms,

  -- Business result.
  o.outcome_type,
  o.succeeded,
  o.primary_reason,

  -- APPENDED, not inserted. `CREATE OR REPLACE VIEW` may only add
  -- columns at the end — inserting one beside the other providers
  -- renames every column after it and Postgres refuses the replace.
  -- Position is cosmetic; grouping by it works identically.
  a.stt_provider

FROM call_attempts a
LEFT JOIN call_metrics     m ON m.call_attempt_id = a.id
LEFT JOIN dispatch_metrics d ON d.call_attempt_id = a.id
LEFT JOIN call_outcomes    o ON o.call_attempt_id = a.id;

COMMENT ON VIEW call_stack_stats IS
  'Read-only join of call_attempts (the four actual provider ids: tts, llm, telephony, stt), call_metrics (conversation latency), dispatch_metrics (orchestration latency) and call_outcomes. Group by the provider columns to compare stacks. Conversation and orchestration timings are kept under separate prefixes and are never blended.';
