import io

p = "src/campaign/tests/acknowledgement-continuity-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"


def cut(start_marker, end_marker):
    """Return (before, body, after) around a test block."""
    i = s.index(start_marker)
    j = s.index(end_marker, i)
    return i, j


# ── replace the M2 test body ─────────────────────────────────────
m2_start = "await test(\"M2 — a reply superseded before it was spoken is NEVER spoken later as recovery\", async () => {"
m4_start = "await test(\"M4 — the tail after a cut survives a sentence the formatter rewrites\", async () => {"
m5_start = "await test(\"M5 — a contaminated reply on a CAMPAIGN call does not speak the generic greeting\", async () => {"

i2 = s.index(m2_start)
i4 = s.index(m4_start)
i5 = s.index(m5_start)

NEW = r'''await test("M2 — a reply superseded before it was spoken is NEVER spoken later as recovery", async () => {
  // A is generated for the caller's first turn and superseded before a
  // byte of it is synthesized, because the caller has already said
  // something newer. B answers that newer turn.
  //
  // WHAT USED TO HAPPEN. The commit site read the stranded remainder as
  // `unspokenTail(assistantText, heard)` with `heard` empty, which is
  // the WHOLE of A — so A became `heldScriptRemainder` /
  // `heldScriptFull`, and the next attention episode resumed it. The
  // caller was read an answer to a question they had already replaced.
  //
  // The episode has to be driven to its RESUME branch for that to show:
  // the FIRST check only opens the episode and acknowledges, and it is
  // the caller's confirmation after it that speaks the held position.
  const A = "The workshop covers the entire funnel from scratch, step by step.";
  const B = "Yes, it is completely free to attend.";
  const h = startHarness({ openingLine: M_OPEN, replies: [A, B], replyDelayMs: 900 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    // Turn 1 — the reply to this is A.
    h.say("Tell me about the workshop.", { isFinal: true, isSpeechFinal: true });
    // ...and, while A is still being generated, a NEWER turn. This is
    // what supersedes A before `speakingSignal` is ever created.
    await sleep(250);
    h.say("Actually, is it free?", { isFinal: true, isSpeechFinal: true });

    await h.waitForReplies(2);
    // Open the hearing episode...
    h.say("Hello? Hello?", { isFinal: true, isSpeechFinal: true });
    await sleep(2500);
    // ...and answer it, which is what reaches the RESUME branch.
    h.say("Yes.", { isFinal: true, isSpeechFinal: true });
    await sleep(3000);

    assert.equal(
      everSaid(h, "entire funnel"),
      false,
      `a superseded reply must never reach the caller — synthesized: ${JSON.stringify(h.syntheses.map((x) => x.text))}`,
    );
    assert.equal(
      h.history().some((t) => t.role === "assistant" && t.content.includes("entire funnel")),
      false,
      "and it must not be committed to history either",
    );
  } finally {
    await h.stop();
  }
});

await test("M4 — the tail after a cut survives a sentence the formatter rewrites", async () => {
  // THE REPRODUCTION. Sentence 2 opens with a discourse filler, so
  // `formatForSpeech` strips it when the sentence is formatted on its
  // own (which is how it is spoken) and leaves it when the whole reply
  // is formatted (which is what `assistantText` holds). The heard
  // prefix therefore stops matching at sentence 2, `unspokenTail`
  // returned "" — indistinguishable from "it was all heard" — and
  // sentence 3 was dropped with nothing said about it. On the approved
  // scripts sentence 3 is the commitment question.
  //
  // The cut has to land INSIDE sentence 3 for the remainder to be
  // interesting, so the check is sent the moment sentence 3 starts
  // playing rather than after a fixed wait.
  const S1 = "We build the whole thing live on the call.";
  const S2 = "So, you will not need any coding or design skills for any of it.";
  const S3 = "Would you like me to reserve your free seat for the session on Sunday morning?";
  const h = startHarness({ openingLine: M_OPEN, replies: [`${S1} ${S2} ${S3}`], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me more.", { isFinal: true, isSpeechFinal: true });

    // Sentence 3 has been handed to TTS: sentences 1 and 2 are queued
    // ahead of it and will have played by the time this lands.
    await h.waitFor(
      "sentence three to start",
      () => h.syntheses.some((x) => x.text.includes("reserve your free seat")),
      15000,
    );
    h.say("Hello? Hello?", { isFinal: true, isSpeechFinal: true });
    await sleep(2500);
    // The confirmation is what resumes whatever is still unheard.
    h.say("Yes.", { isFinal: true, isSpeechFinal: true });
    await sleep(3500);

    // The question must have been spoken AGAIN after the interruption —
    // once as the cut-off original, once as the resumed remainder.
    const timesAsked = h.syntheses.filter((x) => x.text.includes("reserve your free seat")).length;
    assert.ok(
      timesAsked >= 2,
      `the unheard tail must be re-delivered after the cut, saw it ${timesAsked} time(s) — ` +
        `synthesized: ${JSON.stringify(h.syntheses.map((x) => x.text))}`,
    );
  } finally {
    await h.stop();
  }
});

'''

s = s[:i2] + NEW.replace("\n", NL) + s[i5:]
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("M2/M4 tests strengthened")
