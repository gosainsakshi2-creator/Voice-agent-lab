/**
 * campaign-types.ts
 *
 * Data shapes for the campaign layer. Provider ids are taken from the
 * existing `constants/providers.constants.ts` rather than restated,
 * so the campaign layer and the voice agent can never disagree about
 * what "cartesia" means.
 */

import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../../constants/providers.constants";

/**
 * The TTS providers this campaign programme compares.
 *
 * ElevenLabs joined this list as a first-class fourth lane. It was
 * always registered and healthy in the Provider Registry — the
 * exclusion was a campaign-layer scoping decision, not a capability
 * gap — so nothing about the adapter changed to get here.
 *
 * This constant is load-bearing well beyond a list: the dispatcher
 * builds ONE LANE PER ENTRY, and the load guardrails, lane concurrency
 * env keys, campaign audit and production-readiness summary all
 * enumerate it. A fourth lane does not raise the number of live calls —
 * `globalMaxConcurrent` is taken before any lane's own semaphore and
 * still binds — it only means a fourth queue is drained in parallel.
 */
export const CAMPAIGN_TTS_PROVIDERS = [
  TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
  TEXT_TO_SPEECH_PROVIDER_IDS.ELEVENLABS,
  TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
  TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
] as const;

export type CampaignTtsProvider = (typeof CAMPAIGN_TTS_PROVIDERS)[number];

export function isCampaignTtsProvider(value: string): value is CampaignTtsProvider {
  return (CAMPAIGN_TTS_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The language models a campaign can run on.
 *
 * Both were already registered and exercised through the same
 * `LanguageModelProvider` interface; only the campaign layer had no way
 * to name one, because the runtime carried a `"gpt-5.1"` string
 * literal. Neither adapter changed.
 */
export const CAMPAIGN_LLM_PROVIDERS = [
  LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
  LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
] as const;

export type CampaignLlmProvider = (typeof CAMPAIGN_LLM_PROVIDERS)[number];

export function isCampaignLlmProvider(value: string): value is CampaignLlmProvider {
  return (CAMPAIGN_LLM_PROVIDERS as readonly string[]).includes(value);
}

/** The carriers a campaign can dial through. */
export const CAMPAIGN_TELEPHONY_PROVIDERS = [
  TELEPHONY_PROVIDER_IDS.PLIVO,
  TELEPHONY_PROVIDER_IDS.VOBIZ,
] as const;

export type CampaignTelephonyProvider = (typeof CAMPAIGN_TELEPHONY_PROVIDERS)[number];

export function isCampaignTelephonyProvider(value: string): value is CampaignTelephonyProvider {
  return (CAMPAIGN_TELEPHONY_PROVIDERS as readonly string[]).includes(value);
}

export const CAMPAIGN_TYPES = ["registration", "reminder"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export function isCampaignType(value: string): value is CampaignType {
  return (CAMPAIGN_TYPES as readonly string[]).includes(value);
}

/**
 * Percentages, never counts. A campaign of any size is allocated from
 * these — nothing in the codebase contains a per-provider contact
 * total.
 */
export type ProviderAllocation = Readonly<Partial<Record<CampaignTtsProvider, number>>>;

/**
 * The LLM split, campaign-wide.
 *
 * Unlike the TTS allocation this is NOT apportioned across contacts at
 * import time and NOT locked per contact — there is no `contacts.llm`
 * column and no immutability trigger for it, deliberately. The model is
 * chosen per call from these percentages and then recorded on the
 * attempt, which is what makes "which model actually answered this
 * call" a fact about the call rather than an inference from config.
 */
export type LlmAllocation = Readonly<Partial<Record<CampaignLlmProvider, number>>>;

/** The carrier split, campaign-wide. Chosen per call, exactly like the LLM split. */
export type TelephonyAllocation = Readonly<Partial<Record<CampaignTelephonyProvider, number>>>;

/**
 * What a campaign created before this feature existed must behave like.
 *
 * Every campaign already in the database predates the LLM dimension and
 * ran on the `"gpt-5.1"` literal that used to sit in the call runner.
 * Reading a missing allocation as 100% GPT-5.1 is therefore not a
 * default in the "pick something sensible" sense — it is the exact
 * behaviour those campaigns already have, preserved. A stored
 * allocation always wins over it.
 */
export const LEGACY_LLM_ALLOCATION: LlmAllocation = {
  [LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1]: 100,
};

/** Defaults offered to NEW campaigns only. Nothing stored is ever re-read through these. */
export const DEFAULT_LLM_ALLOCATION: LlmAllocation = {
  [LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4]: 50,
  [LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1]: 50,
};

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "IMPORTING",
  "READY",
  "RUNNING",
  "PAUSED",
  "STOPPED",
  "COMPLETED",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignRecord {
  readonly id: string;
  readonly name: string;
  readonly campaignType: string;
  readonly status: CampaignStatus;
  readonly scriptId: string;
  readonly scriptVersion: string;
  readonly scriptHash: string;
  readonly providerAllocation: ProviderAllocation;
  /**
   * The campaign's original single-carrier column, untouched.
   *
   * Still written, still read, and still what a campaign with no
   * telephony allocation dials through — see `telephonyAllocation`.
   */
  readonly telephonyProvider: string;
  readonly language: string;
  readonly dispatchConfig: Readonly<Record<string, unknown>>;
  /**
   * Campaign-wide LLM split, read out of `dispatch_config.llmAllocation`.
   *
   * Resolves to `LEGACY_LLM_ALLOCATION` (100% GPT-5.1) for every
   * campaign that has no stored value, which is every campaign created
   * before this field existed — so their behaviour is unchanged.
   */
  readonly llmAllocation: LlmAllocation;
  /**
   * Campaign-wide carrier split, read out of
   * `dispatch_config.telephonyAllocation`.
   *
   * Resolves to 100% of `telephonyProvider` when absent, so a campaign
   * created before this field existed keeps dialling through exactly
   * the carrier its column names.
   */
  readonly telephonyAllocation: TelephonyAllocation;
  /**
   * Stored inside `dispatch_config.agent` rather than as its own
   * column, so Phase 3A adds no migration and the Phase 1 schema is
   * untouched. Promoting it to a real column is a later, additive
   * migration if querying by agent ever matters.
   */
  readonly agentGender: "male" | "female" | null;
  readonly totalContacts: number;
  readonly pilotStage: number;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

/** Outcome of validating a single CSV row. */
export interface ValidatedRow {
  readonly rowNumber: number;
  readonly name: string | null;
  readonly originalPhone: string;
  readonly normalizedPhone: string;
  readonly callType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export type RejectionReason =
  | "MISSING_PHONE"
  | "INVALID_PHONE"
  | "DUPLICATE_IN_FILE"
  | "MISSING_REQUIRED_NAME"
  | "EMPTY_ROW";

export interface RejectedRow {
  readonly rowNumber: number;
  readonly reason: RejectionReason;
  /** Human-readable, and phone-masked — safe to render and to log. */
  readonly message: string;
  /** Masked. The unmasked value is never carried out of the validator. */
  readonly maskedPhone: string | null;
  /** Present only for DUPLICATE_IN_FILE: the earlier row this collides with. */
  readonly duplicateOfRow?: number;
}

export interface ValidationSummary {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly duplicateRowsInFile: number;
  readonly emptyPhoneRows: number;
  readonly malformedPhoneRows: number;
  readonly missingNameRows: number;
  readonly emptyRows: number;
}

export interface ValidationResult {
  readonly summary: ValidationSummary;
  readonly valid: readonly ValidatedRow[];
  readonly rejected: readonly RejectedRow[];
}
