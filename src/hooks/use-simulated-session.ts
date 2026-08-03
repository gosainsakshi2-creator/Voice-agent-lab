"use client";

/**
 * use-simulated-session.ts
 *
 * Drives the Dashboard's SessionState purely for demonstration —
 * there is no VoiceSessionManager implementation here, no provider
 * calls, no streaming. Every transition this hook makes is checked
 * against the real `SESSION_STATE_TRANSITIONS` graph before being
 * applied, so the simulated flow can never diverge from the
 * architecture's declared state machine.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { SESSION_STATE_TRANSITIONS } from "@/constants/session-states.constants";
import { SessionState } from "@/types/enums";
import type { ConversationTurn } from "@/types/provider.types";
import { MOCK_TRANSCRIPT } from "@/lib/mock/mock-transcript";

function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_STATE_TRANSITIONS[from].includes(to);
}

const CONVERSATION_CYCLE: readonly SessionState[] = [
  SessionState.LISTENING,
  SessionState.THINKING,
  SessionState.SPEAKING,
];

export interface SimulatedSession {
  readonly sessionState: SessionState;
  readonly transcript: readonly ConversationTurn[];
  readonly callDurationSeconds: number;
  readonly isCallActive: boolean;
  readonly startCall: () => void;
  readonly endCall: () => void;
}

export function useSimulatedSession(): SimulatedSession {
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.IDLE);
  const [transcript, setTranscript] = useState<readonly ConversationTurn[]>([]);
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const cycleIndex = useRef(0);
  const transcriptIndex = useRef(0);

  const clearAllTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (interval.current) {
      clearInterval(interval.current);
      interval.current = null;
    }
  }, []);

  const safeTransition = useCallback((to: SessionState) => {
    setSessionState((from) => (canTransition(from, to) ? to : from));
  }, []);

  const schedule = useCallback((fn: () => void, delayMs: number) => {
    const id = setTimeout(fn, delayMs);
    timers.current.push(id);
    return id;
  }, []);

  const appendNextTranscriptLine = useCallback(() => {
    const next = MOCK_TRANSCRIPT[transcriptIndex.current];
    if (!next) return;
    setTranscript((prev) => [...prev, next]);
    transcriptIndex.current += 1;
  }, []);

  const startCall = useCallback(() => {
    clearAllTimers();
    setTranscript([]);
    transcriptIndex.current = 0;
    cycleIndex.current = 0;
    setCallDurationSeconds(0);

    setSessionState(SessionState.INITIALIZING);
    schedule(() => appendNextTranscriptLine(), 400); // "session warmed up" log line first, see below

    schedule(() => safeTransition(SessionState.WARMING_PROVIDERS), 500);
    schedule(() => {
      appendNextTranscriptLine(); // "call connected" log line
    }, 900);
    schedule(() => safeTransition(SessionState.READY), 1100);
    schedule(() => safeTransition(SessionState.CALLING), 1500);
    schedule(() => {
      safeTransition(SessionState.LISTENING);
      interval.current = setInterval(() => {
        setCallDurationSeconds((s) => s + 1);
      }, 1000);
    }, 2000);

    // Advance through LISTENING -> THINKING -> SPEAKING, revealing one
    // transcript line roughly every cycle, looping until the mock
    // transcript is exhausted.
    const runCycle = () => {
      cycleIndex.current += 1;
      const next = CONVERSATION_CYCLE[cycleIndex.current % CONVERSATION_CYCLE.length]!;
      safeTransition(next);
      if (next === SessionState.SPEAKING || next === SessionState.THINKING) {
        appendNextTranscriptLine();
      }
      if (transcriptIndex.current < MOCK_TRANSCRIPT.length) {
        schedule(runCycle, 2200);
      }
    };
    schedule(runCycle, 4200);
  }, [appendNextTranscriptLine, clearAllTimers, safeTransition, schedule]);

  const endCall = useCallback(() => {
    clearAllTimers();
    setSessionState((from) => {
      if (from === SessionState.IDLE) return from;
      return canTransition(from, SessionState.ENDING) ? SessionState.ENDING : from;
    });
    schedule(() => safeTransition(SessionState.IDLE), 500);
  }, [clearAllTimers, safeTransition, schedule]);

  useEffect(() => clearAllTimers, [clearAllTimers]);

  const isCallActive =
    sessionState !== SessionState.IDLE &&
    sessionState !== SessionState.ERROR &&
    sessionState !== SessionState.ENDING;

  return { sessionState, transcript, callDurationSeconds, isCallActive, startCall, endCall };
}
