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
import {
  CONTROL_ENDPOINTING_MS,
  resolveEndpointingMs,
  type EndpointingAssignment,
} from "./stt-endpointing-experiment";

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

  /**
   * READ-ONLY, INSTALLED BY THE TRANSPORT: how many ms of already
   * handed-over assistant audio are still sitting in the transport's
   * own outbound queue, unsent.
   *
   * The pipeline hands audio to a bridge faster than real time and the
   * bridge paces it out at 20ms a frame, holding up to its high-water
   * mark (2800ms on the Plivo and Vobiz pumps). A barge-in DISCARDS
   * that queue. So the pipeline's own "how long has playback been
   * running" clock — which starts at the first hand-off — leads the
   * caller's ears by exactly this much, and everything inside it was
   * never heard.
   *
   * `undefined` means no transport reports a backlog — the in-process
   * audio fallback and the test harnesses, where hand-off IS delivery
   * — and the pipeline then reads it as `0`, i.e. exactly the
   * arithmetic it had before. Whole frames only; the bridges compute it
   * from their existing queue length and frame duration, so this
   * introduces no second timing model and no new threshold.
   */
  outboundBacklogMs: (() => number) | undefined;

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

  /**
   * PHASE 3 BATCH 1 — TELEMETRY ONLY. Wall clock at which the media
   * bridge's outbound pump sent the first audio frame of the CURRENT
   * TURN toward the caller.
   *
   * Written by `noteOutboundFrameSent` and cleared once per turn by
   * `beginTurnTiming`, so it pairs with the pipeline's own
   * `firstAudioQueuedAtMs` to give the playback-startup span. Nothing
   * reads it to make a decision: no gate, no timer, no threshold and
   * no branch in the call path consults it.
   *
   * `undefined` means "no frame has been sent since this turn began" —
   * which is the correct report for a turn that produced no audio, and
   * for any session with no bridge attached at all.
   */
  firstOutboundFrameAtMs: number | undefined;

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
  /**
   * The campaign's identity question, or `undefined` for a session that
   * has nobody to check. Read once by `ConversationPipeline` to decide
   * whether this call has an identity gate at all.
   */
  readonly campaignIdentityLine: string | undefined;
  readonly bargeIn = new BargeInController();
  readonly turnDetector = new AdaptiveTurnDetector();

  /**
   * PHASE 3 — CONTROLLED ENDPOINTING A/B. Which `endpointing` value
   * this call's STT socket is opened with, decided ONCE, before the
   * socket exists.
   *
   * `undefined` means no assignment was made for this session — every
   * path that predates the experiment, and every harness that builds a
   * record by hand. The pipeline resolves that to the production 400
   * through `resolveEndpointingMs`, so an unassigned session behaves
   * exactly as it does today.
   *
   * Written only by `assignSttEndpointing`, which is idempotent, so a
   * retried webhook or a re-entered `beginConversation` cannot move a
   * live call between arms mid-flight.
   */
  sttEndpointing: EndpointingAssignment | undefined;

  /**
   * The ALREADY-RESOLVED `endpointing` value for this call's STT
   * socket, in ms. Always a member of the closed set, always present,
   * and 400 until an assignment says otherwise — so the audio pipeline
   * reads a plain number and has nothing to validate.
   *
   * Deliberately a separate field from `sttEndpointing` above. That
   * one is the AUDIT RECORD (arm, key, split) and may legitimately be
   * absent; this one is the OPERATIONAL VALUE and may not. Keeping
   * them apart is what removed the last place a configuration error
   * could be raised inside the pipeline's STT loop, whose `catch`
   * swallows exceptions by design and would have turned such a throw
   * into a silently deaf call.
   */
  sttEndpointingMs: number = CONTROL_ENDPOINTING_MS;

  /**
   * Records this call's endpointing arm and the value its socket will
   * run. First write wins, for the same reason `markCallAnswered` and
   * `noteSttModel` are idempotent: this is reached from a path a
   * retried webhook can re-enter, and the arm a call ran on must be
   * one value for the whole call.
   */
  assignSttEndpointing(assignment: EndpointingAssignment): EndpointingAssignment {
    if (this.sttEndpointing === undefined) {
      this.sttEndpointing = assignment;
      // Validated once, at the single write point. `assignEndpointing`
      // has already resolved it; this is the guard that keeps the
      // invariant true for any other caller.
      this.sttEndpointingMs = resolveEndpointingMs(assignment.endpointingMs);
    }
    return this.sttEndpointing;
  }

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
    this.campaignIdentityLine = request.campaign?.identityLine;

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
