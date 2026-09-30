/**
 * spoken-name-resolver.ts
 *
 * The Devanagari spelling of ANY contact name, so the opening line
 * ("Hello, am I speaking with {{customer_name}}?") and every later
 * mention say the name the way its owner says it — without anybody
 * adding names to a list by hand.
 *
 * ── WHY A MODEL AND NOT A TRANSLITERATION RULE ────────────────────
 *
 * Romanized names drop vowel length, which is the part you hear: Rahul
 * is राहुल, Ramesh is रमेश, Rakesh is राकेश. No rule recovers that; a
 * model that knows the names does. Its answer is checked (pure
 * Devanagari, one word per name word) and anything else is dropped, so
 * the worst case is today's behaviour: the name spoken as spelled.
 *
 * ── WHEN IT RUNS — NEVER DURING A CALL ────────────────────────────
 *
 *   1. At import (`prefetchSpokenNames`), in the background, batched —
 *      so by the first dial the answer is normally a DB read.
 *   2. Before the dial (`resolveSpokenName`, from call-runner), for a
 *      name import did not cover: bounded by `timeoutMs`, and a late
 *      answer is still stored, so the retry and every later call get it.
 *
 * Nothing here is reachable from the pipeline: the result travels to it
 * as `campaign.customer.spokenName`, and `spokenNameSubstitutions`
 * applies it once per session exactly as it applies the table.
 *
 * ── PRECEDENCE ────────────────────────────────────────────────────
 *
 * The committed table (hand-verified rows) wins wherever it has a row;
 * a name it fully covers is never sent to the model at all.
 *
 * ── WHAT LEAVES THE PROCESS ───────────────────────────────────────
 *
 * The names, and nothing else — no phone, no campaign, no contact id.
 * The stored row is keyed on the name alone.
 */

import { query } from "../db/client";
import { OpenAiGptLanguageModelProvider } from "../../providers/language-model/openai-gpt.provider";
import type { ConversationTurn } from "../../types/provider.types";
import type { SessionId } from "../../types/session.types";
import { isUsableSpelling, nameKeyOf, tableCoversName } from "../../utils/name-pronunciation";

/** `null` = the model declined; remembered so it is not asked again. */
export type Spelling = string | null;

export interface NameStore {
  get(keys: readonly string[]): Promise<ReadonlyMap<string, Spelling>>;
  put(entries: ReadonlyMap<string, Spelling>, source: string): Promise<void>;
}

/** Spells a batch of names; a name missing from the result was not answered. */
export type NameSpeller = (names: readonly string[]) => Promise<ReadonlyMap<string, Spelling>>;

export interface SpokenNameDeps {
  readonly store: NameStore;
  readonly spell: NameSpeller;
}

/** Names per model request at import. Small enough to answer fast, large enough to be cheap. */
const BATCH_SIZE = 40;

// ── Production dependencies ──────────────────────────────────────────

const pgStore: NameStore = {
  async get(keys) {
    if (keys.length === 0) return new Map();
    const result = await query<{ name_key: string; spoken: string | null }>(
      "SELECT name_key, spoken FROM name_pronunciations WHERE name_key = ANY($1::text[])",
      [keys],
    );
    return new Map(result.rows.map((row) => [row.name_key, row.spoken]));
  },
  async put(entries, source) {
    if (entries.size === 0) return;
    const keys = [...entries.keys()];
    const values = keys.map((key) => entries.get(key) ?? null);
    await query(
      `INSERT INTO name_pronunciations (name_key, spoken, source)
       SELECT k, v, $3 FROM unnest($1::text[], $2::text[]) AS t(k, v)
       ON CONFLICT (name_key) DO NOTHING`,
      [keys, values, source],
    );
  },
};

const PROMPT = [
  "You transliterate Indian personal names into Devanagari for a text-to-speech system.",
  "",
  "You get a JSON array of names. Reply with ONE JSON object and nothing else, mapping each",
  "name exactly as given to its Devanagari spelling. Vowel length matters more than anything:",
  "write the spelling that makes a Hindi speaker say the name the way its owner says it",
  "(Rahul is राहुल, Ramesh is रमेश, Rakesh is राकेश). Keep one Devanagari word per word of the",
  "name, in the same order; write an initial as its letter name (\"R\" is आर). Use no Latin",
  "letters and no punctuation. If an entry is not a personal name, or not one you can write",
  "confidently, map it to null.",
].join("\n");

let llm: OpenAiGptLanguageModelProvider | null | undefined;

function languageModel(): OpenAiGptLanguageModelProvider | null {
  if (llm === undefined) {
    try {
      llm = new OpenAiGptLanguageModelProvider();
    } catch {
      // No OPENAI_API_KEY: names are spoken as spelled, as before.
      llm = null;
    }
  }
  return llm;
}

/** Pulls the JSON object out of a reply that may be wrapped in a code fence. */
export function parseSpellingReply(reply: string): ReadonlyMap<string, Spelling> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return new Map();
  }
  if (parsed === null || typeof parsed !== "object") return new Map();
  const out = new Map<string, Spelling>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null) out.set(nameKeyOf(name), null);
    else if (typeof value === "string") out.set(nameKeyOf(name), value.normalize("NFC").trim().replace(/\s+/gu, " "));
  }
  return out;
}

export const openAiSpeller: NameSpeller = async (names) => {
  const model = languageModel();
  if (model === null || names.length === 0) return new Map();
  const history: ConversationTurn[] = [
    { role: "system", content: PROMPT, timestamp: new Date() },
    { role: "user", content: JSON.stringify(names), timestamp: new Date() },
  ];
  const result = await model.generateCompletion({
    sessionId: "name-pronunciations" as unknown as SessionId,
    history,
  });
  return parseSpellingReply(result.turn.content ?? "");
};

const defaultDeps: SpokenNameDeps = { store: pgStore, spell: openAiSpeller };

// ── Resolution ───────────────────────────────────────────────────────

/** Answers already read or written by this process. */
const memo = new Map<string, Spelling>();
/** Model requests in flight, so two dials of one name share one request. */
const inFlight = new Map<string, Promise<string | undefined>>();

/** A name worth resolving: has Latin letters and is not fully in the table. */
function needsResolution(name: string): boolean {
  return /[A-Za-z]/u.test(name) && !tableCoversName(name);
}

function cleanName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * Checks each answer against its name and stores it. An answer that
 * fails the check is stored as `null` — a declined name — so a model
 * that keeps answering badly is not asked on every dial.
 */
async function acceptAndStore(
  names: readonly string[],
  answers: ReadonlyMap<string, Spelling>,
  deps: SpokenNameDeps,
  source: string,
): Promise<void> {
  const accepted = new Map<string, Spelling>();
  for (const name of names) {
    const key = nameKeyOf(name);
    if (!answers.has(key)) continue;
    const answer = answers.get(key) ?? null;
    const spelling = answer !== null && isUsableSpelling(name, answer) ? answer : null;
    accepted.set(key, spelling);
    memo.set(key, spelling);
  }
  try {
    await deps.store.put(accepted, source);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[spoken-name] could not store ${accepted.size} spelling(s): ${String(error)}`);
  }
}

async function readStore(keys: readonly string[], deps: SpokenNameDeps): Promise<void> {
  const unknown = keys.filter((key) => !memo.has(key));
  if (unknown.length === 0) return;
  try {
    const found = await deps.store.get(unknown);
    for (const [key, spelling] of found) memo.set(key, spelling);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[spoken-name] store unavailable, asking the model: ${String(error)}`);
  }
}

/**
 * The Devanagari spelling for one contact, for `campaign.customer.spokenName`.
 *
 * `undefined` when the table already covers the name (the pipeline
 * applies the table itself), when the model declined, or when no answer
 * arrived within `timeoutMs`. Never throws.
 */
export async function resolveSpokenName(
  name: string | null | undefined,
  options: { readonly timeoutMs: number },
  deps: SpokenNameDeps = defaultDeps,
): Promise<string | undefined> {
  const clean = cleanName(name ?? "");
  if (clean.length === 0 || !needsResolution(clean)) return undefined;
  const key = nameKeyOf(clean);

  await readStore([key], deps);
  if (memo.has(key)) return memo.get(key) ?? undefined;

  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const answers = await deps.spell([clean]);
        await acceptAndStore([clean], answers, deps, "dial");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[spoken-name] model request failed: ${String(error)}`);
      } finally {
        inFlight.delete(key);
      }
      return memo.has(key) ? (memo.get(key) ?? undefined) : undefined;
    })();
    inFlight.set(key, pending);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), options.timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolves every distinct name in a contact list ahead of its calls.
 * Batched, sequential (one request at a time), never throws. Returns how
 * many names were sent to the model.
 */
export async function prefetchSpokenNames(
  names: readonly (string | null | undefined)[],
  deps: SpokenNameDeps = defaultDeps,
): Promise<number> {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const clean = cleanName(raw ?? "");
    if (clean.length > 0 && needsResolution(clean) && !byKey.has(nameKeyOf(clean))) byKey.set(nameKeyOf(clean), clean);
  }
  await readStore([...byKey.keys()], deps);
  const missing = [...byKey.entries()].filter(([key]) => !memo.has(key)).map(([, name]) => name);

  for (let index = 0; index < missing.length; index += BATCH_SIZE) {
    const batch = missing.slice(index, index + BATCH_SIZE);
    try {
      await acceptAndStore(batch, await deps.spell(batch), deps, "import");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[spoken-name] batch of ${batch.length} failed: ${String(error)}`);
    }
  }
  return missing.length;
}

/** Every distinct contact name in one campaign, resolved in the background after an import. */
export async function prefetchCampaignSpokenNames(campaignId: string): Promise<void> {
  try {
    const rows = await query<{ name: string | null }>(
      "SELECT DISTINCT name FROM contacts WHERE campaign_id = $1 AND name IS NOT NULL",
      [campaignId],
    );
    const sent = await prefetchSpokenNames(rows.rows.map((row) => row.name));
    // eslint-disable-next-line no-console
    console.log(`[spoken-name] campaign=${campaignId} names=${rows.rows.length} resolved-now=${sent}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[spoken-name] prefetch for campaign=${campaignId} failed: ${String(error)}`);
  }
}

/** Test seam: forget what this process has read or resolved. */
export function resetSpokenNameMemo(): void {
  memo.clear();
  inFlight.clear();
}
