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

// ------------------------------------------------------------------
// Voice-safe output validation
// ------------------------------------------------------------------

/**
 * Strips markdown formatting that would sound wrong when read aloud
 * by TTS. Only removes formatting — NOT content. Prompt-echo
 * contamination is handled by `isContaminatedOutput` + retry, not
 * by regex stripping.
 */
function stripMarkdown(raw: string): string {
  let text = raw;

  // Remove markdown bullet points and numbered lists (e.g. "- ", "* ", "1. ")
  text = text.replace(/^[\t ]*[-*•]\s+/gm, "");
  text = text.replace(/^[\t ]*\d+\.\s+/gm, "");

  // Remove markdown headers ("# ", "## ", etc.)
  text = text.replace(/^[\t ]*#{1,6}\s+/gm, "");

  // Remove bold / italic markers (* ** _ __ ` ``)
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  text = text.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");

  // Collapse multiple newlines into a single space (voice is continuous)
  text = text.replace(/\n{2,}/g, " ");
  text = text.replace(/\n/g, " ");

  // Collapse multiple spaces
  text = text.replace(/ {2,}/g, " ");

  return text.trim();
}

/**
 * Detects prompt-contaminated output — the model has echoed system
 * instructions instead of producing a natural reply. Any output
 * matching this check is NEVER spoken. The pipeline retries with
 * a simplified prompt instead.
 */
const CONTAMINATION_MARKERS = [
  "role:",
  "persona:",
  "constraint:",
  "language:",
  "how to talk:",
  "remember:",
  "context:",
  "instructions:",
  "system prompt:",
  "developer notes:",
  "as a voice assistant",
  "i was instructed",
  "my role is",
  "voice assistant on a",
];

function isContaminatedOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTAMINATION_MARKERS.filter((m) => lower.includes(m)).length >= 1;
}

/** Language-appropriate fallback greetings when the LLM fails or produces contaminated output. */
function fallbackGreeting(language: SupportedLanguage): string {
  switch (language) {
    case "hi":
      return "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?";
    case "hi-en":
      return "Hey, namaste! Kaise help kar sakta hoon aapki?";
    default:
      return "Hey! How can I help you today?";
  }
}

/** Maximum characters for a greeting — anything longer is almost certainly a prompt echo. */
const MAX_GREETING_CHARS = 200;

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
    const sid = this.record.id;
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal) {
      // eslint-disable-next-line no-console
      console.error(`[PIPELINE:${sid}] run() aborted — no loopAbortController on session record`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PIPELINE:${sid}] run() started — state=${this.record.state} streamingSTT=${this.usesStreamingStt} llm=${this.providers.llm.descriptor.id} tts=${this.providers.tts.descriptor.id} stt=${this.providers.stt.descriptor.id}`,
    );

    if (this.usesStreamingStt) {
      this.startContinuousStt(loopSignal);
    }

    // --- Greeting phase ---
    if (!loopSignal.aborted) {
      // eslint-disable-next-line no-console
      console.log(`[PIPELINE:${sid}] Conversation started — generating greeting, state=${this.record.state}`);
      try {
        // Inject a synthetic user turn so the LLM sees an explicit
        // instruction to greet the caller. Phrased as natural speech
        // (not a bracketed meta-instruction) because models like
        // Gemma that fold system prompts into the user turn can
        // misinterpret bracket syntax and echo the prompt back.
        this.record.memory.recordUserTurn(
          "The call has just connected. Greet the caller naturally in one short sentence.",
          this.record.memory.currentLanguage,
        );

        const detected = detectLanguage("", this.record.memory.currentLanguage);
        const greeting = await this.runThinkingAndSpeaking("", detected, loopSignal);
        // eslint-disable-next-line no-console
        console.log(
          `[PIPELINE:${sid}] Greeting succeeded: text="${greeting.assistantText.slice(0, 80)}${greeting.assistantText.length > 80 ? "..." : ""}" llmMs=${greeting.llmMs} ttsMs=${greeting.ttsMs} state=${this.record.state}`,
        );
        if (greeting.assistantText.length > 0) {
          this.record.memory.recordAssistantTurn(greeting.assistantText);
          this.record.bargeIn.reset();
        }
      } catch (error) {
        if (!(error instanceof RecoverableTurnError)) {
          // eslint-disable-next-line no-console
          console.error(
            `[PIPELINE:${sid}] Greeting FATAL error: state=${this.record.state} error=${error instanceof Error ? error.message : String(error)} errorType=${error?.constructor?.name}`,
          );
          this.host.markError(this.record, "PIPELINE", error);
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] Greeting RecoverableTurnError (recovering): state=${this.record.state} error=${error.message} source=${error.sourceCategory} cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        );
        // State may be THINKING or SPEAKING here after the error.
        // Recover to LISTENING so the main loop can proceed. The
        // state machine now allows THINKING → LISTENING for exactly
        // this recovery case.
        if (this.record.state !== SessionState.LISTENING) {
          try {
            this.host.transition(this.record, SessionState.LISTENING, "recovering from greeting error");
          } catch {
            // eslint-disable-next-line no-console
            console.error(`[PIPELINE:${sid}] Could not recover to LISTENING from state=${this.record.state} — ending pipeline`);
            this.host.markError(this.record, "PIPELINE", error);
            return;
          }
        }
      }
    }

    // --- Main loop ---
    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] entering main loop — state=${this.record.state} aborted=${loopSignal.aborted}`);

    while (!loopSignal.aborted) {
      try {
        if (this.record.state !== SessionState.LISTENING) {
          // eslint-disable-next-line no-console
          console.log(
            `[PIPELINE:${sid}] Main loop: state=${this.record.state}, transitioning to LISTENING`,
          );
          this.host.transition(this.record, SessionState.LISTENING, "awaiting user speech");
        }

        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Waiting for user speech...`);
        const turn = await this.acquireNextUserTurn(loopSignal);
        if (!turn || loopSignal.aborted) {
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] acquireNextUserTurn returned null or aborted — exiting loop`);
          break;
        }

        // eslint-disable-next-line no-console
        console.log(`[STT:${sid}] Transcript received: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? "..." : ""}" sttMs=${turn.sttMs}`);

        const detected = detectLanguage(turn.text, this.record.memory.currentLanguage);
        this.record.memory.recordUserTurn(turn.text, detected.language);

        const turnStartedAt = Date.now();
        const result = await this.runThinkingAndSpeaking(turn.text, detected, loopSignal);
        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Turn complete: assistant="${result.assistantText.slice(0, 80)}${result.assistantText.length > 80 ? "..." : ""}" llmMs=${result.llmMs} ttsMs=${result.ttsMs}`);
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
          // eslint-disable-next-line no-console
          console.warn(`[PIPELINE:${sid}] RecoverableTurnError (continuing): ${error.message}`);
          // Recover state to LISTENING so the next iteration can proceed.
          if (this.record.state !== SessionState.LISTENING) {
            try {
              this.host.transition(this.record, SessionState.LISTENING, "recovering from turn error");
            } catch {
              // eslint-disable-next-line no-console
              console.error(`[PIPELINE:${sid}] Cannot recover to LISTENING from state=${this.record.state}`);
            }
          }
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] FATAL error — state=${this.record.state} errorType=${error?.constructor?.name} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.host.markError(this.record, "PIPELINE", error);
        return;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] run() exiting — state=${this.record.state} aborted=${loopSignal.aborted}`);
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

  /**
   * Builds the turn array sent to the LLM.
   *
   * Rules:
   *   1. Exactly ONE system turn — the leading prompt from ConversationMemory.
   *   2. Language hints are folded into the latest user message,
   *      never added as a separate system turn (doing so caused
   *      Gemma's `toGoogleContents` to merge ALL system turns into
   *      the first user message, growing it each turn and triggering
   *      prompt-echo).
   *   3. History order: system → user → assistant → user → assistant …
   */
  private buildRequestHistory(detectedLanguage: SupportedLanguage): readonly ConversationTurn[] {
    const turns = [...this.record.memory.history()];
    const hint = languageHintFor(detectedLanguage);

    // Prepend the language hint to the LAST user turn so the model
    // knows which language to reply in, without polluting the turn
    // structure with extra system messages.
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        turns[i] = { ...turns[i], content: `[${hint}] ${turns[i].content}` };
        break;
      }
    }

    return turns;
  }

  private async runThinkingAndSpeaking(
    userText: string,
    detected: LanguageDetectionResult,
    loopSignal: AbortSignal,
  ): Promise<ThinkingAndSpeakingResult> {
    const sid = this.record.id;
    const isGreeting = userText === "";
    // eslint-disable-next-line no-console
    console.log(
      `[LLM:${sid}] Prompt generated: isGreeting=${isGreeting} language=${detected.language} currentState=${this.record.state} llmProvider=${this.providers.llm.descriptor.id}`,
    );

    this.host.transition(this.record, SessionState.THINKING, "generating a reply");
    const thinkingSignal = combineSignals([this.record.bargeIn.beginThinking(), loopSignal]);
    const request: CompletionRequest = { sessionId: this.record.id, history: this.buildRequestHistory(detected.language) };
    const llmProviderId = this.providers.llm.descriptor.id;

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:${sid}] Sending to ${llmProviderId}: historyLength=${request.history.length} roles=[${request.history.map((t) => t.role).join(",")}] streaming=${typeof this.providers.llm.generateCompletionStream === "function"}`,
    );

    if (this.providers.llm.generateCompletionStream) {
      return this.runStreamingCompletion(request, thinkingSignal, loopSignal, userText, llmProviderId);
    }

    return withGracefulRetry("LANGUAGE_MODEL", async () => {
      // eslint-disable-next-line no-console
      console.log(`[LLM:${sid}] Calling generateCompletion() (batch mode)...`);
      const startedAt = Date.now();
      const completion = await this.providers.llm.generateCompletion(request);
      let llmMs = Date.now() - startedAt;

      let spokenContent = stripMarkdown(completion.turn.content);

      // --- Contamination check: if the output echoes system-prompt
      // markers, retry ONCE with a simplified prompt. Never speak
      // contaminated output. ---
      if (isContaminatedOutput(spokenContent) || (isGreeting && spokenContent.length > MAX_GREETING_CHARS)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LLM:${sid}] Output contaminated or too long (len=${spokenContent.length}), retrying with simplified prompt`,
        );
        const retryHistory: ConversationTurn[] = request.history
          .filter((t) => t.role !== "system")
          .slice(-2); // Last user + possibly last assistant only
        retryHistory.unshift({
          role: "system" as const,
          content: "Reply in one short, natural sentence. Do not describe yourself or your instructions.",
          timestamp: new Date(),
        });
        const retryRequest: CompletionRequest = { sessionId: request.sessionId, history: retryHistory };
        const retryStart = Date.now();
        try {
          const retryCompletion = await this.providers.llm.generateCompletion(retryRequest);
          llmMs += Date.now() - retryStart;
          const retryContent = stripMarkdown(retryCompletion.turn.content);
          if (!isContaminatedOutput(retryContent) && retryContent.length > 0) {
            spokenContent = retryContent;
            // eslint-disable-next-line no-console
            console.log(`[LLM:${sid}] Retry succeeded: "${spokenContent.slice(0, 80)}"`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[LLM:${sid}] Retry also contaminated — using fallback`);
            spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
          }
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`[LLM:${sid}] Retry failed — using fallback`);
          spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[LLM:${sid}] Response generated in ${llmMs}ms: text="${spokenContent.slice(0, 120)}${spokenContent.length > 120 ? "..." : ""}" state=${this.record.state}`,
      );

      if (this.record.state !== SessionState.SPEAKING) {
        this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
      }
      const speakingSignal = combineSignals([this.record.bargeIn.beginSpeaking(), loopSignal]);

      const { ttsMs, ttsCostUsd } = await this.synthesizeAndPlay(spokenContent, speakingSignal);

      return {
        assistantText: spokenContent,
        llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, estimateTokenCount(userText) + estimateTokenCount(spokenContent)),
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
            const cleaned = stripMarkdown(sentence);
            if (cleaned.length === 0) continue;
            speakingSignal ??= this.enterSpeaking();
            if (speakingSignal.aborted) break;
            const spoken = await this.synthesizeAndPlay(cleaned, speakingSignal);
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

    const rawRemainder = chunker.flush();
    const remainder = rawRemainder ? stripMarkdown(rawRemainder) : "";
    if (remainder.length > 0 && !(speakingSignal?.aborted ?? false)) {
      speakingSignal ??= this.enterSpeaking();
      if (!speakingSignal.aborted) {
        const spoken = await this.synthesizeAndPlay(remainder, speakingSignal);
        ttsMs += spoken.ttsMs;
        ttsCostUsd += spoken.ttsCostUsd;
      }
    }

    const assistantText = stripMarkdown((finalText ?? fullText));

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
    const sid = this.record.id;
    if (speakingSignal.aborted || text.trim().length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] synthesizeAndPlay skipped (aborted=${speakingSignal.aborted} emptyText=${text.trim().length === 0})`);
      return { ttsMs: 0, ttsCostUsd: 0 };
    }

    const ttsProviderId = this.providers.tts.descriptor.id;
    // eslint-disable-next-line no-console
    console.log(`[TTS:${sid}] Synthesis started: provider=${ttsProviderId} textLen=${text.length} text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}" streaming=${typeof this.providers.tts.synthesizeStream === "function"}`);
    const task: SynthesisTaskRequest = {
      sessionId: this.record.id,
      request: { text, language: this.record.memory.currentLanguage },
    };
    const startedAt = Date.now();

    if (this.providers.tts.synthesizeStream) {
      let chunkCount = 0;
      try {
        for await (const chunk of this.providers.tts.synthesizeStream(task, speakingSignal)) {
          if (speakingSignal.aborted) break;
          chunkCount += 1;
          await this.playAudioChunk(chunk.audio);
        }
      } catch (err) {
        if (!speakingSignal.aborted) {
          // eslint-disable-next-line no-console
          console.warn(`[TTS:${sid}] streaming TTS error after ${chunkCount} chunks: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const ttsMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] streaming TTS done: ${chunkCount} chunks, ${ttsMs}ms`);
      return { ttsMs, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    }

    return withGracefulRetry("TEXT_TO_SPEECH", async () => {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] Calling synthesize() (batch mode)...`);
      const audio = await this.providers.tts.synthesize(task);
      const ttsCallMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[TTS:${sid}] Audio chunks generated: ${ttsCallMs}ms encoding=${audio.encoding} sampleRate=${audio.sampleRateHz} bytes=${audio.data.byteLength}`,
      );
      await this.playAudioChunk(audio);

      const playbackMs = estimateAudioSeconds(audio) * 1000;
      // eslint-disable-next-line no-console
      console.log(`[PLAYBACK:${sid}] Playback started: estimated ${Math.round(playbackMs)}ms`);
      await abortableSleep(playbackMs, speakingSignal);
      if (speakingSignal.aborted) {
        await this.record.mediaStream?.interruptPlayback();
      }

      return { ttsMs: ttsCallMs, ttsCostUsd: estimateTtsCost(ttsProviderId, text.length) };
    });
  }

  private playAudioChunkCount = 0;
  private outboundReadyResolved = false;

  /**
   * Waits until at least one outbound delivery path (mediaStream or
   * a listener) is available, up to a timeout. Called once before
   * the first audio chunk to handle the edge case where the pipeline
   * starts before the bridge has registered its listener.
   */
  private async waitForOutboundReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.outboundReadyResolved) return;
    const hasPath = () => !!this.record.mediaStream || this.record.outboundAudioListeners.size > 0;
    if (hasPath()) { this.outboundReadyResolved = true; return; }

    // eslint-disable-next-line no-console
    console.warn(
      `[PLAYBACK:${this.record.id}] No outbound delivery path yet — waiting up to ${timeoutMs}ms for bridge to attach`,
    );

    const deadline = Date.now() + timeoutMs;
    while (!hasPath() && Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 50));
    }

    this.outboundReadyResolved = true;
    if (!hasPath()) {
      // eslint-disable-next-line no-console
      console.error(
        `[PLAYBACK:${this.record.id}] WARNING: No outbound delivery path after ${timeoutMs}ms — audio will be lost. hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[PLAYBACK:${this.record.id}] Outbound delivery path ready: hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    }
  }

  private async playAudioChunk(audio: AudioPayload): Promise<void> {
    this.playAudioChunkCount += 1;
    const sid = this.record.id;

    // On the first chunk, wait for the bridge to register its listener.
    if (this.playAudioChunkCount === 1) {
      await this.waitForOutboundReady(2000, this.record.loopAbortController?.signal ?? AbortSignal.abort());
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PLAYBACK:${sid}] playAudioChunk #${this.playAudioChunkCount}: encoding=${audio.encoding} sampleRate=${audio.sampleRateHz} bytes=${audio.data.byteLength} hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
    );
    if (this.record.mediaStream) {
      await this.record.mediaStream.sendAudio(audio);
    }
    for (const listener of this.record.outboundAudioListeners) listener(audio);
  }
}

export { toSessionErrorInfo };