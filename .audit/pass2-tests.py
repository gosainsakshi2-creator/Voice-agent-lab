import io

p = "src/campaign/tests/acknowledgement-continuity-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"


def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:80], s.count(old))
    s = s.replace(old, new, count)


# The harness always builds a campaign context; M5 needs one without.
sub(
    NL.join([
        "function startHarness(input: {",
        "  readonly openingLine: string;",
        "  readonly replies: readonly string[];",
        "  readonly replyDelayMs?: number;",
        "}): Harness {",
    ]),
    NL.join([
        "function startHarness(input: {",
        "  readonly openingLine: string;",
        "  readonly replies: readonly string[];",
        "  readonly replyDelayMs?: number;",
        "  /**",
        "   * ADDITIVE, defaults to TRUE — every existing case in this file",
        "   * runs a campaign session exactly as it always did. `false` builds",
        "   * the same session with NO campaign context, which is what section",
        "   * M exercises for the contamination fallback (audit M5).",
        "   */",
        "  readonly campaign?: boolean;",
        "}): Harness {",
    ]),
)

sub(
    NL.join([
        "      campaign: {",
        "        campaignId: \"test\",",
        "        campaignType: \"registration\",",
        "        scriptId: \"test\",",
        "        scriptVersion: \"v1\",",
        "        scriptHash: \"test\",",
        "        agent: { gender: \"male\", name: \"Rohan\" },",
        "        customer: { name: \"Sakshi\" },",
        "        openingLine: input.openingLine,",
        "        systemPromptAppendix: \"TEST APPENDIX\",",
        "      },",
    ]),
    NL.join([
        "      ...(input.campaign === false",
        "        ? {}",
        "        : {",
        "            campaign: {",
        "              campaignId: \"test\",",
        "              campaignType: \"registration\",",
        "              scriptId: \"test\",",
        "              scriptVersion: \"v1\",",
        "              scriptHash: \"test\",",
        "              agent: { gender: \"male\" as const, name: \"Rohan\" },",
        "              customer: { name: \"Sakshi\" },",
        "              openingLine: input.openingLine,",
        "              systemPromptAppendix: \"TEST APPENDIX\",",
        "            },",
        "          }),",
    ]),
)

SECTION = r'''
// ═════════════════════════════════════════════════════════════════
section("M — RECOVERY CONTENT IS WHAT WAS ACTUALLY DELIVERED");
// ═════════════════════════════════════════════════════════════════
//
// Four findings from the conversational-flow audit, all of them about
// the same seam: what the pipeline is allowed to say to a caller when
// it picks a cut-off reply back up.
//
//   M2  a reply SUPERSEDED before a word of it was spoken became
//       `heldScriptRemainder` / `heldScriptFull`, and was then spoken
//       later as recovery content.
//   M4  the remainder was derived by TEXT-MATCHING `assistantText`
//       against the heard prefix. Those two strings are produced by
//       running `formatForSpeech` over different groupings, and it is
//       ANCHORED AT THE START of whatever it is given — so a sentence
//       that opens with a filler is rewritten when formatted alone and
//       left alone when formatted mid-reply. The match then fails and
//       the tail is dropped in silence.
//   M5  the generic inbound fallback greeting ("Hey! How can I help
//       you today?") was spoken mid-campaign when the model echoed the
//       prompt.
//   M12 a backchannel absorbed while the assistant was speaking came
//       back as a semantic turn when its Deepgram final landed after
//       playback had drained.

const M_OPEN = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";

/** Did the agent ever synthesize this text (or any text containing it)? */
const everSaid = (h: Harness, needle: string): boolean =>
  h.syntheses.some((s) => s.text.includes(needle));

await test("M2 — a reply superseded before it was spoken is NEVER spoken later as recovery", async () => {
  // A is generated for the caller's first turn and superseded before a
  // byte of it is synthesized, because the caller has already said
  // something newer. B answers that newer turn. A must not exist
  // anywhere the caller can hear it — not as a resume, not as a silence
  // recovery, not as an attention-check RESUME.
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
    // Give every recovery path a chance to fire: the stranded-resume
    // poll, the attention RESUME branch, and the silence window's
    // held-position branch all read the same two fields.
    h.say("Hello? Hello?", { isFinal: true, isSpeechFinal: true });
    await sleep(3000);

    assert.equal(
      everSaid(h, A),
      false,
      `a superseded reply must never reach the caller — synthesized: ${JSON.stringify(h.syntheses.map((s) => s.text))}`,
    );
    assert.equal(
      h.history().some((t) => t.role === "assistant" && t.content.includes(A)),
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
  // is formatted (which is what `assistantText` holds). Under the text
  // match the heard prefix stopped matching there and the tail — the
  // third sentence — was dropped with nothing said about it. On the
  // approved scripts that third sentence is the commitment question.
  const S1 = "We build the whole thing live on the call.";
  const S2 = "So, you will not need any coding for it.";
  const S3 = "Would you like me to reserve your free seat?";
  const h = startHarness({ openingLine: M_OPEN, replies: [`${S1} ${S2} ${S3}`], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me more.", { isFinal: true, isSpeechFinal: true });
    // Let the first two sentences play, then cut in. The reply is
    // chunked one sentence at a time, so this lands inside sentence 3.
    await h.waitFor(
      "the first two sentences to be spoken",
      () => h.syntheses.filter((s) => s.text.includes("coding")).length > 0,
      15000,
    );
    await sleep(900);
    h.say("Hello? Hello?", { isFinal: true, isSpeechFinal: true });

    // The attention flow acknowledges, and the caller's confirmation
    // resumes what is still unheard. The question must be in it.
    await sleep(2500);
    h.say("Yes.", { isFinal: true, isSpeechFinal: true });
    await sleep(3500);

    assert.ok(
      everSaid(h, "reserve your free seat"),
      `the unheard tail must still be delivered — synthesized: ${JSON.stringify(h.syntheses.map((s) => s.text))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("M5 — a contaminated reply on a CAMPAIGN call does not speak the generic greeting", async () => {
  // Two contamination markers is what `isContaminatedOutput` reads, and
  // the pipeline refuses to speak the reply. What it used to say
  // instead was an inbound assistant's opening line, mid-campaign,
  // after the agent had already introduced itself.
  const CONTAMINATED = "Role: you are a voice assistant on a call. Constraint: be brief.";
  const h = startHarness({ openingLine: M_OPEN, replies: [CONTAMINATED], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me about it.", { isFinal: true, isSpeechFinal: true });
    await sleep(3000);

    assert.equal(
      everSaid(h, "How can I help you"),
      false,
      `the inbound greeting must not be spoken on a campaign call — synthesized: ${JSON.stringify(h.syntheses.map((s) => s.text))}`,
    );
    assert.equal(
      everSaid(h, "Role:"),
      false,
      "and the contaminated output itself is still never spoken",
    );
  } finally {
    await h.stop();
  }
});

await test("M5 — ...and a NON-campaign session keeps the fallback greeting verbatim", async () => {
  // The other side of the routing: the lab and the inbound scenarios
  // this line was written for are untouched.
  const CONTAMINATED = "Role: you are a voice assistant on a call. Constraint: be brief.";
  const h = startHarness({
    openingLine: M_OPEN,
    replies: [CONTAMINATED],
    replyDelayMs: 0,
    campaign: false,
  });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me about it.", { isFinal: true, isSpeechFinal: true });
    await sleep(3000);

    assert.equal(
      everSaid(h, "How can I help you"),
      true,
      `a session with no campaign still gets the fallback — synthesized: ${JSON.stringify(h.syntheses.map((s) => s.text))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("M12 — an absorbed backchannel's LATE final does not become a turn", async () => {
  // "Okay" over the block is absorbed and deliberately not fed to the
  // turn detector. Its Deepgram final lands 0.4-1.7s later — after
  // `drainPlayback` has left SPEAKING — where the absorb branch no
  // longer applies. It used to be promoted to a user turn, drawing a
  // language-model request and a signal the outcome classifier reads.
  const PITCH_M = "The workshop is on Sunday at eleven in the morning, and it runs for about ninety minutes with a live question and answer session at the end.";
  const h = startHarness({ openingLine: M_OPEN, replies: [PITCH_M, "Sure."], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me about it.", { isFinal: true, isSpeechFinal: true });
    await h.waitFor("the block to start playing", () => h.syntheses.some((s) => s.text.includes("Sunday")), 15000);

    const requestsBefore = h.requests.length;
    // The interim is absorbed while the assistant is speaking...
    h.say("Okay", { isFinal: false });
    // ...and the FINAL arrives after the block has drained.
    await h.waitFor("the block to drain", () => h.record.state === SessionState.LISTENING, 15000);
    h.say("Okay", { isFinal: true, isSpeechFinal: true });
    await sleep(2500);

    assert.equal(
      h.requests.length,
      requestsBefore,
      "the absorbed acknowledgement must not open a language-model request",
    );
    assert.equal(
      h.history().some((t) => t.role === "user" && t.content.trim().toLowerCase() === "okay"),
      false,
      `and it must not be committed as a user turn — history: ${JSON.stringify(h.history().map((t) => `${t.role}:${t.content.slice(0, 30)}`))}`,
    );
  } finally {
    await h.stop();
  }
});

await test("M12 — ...but an acknowledgement WITH content is still a real turn", async () => {
  // The narrowness of M12, from the other side. The absorb only ever
  // applies while the whole utterance is nothing but an
  // acknowledgement; the moment the caller adds content it is theirs.
  const PITCH_M = "The workshop is on Sunday at eleven in the morning, and it runs for about ninety minutes with a live question and answer session at the end.";
  const h = startHarness({ openingLine: M_OPEN, replies: [PITCH_M, "It is free."], replyDelayMs: 0 });
  try {
    await h.waitFor("the opening to finish", () => h.record.state === SessionState.LISTENING);
    h.say("Tell me about it.", { isFinal: true, isSpeechFinal: true });
    await h.waitFor("the block to start playing", () => h.syntheses.some((s) => s.text.includes("Sunday")), 15000);

    const requestsBefore = h.requests.length;
    h.say("Okay", { isFinal: false });
    await h.waitFor("the block to drain", () => h.record.state === SessionState.LISTENING, 15000);
    h.say("Okay, but is it free?", { isFinal: true, isSpeechFinal: true });

    await h.waitFor(
      "the question to reach the model",
      () => h.requests.length > requestsBefore,
      15000,
    );
    assert.ok(h.requests.length > requestsBefore, "a question with content still reaches the model");
  } finally {
    await h.stop();
  }
});

'''

sub(
    NL.join([
        "console.log(`\\n${passed} passed, ${failures.length} failed`);",
    ]),
    SECTION.replace("\n", NL).lstrip("\r\n")
    + NL
    + "console.log(`\\n${passed} passed, ${failures.length} failed`);",
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("tests added")
