"""TEMPORARY probe for L3 — does the machine's greeting reach the
transcript once, or twice? Prints the recorded user turns."""
import io
import shutil

SRC = "src/campaign/tests/ending-transition-tests.ts"
shutil.copyfile(SRC, ".audit/wip/ending-before-l3.ts")

s = io.open(SRC, encoding="utf-8", newline="").read()
NL = "\r\n" if s.count("\r\n") > 0 else "\n"

anchor = 'console.log(`\\n${"═".repeat(60)}`);'
if s.count(anchor) != 1:
    anchor = 'console.log("\\n" + "═".repeat(60));'
assert s.count(anchor) == 1, s.count(anchor)

PROBE = r'''await test("PROBE — how many times is the machine's greeting recorded?", async () => {
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
    await sleep(800);
    const user = h.record.memory.history().filter((t) => t.role === "user");
    console.log(`PROBE user turns = ${JSON.stringify(user.map((t) => t.content))}`);
  } finally {
    await h.stop();
  }
});

'''

s = s.replace(anchor, PROBE.replace("\n", NL) + anchor, 1)
io.open(SRC, "w", encoding="utf-8", newline="").write(s)
print("L3 probe appended (TEMPORARY)")
