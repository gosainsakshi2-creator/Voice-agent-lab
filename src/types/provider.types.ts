/**
 * provider.types.ts
 *
 * Structural types shared by every provider category. These types
 * describe DATA that flows through the system, never behavior.
 * Behavior is defined exclusively in `interfaces/providers/*`.
 */

import type { ProviderCategory, SupportedLanguage } from "./enums";

/**
 * Uniquely identifies a provider implementation registered in the
 * ProviderRegistry. `id` must be unique within its `category`.
 *
 * Example: { category: "TEXT_TO_SPEECH", id: "elevenlabs" }
 */
export interface ProviderIdentifier {
  readonly category: ProviderCategory;
  readonly id: string;
}

/**
 * Metadata describing a provider implementation, independent of any
 * runtime credentials. Used for dashboard listing, benchmark matrix
 * generation, and capability negotiation — WITHOUT exposing the
 * concrete implementation to callers.
 */
export interface ProviderDescriptor extends ProviderIdentifier {
  readonly displayName: string;
  readonly supportedLanguages: readonly SupportedLanguage[];
  readonly version: string;
}

/**
 * Generic result envelope returned by provider health checks.
 * Kept generic (not provider-specific) so the ProviderRegistry can
 * reason about provider availability uniformly.
 */
export interface ProviderHealthStatus {
  readonly identifier: ProviderIdentifier;
  readonly isHealthy: boolean;
  readonly checkedAt: Date;
  readonly latencyMs?: number;
  readonly message?: string;
}

/**
 * Common shape for any audio payload exchanged between the Voice
 * Session Manager and a provider. Deliberately abstract — actual
 * encoding/transport concerns belong to provider implementations.
 */
export interface AudioPayload {
  readonly data: Uint8Array;
  readonly encoding: AudioEncoding;
  readonly sampleRateHz: number;
}

/**
 * Closed set of audio encodings the platform is willing to reason
 * about at the architecture level. Provider implementations are
 * responsible for transcoding to/from whatever the vendor requires.
 */
export type AudioEncoding = "PCM_16" | "MULAW" | "OPUS";

/**
 * A single normalized transcript fragment produced by an STT
 * provider, independent of vendor-specific response shapes.
 */
export interface TranscriptSegment {
  readonly text: string;
  readonly isFinal: boolean;
  readonly confidence: number;
  readonly language: SupportedLanguage;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

/**
 * A single normalized message exchanged with a Language Model
 * provider. Mirrors the conversational-turn concept without
 * committing to any one vendor's message schema.
 */
export interface ConversationTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly timestamp: Date;
}

/**
 * Normalized synthesis request handed to a TTS provider.
 */
export interface SynthesisRequest {
  readonly text: string;
  readonly language: SupportedLanguage;
  readonly voiceId?: string;
}
