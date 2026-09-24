"""TEMPORARY probe — appends one characterization test to the identity
suite, so the M11 spelling gap can be shown end to end through the real
pipeline, then is removed again by `m11-probe-revert.py`.

Nothing here is meant to stay in the tree: the test it adds FAILS, which
is the point.
"""
import io
import shutil

SRC = "src/campaign/tests/identity-gate-tests.ts"
shutil.copyfile(SRC, ".audit/wip/identity-before-probe.ts")

s = io.open(SRC, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

anchor = 'console.log(`\\n${"═".repeat(60)}`);'
assert s.count(anchor) == 1, s.count(anchor)

PROBE = r'''await test("PROBE — Deepgram's unspaced 'Haanji.' answers the identity question", async () => {
  const r = await idFirst(["Haanji."]);
  assert.equal(r.llmRequests, 1, "the answer must open the gate");
  assert.equal(idAsks(r.spoken), 0, "and must not be re-asked");
});

await test("PROBE — ...and the spaced spelling of the same word already does", async () => {
  const r = await idFirst(["Haan ji."]);
  assert.equal(r.llmRequests, 1);
  assert.equal(idAsks(r.spoken), 0);
});

'''

s = s.replace(anchor, PROBE.replace("\n", NL) + anchor, 1)
io.open(SRC, "w", encoding="utf-8", newline="").write(s)
print("probe appended (TEMPORARY)")
