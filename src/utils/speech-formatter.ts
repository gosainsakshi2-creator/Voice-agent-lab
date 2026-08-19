/**
 * speech-formatter.ts
 *
 * Last-mile cleanup of LLM output before it is handed to TTS.
 *
 * The system prompt asks for short, natural, filler-free speech, but a
 * prompt is a preference, not a guarantee — models still open with
 * "Umm,", stack "Okay, thank you.", and reach for textbook Hindi
 * (धन्यवाद, निश्चित रूप से) mid-Hinglish. This pass enforces those
 * rules deterministically on the way out.
 *
 * Applied per sentence chunk in the streaming path, so every rule here
 * must be safe to run on a fragment of a reply, and must never change
 * meaning — only phrasing and dead air.
 */

/** Non-lexical hesitation sounds — always safe to drop from the front. */
const LEADING_HESITATION = /^(?:(?:u+m+h?|u+h+|h+m+|e+r+m?|erm)\b[\s,.…-]*)+/iu;

/**
 * Filler openers that are also real words ("so the price is...", "well
 * within budget"). Only stripped when punctuated as a standalone
 * discourse marker, which is the form the prompt bans.
 *
 * "actually" is deliberately NOT in this list, and must not be added
 * back. The approved registration script opens its second block with
 * "Actually, I'm calling you with a very interesting invitation." —
 * that is signed-off copy, not hesitation, and stripping it shortened
 * an approved line on every single call while leaving no trace that
 * anything had been changed. A campaign script is pinned by content
 * hash precisely so the words that were approved are the words that
 * are spoken; a last-mile regex that quietly edits one of them defeats
 * the entire mechanism. The model inventing its own "actually" is
 * handled where the rest of the padding is — by the conversation
 * policy, which can tell an approved word from an invented one.
 */
const LEADING_DISCOURSE_FILLER =
  /^(?:(?:so basically|let me think|you know|basically|well|so|now)\s*[,–—]\s*)+/iu;

/**
 * Two acknowledgements stacked into one turn — "Okay, thank you." The
 * prompt bans this pattern outright; keep the first, drop the second.
 */
const STACKED_ACKNOWLEDGEMENT =
  /^(okay|ok|sure|absolutely|alright|right|certainly|yeah|yes|got it|theek hai|bilkul|achha|haan)\s*[,.!]?\s+(?:thank you|thanks|thank you so much|shukriya|धन्यवाद)\s*[,.!]?\s*/iu;

/** Over-formal phrasings replaced with what a person actually says on a call. */
const PHRASE_SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // English — corporate/support register
  [/\bhow may I assist you today\b/giu, "how can I help you"],
  [/\bhow may I assist you\b/giu, "how can I help you"],
  [/\bit would be my pleasure to assist you\b/giu, "happy to help"],
  [/\bI would be happy to\b/giu, "I can"],
  [/\bI sincerely appreciate you providing this information\b/giu, "thanks for that"],
  [/\bthank you for bringing this to my attention\b/giu, "thanks for flagging that"],
  [/\bthank you for sharing that\b/giu, "got it"],
  [/\bI completely understand your concern\b/giu, "I understand"],
  [/\bI understand your concern\b/giu, "I understand"],
  [/\bthank you very much\b/giu, "thanks"],
  [/\bcertainly\b/giu, "sure"],
  [/\bkindly\s+/giu, "please "],

  // Hindi — textbook vocabulary the prompt bans in normal conversation.
  // No `\b` here: JS word boundaries are defined over [A-Za-z0-9_], so
  // `\b` next to a Devanagari letter never matches.
  [/निश्चित रूप से/gu, "Bilkul"],
  [/अवश्य/gu, "Sure"],
  [/धन्यवाद/gu, "Thank you"],
  [/कृपया/gu, "Please"],
  [/आपका स्वागत है/gu, "Welcome"],
];

/**
 * Cleans one piece of assistant text for speech. Safe on a full reply
 * or on a single streamed sentence.
 */
export function formatForSpeech(text: string): string {
  let spoken = text.replace(/\s+/gu, " ").trim();
  if (spoken.length === 0) return "";

  spoken = stripLeading(spoken, LEADING_HESITATION);
  spoken = stripLeading(spoken, LEADING_DISCOURSE_FILLER);

  // Collapse before substitutions so "Okay, thank you very much." can't
  // survive as "Okay, thanks."
  spoken = collapseStackedAcknowledgement(spoken);

  for (const [pattern, replacement] of PHRASE_SUBSTITUTIONS) {
    spoken = spoken.replace(pattern, replacement);
  }

  // Ellipses are read aloud as dead air. Mid-sentence they become a
  // comma's worth of pause; at the end, a plain full stop.
  spoken = spoken.replace(/\s*(?:\.{3,}|…)\s*$/u, ".");
  spoken = spoken.replace(/\s*(?:\.{3,}|…)\s*/gu, ", ");

  // Re-capitalise if a stripped filler left a lowercase opener.
  spoken = spoken.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());

  return spoken.replace(/\s+/gu, " ").replace(/\s+([,.!?।])/gu, "$1").trim();
}

/** Strips a leading pattern, but never reduces the text to nothing. */
function stripLeading(text: string, pattern: RegExp): string {
  const stripped = text.replace(pattern, "").trim();
  return stripped.length > 0 ? stripped : text;
}

function collapseStackedAcknowledgement(text: string): string {
  const match = STACKED_ACKNOWLEDGEMENT.exec(text);
  if (!match) return text;

  const keptAcknowledgement = match[1] ?? "";
  const remainder = text.slice(match[0].length).trim();
  // "Okay, thank you." with nothing after it — keep the one word.
  if (remainder.length === 0) return `${keptAcknowledgement}.`;
  return `${keptAcknowledgement}. ${remainder}`;
}
