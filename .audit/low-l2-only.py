"""L2 only — the comment in the main loop's voicemail branch. L4 was
tried, disproved by `resume-accuracy` B2, and is not applied."""
import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

old = """        // machine costs no language-model request, no synthesis and no
        // script. The call then ends on the existing silence watchdog
        // once the recording stops talking — no hangup logic is added
        // to the pipeline, exactly as before."""

new = """        // machine costs no language-model request, no synthesis and no
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
        // audit 2026-09-23, L2)."""

o, n = old.replace("\n", NL), new.replace("\n", NL)
assert s.count(o) == 1, s.count(o)
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(o, n, 1))
print("L2 applied (comment only)")
