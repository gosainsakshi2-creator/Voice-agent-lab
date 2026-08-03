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
  readonly outboundAudioListeners = new Set<(chunk: AudioPayload) => void>();

  /** Set while `start()`'s conversation loop is running; used to stop the loop on `end()`. */
  loopAbortController: AbortController | undefined;
  loopPromise: Promise<void> | undefined;

  turnIndex = 0;

  readonly memory: ConversationMemory;
  readonly metrics: SessionMetricsCollector;
  readonly bargeIn = new BargeInController();
  readonly turnDetector = new AdaptiveTurnDetector();

  constructor(
    readonly id: SessionId,
    readonly request: SessionCreationRequest,
    readonly providerStack: ProviderStackSelection,
  ) {
    this.memory = new ConversationMemory(request.language, buildSystemPrompt(request.language));
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
