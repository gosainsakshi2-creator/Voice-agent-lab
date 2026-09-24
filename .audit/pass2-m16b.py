"""M16, the pipeline half: the same retired contract, stated in the
function that BUILDS the prompt. Comment only — no runtime change."""
import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

old = """          // Marked as well as language-hinted. History has no "this one
          // is now" signal of its own, and a barge-in leaves two user
          // turns in a row with no assistant turn between them (the
          // interrupted reply is never committed) — which is exactly
          // when a reply comes back continuing the previous topic
          // instead of answering what was just asked."""

new = """          // Marked as well as language-hinted. History has no "this one
          // is now" signal of its own, and a barge-in leaves the model
          // looking at a turn of its own that stops mid-thought — or,
          // when nothing of the reply had reached the caller, at two
          // user turns in a row with no assistant turn between them
          // (only the part that was HEARD is committed; see
          // `cancelledHeardText`). Either shape is exactly when a reply
          // comes back continuing the previous topic instead of
          // answering what was just asked."""

o, n = old.replace("\n", NL), new.replace("\n", NL)
assert s.count(o) == 1, s.count(o)
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(o, n, 1))
print("M16 pipeline-side comment aligned")
