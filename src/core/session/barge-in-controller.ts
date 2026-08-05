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

export class BargeInController {
  private speakingAbort: AbortController | null = null;
  private thinkingAbort: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  /** Call when entering THINKING; returns the signal in-flight LLM work should honor. */
  beginThinking(): AbortSignal {
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
     console.log("🔥 BARGE-IN TRIGGERED");
    this.speakingAbort?.abort();
    this.thinkingAbort?.abort();
    for (const listener of this.listeners) listener();
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
