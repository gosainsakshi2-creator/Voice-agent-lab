/**
 * prompt-variant.ts
 *
 * One switch for the COMPACT system prompt: the same rules as the full
 * master prompt and the full conversation policy, written in about a
 * third of the tokens — one example per rule instead of five, no
 * restatements, no explanations of why a rule exists.
 *
 * OFF unless `SYSTEM_PROMPT_COMPACT=true`. Read at call time, not at
 * module load, so a test can flip it and so Render picks it up on the
 * next call after the variable changes. Both `buildSystemPrompt` and
 * `composeCampaignAppendix` consult it, so a call is never half one
 * variant and half the other.
 */
export function compactPromptEnabled(): boolean {
  return (process.env.SYSTEM_PROMPT_COMPACT ?? "false").trim().toLowerCase() === "true";
}
