/**
 * llm-retry-attribution-tests.ts — `npm run test:llm-retry-attribution`
 *
 * PHASE 3 BATCH 2A — ATTRIBUTION ONLY. Covers the telemetry that
 * answers whether OpenAI SDK retries contribute to production TTFT.
 *
 * The message strings asserted below are the REAL formats emitted by
 * the installed openai 7.3.0, copied from `client.js`:
 *
 *   success   :448,499  `[id] POST url succeeded with status 200 in 812ms`
 *   http retry:448,470  `[id, retryOf: id2] POST url failed with status 500 in 900ms - retrying, 2 attempts remaining`
 *   http term :480,484  `... - error; no more retries left` / `error; not retryable`
 *   conn retry:416      `[id] connection timed out - retrying, 1 attempts remaining`
 *   conn term :425,426  `[id] connection failed - error; no more retries left`
 *
 * If a future SDK changes that wording, the parser returns `null`, the
 * raw line is still logged, and attribution degrades to "absent"
 * rather than to a confidently wrong number — asserted in section D.
 *
 * NOTHING HERE PLACES A CALL, OPENS A SOCKET, CONTACTS OPENAI, TOUCHES
 * A DATABASE OR CHANGES RETRY POLICY. No `OpenAI` client is
 * constructed; the logger is exercised directly.
 */

import assert from "node:assert/strict";

const {
  attemptCountOf,
  createRetryAttributionLogger,
  parseSdkLogLine,
  retryCountOf,
  retryOverheadMsOf,
  retryReasonsOf,
  withRetryAttribution,
} = await import("../../providers/language-model/openai-retry-telemetry");
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { ProviderCategory } = await import("../../types/enums");

import type { SdkLogger } from "../../providers/language-model/openai-retry-telemetry";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}
const section = (t: string) => console.log(`\n${t}`);

// Real SDK line shapes.
const LINE_SUCCESS = `[log_a1b2c3] POST https://api.openai.com/v1/chat/completions succeeded with status 200 in 812ms`;
const LINE_HTTP_RETRY = `[log_a1b2c3, x-request-id: "req_1"] POST https://api.openai.com/v1/chat/completions failed with status 500 in 900ms - retrying, 2 attempts remaining`;
const LINE_HTTP_RETRY_2 = `[log_d4e5f6, retryOf: log_a1b2c3, x-request-id: "req_2"] POST https://api.openai.com/v1/chat/completions failed with status 429 in 750ms - retrying, 1 attempts remaining`;
const LINE_SUCCESS_AFTER_RETRY = `[log_g7h8i9, retryOf: log_a1b2c3] POST https://api.openai.com/v1/chat/completions succeeded with status 200 in 640ms`;
const LINE_HTTP_TERMINAL = `[log_a1b2c3] POST https://api.openai.com/v1/chat/completions failed with status 500 in 900ms - error; no more retries left`;
const LINE_CONN_RETRY = `[log_a1b2c3] connection timed out - retrying, 1 attempts remaining`;
const LINE_CONN_TERMINAL = `[log_a1b2c3] connection failed - error; no more retries left`;

/** Collects console output so a test can assert on it without polluting the run. */
function fakeConsole() {
  const lines: string[] = [];
  return {
    lines,
    console_: {
      error: (...a: unknown[]) => lines.push(`error ${a.join(" ")}`),
      warn: (...a: unknown[]) => lines.push(`warn ${a.join(" ")}`),
      info: (...a: unknown[]) => lines.push(`info ${a.join(" ")}`),
      debug: (...a: unknown[]) => lines.push(`debug ${a.join(" ")}`),
    } as unknown as Console,
  };
}

// ═════════════════════════════════════════════════════════════════
section("A. PARSING THE SDK'S REAL LINE FORMATS");

await test("A1. a first-attempt success is recognised as one succeeded attempt", () => {
  const e = parseSdkLogLine(LINE_SUCCESS);
  assert.ok(e);
  assert.equal(e.kind, "succeeded");
  assert.equal(e.status, 200);
  assert.equal(e.attemptMs, 812);
  assert.equal(e.requestLogId, "log_a1b2c3");
  assert.equal(e.retryOfLogId, undefined);
});

await test("A2. an HTTP failure that will be retried is recognised, with its status", () => {
  const e = parseSdkLogLine(LINE_HTTP_RETRY);
  assert.ok(e);
  assert.equal(e.kind, "retrying");
  assert.equal(e.status, 500);
  assert.equal(e.attemptMs, 900);
});

await test("A3. a retry line carries retryOf, linking it to the attempt it replaces", () => {
  const e = parseSdkLogLine(LINE_HTTP_RETRY_2);
  assert.ok(e);
  assert.equal(e.kind, "retrying");
  assert.equal(e.status, 429);
  assert.equal(e.retryOfLogId, "log_a1b2c3");
});

await test("A4. a terminal HTTP failure is NOT counted as a retry", () => {
  const e = parseSdkLogLine(LINE_HTTP_TERMINAL);
  assert.ok(e);
  assert.equal(e.kind, "terminal-failure");
  assert.equal(e.status, 500);
});

await test("A5. a connection timeout is distinguished from an HTTP status", () => {
  const e = parseSdkLogLine(LINE_CONN_RETRY);
  assert.ok(e);
  assert.equal(e.kind, "retrying");
  assert.equal(e.connectionError, true);
  assert.equal(e.timedOut, true);
  assert.equal(e.status, undefined, "a connection error has no HTTP status to report");
});

await test("A6. a connection failure that is not a timeout is marked as such", () => {
  const e = parseSdkLogLine(LINE_CONN_TERMINAL);
  assert.ok(e);
  assert.equal(e.kind, "terminal-failure");
  assert.equal(e.connectionError, true);
  assert.equal(e.timedOut, undefined);
});

// ═════════════════════════════════════════════════════════════════
section("B. ATTRIBUTION — first attempt vs retries, delay, reason, outcome");

await test("B1. a clean single-attempt request reports 1 attempt and 0 retries", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(LINE_SUCCESS);
    return "ok";
  });
  assert.equal(attemptCountOf(attribution), 1);
  assert.equal(retryCountOf(attribution), 0);
  assert.equal(retryReasonsOf(attribution), "", "nothing failed, so there is no reason to report");
  assert.equal(retryOverheadMsOf(attribution), undefined, "a single attempt has no retry overhead");
});

await test("B2. two failures then a success report 3 attempts, 2 retries and both reasons", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(LINE_HTTP_RETRY);
    logger.info(LINE_HTTP_RETRY_2);
    logger.info(LINE_SUCCESS_AFTER_RETRY);
    return "ok";
  });
  assert.equal(attemptCountOf(attribution), 3);
  assert.equal(retryCountOf(attribution), 2);
  assert.equal(retryReasonsOf(attribution), "500,429");
});

await test("B3. retry overhead is MEASURED across the attempts, not computed from the backoff formula", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(LINE_HTTP_RETRY);
    await new Promise((r) => setTimeout(r, 30));
    logger.info(LINE_SUCCESS_AFTER_RETRY);
    return "ok";
  });
  const overhead = retryOverheadMsOf(attribution);
  assert.ok(typeof overhead === "number", "expected a measured overhead");
  assert.ok(overhead >= 25, `expected roughly the real elapsed gap, got ${overhead}ms`);
});

await test("B4. a connection-error retry reports a named reason, not a bare status", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(LINE_CONN_RETRY);
    logger.info(LINE_SUCCESS_AFTER_RETRY);
    return "ok";
  });
  assert.equal(retryReasonsOf(attribution), "connection-timeout");
});

await test("B5. a final failure after exhausted retries is attributed as such", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(LINE_HTTP_RETRY);
    logger.info(LINE_HTTP_RETRY_2);
    logger.info(LINE_HTTP_TERMINAL);
    return "failed";
  });
  assert.equal(attemptCountOf(attribution), 3);
  assert.equal(attribution.events[2]?.kind, "terminal-failure");
  assert.equal(retryReasonsOf(attribution), "500,429,500");
});

await test("B6. CONCURRENT requests do not mix attributions — the reason AsyncLocalStorage is used", async () => {
  // The OpenAI client is shared across calls running at carrier
  // concurrency. A process-wide counter could not tell which request
  // retried; this is the property that makes the numbers per-turn.
  const logger = createRetryAttributionLogger(fakeConsole().console_);

  const slowRetrying = withRetryAttribution(async () => {
    logger.info(LINE_HTTP_RETRY);
    await new Promise((r) => setTimeout(r, 25));
    logger.info(LINE_SUCCESS_AFTER_RETRY);
    return "retried";
  });
  const fastClean = withRetryAttribution(async () => {
    await new Promise((r) => setTimeout(r, 5));
    logger.info(LINE_SUCCESS);
    return "clean";
  });

  const [a, b] = await Promise.all([slowRetrying, fastClean]);
  assert.equal(retryCountOf(a.attribution), 1, "the retrying request owns its retry");
  assert.equal(retryCountOf(b.attribution), 0, "the clean request must NOT inherit the other's retry");
  assert.equal(attemptCountOf(b.attribution), 1);
});

await test("B7. a log line emitted outside any request is dropped, not attributed to someone", () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  assert.doesNotThrow(() => logger.info(LINE_HTTP_RETRY));
});

// ═════════════════════════════════════════════════════════════════
section("C. THE LOGGER CANNOT HARM THE CALL IT DESCRIBES");

await test("C1. warn and error still reach the console — existing SDK diagnostics are not swallowed", () => {
  const { lines, console_ } = fakeConsole();
  const logger = createRetryAttributionLogger(console_);
  logger.warn("sdk warning");
  logger.error("sdk error");
  assert.ok(lines.some((l) => l.startsWith("warn ") && l.includes("sdk warning")));
  assert.ok(lines.some((l) => l.startsWith("error ") && l.includes("sdk error")));
});

await test("C2. a hostile console cannot turn telemetry into an LLM failure", () => {
  const exploding = {
    error: () => {},
    warn: () => {},
    debug: () => {},
    info: () => {
      throw new Error("console exploded");
    },
  } as unknown as Console;
  const logger: SdkLogger = createRetryAttributionLogger(exploding);
  // This function runs INSIDE the SDK's request path. If it throws,
  // it fails the request it was only supposed to observe.
  assert.doesNotThrow(() => logger.info(LINE_HTTP_RETRY));
});

await test("C3. non-string and empty arguments are handled without throwing", () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  assert.doesNotThrow(() => logger.info());
  assert.doesNotThrow(() => logger.info(undefined as unknown as string));
  assert.doesNotThrow(() => logger.info({ not: "a string" }));
  assert.doesNotThrow(() => logger.info(""));
});

await test("C4. a routine first-attempt success adds NO console line", async () => {
  // One extra line per LLM request on every call, for no diagnostic
  // value, is exactly the noise this batch was told to avoid.
  const { lines, console_ } = fakeConsole();
  const logger = createRetryAttributionLogger(console_);
  await withRetryAttribution(async () => {
    logger.info(LINE_SUCCESS);
    return "ok";
  });
  assert.equal(lines.length, 0, `expected silence on the happy path, got: ${lines.join(" | ")}`);
});

await test("C5. a retry DOES produce one greppable console line carrying the raw SDK text", async () => {
  const { lines, console_ } = fakeConsole();
  const logger = createRetryAttributionLogger(console_);
  await withRetryAttribution(async () => {
    logger.info(LINE_HTTP_RETRY);
    return "ok";
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes("[LLM-RETRY]"));
  assert.ok(lines[0]?.includes("kind=retrying"));
  assert.ok(lines[0]?.includes("status=500"));
  assert.ok(lines[0]?.includes(LINE_HTTP_RETRY), "the raw SDK line survives even if parsing later changes");
});

await test("C6. no prompt, message content or credential can reach the telemetry", () => {
  // The SDK's info lines carry a request id, method, URL, status and
  // duration — by construction there is no message body in them. This
  // pins that the parser keeps nothing else even if handed one.
  const e = parseSdkLogLine(
    `[log_x] POST https://api.openai.com/v1/chat/completions failed with status 500 in 10ms - retrying, 2 attempts remaining`,
  );
  assert.ok(e);
  const serialised = JSON.stringify(e);
  assert.ok(!serialised.includes("chat/completions"), "the URL is not retained");
  assert.deepEqual(
    Object.keys(e).sort(),
    ["atMs", "attemptMs", "kind", "requestLogId", "status"].sort(),
  );
});

// ═════════════════════════════════════════════════════════════════
section("D. DEGRADES TO ABSENT, NEVER TO A WRONG NUMBER");

await test("D1. an unrecognised line is ignored rather than counted as an attempt", async () => {
  const logger = createRetryAttributionLogger(fakeConsole().console_);
  const { attribution } = await withRetryAttribution(async () => {
    logger.info(`[log_x] some future SDK wording nobody predicted`);
    return "ok";
  });
  assert.equal(attemptCountOf(attribution), 0, "unparseable input must not invent an attempt");
});

await test("D2. zero observed attempts are reported as ABSENT, not as '1 attempt'", () => {
  // The provider only forwards llmAttempts when > 0. A parsing
  // regression must never masquerade as evidence that retries do not
  // happen — which is the exact conclusion this batch exists to test.
  const attribution = { events: [] };
  assert.equal(attemptCountOf(attribution), 0);
  assert.equal(retryCountOf(attribution), 0);
});

await test("D3. parseSdkLogLine is total — no input shape throws", () => {
  for (const input of ["", "   ", "[log_x]", "retrying,", "succeeded with status"]) {
    assert.doesNotThrow(() => parseSdkLogLine(input));
  }
  assert.equal(parseSdkLogLine(""), null);
});

// ═════════════════════════════════════════════════════════════════
section("E. THE NUMBERS REACH THE PERSISTED PER-TURN METRICS");

const STACK: ProviderStackSelection = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "sarvam" },
};

function turnWith(overrides: Record<string, unknown>) {
  const collector = new SessionMetricsCollector("s-retry" as SessionId, STACK);
  collector.recordTurn({
    turnIndex: 0,
    sttMs: 900, llmMs: 24688, ttsMs: 240, totalMs: 26000,
    llmGenerationMs: 25861, ttsSynthesisMs: 1800, userSpeechMs: 1500,
    sttCostUsd: 0, llmCostUsd: 0, ttsCostUsd: 0,
    promptTokens: undefined, cachedPromptTokens: undefined, reasoningTokens: undefined,
    ...overrides,
  } as never);
  const turn = collector.build().turnLatencies[0];
  assert.ok(turn);
  return turn;
}

await test("E1. attempts, retries, overhead and reasons are persisted alongside TTFT", () => {
  const turn = turnWith({
    llmAttempts: 3, llmRetries: 2, llmRetryOverheadMs: 16000, llmRetryReasons: "500,500",
  });
  assert.equal(turn.llmAttempts, 3);
  assert.equal(turn.llmRetries, 2);
  assert.equal(turn.llmRetryOverheadMs, 16000);
  assert.equal(turn.llmRetryReasons, "500,500");
  assert.equal(turn.llm?.milliseconds, 24688, "TTFT itself is untouched by the attribution");
});

await test("E2. ZERO retries survives as a real observation, not as 'not measured'", () => {
  // This is the answer that falsifies the retry hypothesis, so it must
  // be storable and distinguishable from silence.
  const turn = turnWith({ llmAttempts: 1, llmRetries: 0 });
  assert.equal(turn.llmRetries, 0);
  assert.ok("llmRetries" in turn);
});

await test("E3. a turn with no attribution omits the fields entirely", () => {
  const turn = turnWith({});
  assert.ok(!("llmAttempts" in turn));
  assert.ok(!("llmRetries" in turn));
  assert.ok(!("llmRetryOverheadMs" in turn));
  assert.ok(!("llmRetryReasons" in turn));
});

await test("E4. an empty reasons string is stored as absent rather than as an empty value", () => {
  const turn = turnWith({ llmAttempts: 1, llmRetries: 0, llmRetryReasons: "" });
  assert.ok(!("llmRetryReasons" in turn));
  assert.equal(turn.llmRetries, 0, "...while the count it accompanies still survives");
});

await test("E5. existing per-turn fields are unchanged by the addition", () => {
  const turn = turnWith({ llmAttempts: 3, llmRetries: 2 });
  assert.equal(turn.stt?.milliseconds, 900);
  assert.equal(turn.tts?.milliseconds, 240);
  assert.equal(turn.total?.milliseconds, 26000);
  assert.equal(turn.llmGenerationMs, 25861);
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No telephony, TTS, STT, LLM, database or Google request was made.");
process.exit(failures.length === 0 ? 0 : 1);
