/**
 * health.ts (providers/shared)
 *
 * Uniform helper for building `ProviderHealthStatus` results and for
 * timing provider operations (`latencyMs`, `CompletionResult`, etc.).
 * Every adapter's `checkHealth()` funnels through `probeHealth` so
 * the shape and timing semantics are identical regardless of vendor,
 * matching the "Generic result envelope" contract documented on
 * `ProviderHealthStatus`.
 */

import type { ProviderIdentifier, ProviderHealthStatus } from "../../types/provider.types";

/**
 * Run `operation` and time it, producing a normalized
 * `ProviderHealthStatus` whether the probe succeeds or throws.
 * Adapters supply a lightweight, side-effect-free (or idempotent)
 * operation such as "fetch account details" / "list models".
 */
export async function probeHealth(
  identifier: ProviderIdentifier,
  operation: () => Promise<void>,
): Promise<ProviderHealthStatus> {
  const startedAt = Date.now();
  try {
    await operation();
    return {
      identifier,
      isHealthy: true,
      checkedAt: new Date(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      identifier,
      isHealthy: false,
      checkedAt: new Date(),
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Time an arbitrary async operation, returning both its result and
 * the elapsed milliseconds. Used by LLM adapters to populate
 * `CompletionResult.latencyMs` without duplicating `Date.now()`
 * bookkeeping in every implementation.
 */
export async function timed<T>(operation: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const startedAt = Date.now();
  const result = await operation();
  return { result, latencyMs: Date.now() - startedAt };
}
