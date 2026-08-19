/**
 * script-adherence.ts
 *
 * Did the agent actually run the approved script?
 *
 * The prompt tells it to. `conversation-policy.ts` tells it how to
 * handle being interrupted without leaving the script. Neither of those
 * is evidence — they are instructions to a model, and the only honest
 * way to know whether they held on a real call is to read the words
 * that were spoken and compare them with the words that were approved.
 *
 * This module reads a finished transcript against the campaign's own
 * script text and reports four specific failures, chosen because each
 * one is a thing an improvising agent does and a faithful one does not:
 *
 *   restartedScript      it re-introduced itself and began again, which
 *                        is what happens when a question makes it lose
 *                        its place.
 *   offScriptQuestions   it asked something the script does not ask —
 *                        a discovery or qualification question it
 *                        invented, which is exactly the behaviour this
 *                        campaign must not have.
 *   unsupportedFigures   it said a number the script never gave it: a
 *                        price, a time, a seat count, a bonus value.
 *                        The single most damaging kind of invention on
 *                        a registration call.
 *   repeatedScriptLines  it said the same approved line twice.
 *
 * What this is NOT: a second script engine. It holds no state, drives
 * no conversation and never decides an outcome. It reads the script the
 * registry already owns, and its output is a diagnostic attached to the
 * outcome row so a campaign can be audited without listening to
 * recordings.
 *
 * It is deliberately lenient about WORDING and strict about SUBSTANCE.
 * The agent is allowed to deliver an approved line a few words at a
 * time, in its own rhythm, in Hindi — the master prompt requires that.
 * So nothing here compares strings for equality. What it checks is
 * whether the substance of a spoken question exists in the script at
 * all, and whether a spoken number does.
 */

import { isQuestionTurn, normaliseText } from "./conversation-events";
import type { TranscriptTurn } from "./transcript";

/** Kept small so a pathological call cannot bloat the outcome row. */
const MAX_EXAMPLES = 5;

/**
 * Words carried by every sentence in every language of this campaign.
 * Removed before overlap is measured, because "do you have" matching
 * "do you want" would make every invented question look approved.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "have", "has", "had", "will", "would", "shall",
  "should", "can", "could", "may", "might", "must", "i", "you", "your", "yours",
  "we", "our", "us", "me", "my", "mine", "he", "she", "it", "they", "them",
  "their", "to", "of", "in", "on", "at", "for", "with", "from", "by", "about",
  "as", "into", "out", "up", "down", "over", "just", "also", "very", "really",
  "please", "okay", "ok", "yes", "no", "not", "now", "here", "there", "what",
  "why", "how", "when", "where", "which", "who", "get", "got", "let", "like",
  "want", "tell", "say", "said", "know", "see", "one", "some", "any", "all",
  "aap", "aapka", "aapki", "hai", "hain", "ho", "hoga", "hogi", "ka", "ki", "ke",
  "ko", "se", "me", "mein", "par", "aur", "ye", "yeh", "wo", "woh", "kya", "kaise",
  "kar", "karna", "karenge", "main", "hum", "mera", "meri", "bhi", "toh", "to",
  "nahi", "ji", "haan",
]);

export interface ScriptAdherenceReport {
  /**
   * The agent went back to the top — the greeting, or the first thing
   * it said, spoken again later in the call.
   */
  readonly restartedScript: boolean;
  /** Questions the agent asked that the approved script does not ask. */
  readonly offScriptQuestions: readonly string[];
  /** Figures the agent stated that the approved script never supplied. */
  readonly unsupportedFigures: readonly string[];
  /** Approved lines the agent delivered more than once. */
  readonly repeatedScriptLines: number;
  /** Assistant questions examined, so the counts above have a denominator. */
  readonly agentQuestions: number;
  /** True when nothing above fired. */
  readonly clean: boolean;
}

export interface ScriptAdherenceInput {
  /**
   * The approved script's text. The campaign layer passes the script's
   * `systemPromptAppendix`, which contains the script body verbatim —
   * this module never needs to know how that text is assembled.
   */
  readonly scriptText: string;
  readonly transcript: readonly TranscriptTurn[];
}

/**
 * Reads the transcript against the script. Pure, and never throws:
 * a diagnostic that can fail a call is not a diagnostic.
 */
export function checkScriptAdherence(input: ScriptAdherenceInput): ScriptAdherenceReport {
  const scriptNormalised = normaliseText(input.scriptText);
  const scriptWords = new Set(scriptNormalised.trim().split(" ").filter((word) => word.length > 0));
  const scriptFigures = figureKeysIn(input.scriptText);

  const agentTurns = input.transcript.filter(
    (turn) => turn.role === "assistant" && turn.text.trim().length > 0,
  );

  const offScriptQuestions: string[] = [];
  const unsupportedFigures: string[] = [];
  const spokenScriptLines = new Map<string, number>();
  let agentQuestions = 0;
  let restartedScript = false;

  const greeting = agentTurns[0] ? sentencesOf(agentTurns[0].text)[0] : undefined;

  agentTurns.forEach((turn, turnIndex) => {
    for (const sentence of sentencesOf(turn.text)) {
      const normalised = normaliseText(sentence);
      const contentWords = contentWordsOf(normalised);

      // ── Did it start over? ──────────────────────────────────────
      // Compared against what the agent ACTUALLY opened with rather
      // than against the script template, because the template still
      // holds placeholders and the greeting is the one line spoken
      // verbatim.
      if (
        turnIndex > 0 &&
        greeting !== undefined &&
        contentWords.length >= 2 &&
        overlap(contentWords, contentWordsOf(normaliseText(greeting))) >= 0.8
      ) {
        restartedScript = true;
      }

      // ── Is this question in the script at all? ──────────────────
      if (isQuestionTurn(sentence)) {
        agentQuestions += 1;
        // A question with no content words of its own ("Okay?") commits
        // to nothing and invents nothing.
        if (contentWords.length > 0 && overlapWithSet(contentWords, scriptWords) < 0.6) {
          if (offScriptQuestions.length < MAX_EXAMPLES) offScriptQuestions.push(sentence.trim());
        }
      }

      // ── Did it state a figure nobody gave it? ───────────────────
      for (const figure of spokenFiguresIn(sentence)) {
        if (!scriptFigures.has(figure.canonical) && !unsupportedFigures.includes(figure.spoken)) {
          if (unsupportedFigures.length < MAX_EXAMPLES) unsupportedFigures.push(figure.spoken);
        }
      }

      // ── Did it deliver the same approved line twice? ────────────
      // Only lines long enough to be a script line, and only ones that
      // are in the script: repeating "Sure." is speech, repeating the
      // pitch is a loop.
      if (contentWords.length >= 4 && overlapWithSet(contentWords, scriptWords) >= 0.8) {
        const key = contentWords.slice().sort().join(" ");
        spokenScriptLines.set(key, (spokenScriptLines.get(key) ?? 0) + 1);
      }
    }
  });

  const repeatedScriptLines = [...spokenScriptLines.values()].filter((count) => count > 1).length;

  return {
    restartedScript,
    offScriptQuestions,
    unsupportedFigures,
    repeatedScriptLines,
    agentQuestions,
    clean:
      !restartedScript &&
      offScriptQuestions.length === 0 &&
      unsupportedFigures.length === 0 &&
      repeatedScriptLines === 0,
  };
}

/** Splits spoken text into sentences, keeping the punctuation that ends them. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function contentWordsOf(normalised: string): string[] {
  return [
    ...new Set(
      normalised
        .trim()
        .split(" ")
        .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
    ),
  ];
}

/** Share of `words` that appear in `reference`. */
function overlap(words: readonly string[], reference: readonly string[]): number {
  return overlapWithSet(words, new Set(reference));
}

function overlapWithSet(words: readonly string[], reference: ReadonlySet<string>): number {
  if (words.length === 0) return 1;
  let hits = 0;
  for (const word of words) if (reference.has(word)) hits += 1;
  return hits / words.length;
}

/**
 * Every figure a piece of text states, as spoken, keyed by its digits
 * alone.
 *
 * Digits-only comparison is what lets "₹1,50,000+" in the script cover
 * "1,50,000 rupees" on the call, while still catching a price, a time
 * or a seat count that appears nowhere in the approved text.
 *
 * Spelled-out numbers are not checked: "a couple of hours" is not the
 * kind of invention that costs anybody money, and guessing at
 * word-numbers would raise false alarms on ordinary speech. This is a
 * floor on invented figures, like every other heuristic in this layer,
 * and it says so.
 */
const FIGURE_PATTERN = /\d[\d.,:–—-]*\d|\d/gu;

function spokenFiguresIn(text: string): { spoken: string; canonical: string }[] {
  const found: { spoken: string; canonical: string }[] = [];
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const spoken = match[0];
    const canonical = spoken.replace(/\D+/gu, "");
    if (canonical.length > 0) found.push({ spoken, canonical });
  }
  return found;
}

/**
 * The figures a SCRIPT supplies, whole and in parts.
 *
 * A range in the script ("join 5–10 minutes early") licenses either end
 * of it on the call, and a grouped amount ("1,50,000") licenses the
 * groups it is written in. Being generous here is deliberate: this side
 * of the comparison decides what the agent is ALLOWED to say, and a
 * false alarm on an approved number would train an operator to ignore
 * the real ones.
 */
function figureKeysIn(text: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const spoken = match[0];
    const canonical = spoken.replace(/\D+/gu, "");
    if (canonical.length > 0) keys.add(canonical);
    for (const part of spoken.split(/[^\d]+/u)) {
      if (part.length > 0) keys.add(part);
    }
  }
  return keys;
}
