/**
 * transcript.ts
 *
 * Turns the voice agent's in-memory conversation into the JSON stored
 * on the outcome row.
 *
 * Read-only with respect to the pipeline: the source is the existing
 * `getTranscript` accessor, which projects the same `ConversationMemory`
 * the conversation already maintains. Nothing here changes what the
 * model sees or how a turn is recorded.
 *
 * The stored copy is what makes a better classifier possible later —
 * "re-score the pilot with a stricter rubric" has to be a query, not
 * another round of calls to the same people.
 */

import type { ConversationTurn } from "../../types/provider.types";

/** Kept small enough that a pathological call cannot bloat one JSONB row. */
const MAX_TURNS = 200;
const MAX_CHARS_PER_TURN = 2_000;

export interface TranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** ISO-8601. Stored as a string because that is what survives JSONB round-tripping. */
  readonly at: string | null;
}

export interface StoredTranscript {
  readonly turns: readonly TranscriptTurn[];
  readonly turnCount: number;
  /** True when the tail was dropped, so a short transcript is never mistaken for a short call. */
  readonly truncated: boolean;
  readonly capturedAt: string;
  readonly source: "conversation-memory";
}

/**
 * Normalises the manager's turns.
 *
 * System turns are dropped: they are the prompt, they are identical on
 * every call in the campaign, and storing them once per call would
 * mean the campaign's largest stored artefact is text it already has
 * in the script registry.
 */
export function toStoredTranscript(
  turns: readonly ConversationTurn[],
  capturedAt: Date = new Date(),
): StoredTranscript {
  const conversational = turns.filter(
    (turn): turn is ConversationTurn & { role: "user" | "assistant" } =>
      turn.role === "user" || turn.role === "assistant",
  );

  const kept = conversational.slice(0, MAX_TURNS).map((turn) => ({
    role: turn.role,
    text: String(turn.content ?? "").slice(0, MAX_CHARS_PER_TURN).trim(),
    at: toIso(turn.timestamp),
  }));

  return {
    turns: kept,
    turnCount: conversational.length,
    truncated: conversational.length > kept.length,
    capturedAt: capturedAt.toISOString(),
    source: "conversation-memory",
  };
}

function toIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

/** Reads a transcript back out of JSONB, tolerating anything malformed. */
export function fromStoredTranscript(value: unknown): readonly TranscriptTurn[] {
  if (typeof value !== "object" || value === null) return [];
  const turns = (value as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((turn) => {
    if (typeof turn !== "object" || turn === null) return [];
    const role = (turn as { role?: unknown }).role;
    const text = (turn as { text?: unknown }).text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") return [];
    const at = (turn as { at?: unknown }).at;
    return [{ role, text, at: typeof at === "string" ? at : null }];
  });
}
