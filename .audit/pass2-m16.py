import io

p = "src/core/session/system-prompt.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"


def sub(old, new, count=1):
    global s
    o = old.replace("\n", NL)
    n = new.replace("\n", NL)
    assert s.count(o) == count, (old[:70], s.count(o))
    s = s.replace(o, n, count)


# ── 1. the file header's statement of the contract ────────────────
sub(
    """ *  - An interrupted reply is CANCELLED and never committed to
 *    `ConversationMemory` (see the barge-in path in
 *    `ConversationPipeline.run`). The model therefore sees consecutive
 *    `user` turns with no assistant turn between them whenever a
 *    barge-in happened, which `# INTERRUPTIONS AND BARGE-IN` explains
 *    rather than leaving the model to guess.""",
    """ *  - An interrupted reply is committed AS FAR AS THE CALLER HEARD IT
 *    and no further (see the barge-in path in
 *    `ConversationPipeline.run`: the played prefix is recorded, the
 *    unplayed remainder is discarded). So the model sees a SHORT
 *    assistant turn that stops mid-thought, and — when the barge-in
 *    produced no turn of its own — sometimes consecutive `user` turns
 *    with nothing of its own between them. `# INTERRUPTIONS AND
 *    BARGE-IN` explains both shapes rather than leaving the model to
 *    guess.
 *
 *    This corrected a contract that had gone stale: the prompt used to
 *    assert an interrupted reply was "never committed", which stopped
 *    being true when the pipeline began committing the heard prefix so
 *    that "carry on from where you left off" could refer to something
 *    the model can actually see. Nothing about the runtime changed
 *    here; the description did (read-only audit 2026-09-23, M16).""",
)

# ── 2. the same claim, in the current-turn note's rationale ───────
sub(
    """ * now" marker, and an interrupted reply is never committed, so the
 * model regularly receives two user messages in a row with no assistant
 * turn between them — and on Gemma those are merged into ONE message""",
    """ * now" marker, and an interrupted reply is committed only as far as it
 * was heard, so the model regularly receives a stub of its own followed
 * by two user messages in a row — and on Gemma those are merged into ONE message""",
)

# ── 3. the section the model actually reads ──────────────────────
sub(
    """A reply that was cut off is UNCOMMITTED. Treat it as though it was never
said:

1. Stop speaking.
2. Do not treat the interrupted reply as a completed turn of yours.
3. Do not answer from it, and do not carry its unfinished question forward.
4. Let the caller finish their new thought.
5. Re-evaluate their CURRENT intent.
6. Use the rest of the conversation as context.
7. Answer their latest complete thought, once.

Because interrupted replies are dropped from the conversation record, you
will sometimes see two or more of the caller's turns in a row with nothing
of yours between them. That is what an interruption looks like from here.
Those consecutive turns usually belong to ONE developing thought. Read them
together and respond to the complete intent — not only the first fragment,
and not only the last.""",
    """A reply that was cut off is NOT a completed turn of yours. Treat it as
something you started saying and did not finish:

1. Stop speaking.
2. Do not treat the interrupted reply as a completed turn of yours.
3. Do not answer from it, and do not carry its unfinished question forward.
4. Let the caller finish their new thought.
5. Re-evaluate their CURRENT intent.
6. Use the rest of the conversation as context.
7. Answer their latest complete thought, once.

WHAT AN INTERRUPTION LOOKS LIKE FROM HERE. The record keeps exactly as
much of your reply as the caller actually heard, and nothing after it —
so one of your turns will simply stop mid-thought. Whatever it was
leading up to was never said out loud, and the caller cannot have heard
it. Do not treat it as a promise you have already kept, and do not
repeat the part they did hear.

You will also sometimes see two or more of the caller's turns in a row
with nothing of yours between them, which is the same event where none
of your reply had reached them yet. Those consecutive turns usually
belong to ONE developing thought: read them together and respond to the
complete intent — not only the first fragment, and not only the last.""",
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("M16 prompt contract corrected")
