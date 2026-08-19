/**
 * external-limits.ts
 *
 * Every limit that lives outside this repository and therefore cannot
 * be answered from inside it.
 *
 * The rule this file exists to enforce: a figure is either DERIVED FROM
 * THE REPOSITORY — a value in the code, an environment variable, a rate
 * the cost estimator actually applies — or it is marked
 * NEEDS_EXTERNAL_CONFIRMATION. There is no third category, and nothing
 * here invents a carrier's concurrency, a vendor's rate limit or a
 * price that is not already used by `cost-estimator.ts`.
 *
 * The prices below are read by CALLING the estimator's own exported
 * functions with unit inputs, rather than by restating its constants.
 * That way "the rate our estimator uses" cannot drift from the rate our
 * estimator uses. Several of those rates are list-price placeholders and
 * say so in `cost-estimator.ts`; the ones that matter commercially are
 * flagged here as needing confirmation against a contract.
 *
 * `blocksScaling: true` marks a limit that must be confirmed before the
 * campaign goes past the pilot rungs. Those are the entries behind the
 * standing external-limits blocker in `preflight.ts`.
 *
 * Read-only. Nothing here contacts a vendor.
 */

import {
  estimateLlmCost,
  estimateSttCost,
  estimateTelephonyCost,
  estimateTtsCost,
} from "../core/session/cost-estimator";
import { optionalEnv } from "../providers/shared/env";

export const EXTERNAL_VENDORS = [
  "vobiz",
  "deepgram",
  "openai",
  "cartesia",
  "sarvam",
  "smallest-ai",
] as const;

export type ExternalVendor = (typeof EXTERNAL_VENDORS)[number];

export type LimitStatus = "FROM_REPOSITORY" | "NEEDS_EXTERNAL_CONFIRMATION";

export interface ExternalLimit {
  readonly id: string;
  readonly vendor: ExternalVendor;
  /** What has to be known. */
  readonly limit: string;
  readonly status: LimitStatus;
  /**
   * The repository's answer, when it has one. `null` whenever the
   * status is NEEDS_EXTERNAL_CONFIRMATION — a value and a "we do not
   * know" can never appear together.
   */
  readonly repositoryValue: string | null;
  /** Where the repository fact comes from, so the claim is checkable. */
  readonly source?: string;
  /** Why the campaign cares. */
  readonly matters: string;
  /** Where to get the number. */
  readonly confirmWith?: string;
  /** True when scaling past the pilot without this is a guess. */
  readonly blocksScaling: boolean;
}

/** A price per unit, formatted for a report, taken from the estimator itself. */
function usd(amount: number, unit: string): string {
  return `$${amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} per ${unit} (as applied by cost-estimator.ts)`;
}

function mask(value: string | undefined): string {
  if (!value) return "not set";
  return value.length <= 4 ? "****" : `${value.slice(0, Math.min(6, value.length - 3))}***${value.slice(-2)}`;
}

/**
 * The full register. Assembled at call time so environment-derived
 * entries reflect the process that is actually running.
 */
export function getExternalLimits(): readonly ExternalLimit[] {
  const limits: ExternalLimit[] = [];

  // ── VOBIZ ─────────────────────────────────────────────────────────
  limits.push(
    {
      id: "vobiz.api",
      vendor: "vobiz",
      limit: "API surface this integration actually uses",
      status: "FROM_REPOSITORY",
      repositoryValue:
        `POST {base}/api/v1/Account/{auth_id}/Call/ with {from,to,answer_url,answer_method}; ` +
        `DELETE {base}/api/v1/Account/{auth_id}/Call/{call_uuid}/; GET {base}/api/v1/auth/me for health. ` +
        `base = ${optionalEnv("VOBIZ_API_BASE_URL", "https://api.vobiz.ai")}`,
      source: "src/providers/telephony/vobiz.provider.ts",
      matters:
        "These three requests are the whole telephony surface. Any capability not reachable through them does not exist for this campaign today.",
      blocksScaling: false,
    },
    {
      id: "vobiz.max_concurrent_channels",
      vendor: "vobiz",
      limit: "Maximum simultaneous outbound calls / channels on the account",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "CAMPAIGN_GLOBAL_MAX_CONCURRENCY must sit below it. Above it, calls fail at origination and every failure is charged to the retry budget.",
      confirmWith: "Vobiz account manager / console channel allocation.",
      blocksScaling: true,
    },
    {
      id: "vobiz.cps",
      vendor: "vobiz",
      limit: "Permitted call attempts per second (origination rate)",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "CAMPAIGN_GLOBAL_CPS is a self-imposed guess until this is known. Exceeding a carrier's CPS is a common cause of silent 4xx bursts and temporary blocks.",
      confirmWith: "Vobiz account manager.",
      blocksScaling: true,
    },
    {
      id: "vobiz.did_limits",
      vendor: "vobiz",
      limit: "Per-DID daily call limits, and whether a caller ID can be flagged for volume",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "One number is configured for every call. If a DID has a daily cap or a spam-flag threshold, a 2,000-call day on a single caller ID hits it.",
      confirmWith: "Vobiz account manager; also the terminating operators' policy for the destination country.",
      blocksScaling: true,
    },
    {
      id: "vobiz.did_pool",
      vendor: "vobiz",
      limit: "Whether multiple DIDs are available on the account, and can be rotated per call",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue:
        null,
      matters:
        "Rotation cannot be implemented against an unknown pool. The code path that would use it is a single `from` field, so the change is small — the missing part is the numbers and whether Vobiz permits rotating them.",
      confirmWith: "Vobiz console (Numbers) and account manager.",
      blocksScaling: true,
    },
    {
      id: "vobiz.from_number",
      vendor: "vobiz",
      limit: "Caller ID actually configured",
      status: "FROM_REPOSITORY",
      repositoryValue: `VOBIZ_FROM_NUMBER = ${mask(process.env["VOBIZ_FROM_NUMBER"])} (single number, no rotation implemented)`,
      source: "src/providers/telephony/vobiz.provider.ts loadEnvConfig()",
      matters: "Every call in every lane presents this one number.",
      blocksScaling: false,
    },
    {
      id: "vobiz.amd",
      vendor: "vobiz",
      limit: "Answering-machine / voicemail detection support",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "Without it a voicemail greeting is indistinguishable from a human answer: the media stream opens, the pipeline starts talking, and the outcome is classified from a transcript of an answering machine.",
      confirmWith:
        "Vobiz API docs / account manager: is there a machine-detection parameter on the Call API, and does it report the verdict back?",
      blocksScaling: true,
    },
    {
      id: "vobiz.status_callback",
      vendor: "vobiz",
      limit: "Call-status callback (ringing / answered / busy / no-answer / rejected) and hangup cause",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue:
        null,
      matters:
        "The Call request this code sends carries answer_url only. No status callback URL is sent and no status webhook route exists, so NO_ANSWER and BUSY are inferred from our own timers and recorded as status_source='inferred'.",
      confirmWith: "Vobiz API docs: status callback parameter name, event list, and hangup-cause field.",
      blocksScaling: true,
    },
    {
      id: "vobiz.cdr",
      vendor: "vobiz",
      limit: "CDR / billing API for reconciliation",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "Our telephony cost is an estimate at a placeholder per-minute rate. Reconciling a 2,000-call day needs the carrier's own record of connected minutes.",
      confirmWith: "Vobiz console (billing/CDR export) or CDR API.",
      blocksScaling: false,
    },
    {
      id: "vobiz.campaign_restrictions",
      vendor: "vobiz",
      limit: "Outbound campaign restrictions: allowed hours, consent requirements, prohibited content, KYC on the DID",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "The calling window in this repository is our own default (10:00-20:00 Asia/Kolkata). It is not derived from any carrier or regulator document.",
      confirmWith: "Vobiz terms for outbound campaigns; the destination country's telemarketing regulations.",
      blocksScaling: true,
    },
    {
      id: "vobiz.telephony_rate",
      vendor: "vobiz",
      limit: "Contracted per-minute voice rate",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters: `The estimator currently prices Vobiz at ${usd(estimateTelephonyCost("vobiz", 60), "connected minute")}, which cost-estimator.ts states is an order-of-magnitude list-price placeholder.`,
      confirmWith: "Vobiz contract / invoice.",
      blocksScaling: false,
    },
  );

  // ── DEEPGRAM ──────────────────────────────────────────────────────
  limits.push(
    {
      id: "deepgram.model",
      vendor: "deepgram",
      limit: "Model in use",
      status: "FROM_REPOSITORY",
      repositoryValue: `DEEPGRAM_MODEL = ${optionalEnv("DEEPGRAM_MODEL", "(unset)")}`,
      source: ".env / src/providers/speech-to-text/deepgram.provider.ts",
      matters: "Concurrency and rate limits are per-model on some plans.",
      blocksScaling: false,
    },
    {
      id: "deepgram.sockets_per_call",
      vendor: "deepgram",
      limit: "Streaming connections this campaign will open",
      status: "FROM_REPOSITORY",
      repositoryValue:
        "One live streaming connection per answered call, so the peak equals the effective global concurrency (not the campaign size).",
      source: "src/campaign/dispatch/concurrency.ts (semaphore bounds live calls)",
      matters: "This is the figure to compare against Deepgram's own concurrency allowance.",
      blocksScaling: false,
    },
    {
      id: "deepgram.max_concurrent_streams",
      vendor: "deepgram",
      limit: "Account limit on concurrent streaming connections",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "Exceeding it fails the STT socket after the call is already answered — the worst possible moment, because the person has picked up and is charged for.",
      confirmWith: "Deepgram console (plan limits) / support.",
      blocksScaling: true,
    },
    {
      id: "deepgram.rate_and_minutes",
      vendor: "deepgram",
      limit: "Request rate limit and any monthly minute allowance on the plan",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters: "A 2,000-call campaign at ~2 minutes each is ~4,000 STT minutes in a day.",
      confirmWith: "Deepgram console (usage and plan).",
      blocksScaling: true,
    },
    {
      id: "deepgram.price",
      vendor: "deepgram",
      limit: "Price used by our estimator",
      status: "FROM_REPOSITORY",
      repositoryValue: usd(estimateSttCost("deepgram", 60), "audio minute"),
      source: "src/core/session/cost-estimator.ts",
      matters: "Every STT cost figure in the results report scales from this one number.",
      blocksScaling: false,
    },
  );

  // ── OPENAI ────────────────────────────────────────────────────────
  limits.push(
    {
      id: "openai.model",
      vendor: "openai",
      limit: "Model in use",
      status: "FROM_REPOSITORY",
      repositoryValue: `OPENAI_MODEL = ${optionalEnv("OPENAI_MODEL", "(unset)")}`,
      source: ".env / src/providers/language-model/openai-gpt.provider.ts",
      matters: "RPM and TPM are per-model and per-tier.",
      blocksScaling: false,
    },
    {
      id: "openai.requests_per_call",
      vendor: "openai",
      limit: "Requests this campaign will generate",
      status: "FROM_REPOSITORY",
      repositoryValue:
        "One streaming completion per conversation turn, so peak concurrent requests is bounded by global concurrency and total requests by turns-per-call times calls.",
      source: "src/core/session/conversation-pipeline.ts (one LLM request per turn)",
      matters: "The figure to compare against RPM; TPM needs the prompt size, which grows with rolling history.",
      blocksScaling: false,
    },
    {
      id: "openai.rpm_tpm",
      vendor: "openai",
      limit: "RPM, TPM and concurrency for the configured model on this account's tier",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "A 429 mid-conversation is a dead air gap on a live call. classifyError maps it to TEMPORARY, which schedules a retry — a second real call to the same person because of a rate limit.",
      confirmWith: "OpenAI dashboard: Settings > Limits, for the exact model id.",
      blocksScaling: true,
    },
    {
      id: "openai.price",
      vendor: "openai",
      limit: "Price used by our estimator",
      status: "FROM_REPOSITORY",
      repositoryValue:
        `${usd(estimateLlmCost("gpt-5.1", 1_000_000, 0), "1M input tokens")}; ` +
        `${usd(estimateLlmCost("gpt-5.1", 0, 1_000_000), "1M output tokens")}`,
      source: "src/core/session/cost-estimator.ts",
      matters:
        "Token counts are estimated from characters — neither adapter reports real usage — so LLM cost is an approximation on both sides.",
      blocksScaling: false,
    },
  );

  // ── CARTESIA ──────────────────────────────────────────────────────
  limits.push(
    {
      id: "cartesia.model",
      vendor: "cartesia",
      limit: "Model and sample rate in use",
      status: "FROM_REPOSITORY",
      repositoryValue:
        `CARTESIA_MODEL_ID = ${optionalEnv("CARTESIA_MODEL_ID", "(unset)")}, ` +
        `CARTESIA_SAMPLE_RATE_HZ = ${optionalEnv("CARTESIA_SAMPLE_RATE_HZ", "(unset)")}`,
      source: ".env / src/providers/text-to-speech/cartesia.provider.ts",
      matters: "Rate limits are often per-model.",
      blocksScaling: false,
    },
    {
      id: "cartesia.limits",
      vendor: "cartesia",
      limit: "Concurrent synthesis requests and request rate limit on the plan",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters:
        "The Cartesia lane's concurrency is a guess until this is known. A throttled TTS response is dead air mid-sentence.",
      confirmWith: "Cartesia dashboard (plan limits) / support.",
      blocksScaling: true,
    },
    {
      id: "cartesia.price",
      vendor: "cartesia",
      limit: "Price used by our estimator",
      status: "FROM_REPOSITORY",
      repositoryValue: usd(estimateTtsCost("cartesia", 0, 60), "minute of GENERATED audio"),
      source: "src/core/session/cost-estimator.ts",
      matters:
        "Cartesia is billed on generated audio duration, not characters, so its cost is not comparable to the other two lanes per character.",
      blocksScaling: false,
    },
  );

  // ── SARVAM ────────────────────────────────────────────────────────
  limits.push(
    {
      id: "sarvam.model",
      vendor: "sarvam",
      limit: "Model, endpoint and sample rate in use",
      status: "FROM_REPOSITORY",
      repositoryValue:
        `SARVAM_TTS_MODEL = ${optionalEnv("SARVAM_TTS_MODEL", "(unset)")}, ` +
        `SARVAM_BASE_URL = ${optionalEnv("SARVAM_BASE_URL", "(unset)")}, ` +
        `SARVAM_SAMPLE_RATE_HZ = ${optionalEnv("SARVAM_SAMPLE_RATE_HZ", "(unset)")}`,
      source: ".env / src/providers/text-to-speech/sarvam.provider.ts",
      matters: "Rate limits are per-model and per-plan.",
      blocksScaling: false,
    },
    {
      id: "sarvam.limits",
      vendor: "sarvam",
      limit: "Concurrent request and rate limits on the plan",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters: "The Sarvam lane's concurrency is a guess until this is known.",
      confirmWith: "Sarvam dashboard / support.",
      blocksScaling: true,
    },
    {
      id: "sarvam.price",
      vendor: "sarvam",
      limit: "Price used by our estimator",
      status: "FROM_REPOSITORY",
      repositoryValue: `${usd(estimateTtsCost("sarvam", 1_000), "1,000 characters")} — converted from the published rupee rate at a fixed INR/USD divisor in cost-estimator.ts`,
      source: "src/core/session/cost-estimator.ts",
      matters:
        "The conversion rate is a constant in the repository, so Sarvam's dollar cost moves only when that constant is edited.",
      confirmWith: "Sarvam pricing page, and the INR/USD rate you want to compare at.",
      blocksScaling: false,
    },
  );

  // ── SMALLEST AI ───────────────────────────────────────────────────
  limits.push(
    {
      id: "smallest-ai.endpoint",
      vendor: "smallest-ai",
      limit: "Endpoint and sample rate in use",
      status: "FROM_REPOSITORY",
      repositoryValue:
        `SMALLEST_AI_BASE_URL = ${optionalEnv("SMALLEST_AI_BASE_URL", "(unset)")}, ` +
        `SMALLEST_AI_SAMPLE_RATE_HZ = ${optionalEnv("SMALLEST_AI_SAMPLE_RATE_HZ", "(unset)")}`,
      source: ".env / src/providers/text-to-speech/smallest-ai.provider.ts",
      matters: "Rate limits are per-plan.",
      blocksScaling: false,
    },
    {
      id: "smallest-ai.limits",
      vendor: "smallest-ai",
      limit: "Concurrent request and rate limits on the plan",
      status: "NEEDS_EXTERNAL_CONFIRMATION",
      repositoryValue: null,
      matters: "The Smallest AI lane's concurrency is a guess until this is known.",
      confirmWith: "Smallest AI dashboard / support.",
      blocksScaling: true,
    },
    {
      id: "smallest-ai.price",
      vendor: "smallest-ai",
      limit: "Price used by our estimator",
      status: "FROM_REPOSITORY",
      repositoryValue: usd(estimateTtsCost("smallest-ai", 1_000), "1,000 characters"),
      source: "src/core/session/cost-estimator.ts",
      matters: "Every Smallest AI TTS cost figure scales from this number.",
      blocksScaling: false,
    },
  );

  return limits;
}

export function unconfirmedExternalLimits(
  limits: readonly ExternalLimit[] = getExternalLimits(),
): readonly ExternalLimit[] {
  return limits.filter((limit) => limit.status === "NEEDS_EXTERNAL_CONFIRMATION");
}

export function scalingBlockingLimits(
  limits: readonly ExternalLimit[] = getExternalLimits(),
): readonly ExternalLimit[] {
  return unconfirmedExternalLimits(limits).filter((limit) => limit.blocksScaling);
}

/**
 * Statuses this system can and cannot distinguish today, stated once so
 * no report has to guess.
 *
 * Derived from the code, not from the carrier: the Call request carries
 * `answer_url` and nothing else, the Vobiz media bridge sends no `stop`
 * event upstream and receives none, and the call runner's own watchdog
 * is what produces NO_ANSWER. Anything a carrier would have to tell us
 * is listed as unavailable.
 */
export interface StatusCapability {
  readonly status: string;
  readonly available: boolean;
  /** 'observed' when the platform saw it, 'inferred' when a timer deduced it. */
  readonly provenance: "observed" | "inferred" | "unavailable";
  readonly howItIsDetermined: string;
}

export function callStatusCapabilities(): readonly StatusCapability[] {
  return [
    {
      status: "human answered",
      available: false,
      provenance: "observed",
      howItIsDetermined:
        "ANSWERED is observed — but only as 'the media stream opened'. The Vobiz bridge calls confirmCallAnswered() on the stream's 'start' event, which fires for a human, an answering machine and an IVR alike. 'Answered' is real; 'human' is not established.",
    },
    {
      status: "voicemail / answering machine",
      available: false,
      provenance: "unavailable",
      howItIsDetermined:
        "No AMD parameter is sent and no carrier verdict is received. A voicemail greeting currently becomes a normal answered call whose transcript the outcome classifier reads, and typically lands as no_engagement or unclear.",
    },
    {
      status: "busy",
      available: false,
      provenance: "inferred",
      howItIsDetermined:
        "Only ever inferred, and only from an error string: classifyError() matches /busy/ in a thrown message from the Call API. Without a status callback, a busy line that the carrier accepts and drops presents as NO_ANSWER instead.",
    },
    {
      status: "no answer",
      available: true,
      provenance: "inferred",
      howItIsDetermined:
        "Inferred by the call runner's own ring watchdog after CAMPAIGN_RING_TIMEOUT_SECONDS with no 'answered' transition. Stored with status_source='inferred', and the results report counts these separately as inferredTerminal.",
    },
    {
      status: "rejected / declined",
      available: false,
      provenance: "inferred",
      howItIsDetermined:
        "Only inferred from an error string (/reject|declined|denied|forbidden|403/). A callee pressing decline is indistinguishable from no answer today.",
    },
    {
      status: "completed conversation",
      available: true,
      provenance: "observed",
      howItIsDetermined:
        "Observed from the existing session state machine: the pipeline reaching IDLE, or the watchdog ending the call at max duration or max silence. hangup_reason records which.",
    },
    {
      status: "carrier hangup cause",
      available: false,
      provenance: "unavailable",
      howItIsDetermined:
        "Never received. The Vobiz media bridge documents that the platform sends no 'stop' event — a WebSocket close is end-of-stream — and no status webhook route exists.",
    },
  ];
}
