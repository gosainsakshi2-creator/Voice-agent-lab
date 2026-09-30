-- 008_name_pronunciations.sql
--
-- THE DEVANAGARI SPELLING OF EVERY CONTACT NAME, RESOLVED ONCE.
--
-- A TTS voice reads a romanized Indian name with English letter rules
-- ("Saurabh" -> "Sore-ab"). Written in Devanagari it is said the way its
-- owner says it. The committed table in
-- src/utils/name-pronunciations.generated.ts only holds a few hand-
-- checked names, and no hand list can keep up with every uploaded
-- contact list, so every other name is resolved by a model — at import,
-- in the background, or at the latest just before its first dial — and
-- stored here so it is never asked again, by any campaign or process.
-- See src/campaign/names/spoken-name-resolver.ts.
--
-- KEYED ON THE NAME ALONE (lower-cased, whitespace-collapsed, NFC). No
-- phone number, contact id or campaign id is stored: the row says how a
-- name is pronounced, not who has it.
--
-- `spoken` IS NULL when the model declined (not a name, or not one it
-- could write confidently). That answer is remembered too, so a bad row
-- in a contact list costs one request, not one per dial.
--
-- ADDITIVE AND NON-DESTRUCTIVE: a new table, read only by the resolver.
-- Without it every name is spoken as spelled, exactly as before.

CREATE TABLE IF NOT EXISTS name_pronunciations (
  name_key    TEXT PRIMARY KEY,
  spoken      TEXT,
  source      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
