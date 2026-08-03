/**
 * speech-to-text-provider.interface.ts
 *
 * Contract that ANY STT vendor (Deepgram today, others tomorrow)
 * must satisfy to be plugged into the Provider Registry.
 */

import type {
  AudioPayload,
  ProviderDescriptor,
  ProviderHealthStatus,
  TranscriptSegment,
} from "../../types/provider.types";
import type { SupportedLanguage } from "../../types/enums";
import type { SessionId } from "../../types/session.types";
import type { StreamingTranscriptionRequest } from "../../types/streaming.types";

/**
 * Parameters required to transcribe a single audio payload within
 * the context of a session.
 */
export interface TranscriptionRequest {
  readonly sessionId: SessionId;
  readonly audio: AudioPayload;
  readonly language: SupportedLanguage;
}

export interface SpeechToTextProvider {
  readonly descriptor: ProviderDescriptor;

  /**
   * Transcribe a single audio payload and return normalized
   * transcript segments. Streaming/partial-result semantics are
   * intentionally left to the implementation's own internal
   * mechanics and are out of scope for this architecture pass.
   */
  transcribe(request: TranscriptionRequest): Promise<readonly TranscriptSegment[]>;

  /**
   * OPTIONAL, ADDITIVE. Transcribe an ongoing audio source,
   * yielding partial (`isFinal: false`) and final (`isFinal: true`)
   * `TranscriptSegment`s as they become available, rather than
   * waiting for the caller to finish speaking. A provider that does
   * not implement true streaming transcription simply omits this
   * member; callers must feature-detect it (`if (provider.transcribeStream)`)
   * and fall back to `transcribe` otherwise. Does not replace or
   * alter the semantics of `transcribe`.
   */
  transcribeStream?(request: StreamingTranscriptionRequest): AsyncIterable<TranscriptSegment>;

  /**
   * Report whether the provider's upstream connection is currently
   * reachable and authenticated.
   */
  checkHealth(): Promise<ProviderHealthStatus>;
}
