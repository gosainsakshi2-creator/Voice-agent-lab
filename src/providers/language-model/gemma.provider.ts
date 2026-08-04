/**
 * gemma.provider.ts
 *
 * Concrete `LanguageModelProvider` implementation for Gemma, backed
 * by Google AI Studio's official Node.js SDK (`@google/generative-ai`).
 *
 * Google's Generative Language API only recognizes "user" and
 * "model" roles inside `contents`, and — per Google's own
 * documentation — Gemma models (unlike Gemini) do not support the
 * separate `systemInstruction` field. To stay within documented
 * behavior rather than inventing support for an unsupported field,
 * this adapter folds any "system" turns into a leading "user" turn
 * instead of passing `systemInstruction`.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Content } from "@google/generative-ai";
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
import { getOk } from "../shared/http";

interface GemmaEnvConfig {
  readonly apiKey: string;
  readonly model: string;
}

function loadEnvConfig(): GemmaEnvConfig {
  return {
    apiKey: requireEnv("GEMMA_API_KEY", LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4),
    model: optionalEnv("GEMMA_MODEL", "gemma-3-27b-it"),
  };
}

/**
 * Converts vendor-neutral conversation history into Google's
 * `Content[]` shape, merging any "system" turns into the first
 * "user" turn (see file-level comment for rationale).
 */
function toGoogleContents(history: readonly ConversationTurn[]): Content[] {
  const systemPreamble = history
    .filter((turn) => turn.role === "system")
    .map((turn) => turn.content)
    .join("\n\n");

  const conversational = history.filter((turn) => turn.role !== "system");

  const contents: Content[] = conversational.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));

  if (systemPreamble.length > 0 && contents.length > 0 && contents[0]?.role === "user") {
    const first = contents[0];
    contents[0] = { role: "user", parts: [{ text: `${systemPreamble}\n\n${first.parts[0]?.text ?? ""}` }] };
  }

  return contents;
}

export class GemmaLanguageModelProvider implements LanguageModelProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.LANGUAGE_MODEL,
    id: LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
    displayName: "Gemma 4",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "google-ai-studio",
  };

  private readonly client: GoogleGenerativeAI;
  private readonly config: GemmaEnvConfig;

  constructor(config: GemmaEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new GoogleGenerativeAI(config.apiKey);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.client.getGenerativeModel({ model: this.config.model });
    const contents = toGoogleContents(request.history);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] generateCompletion: model=${this.config.model} contentsLength=${contents.length} roles=[${contents.map((c) => c.role).join(",")}]`,
    );

    const { result, latencyMs } = await timed(() => model.generateContent({ contents }));

    const content = result.response.text();

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] Response: ${latencyMs}ms contentLen=${content.length} text="${content.slice(0, 100)}${content.length > 100 ? "..." : ""}"`,
    );

    if (content.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[LLM:gemma] WARNING: empty content from model`);
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
      // The SDK does not expose a dedicated "list models" call; use
      // the official REST list-models endpoint (same API the SDK
      // wraps) as a lightweight, side-effect-free credential check.
      await getOk(
        this.descriptor.id,
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`,
        {},
      );
    });
  }
}
