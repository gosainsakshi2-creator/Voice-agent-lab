/**
 * name-pronunciation.ts
 *
 * Turns ONE contact's name into the substitutions `pronounceForSpeech`
 * applies on the way to `synthesize`.
 *
 * ── SCOPE: THE CONTACT'S OWN NAME, AND NOTHING ELSE ───────────────
 *
 * This never scans an utterance for "any name it recognises". It is
 * built from `campaign.customer.name` — one known field, one person,
 * per call — and only that name and its parts can be rewritten. That
 * bound is the whole safety case, and it is what separates this from a
 * general transliterator: a table entry like "mala" or "sona" would
 * otherwise fire inside an unrelated word on somebody else's call, and
 * a company or product name could never be reached at all.
 *
 * ── WHAT IT COSTS AT CALL TIME ────────────────────────────────────
 *
 * A few `Map.get` calls, ONCE per session, and then one regex replace
 * per utterance per matched part. No model, no network, no database.
 * The Devanagari was resolved offline — see
 * `name-pronunciations.generated.ts`.
 *
 * ── WHAT IT DOES NOT TOUCH ────────────────────────────────────────
 *
 * The canonical spelling stays canonical everywhere that is not audio:
 * the transcript, the classifier, the registrations sheet and the
 * contact record all keep what the CSV had. `pronounceForSpeech` runs
 * on the string handed to the vendor and on nothing else.
 */

import { GENERATED_NAMES, VERIFIED_NAMES } from "./name-pronunciations.generated";

/** One rewrite: match this in the spoken text, say that instead. */
export interface SpokenNameSubstitution {
  readonly pattern: RegExp;
  readonly spoken: string;
}

/**
 * Lookup key: lower-cased, whitespace-collapsed, NFC. The contact list
 * is human-typed, so "  RAHUL  sharma" and "Rahul Sharma" must reach
 * the same row.
 */
export function nameKeyOf(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}
const keyOf = nameKeyOf;

/** Devanagari letters, marks and spaces, and nothing else. */
const PURE_DEVANAGARI = /^[ऀ-ॿ ]+$/u;

/**
 * A resolved spelling is only trusted when it is pure Devanagari and
 * has exactly one word per word of the name — the alignment the parts
 * below are cut from. Anything else is ignored, never half-applied.
 */
export function isUsableSpelling(name: string, spelling: string | undefined): spelling is string {
  if (spelling === undefined) return false;
  const spoken = spelling.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (spoken.length === 0 || !PURE_DEVANAGARI.test(spoken)) return false;
  const words = name.normalize("NFC").trim().replace(/\s+/gu, " ").split(" ");
  return spoken.split(" ").length === words.length;
}

/**
 * True when the committed table already says every part of this name
 * (or the whole name), so nothing has to be resolved for it.
 */
export function tableCoversName(name: string): boolean {
  const full = name.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (full.length === 0) return true;
  if (lookupSpokenName(full) !== undefined) return true;
  const parts = full.split(" ").filter((part) => part.length > 1);
  return parts.every((part) => lookupSpokenName(part) !== undefined);
}

/**
 * The Devanagari spelling for one name, or `undefined`.
 *
 * Hand-verified entries win: `npm run names:generate` may only ADD, so
 * a spelling somebody corrected is never replaced by a generated one.
 */
export function lookupSpokenName(name: string): string | undefined {
  const key = keyOf(name);
  return VERIFIED_NAMES[key] ?? GENERATED_NAMES[key];
}

/** Escapes a name for use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * ── WORD BOUNDARIES, WITHOUT `\b` ─────────────────────────────────
 *
 * JavaScript's `\b` is defined over `[A-Za-z0-9_]`, so it behaves
 * correctly on the LATIN side of a match and not at all next to
 * Devanagari — which is exactly the mixed-script text a Hinglish call
 * produces. A name is therefore bounded by "not a letter, not a digit
 * and not a combining mark" on each side, the same class the phrase
 * matchers elsewhere in this codebase use.
 *
 * `\p{M}` is in the class deliberately: Devanagari matras are combining
 * marks, and leaving them out would let a match end in the middle of a
 * syllable.
 */
const BOUNDARY = "(?<![\\p{L}\\p{N}\\p{M}])";
const BOUNDARY_AFTER = "(?![\\p{L}\\p{N}\\p{M}])";

function patternFor(name: string): RegExp {
  return new RegExp(`${BOUNDARY}${escapeForRegExp(name)}${BOUNDARY_AFTER}`, "giu");
}

/**
 * The substitutions for one call, built once when the session starts.
 *
 * ORDER IS LOAD-BEARING: the FULL name first, then each part. "Saurabh
 * Bhatnagar" has to be consumed as one phrase before the rule for
 * "Saurabh" can split it, or the surname would be left in Latin beside
 * a Devanagari given name.
 *
 * A part with no row in the table is simply left out — that name keeps
 * its canonical spelling, which is today's behaviour and is never an
 * error. A one-letter part (an initial, "R." in "R. Sharma") is skipped
 * outright: it carries no pronunciation and would match far too much.
 *
 * Returns an empty list for an empty name, so a session with no contact
 * name costs nothing and changes nothing.
 *
 * `resolvedSpelling` is the spelling the campaign layer resolved for a
 * name the table does not know (`spoken-name-resolver.ts`, before the
 * dial). The table still wins wherever it has a row; the resolved
 * spelling fills only what it lacks, word for word. A spelling that is
 * not pure Devanagari, or does not have one word per name word, is
 * ignored outright.
 */
export function spokenNameSubstitutions(
  customerName: string | null | undefined,
  resolvedSpelling?: string,
): readonly SpokenNameSubstitution[] {
  const full = (customerName ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (full.length === 0) return [];

  const words = full.split(" ");
  const resolvedWords = isUsableSpelling(full, resolvedSpelling)
    ? resolvedSpelling.normalize("NFC").trim().replace(/\s+/gu, " ").split(" ")
    : undefined;
  const resolvedFor = new Map<string, string>();
  if (resolvedWords !== undefined) {
    resolvedFor.set(keyOf(full), resolvedWords.join(" "));
    words.forEach((word, index) => {
      const spoken = resolvedWords[index];
      if (spoken !== undefined && !resolvedFor.has(keyOf(word))) resolvedFor.set(keyOf(word), spoken);
    });
  }

  const substitutions: SpokenNameSubstitution[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    const key = keyOf(name);
    if (key.length === 0 || seen.has(key)) return;
    const spoken = lookupSpokenName(name) ?? resolvedFor.get(key);
    if (spoken === undefined) return;
    seen.add(key);
    substitutions.push({ pattern: patternFor(name), spoken });
  };

  const parts = words.filter((part) => part.length > 1);
  if (parts.length > 1) {
    // The whole phrase, built from the table's parts where it has them
    // and the resolved words for the rest — so a table row is never
    // overridden by the resolved spelling inside the full name either.
    if (lookupSpokenName(full) === undefined && resolvedWords !== undefined) {
      const spoken = words
        .map((word, index) => (word.length > 1 ? lookupSpokenName(word) : undefined) ?? resolvedWords[index] ?? word)
        .join(" ");
      seen.add(keyOf(full));
      substitutions.push({ pattern: patternFor(full), spoken });
    } else {
      add(full);
    }
  }
  for (const part of parts) add(part);

  return substitutions;
}

/**
 * One substitution for a name matched AS A WHOLE PHRASE, never split
 * into its parts.
 *
 * This is what a person the SCRIPTS name gets, and the difference from
 * `spokenNameSubstitutions` is deliberate. The contact is addressed by
 * first name on every turn, so their parts must be covered. Somebody
 * merely mentioned in the copy is not: the registration script says
 * "Saurabh Sir" in its FAQ answers, and rewriting a bare given name
 * wherever it appears is a wider claim than "this full name is said
 * this way" — it would also fire on a different Saurabh.
 */
export function fullNameSubstitution(name: string): SpokenNameSubstitution | undefined {
  const spoken = lookupSpokenName(name);
  if (spoken === undefined) return undefined;
  return { pattern: patternFor(name.normalize("NFC").trim().replace(/\s+/gu, " ")), spoken };
}

/**
 * Applies the substitutions to one utterance.
 *
 * IDEMPOTENT: every pattern matches Latin only, so a second pass over
 * already-Devanagari output finds nothing. Asserted in the tests.
 */
export function applySpokenNames(
  text: string,
  substitutions: readonly SpokenNameSubstitution[],
): string {
  if (substitutions.length === 0) return text;
  let spoken = text;
  for (const { pattern, spoken: replacement } of substitutions) {
    spoken = spoken.replace(pattern, replacement);
  }
  return spoken;
}
