/**
 * campaign-create-request.ts
 *
 * The body of `POST /api/campaigns`, built in ONE place from the
 * values the operator actually chose.
 *
 * WHY THIS IS NOT INLINE IN THE FORM.
 *
 * It used to be. The form assembled the request inside a
 * `useCallback` whose dependency array listed six of the nine values
 * the body is made of — `sttProvider`, `llmAllocation` and
 * `telephonyAllocation` were read but not declared. React memoises a
 * `useCallback` until one of its declared dependencies changes, so
 * clicking the Soniox button did not rebuild the callback, and the
 * one that ran still closed over the PREVIOUS render's `sttProvider`.
 * An operator who selected Soniox as their last action before pressing
 * Create sent `"deepgram"` — silently, with the button showing Soniox.
 * That is the defect this module exists to make structurally
 * impossible, not merely fixed once.
 *
 * Taking every field as one explicit argument object is what buys
 * that: the builder cannot read a value the caller did not pass, so
 * there is no closure for a value to go stale in, and the form's
 * dependency array can be checked against a single object rather than
 * against nine scattered reads.
 *
 * NO INFERENCE, NO DEFAULTING, NO NORMALISATION. The builder copies
 * what it is given. In particular it does NOT look at the campaign
 * name: a campaign called "soniox test" gets whatever recognizer the
 * operator selected, which may well be Deepgram. Provider selection is
 * explicit or it is nothing — guessing from a label is exactly the
 * kind of hidden substitution the incident was made of, in the
 * opposite direction.
 *
 * Pure, and deliberately free of React, `next/*` and every `ui/`
 * primitive, so the request body can be asserted in a plain Node test
 * without a DOM.
 */

import type { CampaignType } from "./campaign-types";

/** Percentage splits, exactly as the form holds them. */
export type PercentAllocation = Readonly<Record<string, number>>;

/** Everything the operator chose, passed explicitly. */
export interface CampaignCreateFields {
  readonly name: string;
  readonly campaignType: CampaignType;
  readonly language: string;
  readonly providerAllocation: PercentAllocation;
  readonly llmAllocation: PercentAllocation;
  readonly telephonyAllocation: PercentAllocation;
  /**
   * The recognizer the operator selected. Always sent, including when
   * it is the platform default: the column records a DECISION, and
   * "chose Deepgram" must stay distinguishable from "never chose".
   * The API stores an explicit value verbatim and only stores NULL
   * when the field is absent.
   */
  readonly sttProvider: string;
  /** Absent when no script is registered for the type. */
  readonly script?: { readonly id: string; readonly version: string } | undefined;
}

/** The JSON body of `POST /api/campaigns`. Shape unchanged from the inline version. */
export interface CampaignCreateBody {
  readonly name: string;
  readonly campaignType: CampaignType;
  readonly language: string;
  readonly providerAllocation: PercentAllocation;
  readonly llmAllocation: PercentAllocation;
  readonly telephonyAllocation: PercentAllocation;
  readonly sttProvider: string;
  readonly scriptId?: string;
  readonly scriptVersion?: string;
  readonly idempotencyKey: string;
}

/**
 * The idempotency key the form has always sent: derived from the
 * campaign's own identity so a double-submit or a refreshed form
 * resolves to the same campaign instead of creating a second one.
 *
 * Deliberately NOT a function of the provider selection. Including it
 * would make "same name, different recognizer" a different campaign,
 * which would quietly turn a corrected selection into a duplicate row
 * rather than the same campaign created once.
 */
export function campaignIdempotencyKey(campaignType: string, name: string): string {
  return `ui:${campaignType}:${name.trim().toLowerCase()}`;
}

/**
 * Builds the request body. A copy, not a transformation: every value
 * is the one the caller passed.
 */
export function buildCampaignCreateBody(fields: CampaignCreateFields): CampaignCreateBody {
  return {
    name: fields.name,
    campaignType: fields.campaignType,
    language: fields.language,
    providerAllocation: fields.providerAllocation,
    llmAllocation: fields.llmAllocation,
    telephonyAllocation: fields.telephonyAllocation,
    // Copied, never resolved. `resolveSttProviderId` in the call
    // runner is the ONLY place an id turns into a running provider,
    // and nothing here duplicates that precedence.
    sttProvider: fields.sttProvider,
    ...(fields.script ? { scriptId: fields.script.id, scriptVersion: fields.script.version } : {}),
    idempotencyKey: campaignIdempotencyKey(fields.campaignType, fields.name),
  };
}
