/**
 * openai-retry-telemetry.ts
 *
 * PHASE 3 BATCH 2A — ATTRIBUTION ONLY. Answers one question with
 * evidence instead of inference: **are OpenAI SDK retries contributing
 * to production time-to-first-token?**
 *
 * The Phase 3 Batch 2 audit measured a bimodal TTFT distribution —
 * p99.5 of 3.9s, then a jump to 21.3s with an empty band between 6.2s
 * and 13.4s — whose shape fits a discrete failure-and-retry rather
 * than a continuously slow model. It could not prove it, because the
 * SDK's retry lines log at `info` while the default `logLevel` is
 * `warn`, so every retry this deployment has ever performed was
 * discarded before it reached a console.
 *
 * ── WHY THE CLIENT `logger` OPTION, AND NOT `OPENAI_LOG` ───────────
 *
 * `OPENAI_LOG=info` is process-wide: it would turn on info logging for
 * every OpenAI client in the process, present and future. The SDK
 * instead accepts a `logger` per client instance (`client.js:166`,
 * consumed through `loggerFor`), which is the narrowest scope the
 * vendor offers — only the voice agent's own LLM client is affected.
 *
 * ── WHY THIS CANNOT CHANGE RETRY BEHAVIOUR ─────────────────────────
 *
 * `loggerFor(client).info(...)` is ALREADY CALLED on every request
 * today; with `logLevel: "warn"` it resolves to `noop` (see
 * `makeLogFn`). This module supplies a real function where a no-op
 * used to sit. It does not touch `maxRetries`, the backoff
 * calculation, the retryable-status table, the timeout, or the
 * request itself — all of which are read elsewhere in the SDK and are
 * not reachable from a logger.
 *
 * ── WHY AsyncLocalStorage ──────────────────────────────────────────
 *
 * The client is shared across concurrent calls (the dispatcher runs at
 * carrier concurrency 3), so a process-wide counter could not say
 * WHICH request retried. The SDK's logger call happens synchronously
 * inside `makeRequest`, which is awaited from our own
 * `chat.completions.create(...)` — i.e. inside our async context — so
 * an `AsyncLocalStorage` store entered around that await captures
 * exactly this request's attempts and nobody else's.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────
 *
 * Every function here is synchronous, allocation-light, and wrapped so
 * that it cannot throw into the SDK's request path: a logger that
 * threw would fail the LLM call it was only supposed to describe.
 * Nothing here awaits, sleeps, or touches the network. No prompt text,
 * message content, caller data or API key can reach it — the SDK's
 * info-level lines carry only a request id, an HTTP method, the
 * endpoint URL, a status code and a duration.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One observed HTTP attempt, as reported by the SDK's own logging. */
export interface RetryAttemptEvent {
  /** Wall clock at which the SDK emitted this line. */
  readonly atMs: number;
  /**
   * What the SDK said happened:
   *   "succeeded"        — this attempt returned response headers OK
   *   "retrying"         — this attempt failed and another will follow
   *   "terminal-failure" — this attempt failed and no retry will follow
   */
  readonly kind: "succeeded" | "retrying" | "terminal-failure";
  /** HTTP status, when the attempt reached a response. Absent for connection errors. */
  readonly status?: number;
  /** `true` when the SDK classified this as a connection error/timeout rather than an HTTP status. */
  readonly connectionError?: boolean;
  /** Whether the SDK called it a timeout specifically. */
  readonly timedOut?: boolean;
  /** The SDK's own per-attempt duration, when its line reported one. */
  readonly attemptMs?: number;
  /** The SDK's local correlation id for this attempt (`log_xxxxxx`). */
  readonly requestLogId?: string;
  /** Present only on a retry: the correlation id of the attempt being retried. */
  readonly retryOfLogId?: string;
}

/**
 * Mutable per-request record. Written only by the logger below, read
 * once the request's `await` has returned.
 */
export interface RetryAttribution {
  /** Every attempt line observed for this request, in order. */
  readonly events: RetryAttemptEvent[];
}

/** Total HTTP attempts observed. 1 means "no retry happened". */
export function attemptCountOf(attribution: RetryAttribution): number {
  return attribution.events.length;
}

/** Retries only — i.e. attempts beyond the first. */
export function retryCountOf(attribution: RetryAttribution): number {
  return Math.max(0, attribution.events.length - 1);
}

/**
 * Measured wall-clock spent on everything except the final attempt:
 * failed attempts plus the SDK's backoff sleeps between them. This is
 * the number that says how much of a turn's TTFT the retry machinery
 * is responsible for.
 *
 * Measured, not computed from the backoff formula: the formula
 * includes random jitter, and the point of this module is evidence.
 * `undefined` when there was nothing to measure (a single attempt) or
 * when the SDK's lines carried no usable timestamps.
 */
export function retryOverheadMsOf(attribution: RetryAttribution): number | undefined {
  const events = attribution.events;
  if (events.length < 2) return undefined;
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return undefined;
  const span = last.atMs - first.atMs;
  return Number.isFinite(span) && span >= 0 ? span : undefined;
}

/**
 * A compact, non-sensitive description of why the retries happened —
 * e.g. `"500,500"` or `"connection-timeout,429"`. Empty string when no
 * retry occurred, so a consumer can store it unconditionally.
 */
export function retryReasonsOf(attribution: RetryAttribution): string {
  return attribution.events
    .filter((e) => e.kind !== "succeeded")
    .map((e) => (e.connectionError ? (e.timedOut ? "connection-timeout" : "connection-error") : String(e.status ?? "unknown")))
    .join(",");
}

const storage = new AsyncLocalStorage<RetryAttribution>();

/**
 * Runs `fn` with a fresh attribution record in scope and hands back
 * both its result and what was observed while it ran.
 *
 * Wrap ONLY the provider call that performs the HTTP request. The
 * retries all happen inside it — the SDK returns to the caller only
 * once an attempt has produced response headers — so the record is
 * complete by the time this resolves.
 */
export async function withRetryAttribution<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; attribution: RetryAttribution }> {
  const attribution: RetryAttribution = { events: [] };
  const result = await storage.run(attribution, fn);
  return { result, attribution };
}

/**
 * Parses one SDK info line into an event. Pure, total, and never
 * throws: an unrecognised line yields `null` and is ignored rather
 * than corrupting the record. The SDK's message formats are not a
 * stable contract, so the raw line is always logged alongside (see
 * `createRetryAttributionLogger`) — if a future SDK version changes
 * wording, attribution degrades to "raw lines in the log" rather than
 * to silently wrong numbers.
 */
export function parseSdkLogLine(message: string): RetryAttemptEvent | null {
  if (typeof message !== "string" || message.length === 0) return null;

  const requestLogId = /\[(log_[0-9a-z]+)/i.exec(message)?.[1];
  const retryOfLogId = /retryOf:\s*(log_[0-9a-z]+)/i.exec(message)?.[1];
  const attemptMsRaw = /\sin\s(\d+)ms/i.exec(message)?.[1];
  const attemptMs = attemptMsRaw === undefined ? undefined : Number(attemptMsRaw);
  // Both outcomes carry the status in the same clause — the SDK builds
  // one `responseInfo` string and only swaps the verb (`client.js:448`),
  // so matching on "failed" alone silently dropped the status from
  // every successful attempt.
  const status = /(?:succeeded|failed) with status\s(\d+)/i.exec(message)?.[1];
  const isConnection = /connection (timed out|failed)/i.test(message);
  const timedOut = /connection timed out/i.test(message);

  // The three terminal shapes, in the order the SDK emits them.
  let kind: RetryAttemptEvent["kind"];
  if (/-\s*retrying,/i.test(message)) kind = "retrying";
  else if (/succeeded with status/i.test(message)) kind = "succeeded";
  else if (/no more retries left|cannot be retried|error;/i.test(message)) kind = "terminal-failure";
  else return null;

  return {
    atMs: Date.now(),
    kind,
    ...(status !== undefined ? { status: Number(status) } : {}),
    ...(isConnection ? { connectionError: true } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(attemptMs !== undefined && Number.isFinite(attemptMs) ? { attemptMs } : {}),
    ...(requestLogId !== undefined ? { requestLogId } : {}),
    ...(retryOfLogId !== undefined ? { retryOfLogId } : {}),
  };
}

/** The subset of the SDK's `Logger` shape we must satisfy. */
export interface SdkLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * Builds the logger handed to the OpenAI client.
 *
 * `error` and `warn` forward to the console exactly as they do today
 * — the SDK's default logger IS `console`, so swallowing them here
 * would LOSE existing diagnostics, which is a behaviour change in the
 * wrong direction. `debug` is a no-op and is never reached anyway: the
 * client is configured at `info`, and `makeLogFn` resolves anything
 * below the level to `noop` before it is called.
 *
 * `info` is the one that matters. It records the attempt into the
 * ambient request record (when there is one) and emits a single
 * machine-greppable line. Both halves are inside one try/catch,
 * because this function runs inside the SDK's request path and must
 * be incapable of failing the call it is describing.
 */
export function createRetryAttributionLogger(console_: Console = console): SdkLogger {
  return {
    error: (...args: unknown[]) => console_.error(...args),
    warn: (...args: unknown[]) => console_.warn(...args),
    debug: () => {},
    info: (...args: unknown[]) => {
      try {
        const message = typeof args[0] === "string" ? args[0] : "";
        const event = parseSdkLogLine(message);
        if (event === null) return;

        const attribution = storage.getStore();
        attribution?.events.push(event);

        // Only the exceptional lines are worth a console line of their
        // own. A successful first attempt is the overwhelmingly common
        // case and logging it would add one line per LLM request to
        // every call, for no diagnostic value.
        if (event.kind === "succeeded" && (attribution === undefined || attribution.events.length === 1)) {
          return;
        }

        // eslint-disable-next-line no-console
        console_.info(
          `[LLM-RETRY] kind=${event.kind}` +
            ` attempt=${attribution ? attribution.events.length : "?"}` +
            ` status=${event.status ?? (event.connectionError ? (event.timedOut ? "connection-timeout" : "connection-error") : "n/a")}` +
            ` attemptMs=${event.attemptMs ?? "n/a"}` +
            ` requestLogId=${event.requestLogId ?? "n/a"}` +
            ` retryOf=${event.retryOfLogId ?? "n/a"}` +
            ` | sdk="${message}"`,
        );
      } catch {
        // A telemetry failure must never become an LLM failure.
      }
    },
  };
}
