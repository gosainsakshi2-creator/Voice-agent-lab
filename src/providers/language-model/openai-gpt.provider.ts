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

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.models.list();
    });
  }
}
