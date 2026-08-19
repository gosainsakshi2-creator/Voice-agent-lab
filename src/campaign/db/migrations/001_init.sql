-- 001_init.sql
--
-- Campaign layer foundation. Creates the persistence the campaign
-- orchestration layer needs and NOTHING the existing voice agent
-- touches: no table here is read or written by the voice pipeline,
-- which remains entirely in-memory and unchanged.
--
-- Two guarantees are enforced by PostgreSQL itself rather than by
-- application code, because they are the guarantees the whole
-- campaign design rests on:
--
--   1. ONE NUMBER, ONE PROVIDER, FOREVER.
--      contacts_one_number_per_campaign makes a second row for the
--      same number impossible, and contacts_provider_immutable makes
--      changing that row's provider impossible. A cross-provider
--      reassignment is therefore not a bug we have to avoid writing;
--      it is a transaction that cannot commit.
--
--   2. NO ATTEMPT ON THE WRONG PROVIDER.
--      call_attempts_provider_guard re-reads the contact's assignment
--      on every insert and update and refuses any attempt that
--      disagrees with it, so even a buggy retry planner cannot dial a
--      number through a provider it was not assigned to.
--
-- Metric separation is also structural: call_metrics holds VOICE
-- CONVERSATION measurements produced by the existing, untouched
-- SessionMetricsCollector, while dispatch_metrics holds CAMPAIGN
-- ORCHESTRATION measurements produced by new code. They are separate
-- tables so no query can average a database write latency into a TTS
-- latency.

-- ── Enumerated states ────────────────────────────────────────────
-- Deliberately separate from the voice agent's own SessionState (see
-- constants/session-states.constants.ts, untouched). The two state
-- machines describe different things and must not be coupled.

CREATE TYPE campaign_status AS ENUM (
  'DRAFT', 'IMPORTING', 'READY', 'RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED'
);

CREATE TYPE call_status AS ENUM (
  'PENDING', 'ASSIGNED', 'QUEUED', 'DIALING', 'RINGING', 'ANSWERED',
  'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'
);

-- ── campaigns ────────────────────────────────────────────────────

CREATE TABLE campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  campaign_type       text NOT NULL,
  status              campaign_status NOT NULL DEFAULT 'DRAFT',

  -- Which script ran, and proof of exactly which text it was.
  script_id           text NOT NULL,
  script_version      text NOT NULL,
  script_hash         text NOT NULL,

  -- Percentages, never counts:
  -- {"cartesia":33.33,"sarvam":33.33,"smallest-ai":33.34}
  provider_allocation jsonb NOT NULL,
  telephony_provider  text NOT NULL,
  language            text NOT NULL,

  -- Concurrency, CPS and retry policy snapshotted at launch, so a
  -- later config edit cannot retroactively change how a running
  -- campaign behaved.
  dispatch_config     jsonb NOT NULL DEFAULT '{}'::jsonb,

  total_contacts      integer NOT NULL DEFAULT 0,

  -- Pilot ladder position (0=10, 1=50, 2=100, 3=500, 4=full). The
  -- gate table that enforces it arrives with the dispatcher phase.
  pilot_stage         integer NOT NULL DEFAULT 0,

  -- A refreshed browser or a retried request must not create a
  -- second campaign.
  idempotency_key     text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz
);

CREATE UNIQUE INDEX campaigns_idempotency_key_idx
  ON campaigns (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX campaigns_status_idx ON campaigns (status, created_at DESC);

-- ── contacts ─────────────────────────────────────────────────────

CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  name               text,
  normalized_phone   text NOT NULL,
  original_phone     text NOT NULL,
  call_type          text,

  -- Every additional CSV column is preserved here verbatim, so an
  -- unexpected column is never silently dropped on import.
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  csv_row_number     integer,

  -- THE LOCK. Written once at import, inside the same transaction as
  -- the insert, and immutable from that moment (see trigger below).
  assigned_provider  text NOT NULL,
  assigned_at        timestamptz NOT NULL DEFAULT now(),

  status             call_status NOT NULL DEFAULT 'PENDING',
  attempt_count      integer NOT NULL DEFAULT 0,
  next_attempt_after timestamptz,

  -- Set by the SKIP LOCKED claim so a crashed worker's rows are
  -- identifiable on recovery.
  claimed_by         text,
  claimed_at         timestamptz,
  last_status_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contacts_one_number_per_campaign
    UNIQUE (campaign_id, normalized_phone),
  CONSTRAINT contacts_attempt_count_non_negative
    CHECK (attempt_count >= 0)
);

-- Supports the dispatcher's per-lane claim query.
CREATE INDEX contacts_dispatch_idx
  ON contacts (campaign_id, assigned_provider, status, next_attempt_after);

CREATE OR REPLACE FUNCTION contacts_lock_provider() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.assigned_provider IS DISTINCT FROM OLD.assigned_provider THEN
    RAISE EXCEPTION
      'assigned_provider is immutable: contact % is locked to "%", refused change to "%"',
      OLD.id, OLD.assigned_provider, NEW.assigned_provider
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contacts_provider_immutable
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_lock_provider();

-- ── call_attempts ────────────────────────────────────────────────

CREATE TABLE call_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  attempt_number     integer NOT NULL,
  provider           text NOT NULL,
  telephony_provider text NOT NULL,

  -- Correlation handles. session_id ties back to the existing
  -- in-memory VoiceSessionManager; provider_call_id is the carrier's
  -- request_uuid. Both unique, so a webhook resolves to exactly one
  -- attempt without any in-memory map to lose on restart.
  session_id         text,
  provider_call_id   text,

  status             call_status NOT NULL DEFAULT 'ASSIGNED',

  -- Honesty about provenance: 'observed' (we saw it happen),
  -- 'inferred' (deduced from a timeout), 'carrier' (reported to us).
  -- Until a status callback exists, NO_ANSWER and BUSY are 'inferred'
  -- and must never be presented as carrier-reported.
  status_source      text NOT NULL DEFAULT 'observed',

  dialed_at          timestamptz,
  answered_at        timestamptz,
  ended_at           timestamptz,
  duration_seconds   numeric(10,3),
  ring_seconds       numeric(10,3),

  hangup_reason      text,
  failure_reason     text,
  failure_class      text,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: a retried request, a duplicated worker, or a
  -- dispatcher restarting mid-dial cannot create a second attempt row
  -- for the same attempt number, so it cannot place a second call.
  CONSTRAINT call_attempts_contact_attempt_unique
    UNIQUE (contact_id, attempt_number),
  CONSTRAINT call_attempts_attempt_number_positive
    CHECK (attempt_number >= 1)
);

CREATE UNIQUE INDEX call_attempts_session_id_idx
  ON call_attempts (session_id) WHERE session_id IS NOT NULL;

CREATE UNIQUE INDEX call_attempts_provider_call_id_idx
  ON call_attempts (provider_call_id) WHERE provider_call_id IS NOT NULL;

CREATE INDEX call_attempts_campaign_provider_idx
  ON call_attempts (campaign_id, provider, status);

CREATE INDEX call_attempts_contact_idx ON call_attempts (contact_id);

CREATE OR REPLACE FUNCTION call_attempts_match_assignment() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  assigned_provider_value text;
  owning_campaign_id      uuid;
BEGIN
  SELECT c.assigned_provider, c.campaign_id
    INTO assigned_provider_value, owning_campaign_id
    FROM contacts c
   WHERE c.id = NEW.contact_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'call attempt references unknown contact %', NEW.contact_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.provider IS DISTINCT FROM assigned_provider_value THEN
    RAISE EXCEPTION
      'cross-provider attempt refused: contact % is locked to "%", attempt requested "%"',
      NEW.contact_id, assigned_provider_value, NEW.provider
      USING ERRCODE = '23514';
  END IF;

  IF NEW.campaign_id IS DISTINCT FROM owning_campaign_id THEN
    RAISE EXCEPTION
      'campaign mismatch: contact % belongs to campaign %, attempt claims %',
      NEW.contact_id, owning_campaign_id, NEW.campaign_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER call_attempts_provider_guard
  BEFORE INSERT OR UPDATE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION call_attempts_match_assignment();

-- ── call_outcomes ────────────────────────────────────────────────
-- Business result. detail is JSONB and GIN-indexed so a new outcome
-- field is queryable the day it appears, with no migration. Only
-- succeeded and primary_reason are read by analytics, so a new
-- campaign type can never break an existing report.

CREATE TABLE call_outcomes (
  call_attempt_id uuid PRIMARY KEY REFERENCES call_attempts(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  outcome_type    text NOT NULL,
  schema_version  integer NOT NULL DEFAULT 1,

  succeeded       boolean,
  primary_reason  text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,

  classifier      text,
  classified_at   timestamptz NOT NULL DEFAULT now(),

  -- Kept so a refined success rubric can be re-run over stored
  -- transcripts instead of re-calling people.
  transcript      jsonb
);

CREATE INDEX call_outcomes_detail_idx ON call_outcomes USING gin (detail);
CREATE INDEX call_outcomes_campaign_idx
  ON call_outcomes (campaign_id, outcome_type, succeeded);

-- ── call_metrics — VOICE CONVERSATION ONLY ───────────────────────
-- Sourced verbatim from the existing BenchmarkMetrics object produced
-- by the untouched SessionMetricsCollector. raw keeps the whole
-- object so a measurement nobody thought to promote is still
-- recoverable later.

CREATE TABLE call_metrics (
  call_attempt_id      uuid PRIMARY KEY REFERENCES call_attempts(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  provider             text NOT NULL,

  turn_count           integer,
  conversation_seconds numeric(10,3),

  stt_p50_ms           integer,
  llm_p50_ms           integer,
  tts_p50_ms           integer,
  total_p50_ms         integer,
  first_turn_total_ms  integer,

  cost_telephony_usd   numeric(12,6),
  cost_stt_usd         numeric(12,6),
  cost_llm_usd         numeric(12,6),
  cost_tts_usd         numeric(12,6),
  cost_total_usd       numeric(12,6),

  raw                  jsonb NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX call_metrics_campaign_provider_idx
  ON call_metrics (campaign_id, provider);

-- ── dispatch_metrics — CAMPAIGN ORCHESTRATION ONLY ───────────────
-- Deliberately a SEPARATE table from call_metrics. Mixing the two
-- would let a slow database write masquerade as a slow TTS provider,
-- which is precisely the comparison this campaign exists to get
-- right. No view may join them into a single "latency" figure.

CREATE TABLE dispatch_metrics (
  call_attempt_id          uuid PRIMARY KEY REFERENCES call_attempts(id) ON DELETE CASCADE,
  campaign_id              uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  provider                 text NOT NULL,

  queue_wait_ms            integer,  -- became eligible -> claimed
  claim_to_dial_ms         integer,  -- claimed         -> startCall issued
  dial_request_ms          integer,  -- telephony REST round trip
  dial_to_ring_ms          integer,
  ring_to_answer_ms        integer,
  answer_to_first_audio_ms integer,  -- handover into the existing pipeline
  persist_ms               integer,  -- result write
  classify_ms              integer,  -- post-call outcome classification

  recorded_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dispatch_metrics_campaign_provider_idx
  ON dispatch_metrics (campaign_id, provider);

-- ── webhook_events ───────────────────────────────────────────────
-- Dedupe-first storage. A handler inserts with ON CONFLICT DO NOTHING
-- RETURNING id; no row back means the delivery is a duplicate and is
-- dropped. Carrier retries therefore cost nothing.

CREATE TABLE webhook_events (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  event_type   text NOT NULL,
  dedupe_key   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,

  CONSTRAINT webhook_events_dedupe UNIQUE (source, event_type, dedupe_key)
);

CREATE INDEX webhook_events_unprocessed_idx
  ON webhook_events (received_at) WHERE processed_at IS NULL;

-- ── campaign_events ──────────────────────────────────────────────
-- Append-only operations log, so a post-mortem never depends on
-- terminal scrollback.

CREATE TABLE campaign_events (
  id          bigserial PRIMARY KEY,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id  uuid,
  attempt_id  uuid,
  level       text NOT NULL DEFAULT 'info',
  code        text NOT NULL,
  message     text,
  data        jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_events_campaign_idx ON campaign_events (campaign_id, at DESC);
CREATE INDEX campaign_events_code_idx ON campaign_events (code, at DESC);

-- ── dispatcher_locks ─────────────────────────────────────────────
-- One dispatcher per campaign, across restarts and duplicate deploys.
-- A stale heartbeat lets a restarted process take over.

CREATE TABLE dispatcher_locks (
  scope        text PRIMARY KEY,
  owner        text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
