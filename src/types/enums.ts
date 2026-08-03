/**
 * enums.ts
 *
 * Canonical, closed sets of values used throughout Voice Agent Lab.
 * These are intentionally kept provider-agnostic. Provider-specific
 * identifiers live in `constants/providers.constants.ts` as literal
 * unions/consts, NOT here, so that adding a provider never requires
 * touching core session/state logic.
 */

/**
 * Lifecycle states of a single Voice Session.
 * A session is always in exactly one state. Transitions between
 * states are owned exclusively by the VoiceSessionManager.
 */
export enum SessionState {
  IDLE = "IDLE",
  INITIALIZING = "INITIALIZING",
  WARMING_PROVIDERS = "WARMING_PROVIDERS",
  READY = "READY",
  CALLING = "CALLING",
  LISTENING = "LISTENING",
  THINKING = "THINKING",
  SPEAKING = "SPEAKING",
  ENDING = "ENDING",
  ERROR = "ERROR",
}

/**
 * The four provider categories the Provider Registry is capable of
 * resolving. Every provider implementation belongs to exactly one
 * category.
 */
export enum ProviderCategory {
  TELEPHONY = "TELEPHONY",
  SPEECH_TO_TEXT = "SPEECH_TO_TEXT",
  LANGUAGE_MODEL = "LANGUAGE_MODEL",
  TEXT_TO_SPEECH = "TEXT_TO_SPEECH",
}

/**
 * Languages supported by the benchmarking matrix.
 * Kept as an enum (rather than a free string) so that a benchmark
 * run can be statically validated against supported combinations.
 */
export enum SupportedLanguage {
  ENGLISH = "en",
  HINDI = "hi",
  HINGLISH = "hi-en",
}

/**
 * Direction of a telephony call relative to the platform.
 */
export enum CallDirection {
  INBOUND = "INBOUND",
  OUTBOUND = "OUTBOUND",
}

/**
 * Severity classification for VoiceAgentError and structured logs.
 */
export enum ErrorSeverity {
  WARNING = "WARNING",
  RECOVERABLE = "RECOVERABLE",
  FATAL = "FATAL",
}

/**
 * High level environment the runtime is executing in.
 * Used by configuration loaders to select environment-specific
 * validation rules (e.g. stricter secrets handling in production).
 */
export enum RuntimeEnvironment {
  DEVELOPMENT = "development",
  TEST = "test",
  STAGING = "staging",
  PRODUCTION = "production",
}
