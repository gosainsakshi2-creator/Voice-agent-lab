/**
 * openai-gpt.provider.ts
 *
 * Concrete `LanguageModelProvider` implementation for GPT-5.1, backed
 * by the official `openai` Node.js SDK. Role names on
 * `ConversationTurn` ("system" | "user" | "assistant") map directly
 * onto OpenAI's Chat Completions message roles, so no translation
 * layer is needed beyond shape conversion.
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LANGUAGE_MODEL_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { ConversationTurn, ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type { LlmStreamEvent } from "../../types/streaming.types";
import type {
  CompletionRequest,
  CompletionResult,
  LanguageModelProvider,
} from "../../interfaces/providers/language-model-provider.interface";
import { probeHealth, timed } from "../shared/health";
import { requireEnv, optionalEnv } from "../shared/env";

interface OpenAiEnvConfig {
  readonly apiKey: string;
  readonly model: string;
}

function loadEnvConfig(): OpenAiEnvConfig {
  return {
    apiKey: requireEnv("OPENAI_API_KEY", LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1),
    model: optionalEnv("OPENAI_MODEL", LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1),
  };
}

/**
 * Converts a vendor-neutral `ConversationTurn` into OpenAI's
 * discriminated `ChatCompletionMessageParam` union. Written as an
 * explicit switch (rather than a structural object literal) so
 * TypeScript can verify each branch against the correct member of
 * the union instead of a widened `role` string.
 */
function toOpenAiMessage(turn: ConversationTurn): ChatCompletionMessageParam {
  switch (turn.role) {
    case "system":
      return { role: "system", content: turn.content };
    case "user":
      return { role: "user", content: turn.content };
    case "assistant":
      return { role: "assistant", content: turn.content };
  }
}

export class OpenAiGptLanguageModelProvider implements LanguageModelProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.LANGUAGE_MODEL,
    id: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
    displayName: "GPT-5.1",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "chat-completions",
  };

  private readonly client: OpenAI;
  private readonly config: OpenAiEnvConfig;

  constructor(config: OpenAiEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.apiKey });
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResult> {
    const messages: ChatCompletionMessageParam[] = request.history.map((turn) => toOpenAiMessage(turn));

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:openai] generateCompletion: model=${this.config.model} messageCount=${messages.length} roles=[${messages.map((m) => m.role).join(",")}]`,
    );

    const { result: completion, latencyMs } = await timed(() =>
      this.client.chat.completions.create({
        model: this.config.model,
        messages,
      }),
    );

    const content = completion.choices[0]?.message?.content ?? "";

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:openai] Response: ${latencyMs}ms contentLen=${content.length} text="${content.slice(0, 100)}${content.length > 100 ? "..." : ""}" finishReason=${completion.choices[0]?.finish_reason}`,
    );

    if (content.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[LLM:openai] WARNING: empty content from model — choices=${JSON.stringify(completion.choices)}`,
      );
    }

    const turn: ConversationTurn = {
      role: "assistant",
      content,
      timestamp: new Date(),
    };

    return { turn, latencyMs };
  }

  async *generateCompletionStream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const messages: ChatCompletionMessageParam[] = request.history.map((turn) => toOpenAiMessage(turn));

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:openai] generateCompletionStream: model=${this.config.model} messageCount=${messages.length}`,
    );

    const startedAt = Date.now();
    let tokenIndex = 0;
    let fullContent = "";

    // ── DIAGNOSTIC ONLY — read by nothing, logged once per stream ──────
    //
    // Real token counts from OpenAI, so "where is LLM First Token going"
    // can be answered with measurements instead of the character-count
    // heuristic in cost-estimator.ts. `reasoningTokens` is the one that
    // matters: on a reasoning model those tokens are emitted BEFORE the
    // first visible content token, so they land entirely inside the
    // llm-first-token span. `cachedTokens` says whether the large system
    // prompt is being served from OpenAI's prefix cache or prefilled in
    // full every turn.
    //
    // All four stay `undefined` when the stream is interrupted (barge-in):
    // the usage chunk is the last thing sent, so an aborted stream never
    // reaches it. That is reported as "n/a", never as 0.
    let promptTokens: number | undefined;
    let cachedTokens: number | undefined;
    let completionTokens: number | undefined;
    let reasoningTokens: number | undefined;

    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages,
      stream: true,
      verbosity: "low",
      // Asks for ONE extra chunk before `[DONE]` carrying `usage`, with
      // an empty `choices` array. Adds no tokens, changes no generation
      // parameter, and cannot produce a token event (see the loop below).
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        yield { type: "token" as const, delta, index: tokenIndex++ };
      }

      // ── Why the `finish_reason` break is gone ─────────────────────────
      //
      // The usage chunk arrives AFTER the chunk carrying `finish_reason`,
      // so `if (chunk.choices[0]?.finish_reason) break;` exited one chunk
      // early and made `stream_options.include_usage` inert. Draining to
      // the stream's natural end instead changes nothing that is emitted:
      // no content deltas arrive after `finish_reason`, and the usage
      // chunk has `choices: []` so `chunk.choices[0]?.delta?.content` is
      // undefined and the token branch above cannot fire for it. The
      // `signal?.aborted` check still runs every iteration, so barge-in
      // remains as responsive as before.
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
        completionTokens = chunk.usage.completion_tokens;
        reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
      }
    }

    const latencyMs = Date.now() - startedAt;

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:openai] Stream complete: ${latencyMs}ms tokens=${tokenIndex} contentLen=${fullContent.length}` +
        ` | USAGE promptTokens=${promptTokens ?? "n/a"} cachedTokens=${cachedTokens ?? "n/a"}` +
        ` completionTokens=${completionTokens ?? "n/a"} reasoningTokens=${reasoningTokens ?? "n/a"}`,
    );

    yield {
      type: "final" as const,
      turn: { role: "assistant" as const, content: fullContent, timestamp: new Date() },
      latencyMs,
    };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.models.list();
    });
  }
}
