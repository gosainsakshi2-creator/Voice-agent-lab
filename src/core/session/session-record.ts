/**
 * session-record.ts
 *
 * The mutable, internal-only bookkeeping the VoiceSessionManager
 * implementation keeps per session. Nothing in this file is part of
 * the public `VoiceSessionManager`/`SessionSnapshot` contracts — it
 * is the private state those public shapes are derived from.
 */

import { SessionState } from "../../types/enums";
import type {
  ProviderStackSelection,
  SessionCreationRequest,
  SessionErrorInfo,
  SessionId,
  SessionSnapshot,
  SessionStateTransition,
  SessionWarmupResult,
} from "../../types/session.types";
import { TTS_VOICE_METADATA } from "../../constants/voice.constants";
import type { AudioPayload } from "../../types/provider.types";
import type { TelephonyCallHandle } from "../../interfaces/providers/telephony-provider.interface";
import type { TelephonyMediaStream } from "../../types/streaming.types";
import { ConversationMemory } from "./conversation-memory";
import { SessionMetricsCollector } from "./metrics-collector";
import { BargeInController } from "./barge-in-controller";
import { AdaptiveTurnDetector } from "./turn-detection";
import { AsyncQueue } from "./async-queue";
import { buildSystemPrompt } from "./system-prompt";

export class SessionRecord {
  state: SessionState = SessionState.INITIALIZING;
  readonly createdAt: Date = new Date();
  updatedAt: Date = new Date();
  endedAt: Date | undefined;
  lastError: SessionErrorInfo | undefined;

  readonly stateHistory: SessionStateTransition[] = [];
  warmupResult: SessionWarmupResult | undefined;

  telephonyHandle: TelephonyCallHandle | undefined;
  mediaStream: TelephonyMediaStream | undefined;

  /** Fallback inbound-audio source used whenever the telephony provider has no `openMediaStream`. */
  readonly inboundAudioFallback = new AsyncQueue<AudioPayload>();
  /**
   * A listener MAY return a promise to apply backpressure: the pipeline
   * awaits it before handing over the next chunk. Telephony bridges use
   * this to stop a streaming TTS provider (which synthesizes ~25x faster
   * than real time) from building a multi-second backlog in their own
   * outbound queue. Returning `void` — the original contract — keeps the
   * previous fire-and-forget behaviour.
   */
  readonly outboundAudioListeners = new Set<(chunk: AudioPayload) => void | Promise<void>>();

  /** Set while `start()`'s conversation loop is running; used to stop the loop on `end()`. */
  loopAbortController: AbortController | undefined;
  loopPromise: Promise<void> | undefined;

  turnIndex = 0;

  /**
   * Latest STT text for the utterance currently in progress —
   * DISPLAY ONLY. Written from interim (and final) Deepgram
   * segments so the Dashboard can show what the caller is saying
   * without waiting for turn-end. It is never read by the turn
   * detector, never sent to the LLM, and is cleared the moment the
   * real user turn is committed to `memory`.
   */
  liveUserTranscript = "";

  /**
   * Epoch-ms of the last real conversation activity observed inside the
   * pipeline — an STT segment for the caller (interim segments
   * included). Session STATE transitions are not the whole story: a
   * caller who is mid-utterance produces streaming transcripts but no
   * transition, so a silence watchdog that only watches transitions
   * sees an actively talking caller as silent. `0` means nothing has
   * been heard yet, which is genuine silence.
   */
  lastConversationActivityAt = 0;

  /**
   * Epoch-ms at which the TRANSPORT last reported LOUD, near-end speech
   * energy — its own RMS measurement, not a transcript. Written only by
   * `noteCallerEnergy`; see the loud gate in `vad-segmenter.ts` for why
   * this is a different question from `lastConversationActivityAt`.
   *
   * Read by the pipeline to corroborate a transcript before treating it
   * as the caller talking over the assistant: Deepgram transcribes a
   * television, a second person across the room and the echo of our own
   * audio just as readily as it transcribes the caller, and a barge-in
   * on any of those cuts the assistant off mid-sentence for nobody.
   *
   * `0` means no transport on this session reports energy at all — the
   * in-process audio fallback, and the test harnesses — which the
   * pipeline reads as "no corroboration is available here", falling
   * back to exactly the transcript-only behaviour it had before.
   */
  lastCallerEnergyAt = 0;

  /**
   * Epoch-ms at which the STT provider last delivered ANY segment —
   * interim or final, with or without text — to the pipeline's
   * transcript loop. Written only there. A statement about the STT
   * connection being ALIVE, not about the caller: it is read by the
   * transports' energy-only barge-in fallback, which exists solely for
   * a dead STT socket and must not fire while Deepgram is demonstrably
   * still delivering.
   *
   * `0` means no segment has arrived on this call yet, which the
   * fallback treats as "no evidence STT is alive" — i.e. exactly its
   * previous behaviour.
   */
  lastSttEvidenceAt = 0;

  readonly memory: ConversationMemory;
  readonly metrics: SessionMetricsCollector;
  /** Grammatical gender of the selected TTS voice — also drives the deterministic Hindi greeting. */
  readonly voiceGender: "male" | "female";
  /**
   * Campaign greeting for this call, already interpolated. `undefined`
   * for every non-campaign session, which then uses the existing
   * `openingLineFor` line exactly as before.
   */
  readonly campaignOpeningLine: string | undefined;
  readonly bargeIn = new BargeInController();
  readonly turnDetector = new AdaptiveTurnDetector();

  constructor(
    
    readonly id: SessionId,
    readonly request: SessionCreationRequest,
    readonly providerStack: ProviderStackSelection,
  ) {
    const providerId = request.providerStack.textToSpeech.id;
    const voiceGender = TTS_VOICE_METADATA.get(request.providerStack.textToSpeech.id) ?? "female";
    this.voiceGender = voiceGender;

    // Campaign scenario, when this session belongs to a campaign. The
    // master prompt is unchanged either way — `buildSystemPrompt`
    // appends this after it rather than replacing anything.
    this.campaignOpeningLine = request.campaign?.openingLine;

    this.memory = new ConversationMemory(
    request.language,
    buildSystemPrompt(
        request.language,
        voiceGender,
        request.campaign?.systemPromptAppendix
    )
);
    this.metrics = new SessionMetricsCollector(id, providerStack);
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      state: this.state,
      language: this.memory.currentLanguage,
      direction: this.request.direction,
      providerStack: this.providerStack,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }
}
