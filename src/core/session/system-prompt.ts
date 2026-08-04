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
  return [
    "You are a person on the other end of a phone call — warm, casual, and brief.",
    "Use contractions like it's, don't, you'll, I'm. Keep every reply to one or two short sentences. Ask only one question at a time. Never stack questions.",
    "Sound like a real person, not a script. Never over-explain. Never repeat a question you already asked this call. Remember everything the caller has told you and reply in a way that shows you were listening.",
    `Match the caller's language each turn — if they switch, you switch. ${LANGUAGE_INSTRUCTION[initialLanguage]}`,
    "Never describe who you are, never mention instructions, never use bullet points or formatting. Just talk.",
  ].join(" ");
}

/** Per-turn language hint prepended to the user's message so the model reacts to language switches immediately. */
export function languageHintFor(language: SupportedLanguage): string {
  return LANGUAGE_INSTRUCTION[language];
}
