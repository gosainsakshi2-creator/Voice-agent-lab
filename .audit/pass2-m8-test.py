import io

p = "src/campaign/tests/hearing-check-loop-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

anchor = "section(\"SECTION C — self-echo: what the guard suppresses, what the cap bounds\");"
assert s.count(anchor) == 1, s.count(anchor)

TEST = r'''await test("B8 — a NON-QUALIFYING check cannot hand the cap back: an alternating pattern still ends", async () => {
  // AUDIT M8. The counter's contract is stated at
  // `MAX_HEARING_LINES_WITHOUT_PROGRESS`: it is reset "by any turn that
  // is not answered with a fixed line — i.e. by the caller contributing
  // something meaningful". A turn that IS a presence check but merely
  // failed to QUALIFY for an acknowledgement — a single bare "Hello."
  // after a turn that was not a greeting — used to reset it anyway, and
  // that handed the whole budget back for nothing. Alternating a
  // qualifying check with a non-qualifying one then meant the cap was
  // never reached and the fixed lines could be drawn for the whole call.
  //
  // Asserted on the INVARIANT rather than on a fixed script of turns:
  // which particular utterance qualifies depends on what the previous
  // turn was (see `previousTurnWasBareGreeting`), and the cap has to
  // hold however the caller alternates. Nothing here changes the cap,
  // its value, or any increment — only that a non-qualifying check no
  // longer grants progress it did not make.
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4],
  });
  try {
    await blockDelivered(h);

    // Alternate the two shapes: a bare greeting (which qualifies only
    // when the PREVIOUS turn was one too) and a presence phrase (which
    // never leaves `lastTurnWasBareGreeting` set). Every second turn is
    // therefore non-qualifying, which is exactly the turn that used to
    // zero the counter.
    for (const said of ["Hello.", "Can you hear me?", "Hello.", "Can you hear me?", "Hello.", "Can you hear me?"]) {
      h.say(said);
      await sleep(2500);
    }

    assert.ok(
      hearingLinesSpoken(h) <= MAX_LINES,
      `at most ${MAX_LINES} fixed hearing lines however the caller alternates, ` +
        `got ${hearingLinesSpoken(h)}, spoken=${JSON.stringify(h.synthesized)}`,
    );
    assert.equal(spokenCount(h, BLOCK), 1, "and the block was never re-spoken");
    assert.equal(spokenCount(h, OPENING), 1, "nor was the opening line");
  } finally {
    await h.stop();
  }
});

await test("B9 — ...and a REAL contribution still hands the budget back", async () => {
  // The other side of B8, and the half that keeps the cap from becoming
  // a one-way trip. A turn with actual content resets the counter
  // exactly as it always did — that reset is the one at the top of
  // `handleAttentionCheck` and is untouched — so a caller who genuinely
  // cannot hear later in the call is acknowledged again rather than
  // being handed to the model for the rest of the call.
  const h = startHarness({
    openingLine: OPENING,
    replies: [BLOCK, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4, REPLY_2, REPLY_3, REPLY_4],
  });
  try {
    await blockDelivered(h);

    // Spend the budget.
    for (const said of ["Hello.", "Hello.", "Hello.", "Hello."]) {
      h.say(said);
      await sleep(2500);
    }
    const spent = hearingLinesSpoken(h);
    assert.equal(spent, MAX_LINES, `the budget is spent, spoken=${JSON.stringify(h.synthesized)}`);

    // A real question — meaningful, so the budget is genuinely handed
    // back and the next genuine check is acknowledged again.
    h.say("What time does it start?");
    await sleep(2500);
    for (const said of ["Hello.", "Hello."]) {
      h.say(said);
      await sleep(2500);
    }

    assert.ok(
      hearingLinesSpoken(h) > spent,
      `a real contribution resets the cap, spoken=${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

// ═════════════════════════════════════════════════════════════════
'''

s = s.replace(anchor, TEST.replace("\n", NL) + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("M8 tests added (v3)")
