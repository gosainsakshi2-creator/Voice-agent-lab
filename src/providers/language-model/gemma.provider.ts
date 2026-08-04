/**
 * gemma.provider.ts
 *
 * Concrete `LanguageModelProvider` implementation for Gemma, backed
 * by Google AI Studio's official Node.js SDK (`@google/generative-ai`).
 *
 * The system prompt is passed via the SDK's `systemInstruction`
 * parameter — a dedicated field that keeps behavioural instructions
 * completely separate from the conversation content the model sees.
 * This prevents the model from echoing the system prompt back as
 * conversational output, which happened when the system prompt was
 * folded into the `contents` array as a user turn.
 *
 * Google's API requires strict user/model alternation inside
 * `contents`. This adapter enforces that invariant by merging
 * adjacent same-role turns and filtering out any system turns
 * before they reach the `contents` array.
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
 * Converts ONLY the non-system turns of a conversation history into
 * Google's `Content[]` shape. System turns are excluded — they are
 * passed separately via `systemInstruction`.
 *
 * Google's API requires strict user/model alternation. Adjacent
 * same-role turns are merged into a single Content entry.
 */
function toGoogleContents(history: readonly ConversationTurn[]): Content[] {
  const contents: Content[] = [];

  for (const turn of history) {
    // System turns are handled via systemInstruction — skip them.
    if (turn.role === "system") continue;

    const role = turn.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];

    // Google requires strict alternation. If two consecutive turns
    // share a role (e.g. multiple user utterances before the model
    // replied), merge them into one Content entry.
    if (last && last.role === role) {
      last.parts.push({ text: turn.content });
    } else {
      contents.push({ role, parts: [{ text: turn.content }] });
    }
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
    // Extract the system prompt to pass via systemInstruction,
    // keeping it completely out of the conversation contents.
    const systemParts = request.history
      .filter((turn) => turn.role === "system")
      .map((turn) => turn.content);
    const systemPreamble = systemParts.join("\n\n");

    const model = this.client.getGenerativeModel({
      model: this.config.model,
      ...(systemPreamble.length > 0 ? { systemInstruction: systemPreamble } : {}),
    });

    const contents = toGoogleContents(request.history);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] generateCompletion: model=${this.config.model} contentsLength=${contents.length} roles=[${contents.map((c) => c.role).join(",")}] systemInstructionLen=${systemPreamble.length}`,
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
      await getOk(
        this.descriptor.id,
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`,
        {},
      );
    });
  }
}
