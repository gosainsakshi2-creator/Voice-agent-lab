/**
 * M4, second attempt: the divergence needs a MIDDLE sentence whose
 * per-sentence formatting differs from its formatting inside the whole
 * reply. Then the heard prefix stops matching and the tail after it is
 * lost.
 */
const { unspokenTail } = await import("../src/core/session/conversation-pipeline");
const { formatForSpeech } = await import("../src/utils/speech-formatter");

const spoken = (s: string) => formatForSpeech(s);

const CASES: Array<{ label: string; s: [string, string, string] }> = [
  {
    label: "middle sentence opens with a discourse filler",
    s: [
      "We build the whole thing live on the call.",
      "So, you will not need any coding for it.",
      "Would you like me to reserve your free seat?",
    ],
  },
  {
    label: "middle sentence opens with a hesitation",
    s: [
      "The workshop is on Sunday at 11 AM.",
      "Um, the joining details come on WhatsApp.",
      "Would you like me to reserve your free seat?",
    ],
  },
  {
    label: "plain prose (control — must NOT diverge)",
    s: [
      "The workshop is on Sunday at 11 AM.",
      "The joining details come on WhatsApp.",
      "Would you like me to reserve your free seat?",
    ],
  },
];

for (const { label, s } of CASES) {
  const [s1, s2, s3] = s;
  // What the pipeline stores as the reply.
  const assistantText = spoken(`${s1} ${s2} ${s3}`);
  // What playback recorded once s1 and s2 had played: per-sentence
  // formatting, joined exactly as `heardSoFarText()` joins them.
  const heard = `${spoken(s1)} ${spoken(s2)}`.trim();

  const tail = unspokenTail(assistantText, heard);

  console.log(`\n-- ${label}`);
  console.log(`   assistantText : ${JSON.stringify(assistantText)}`);
  console.log(`   heard (s1+s2) : ${JSON.stringify(heard)}`);
  console.log(`   unspokenTail  : ${JSON.stringify(tail)}`);
  console.log(`   EXPECTED tail : ${JSON.stringify(spoken(s3))}`);
  console.log(
    `   RESULT        : ${tail.length === 0 ? "TAIL LOST  <-- M4" : tail === spoken(s3) ? "correct" : "different but non-empty"}`,
  );
}
