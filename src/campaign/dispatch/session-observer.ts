/**
 * session-observer.ts
 *
 * Watches campaign calls through the voice agent's EXISTING
 * `onStateChange` hook. Nothing new is emitted by the pipeline; this
 * only reads transitions that already happen.
 *
 * One shared listener, dispatched through a Map — deliberately not one
 * listener per call. The manager keeps listeners in a single Set and
 * fires every one on every transition, so a listener per call would
 * make each transition O(live calls) and would leak for any call whose
 * unsubscribe never ran.
 */

import type { SessionStateTransition } from "../../types/session.types";

export type SessionPhase = "answered" | "ended" | "errored" | "activity";

export interface SessionEvent {
  readonly phase: SessionPhase;
  readonly transition: SessionStateTransition;
}

type Handler = (event: SessionEvent) => void;

interface ManagerLike {
  onStateChange(listener: (sessionId: string, transition: SessionStateTransition) => void): () => void;
}

export class SessionObserver {
  private readonly handlers = new Map<string, Handler>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly manager: ManagerLike) {}

  private ensureSubscribed(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.manager.onStateChange((sessionId, transition) => {
      const handler = this.handlers.get(sessionId);
      if (!handler) return;
      handler({ phase: classify(transition), transition });
    });
  }

  watch(sessionId: string, handler: Handler): () => void {
    this.ensureSubscribed();
    this.handlers.set(sessionId, handler);
    return () => this.handlers.delete(sessionId);
  }

  get watching(): number {
    return this.handlers.size;
  }

  /** Detaches the single underlying listener. Used on shutdown. */
  dispose(): void {
    this.handlers.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

/**
 * Maps a voice-agent SessionState transition onto the campaign's own
 * vocabulary. Read-only: the session state machine is untouched.
 *
 *   CALLING -> LISTENING   the callee actually picked up
 *   * -> IDLE              the call is over
 *   * -> ERROR             the pipeline gave up
 *   anything else          a turn boundary, i.e. the call is alive
 */
export function classify(transition: SessionStateTransition): SessionPhase {
  const to = String(transition.to);
  const from = String(transition.from);
  if (to === "ERROR") return "errored";
  if (to === "IDLE") return "ended";
  if (from === "CALLING" && to === "LISTENING") return "answered";
  return "activity";
}
