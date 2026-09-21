/**
 * barge-in-controller.ts
 *
 * Owns cancellation for a single session's current TTS playback and
 * (optionally) an in-flight LLM completion, so "the AI is speaking
 * and the user starts talking" can be handled as: stop TTS output
 * immediately, cancel remaining audio, and let STT keep listening
 * without missing anything.
 *
 * The controller itself does not decide WHEN a barge-in has
 * happened (that judgment call belongs to the pipeline, which is
 * watching inbound audio/STT activity during SPEAKING) — it only
 * gives the pipeline one place to say "cancel now" and one place
 * for every in-flight operation to check "was I cancelled".
 */

/**
 * TELEMETRY ONLY — which phase was live when a barge-in cancelled it.
 *
 * `TurnOutcome` already separates the THINKING-side supersession
 * (`superseded_buffered` / `superseded_pending`) from everything else,
 * but it CANNOT identify a SPEAKING-side barge-in: a reply that was
 * interrupted after its first audio chunk resolves to `"spoken"`,
 * exactly like a reply that finished undisturbed. A 2026-09-21 audit
 * needed to tell those two apart — "the caller was talked over" versus
 * "the caller was answered" — and no stored field could.
 *
 * `"idle"` means `triggerBargeIn` fired with no phase active, which is
 * the documented idempotent no-op.
 */
export type BargeInPhase = "thinking" | "speaking" | "idle";

export class BargeInController {
  private speakingAbort: AbortController | null = null;
  private thinkingAbort: AbortController | null = null;
  /**
   * TELEMETRY ONLY — see `BargeInPhase`. Written by `triggerBargeIn`,
   * read and cleared by `consumeBargeInPhase`, and consulted by no
   * decision here or in the pipeline. Deliberately NOT cleared by
   * `reset()`: the pipeline calls `reset()` before it records the turn,
   * so clearing there would wipe the label of the turn it describes.
   */
  private lastBargeInPhase: BargeInPhase | undefined;
  private readonly listeners = new Set<() => void>();

  /** Call when entering THINKING; returns the signal in-flight LLM work should honor. */
  beginThinking(): AbortSignal {
    // TELEMETRY ONLY. Cleared where a new reply cycle BEGINS, which is
    // the same boundary the turn detector clears its marker label at
    // and for the same reason: `reset()` runs before the pipeline
    // records the turn, so it cannot be the clearing point, and a
    // barge-in that cancelled something OUTSIDE a turn — the greeting,
    // an identity-gate line — would otherwise be consumed by the next
    // turn and mislabel it. No decision reads this.
    this.lastBargeInPhase = undefined;
    this.thinkingAbort = new AbortController();
    return this.thinkingAbort.signal;
  }

  /** Call when entering SPEAKING; returns the signal in-flight TTS/playback work should honor. */
  beginSpeaking(): AbortSignal {
    this.speakingAbort = new AbortController();
    return this.speakingAbort.signal;
  }

  /**
   * Immediately cancel whatever is currently speaking (and, if still
   * in flight, thinking) and notify subscribers. Idempotent — a
   * second call while nothing is active is a harmless no-op.
   */
  triggerBargeIn(): void {
    // TELEMETRY ONLY, and recorded BEFORE the aborts so it describes
    // the phase that was live when this fired. SPEAKING is tested
    // first because `beginSpeaking` follows `beginThinking` within one
    // reply, so both handles are set while audio is playing and the
    // later phase is the one being interrupted. The FIRST trigger of a
    // reply wins: `triggerBargeIn` is idempotent and may be called
    // again during the unwind, by which point the phase has moved on.
    this.lastBargeInPhase ??=
      this.speakingAbort !== null ? "speaking" : this.thinkingAbort !== null ? "thinking" : "idle";
    this.speakingAbort?.abort();
    this.thinkingAbort?.abort();
    for (const listener of this.listeners) listener();
  }

  /**
   * TELEMETRY ONLY — the phase the most recent barge-in interrupted,
   * cleared on read so a turn with no barge-in reports absence rather
   * than inheriting the previous turn's. Same snapshot-then-clear
   * contract the turn detector uses for its own labels.
   */
  consumeBargeInPhase(): BargeInPhase | undefined {
    const phase = this.lastBargeInPhase;
    this.lastBargeInPhase = undefined;
    return phase;
  }

  onBargeIn(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clears abort handles once a phase has ended cleanly (not via barge-in). */
  reset(): void {
    this.speakingAbort = null;
    this.thinkingAbort = null;
  }
}
