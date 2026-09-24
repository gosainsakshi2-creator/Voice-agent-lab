/**
 * generate-name-pronunciations.ts — `npm run names:generate`
 *
 * Fills `src/utils/name-pronunciations.generated.ts` with the Devanagari
 * spelling of every name in the contact list, so that no name ever has
 * to be added by hand and nothing has to be resolved while a call is in
 * progress.
 *
 *   npm run names:generate                      # every campaign
 *   npm run names:generate -- --campaign=<uuid> # one campaign
 *   npm run names:generate -- --dry-run         # print, write nothing
 *   npm run names:generate -- --limit=50        # cap the model calls
 *
 * ── WHY THIS IS A SCRIPT AND NOT A FUNCTION THE PIPELINE CALLS ────
 *
 * Latency. Resolving a name costs a model request; doing that during a
 * call would put a network round trip in front of the greeting and add
 * a failure mode to every dial. Here it happens once, offline, against
 * a list of UNIQUE names — a few hundred rows typically cover thousands
 * of contacts, because first names repeat heavily — and the committed
 * output is read at call time with a `Map.get`.
 *
 * ── WHAT IT WILL AND WILL NOT DO ──────────────────────────────────
 *
 * IT ONLY ADDS. A name already in the file keeps the spelling it has,
 * whether that came from an earlier run or from somebody correcting it
 * by hand. There is no path in this script that rewrites an existing
 * row, so a correction is permanent.
 *
 * IT REFUSES ANYTHING THAT IS NOT A NAME. The model is asked for one
 * name at a time and its answer is accepted only if it is pure
 * Devanagari of a plausible length. Anything else — an apology, an
 * explanation, a transliteration back into Latin, an empty string — is
 * dropped, and that name simply stays absent, which means it is spoken
 * exactly as it is spelled today. A miss is never an error.
 *
 * REVIEW THE DIFF. A wrong row here is a wrong name said aloud to a
 * real person. It is committed to the repo precisely so it can be read
 * before it ships.
 *
 * NO CONTACT DATA LEAVES THIS SCRIPT except the NAMES themselves, one
 * at a time. No phone number, no campaign, no row, nothing else.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { query, closeDbPool } from "../db/client";
import { OpenAiGptLanguageModelProvider } from "../../providers/language-model/openai-gpt.provider";
import { GENERATED_NAMES, VERIFIED_NAMES } from "../../utils/name-pronunciations.generated";
import type { ConversationTurn } from "../../types/provider.types";
import type { SessionId } from "../../types/session.types";

const GENERATED_FILE = path.join(process.cwd(), "src/utils/name-pronunciations.generated.ts");

/** Devanagari letters and combining marks, and nothing else. */
const PURE_DEVANAGARI = /^[ऀ-ॿ\s]+$/u;

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Every distinct name part worth resolving, lower-cased.
 *
 * Both the FULL name and each part: the full name is what the opening
 * line reads out, and the parts are what the model says for the rest of
 * the call. One-character parts are initials and are skipped.
 */
async function distinctNames(campaignId: string | undefined): Promise<readonly string[]> {
  const rows = campaignId
    ? await query<{ name: string | null }>(
        "SELECT DISTINCT name FROM contacts WHERE campaign_id = $1 AND name IS NOT NULL",
        [campaignId],
      )
    : await query<{ name: string | null }>(
        "SELECT DISTINCT name FROM contacts WHERE name IS NOT NULL",
      );

  const names = new Set<string>();
  for (const row of rows.rows) {
    const full = (row.name ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
    if (full.length === 0) continue;
    const parts = full.split(" ").filter((part) => part.length > 1);
    if (parts.length > 1) names.add(full.toLowerCase());
    for (const part of parts) names.add(part.toLowerCase());
  }
  return [...names].sort();
}

const PROMPT = [
  "You transliterate Indian personal names into Devanagari for a text-to-speech system.",
  "",
  "Reply with the name in Devanagari and NOTHING else — no quotes, no Latin letters, no",
  "explanation, no alternatives. Vowel length matters more than anything: write the spelling",
  "that makes a Hindi speaker say the name the way its owner says it (Rahul is राहुल, Ramesh is",
  "रमेश). If the name is not one you can write confidently, reply with exactly: SKIP",
].join("\n");

async function spellOneName(
  llm: OpenAiGptLanguageModelProvider,
  name: string,
): Promise<string | undefined> {
  const history: ConversationTurn[] = [
    { role: "system", content: PROMPT, timestamp: new Date() } as ConversationTurn,
    { role: "user", content: name, timestamp: new Date() } as ConversationTurn,
  ];
  try {
    const result = await llm.generateCompletion({ sessionId: `names-${name}` as unknown as SessionId, history });
    const answer = (result.turn.content ?? "").normalize("NFC").trim();
    if (answer.length === 0 || answer === "SKIP") return undefined;
    if (!PURE_DEVANAGARI.test(answer)) return undefined;
    // A name is short. Anything long is a sentence that happened to be
    // written in Devanagari, which is not what was asked for.
    if (answer.length > name.length * 2 + 8) return undefined;
    return answer;
  } catch {
    return undefined;
  }
}

/** Rewrites only the GENERATED_NAMES block, leaving VERIFIED_NAMES and every comment intact. */
function writeGeneratedBlock(entries: ReadonlyMap<string, string>): void {
  const source = readFileSync(GENERATED_FILE, "utf8");
  const marker = "export const GENERATED_NAMES: Readonly<Record<string, string>> = {";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${GENERATED_FILE}: GENERATED_NAMES block not found`);
  const end = source.indexOf("};", start);
  if (end < 0) throw new Error(`${GENERATED_FILE}: GENERATED_NAMES block is not closed`);

  const body = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    // A key with a space or anything non-identifier must be quoted.
    .map(([key, value]) => `  ${/^[a-z][a-z0-9]*$/u.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");

  writeFileSync(GENERATED_FILE, `${source.slice(0, start)}${marker}\n${body}\n${source.slice(end)}`, "utf8");
}

async function main(): Promise<void> {
  const campaignId = arg("campaign");
  const dryRun = flag("dry-run");
  const limit = Number(arg("limit") ?? "0");

  const existing = new Map<string, string>(Object.entries(GENERATED_NAMES));
  const verified = new Set(Object.keys(VERIFIED_NAMES));

  const all = await distinctNames(campaignId);
  const missing = all.filter((name) => !existing.has(name) && !verified.has(name));
  const todo = limit > 0 ? missing.slice(0, limit) : missing;

  console.log(`${all.length} distinct names in the contact list.`);
  console.log(`${all.length - missing.length} already have a spelling; ${missing.length} do not.`);
  if (todo.length !== missing.length) console.log(`--limit=${limit}: resolving ${todo.length} of them.`);
  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const llm = new OpenAiGptLanguageModelProvider();
  let added = 0;
  let skipped = 0;
  for (const [index, name] of todo.entries()) {
    const spelling = await spellOneName(llm, name);
    if (spelling === undefined) {
      skipped += 1;
      console.log(`  [skip] ${name}`);
    } else {
      existing.set(name, spelling);
      added += 1;
      console.log(`  [ ok ] ${name} -> ${spelling}`);
    }
    if ((index + 1) % 25 === 0) console.log(`  ...${index + 1}/${todo.length}`);
  }

  console.log(`\n${added} added, ${skipped} left absent (they keep today's spelling).`);
  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }
  writeGeneratedBlock(existing);
  console.log(`Wrote ${existing.size} entries to ${GENERATED_FILE}.`);
  console.log("READ THE DIFF before committing — a wrong row is a wrong name said to a real person.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
