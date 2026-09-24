"""The two focused regressions for the LOW pass: L4 (both directions)
and the L3 regression net."""
import io

# ── L4 ────────────────────────────────────────────────────────────
p = "src/campaign/tests/speculative-llm-start-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

anchor = """// ═════════════════════════════════════════════════════════════════
console.log("""
assert s.count(anchor.replace("\n", NL)) == 1

BLOCK = r'''// ═════════════════════════════════════════════════════════════════
section("SECTION F — the skip predicate is the handler's, not a copy of it");
// ═════════════════════════════════════════════════════════════════
//
// `startSpeculation` declines to pre-open a request for a turn
// `handleAttentionCheck` will answer with a fixed line, because such a
// request could only ever be abandoned. It expressed that with its own
// copy of the handler's rule, and the copy went stale when the rule
// changed (audit L4). Both directions of the disagreement are pinned
// here, against the SAME two-turn sequence the handler's rule is made
// of: one bare greeting is a hello, two in a row is a hearing problem.

await test("F1 — a single bare greeting after a block reaches the model, so it is pre-opened like any other turn", async () => {
  const h = startHarness({ openingLine: OPENING, replies: ["R1", "R2"] });
  try {
    await h.waitForReplies(1);

    // A real turn first, so a block has been committed — this is the
    // state in which the stale copy and the handler disagreed.
    h.say("How much does it cost?", { isSpeechFinal: true });
    await h.waitForReplies(2);
    const afterBlock = h.requests.length;

    // ...and now ONE bare greeting, out of a clear sky. The handler
    // does not answer this: a single hello is a person saying hello,
    // and it takes the contextual path. So declining to pre-open it
    // bought nothing and cost the turn its head start.
    h.say("Hello.", { isSpeechFinal: true });
    await h.waitFor("a pre-opened request", () => h.requests.length > afterBlock, 400);
    assert.equal(
      h.requests[afterBlock]!.userTurnCommitted,
      false,
      "opened during the confirmation window, before the turn was committed",
    );
    await h.waitForReplies(3);
    assert.equal(h.requests.length, afterBlock + 1, "adopted — one request for the turn, not two");
  } finally {
    await h.stop();
  }
});

await test("F2 — ...but the SECOND bare greeting is answered with a fixed line, and still spends nothing", async () => {
  // The other direction, and the reason the predicate cannot simply be
  // dropped. This turn IS the handler's — a strict check whose previous
  // turn was a bare greeting — so no request may be opened for it, not
  // even one that would be abandoned a moment later.
  const h = startHarness({ openingLine: OPENING, replies: ["R1", "R2"] });
  try {
    await h.waitForReplies(1);
    h.say("How much does it cost?", { isSpeechFinal: true });
    await h.waitForReplies(2);

    h.say("Hello.", { isSpeechFinal: true });
    await h.waitForReplies(3);
    const beforeSecond = h.requests.length;

    h.say("Hello.", { isSpeechFinal: true });
    await h.waitForReplies(4);
    assert.equal(
      h.requests.length,
      beforeSecond,
      "the repeated greeting is answered by the fixed hearing line — zero requests, pre-opened or otherwise",
    );
    assert.ok(
      h.synthesized.some((t) => t.includes("hear me okay")),
      `the fixed line was spoken: ${JSON.stringify(h.synthesized)}`,
    );
  } finally {
    await h.stop();
  }
});

'''

s = s.replace(anchor.replace("\n", NL), BLOCK.replace("\n", NL) + anchor.replace("\n", NL), 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("L4 tests added")

# ── L3 net ────────────────────────────────────────────────────────
p2 = "src/campaign/tests/ending-transition-tests.ts"
t = io.open(p2, encoding="utf-8", newline="").read()
NL2 = "\r\n" if t.count("\r\n") > 0 else "\n"

anchor2 = 'console.log(`\\n${"═".repeat(60)}`);'
assert t.count(anchor2) == 1, t.count(anchor2)

NET = r'''await test("A3. the machine's greeting is recorded EXACTLY once, whichever route records it", async () => {
  // TWO SITES CAN RECORD IT. `hangUpOnVoicemail` records the phrase
  // itself, because it ends the call before the turn detector would
  // have released anything and an empty transcript files the call as an
  // ordinary silent one; the main loop's voicemail branch records a
  // turn that WAS released, for the same reason. `host.end` is not
  // awaited, so which of them runs is a race — and both running is a
  // transcript with the machine's words in it twice, which the outcome
  // classifier reads signal-per-phrase.
  //
  // HONEST ABOUT WHAT THIS IS: a regression net, not a reproduction.
  // On this harness the hangup wins the race every time and the phrase
  // is recorded once, so this passes today; what it pins is the
  // invariant, so a change that lets both sites fire is caught here
  // rather than in the stored transcripts (read-only audit
  // 2026-09-23, L3).
  let ended = 0;
  let harness: Harness | undefined;
  const h = startHarness({
    onEndFromPipeline: () => {
      ended += 1;
      harness?.endLikeTheManager();
    },
  });
  harness = h;
  try {
    await greetingDone(h);
    h.say("Please leave a message after the tone.");
    await h.waitFor("the pipeline to end its own call", () => ended > 0);
    await sleep(600);

    const machineTurns = h.record.memory
      .history()
      .filter((turn) => turn.role === "user" && turn.content.includes("leave a message"));
    assert.equal(
      machineTurns.length,
      1,
      `the machine's words belong in the transcript once: ${JSON.stringify(machineTurns.map((x) => x.content))}`,
    );
  } finally {
    await h.stop();
  }
});

'''

t = t.replace(anchor2, NET.replace("\n", NL2) + anchor2, 1)
io.open(p2, "w", encoding="utf-8", newline="").write(t)
print("L3 net added")
