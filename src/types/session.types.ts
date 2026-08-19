/**
 * session.types.ts
 *
 * Data shapes describing a Voice Session — the top-level unit of
 * work orchestrated by the VoiceSessionManager. A session represents
 * one benchmarking call across a chosen provider stack.
 */

import type { CallDirection, ProviderCategory, SessionState, SupportedLanguage } from "./enums";
import type { ProviderHealthStatus, ProviderIdentifier } from "./provider.types";

/**
 * Immutable identifier for a session, assigned at creation time.
 */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * The full set of provider selections required to run a session.
 * This is the "stack" being benchmarked. Because every field is a
 * ProviderIdentifier (not a concrete class), swapping providers is
 * purely a configuration/data change.
 */
export interface ProviderStackSelection {
  readonly telephony: ProviderIdentifier;
  readonly speechToText: ProviderIdentifier;
  readonly languageModel: ProviderIdentifier;
  readonly textToSpeech: ProviderIdentifier;
}

/**
 * Parameters required to start a new Voice Session. Supplied by the
 * Dashboard to the VoiceSessionManager — never directly to any
 * provider.
 *
 * This is the COMPLETE benchmark configuration for a session:
 *  - Telephony / STT / LLM / Voice (TTS) providers — `providerStack`
 *  - Conversation language               — `language`
 *  - Destination number                  — `destinationNumber`
 *
 * Nothing else is required to start a benchmark run; anything
 * beyond these fields belongs in `metadata`, not as a new required
 * field, to keep this contract stable as the platform grows.
 */
export interface SessionCreationRequest {
  readonly language: SupportedLanguage;
  readonly direction: CallDirection;
  /** Telephony, Speech-To-Text, Language Model, and Voice (TTS) provider selection. */
  readonly providerStack: ProviderStackSelection;
  /** Required for CallDirection.OUTBOUND; irrelevant for INBOUND. */
  readonly destinationNumber?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * ADDITIVE, OPTIONAL. Present only for outbound campaign calls.
   * Absent for every existing caller, which is what keeps their
   * behavior byte-for-byte identical.
   */
  readonly campaign?: CampaignSessionContext;
}

/**
 * ADDITIVE, OPTIONAL. Everything an outbound campaign supplies to a
 * session: who the agent is, who is being called, and the two pieces
 * of already-interpolated text the campaign wants used.
 *
 * A session created WITHOUT this field behaves exactly as it did
 * before campaigns existed — same system prompt, same opening line.
 * Nothing in the conversation pipeline branches on the campaign; the
 * only difference is which strings it is handed.
 */
export interface CampaignSessionContext {
  readonly campaignId: string;
  readonly campaignType: string;
  readonly scriptId: string;
  readonly scriptVersion: string;
  readonly scriptHash: string;
  readonly agent: { readonly gender: "male" | "female"; readonly name: string };
  readonly customer: { readonly name: string };
  /** Appended AFTER the master system prompt. Placeholders already resolved. */
  readonly systemPromptAppendix: string;
  /** Spoken verbatim in place of the default greeting. Placeholders already resolved. */
  readonly openingLine: string;
}

/**
 * A point-in-time snapshot of a session's state, suitable for
 * exposing to the Dashboard via the VoiceSessionManager without
 * leaking provider internals.
 */
export interface SessionSnapshot {
  readonly id: SessionId;
  readonly state: SessionState;
  readonly language: SupportedLanguage;
  readonly direction: CallDirection;
  readonly providerStack: ProviderStackSelection;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt?: Date;
  readonly lastError?: SessionErrorInfo;
}

/**
 * Structured error information attached to a session snapshot when
 * `state === SessionState.ERROR`.
 */
export interface SessionErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly occurredAt: Date;
  readonly sourceCategory?: string;
}

/**
 * A single recorded state transition, used for building session
 * timelines / benchmarking latency between states (e.g. time spent
 * in THINKING vs SPEAKING).
 */
export interface SessionStateTransition {
  readonly from: SessionState;
  readonly to: SessionState;
  readonly at: Date;
  readonly reason?: string;
}

/**
 * Warm-up outcome for a single provider within the session's
 * ProviderStackSelection, produced while the session is in
 * `SessionState.WARMING_PROVIDERS`.
 */
export interface ProviderWarmupStatus {
  readonly category: ProviderCategory;
  readonly identifier: ProviderIdentifier;
  readonly health: ProviderHealthStatus;
  readonly warmedUpAt: Date;
}

/**
 * Aggregate result of warming up every provider in a session's
 * ProviderStackSelection. `isReady` is true only when every entry
 * in `providerStatuses` reports a healthy provider — this is the
 * gate the VoiceSessionManager evaluates before transitioning a
 * session from WARMING_PROVIDERS to READY.
 */
export interface SessionWarmupResult {
  readonly sessionId: SessionId;
  readonly isReady: boolean;
  readonly providerStatuses: readonly ProviderWarmupStatus[];
  readonly startedAt: Date;
  readonly completedAt?: Date;
}
