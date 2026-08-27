/**
 * voice-session-manager.impl.ts
 *
 * Concrete implementation of the `VoiceSessionManager` interface
 * (see `interfaces/voice-session-manager.interface.ts`). Every
 * member of that interface is implemented with its documented
 * signature and semantics, unchanged.
 *
 * Beyond the interface, this class exposes a small number of
 * additional public methods — `pushInboundAudio`, `onOutboundAudio`,
 * `signalBargeIn` — which are NOT part of `VoiceSessionManager` and
 * are therefore invisible to the Dashboard (which only ever holds a
 * `VoiceSessionManager`-typed reference). They exist so a future
 * telephony media/webhook layer (explicitly out of scope for this
 * pass) has a concrete, real place to plug real-time audio in and
 * out without requiring another architecture change later.
 */

import { ProviderCategory, SessionState } from "../../types/enums";
import { SESSION_STATE_TRANSITIONS } from "../../constants/session-states.constants";
import { InvalidSessionStateTransitionError, SessionNotFoundError } from "../../core/errors";
import type {
  SessionCreationRequest,
  SessionId,
  SessionSnapshot,
  SessionStateTransition,
  SessionWarmupResult,
  ProviderWarmupStatus,
} from "../../types/session.types";
import type { BenchmarkMetrics } from "../../types/benchmark.types";
import type { AudioPayload } from "../../types/provider.types";
import type { ProviderRegistry } from "../../interfaces/provider-registry.interface";
import type {
  SessionStateListener,
  VoiceSessionManager,
} from "../../interfaces/voice-session-manager.interface";
import type { TelephonyCallHandle } from "../../interfaces/providers/telephony-provider.interface";

import { SessionRecord } from "./session-record";
import { ConversationPipeline, type PipelineHost, type ResolvedProviderStack } from "./conversation-pipeline";
import { toSessionErrorInfo } from "./error-recovery";

let sessionCounter = 0;
function generateSessionId(): SessionId {
  sessionCounter += 1;
  return `sess_${Date.now().toString(36)}_${sessionCounter.toString(36)}` as SessionId;
}

export class DefaultVoiceSessionManager implements VoiceSessionManager, PipelineHost {
  private readonly sessions = new Map<SessionId, SessionRecord>();
  private readonly pipelines = new Map<SessionId, ConversationPipeline>();
  private readonly listeners = new Set<SessionStateListener>();

  constructor(private readonly registry: ProviderRegistry) {}

  // ---------------------------------------------------------------
  // VoiceSessionManager
  // ---------------------------------------------------------------

  async createSession(request: SessionCreationRequest): Promise<SessionSnapshot> {
    // Fail fast on a bad provider stack selection rather than
    // discovering it later during warm-up — `resolve` throws
    // `ProviderNotFoundError` (a VoiceAgentError) if any id in the
    // stack isn't registered.
    this.registry.resolve(ProviderCategory.TELEPHONY, request.providerStack.telephony.id);
    this.registry.resolve(ProviderCategory.SPEECH_TO_TEXT, request.providerStack.speechToText.id);
    this.registry.resolve(ProviderCategory.LANGUAGE_MODEL, request.providerStack.languageModel.id);
    this.registry.resolve(ProviderCategory.TEXT_TO_SPEECH, request.providerStack.textToSpeech.id);

    const id = generateSessionId();
    const record = new SessionRecord(id, request, request.providerStack);
    this.sessions.set(id, record);
    return record.toSnapshot();
  }

  async warmUpProviders(sessionId: SessionId): Promise<SessionSnapshot> {
    const record = this.getRecordOrThrow(sessionId);
    this.transition(record, SessionState.WARMING_PROVIDERS, "warming up provider stack");

    const startedAt = new Date();
    const targets: ReadonlyArray<{ category: ProviderCategory; id: string }> = [
      { category: ProviderCategory.TELEPHONY, id: record.providerStack.telephony.id },
      { category: ProviderCategory.SPEECH_TO_TEXT, id: record.providerStack.speechToText.id },
      { category: ProviderCategory.LANGUAGE_MODEL, id: record.providerStack.languageModel.id },
      { category: ProviderCategory.TEXT_TO_SPEECH, id: record.providerStack.textToSpeech.id },
    ];

    const providerStatuses: ProviderWarmupStatus[] = await Promise.all(
      targets.map(async (target) => {
        const provider = this.registry.resolve(target.category, target.id);
        const health = await provider.checkHealth();
        return {
          category: target.category,
          identifier: { category: target.category, id: target.id },
          health,
          warmedUpAt: new Date(),
        };
      }),
    );
    const isReady = providerStatuses.every((status) => status.health.isHealthy);
    const warmupResult: SessionWarmupResult = {
      sessionId,
      isReady,
      providerStatuses,
      startedAt,
      completedAt: new Date(),
    };
    record.warmupResult = warmupResult;

    if (isReady) {
      this.transition(record, SessionState.READY, "all providers healthy");
    } else {
      const unhealthy = providerStatuses.filter((status) => !status.health.isHealthy);
      record.lastError = {
        code: "PROVIDER_WARMUP_FAILED",
        message: `${unhealthy.length} provider(s) failed warm-up: ${unhealthy
          .map((status) => `${status.identifier.category}/${status.identifier.id}`)
          .join(", ")}`,
        occurredAt: new Date(),
      };
      this.transition(record, SessionState.ERROR, "one or more providers failed warm-up");
    }

    return record.toSnapshot();
  }

  async getWarmupResult(sessionId: SessionId): Promise<SessionWarmupResult> {
    const record = this.getRecordOrThrow(sessionId);
    if (!record.warmupResult) {
      throw new Error(`Warm-up has not been run yet for session "${sessionId}".`);
    }
    return record.warmupResult;
  }

  async start(sessionId: SessionId): Promise<SessionSnapshot> {
    const record = this.getRecordOrThrow(sessionId);
    // eslint-disable-next-line no-console
    console.log(`[session-mgr:${sessionId}] start() called, current state=${record.state}`);
    this.transition(record, SessionState.CALLING, "placing/accepting the call");

    const telephony = this.registry.resolve(ProviderCategory.TELEPHONY, record.providerStack.telephony.id);
    // eslint-disable-next-line no-console
    console.log(`[session-mgr:${sessionId}] telephony.startCall() — provider=${record.providerStack.telephony.id}`);
    const handle: TelephonyCallHandle = await telephony.startCall({
      sessionId,
      ...(record.request.destinationNumber !== undefined
        ? { destinationNumber: record.request.destinationNumber }
        : {}),
    });
    record.telephonyHandle = handle;
    // eslint-disable-next-line no-console
    console.log(`[session-mgr:${sessionId}] call placed, providerCallId=${handle.providerCallId}, hasOpenMediaStream=${typeof telephony.openMediaStream === "function"}`);

    if (telephony.openMediaStream) {
      // A provider that can hand back a live media stream directly
      // from startCall() has already confirmed the call is
      // connected — safe to move straight into the conversation.
      record.mediaStream = await telephony.openMediaStream(handle);
      this.beginConversation(record);
    }
    // Otherwise (Plivo: the REST API above only confirms the call was
    // *placed* — the phone may still be ringing) the conversation is
    // started later by `confirmCallAnswered`, once the Answer-URL
    // webhook fires and tells us the callee actually picked up.

    return record.toSnapshot();
  }

  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. Called by the
   * Plivo Answer-URL webhook once Plivo confirms the callee has
   * actually answered — as opposed to `start()` above, which only
   * *places* the call and returns as soon as Plivo's REST API
   * accepts the request (while the phone is still ringing). Moves
   * the session from CALLING to LISTENING and starts the
   * ConversationPipeline for the first time; a no-op if the session
   * already moved on (ended, errored, or already answered) so a
   * stray/duplicate webhook delivery can't double-start the pipeline.
   */
  confirmCallAnswered(sessionId: SessionId): void {
    const record = this.getRecordOrThrow(sessionId);
    // eslint-disable-next-line no-console
    console.log(`[session-mgr:${sessionId}] confirmCallAnswered() called, current state=${record.state}`);
    if (record.state !== SessionState.CALLING) {
      // eslint-disable-next-line no-console
      console.log(`[session-mgr:${sessionId}] confirmCallAnswered() skipped — state is ${record.state}, not CALLING`);
      return;
    }
    this.beginConversation(record);
  }

  private beginConversation(record: SessionRecord): void {
    // Benchmark clock origin. This is the single point every
    // telephony path converges on once the callee has actually picked
    // up — Plivo and Vobiz both arrive here via `confirmCallAnswered`
    // from their media-stream "start" event, and a provider that can
    // hand back a live stream from startCall() arrives here directly.
    // Anchoring here (rather than at createSession, where the metrics
    // collector is constructed) is what keeps dial and ring time out
    // of Call Duration, identically for both providers.
    record.metrics.markCallAnswered();

    // eslint-disable-next-line no-console
    console.log(
      `[session-mgr:${record.id}] beginConversation() — resolving providers: telephony=${record.providerStack.telephony.id} stt=${record.providerStack.speechToText.id} llm=${record.providerStack.languageModel.id} tts=${record.providerStack.textToSpeech.id}`,
    );

    const providers: ResolvedProviderStack = {
      telephony: this.registry.resolve(ProviderCategory.TELEPHONY, record.providerStack.telephony.id),
      stt: this.registry.resolve(ProviderCategory.SPEECH_TO_TEXT, record.providerStack.speechToText.id),
      llm: this.registry.resolve(ProviderCategory.LANGUAGE_MODEL, record.providerStack.languageModel.id),
      tts: this.registry.resolve(ProviderCategory.TEXT_TO_SPEECH, record.providerStack.textToSpeech.id),
    };

    this.transition(record, SessionState.LISTENING, "call connected");

    // eslint-disable-next-line no-console
    console.log(
      `[session-mgr:${record.id}] providers resolved, state now LISTENING, creating ConversationPipeline, hasMediaStream=${!!record.mediaStream}`,
    );

    record.loopAbortController = new AbortController();
    const pipeline = new ConversationPipeline(record, providers, this);
    this.pipelines.set(record.id, pipeline);
    record.loopPromise = pipeline.run();
  }

  async end(sessionId: SessionId): Promise<SessionSnapshot> {
    const record = this.getRecordOrThrow(sessionId);
    // eslint-disable-next-line no-console
    console.log(`[session-mgr:${sessionId}] end() called, current state=${record.state}`);

    // FIX #11 — release any TTS transport pre-opened for this session.
    //
    // Deliberately ahead of the IDLE early-return below, so a session
    // that has already ended by another route still cannot leave a
    // socket behind. The provider's `disposeSession` is idempotent and
    // is a no-op for a session that was never prepared, so this is safe
    // to run unconditionally and changes nothing else about teardown —
    // no state transition, no metric, no ordering that anything depends
    // on. The loop abort further down would also release it through the
    // signal the pipeline passed; this is the belt to that braces, for
    // the paths where the loop was never running.
    try {
      const tts = this.registry.resolve(
        ProviderCategory.TEXT_TO_SPEECH,
        record.providerStack.textToSpeech.id,
      );
      tts.disposeSession?.(sessionId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[session-mgr:${sessionId}] TTS transport dispose skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (record.state === SessionState.IDLE) {
      // Already fully ended (e.g. the Dashboard's End Call and the
      // Plivo media stream closing due to a remote hangup both
      // resolved to this call) — nothing left to do.
      // eslint-disable-next-line no-console
      console.log(`[session-mgr:${sessionId}] end() no-op — already IDLE`);
      return record.toSnapshot();
    }

    record.bargeIn.triggerBargeIn();
    record.loopAbortController?.abort();
    record.inboundAudioFallback.close();

    if (record.state !== SessionState.ERROR) {
      this.transition(record, SessionState.ENDING, "ending the call");
    }

    if (record.loopPromise) {
      await record.loopPromise.catch(() => undefined);
    }

    if (record.mediaStream) {
      await record.mediaStream.close().catch(() => undefined);
    }
    if (record.telephonyHandle) {
      const telephony = this.registry.resolve(ProviderCategory.TELEPHONY, record.providerStack.telephony.id);
      await telephony.endCall(record.telephonyHandle).catch(() => undefined);
    }

    record.metrics.markCallEnded();
    record.endedAt = new Date();

    if (this.canTransition(record.state, SessionState.IDLE)) {
      this.transition(record, SessionState.IDLE, "call ended");
    }

    this.pipelines.delete(sessionId);
    return record.toSnapshot();
  }

  async getSnapshot(sessionId: SessionId): Promise<SessionSnapshot> {
    return this.getRecordOrThrow(sessionId).toSnapshot();
  }

  async listSessions(): Promise<readonly SessionSnapshot[]> {
    return Array.from(this.sessions.values()).map((record) => record.toSnapshot());
  }

  async getStateHistory(sessionId: SessionId): Promise<readonly SessionStateTransition[]> {
    return [...this.getRecordOrThrow(sessionId).stateHistory];
  }

  async getBenchmarkMetrics(sessionId: SessionId): Promise<BenchmarkMetrics> {
    return this.getRecordOrThrow(sessionId).metrics.build();
  }

  onStateChange(listener: SessionStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canTransition(from: SessionState, to: SessionState): boolean {
    return SESSION_STATE_TRANSITIONS[from].includes(to);
  }

  // ---------------------------------------------------------------
  // PipelineHost (internal, used by ConversationPipeline)
  // ---------------------------------------------------------------

  transition(record: SessionRecord, to: SessionState, reason?: string): void {
    if (!this.canTransition(record.state, to)) {
      // eslint-disable-next-line no-console
      console.error(
        `[session-mgr:${record.id}] INVALID TRANSITION: ${record.state} -> ${to} (reason: ${reason ?? "none"})`,
      );
      throw new InvalidSessionStateTransitionError(record.state, to);
    }

    const transitionRecord: SessionStateTransition = {
      from: record.state,
      to,
      at: new Date(),
      ...(reason !== undefined ? { reason } : {}),
    };

    // eslint-disable-next-line no-console
    console.log(
      `[session-mgr:${record.id}] transition: ${record.state} -> ${to} (reason: ${reason ?? "none"})`,
    );

    record.state = to;
    record.updatedAt = transitionRecord.at;
    record.stateHistory.push(transitionRecord);

    for (const listener of this.listeners) listener(record.id, transitionRecord);
  }

  markError(record: SessionRecord, sourceCategory: string, error: unknown): void {
    record.lastError = toSessionErrorInfo(error, sourceCategory);
    // eslint-disable-next-line no-console
    console.error(
      `[session-mgr:${record.id}] markError: source=${sourceCategory} state=${record.state} error=${record.lastError.message}`,
    );
    if (this.canTransition(record.state, SessionState.ERROR)) {
      this.transition(record, SessionState.ERROR, `${sourceCategory} error: ${record.lastError.message}`);
    }
  }

  // ---------------------------------------------------------------
  // Extra, non-interface capabilities (real-time audio plumbing).
  // Not part of VoiceSessionManager — invisible to the Dashboard.
  // ---------------------------------------------------------------

  /**
   * Feed inbound audio for a session that has no telephony-provided
   * `TelephonyMediaStream` (i.e. `openMediaStream` isn't
   * implemented yet). A future webhook/media-bridge layer, or a
   * test harness, calls this as real audio arrives.
   */
  private inboundAudioPushCount = new Map<SessionId, number>();

  pushInboundAudio(sessionId: SessionId, chunk: AudioPayload): void {
    const record = this.getRecordOrThrow(sessionId);
    const count = (this.inboundAudioPushCount.get(sessionId) ?? 0) + 1;
    this.inboundAudioPushCount.set(sessionId, count);

    if (!record.mediaStream) {
      record.inboundAudioFallback.push(chunk);
    }
  }

  /** Subscribe to synthesized audio as the pipeline produces it. Returns an unsubscribe function. */
  onOutboundAudio(
    sessionId: SessionId,
    listener: (chunk: AudioPayload) => void | Promise<void>,
  ): () => void {
    const record = this.getRecordOrThrow(sessionId);
    record.outboundAudioListeners.add(listener);
    return () => record.outboundAudioListeners.delete(listener);
  }

  /**
   * Manually signal a barge-in for a session — used when the
   * telephony transport can detect "the caller started talking"
   * faster than STT can confirm it, or by tests exercising
   * interruption handling without a real streaming STT provider.
   */
  /**
   * @returns whether the barge-in was ACCEPTED. A transport that clears
   *   its own playback buffer for latency must only do so when the
   *   answer is `true`: the pipeline declines a barge-in while the fixed
   *   opening line is still playing (see
   *   `ConversationPipeline.triggerExternalBargeIn`), and a transport
   *   that dropped the queue anyway would leave the caller in silence
   *   with nothing left to play and no reply on the way.
   */
  signalBargeIn(sessionId: SessionId): boolean {
    const record = this.getRecordOrThrow(sessionId);
    const pipeline = this.pipelines.get(sessionId);
    if (pipeline) {
      return pipeline.triggerExternalBargeIn();
    }
    record.bargeIn.triggerBargeIn();
    return true;
  }

  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. Mirrors
   * `pushInboundAudio` / `onOutboundAudio` / `signalBargeIn` above:
   * a small read-only accessor added for the integration layer so
   * the Dashboard can render a live transcript, sourced from the
   * exact same `ConversationMemory` the pipeline already maintains
   * internally. Does not alter any existing method's signature or
   * behavior, and duplicates no orchestration logic — it only
   * exposes state that already exists.
   */
getTranscript(sessionId: SessionId): readonly import("../../types/provider.types").ConversationTurn[] {
  const record = this.getRecordOrThrow(sessionId);
  const committed = record.memory
    .history()
    .filter(turn => turn.role !== "system");

  // Display-only tail: the utterance the caller is speaking right
  // now, as reported by streaming STT before turn-end. It lives
  // only in this projection — `memory` (and therefore the LLM) is
  // untouched — and is replaced by the real turn once committed.
  if (record.liveUserTranscript.length === 0) return committed;
  return [
    ...committed,
    { role: "user" as const, content: record.liveUserTranscript, timestamp: new Date() },
  ];
}

  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. Read-only companion to
   * `getTranscript` above: epoch-ms of the last conversation activity
   * the pipeline actually heard (streaming STT segments, interim
   * included), or `0` if nothing has been heard on this call yet.
   * Exposes state that already exists so a caller-side watchdog can
   * tell an active call from a silent one without watching session
   * state transitions, which do not fire while a caller is speaking.
   */
  lastActivityAt(sessionId: SessionId): number {
    return this.getRecordOrThrow(sessionId).lastConversationActivityAt;
  }

  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. The transport reporting
   * that the CALLER is audibly speaking right now, from its own energy
   * VAD rather than from a transcript.
   *
   * `lastConversationActivityAt` was previously written from STT
   * segments alone, which made the campaign silence watchdog's notion
   * of a live call depend on one provider socket staying up: a stalled
   * or dead STT stream reported an actively talking caller as silence,
   * and the watchdog hung up on them. The bridges already compute this
   * signal for barge-in, so this is the same observation written to the
   * same field — an OR, never a replacement, so a caller who says
   * nothing still produces no activity and genuine silence still ends
   * the call at exactly the same deadline.
   *
   * Writes one timestamp and nothing else: no state transition, no
   * effect on turn detection, barge-in, the LLM or playback.
   */
  noteCallerSpeech(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.lastConversationActivityAt = Date.now();
  }

  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. The transport reporting
   * that it is hearing LOUD, near-end speech right now — a strictly
   * stronger claim than `noteCallerSpeech` above, from the same energy
   * VAD at a higher threshold (see the loud gate in
   * `vad-segmenter.ts`).
   *
   * This is the signal that lets the pipeline tell the caller talking
   * over the assistant apart from a television, a second person across
   * the room, or the echo of our own audio out of the caller's
   * earpiece. All three are transcribed by Deepgram exactly like real
   * speech, and every one of them used to cut the assistant off
   * mid-sentence — the reported "background voice interrupts the agent
   * and it goes quiet" behaviour.
   *
   * Writes two timestamps and nothing else: no state transition, no
   * effect on turn detection, the LLM or playback. Loud speech is also
   * conversation activity, so `lastConversationActivityAt` is stamped
   * too — an OR with `noteCallerSpeech`, never a replacement, so the
   * silence watchdog's deadline is unchanged.
   */
  noteCallerEnergy(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const now = Date.now();
    record.lastCallerEnergyAt = now;
    record.lastConversationActivityAt = now;
  }

  // ---------------------------------------------------------------

  private getRecordOrThrow(sessionId: SessionId): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new SessionNotFoundError(sessionId);
    }
    return record;
  }
}

/** Convenience factory mirroring `bootstrapProviderRegistry`'s style. */
export function createVoiceSessionManager(registry: ProviderRegistry): VoiceSessionManager {
  return new DefaultVoiceSessionManager(registry);
}