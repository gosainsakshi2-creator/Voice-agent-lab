/**
 * language-model-provider.interface.ts
 *
 * Contract that ANY LLM vendor (GPT-5.1, Gemma 4 today, others
 * tomorrow) must satisfy to be plugged into the Provider Registry.
 */

import type {
  ConversationTurn,
  ProviderDescriptor,
  ProviderHealthStatus,
} from "../../types/provider.types";
import type { SessionId } from "../../types/session.types";
import type { LlmStreamEvent } from "../../types/streaming.types";

/**
 * Parameters required to obtain the next assistant turn given a
 * conversation history.
 */
export interface CompletionRequest {
  readonly sessionId: SessionId;
  readonly history: readonly ConversationTurn[];
}

/**
 * Normalized result of a completion request.
 */
export interface CompletionResult {
  readonly turn: ConversationTurn;
  readonly latencyMs: number;
}

export interface LanguageModelProvider {
  readonly descriptor: ProviderDescriptor;

  /**
   * Produce the next assistant turn for a given conversation
   * history. Streaming token delivery is intentionally out of
   * scope for this architecture pass.
   */
  generateCompletion(request: CompletionRequest): Promise<CompletionResult>;

  /**
   * OPTIONAL, ADDITIVE. Produce the next assistant turn as a stream
   * of `LlmTokenEvent`s followed by exactly one terminal
   * `LlmFinalEvent` carrying the same `ConversationTurn` +
   * `latencyMs` shape as `CompletionResult`. A provider that does
   * not implement token streaming simply omits this member; callers
   * must feature-detect it (`if (provider.generateCompletionStream)`)
   * and fall back to `generateCompletion` otherwise. Does not
   * replace or alter the semantics of `generateCompletion`.
   */
  generateCompletionStream?(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;

  /**
   * Report whether the provider's upstream connection is currently
   * reachable and authenticated.
   */
  checkHealth(): Promise<ProviderHealthStatus>;
}
