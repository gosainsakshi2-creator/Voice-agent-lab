-- 007_tts_audio_cache.sql
--
-- SYNTHESIZED AUDIO FOR LINES THAT ARE THE SAME ON EVERY CALL.
--
-- "Hey, can you hear me okay?", the silence prompts, the fixed closes:
-- word for word identical across calls, customers and deploys, and each
-- one used to cost a TTS round trip (p50 ~180ms, p90 ~490ms on real
-- calls, 2026-09-28) every time it was said — usually at the exact
-- moment the caller is already waiting. This table is the shared tier
-- of `TtsAudioCache` (src/core/session/tts-audio-cache.ts): every server
-- process reads from it, and it survives restarts and deploys, which
-- the in-process tier in front of it does not.
--
-- CONTENT-ADDRESSED. `cache_key` is a SHA-256 over the TTS provider id,
-- the provider's own fingerprint of the request it would send (model,
-- voice, speed, sample rate, format — everything except the text; see
-- `TextToSpeechProvider.cacheIdentity`) and the exact text sent. A
-- changed voice or setting is a different key, so stale audio cannot be
-- served; it is simply never read again.
--
-- NO PERSONAL DATA. The pipeline never caches a line containing the
-- contact's name, and never caches model-generated text — only the
-- pipeline's and the script's fixed lines.
--
-- ADDITIVE AND NON-DESTRUCTIVE: a new table, referenced by nothing, read
-- by nothing but the cache. Dropping it loses nothing but speed: every
-- line is then synthesized live, exactly as before this migration.

CREATE TABLE IF NOT EXISTS tts_audio_cache (
  cache_key      TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL,
  encoding       TEXT NOT NULL,
  sample_rate_hz INTEGER NOT NULL CHECK (sample_rate_hz > 0),
  audio          BYTEA NOT NULL,
  byte_length    INTEGER NOT NULL CHECK (byte_length > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count      INTEGER NOT NULL DEFAULT 0
);

-- For pruning entries nothing has asked for in a long time (a voice that
-- was changed, a line that was re-worded).
CREATE INDEX IF NOT EXISTS tts_audio_cache_last_used_at_idx ON tts_audio_cache (last_used_at);
