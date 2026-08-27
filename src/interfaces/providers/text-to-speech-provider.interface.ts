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
   * OPTIONAL, ADDITIVE — FIX #11. A hint that this session is about to
   * need synthesis, so a provider whose transport costs a handshake may
   * open that connection NOW rather than on the caller's clock.
   *
   * Contract, and it is deliberately narrow:
   *
   *   - It is a HINT. It must never be required for correctness. A
   *     provider that does not implement it, or that fails to prepare
   *     anything, must behave exactly as it does today — which is why
   *     this returns `void` rather than a promise the caller could
   *     await, and why it must never throw.
   *   - It is a NETWORK ACTION ONLY. It must not synthesize, must not
   *     send any application data on the connection it opens, must not
   *     produce audio, and must have no bearing on turn-taking. Nothing
   *     downstream may become dependent on having been called.
   *   - It is SESSION-SCOPED. Anything it opens belongs to `sessionId`
   *     alone and must never be handed to another session.
   *   - `signal`, when aborted, must release whatever was prepared.
   *
   * Callers feature-detect it (`if (provider.prepareSession)`) and are
   * free never to call it at all.
   */
  prepareSession?(sessionId: SessionId, signal?: AbortSignal): void;

  /**
   * OPTIONAL, ADDITIVE — FIX #11. Release anything `prepareSession`
   * opened for this session. Called once when the session tears down.
   * Must be idempotent, must never throw, and must be safe to call for
   * a session that was never prepared.
   */
  disposeSession?(sessionId: SessionId): void;

  /**
   * Report whether the provider's upstream connection is currently
   * reachable and authenticated.
   */
  checkHealth(): Promise<ProviderHealthStatus>;
}
