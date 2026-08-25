/**
 * conversation-memory.ts
 *
 * In-call memory for a single Voice Session: the full turn history
 * (fed to the Language Model as context), the current language and
 * topic, lightweight extracted entities, user preferences mentioned
 * during the call, and a record of previously-asked assistant
 * questions so the conversation doesn't repeat itself.
 *
 * Deliberately a plain in-memory structure — persistence beyond a
 * single session's lifetime is out of scope for this pass (a
 * session's memory dies with the session, matching the existing
 * SessionState machine which has no "resume a past call" concept).
 */

import type { SupportedLanguage } from "../../types/enums";
import type { ConversationTurn } from "../../types/provider.types";

export interface ConversationEntity {
  readonly kind: "number" | "phone" | "proper_noun";
  readonly value: string;
  readonly mentionedAt: Date;
  readonly turnIndex: number;
}

export interface ConversationMemorySnapshot {
  readonly turns: readonly ConversationTurn[];
  readonly language: SupportedLanguage;
  readonly topic?: string;
  readonly entities: readonly ConversationEntity[];
  readonly preferences: Readonly<Record<string, string>>;
  readonly turnCount: number;
}

const PHONE_LIKE = /\b(\+?\d[\d\s-]{7,}\d)\b/g;
const STANDALONE_NUMBER = /\b\d+(?:\.\d+)?\b/g;
const PROPER_NOUN = /\b[A-Z][a-zA-Z]{2,}\b/g;

/** Normalizes text for repeat-question comparison: case/punctuation/whitespace insensitive. */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  return /^(what|who|when|where|why|how|kya|kaun|kab|kahan|kaise|kyun)\b/i.test(trimmed);
}

export class ConversationMemory {
  private readonly turns: ConversationTurn[] = [];
  private readonly entities: ConversationEntity[] = [];
  private readonly preferences = new Map<string, string>();
  private readonly askedQuestions = new Set<string>();
  private language: SupportedLanguage;
  private topic: string | undefined;
  private turnCount = 0;

  constructor(initialLanguage: SupportedLanguage, systemPrompt: string) {
    this.language = initialLanguage;
    this.turns.push({ role: "system", content: systemPrompt, timestamp: new Date() });
  }

  /** Records a user utterance, updates the tracked language, and extracts entities. */
  recordUserTurn(text: string, detectedLanguage: SupportedLanguage): ConversationTurn {
    this.language = detectedLanguage;
    const turn: ConversationTurn = { role: "user", content: text, timestamp: new Date() };
    this.turns.push(turn);
    this.extractEntities(text);
    this.turnCount += 1;
    return turn;
  }

  /** Records an assistant utterance and remembers it if it was a question, to avoid repeats. */
  recordAssistantTurn(text: string): ConversationTurn {
    const turn: ConversationTurn = { role: "assistant", content: text, timestamp: new Date() };
    this.turns.push(turn);
    if (looksLikeQuestion(text)) {
      this.askedQuestions.add(normalizeForComparison(text));
    }
    return turn;
  }

  /** True if a semantically-similar (normalized) question has already been asked this call. */
  hasAskedSimilarQuestion(candidateQuestion: string): boolean {
    return this.askedQuestions.has(normalizeForComparison(candidateQuestion));
  }

  rememberPreference(key: string, value: string): void {
    this.preferences.set(key, value);
  }

  getPreference(key: string): string | undefined {
    return this.preferences.get(key);
  }

  setTopic(topic: string): void {
    this.topic = topic;
  }

  getTopic(): string | undefined {
    return this.topic;
  }

  get currentLanguage(): SupportedLanguage {
    return this.language;
  }

  /** Full turn history in Language-Model-ready order, including the leading system turn. */
  history(): readonly ConversationTurn[] {
    return this.turns;
  }

  /**
   * Windowed turn history for LLM requests: system turn + last
   * `maxPairs` user/assistant exchange pairs. Keeps the LLM context
   * bounded so token usage and latency don't grow with call length,
   * while preserving enough recent context for a natural conversation.
   *
   * WHY THE WINDOW IS 20 PAIRS AND NOT 6.
   *
   * The window is what the model knows it has already said. At 6 pairs
   * (12 entries) the opening turns fall out of it after six exchanges —
   * including the assistant turn carrying the introduction and the
   * first script block. From that point on the model is being asked to
   * "continue from where you were" while looking at a history in which
   * it never introduced itself and never opened the pitch, so it
   * re-introduces and re-opens. That is a context-construction bug, not
   * a prompt one: `conversation-policy.ts` already says "never repeat
   * the opening line", and the instruction is unactionable when the
   * line is no longer in the history.
   *
   * 20 pairs covers a whole call rather than the last minute of it.
   * `CAMPAIGN_MAX_CALL_SECONDS` is 180s by default and one exchange is
   * an agent block plus a reply — roughly 8-10s — so ~20 exchanges is
   * the whole conversation. It is still a WINDOW, so the original
   * guarantee holds: token usage stays bounded and a call that somehow
   * runs long cannot grow the prompt without limit.
   *
   * Cost is not a concern at this size. The campaign system prompt
   * measures ~12,400 prompt tokens and is served from the provider's
   * prefix cache (see `primeLlmPrefixCache`); 40 short conversational
   * turns are on the order of a thousand tokens against it.
   */
  recentHistory(maxPairs: number = 20): readonly ConversationTurn[] {
    return ConversationMemory.window(this.turns, maxPairs);
  }

  /**
   * READ-ONLY PREVIEW: exactly what `recentHistory()` would return
   * immediately after `recordUserTurn(text, …)` — the same window over
   * the same turns with that one user turn appended — WITHOUT recording
   * anything. Nothing is pushed, the language is not updated, no entity
   * is extracted and the turn count does not move.
   *
   * Exists so a request can be prepared for a user turn the pipeline
   * has not yet committed, and be identical (role for role, content for
   * content) to the one it will build once it does. Sharing `window`
   * with `recentHistory` is what makes that identity hold by
   * construction rather than by duplication.
   */
  previewRecentHistory(pendingUserText: string, maxPairs: number = 20): readonly ConversationTurn[] {
    const pending: ConversationTurn = { role: "user", content: pendingUserText, timestamp: new Date() };
    return ConversationMemory.window([...this.turns, pending], maxPairs);
  }

  /** The single windowing rule behind `recentHistory` and `previewRecentHistory`. */
  private static window(turns: readonly ConversationTurn[], maxPairs: number): readonly ConversationTurn[] {
    const systemTurn = turns[0];
    if (!systemTurn || systemTurn.role !== "system") return turns;

    const nonSystem = turns.slice(1);
    // Each pair is a user + assistant turn = 2 entries.
    const maxEntries = maxPairs * 2;
    const windowed = nonSystem.length <= maxEntries
      ? nonSystem
      : nonSystem.slice(-maxEntries);
    return [systemTurn, ...windowed];
  }

  snapshot(): ConversationMemorySnapshot {
    return {
      turns: [...this.turns],
      language: this.language,
      ...(this.topic !== undefined ? { topic: this.topic } : {}),
      entities: [...this.entities],
      preferences: Object.fromEntries(this.preferences),
      turnCount: this.turnCount,
    };
  }

  private extractEntities(text: string): void {
    const now = new Date();

    for (const match of text.matchAll(PHONE_LIKE)) {
      this.entities.push({ kind: "phone", value: match[0].trim(), mentionedAt: now, turnIndex: this.turnCount });
    }

    // Proper nouns are matched first and stripped out before the
    // standalone-number pass so a capitalized word containing digits
    // (rare, but e.g. product codes) isn't double-counted.
    for (const match of text.matchAll(PROPER_NOUN)) {
      this.entities.push({ kind: "proper_noun", value: match[0], mentionedAt: now, turnIndex: this.turnCount });
    }

    const withoutPhones = text.replace(PHONE_LIKE, " ");
    for (const match of withoutPhones.matchAll(STANDALONE_NUMBER)) {
      this.entities.push({ kind: "number", value: match[0], mentionedAt: now, turnIndex: this.turnCount });
    }
  }
}
