/**
 * Read-only probe: does M4 (unspokenTail formatting divergence) and the
 * M2 shape (a never-delivered reply becoming a held remainder) actually
 * reproduce against the real exported helpers? No pipeline, no call.
 */
const { unspokenTail } = await import("../src/core/session/conversation-pipeline");
const { formatForSpeech } = await import("../src/utils/speech-formatter");

// `toSpokenText` is module-private; `stripMarkdown` is a no-op for
// plain prose, so `formatForSpeech` alone is the operative half here.
const spoken = (s: string) => formatForSpeech(s);

console.log("=== M4: whole-text formatting vs per-sentence formatting ===");

const CASES: Array<{ label: string; s1: string; s2: string }> = [
  {
    label: "second sentence opens with a discourse filler",
    s1: "We build the whole thing live on the call.",
    s2: "So, you will not need any coding for it.",
  },
  {
    label: "second sentence opens with a hesitation",
    s1: "The workshop is on Sunday at 11 AM.",
    s2: "Um, the joining details come on WhatsApp.",
  },
  {
    label: "second sentence opens with a stacked acknowledgement",
    s1: "Your seat is reserved for Sunday.",
    s2: "Okay, thank you very much for your time.",
  },
  {
    label: "plain prose (control — must NOT diverge)",
    s1: "The workshop is on Sunday at 11 AM.",
    s2: "The joining details come on WhatsApp.",
  },
];

for (const { label, s1, s2 } of CASES) {
  // What the pipeline stores as `assistantText`: the formatter run ONCE
  // over the whole reply.
  const assistantText = spoken(`${s1} ${s2}`);
  // What playback actually recorded: the formatter run per sentence,
  // joined the way `heardSoFarText()` joins them.
  const heardAfterS1 = spoken(s1);

  const tail = unspokenTail(assistantText, heardAfterS1);
  const perSentenceS2 = spoken(s2);

  console.log(`\n-- ${label}`);
  console.log(`   assistantText  : ${JSON.stringify(assistantText)}`);
  console.log(`   heard (s1 only): ${JSON.stringify(heardAfterS1)}`);
  console.log(`   unspokenTail   : ${JSON.stringify(tail)}`);
  console.log(`   per-sentence s2: ${JSON.stringify(perSentenceS2)}`);
  console.log(`   TAIL LOST?     : ${tail.length === 0 ? "YES  <-- M4" : "no"}`);
}

console.log("\n=== M2 shape: nothing heard -> the whole reply is the 'tail' ===");
const reply = spoken("You will not need any coding or design skills for this.");
console.log(`   unspokenTail(reply, "") === whole reply : ${unspokenTail(reply, "") === reply}`);
console.log(`   -> a reply superseded before a byte played yields a full-length remainder`);
