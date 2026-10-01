/**
 * stt-repair.ts
 *
 * Repairs the one STT mistake that turns a question into a refusal:
 * "know" written as "no". Applied to the caller's turn before the model,
 * the classifier or the hangup watchdog read it, when the pipeline option
 * `repairSttHomophones` is on.
 *
 * WHY. Call e92a6b5a (2026-10-01). Asked "Would you like me to reserve
 * your free seat?", the caller said "Actually, first I want to know more
 * about the services." Soniox wrote "Actually, first I want to— No more
 * about the services." The model read a refusal, spoke the decline close,
 * and the call was ended on it — a caller who wanted to hear more,
 * recorded as declined.
 *
 * THE RULES ARE NARROW ON PURPOSE. Each one rewrites a shape in which
 * "no" cannot be a refusal, so a real "no" is never touched:
 *   - "no more about …": a refusal is "no more calls", never "no more
 *     about the services". Read either as "know more about" or as "No,
 *     more about…" — a request for more — and neither ends the call.
 *   - "want / wanted / would like / like / need / have to … no <what /
 *     how / why / when / where / which / who / if / whether / about /
 *     more / the / your / this>": the verb wants an object, and "to no"
 *     is not English.
 *   - "don't / do not / didn't / did not / doesn't / does not / dunno no":
 *     "I don't no" is only ever "I don't know".
 * English only: Hindi "no" is "nahi", and a Hinglish "know" is written
 * in Latin script the same way, so the same rules hold there.
 */

const ASKING_WORD = "(?:what|how|why|when|where|which|who|whom|whose|if|whether|about|more|the|your|this|that|anything|everything|something)";

const RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly replace: string }> = [
  // "No more about the services." / "…no more about it?"
  { pattern: /\bno(\s+more\s+about)\b/giu, replace: "know$1" },
  // "I want to— No more", "I'd like to no what", "need to no about"
  {
    pattern: new RegExp(
      `\\b((?:want|wanted|wants|would like|'d like|like|need|needed|needs|have|has|had|got|trying|try|wish)\\s+to)([\\s,.!?…—–-]*)no\\b(?=[\\s,.!?…—–-]*${ASKING_WORD}\\b)`,
      "giu",
    ),
    replace: "$1$2know",
  },
  // "I don't no", "do not no what"
  { pattern: /\b(don't|do not|didn't|did not|doesn't|does not)\s+no\b/giu, replace: "$1 know" },
];

/** The caller's words with "know" restored where STT wrote "no". Unchanged when nothing matched. */
export function repairSttHomophones(text: string): string {
  let out = text;
  for (const { pattern, replace } of RULES) out = out.replace(pattern, replace);
  if (out === text) return text;
  // "No more about" became "know more about": keep the capital where a sentence opened.
  return out.replace(/(^\s*|[.!?…—–-]\s*)know\b/gu, (_m, lead: string) => `${lead}Know`);
}
