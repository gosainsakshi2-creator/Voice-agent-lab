/**
 * languages.constants.ts
 *
 * Human-readable metadata for each SupportedLanguage. Kept separate
 * from the enum itself so that display concerns never leak into
 * core types.
 */

import { SupportedLanguage } from "../types/enums";

export interface LanguageMetadata {
  readonly code: SupportedLanguage;
  readonly label: string;
  readonly bcp47Tag: string;
}

export const LANGUAGE_METADATA: Readonly<Record<SupportedLanguage, LanguageMetadata>> = {
  [SupportedLanguage.ENGLISH]: {
    code: SupportedLanguage.ENGLISH,
    label: "English",
    bcp47Tag: "en",
  },
  [SupportedLanguage.HINDI]: {
    code: SupportedLanguage.HINDI,
    label: "Hindi",
    bcp47Tag: "hi",
  },
  [SupportedLanguage.HINGLISH]: {
    code: SupportedLanguage.HINGLISH,
    label: "Hinglish",
    bcp47Tag: "multi",
  },
};

export const ALL_SUPPORTED_LANGUAGES: readonly SupportedLanguage[] =
  Object.values(SupportedLanguage);
