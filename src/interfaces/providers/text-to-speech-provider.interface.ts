/**
 * text-to-speech-provider.interface.ts
 *
 * Contract that ANY TTS vendor (ElevenLabs, Cartesia, Sarvam,
 * Smallest AI today, others tomorrow) must satisfy to be plugged
 * into the Provider Registry.
 */

import type {
  AudioPayload,
  ProviderDescriptor,
  ProviderHealthStatus,
  SynthesisRequest,
} from "../../types/provider.types";
import type { SessionId } from "../../types/session.types";
import type { TtsAudioChunk } from "../../types/streaming.types";

/**
 * Parameters required to synthesize speech within the context of a
 * session.
 */
export interface SynthesisTaskRequest {
  readonly sessionId: SessionId;
  readonly request: SynthesisRequest;
}

export interface TextToSpeechProvider {
  readonly descriptor: ProviderDescriptor;

  /**
   * Synthesize speech audio for the given text. Streaming audio
   * output is intentionally out of scope for this architecture
   * pass.
   */
  synthesize(task: SynthesisTaskRequest): Promise<AudioPayload>;

  /**
   * OPTIONAL, ADDITIVE. Synthesize speech audio for the given text,
   * yielding `TtsAudioChunk`s as they are produced rather than
   * waiting for the entire utterance to finish synthesizing. A
   * provider that does not implement streaming synthesis simply
   * omits this member; callers must feature-detect it
   * (`if (provider.synthesizeStream)`) and fall back to `synthesize`
   * otherwise. `signal`, when aborted, must stop emission promptly —
   * this is the mechanism the VoiceSessionManager uses to cut TTS
   * audio off immediately on barge-in. Does not replace or alter the
   * semantics of `synthesize`.
   */
  synthesizeStream?(task: SynthesisTaskRequest, signal?: AbortSignal): AsyncIterable<TtsAudioChunk>;

  /**
   * Report whether the provider's upstream connection is currently
   * reachable and authenticated.
   */
  checkHealth(): Promise<ProviderHealthStatus>;
}
