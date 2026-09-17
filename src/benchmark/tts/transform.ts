/**
 * transform.ts — runs the corpus through the REAL text passes.
 *
 * PHASE 4, EVIDENCE STEP. Pure: no I/O, no clock, no network, no
 * provider.
 *
 * ── THERE IS NO SECOND IMPLEMENTATION HERE ────────────────────────
 *
 * This file imports `formatForSpeech` and `pronounceForSpeech` from
 * the production modules and calls them. It contains no formatting
 * rule, no pronunciation rule, no regex and no vocabulary of its own,
 * and it must never grow one: the entire value of this harness is that
 * the text it reports is the text production produces. A local
 * re-implementation would make the evidence describe the harness.
 *
 * ── THE ORDER IS PRODUCTION'S ORDER ───────────────────────────────
 *
 * On a live call the two passes run at different moments and in this
 * sequence:
 *
 *   1. `toSpokenText()`   — conversation-pipeline.ts:298, applied to
 *      every fixed line and every generated chunk before it is spoken.
 *      It is `formatForSpeech(stripMarkdown(raw))`.
 *   2. `pronounceForSpeech(text, language)` — conversation-pipeline.ts:5582,
 *      applied inside `synthesizeAndPlay` to the string handed to
 *      `synthesize`, and to nothing else. The original wording is what
 *      goes to history, the classifier and the sheet.
 *
 * ── THE ONE PRODUCTION STEP THIS DOES NOT MODEL, AND WHY ──────────
 *
 * `stripMarkdown` is module-private inside `conversation-pipeline.ts`
 * and is not exported. Importing that module to reach it would pull
 * the entire session runtime — state machine, barge-in controller,
 * metrics, provider wiring — into a text-only harness, which is a
 * stop condition for this task rather than a convenience.
 *
 * It is omitted, and the omission is recorded on every result
 * (`stripMarkdownApplied: false`) rather than glossed. It costs this
 * evidence nothing: `stripMarkdown` removes markdown syntax the model
 * sometimes emits, and no corpus item contains any. If a future corpus
 * item does, that item's evidence is incomplete and the flag says so.
 */

import { formatForSpeech } from "../../utils/speech-formatter";
import { pronounceForSpeech } from "../../utils/speech-pronunciation";
import type { SupportedLanguage } from "../../types/enums";
import type { CorpusItem } from "./corpus";

/**
 * How the declared `expectation` compares with what the real functions
 * did. `match` is the ordinary case; `mismatch` means the declaration
 * in `corpus.ts` is now stale — which is a finding about the code, not
 * a licence to edit the corpus without reading why.
 */
export type ExpectationVerdict = "match" | "mismatch";

export interface TransformResult {
  readonly corpusId: string;
  readonly language: SupportedLanguage;
  /** Exactly as written in the corpus. */
  readonly originalText: string;
  /** After `formatForSpeech`. */
  readonly formattedText: string;
  /** After `pronounceForSpeech` — THE STRING THE PROVIDER RECEIVES. */
  readonly synthesisText: string;
  /** Did either pass change anything? */
  readonly changed: boolean;
  /** Which passes changed it — useful when only one of the two fired. */
  readonly changedBy: readonly ("formatForSpeech" | "pronounceForSpeech")[];
  readonly declaredExpectation: CorpusItem["expectation"];
  readonly verdict: ExpectationVerdict;
  /** False for every item today — see the file header. */
  readonly stripMarkdownApplied: false;
}

/**
 * Runs one corpus item through both passes, in production's order.
 *
 * Deterministic: the same item and the same source code always produce
 * the same three strings. Nothing here reads a clock, an environment
 * variable or a random source.
 */
export function transformItem(item: CorpusItem): TransformResult {
  const formattedText = formatForSpeech(item.sourceText);
  const synthesisText = pronounceForSpeech(formattedText, item.language);

  const changedBy: ("formatForSpeech" | "pronounceForSpeech")[] = [];
  if (formattedText !== item.sourceText) changedBy.push("formatForSpeech");
  if (synthesisText !== formattedText) changedBy.push("pronounceForSpeech");

  const changed = synthesisText !== item.sourceText;
  const observed = changed ? "transformed" : "unchanged";

  return {
    corpusId: item.id,
    language: item.language,
    originalText: item.sourceText,
    formattedText,
    synthesisText,
    changed,
    changedBy,
    declaredExpectation: item.expectation,
    verdict: observed === item.expectation ? "match" : "mismatch",
    stripMarkdownApplied: false,
  };
}

/** The whole corpus, in corpus order. */
export function transformAll(items: readonly CorpusItem[]): readonly TransformResult[] {
  return items.map(transformItem);
}

/** Items whose recorded behaviour no longer matches the corpus declaration. */
export function mismatches(results: readonly TransformResult[]): readonly TransformResult[] {
  return results.filter((result) => result.verdict === "mismatch");
}
