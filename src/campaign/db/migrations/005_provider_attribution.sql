-- 005_provider_attribution.sql
--
-- WHICH PROVIDERS ACTUALLY HANDLED EACH CALL.
--
-- The campaign can now split three INDEPENDENT dimensions by
-- percentage — TTS, language model, telephony — so "what this campaign
-- is configured to do" and "what this call actually did" have stopped
-- being the same sentence. Only the second one can answer "how fast is
-- GPT-5.1 + Sarvam + Vobiz?", and only if it is recorded per call.
--
-- Two of the three were already here and are UNCHANGED:
--
--   call_attempts.provider            the contact's locked TTS lane
--   call_attempts.telephony_provider  the carrier
--
-- The language model was not recorded anywhere, because until now
-- there was nothing to record: the runtime carried a "gpt-5.1" string
-- literal, so every call had the same answer. This migration adds the
-- one missing column and nothing else.
--
-- ADDITIVE AND NON-DESTRUCTIVE, deliberately:
--
--   - The column is NULLABLE with NO default and NO backfill. Rows
--     written before this migration genuinely do not record which
--     model ran, and NULL says exactly that. Backfilling them with
--     'gpt-5.1' would be a guess — a correct-looking one, since that
--     literal is what they ran, but written into a column whose whole
--     purpose is to hold an observation. An analyst filtering on
--     llm_provider should see historical rows absent, not silently
--     folded into the GPT-5.1 population.
--   - No column is dropped, renamed, retyped or re-constrained.
--   - No trigger is added or altered. In particular the existing
--     call_attempts_provider_guard, which re-reads the contact's
--     locked TTS assignment on every insert and update, is untouched
--     and still refuses any cross-provider attempt.
--
-- Re-runnable: every statement is IF NOT EXISTS / OR REPLACE, so a
-- partially-applied run can be repeated safely.

-- ── The one missing actual-provider column ───────────────────────

ALTER TABLE call_attempts
  ADD COLUMN IF NOT EXISTS llm_provider text;

COMMENT ON COLUMN call_attempts.llm_provider IS
  'Canonical id of the language model that ACTUALLY ran this call, resolved from the campaign''s LLM allocation at dial time. NULL for attempts predating provider attribution. Never the configured allocation.';

-- Supports "group the stack by model", which is the question this
-- column exists for. Partial, so the NULL historical rows cost nothing.
CREATE INDEX IF NOT EXISTS call_attempts_llm_provider_idx
  ON call_attempts (campaign_id, llm_provider, status)
  WHERE llm_provider IS NOT NULL;

-- Supports the full three-dimensional grouping without a sequential
-- scan once several stacks are in play within one campaign.
CREATE INDEX IF NOT EXISTS call_attempts_stack_idx
  ON call_attempts (campaign_id, provider, llm_provider, telephony_provider);

-- ── The stack view ───────────────────────────────────────────────
--
-- A READ-ONLY JOIN, not a new table and not a copy. Provider identity
-- lives in exactly one place — call_attempts — and this view reaches
-- it, so there is no second copy to drift. It exists because the
-- alternative is every analyst hand-writing the same three-way join
-- and getting the call_metrics/dispatch_metrics distinction wrong.
--
-- THE SEPARATION IS PRESERVED. call_metrics holds VOICE CONVERSATION
-- measurements and dispatch_metrics holds CAMPAIGN ORCHESTRATION
-- measurements; 001_init.sql is explicit that no view may merge them
-- into a single "latency" figure. This view keeps every column under
-- its own name and its own prefix, and computes no blended total, so
-- a database write latency still cannot be averaged into a TTS
-- latency.
--
-- LEFT JOINs throughout: an attempt that never connected has no
-- metrics, and it must still appear here with its providers, so
-- "which stacks fail to connect" stays answerable.

CREATE OR REPLACE VIEW call_stack_stats AS
SELECT
  a.id                            AS call_attempt_id,
  a.campaign_id,
  a.contact_id,
  a.attempt_number,
  a.status,
  a.hangup_reason,
  a.failure_class,

  -- The three actual providers. The grouping keys.
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

  -- Turn level, median across the call. Straight from the existing
  -- collector's promoted columns; nothing is recomputed here.
  m.stt_p50_ms,
  m.llm_p50_ms,
  m.tts_p50_ms,
  m.total_p50_ms,
  m.first_turn_total_ms,

  -- Cost. cost_llm_usd is NULL, not 0, for a model with no confirmed
  -- commercial rate — see cost-estimator.ts. Do not COALESCE it to 0
  -- in a report: that is the difference between "free" and "unknown".
  m.cost_telephony_usd,
  m.cost_stt_usd,
  m.cost_llm_usd,
  m.cost_tts_usd,
  m.cost_total_usd,

  -- Orchestration. Deliberately prefixed so no query can confuse a
  -- dispatcher timing with a conversation timing.
  d.queue_wait_ms                 AS dispatch_queue_wait_ms,
  d.claim_to_dial_ms              AS dispatch_claim_to_dial_ms,
  d.dial_request_ms               AS dispatch_dial_request_ms,
  d.ring_to_answer_ms             AS dispatch_ring_to_answer_ms,
  d.answer_to_first_audio_ms      AS dispatch_answer_to_first_audio_ms,

  -- Business result, so a stack can be judged on outcomes and not only
  -- on speed.
  o.outcome_type,
  o.succeeded,
  o.primary_reason

FROM call_attempts a
LEFT JOIN call_metrics     m ON m.call_attempt_id = a.id
LEFT JOIN dispatch_metrics d ON d.call_attempt_id = a.id
LEFT JOIN call_outcomes    o ON o.call_attempt_id = a.id;

COMMENT ON VIEW call_stack_stats IS
  'Read-only join of call_attempts (the three actual provider ids), call_metrics (conversation latency), dispatch_metrics (orchestration latency) and call_outcomes. Group by tts_provider/llm_provider/telephony_provider to compare stacks. Conversation and orchestration timings are kept under separate prefixes and are never blended.';
