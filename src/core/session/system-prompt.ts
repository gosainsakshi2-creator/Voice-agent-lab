/**
 * system-prompt.ts
 *
 * Builds the leading `system` `ConversationTurn` handed to the
 * Language Model provider for every session. Written as plain prose
 * — no bullet points, section headers, or structured labels — so
 * models that lack a dedicated system-instruction channel (e.g.
 * Gemma, which folds system text into the conversation) cannot
 * echo structural artefacts back to the caller.
 */

import { SupportedLanguage } from "../../types/enums";

const LANGUAGE_INSTRUCTION: Readonly<Record<SupportedLanguage, string>> = {
  [SupportedLanguage.ENGLISH]: "The caller is currently speaking English. Reply in English.",
  [SupportedLanguage.HINDI]: "The caller is currently speaking Hindi. Reply in Hindi.",
  [SupportedLanguage.HINGLISH]:
    "The caller is naturally mixing Hindi and English. Reply naturally in Hinglish, the way people actually speak.",
};

export function buildSystemPrompt(initialLanguage: SupportedLanguage): string {
  return `You are a friendly person on a phone call. Talk naturally in short sentences, under 15 words. Ask one question at a time. Match the caller's language. Never use bullet points, markdown, lists, or formatting. ${LANGUAGE_INSTRUCTION[initialLanguage]}`;
}
/** Per-turn language hint prepended to the user's message so the model reacts to language switches immediately. */
export function languageHintFor(language: SupportedLanguage): string {
  return LANGUAGE_INSTRUCTION[language];
}
