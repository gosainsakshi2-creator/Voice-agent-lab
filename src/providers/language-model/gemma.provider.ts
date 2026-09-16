/**
 * gemma.provider.ts
 *
 * Concrete `LanguageModelProvider` implementation for Gemma 4, backed
 * by OpenRouter's OpenAI-compatible Chat Completions API through the
 * official `openai` Node.js SDK.
 *
 * The SDK is already a dependency of this repository (it serves the
 * GPT-5.1 adapter next door), and OpenRouter speaks the same wire
 * protocol behind a different `baseURL`, so this adapter introduces no
 * second HTTP client and no new package.
 *
 * ── WHY THIS FILE NO LONGER PARSES "thought" PARTS ─────────────────
 *
 * The previous backend was Google AI Studio (`@google/generative-ai`).
 * There, a thinking model returned its private reasoning as an extra
 * `Part` on the SAME candidate as the answer:
 *
 *   parts[0] = { thought: true, text: "*  Role: ... Constraints: ..." }
 *   parts[1] = { text: "Hello! I'm calling from FlexiFunnels..." }
 *
 * and the SDK's `response.text()` helper concatenated both, which is
 * how a reasoning trace once reached the sentence chunker and TTS.
 *
 * OpenRouter's response shape is different, and that Google-specific
 * parsing must NOT be carried over. Reasoning is never mixed into
 * `content`: OpenRouter normalizes it onto SEPARATE, non-standard
 * fields alongside the OpenAI-standard ones —
 *
 *   batch:     choices[0].message.content    <- the spoken answer
 *              choices[0].message.reasoning  <- reasoning, if any
 *   streaming: choices[0].delta.content      <- the spoken answer
 *              choices[0].delta.reasoning    <- reasoning, if any
 *
 * (plus a structured `reasoning_details` carrying the same trace).
 *
 * So the filter here is by construction rather than by inspection:
 * this adapter reads `content` and ONLY `content`, on both paths. A
 * reasoning field is never concatenated, never yielded as a token
 * event, and therefore can never reach the sentence chunker or TTS.
 * `reasoning` is touched in exactly one way — its length is measured
 * for the log line, preserving the observability the Google adapter
 * had (`thoughtCharsStripped`) so "did this model think, and for how
 * long before it spoke" stays answerable from the logs.
 *
 * The `reasoning` fields are absent from the SDK's typed unions
 * (they are an OpenRouter extension), so they are declared locally
 * below rather than cast away at each use site — the same approach
 * the Google adapter took with `thought`.
 *
 * ── SYSTEM PROMPT AND TURN ORDER ───────────────────────────────────
 *
 * Roles on `ConversationTurn` ("system" | "user" | "assistant") map
 * one-to-one onto Chat Completions roles, so the conversation crosses
 * the wire exactly as the pipeline built it: system instructions stay
 * `system` messages, and user/assistant order and content are
 * preserved verbatim.
 *
 * The Google adapter additionally had to hoist system turns into
 * `systemInstruction` and merge adjacent same-role turns, because that
 * API rejects anything but strict user/model alternation. Chat
 * Completions has no such constraint, so no merging happens here and
 * two consecutive caller turns stay two distinct messages.
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
import { getOk } from "../shared/http";

/** OpenRouter's OpenAI-compatible endpoint root. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Model served when `GEMMA_MODEL` is unset. */
const DEFAULT_GEMMA_MODEL = "google/gemma-4-26b-a4b-it";

interface GemmaEnvConfig {
  readonly apiKey: string;
  readonly model: string;
}

function loadEnvConfig(): GemmaEnvConfig {
  return {
    apiKey: requireEnv("OPENROUTER_API_KEY", LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4),
    model: optionalEnv("GEMMA_MODEL", DEFAULT_GEMMA_MODEL),
  };
}

/**
 * OpenRouter's reasoning extension, absent from the `openai` SDK's
 * typed message/delta unions (see the file header). Declared as its
 * own view so the field is read in one shape at both use sites and
 * never confused with `content`.
 */
interface OpenRouterReasoningCarrier {
  readonly reasoning?: string | null;
}

/** Characters of reasoning on a message/delta — measured, never emitted. */
function reasoningLengthOf(carrier: unknown): number {
  const reasoning = (carrier as OpenRouterReasoningCarrier | undefined)?.reasoning;
  return typeof reasoning === "string" ? reasoning.length : 0;
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

/** One-line-per-message structural dump of exactly what goes over the wire. */
function describePayload(messages: readonly ChatCompletionMessageParam[]): string {
  const rows = messages
    .map((message, index) => {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      const preview = text.slice(0, 70).replace(/\s+/g, " ");
      return `  [${index}] role=${message.role} chars=${text.length} "${preview}${text.length > 70 ? "…" : ""}"`;
    })
    .join("\n");

  return `messages (${messages.length}):\n${rows}`;
}

export class GemmaLanguageModelProvider implements LanguageModelProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.LANGUAGE_MODEL,
    id: LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4,
    displayName: "Gemma 4",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "openrouter-chat-completions",
  };

  private readonly client: OpenAI;
  private readonly config: GemmaEnvConfig;

  constructor(config: GemmaEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: OPENROUTER_BASE_URL,
    });
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResult> {
    const messages: ChatCompletionMessageParam[] = request.history.map((turn) => toOpenAiMessage(turn));

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] FINAL PAYLOAD -> ${this.config.model} (openrouter chat.completions)\n${describePayload(messages)}`,
    );

    const { result: completion, latencyMs } = await timed(() =>
      this.client.chat.completions.create({
        model: this.config.model,
        messages,
      }),
    );

    const message = completion.choices[0]?.message;
    // `content` only — reasoning lives on its own field and is never
    // part of the spoken answer (see the file header).
    const content = message?.content ?? "";
    const reasoningChars = reasoningLengthOf(message);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] Response: ${latencyMs}ms reasoningCharsIgnored=${reasoningChars} contentLen=${content.length} text="${content.slice(0, 100)}${content.length > 100 ? "..." : ""}" finishReason=${completion.choices[0]?.finish_reason}`,
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

  async *generateCompletionStream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const messages: ChatCompletionMessageParam[] = request.history.map((turn) => toOpenAiMessage(turn));

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] FINAL PAYLOAD -> ${this.config.model} (openrouter chat.completions stream)\n${describePayload(messages)}`,
    );

    const startedAt = Date.now();
    let tokenIndex = 0;
    let fullContent = "";
    let reasoningChars = 0;
    let firstAnswerTokenAtMs = 0;

    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      const delta = chunk.choices[0]?.delta;

      // Counted, not emitted: a reasoning delta must never become a
      // token event, or it would be spoken.
      reasoningChars += reasoningLengthOf(delta);

      const text = delta?.content;
      if (!text) continue;

      if (firstAnswerTokenAtMs === 0) {
        firstAnswerTokenAtMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.log(
          `[LLM:gemma] first ANSWER token at ${firstAnswerTokenAtMs}ms (after ${reasoningChars} chars of reasoning, not spoken)`,
        );
      }

      // Forwarded as it arrives — no batching, no sentence assembly
      // here; the pipeline's chunker owns that.
      fullContent += text;
      yield { type: "token" as const, delta: text, index: tokenIndex++ };
    }

    const latencyMs = Date.now() - startedAt;

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] Stream complete: ${latencyMs}ms firstAnswerTokenMs=${firstAnswerTokenAtMs} tokens=${tokenIndex} contentLen=${fullContent.length} reasoningCharsIgnored=${reasoningChars}`,
    );

    yield {
      type: "final" as const,
      turn: { role: "assistant" as const, content: fullContent, timestamp: new Date() },
      latencyMs,
    };
  }

  /**
   * Two cheap authenticated GETs, no generation:
   *
   *   1. `/key`  — 401s on a missing or invalid `OPENROUTER_API_KEY`,
   *      and fails outright when OpenRouter is unreachable. (The
   *      `/models` list is public, so it would pass with a bad key and
   *      is not a credential check.)
   *   2. `/models/{model}/endpoints` — 404s when the configured
   *      `GEMMA_MODEL` is not served, which is the one failure the key
   *      probe cannot see.
   *
   * Neither consumes credits or tokens.
   */
  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      const headers = { Authorization: `Bearer ${this.config.apiKey}` };
      await getOk(this.descriptor.id, `${OPENROUTER_BASE_URL}/key`, headers);
      await getOk(
        this.descriptor.id,
        `${OPENROUTER_BASE_URL}/models/${this.config.model}/endpoints`,
        headers,
      );
    });
  }
}
