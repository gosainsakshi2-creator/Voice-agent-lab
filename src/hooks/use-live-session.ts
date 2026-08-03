"use client";

/**
 * use-live-session.ts
 *
 * Replaces `useSimulatedSession` with a real implementation backed
 * by the new integration-layer API routes
 * (`/api/sessions`, `/api/sessions/[id]/{warmup,start,events}`,
 * `/api/providers`) — which themselves do nothing but call the
 * existing, unmodified `VoiceSessionManager` / `ProviderRegistry`.
 * No orchestration, state-machine, or provider logic lives in this
 * hook; it only turns HTTP/SSE traffic into React state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { SessionState, CallDirection, ProviderCategory } from "@/types/enums";
import type { SupportedLanguage } from "@/types/enums";
import type { ConversationTurn, ProviderDescriptor, ProviderHealthStatus } from "@/types/provider.types";
import type { BenchmarkMetrics } from "@/types/benchmark.types";
import type { SessionId, SessionSnapshot } from "@/types/session.types";
import type { ProviderStackFormValue } from "@/components/dashboard/config-panel";

const EMPTY_METRICS_FOR = (sessionId: string): BenchmarkMetrics => ({
  sessionId: sessionId as SessionId,
  providerStack: {
    telephony: { category: ProviderCategory.TELEPHONY, id: "" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "" },
  },
  timestamp: new Date(),
  callDuration: { seconds: 0, startedAt: new Date() },
  estimatedCost: { amount: 0, currency: "USD" },
  turnLatencies: [],
});

export interface ProviderCatalog {
  readonly telephony: readonly ProviderDescriptor[];
  readonly speechToText: readonly ProviderDescriptor[];
  readonly languageModel: readonly ProviderDescriptor[];
  readonly textToSpeech: readonly ProviderDescriptor[];
}

export interface LiveSession {
  readonly sessionState: SessionState;
  readonly transcript: readonly ConversationTurn[];
  readonly callDurationSeconds: number;
  readonly isCallActive: boolean;
  readonly startCall: () => void;
  readonly endCall: () => void;
  readonly metrics: BenchmarkMetrics;
  readonly health: readonly ProviderHealthStatus[];
  readonly providers: ProviderCatalog | undefined;
  readonly errorMessage: string | undefined;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Request to ${url} failed`);
  return json as T;
}

export function useLiveSession(
  stack: ProviderStackFormValue,
  language: SupportedLanguage,
  destinationNumber: string,
): LiveSession {
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.IDLE);
  const [transcript, setTranscript] = useState<readonly ConversationTurn[]>([]);
  const [metrics, setMetrics] = useState<BenchmarkMetrics>(EMPTY_METRICS_FOR(""));
  const [health, setHealth] = useState<readonly ProviderHealthStatus[]>([]);
  const [providers, setProviders] = useState<ProviderCatalog | undefined>(undefined);
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const sessionIdRef = useRef<SessionId | undefined>(undefined);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const durationInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the provider catalog + baseline health once on mount so the
  // ConfigPanel can offer real registered providers instead of mocks.
  useEffect(() => {
    let cancelled = false;
   
  fetch("/api/providers")
  .then((r) => r.json())
  .then((json) => {
    
    if (cancelled) return;
 
    
    
    setProviders(json.providers);
    
    setHealth(json.health ?? []);
  })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = undefined;
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (durationInterval.current) {
      clearInterval(durationInterval.current);
      durationInterval.current = null;
    }
  }, []);

  useEffect(() => () => {
    closeStream();
    stopDurationTimer();
  }, [closeStream, stopDurationTimer]);

  const subscribeToEvents = useCallback((sessionId: SessionId) => {
    closeStream();
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    eventSourceRef.current = source;

    source.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as {
          session: SessionSnapshot;
          transcript: ConversationTurn[];
          metrics: BenchmarkMetrics;
        };
        setSessionState(data.session.state);
        setTranscript(data.transcript);
        setMetrics(data.metrics);
        if (data.session.lastError) setErrorMessage(data.session.lastError.message);
      } catch {
        // malformed/heartbeat frame — ignore
      }
    };
  }, [closeStream]);

  const startCall = useCallback(() => {
    setErrorMessage(undefined);
    setTranscript([]);
    setCallDurationSeconds(0);

    void (async () => {
      try {
        const { session } = await postJson<{ session: SessionSnapshot }>("/api/sessions", {
          language,
          direction: CallDirection.OUTBOUND,
          providerStack: {
            telephony: { category: "TELEPHONY", id: stack.telephonyId },
            speechToText: { category: "SPEECH_TO_TEXT", id: stack.speechToTextId },
            languageModel: { category: "LANGUAGE_MODEL", id: stack.languageModelId },
            textToSpeech: { category: "TEXT_TO_SPEECH", id: stack.textToSpeechId },
          },
          destinationNumber,
        });

        sessionIdRef.current = session.id;
        setSessionState(session.state);
        subscribeToEvents(session.id);

        durationInterval.current = setInterval(() => {
          setCallDurationSeconds((s) => s + 1);
        }, 1000);

        await postJson(`/api/sessions/${session.id}/warmup`);
        await postJson(`/api/sessions/${session.id}/start`);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        stopDurationTimer();
      }
    })();
  }, [destinationNumber, language, stack, subscribeToEvents, stopDurationTimer]);

  const endCall = useCallback(() => {
    const sessionId = sessionIdRef.current;
    stopDurationTimer();
    if (!sessionId) {
      setSessionState(SessionState.IDLE);
      return;
    }
    void fetch(`/api/sessions/${sessionId}`, { method: "DELETE" })
      .catch(() => undefined)
      .finally(() => {
        closeStream();
        sessionIdRef.current = undefined;
      });
  }, [closeStream, stopDurationTimer]);

  const isCallActive =
    sessionState !== SessionState.IDLE &&
    sessionState !== SessionState.ERROR &&
    sessionState !== SessionState.ENDING;

  return {
    sessionState,
    transcript,
    callDurationSeconds,
    isCallActive,
    startCall,
    endCall,
    metrics,
    health,
    providers,
    errorMessage,
  };
}
