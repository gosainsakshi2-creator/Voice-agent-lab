/**
 * turn-detection.ts
 *
 * Adaptive end-of-turn ("endpointing") detection for the streaming
 * pipeline. The platform's `TranscriptSegment` shape only exposes
 * per-segment timing (`startedAtMs`/`endedAtMs`) and an `isFinal`
 * flag — there is no raw audio-energy/VAD signal in this
 * architecture (see `AudioPayload`, which is deliberately opaque
 * bytes). This detector works with the signal that IS available:
 * the gap between successive transcript segments.
 *
 * A fixed silence timeout either cuts off slow, thoughtful speakers
 * or feels sluggish for fast, clipped speakers. This detector starts
 * at a sensible default and nudges its threshold toward the user's
 * own observed inter-utterance pause length as the call progresses,
 * within safe bounds — the "adaptive turn detection" requirement.
 */

import type { TranscriptSegment } from "../../types/provider.types";

const DEFAULT_SILENCE_TIMEOUT_MS = 700;
const MIN_SILENCE_TIMEOUT_MS = 300;
const MAX_SILENCE_TIMEOUT_MS = 1400;
/** How strongly a single observed gap nudges the running estimate (0..1). */
const ADAPTATION_RATE = 0.25;

export interface TurnDetectionEvent {
  /** The accumulated final transcript text for the completed turn. */
  readonly text: string;
  /** Wall-clock ms from the first segment of this turn to endpointing. */
  readonly turnDurationMs: number;
}

/**
 * Feed transcript segments in as they arrive (partial or final);
 * receive an `onTurnEnd` callback exactly once per detected user
 * turn. Callers own the timer clock via `now()` injection so this
 * class is trivially testable without real wall-clock delays.
 */
export class AdaptiveTurnDetector {
  private silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS;
  private pendingFinalText = "";
  private turnStartedAtMs: number | null = null;
  private lastSegmentAtMs: number | null = null;
  private lastFinalEndedAtMs: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: TurnDetectionEvent) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onTurnEnd(listener: (event: TurnDetectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feed a new transcript segment (partial or final) into the detector. */
  feed(segment: TranscriptSegment): void {
    const nowMs = this.now();

    if (this.turnStartedAtMs === null) {
      this.turnStartedAtMs = nowMs;
    }
    this.lastSegmentAtMs = nowMs;

    if (segment.isFinal) {
      this.pendingFinalText = this.pendingFinalText.length > 0
        ? `${this.pendingFinalText} ${segment.text}`.trim()
        : segment.text;

      if (this.lastFinalEndedAtMs !== null) {
        const observedGapMs = segment.startedAtMs - this.lastFinalEndedAtMs;
        if (observedGapMs > 0) {
          this.adaptTimeout(observedGapMs);
        }
      }
      this.lastFinalEndedAtMs = segment.endedAtMs;
    }

    this.rearmTimer();
  }

  /** Force an immediate end-of-turn (e.g. the caller detected hard silence via another signal). */
  forceEndTurn(): void {
    this.clearTimer();
    this.emitTurnEnd();
  }

  /** Discards any in-progress turn without emitting — used when a session ends mid-utterance. */
  reset(): void {
    this.clearTimer();
    this.pendingFinalText = "";
    this.turnStartedAtMs = null;
    this.lastSegmentAtMs = null;
  }

  getCurrentSilenceTimeoutMs(): number {
    return this.silenceTimeoutMs;
  }

  private rearmTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.emitTurnEnd(), this.silenceTimeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emitTurnEnd(): void {
    if (this.pendingFinalText.trim().length === 0) {
      this.reset();
      return;
    }

    const turnDurationMs =
      this.turnStartedAtMs !== null && this.lastSegmentAtMs !== null
        ? this.lastSegmentAtMs - this.turnStartedAtMs
        : 0;

    const event: TurnDetectionEvent = { text: this.pendingFinalText.trim(), turnDurationMs };
    this.reset();
    for (const listener of this.listeners) listener(event);
  }

  private adaptTimeout(observedGapMs: number): void {
    const clampedObservation = Math.min(Math.max(observedGapMs, MIN_SILENCE_TIMEOUT_MS), MAX_SILENCE_TIMEOUT_MS);
    const next = this.silenceTimeoutMs + (clampedObservation - this.silenceTimeoutMs) * ADAPTATION_RATE;
    this.silenceTimeoutMs = Math.min(Math.max(next, MIN_SILENCE_TIMEOUT_MS), MAX_SILENCE_TIMEOUT_MS);
  }
}
