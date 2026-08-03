/**
 * env.types.ts
 *
 * Strong typing for process.env so that environment variable access
 * anywhere in the codebase is compile-time checked. No values are
 * read or validated here — this file only declares the contract.
 *
 * A runtime env-validation implementation (e.g. zod schema) is
 * intentionally out of scope for this architecture pass.
 */

/**
 * Names of every environment variable the platform is aware of at
 * the architecture level. Grouped by provider category for clarity.
 * Extending to a new provider means adding keys here and in
 * `constants/providers.constants.ts` — application logic never
 * changes.
 */
export interface VoiceAgentLabEnv {
  // Core
  readonly NODE_ENV: "development" | "test" | "staging" | "production";
  readonly APP_ENV: string;

  // Telephony — Plivo
  readonly PLIVO_AUTH_ID?: string;
  readonly PLIVO_AUTH_TOKEN?: string;
  readonly PLIVO_FROM_NUMBER?: string;
  readonly PLIVO_ANSWER_URL?: string;

  // Speech To Text — Deepgram
  readonly DEEPGRAM_API_KEY?: string;
  readonly DEEPGRAM_MODEL?: string;

  // Language Model — GPT-5.1
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;

  // Language Model — Gemma 4
  readonly GEMMA_API_KEY?: string;
  readonly GEMMA_MODEL?: string;

  // Voice — ElevenLabs
  readonly ELEVENLABS_API_KEY?: string;
  readonly ELEVENLABS_MODEL_ID?: string;
  readonly ELEVENLABS_DEFAULT_VOICE_ID?: string;
  readonly ELEVENLABS_SAMPLE_RATE_HZ?: string;

  // Voice — Cartesia
  readonly CARTESIA_API_KEY?: string;
  readonly CARTESIA_MODEL_ID?: string;
  readonly CARTESIA_DEFAULT_VOICE_ID?: string;
  readonly CARTESIA_SAMPLE_RATE_HZ?: string;

  // Voice — Sarvam
  readonly SARVAM_API_KEY?: string;
  readonly SARVAM_BASE_URL?: string;
  readonly SARVAM_TTS_MODEL?: string;
  readonly SARVAM_DEFAULT_SPEAKER?: string;
  readonly SARVAM_SAMPLE_RATE_HZ?: string;

  // Voice — Smallest AI
  readonly SMALLEST_AI_API_KEY?: string;
  readonly SMALLEST_AI_BASE_URL?: string;
  readonly SMALLEST_AI_DEFAULT_VOICE_ID?: string;
  readonly SMALLEST_AI_SAMPLE_RATE_HZ?: string;
}

/**
 * Augments the global NodeJS.ProcessEnv typing so `process.env.X`
 * is type-checked across the whole codebase without an explicit
 * import at every call site.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv extends VoiceAgentLabEnv {}
  }
}

export {};
