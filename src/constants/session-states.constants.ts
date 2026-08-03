/**
 * session-states.constants.ts
 *
 * Declarative definition of the legal SessionState transition
 * graph. This is the single source of truth consumed by
 * `VoiceSessionManager.canTransition` — the state machine's rules
 * live in data, not scattered conditionals.
 *
 *   IDLE -> INITIALIZING -> WARMING_PROVIDERS -> READY -> CALLING -> LISTENING
 *     <-> THINKING <-> SPEAKING -> ENDING -> IDLE
 *
 *   WARMING_PROVIDERS is the phase in which the VoiceSessionManager
 *   asks the ProviderRegistry to pre-warm (e.g. establish
 *   connections, prime caches/models) every provider in the
 *   session's ProviderStackSelection before declaring the session
 *   READY. It exists as its own state — rather than being folded
 *   into INITIALIZING — so that warm-up latency is independently
 *   observable in `SessionStateTransition` history and therefore in
 *   benchmark metrics.
 *
 *   Any non-terminal state may transition to ERROR.
 *   ERROR may transition to ENDING (graceful cleanup) or IDLE
 *   (reset for reuse).
 */

import { SessionState } from "../types/enums";

export const SESSION_STATE_TRANSITIONS: Readonly<
  Record<SessionState, readonly SessionState[]>
> = {
  [SessionState.IDLE]: [SessionState.INITIALIZING],
  [SessionState.INITIALIZING]: [SessionState.WARMING_PROVIDERS, SessionState.ERROR, SessionState.ENDING],
  [SessionState.WARMING_PROVIDERS]: [SessionState.READY, SessionState.ERROR, SessionState.ENDING],
  [SessionState.READY]: [SessionState.CALLING, SessionState.ERROR, SessionState.ENDING],
  [SessionState.CALLING]: [SessionState.LISTENING, SessionState.ERROR, SessionState.ENDING],
  [SessionState.LISTENING]: [SessionState.THINKING, SessionState.ERROR, SessionState.ENDING],
  [SessionState.THINKING]: [SessionState.SPEAKING, SessionState.ERROR, SessionState.ENDING],
  [SessionState.SPEAKING]: [SessionState.LISTENING, SessionState.ERROR, SessionState.ENDING],
  [SessionState.ENDING]: [SessionState.IDLE, SessionState.ERROR],
  [SessionState.ERROR]: [SessionState.ENDING, SessionState.IDLE],
};

/**
 * States considered "active" — a session occupying one of these is
 * consuming provider resources (open telephony channel, live
 * audio streams, etc.).
 */
export const ACTIVE_SESSION_STATES: readonly SessionState[] = [
  SessionState.CALLING,
  SessionState.LISTENING,
  SessionState.THINKING,
  SessionState.SPEAKING,
];

/**
 * States considered terminal for a given call attempt.
 */
export const TERMINAL_SESSION_STATES: readonly SessionState[] = [
  SessionState.IDLE,
  SessionState.ERROR,
];
