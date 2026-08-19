/**
 * load-guardrails.ts
 *
 * The limits on the limits.
 *
 * Every dispatcher limit is read from the environment by
 * `dispatch.config.ts`, through `optionalEnvNumber`, which accepts any
 * finite number. That is fine for the values it was written for and
 * dangerous for two of them:
 *
 *   - `CAMPAIGN_GLOBAL_CPS=0` does not mean "no calls per second". The
 *     token bucket treats a non-positive rate as NO RATE LIMIT AT ALL
 *     and returns immediately, so a zero — a plausible typo, and the
 *     natural way to write "unset" — removes the only control that
 *     paces call origination. Concurrency still bounds how many calls
 *     are live, but every one of them starts in the same instant.
 *
 *   - `CAMPAIGN_GLOBAL_MAX_CONCURRENCY=0` is the opposite failure: the
 *     semaphore never grants, so every lane spins on its poll interval
 *     forever and the campaign silently never dials.
 *
 * Neither was caught anywhere. So this module states the absolute
 * ceilings explicitly, and a run is REFUSED — not clamped — when the
 * configuration is outside them. Refused rather than clamped is the
 * convention the rest of this codebase already uses for limits
 * (`pilot-stage.ts`, the stage route): a typo that silently became a
 * working number is the mistake these controls exist to prevent.
 *
 * The absolute ceilings themselves are overridable, deliberately, and
 * deliberately awkward: raising `CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY` is
 * a visible decision in a deployment's environment, which is exactly
 * what raising the load a carrier sees should be.
 *
 * Pure. No database, no clock, no network. Nothing here places a call
 * or enables dialing.
 */

import { optionalEnvNumber } from "../../providers/shared/env";
import { CAMPAIGN_TTS_PROVIDERS } from "../domain/campaign-types";
import type { DispatchConfig } from "../config/dispatch.config";

export interface AbsoluteLimits {
  /** Live calls across every lane. */
  readonly maxConcurrency: number;
  /** New calls started per second, global or per lane. */
  readonly maxCallsPerSecond: number;
  /** Calls one run may place, whatever the ladder says. */
  readonly maxCallsPerRun: number;
  /** Seconds a single call may occupy a channel. */
  readonly maxCallSeconds: number;
  /** Attempts one contact may receive. */
  readonly maxRetryAttempts: number;
}

/**
 * The ceilings. These are not measured provider capabilities — the
 * Vobiz, Deepgram, OpenAI and TTS limits are still unconfirmed (see
 * `external-limits.ts`). They are the point past which a
 * misconfiguration stops looking like a typo and starts looking like a
 * deliberate decision that should have to be written down.
 */
export function getAbsoluteLimits(): AbsoluteLimits {
  return {
    maxConcurrency: optionalEnvNumber("CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY", 60),
    maxCallsPerSecond: optionalEnvNumber("CAMPAIGN_ABSOLUTE_MAX_CPS", 20),
    maxCallsPerRun: optionalEnvNumber("CAMPAIGN_ABSOLUTE_MAX_CALLS_PER_RUN", 25_000),
    maxCallSeconds: optionalEnvNumber("CAMPAIGN_ABSOLUTE_MAX_CALL_SECONDS", 900),
    maxRetryAttempts: optionalEnvNumber("CAMPAIGN_ABSOLUTE_MAX_RETRY_ATTEMPTS", 5),
  };
}

/**
 * What a finding is about, so the production-readiness report can file
 * each one under the right numbered check instead of matching on the
 * text of a message.
 */
export type LoadTopic =
  | "concurrency"
  | "cps"
  | "call-ceiling"
  | "call-duration"
  | "silence"
  | "ring-timeout"
  | "retry"
  | "claim-batch"
  | "poll-interval"
  | "lock";

export interface LoadIssue {
  readonly topic: LoadTopic;
  readonly severity: "blocker" | "warning";
  readonly message: string;
}

export interface LoadSafetyReport {
  readonly safe: boolean;
  readonly issues: readonly LoadIssue[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  /** The figures actually in force, for the readiness report to print. */
  readonly effective: {
    readonly globalMaxConcurrent: number;
    readonly globalCallsPerSecond: number;
    readonly laneMaxConcurrentTotal: number;
    readonly laneCallsPerSecondTotal: number;
    readonly callCeiling: number;
    readonly maxCallSeconds: number;
    readonly maxSilenceSeconds: number;
    readonly ringTimeoutSeconds: number;
    readonly retryMaxAttempts: number;
  };
  readonly absolute: AbsoluteLimits;
}

/** Findings for one topic, for a report that groups by check. */
export function issuesFor(
  report: LoadSafetyReport,
  ...topics: readonly LoadTopic[]
): readonly LoadIssue[] {
  return report.issues.filter((issue) => topics.includes(issue.topic));
}

/**
 * Checks one run's effective configuration against the absolute
 * ceilings and against the values that break the dispatcher outright.
 *
 * @param callCeiling The number the run will actually be given — the
 *   already-resolved smallest of the environment ceiling, the pilot
 *   ladder and any per-campaign ceiling. Passed in rather than
 *   recomputed so this cannot disagree with `describeCallCeiling`.
 */
export function checkLoadSafety(
  config: DispatchConfig,
  callCeiling: number,
  absolute: AbsoluteLimits = getAbsoluteLimits(),
): LoadSafetyReport {
  const issues: LoadIssue[] = [];
  const block = (topic: LoadTopic, message: string) =>
    issues.push({ topic, severity: "blocker", message });
  const warn = (topic: LoadTopic, message: string) =>
    issues.push({ topic, severity: "warning", message });

  const requirePositiveInteger = (
    topic: LoadTopic,
    name: string,
    value: number,
    because: string,
  ): void => {
    if (!Number.isInteger(value) || value < 1) {
      block(topic, `${name} is ${value}; it must be an integer of at least 1 — ${because}`);
    }
  };

  // ── The two values whose zero means "unlimited" or "never" ───────
  if (config.globalCallsPerSecond <= 0) {
    block(
      "cps",
      `CAMPAIGN_GLOBAL_CPS is ${config.globalCallsPerSecond}. A non-positive rate disables the ` +
        "token bucket entirely, so every call in the concurrency window would be originated at once. " +
        "Set a positive calls-per-second value.",
    );
  }
  requirePositiveInteger(
    "concurrency",
    "CAMPAIGN_GLOBAL_MAX_CONCURRENCY",
    config.globalMaxConcurrent,
    "a semaphore of 0 never grants, so the campaign would poll forever and never dial.",
  );

  for (const provider of CAMPAIGN_TTS_PROVIDERS) {
    const lane = config.lanes[provider];
    const key = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    if (lane.callsPerSecond <= 0) {
      block(
        "cps",
        `CAMPAIGN_CPS_${key} is ${lane.callsPerSecond}. A non-positive per-lane rate disables that ` +
          "lane's pacing entirely. Set a positive value.",
      );
    }
    requirePositiveInteger(
      "concurrency",
      `CAMPAIGN_CONCURRENCY_${key}`,
      lane.maxConcurrent,
      `the ${provider} lane would never start a call.`,
    );
    if (lane.maxConcurrent > absolute.maxConcurrency) {
      block(
        "concurrency",
        `CAMPAIGN_CONCURRENCY_${key} is ${lane.maxConcurrent}, above the absolute ceiling of ` +
          `${absolute.maxConcurrency}. Raise CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY deliberately if that is intended.`,
      );
    }
    if (lane.callsPerSecond > absolute.maxCallsPerSecond) {
      block(
        "cps",
        `CAMPAIGN_CPS_${key} is ${lane.callsPerSecond}, above the absolute ceiling of ` +
          `${absolute.maxCallsPerSecond}. Raise CAMPAIGN_ABSOLUTE_MAX_CPS deliberately if that is intended.`,
      );
    }
  }

  // ── The absolute ceilings ────────────────────────────────────────
  if (config.globalMaxConcurrent > absolute.maxConcurrency) {
    block(
      "concurrency",
      `CAMPAIGN_GLOBAL_MAX_CONCURRENCY is ${config.globalMaxConcurrent}, above the absolute ceiling ` +
        `of ${absolute.maxConcurrency}. Raise CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY deliberately if that is intended.`,
    );
  }
  if (config.globalCallsPerSecond > absolute.maxCallsPerSecond) {
    block(
      "cps",
      `CAMPAIGN_GLOBAL_CPS is ${config.globalCallsPerSecond}, above the absolute ceiling of ` +
        `${absolute.maxCallsPerSecond}. Raise CAMPAIGN_ABSOLUTE_MAX_CPS deliberately if that is intended.`,
    );
  }

  // ── The call ceiling ─────────────────────────────────────────────
  requirePositiveInteger(
    "call-ceiling",
    "the effective call ceiling",
    callCeiling,
    "a run permitted zero calls is a configuration error, not a dry run; CAMPAIGN_DIALING_ENABLED is the control for that.",
  );
  if (callCeiling > absolute.maxCallsPerRun) {
    block(
      "call-ceiling",
      `The effective call ceiling is ${callCeiling}, above the absolute ceiling of ` +
        `${absolute.maxCallsPerRun}. Raise CAMPAIGN_ABSOLUTE_MAX_CALLS_PER_RUN deliberately if that is intended.`,
    );
  }

  // ── Watchdog bounds. Each one ends a call; a zero ends it instantly ──
  requirePositiveInteger(
    "call-duration",
    "CAMPAIGN_MAX_CALL_SECONDS",
    config.maxCallSeconds,
    "the watchdog would end every call the moment it was answered.",
  );
  requirePositiveInteger(
    "silence",
    "CAMPAIGN_MAX_SILENCE_SECONDS",
    config.maxSilenceSeconds,
    "the watchdog would end every call before the first word.",
  );
  requirePositiveInteger(
    "ring-timeout",
    "CAMPAIGN_RING_TIMEOUT_SECONDS",
    config.ringTimeoutSeconds,
    "every call would be recorded as NO_ANSWER before it could ring.",
  );
  if (config.maxCallSeconds > absolute.maxCallSeconds) {
    block(
      "call-duration",
      `CAMPAIGN_MAX_CALL_SECONDS is ${config.maxCallSeconds}, above the absolute ceiling of ` +
        `${absolute.maxCallSeconds}. A call that can run that long holds a channel, a Deepgram socket ` +
        "and an audio pump for the whole time. Raise CAMPAIGN_ABSOLUTE_MAX_CALL_SECONDS deliberately if that is intended.",
    );
  }

  // ── Retry policy ─────────────────────────────────────────────────
  requirePositiveInteger(
    "retry",
    "CAMPAIGN_RETRY_MAX_ATTEMPTS",
    config.retry.maxAttempts,
    "no contact would ever be retried, and a transient carrier outage would discard the whole list.",
  );
  if (config.retry.maxAttempts > absolute.maxRetryAttempts) {
    block(
      "retry",
      `CAMPAIGN_RETRY_MAX_ATTEMPTS is ${config.retry.maxAttempts}, above the absolute ceiling of ` +
        `${absolute.maxRetryAttempts}. Each attempt is another real call to the same person.`,
    );
  }
  if (config.retry.temporaryBackoffMinutes.length === 0) {
    warn(
      "retry",
      "CAMPAIGN_RETRY_TEMPORARY_BACKOFF_MINUTES parsed to an empty list, so TEMPORARY and SYSTEM " +
        "failures will never be retried. A provider blip would drop those contacts for the run.",
    );
  }

  requirePositiveInteger(
    "claim-batch",
    "CAMPAIGN_CLAIM_BATCH_SIZE",
    config.claimBatchSize,
    "no lane could ever claim a contact.",
  );

  // ── Warnings: legal configurations worth seeing before a launch ──
  const laneConcurrencyTotal = CAMPAIGN_TTS_PROVIDERS.reduce(
    (sum, provider) => sum + config.lanes[provider].maxConcurrent,
    0,
  );
  const laneCpsTotal = CAMPAIGN_TTS_PROVIDERS.reduce(
    (sum, provider) => sum + config.lanes[provider].callsPerSecond,
    0,
  );

  if (config.globalMaxConcurrent > laneConcurrencyTotal) {
    warn(
      "concurrency",
      `CAMPAIGN_GLOBAL_MAX_CONCURRENCY is ${config.globalMaxConcurrent} but the three lanes total ` +
        `${laneConcurrencyTotal}; the global cap can never bind. Throughput is set by the lanes.`,
    );
  }
  if (config.globalCallsPerSecond > laneCpsTotal) {
    warn(
      "cps",
      `CAMPAIGN_GLOBAL_CPS is ${config.globalCallsPerSecond} but the three lanes total ${laneCpsTotal} ` +
        "calls per second; the global rate can never bind.",
    );
  }
  if (config.pollIntervalMs < 250) {
    warn(
      "poll-interval",
      `CAMPAIGN_POLL_INTERVAL_MS is ${config.pollIntervalMs}. Each lane runs a claim query on that ` +
        "interval; below ~250ms the three lanes spend the campaign querying the database.",
    );
  }
  if (config.maxSilenceSeconds >= config.maxCallSeconds) {
    warn(
      "silence",
      `CAMPAIGN_MAX_SILENCE_SECONDS (${config.maxSilenceSeconds}) is not below ` +
        `CAMPAIGN_MAX_CALL_SECONDS (${config.maxCallSeconds}), so the silence watchdog can never fire first.`,
    );
  }
  if (config.lockStaleSeconds < 45) {
    warn(
      "lock",
      `CAMPAIGN_LOCK_STALE_SECONDS is ${config.lockStaleSeconds}. The dispatcher heartbeats every 15s; ` +
        "a stale window that tight lets a second dispatcher take a lock a live one still holds.",
    );
  }

  const blockers = issues.filter((issue) => issue.severity === "blocker").map((issue) => issue.message);
  const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);

  return {
    safe: blockers.length === 0,
    issues,
    blockers,
    warnings,
    effective: {
      globalMaxConcurrent: config.globalMaxConcurrent,
      globalCallsPerSecond: config.globalCallsPerSecond,
      laneMaxConcurrentTotal: laneConcurrencyTotal,
      laneCallsPerSecondTotal: laneCpsTotal,
      callCeiling,
      maxCallSeconds: config.maxCallSeconds,
      maxSilenceSeconds: config.maxSilenceSeconds,
      ringTimeoutSeconds: config.ringTimeoutSeconds,
      retryMaxAttempts: config.retry.maxAttempts,
    },
    absolute,
  };
}

/**
 * Theoretical throughput of a configuration, so a capacity claim is
 * arithmetic rather than an opinion.
 *
 * The binding limit is whichever is lower: how fast calls may START
 * (CPS), or how many may be LIVE at once divided by how long each one
 * lasts. Both are computed and the smaller is reported, along with
 * which one bound — a campaign limited by concurrency and one limited
 * by CPS need different fixes.
 */
export interface ThroughputEstimate {
  readonly callsPerHourByCps: number;
  readonly callsPerHourByConcurrency: number;
  readonly callsPerHour: number;
  readonly boundBy: "cps" | "concurrency";
  readonly effectiveConcurrency: number;
  readonly effectiveCps: number;
  readonly assumedCallSeconds: number;
  /** Volume -> hours at the rate above. */
  readonly hoursFor: Readonly<Record<string, number>>;
}

/**
 * @param averageCallSeconds Mean channel-occupancy seconds per
 *   attempt: ring time plus talk time plus teardown. This is an INPUT,
 *   not a measurement — nothing in this repository has observed it yet.
 */
export function estimateThroughput(
  config: DispatchConfig,
  averageCallSeconds: number,
  volumes: readonly number[] = [10, 50, 100, 500, 2_000, 10_000],
): ThroughputEstimate {
  const laneConcurrency = CAMPAIGN_TTS_PROVIDERS.reduce(
    (sum, provider) => sum + config.lanes[provider].maxConcurrent,
    0,
  );
  const laneCps = CAMPAIGN_TTS_PROVIDERS.reduce(
    (sum, provider) => sum + config.lanes[provider].callsPerSecond,
    0,
  );

  const effectiveConcurrency = Math.min(config.globalMaxConcurrent, laneConcurrency);
  const effectiveCps = Math.min(
    config.globalCallsPerSecond > 0 ? config.globalCallsPerSecond : Number.POSITIVE_INFINITY,
    laneCps > 0 ? laneCps : Number.POSITIVE_INFINITY,
  );

  const callsPerHourByCps = Number.isFinite(effectiveCps)
    ? effectiveCps * 3_600
    : Number.POSITIVE_INFINITY;
  const callsPerHourByConcurrency =
    averageCallSeconds > 0 ? (effectiveConcurrency * 3_600) / averageCallSeconds : 0;

  const callsPerHour = Math.min(callsPerHourByCps, callsPerHourByConcurrency);
  const hoursFor: Record<string, number> = {};
  for (const volume of volumes) {
    hoursFor[String(volume)] = callsPerHour > 0 ? volume / callsPerHour : Number.POSITIVE_INFINITY;
  }

  return {
    callsPerHourByCps,
    callsPerHourByConcurrency,
    callsPerHour,
    boundBy: callsPerHourByCps <= callsPerHourByConcurrency ? "cps" : "concurrency",
    effectiveConcurrency,
    effectiveCps,
    assumedCallSeconds: averageCallSeconds,
    hoursFor,
  };
}
