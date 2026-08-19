/**
 * campaign-types.ts
 *
 * Data shapes for the campaign layer. Provider ids are taken from the
 * existing `constants/providers.constants.ts` rather than restated,
 * so the campaign layer and the voice agent can never disagree about
 * what "cartesia" means.
 */

import { TEXT_TO_SPEECH_PROVIDER_IDS } from "../../constants/providers.constants";

/** The TTS providers this campaign programme compares. ElevenLabs is deliberately out of scope. */
export const CAMPAIGN_TTS_PROVIDERS = [
  TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
  TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
  TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
] as const;

export type CampaignTtsProvider = (typeof CAMPAIGN_TTS_PROVIDERS)[number];

export function isCampaignTtsProvider(value: string): value is CampaignTtsProvider {
  return (CAMPAIGN_TTS_PROVIDERS as readonly string[]).includes(value);
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
  readonly telephonyProvider: string;
  readonly language: string;
  readonly dispatchConfig: Readonly<Record<string, unknown>>;
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
