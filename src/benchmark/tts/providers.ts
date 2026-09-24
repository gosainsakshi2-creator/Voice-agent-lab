/**
 * providers.ts — the harness's view of the four configured TTS lanes.
 *
 * PHASE 4, EVIDENCE STEP. This file DESCRIBES the production
 * configuration and can construct the production adapters. It changes
 * nothing about either.
 *
 * ── HOW CONFIGURATION IS REPORTED, AND WHY IT IS REPORTED THIS WAY ─
 *
 * A baseline report is worthless if it can claim a setting the run did
 * not actually use, so no value here is copied from an adapter and
 * then asserted as fact. Configuration comes from exactly two places,
 * and each is labelled:
 *
 *   ENV-DERIVED — read at run time with `optionalEnv`, the same helper
 *   the adapters read through. When a variable is unset the report
 *   says `(unset - adapter default applies)` rather than restating the
 *   adapter's default, which would be a second copy of a literal that
 *   could drift. This mirrors what `production-readiness.ts` and
 *   `external-limits.ts` already do for the same variables.
 *
 *   ADAPTER-DECLARED — the speaking-rate constants are hard-coded in
 *   the adapters and are not configurable, so there is no env to read.
 *   They are declared here WITH the file they live in, and
 *   `tts-evidence-harness-tests.ts` reads that file and fails if the
 *   declaration and the adapter disagree. That is the same
 *   pinned-constant-plus-guard-test pattern the campaign suites already
 *   use to keep a test in step with an approved script line. The report
 *   is therefore never the authority — the adapter is — but it also
 *   cannot silently go stale.
 *
 * NO SECRET IS READ, STORED OR REPORTED. API keys are only ever tested
 * for PRESENCE, and only past the confirmation gate. `apiKeyEnv` names
 * the variable; its value never leaves `process.env`.
 */

import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";
import { optionalEnv } from "../../providers/shared/env";
import type { TextToSpeechProvider } from "../../interfaces/providers/text-to-speech-provider.interface";
import { ElevenLabsTextToSpeechProvider } from "../../providers/text-to-speech/elevenlabs.provider";
import { CartesiaTextToSpeechProvider } from "../../providers/text-to-speech/cartesia.provider";
import { SarvamTextToSpeechProvider } from "../../providers/text-to-speech/sarvam.provider";
import { SmallestAiTextToSpeechProvider } from "../../providers/text-to-speech/smallest-ai.provider";

/** Printed when a variable is unset, instead of restating the adapter's default. */
export const UNSET_NOTE = "(unset - adapter default applies)";

/**
 * A speaking-rate constant that lives in adapter source, not in the
 * environment. `sourceFile` plus `constantName` is what the guard test
 * greps; `declaredValue` is what the report prints.
 */
export interface AdapterDeclaredRate {
  /** The vendor's own parameter name, as sent on the wire. */
  readonly parameter: "speed" | "pace";
  readonly declaredValue: number;
  /** Repo-relative path to the adapter that owns the constant. */
  readonly sourceFile: string;
  /**
   * The identifier or literal the guard test looks for. For an adapter
   * that names its constant, this is the name; for one that inlines the
   * number, it is the property it is inlined on.
   */
  readonly constantName: string;
  /** Which synthesis paths carry it — the ElevenLabs drift is real and recorded. */
  readonly appliedOn: "both paths" | "streaming path only";
}

export interface HarnessProvider {
  readonly id: string;
  readonly displayName: string;
  /** Env var holding the credential. Read for PRESENCE only, never reported. */
  readonly apiKeyEnv: string;
  /** Env vars whose values are safe to report verbatim. */
  readonly configEnv: readonly { readonly label: string; readonly name: string }[];
  readonly declaredRate: AdapterDeclaredRate;
  /** How `SupportedLanguage` reaches this vendor. Prose, for the report. */
  readonly languageMapping: string;
  /** Constructs the PRODUCTION adapter. Reads credentials; never called on a dry run. */
  readonly construct: () => TextToSpeechProvider;
}

/**
 * The four lanes, in `CAMPAIGN_TTS_PROVIDERS` order.
 *
 * Every id comes from `TEXT_TO_SPEECH_PROVIDER_IDS` rather than a
 * string literal, so a renamed provider is a compile error here.
 */
export const HARNESS_PROVIDERS: readonly HarnessProvider[] = [
  {
    id: TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
    displayName: "Cartesia",
    apiKeyEnv: "CARTESIA_API_KEY",
    configEnv: [
      { label: "model", name: "CARTESIA_MODEL_ID" },
      { label: "voice", name: "CARTESIA_DEFAULT_VOICE_ID" },
      { label: "sampleRateHz", name: "CARTESIA_SAMPLE_RATE_HZ" },
    ],
    declaredRate: {
      parameter: "speed",
      declaredValue: 1.25,
      sourceFile: "src/providers/text-to-speech/cartesia.provider.ts",
      constantName: "speed",
      appliedOn: "both paths",
    },
    languageMapping: "en -> en; hi -> hi; hi-en (Hinglish) -> hi",
    construct: () => new CartesiaTextToSpeechProvider(),
  },
  {
    id: TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
    displayName: "ElevenLabs",
    apiKeyEnv: "ELEVENLABS_API_KEY",
    configEnv: [
      { label: "model", name: "ELEVENLABS_MODEL_ID" },
      { label: "voice", name: "ELEVENLABS_DEFAULT_VOICE_ID" },
      { label: "sampleRateHz", name: "ELEVENLABS_SAMPLE_RATE_HZ" },
    ],
    declaredRate: {
      parameter: "speed",
      declaredValue: 0.94,
      sourceFile: "src/providers/text-to-speech/elevenlabs.provider.ts",
      constantName: "speed",
      appliedOn: "streaming path only",
    },
    languageMapping: "en -> en; hi -> hi; hi-en (Hinglish) -> hi",
    construct: () => new ElevenLabsTextToSpeechProvider(),
  },
  {
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
    displayName: "Sarvam",
    apiKeyEnv: "SARVAM_API_KEY",
    configEnv: [
      { label: "model", name: "SARVAM_TTS_MODEL" },
      { label: "speaker", name: "SARVAM_DEFAULT_SPEAKER" },
      { label: "sampleRateHz", name: "SARVAM_SAMPLE_RATE_HZ" },
      { label: "baseUrl", name: "SARVAM_BASE_URL" },
    ],
    declaredRate: {
      parameter: "pace",
      declaredValue: 1.0,
      sourceFile: "src/providers/text-to-speech/sarvam.provider.ts",
      constantName: "SARVAM_PACE",
      appliedOn: "both paths",
    },
    languageMapping: "en -> en-IN; hi -> hi-IN; hi-en (Hinglish) -> hi-IN",
    construct: () => new SarvamTextToSpeechProvider(),
  },
  {
    id: TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
    displayName: "Smallest AI",
    apiKeyEnv: "SMALLEST_AI_API_KEY",
    configEnv: [
      { label: "voice", name: "SMALLEST_AI_DEFAULT_VOICE_ID" },
      { label: "sampleRateHz", name: "SMALLEST_AI_SAMPLE_RATE_HZ" },
      { label: "baseUrl", name: "SMALLEST_AI_BASE_URL" },
      { label: "streamBaseUrl", name: "SMALLEST_AI_STREAM_BASE_URL" },
    ],
    declaredRate: {
      parameter: "speed",
      declaredValue: 0.92,
      sourceFile: "src/providers/text-to-speech/smallest-ai.provider.ts",
      constantName: "speed",
      appliedOn: "both paths",
    },
    languageMapping: "NONE - the adapter sends no language field on either path",
    construct: () => new SmallestAiTextToSpeechProvider(),
  },
];

export const ALL_PROVIDER_IDS: readonly string[] = HARNESS_PROVIDERS.map((p) => p.id);

/** The env-derived half of a lane's configuration. Contains no secret. */
export interface EffectiveConfig {
  readonly providerId: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, string>>;
  readonly rate: AdapterDeclaredRate;
  readonly languageMapping: string;
  /** Presence only. Never the value, never a prefix of the value. */
  readonly apiKeyPresent: boolean;
  readonly apiKeyEnv: string;
}

/**
 * Reads what this run will actually use. Safe to call on a dry run:
 * it reads env, constructs nothing and contacts nobody.
 */
export function effectiveConfig(provider: HarnessProvider): EffectiveConfig {
  const settings: Record<string, string> = {};
  for (const { label, name } of provider.configEnv) {
    settings[label] = `${optionalEnv(name, UNSET_NOTE)}  [${name}]`;
  }
  const rawKey = process.env[provider.apiKeyEnv];
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    settings,
    rate: provider.declaredRate,
    languageMapping: provider.languageMapping,
    apiKeyPresent: typeof rawKey === "string" && rawKey.trim().length > 0,
    apiKeyEnv: provider.apiKeyEnv,
  };
}

/**
 * Parses `--providers=a,b`. An unknown id is a hard error, never a
 * silent no-op — the same rule `bench:llm` applies to `--models=`, and
 * for the same reason: a typo must not quietly run the wrong arms and
 * spend vendor credit on them.
 */
export function selectedProviderIds(argv: readonly string[], flag = "--providers="): readonly string[] {
  const found = argv.find((arg) => arg.startsWith(flag));
  if (!found) return ALL_PROVIDER_IDS;
  const requested = found
    .slice(flag.length)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0) throw new Error(`${flag} was given with no provider ids`);
  const unknown = requested.filter((id) => !ALL_PROVIDER_IDS.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown provider id(s): ${unknown.join(", ")}. Known: ${ALL_PROVIDER_IDS.join(", ")}`,
    );
  }
  return requested;
}

export function providerById(id: string): HarnessProvider {
  const provider = HARNESS_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`no harness provider for id "${id}"`);
  return provider;
}
