/**
 * conversation-pipeline.ts
 *
 * Drives one session's LISTENING -> THINKING -> SPEAKING -> (repeat)
 * cycle against whatever streaming capabilities its resolved
 * provider stack happens to expose:
 *
 *  - STT: if `transcribeStream` exists, runs ONE continuous
 *    streaming transcription for the whole call and derives turn
 *    boundaries from the `AdaptiveTurnDetector`. Otherwise falls
 *    back to acquiring one whole `AudioPayload` at a time and
 *    treating each as a complete turn (the only option a batch
 *    `transcribe()` call allows).
 *
 *  - LLM: if `generateCompletionStream` exists, sentence-chunks the
 *    incoming token deltas and starts TTS on each sentence as soon
 *    as it's complete — real overlap between "the model is still
 *    thinking" and "the assistant has already started speaking".
 *    Otherwise waits for the full `generateCompletion` result before
 *    speaking at all.
 *
 *  - TTS: if `synthesizeStream` exists, plays audio chunks as they
 *    arrive. Otherwise synthesizes the whole utterance at once and
 *    simulates its playback duration so barge-in cancellation still
 *    behaves correctly even without a live audio transport.
 *
 * Barge-in ("the AI is speaking and the user starts talking") is
 * handled the same way regardless of which capabilities are
 * present: `BargeInController.triggerBargeIn()` aborts whatever is
 * currently in flight and the pipeline immediately falls back to
 * LISTENING.
 */

import { SessionState } from "../../types/enums";
import type { SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ConversationTurn } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { LanguageModelProvider } from "../../interfaces/providers/language-model-provider.interface";
import type { SpeechToTextProvider } from "../../interfaces/providers/speech-to-text-provider.interface";
import type { TextToSpeechProvider, SynthesisTaskRequest } from "../../interfaces/providers/text-to-speech-provider.interface";
import type { TelephonyProvider } from "../../interfaces/providers/telephony-provider.interface";

import type { SessionRecord } from "./session-record";
import { detectLanguage, type LanguageDetectionResult } from "./language-detector";
import { languageHintFor } from "./system-prompt";
import { SentenceChunker } from "./sentence-chunker";
import { combineSignals, abortableSleep } from "./abort-utils";
import { estimateAudioSeconds, withByteCounter } from "./audio-utils";
import { estimateLlmCost, estimateSttCost, estimateTtsCost, estimateTokenCount } from "./cost-estimator";
import { withGracefulRetry, RecoverableTurnError, toSessionErrorInfo } from "./error-recovery";

export interface ResolvedProviderStack {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LanguageModelProvider;
  readonly tts: TextToSpeechProvider;
}

/**
 * The slice of the VoiceSessionManager the pipeline needs in order
 * to move a session between states without duplicating the
 * transition-validation logic that already lives on the manager.
 */
export interface PipelineHost {
  transition(record: SessionRecord, to: SessionState, reason?: string): void;
  markError(record: SessionRecord, sourceCategory: string, error: unknown): void;
}

interface AcquiredTurn {
  readonly text: string;
  readonly sttMs: number;
  readonly sttCostUsd: number;
}

interface ThinkingAndSpeakingResult {
  readonly assistantText: string;
  readonly llmMs: number;
  readonly llmCostUsd: number;
  readonly ttsMs: number;
  readonly ttsCostUsd: number;
}

export class ConversationPipeline {
  private readonly usesStreamingStt: boolean;
  private sinceLastTurnBytes = 0;
  private sinceLastTurnEncoding: AudioPayload["encoding"] | undefined;
  private sinceLastTurnSampleRateHz: number | undefined;
  private batchAudioIterator: AsyncIterator<AudioPayload> | undefined;

  constructor(
    private readonly record: SessionRecord,
    private readonly providers: ResolvedProviderStack,
    private readonly host: PipelineHost,
  ) {
    this.usesStreamingStt = typeof providers.stt.transcribeStream === "function";
  }

  /** Runs until the session's loop-abort signal fires or a fatal error occurs. */
  async run(): Promise<void> {
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal) return;

    if (this.usesStreamingStt) {
      this.startContinuousStt(loopSignal);
    }

    if (!loopSignal.aborted) {
      try {
        const detected = detectLanguage("", this.record.memory.currentLanguage);
        const greeting = await this.runThinkingAndSpeaking("", detected, loopSignal);
        if (greeting.assistantText.length > 0) {
          this.record.memory.recordAssistantTurn(greeting.assistantText);
          this.record.bargeIn.reset();
        }
      } catch (error) {
        if (!(error instanceof RecoverableTurnError)) {
          this.host.markError(this.record, "PIPELINE", error);
          return;
        }
      }
    }

    while (!loopSignal.aborted) {
      try {
        if (this.record.state !== SessionState.LISTENING) {
          this.host.transition(this.record, SessionState.LISTENING, "awaiting user speech");
        }

        const turn = await this.acquireNextUserTurn(loopSignal);
        if (!turn || loopSignal.aborted) break;

        const detected = detectLanguage(turn.text, this.record.memory.currentLanguage);
        this.record.memory.recordUserTurn(turn.text, detected.language);

        const turnStartedAt = Date.now();
        const result = await this.runThinkingAndSpeaking(turn.text, detected, loopSignal);
        this.record.memory.recordAssistantTurn(result.assistantText);
        this.record.bargeIn.reset();

        this.record.metrics.recordTurn({
          turnIndex: this.record.turnIndex++,
          sttMs: turn.sttMs,
          llmMs: result.llmMs,
          ttsMs: result.ttsMs,
          totalMs: turn.sttMs + (Date.now() - turnStartedAt),
          sttCostUsd: turn.sttCostUsd,
          llmCostUsd: result.llmCostUsd,
          ttsCostUsd: result.ttsCostUsd,
        });
      } catch (error) {
        if (error instanceof RecoverableTurnError) {
          // The current turn is lost, but the session stays alive —
          // this is exactly the "never crash the entire session"
          // requirement for transient provider failures.
          continue;
        }
        this.host.markError(this.record, "PIPELINE", error);
        return;
      }
    }
  }

  /** Externally-triggered barge-in (e.g. from a future real-time transport, or a test harness). */
  triggerExternalBargeIn(): void {
    this.record.bargeIn.triggerBargeIn();
    if (this.record.state === SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.LISTENING, "external barge-in signal");
    }
  }

  // ---------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------

  private inboundAudioSource(): AsyncIterable<AudioPayload> {
    return this.record.mediaStream?.inbound ?? this.record.inboundAudioFallback;
  }

  private startContinuousStt(loopSignal: AbortSignal): void {
    const wrapped = withByteCounter(this.inboundAudioSource(), (chunk) => {
      this.sinceLastTurnBytes += chunk.data.byteLength;
      this.sinceLastTurnEncoding ??= chunk.encoding;
      this.sinceLastTurnSampleRateHz ??= chunk.sampleRateHz;
    });

    void (async () => {
      try {
        const stream = this.providers.stt.transcribeStream?.({
          sessionId: this.record.id,
          audio: wrapped,
          language: this.record.memory.currentLanguage,
          signal: loopSignal,
        });
        if (!stream) return;

        for await (const segment of stream) {
          if (loopSignal.aborted) break;

          // The user has started talking while the assistant was
          // speaking — cut TTS immediately and resume listening,
          // then keep feeding this segment into the turn detector so
          // nothing the user said is lost.
          if (this.record.state === SessionState.SPEAKING) {
            this.triggerExternalBargeIn();
          }

          this.record.turnDetector.feed(segment);
        }
      } catch {
        // A broken streaming STT connection here degrades to
        // "no more live transcription" rather than crashing the
        // session; `acquireNextUserTurn` will simply stop resolving
        // new turns, and `end()` still works normally.
      }
    })();
  }

  private async acquireNextUserTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    if (this.usesStreamingStt) {
      return this.waitForTurnDetectorEnd(loopSignal);
    }
    return this.acquireBatchTurn(loopSignal);
  }

  private waitForTurnDetectorEnd(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (result: AcquiredTurn | null): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        loopSignal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const unsubscribe = this.record.turnDetector.onTurnEnd((event) => {
        const audioSeconds = this.consumeSinceLastTurnAudioSeconds();
        const providerId = this.providers.stt.descriptor.id;
        finish({
          text: event.text,
          sttMs: event.turnDurationMs,
          sttCostUsd: estimateSttCost(providerId, audioSeconds),
        });
      });

      const onAbort = (): void => finish(null);
      loopSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private consumeSinceLastTurnAudioSeconds(): number {
    if (this.sinceLastTurnBytes === 0 || !this.sinceLastTurnSampleRateHz) return 0;
    const seconds = estimateAudioSeconds({
      data: new Uint8Array(this.sinceLastTurnBytes),
      encoding: this.sinceLastTurnEncoding ?? "PCM_16",
      sampleRateHz: this.sinceLastTurnSampleRateHz,
    });
    this.sinceLastTurnBytes = 0;
    return seconds;
  }

  private async acquireBatchTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    this.batchAudioIterator ??= this.inboundAudioSource()[Symbol.asyncIterator]();

    while (!loopSignal.aborted) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<IteratorResult<AudioPayload>>((resolve) => {
        onAbort = () => resolve({ value: undefined as unknown as AudioPayload, done: true });
        loopSignal.addEventListener("abort", onAbort, { once: true });
      });

      const next = await Promise.race([this.batchAudioIterator.next(), abortPromise]);
      if (onAbort) loopSignal.removeEventListener("abort", onAbort);

      if (next.done || loopSignal.aborted) return null;

      const providerId = this.providers.stt.descriptor.id;
      const segments = await withGracefulRetry("SPEECH_TO_TEXT", () =>
        this.providers.stt.transcribe({
          sessionId: this.record.id,
          audio: next.value,
          language: this.record.memory.currentLanguage,
        }),
      );

      const text = segments
        .filter((segment) => segment.isFinal)
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (text.length === 0) continue; // silence/noise chunk — keep listening

      return {
        text,
        sttMs: 0,
        sttCostUsd: estimateSttCost(providerId, estimateAudioSeconds(next.value)),
      };
    }

    return null;
  }

  // ---------------------------------------------------------------
  // LLM + TTS
  // ---------------------------------------------------------------

  private buildRequestHistory(detectedLanguage: SupportedLanguage): readonly ConversationTurn[] {
    return [
      ...this.record.memory.history(),
      { role: "system", content: languageHintFor(detectedLanguage), timestamp: new Date() },
    ];
  }

  private async runThinkingAndSpeaking(
    userText: string,
    detected: LanguageDetectionResult,
    loopSignal: AbortSignal,
  ): Promise<ThinkingAndSpeakingResult> {
    this.host.transition(this.record, SessionState.THINKING, "generating a reply");
    const thinkingSignal = combineSignals([this.record.bargeIn.beginThinking(), loopSignal]);
    const request: CompletionRequest = { sessionId: this.record.id, history: this.buildRequestHistory(detected.language) };
    const llmProviderId = this.providers.llm.descriptor.id;

    if (this.providers.llm.generateCompletionStream) {
      return this.runStreamingCompletion(request, thinkingSignal, loopSignal, userText, llmProviderId);
    }

    return withGracefulRetry("LANGUAGE_MODEL", async () => {
      const startedAt = Date.now();
      const completion = await this.providers.llm.generateCompletion(request);
      const llmMs = Date.now() - startedAt;

      if (this.record.state !== SessionState.SPEAKING) {
        this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
      }
      const speakingSignal = combineSignals([this.record.bargeIn.beginSpeaking(), loopSignal]);

      const { ttsMs, ttsCostUsd } = await this.synthesizeAndPlay(completion.turn.content, speakingSignal);

      return {
        assistantText: completion.turn.content,
        llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(completion.turn.content)),
        ttsMs,
        ttsCostUsd,
      };
    });
  }

  private async runStreamingCompletion(
    request: CompletionRequest,
    thinkingSignal: AbortSignal,
    loopSignal: AbortSignal,
    userText: string,
    llmProviderId: string,
  ): Promise<ThinkingAndSpeakingResult> {
    const chunker = new SentenceChunker();
    let fullText = "";
    let finalText: string | undefined;
    let llmMs = 0;
    let ttsMs = 0;
    let ttsCostUsd = 0;
    let speakingSignal: AbortSignal | undefined;
    const startedAt = Date.now();

    try {
      const stream = this.providers.llm.generateCompletionStream?.(request, thinkingSignal);
      if (!stream) throw new Error("generateCompletionStream unexpectedly unavailable");

      for await (const event of stream) {
        if (thinkingSignal.aborted) break;

        if (event.type === "token") {
          fullText += event.delta;
          const readySentences = chunker.push(event.delta);
          for (const sentence of readySentences) {
            speakingSignal ??= this.enterSpeaking();
            if (speakingSignal.aborted) break;
            const spoken = await this.synthesizeAndPlay(sentence, speakingSignal);
            ttsMs += spoken.ttsMs;
            ttsCostUsd += spoken.ttsCostUsd;
          }
        } else {
          finalText = event.turn.content;
          llmMs = event.latencyMs;
        }

        if (speakingSignal?.aborted) break;
      }
    } catch {
      // Streaming LLM connection dropped mid-reply — speak whatever
      // was generated so far rather than losing the turn entirely.
    }

    if (llmMs === 0) llmMs = Date.now() - startedAt;

    const remainder = chunker.flush();
    if (remainder && !(speakingSignal?.aborted ?? false)) {
      speakingSignal ??= this.enterSpeaking();
      if (!speakingSignal.aborted) {
        const spoken = await this.synthesizeAndPlay(remainder, speakingSignal);
        ttsMs += spoken.ttsMs;
        ttsCostUsd += spoken.ttsCostUsd;
      }
    }

    const assistantText = (finalText ?? fullText).trim();

    // If nothing was ever spoken (e.g. immediate barge-in), still
    // make sure we transitioned through SPEAKING at least nominally
    // isn't required — LISTENING is re-entered naturally by the
    // caller's next loop iteration either way.
    void loopSignal;

    return {
      assistantText,
      llmMs,
      llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(assistantText)),
      ttsMs,
      ttsCostUsd,
    };
  }

  private enterSpeaking(): AbortSignal {
    if (this.record.state !== SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
    }
    return combineSignals([this.record.bargeIn.beginSpeaking(), this.record.loopAbortController!.signal]);
  }

  private async synthesizeAndPlay(text: string, speakingSignal: AbortSignal): Promise<{ ttsMs: number; ttsCostUsd: number }> {
    if (speakingSignal.aborted || text.trim().length === 0) {
      return { ttsMs: 0, ttsCostUsd: 0 };
    }

    const ttsProviderId = this.providers.tts.descriptor.id;
    const task: SynthesisTaskRequest = {
      sessionId: this.record.id,
      request: { text, language: this.record.memory.currentLanguage },
    };
    const startedAt = Date.now();

    if (this.providers.tts.synthesizeStream) {
      try {
        for await (const chunk of this.providers.tts.synthesizeStream(task, speakingSignal)) {
          if (speakingSignal.aborted) break;
          await this.playAudioChunk(chunk.audio);
        }
      } catch {
        if (!speakingSignal.aborted) {
          // Fall through — a streaming synthesis failure still
          // yields whatever latency/cost bookkeeping makes sense
          // for the attempt rather than throwing away the turn.
        }
      }
      return { ttsMs: Date.now() - startedAt, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    }

    return withGracefulRetry("TEXT_TO_SPEECH", async () => {
      const audio = await this.providers.tts.synthesize(task);
      const ttsCallMs = Date.now() - startedAt;
      await this.playAudioChunk(audio);

      const playbackMs = estimateAudioSeconds(audio) * 1000;
      await abortableSleep(playbackMs, speakingSignal);
      if (speakingSignal.aborted) {
        await this.record.mediaStream?.interruptPlayback();
      }

      return { ttsMs: ttsCallMs, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    });
  }

  private async playAudioChunk(audio: AudioPayload): Promise<void> {
    if (this.record.mediaStream) {
      await this.record.mediaStream.sendAudio(audio);
    }
    for (const listener of this.record.outboundAudioListeners) listener(audio);
  }
}

export { toSessionErrorInfo };