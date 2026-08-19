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
  readonly maxAttempts: number;
  readonly noAnswerDelayMinutes: number;
  readonly busyDelayMinutes: number;
  readonly temporaryBackoffMinutes: readonly number[];
  readonly retryOnRejected: boolean;
  readonly retryOnUserHangup: boolean;
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
        maxConcurrent: optionalEnvNumber(`CAMPAIGN_CONCURRENCY_${envKey(provider)}`, 5),
        callsPerSecond: optionalEnvNumber(`CAMPAIGN_CPS_${envKey(provider)}`, 1),
      },
    ]),
  ) as Record<CampaignTtsProvider, LaneLimits>;

  return {
    // THE KILL SWITCH. Off by default: the dispatcher can be built,
    // started and rehearsed without any code path able to place a call.
    dialingEnabled: optionalEnv("CAMPAIGN_DIALING_ENABLED", "false") === "true",
    globalMaxConcurrent: optionalEnvNumber("CAMPAIGN_GLOBAL_MAX_CONCURRENCY", 15),
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
    },
    dispatcherId: optionalEnv("CAMPAIGN_DISPATCHER_ID", `pid-${process.pid}`),
    lockStaleSeconds: optionalEnvNumber("CAMPAIGN_LOCK_STALE_SECONDS", 90),
  };
}
