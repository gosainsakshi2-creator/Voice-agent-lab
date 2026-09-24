"""M11 follow-up: the UNSPACED spelling of a confirmation already in the
table. Two entries in `CONFIRMATIONS`, nothing else."""
import io

p = "src/campaign/domain/identity-answer.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

old = """  "haan", "han", "ha ji", "haan ji", "ji haan", "ji", "bilkul", "sahi","""

new = """  "haan", "han", "ha ji", "haan ji", "ji haan", "ji", "bilkul", "sahi",
  // ── THE UNSPACED SPELLING OF THE ENTRY ABOVE ────────────────────
  //
  // Deepgram writes this word as one token as often as two, and
  // `contains` is whole-word containment over `normaliseText`, so
  // " haanji " matched neither " haan ji " nor " haan ". The commonest
  // Hinglish answer to "Am I speaking with Sakshi?" therefore read as
  // `unclear` in half its renderings: the caller confirmed, the gate
  // re-asked "Sorry — am I speaking with…?", and a caller who answers
  // the same way twice more is given up on by `MAX_IDENTITY_REASKS` —
  // the call ended on the RIGHT person (read-only audit 2026-09-23,
  // M11 follow-up).
  //
  // NOT NEW VOCABULARY, AND NOT A NEW DEVICE. `classifier.ts` already
  // carries these two spellings for this exact reason, with the same
  // note; this is the same repair `SELF_IDENTIFICATIONS` carries for
  // "that s me" and `QUESTIONS_BACK` for "who s this" — a rendering of
  // a phrase this table already accepts, so nothing the gate rejects
  // today becomes acceptable.
  //
  // SAFE AGAINST THE ORDER ABOVE IT. `QUESTIONS_BACK` and `DENIALS`
  // are both read BEFORE this table, so neither is affected, and the
  // hearing exclusion is decided before the gate ever calls this
  // function (`turnAnsweredHearingCheckOnly`) — so a "haanji" that
  // answered "can you hear me okay?" still cannot confirm identity.
  // Nothing in the attention, hearing or pickup vocabulary is touched:
  // `BARE_GREETING_ONLY`, `HEARING_CONFIRMATION_ONLY` and
  // `PICKUP_GREETING_ONLY` already carry their own spellings and are
  // not read from here.
  "haanji", "hanji","""

o, n = old.replace("\n", NL), new.replace("\n", NL)
assert s.count(o) == 1, s.count(o)
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(o, n, 1))
print("M11 follow-up: haanji/hanji added to CONFIRMATIONS")
