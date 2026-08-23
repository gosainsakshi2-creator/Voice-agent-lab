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
  /**
   * Whether the provider's own endpointer declared END OF SPEECH for
   * this segment, as opposed to merely closing a chunk it will not
   * revise (Deepgram's `speech_final` vs `is_final`).
   *
   * `isFinal` alone says "these words are settled" — a streaming
   * recognizer emits it repeatedly WHILE the caller is still talking,
   * at chunk boundaries. Treating that as the end of the caller's
   * thought is what makes an agent reply to half a sentence.
   *
   * OPTIONAL, and absence means "assume endpointed". Batch
   * transcription and providers with no equivalent signal therefore
   * keep their existing turn-detection behaviour unchanged.
   */
  readonly isSpeechFinal?: boolean;
  /**
   * OPTIONAL, ADDITIVE. This result carries NO new words — it is only
   * the provider's endpointer reporting that the speech it has already
   * delivered has ended.
   *
   * Deepgram sets `speech_final: true` on the Results message its
   * endpointer fires on. When every word of the utterance was already
   * returned in an earlier `is_final` message, that message arrives
   * with an EMPTY transcript and no word timings — the words and the
   * end-of-speech claim come in two separate messages. Dropping the
   * empty one (which is what an adapter does if it filters on
   * transcript text) throws the endpoint claim away, and the turn
   * detector then has to fall back to waiting out a full silence
   * window plus its chunk-boundary grace for a turn the provider had
   * already declared finished.
   *
   * A segment carrying this flag has no text, no timings and no
   * confidence worth reading. It is a signal, not a transcript:
   * consumers must route it to end-of-speech handling and must NOT
   * feed it anywhere a real segment goes. Absent everywhere else, so
   * every existing provider and consumer is unchanged.
   */
  readonly isEndOfSpeechMarker?: boolean;
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
