import io

p = "src/campaign/tests/acknowledgement-continuity-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

old_start = "// ── M2 AND M4 ARE NOT EXERCISABLE FROM THIS HARNESS ───────────────"
new_anchor = "await test(\"M5 — a contaminated reply on a CAMPAIGN call does not speak the generic greeting\", async () => {"

i = s.index(old_start)
j = s.index(new_anchor)

NOTE = r'''// ── M2 AND M4 ARE INVESTIGATED HERE AND DELIBERATELY NOT FIXED ────
//
// M4 — the remainder of a cut-off reply used to be derived as
// `unspokenTail(assistantText, heardText)`, a TEXT MATCH between two
// strings `formatForSpeech` produced over different groupings. It is
// anchored at the start of whatever it is given, so a sentence opening
// with a filler is rewritten when formatted alone (as it is spoken) and
// left alone inside the whole reply (as it is stored). The comparison
// then fails and the tail is reported as empty. That input/output fact
// is pinned deterministically in `test:resume-accuracy` section R.
//
// The obvious repair — keep the queued utterances that were not heard,
// so both sides are the same strings — CONFLICTS with an established
// fix and was reverted. `test:resume-accuracy` C1 ("a held remainder
// beginning mid-sentence is not re-capitalised") pins the remainder as
// a SLICE OF `assistantText`; the queued utterances are the
// per-sentence formatted form, which capitalises a piece that begins
// mid-sentence. The two encode opposite answers to "what is the
// canonical text of a reply" — the whole-formatted form that history,
// the classifier and the sheet read, or the per-piece form TTS was
// actually handed. Choosing between them is a product decision about
// the stored transcript, not a local repair, so it is reported rather
// than taken.
//
// M2 — a reply superseded before a word of it was spoken did become a
// held position under that same calculation (empty heard prefix ->
// the whole reply). It could not be reproduced: supersession requires
// a newer turn that TAKES THE FLOOR, and such a turn is a real
// contribution, whose branch in `handleAttentionCheck` clears
// `heldScriptRemainder` and `heldScriptFull` on the very next
// iteration — before any recovery path can read them.
//
// Neither is exercisable end to end from this harness in any case: the
// fake transport reports no playback backlog, so `heardSoFarText()`
// never settles on a PARTIAL set of queued utterances, and nothing in
// this file reaches "resuming a held script position". That is also why
// test 5 above, and the wider family of 15s "waiting for 3 replies"
// timeouts across the suites, fail on clean HEAD.

'''

s = s[:i] + NOTE.replace("\n", NL) + s[j:]
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("note corrected")
