"""LOW cleanup pass — L2 (comment contradicts code) and L4 (the
speculation skip predicate no longer matches the handler it quotes)."""
import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"


def sub(old, new):
    global s
    o, n = old.replace("\n", NL), new.replace("\n", NL)
    assert s.count(o) == 1, (old[:60], s.count(o))
    s = s.replace(o, n, 1)


# ── L2 — the main loop's voicemail branch describes a call that ends
#        on the silence watchdog. It has not ended that way since the
#        live hangup was added; this branch is now the SAFETY NET for a
#        turn released before that hangup takes effect.
sub(
    """        // machine costs no language-model request, no synthesis and no
        // script. The call then ends on the existing silence watchdog
        // once the recording stops talking — no hangup logic is added
        // to the pipeline, exactly as before.""",
    """        // machine costs no language-model request, no synthesis and no
        // script.
        //
        // AND THIS IS THE SAFETY NET, NOT THE USUAL ROUTE. The comment
        // here used to say the call then ends on the silence watchdog
        // and that no hangup logic exists in the pipeline. Neither has
        // been true since `hangUpOnVoicemail`: detection fires on the
        // STT listener, records the machine's words itself and calls
        // `host.end` at once, so the line is released immediately
        // rather than held open. `end` is not awaited, so a turn the
        // detector had already released can still reach this branch
        // before the loop is aborted — which is exactly what this is
        // for, and why it records rather than dropping (read-only
        // audit 2026-09-23, L2).""",
)

# ── L4 — the skip predicate quotes `handleAttentionCheck`'s no-remainder
#        branch, and stopped matching it when that branch was changed.
sub(
    """    // FIX 2 — the same predicate `handleAttentionCheck`'s no-remainder
    // branch applies: a turn it will answer with a fixed line never
    // reaches the model, so a request pre-opened for it would only be
    // abandoned. Same family as the two guards on the line above.
    if (this.contextualReplyCommitted ? isHearingCheck(text) : isEmphaticHearingCheck(text)) return;""",
    """    // FIX 2 — the same predicate `handleAttentionCheck`'s no-remainder
    // branch applies: a turn it will answer with a fixed line never
    // reaches the model, so a request pre-opened for it would only be
    // abandoned. Same family as the two guards on the line above.
    //
    // KEPT IN STEP WITH THAT BRANCH, WHICH IS THE WHOLE POINT OF IT.
    // This used to read `contextualReplyCommitted ? isHearingCheck :
    // isEmphaticHearingCheck` — the rule the handler applied when this
    // guard was written. The handler's rule then changed to "an
    // unmistakable check, OR a strict check whose PREVIOUS turn was a
    // bare greeting", and this copy did not, so the two disagreed in
    // both directions: after a block a single bare "Hello." was
    // declined here although the handler hands it to the model (the
    // pre-open, and the latency it buys, was lost for nothing), and
    // before any block a repeated bare greeting was pre-opened
    // although the handler answers it with a fixed line (a request
    // paid for and thrown away). Reading the handler's own flag is
    // what keeps them from drifting again — no new state, no new
    // vocabulary, and the spoken behaviour on both paths is
    // identical either way (read-only audit 2026-09-23, L4).
    if (isEmphaticHearingCheck(text) || (this.lastTurnWasBareGreeting && isHearingCheck(text))) return;""",
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("L2 + L4 applied")
