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
   */
  recentHistory(maxPairs: number = 6): readonly ConversationTurn[] {
    const systemTurn = this.turns[0];
    if (!systemTurn || systemTurn.role !== "system") return this.turns;

    const nonSystem = this.turns.slice(1);
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
