/**
 * llm-usage-telemetry-tests.ts — `npm run test:llm-usage-telemetry`
 *
 * FIX #6A — TELEMETRY ONLY. Covers the two places the new usage fields
 * (`promptTokens`, `cachedPromptTokens`, `reasoningTokens`) were added:
 *
 *   1. `OpenAiGptLanguageModelProvider.generateCompletionStream` now
 *      forwards the usage chunk it was already fetching (previously
 *      console-logged only) onto the stream's `final` event.
 *   2. `SessionMetricsCollector.recordTurn` now stores those three
 *      fields on `TurnLatencyBreakdown`, using the same
 *      "0 is real, undefined is not measured" rule as every other
 *      field on that type.
 *
 * The OpenAI SDK client is replaced with a local fake (`this.client`
 * is a plain, untyped-at-runtime property — TypeScript's `private` is
 * a compile-time-only annotation) so these tests make no network call
 * and require no `OPENAI_API_KEY`. Section A also captures the exact
 * object passed to `chat.completions.create` and asserts it is
 * unchanged by this pass — model, messages, `stream`, `verbosity`,
 * `stream_options` — proving the request itself was not touched.
 *
 * NOTHING HERE CONTACTS OPENAI OR ANY OTHER VENDOR.
 */

import assert from "node:assert/strict";

const { OpenAiGptLanguageModelProvider } = await import(
  "../../providers/language-model/openai-gpt.provider"
);
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { ProviderCategory } = await import("../../types/enums");

import type { ConversationTurn } from "../../types/provider.types";
import type { LlmFinalEvent, LlmTokenEvent } from "../../types/streaming.types";
import type { SessionId } from "../../types/session.types";
import type { ProviderStackSelection } from "../../types/session.types";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);

// ═════════════════════════════════════════════════════════════════
// SECTION A — provider: usage capture on the stream's `final` event
// ═════════════════════════════════════════════════════════════════

/** A minimal fake `ChatCompletionChunk`, shaped exactly like the real SDK's. */
function tokenChunk(content: string) {
  return { choices: [{ delta: { content }, finish_reason: null }], usage: null };
}

function usageChunk(usage: {
  prompt_tokens: number;
  cached_tokens?: number;
  completion_tokens: number;
  reasoning_tokens?: number;
}) {
  return {
    choices: [],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      prompt_tokens_details:
        usage.cached_tokens !== undefined ? { cached_tokens: usage.cached_tokens } : undefined,
      completion_tokens: usage.completion_tokens,
      completion_tokens_details:
        usage.reasoning_tokens !== undefined ? { reasoning_tokens: usage.reasoning_tokens } : undefined,
    },
  };
}

/**
 * Builds a provider whose OpenAI client is a fake that streams exactly
 * `chunks` and records the single object it was called with. `create`
 * is async and returns an async-iterable, matching the real SDK's
 * `chat.completions.create({ stream: true, ... })` contract.
 */
function fakeProvider(chunks: readonly unknown[]) {
  const calls: unknown[] = [];
  const provider = new OpenAiGptLanguageModelProvider({ apiKey: "test-key", model: "gpt-5.1" });
  // `client` is `private` only at the type level; this replaces it with
  // a local fake so no network call is made. Production code (the
  // provider class) is not modified to allow this.
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          calls.push(params);
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const chunk of chunks) yield chunk;
            },
          };
        },
      },
    },
  };
  return { provider, calls };
}

const history: readonly ConversationTurn[] = [
  { role: "system", content: "You are a helpful voice assistant.", timestamp: new Date() },
  { role: "user", content: "Hello", timestamp: new Date() },
];

async function drain(
  provider: InstanceType<typeof OpenAiGptLanguageModelProvider>,
): Promise<{ tokens: LlmTokenEvent[]; final: LlmFinalEvent }> {
  const tokens: LlmTokenEvent[] = [];
  let final: LlmFinalEvent | undefined;
  for await (const event of provider.generateCompletionStream!({
    sessionId: "test" as SessionId,
    history,
  })) {
    if (event.type === "token") tokens.push(event);
    else final = event;
  }
  assert.ok(final, "stream must yield exactly one final event");
  return { tokens, final: final! };
}

section("SECTION A — provider forwards usage onto the final event");

await test("usage values are captured correctly onto the final event", async () => {
  const { provider } = fakeProvider([
    tokenChunk("Hi"),
    tokenChunk(" there"),
    usageChunk({ prompt_tokens: 9000, cached_tokens: 8192, completion_tokens: 40, reasoning_tokens: 12 }),
  ]);
  const { final } = await drain(provider);
  assert.equal(final.promptTokens, 9000);
  assert.equal(final.cachedPromptTokens, 8192);
  assert.equal(final.reasoningTokens, 12);
});

await test("cached tokens of zero are preserved, not dropped as falsy", async () => {
  const { provider } = fakeProvider([
    tokenChunk("Hi"),
    usageChunk({ prompt_tokens: 500, cached_tokens: 0, completion_tokens: 10, reasoning_tokens: 0 }),
  ]);
  const { final } = await drain(provider);
  assert.equal(final.cachedPromptTokens, 0, "cached_tokens: 0 (a genuine cache miss) must read back as 0");
  assert.notEqual(final.cachedPromptTokens, undefined);
});

await test("reasoning tokens are preserved, including zero", async () => {
  const { provider } = fakeProvider([
    tokenChunk("Hi"),
    usageChunk({ prompt_tokens: 500, cached_tokens: 128, completion_tokens: 10, reasoning_tokens: 0 }),
  ]);
  const { final } = await drain(provider);
  assert.equal(final.reasoningTokens, 0);
});

await test("usage fields are omitted (not zeroed) when no usage chunk arrives", async () => {
  // Mirrors a barge-in: the stream ends (or is abandoned) before the
  // trailing usage-only chunk is ever sent.
  const { provider } = fakeProvider([tokenChunk("Hi"), tokenChunk(" there")]);
  const { final } = await drain(provider);
  assert.equal(Object.prototype.hasOwnProperty.call(final, "promptTokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(final, "cachedPromptTokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(final, "reasoningTokens"), false);
});

await test("existing streaming behavior is unchanged: token deltas and final content are unaffected", async () => {
  const { provider } = fakeProvider([
    tokenChunk("Hi"),
    tokenChunk(" there"),
    usageChunk({ prompt_tokens: 100, cached_tokens: 50, completion_tokens: 5 }),
  ]);
  const { tokens, final } = await drain(provider);
  assert.deepEqual(
    tokens.map((t) => t.delta),
    ["Hi", " there"],
  );
  assert.equal(final.type, "final");
  assert.equal(final.turn.content, "Hi there");
  assert.equal(final.turn.role, "assistant");
  assert.equal(typeof final.latencyMs, "number");
  assert.ok(final.latencyMs >= 0);
});

await test("the request sent to OpenAI is unchanged: same model, messages, stream, verbosity, stream_options", async () => {
  const { provider, calls } = fakeProvider([
    tokenChunk("Hi"),
    usageChunk({ prompt_tokens: 10, cached_tokens: 0, completion_tokens: 1 }),
  ]);
  await drain(provider);
  assert.equal(calls.length, 1, "exactly one request must be issued");
  assert.deepEqual(calls[0], {
    model: "gpt-5.1",
    messages: [
      { role: "system", content: "You are a helpful voice assistant." },
      { role: "user", content: "Hello" },
    ],
    stream: true,
    verbosity: "low",
    stream_options: { include_usage: true },
  });
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — metrics collector: storage of the new fields
// ═════════════════════════════════════════════════════════════════

section("SECTION B — SessionMetricsCollector stores the new fields correctly");

const stack: ProviderStackSelection = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
};

function baseTurnInput(overrides: Partial<Parameters<InstanceType<typeof SessionMetricsCollector>["recordTurn"]>[0]> = {}) {
  return {
    turnIndex: 0,
    sttMs: 100,
    llmMs: 800,
    ttsMs: 200,
    totalMs: 1100,
    llmGenerationMs: 1500,
    ttsSynthesisMs: 900,
    userSpeechMs: 1200,
    sttCostUsd: 0,
    llmCostUsd: 0,
    ttsCostUsd: 0,
    promptTokens: undefined,
    cachedPromptTokens: undefined,
    reasoningTokens: undefined,
    ...overrides,
  };
}

await test("promptTokens, cachedPromptTokens, reasoningTokens are stored when provided", () => {
  const collector = new SessionMetricsCollector("test" as SessionId, stack);
  collector.recordTurn(
    baseTurnInput({ promptTokens: 12411, cachedPromptTokens: 12288, reasoningTokens: 0 }),
  );
  const turn = collector.build().turnLatencies[0]!;
  assert.equal(turn.promptTokens, 12411);
  assert.equal(turn.cachedPromptTokens, 12288);
  assert.equal(turn.reasoningTokens, 0);
});

await test("cachedPromptTokens of 0 survives recordTurn — a real cache miss is not 'not measured'", () => {
  const collector = new SessionMetricsCollector("test" as SessionId, stack);
  collector.recordTurn(baseTurnInput({ promptTokens: 12411, cachedPromptTokens: 0 }));
  const turn = collector.build().turnLatencies[0]!;
  assert.equal(turn.cachedPromptTokens, 0);
  assert.notEqual(turn.cachedPromptTokens, undefined);
});

await test("fields are absent (not present, not zero) when the turn had no usage data", () => {
  const collector = new SessionMetricsCollector("test" as SessionId, stack);
  collector.recordTurn(baseTurnInput());
  const turn = collector.build().turnLatencies[0]!;
  assert.equal(Object.prototype.hasOwnProperty.call(turn, "promptTokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(turn, "cachedPromptTokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(turn, "reasoningTokens"), false);
});

await test("existing llmMs (time-to-first-token) is completely unaffected by the new fields", () => {
  const withUsage = new SessionMetricsCollector("test" as SessionId, stack);
  withUsage.recordTurn(
    baseTurnInput({ llmMs: 842, promptTokens: 12411, cachedPromptTokens: 12288, reasoningTokens: 0 }),
  );
  const withoutUsage = new SessionMetricsCollector("test" as SessionId, stack);
  withoutUsage.recordTurn(baseTurnInput({ llmMs: 842 }));

  const a = withUsage.build().turnLatencies[0]!;
  const b = withoutUsage.build().turnLatencies[0]!;
  assert.equal(a.llm?.milliseconds, 842);
  assert.equal(b.llm?.milliseconds, 842);
  assert.equal(a.llm?.milliseconds, b.llm?.milliseconds, "usage telemetry must not change llmMs");
});

await test("llmMs remains absent (never 0) when the turn genuinely has no measurement, regardless of usage data", () => {
  const collector = new SessionMetricsCollector("test" as SessionId, stack);
  collector.recordTurn(
    baseTurnInput({ llmMs: undefined, promptTokens: 500, cachedPromptTokens: 0, reasoningTokens: 0 }),
  );
  const turn = collector.build().turnLatencies[0]!;
  assert.equal(turn.llm, undefined);
  assert.equal(turn.promptTokens, 500);
});

// ─────────────────────────────────────────────────────────────────
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
console.log("No telephony, TTS, STT, LLM or database request was made.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
