import io

# ── 1. drop the two vacuous pipeline tests from the ack-continuity file
p = "src/campaign/tests/acknowledgement-continuity-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

m2_start = "await test(\"M2 — a reply superseded before it was spoken is NEVER spoken later as recovery\", async () => {"
m5_start = "await test(\"M5 — a contaminated reply on a CAMPAIGN call does not speak the generic greeting\", async () => {"
i2 = s.index(m2_start)
i5 = s.index(m5_start)

NOTE = r'''// ── M2 AND M4 ARE NOT EXERCISABLE FROM THIS HARNESS ───────────────
//
// Both are about the remainder of a reply the caller heard only part
// of, and this harness never produces one: the fake transport reports
// no playback backlog, so `heardSoFarText()` never settles on a
// PARTIAL set of queued utterances. Nothing in this file reaches
// "RESUMING the unheard remainder" or "resuming a held script
// position" — which is also why test 5 above, and the wider family of
// 15s "waiting for 3 replies" timeouts across the suites, fail on
// clean HEAD.
//
// So the two findings are proved where they are actually decidable:
//
//   M4  `test:resume-accuracy` section R — the two representations the
//       old remainder calculation compared, and the exact input on
//       which that comparison silently returns "".
//   M2  not reproducible at all: the turn that SUPERSEDES a reply is
//       by construction a floor-taking contribution, and the
//       contribution branch of `handleAttentionCheck` clears
//       `heldScriptRemainder` / `heldScriptFull` on the very next
//       iteration — before any recovery path can read them. The
//       pipeline change makes it structurally impossible regardless;
//       see `cancelledUnheardText`.

'''

s = s[:i2] + NOTE.replace("\n", NL) + s[i5:]
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("vacuous M2/M4 harness tests removed, note added")

# ── 2. add the deterministic representation test to resume-accuracy
p2 = "src/campaign/tests/barge-in-resume-accuracy-tests.ts"
t = io.open(p2, encoding="utf-8", newline="").read()

anchor = "console.log(`\\n${failures.length === 0 ? \"ALL PASSED\" : \"FAILURES\"} — ${passed} passed, ${failures.length} failed`);"
assert t.count(anchor) == 1, t.count(anchor)

SECTION = r'''// ═════════════════════════════════════════════════════════════════
// SECTION R — THE REMAINDER IS NOT A TEXT MATCH (audit M4)
// ═════════════════════════════════════════════════════════════════
//
// The stranded remainder used to be derived as
// `unspokenTail(assistantText, heardText)`. Those two strings are both
// produced by `formatForSpeech`, but over DIFFERENT GROUPINGS:
//
//   assistantText  `toSpokenText(<the whole reply>)`   — formatted once
//   heardText      the queued utterances joined         — formatted per
//                                                         sentence
//
// and `formatForSpeech` is ANCHORED AT THE START of whatever it is
// handed: it strips a leading hesitation or discourse filler and
// re-capitalises what is left. A sentence that opens with one is
// therefore rewritten when it is formatted alone — which is how it is
// spoken — and left untouched when it sits in the middle of the whole
// reply. The heard prefix then stops matching there, `unspokenTail`
// reports "" and the caller is owed nothing, which is
// indistinguishable from "they heard all of it".
//
// These cases are the input on which that happens. The pipeline no
// longer performs the comparison at all — it keeps the queued
// utterances that were not heard (`cancelledUnheardText`), so the two
// sides are the same strings by construction — and this section pins
// the hazard that made the change necessary, from both directions.

const { unspokenTail: tailOf } = await import("../../core/session/conversation-pipeline");
const { formatForSpeech: fmt } = await import("../../utils/speech-formatter");

/** The reply as stored: the formatter run ONCE over everything. */
const wholeReply = (...sentences: readonly string[]) => fmt(sentences.join(" "));
/** The reply as played: the formatter run per sentence, joined as `heardSoFarText` joins them. */
const asPlayed = (...sentences: readonly string[]) => sentences.map(fmt).join(" ").trim();

await test("R1 — a MIDDLE sentence the formatter rewrites makes the old comparison lose the tail", () => {
  const S1 = "We build the whole thing live on the call.";
  const S2 = "So, you will not need any coding for it.";
  const S3 = "Would you like me to reserve your free seat?";

  const stored = wholeReply(S1, S2, S3);
  const heard = asPlayed(S1, S2);

  // The two representations genuinely differ — that is the whole defect.
  assert.ok(stored.includes("So, you will not need"), "the whole-reply form keeps the filler");
  assert.ok(!heard.includes("So, you will not need"), "the per-sentence form strips it");

  // ...and the consequence: the tail is reported as empty even though a
  // whole sentence — the commitment question — was never heard.
  assert.equal(
    tailOf(stored, heard),
    "",
    "the old comparison silently loses everything after the rewritten sentence",
  );
  assert.ok(
    fmt(S3).includes("reserve your free seat"),
    "and what was lost is the question that commits the caller",
  );
});

await test("R2 — a hesitation opener does the same", () => {
  const S1 = "The workshop is on Sunday at 11 AM.";
  const S2 = "Um, the joining details come on WhatsApp.";
  const S3 = "Would you like me to reserve your free seat?";

  assert.equal(tailOf(wholeReply(S1, S2, S3), asPlayed(S1, S2)), "");
});

await test("R3 — plain prose is unaffected, so the hazard is specific and not universal", () => {
  // The control. Where the formatter changes nothing, the two
  // representations agree and the old comparison was correct — which is
  // why this went unnoticed: most replies are of this shape.
  const S1 = "The workshop is on Sunday at 11 AM.";
  const S2 = "The joining details come on WhatsApp.";
  const S3 = "Would you like me to reserve your free seat?";

  assert.equal(tailOf(wholeReply(S1, S2, S3), asPlayed(S1, S2)), fmt(S3));
});

await test("R4 — nothing heard at all yields the WHOLE reply as the tail", () => {
  // The M2 shape, stated as an input/output fact: with an empty heard
  // prefix the old comparison hands back everything, so a reply the
  // caller never heard a word of became a full-length held position.
  // The pipeline no longer derives the remainder this way; a reply with
  // no queued utterances now yields nothing to hold.
  const reply = fmt("You will not need any coding or design skills for this.");
  assert.equal(tailOf(reply, ""), reply);
});

'''

t = t.replace(anchor, SECTION.replace("\n", NL) + anchor, 1)
io.open(p2, "w", encoding="utf-8", newline="").write(t)
print("M4 representation tests added to resume-accuracy")
