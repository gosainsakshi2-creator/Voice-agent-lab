/**
 * dispatch.config.ts
 *
 * Every dispatcher limit, read from the environment. Nothing here is a
 * measured provider capability — the real Vobiz, Deepgram, OpenAI and
 * TTS limits are still unconfirmed, so the defaults are deliberately
 * conservative and are meant to be raised against observed behaviour
 * during the pilot, not guessed upward now.
 */

import { optionalEnv, optionalEnvNumber } from "../../providers/shared/env";
import { CAMPAIGN_TTS_PROVIDERS, type CampaignTtsProvider } from "../domain/campaign-types";

/**
 * The Vobiz account's CONFIRMED ceiling on simultaneous live calls.
 *
 * No longer a guess, which is why it is now the default rather than a
 * comment. The previous defaults — 15 global, 5 per lane — let the
 * dispatcher hold five times the carrier's allowance open at once with
 * nothing in this repository or in `.env.local` bringing it back down,
 * so the ceiling was enforced only by Vobiz refusing or tearing down
 * the calls above it. That is a carrier-side hangup on a live
 * conversation, and it is indistinguishable at this end from any other
 * random disconnect.
 *
 * The global semaphore is shared by all three lanes (see
 * `LaneGate.acquire`, which takes it before the lane's own), so this
 * one number bounds the total live calls whatever the lanes are set to.
 * Both remain env-overridable: raising them is a deliberate act, and
 * `checkLoadSafety` still holds every value to the absolute ceiling.
 */
const CARRIER_MAX_CONCURRENT_CALLS = 3;

export interface LaneLimits {
  readonly maxConcurrent: number;
  readonly callsPerSecond: number;
}

export interface DispatchConfig {
  readonly dialingEnabled: boolean;
  readonly globalMaxConcurrent: number;
  readonly globalCallsPerSecond: number;
  readonly lanes: Readonly<Record<CampaignTtsProvider, LaneLimits>>;
  readonly ringTimeoutSeconds: number;
  readonly maxCallSeconds: number;
  readonly maxSilenceSeconds: number;
  readonly claimBatchSize: number;
  readonly pollIntervalMs: number;
  readonly stageMaxCalls: number;
  readonly retry: RetryConfig;
  readonly dispatcherId: string;
  readonly lockStaleSeconds: number;
}

export interface RetryConfig {
  /**
   * The attempt ceiling for every campaign type that has no more
   * specific one. Unchanged, and still what the telephony-only retry
   * path uses.
   */
  readonly maxAttempts: number;
  readonly noAnswerDelayMinutes: number;
  readonly busyDelayMinutes: number;
  readonly temporaryBackoffMinutes: readonly number[];
  readonly retryOnRejected: boolean;
  readonly retryOnUserHangup: boolean;

  // ── Registration-only policy (Phase 7) ──────────────────────────
  // A registration contact is retryable until the person actually
  // decides, so the policy that bounds that lives here as data rather
  // than as conditionals in the planner. Reminder campaigns do not
  // read any of these.

  /** Total attempts allowed per REGISTRATION contact, definitive outcomes aside. */
  readonly registrationMaxAttempts: number;
  /** Wait after the person asked to be called at another time. */
  readonly callbackDelayMinutes: number;
  /** Wait after a call that connected and decided nothing. */
  readonly unresolvedDelayMinutes: number;
  /**
   * Whether an UNRESOLVED registration call (unclear, interrupted,
   * positive-but-not-committed, no engagement) is redialled at all.
   * On by default: for a registration campaign, "we never found out"
   * is a reason to call back, not a result.
   */
  readonly retryOnUnresolvedRegistration: boolean;
}

/** Env key suffix for a provider id: "smallest-ai" -> "SMALLEST_AI". */
function envKey(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function getDispatchConfig(): DispatchConfig {
  const lanes = Object.fromEntries(
    CAMPAIGN_TTS_PROVIDERS.map((provider) => [
      provider,
      {
        maxConcurrent: optionalEnvNumber(`CAMPAIGN_CONCURRENCY_${envKey(provider)}`, CARRIER_MAX_CONCURRENT_CALLS),
        callsPerSecond: optionalEnvNumber(`CAMPAIGN_CPS_${envKey(provider)}`, 1),
      },
    ]),
  ) as Record<CampaignTtsProvider, LaneLimits>;

  return {
    // THE KILL SWITCH. Off by default: the dispatcher can be built,
    // started and rehearsed without any code path able to place a call.
    dialingEnabled: optionalEnv("CAMPAIGN_DIALING_ENABLED", "false") === "true",
    globalMaxConcurrent: optionalEnvNumber("CAMPAIGN_GLOBAL_MAX_CONCURRENCY", CARRIER_MAX_CONCURRENT_CALLS),
    globalCallsPerSecond: optionalEnvNumber("CAMPAIGN_GLOBAL_CPS", 3),
    lanes,
    ringTimeoutSeconds: optionalEnvNumber("CAMPAIGN_RING_TIMEOUT_SECONDS", 35),
    maxCallSeconds: optionalEnvNumber("CAMPAIGN_MAX_CALL_SECONDS", 180),
    maxSilenceSeconds: optionalEnvNumber("CAMPAIGN_MAX_SILENCE_SECONDS", 20),
    claimBatchSize: optionalEnvNumber("CAMPAIGN_CLAIM_BATCH_SIZE", 5),
    pollIntervalMs: optionalEnvNumber("CAMPAIGN_POLL_INTERVAL_MS", 1000),
    // Pilot ladder ceiling for a single run. 10 by default so the first
    // real run cannot become a thousand calls by accident.
    stageMaxCalls: optionalEnvNumber("CAMPAIGN_STAGE_MAX_CALLS", 10),
    retry: {
      maxAttempts: optionalEnvNumber("CAMPAIGN_RETRY_MAX_ATTEMPTS", 3),
      noAnswerDelayMinutes: optionalEnvNumber("CAMPAIGN_RETRY_NO_ANSWER_DELAY_MINUTES", 30),
      busyDelayMinutes: optionalEnvNumber("CAMPAIGN_RETRY_BUSY_DELAY_MINUTES", 10),
      temporaryBackoffMinutes: optionalEnv("CAMPAIGN_RETRY_TEMPORARY_BACKOFF_MINUTES", "1,4,16")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0),
      retryOnRejected: optionalEnv("CAMPAIGN_RETRY_ON_REJECTED", "false") === "true",
      retryOnUserHangup: optionalEnv("CAMPAIGN_RETRY_ON_USER_HANGUP", "false") === "true",
      // Defaults to the existing ceiling, so registration behaviour
      // changes in KIND (what is retryable) and not in VOLUME (how
      // many times) unless this is set deliberately.
      registrationMaxAttempts: optionalEnvNumber(
        "CAMPAIGN_RETRY_REGISTRATION_MAX_ATTEMPTS",
        optionalEnvNumber("CAMPAIGN_RETRY_MAX_ATTEMPTS", 3),
      ),
      callbackDelayMinutes: optionalEnvNumber("CAMPAIGN_RETRY_CALLBACK_DELAY_MINUTES", 30),
      unresolvedDelayMinutes: optionalEnvNumber("CAMPAIGN_RETRY_UNRESOLVED_DELAY_MINUTES", 30),
      retryOnUnresolvedRegistration:
        optionalEnv("CAMPAIGN_RETRY_ON_UNRESOLVED_REGISTRATION", "true") === "true",
    },
    dispatcherId: optionalEnv("CAMPAIGN_DISPATCHER_ID", `pid-${process.pid}`),
    lockStaleSeconds: optionalEnvNumber("CAMPAIGN_LOCK_STALE_SECONDS", 90),
  };
}
