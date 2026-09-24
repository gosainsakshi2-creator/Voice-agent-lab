/**
 * M1 and M11 — the two "haan ji" findings, at the predicate level.
 *
 * Offline, no harness, no provider. This only reads the exported
 * vocabulary predicates and the identity classifier, and prints what
 * they answer for the family the audit names. It changes nothing.
 *
 * M1  `handleAttentionCheck` computes `isCheck = isAttentionCheck(t)`
 *     and, inside an episode opened BEFORE any block, tests `isCheck`
 *     FIRST. So whatever this prints as a check is answered with
 *     another fixed hearing line rather than closing the episode.
 *
 * M11 the identity gate reads `classifyIdentityAnswer` while the
 *     identity question is outstanding, which on an identity-first
 *     script is the very first turn — including the caller's pickup.
 */
const { isAttentionCheck, isHearingCheck, isEmphaticHearingCheck } = await import(
  "../src/core/session/conversation-pipeline"
);
const { classifyIdentityAnswer } = await import("../src/campaign/domain/identity-answer");

const WORDS = [
  "haan ji",
  "haanji",
  "hanji",
  "haan",
  "ji",
  "yes",
  "theek hai",
  "hello",
  "hello hello",
];

console.log("utterance        isAttentionCheck  isHearingCheck  isEmphatic  identity");
for (const w of WORDS) {
  console.log(
    `${w.padEnd(16)} ${String(isAttentionCheck(w)).padEnd(17)} ${String(isHearingCheck(w)).padEnd(15)} ` +
      `${String(isEmphaticHearingCheck(w)).padEnd(11)} ${classifyIdentityAnswer(w)}`,
  );
}

console.log(
  "\nM1  — the asymmetry: an utterance that is an attention check is answered with a\n" +
    "      second fixed hearing line inside an episode opened before any block, because\n" +
    "      `isCheck` is tested before `confirmsHearing`. Anything NOT a check on this\n" +
    "      table, but in HEARING_CONFIRMATION_ONLY, closes the episode instead.",
);
console.log(
  "M11 — whatever `classifyIdentityAnswer` calls `confirmed` opens the gate when the\n" +
    "      identity question is outstanding, which on an identity-first script includes\n" +
    "      the caller's pickup turn (identity-gate D2/D3).",
);
