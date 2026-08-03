/**
 * session-state-meta.ts
 *
 * Presentation-only metadata for `SessionState`: display labels and
 * a fixed color token per state. The actual legal-transition graph
 * is never duplicated here — it's read directly from
 * `SESSION_STATE_TRANSITIONS` wherever a transition needs
 * validating (see `useSimulatedSession`).
 */

import { SessionState } from "@/types/enums";

export interface SessionStateMeta {
  readonly label: string;
  readonly colorVar: string;
}

export const SESSION_STATE_META: Readonly<Record<SessionState, SessionStateMeta>> = {
  [SessionState.IDLE]: { label: "Idle", colorVar: "var(--color-state-idle)" },
  [SessionState.INITIALIZING]: { label: "Initializing", colorVar: "var(--color-state-initializing)" },
  [SessionState.WARMING_PROVIDERS]: { label: "Warming Providers", colorVar: "var(--color-state-warming)" },
  [SessionState.READY]: { label: "Ready", colorVar: "var(--color-state-ready)" },
  [SessionState.CALLING]: { label: "Calling", colorVar: "var(--color-state-calling)" },
  [SessionState.LISTENING]: { label: "Listening", colorVar: "var(--color-state-listening)" },
  [SessionState.THINKING]: { label: "Thinking", colorVar: "var(--color-state-thinking)" },
  [SessionState.SPEAKING]: { label: "Speaking", colorVar: "var(--color-state-speaking)" },
  [SessionState.ENDING]: { label: "Ending", colorVar: "var(--color-state-ending)" },
  [SessionState.ERROR]: { label: "Error", colorVar: "var(--color-state-error)" },
};

/**
 * Linear ordering used purely for the visual stepper. This is a
 * display concern (which order to draw left-to-right) — it does
 * not encode legality; `SESSION_STATE_TRANSITIONS` remains the only
 * source of truth for which transitions are valid.
 */
export const SESSION_STATE_STEPPER_ORDER: readonly SessionState[] = [
  SessionState.IDLE,
  SessionState.INITIALIZING,
  SessionState.WARMING_PROVIDERS,
  SessionState.READY,
  SessionState.CALLING,
  SessionState.LISTENING,
  SessionState.THINKING,
  SessionState.SPEAKING,
  SessionState.ENDING,
];
