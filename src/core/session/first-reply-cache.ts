/**
 * first-reply-cache.ts
 *
 * The reply to a bare "Yes." after the identity question, kept across
 * calls, so the model is asked for it once instead of on every call.
 *
 * WHY IT IS SAFE TO REUSE. That reply is generated from nothing but the
 * script, the standing prompt and the identity exchange — the same on
 * every call of a campaign except for the contact's name. The key is a
 * hash of exactly what the model is sent, with the name masked out, so:
 *   - a different script, policy, prompt, question, language or model is
 *     a different key, and is generated fresh;
 *   - an edited script changes the text, so the key changes on its own —
 *     nothing has to be invalidated and no script needs a field for it.
 * A reply that says the contact's name is never stored (see the
 * pipeline), because it would greet the next caller with the wrong one.
 *
 * NEEDS NOTHING FROM A SCRIPT. It learns the reply from the first call
 * that generates it, for whatever script the customer uploaded.
 *
 * Memory only, per process: a restart simply generates it once more.
 */

import { createHash } from "node:crypto";

import type { ConversationTurn } from "../../types/provider.types";

/** Bump when the pipeline changes what a stored reply means, so older entries are never served. */
export const FIRST_REPLY_CACHE_SCHEMA = "first-reply-v1";

const DEFAULT_MAX_ENTRIES = 500;

/** Every spelling of the contact's name, longest first, as case-insensitive patterns. */
function namePatterns(names: readonly string[]): RegExp[] {
  const forms = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    forms.add(trimmed);
    for (const part of trimmed.split(/\s+/u)) if (part.length >= 2) forms.add(part);
  }
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"));
}

/**
 * The key for one prepared request: every input that shapes the reply,
 * with the contact's name masked so every call of a campaign shares it.
 */
export function firstReplyCacheKey(
  llmProviderId: string,
  history: readonly ConversationTurn[],
  contactNames: readonly string[],
): string {
  const patterns = namePatterns(contactNames);
  const mask = (text: string) => patterns.reduce((out, pattern) => out.replace(pattern, "{{contact}}"), text);
  const turns = history.map((turn) => [turn.role, mask(turn.content)]);
  return createHash("sha256")
    .update(JSON.stringify([FIRST_REPLY_CACHE_SCHEMA, llmProviderId, turns]), "utf8")
    .digest("hex");
}

export class FirstReplyCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  get(key: string): string | undefined {
    const text = this.entries.get(key);
    if (text === undefined) return undefined;
    // Least-recently-used order: a read moves the entry to the end.
    this.entries.delete(key);
    this.entries.set(key, text);
    return text;
  }

  put(key: string, text: string): void {
    this.entries.delete(key);
    this.entries.set(key, text);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

let processCache: FirstReplyCache | undefined;

/** One cache per process, shared by every call it runs. */
export function processFirstReplyCache(): FirstReplyCache {
  processCache ??= new FirstReplyCache();
  return processCache;
}
