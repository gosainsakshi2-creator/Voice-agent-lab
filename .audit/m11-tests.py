"""The two regressions for the M11 follow-up: one unit, one D2-shaped
end-to-end."""
import io

p = "src/campaign/tests/identity-gate-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"


def insert_before(anchor, block):
    global s
    a = anchor.replace("\n", NL)
    assert s.count(a) == 1, (anchor[:60], s.count(a))
    s = s.replace(a, block.replace("\n", NL) + a, 1)


# ── the unit test, beside the table it reads ──────────────────────
insert_before(
    'await test("A2. a denial is denied", () => {',
    r'''await test("A1b. the SPACED and UNSPACED spellings of the same word agree", () => {
  // Deepgram writes this word as one token as often as two, and the
  // table was matched whole-word, so " haanji " matched neither
  // " haan ji " nor " haan ". Half the renderings of the commonest
  // Hinglish confirmation read as `unclear`, which costs a re-ask and,
  // said the same way three times, ends the call on the right person.
  //
  // Asserted as an EQUIVALENCE rather than three separate verdicts:
  // what was wrong was not the reading of any one spelling but that
  // the spellings disagreed, and that is what must not come back.
  for (const said of ["Haan ji.", "Haanji.", "Hanji."]) {
    assert.equal(classifyIdentityAnswer(said, "Sakshi"), "confirmed", `"${said}"`);
  }
  // ...and the boundary: this adds a SPELLING, not vocabulary. A word
  // the gate does not accept spaced is not accepted unspaced either.
  assert.equal(classifyIdentityAnswer("Theekhai.", "Sakshi"), "unclear");
});

''',
)

# ── the end-to-end regression, beside D2 which it mirrors ─────────
insert_before(
    'await test("D3. the caller\'s bare \'Haan.\' is an ANSWER, not a pickup acknowledgement", async () => {',
    r'''await test("D2b. ...and Deepgram's UNSPACED 'Haanji.' confirms exactly as the spaced one does", async () => {
  // D2's twin, in the rendering the STT actually emits about half the
  // time. The gate used to read it `unclear` and put the question
  // again — "Sorry — Am I speaking with Sakshi?" — to a caller who had
  // just said yes. `idAsks` is therefore the assertion that matters:
  // zero means the opening asked once and the answer was taken.
  const r = await idFirst(["Haanji."]);
  assert.equal(r.llmRequests, 1, "the answer reached the gate and opened it");
  assert.equal(idAsks(r.spoken), 0, "and the caller is NOT re-asked what they just answered");
  assert.equal(pitched(r.spoken), true, "the introduction and purpose follow, as they do for D2");
});

''',
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("A1b and D2b added")
