/**
 * streaming.types.ts
 *
 * ADDITIVE ONLY. These types describe the shapes used by the new,
 * optional streaming members appended to the four provider
 * interfaces (see `interfaces/providers/*`). Nothing here replaces,
 * renames, or narrows an existing type in `provider.types.ts` or
 * `session.types.ts` — this file only introduces new vocabulary so
 * a provider MAY expose partial/incremental results in addition to
 * its existing batch (`Promise<FullResult>`) contract.
 *
 * A provider that does not implement the optional streaming member
 * is exactly as valid as it was before this file existed.
 */

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "./provider.types";
import type { SessionId } from "./session.types";

/**
 * A single incremental token/text delta emitted by a streaming
 * Language Model completion, prior to the final assembled turn.
 */
export interface LlmTokenEvent {
  readonly type: "token";
  readonly delta: string;
  readonly index: number;
}

/**
 * Terminal event of a streaming Language Model completion, carrying
 * the same normalized `ConversationTurn` + latency shape as the
 * existing batch `CompletionResult`, so callers can treat the last
 * event of a stream exactly like a batch result.
 */
export interface LlmFinalEvent {
  readonly type: "final";
  readonly turn: ConversationTurn;
  readonly latencyMs: number;
}

export type LlmStreamEvent = LlmTokenEvent | LlmFinalEvent;

/**
 * A single chunk of synthesized audio emitted by a streaming TTS
 * call. `isFinal` marks the last chunk for a given synthesis
 * request so callers don't need a separate "end" sentinel type.
 */
export interface TtsAudioChunk {
  readonly audio: AudioPayload;
  readonly sequence: number;
  readonly isFinal: boolean;
}

/**
 * Parameters for a streaming transcription call. Mirrors
 * `TranscriptionRequest` except `audio` is an ongoing async source
 * of chunks rather than one complete payload, since the whole point
 * of streaming STT is not waiting for the caller to finish speaking
 * before transcription begins.
 */
export interface StreamingTranscriptionRequest {
  readonly sessionId: SessionId;
  readonly audio: AsyncIterable<AudioPayload>;
  readonly language: import("./enums").SupportedLanguage;
  readonly signal?: AbortSignal;
}

/**
 * Re-exported for call sites that only need the partial/final
 * transcript shape while streaming — identical to the existing
 * `TranscriptSegment`, kept as an alias so streaming call sites
 * read naturally without importing two names for one shape.
 */
export type StreamingTranscriptSegment = TranscriptSegment;

/**
 * A duplex handle over a live telephony call's media, returned by a
 * `TelephonyProvider`'s optional `openMediaStream`. Deliberately
 * narrow: inbound audio arrives as an async source, outbound audio
 * is pushed by the caller, and `interruptPlayback` gives the
 * VoiceSessionManager a single, vendor-neutral way to implement
 * barge-in (stop whatever audio the far end is currently hearing).
 */
export interface TelephonyMediaStream {
  readonly sessionId: SessionId;

  /** Audio arriving from the far end of the call, as it arrives. */
  readonly inbound: AsyncIterable<AudioPayload>;

  /** Push a chunk of synthesized audio to the far end. */
  sendAudio(chunk: AudioPayload): Promise<void>;

  /**
   * Stop playback of any audio queued or in-flight toward the far
   * end immediately. Used exclusively for barge-in: the moment the
   * far end starts talking over the assistant, the manager calls
   * this before anything else.
   */
  interruptPlayback(): Promise<void>;

  /** Release the underlying media resources. */
  close(): Promise<void>;
}
