/**
 * gemma.provider.ts
 *
 * Concrete `LanguageModelProvider` implementation for Gemma, backed
 * by Google AI Studio's official Node.js SDK (`@google/generative-ai`).
 *
 * ── WHY THIS FILE FILTERS "thought" PARTS ──────────────────────────
 *
 * `gemma-4-31b-it` (and `gemma-4-26b-a4b-it`) are THINKING models.
 * Every response comes back as two parts:
 *
 *   parts[0] = { thought: true, text: "*  Role: Professional AI Voice
 *                Agent for FlexiFunnels.\n *  Constraints: ..." }
 *   parts[1] = { text: "Hello! I'm calling from FlexiFunnels. Is this
 *                a good time to talk?" }
 *
 * The first part is the model's private reasoning trace — it plans in
 * "Role: / Context: / Constraints:" bullets, drafts two or three
 * candidate replies, self-checks them, then emits the real answer.
 * Confirmed against the live API: `usageMetadata` reports
 * `thoughtsTokenCount: 184` against `candidatesTokenCount: 20`.
 *
 * That reasoning trace is NOT prompt echo, and no amount of prompt
 * engineering suppresses it. It reproduces identically whether the
 * system prompt is passed via `systemInstruction`, merged into the
 * first user turn, or split across a user/model priming pair.
 *
 * What actually leaked it to the caller is the SDK: this package is
 * v0.24.x, which predates the `thought` field entirely (it is absent
 * from the `Part` union in `generative-ai.d.ts`). Its `response.text()`
 * / `chunk.text()` helper concatenates the text of EVERY part with no
 * `thought` check, so the reasoning trace was returned as if it were
 * the reply and handed straight to the sentence chunker and TTS.
 *
 * Thinking cannot be turned off for this model family — the API
 * rejects both levers with HTTP 400:
 *   generationConfig.thinkingConfig.thinkingBudget -> "Thinking budget
 *     is not supported for this model."
 *   generationConfig.thinkingConfig.thinkingLevel  -> "Thinking level
 *     is not supported for this model."
 * (`includeThoughts: false` is accepted but ignored; thoughts still
 * come back.) So the parts must be filtered on our side, which is what
 * `answerPartsOf` below does for both the batch and streaming paths.
 *
 * ── SYSTEM PROMPT ──────────────────────────────────────────────────
 *
 * `systemInstruction` is supported by these models and is used
 * directly: instructions arrive as instructions, the caller's message
 * arrives as the thing to answer. The previous "merge the prompt into
 * the first user turn behind a long don't-repeat-this preamble"
 * workaround is gone — it was fighting a symptom that had a different
 * cause, and the extra preamble text measurably made the model's
 * reasoning longer, not shorter.
 *
 * Google's API requires strict user/model alternation inside
 * `contents`. This adapter enforces that invariant by merging
 * adjacent same-role turns.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Content, GenerateContentRequest } from "@google/generative-ai";
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

interface GemmaEnvConfig {
  readonly apiKey: string;
  readonly model: string;
}

function loadEnvConfig(): GemmaEnvConfig {
  return {
    apiKey: requireEnv("GEMMA_API_KEY", LANGUAGE_MODEL_PROVIDER_IDS.GEMMA_4),
    model: optionalEnv("GEMMA_MODEL", "gemma-4-31b-it"),
  };
}

/**
 * The shape of a response part as the API actually returns it. The
 * v0.24.x SDK's own `Part` union has no `thought` member (see the file
 * header), so the field is declared here rather than cast away at each
 * use site.
 */
interface GemmaResponsePart {
  readonly text?: string;
  readonly thought?: boolean;
}

/** Minimal view of a (possibly partial) response's first candidate. */
interface GemmaCandidateCarrier {
  readonly candidates?: ReadonlyArray<{ readonly content?: { readonly parts?: readonly GemmaResponsePart[] } }>;
}

/**
 * The model's actual reply, with its private reasoning removed.
 *
 * Deliberately NOT `response.text()`: that helper concatenates every
 * part including `thought: true` ones, which is exactly the bug this
 * provider exists to avoid.
 */
function answerTextOf(response: unknown): string {
  const parts = (response as GemmaCandidateCarrier).candidates?.[0]?.content?.parts ?? [];
  let text = "";
  for (const part of parts) {
    if (part.thought === true) continue;
    if (part.text) text += part.text;
  }
  return text;
}

/** True if the response carried any reasoning parts — logged for observability. */
function hasThoughtParts(response: unknown): boolean {
  const parts = (response as GemmaCandidateCarrier).candidates?.[0]?.content?.parts ?? [];
  return parts.some((part) => part.thought === true);
}

/**
 * Splits a vendor-neutral history into the two things Google's API
 * wants them to be: the system prompt as `systemInstruction`, and the
 * user/model exchange as `contents`.
 *
 * Google requires strict user/model alternation in `contents`, so
 * adjacent same-role turns (e.g. two caller utterances before the
 * model replied) are merged into a single entry.
 */
function toGoogleRequest(history: readonly ConversationTurn[]): GenerateContentRequest {
  const systemPrompt = history
    .filter((turn) => turn.role === "system")
    .map((turn) => turn.content)
    .join("\n\n");

  const contents: Content[] = [];

  for (const turn of history) {
    if (turn.role === "system") continue;

    const role = turn.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];

    if (last && last.role === role) {
      last.parts.push({ text: turn.content });
    } else {
      contents.push({ role, parts: [{ text: turn.content }] });
    }
  }

  return {
    contents,
    ...(systemPrompt.length > 0 ? { systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } } : {}),
  };
}

/** One-line structural dump of exactly what goes over the wire. */
function describePayload(request: GenerateContentRequest): string {
  const system = request.systemInstruction;
  const systemText =
    typeof system === "string"
      ? system
      : ((system as Content | undefined)?.parts ?? []).map((part) => ("text" in part ? part.text : "")).join("");

  const contents = request.contents
    .map((content, index) => {
      const text = content.parts.map((part) => ("text" in part ? (part.text ?? "") : "")).join("");
      const preview = text.slice(0, 70).replace(/\s+/g, " ");
      return `  [${index}] role=${content.role} chars=${text.length} "${preview}${text.length > 70 ? "…" : ""}"`;
    })
    .join("\n");

  return (
    `systemInstruction: ${systemText.length > 0 ? `${systemText.length} chars` : "NONE"}\n` +
    `contents (${request.contents.length}):\n${contents}`
  );
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
    const model = this.buildModel();
    const payload = toGoogleRequest(request.history);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] FINAL PAYLOAD -> ${this.config.model} (generateContent)\n${describePayload(payload)}`,
    );

    const { result, latencyMs } = await timed(() => model.generateContent(payload));
    const content = answerTextOf(result.response);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] Response: ${latencyMs}ms thoughtPartsStripped=${hasThoughtParts(result.response)} contentLen=${content.length} text="${content.slice(0, 100)}${content.length > 100 ? "..." : ""}"`,
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

  private buildModel() {
    return this.client.getGenerativeModel({ model: this.config.model });
  }

  async *generateCompletionStream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const model = this.buildModel();
    const payload = toGoogleRequest(request.history);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] FINAL PAYLOAD -> ${this.config.model} (streamGenerateContent)\n${describePayload(payload)}`,
    );

    const startedAt = Date.now();
    let tokenIndex = 0;
    let fullContent = "";
    let thoughtChars = 0;
    let firstAnswerTokenAtMs = 0;

    const streamResult = await model.generateContentStream(payload);

    for await (const chunk of streamResult.stream) {
      if (signal?.aborted) break;

      // Per-part, not `chunk.text()`: the reasoning trace and the
      // reply can arrive in the same chunk, and only the reply may be
      // forwarded to the sentence chunker / TTS.
      for (const part of (chunk as GemmaCandidateCarrier).candidates?.[0]?.content?.parts ?? []) {
        if (part.thought === true) {
          thoughtChars += part.text?.length ?? 0;
          continue;
        }
        const text = part.text;
        if (!text) continue;
        if (firstAnswerTokenAtMs === 0) {
          firstAnswerTokenAtMs = Date.now() - startedAt;
          // eslint-disable-next-line no-console
          console.log(
            `[LLM:gemma] first ANSWER token at ${firstAnswerTokenAtMs}ms (after ${thoughtChars} chars of reasoning, not spoken)`,
          );
        }
        fullContent += text;
        yield { type: "token" as const, delta: text, index: tokenIndex++ };
      }
    }

    const latencyMs = Date.now() - startedAt;

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:gemma] Stream complete: ${latencyMs}ms firstAnswerTokenMs=${firstAnswerTokenAtMs} tokens=${tokenIndex} contentLen=${fullContent.length} thoughtCharsStripped=${thoughtChars}`,
    );

    yield {
      type: "final" as const,
      turn: { role: "assistant" as const, content: fullContent, timestamp: new Date() },
      latencyMs,
    };
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
