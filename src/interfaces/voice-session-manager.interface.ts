/**
 * voice-session-manager.interface.ts
 *
 * The Voice Session Manager is the ONLY component the Dashboard is
 * allowed to talk to. It orchestrates the full lifecycle of a
 * benchmarking call by resolving providers through the
 * ProviderRegistry and driving a session through the SessionState
 * machine. No UI code, and no other application code, may reach
 * into a provider directly.
 *
 *   Dashboard
 *     -> VoiceSessionManager
 *          -> ProviderRegistry
 *               -> TelephonyProvider / SpeechToTextProvider /
 *                  LanguageModelProvider / TextToSpeechProvider
 */

import type { SessionState } from "../types/enums";
import type {
  SessionCreationRequest,
  SessionId,
  SessionSnapshot,
  SessionStateTransition,
  SessionWarmupResult,
} from "../types/session.types";
import type { BenchmarkMetrics } from "../types/benchmark.types";

/**
 * Subscriber callback invoked whenever a session transitions
 * between states. Enables the Dashboard to reflect live state
 * (e.g. Listening -> Thinking -> Speaking) without polling.
 */
export type SessionStateListener = (
  sessionId: SessionId,
  transition: SessionStateTransition,
) => void;

export interface VoiceSessionManager {
  /**
   * Create a new session in `SessionState.INITIALIZING` from the
   * given request. Does not start the call — see `start`.
   */
  createSession(request: SessionCreationRequest): Promise<SessionSnapshot>;

  /**
   * Transition a session from INITIALIZING into WARMING_PROVIDERS
   * and instruct the ProviderRegistry to warm up every provider in
   * the session's ProviderStackSelection (e.g. open connections,
   * prime models/caches). Resolves once warm-up has finished; the
   * resulting `SessionSnapshot.state` is `READY` on success or
   * `ERROR` if any required provider failed to warm up.
   */
  warmUpProviders(sessionId: SessionId): Promise<SessionSnapshot>;

  /**
   * Retrieve the result of the most recent provider warm-up pass
   * for a session, including per-provider health detail. Useful for
   * the Dashboard to explain why a session is stuck in
   * WARMING_PROVIDERS or entered ERROR during warm-up.
   */
  getWarmupResult(sessionId: SessionId): Promise<SessionWarmupResult>;

  /**
   * Transition a session from READY into CALLING and begin
   * orchestrating the provider stack.
   */
  start(sessionId: SessionId): Promise<SessionSnapshot>;

  /**
   * Gracefully end a session, transitioning it through ENDING and
   * releasing any provider resources associated with it.
   */
  end(sessionId: SessionId): Promise<SessionSnapshot>;

  /**
   * Retrieve the current snapshot of a session.
   */
  getSnapshot(sessionId: SessionId): Promise<SessionSnapshot>;

  /**
   * Retrieve the current snapshot of every active or recently ended
   * session known to the manager.
   */
  listSessions(): Promise<readonly SessionSnapshot[]>;

  /**
   * Retrieve the full ordered history of state transitions for a
   * session — the raw material for latency benchmarking (e.g. time
   * spent in THINKING vs SPEAKING per provider stack).
   */
  getStateHistory(sessionId: SessionId): Promise<readonly SessionStateTransition[]>;

  /**
   * Retrieve the benchmark metrics collected for a session
   * (per-stage latencies, call duration, estimated cost, and the
   * provider stack under test). Populated as the session progresses
   * and finalized once the session reaches a terminal state.
   */
  getBenchmarkMetrics(sessionId: SessionId): Promise<BenchmarkMetrics>;

  /**
   * Subscribe to state transitions across all sessions. Returns an
   * unsubscribe function.
   */
  onStateChange(listener: SessionStateListener): () => void;

  /**
   * Type guard describing which transitions are legal from a given
   * state. Exposed so the Dashboard can disable invalid actions
   * without duplicating the state machine's rules.
   */
  canTransition(from: SessionState, to: SessionState): boolean;
}
