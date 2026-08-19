/**
 * call-runner.ts
 *
 * One campaign call, end to end.
 *
 * This is the ONLY module in the campaign layer that touches the voice
 * agent, and it does so exclusively through existing public methods:
 * `createSession`, `warmUpProviders`, `start`, `end`, `onStateChange`,
 * `getBenchmarkMetrics`, `getTranscript`. Nothing in the pipeline is
 * modified, subclassed, or reached into.
 *
 * Order matters and is deliberate:
 *
 *   1. attempt row FIRST, before anything can dial. If the process
 *      dies immediately after, recovery finds the row rather than a
 *      call nobody knows about.
 *   2. kill switch checked before the session is created, so a
 *      rehearsal cannot reach the telephony provider.
 *   3. campaign context built and validated before dialling, so a
 *      contact with no name fails without ringing anyone.
 *   4. every exit path goes through `finalize`, which closes the
 *      attempt and moves the contact in one transaction.
 */

import { CallDirection, ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { SessionCreationRequest, SessionId } from "../../types/session.types";
import type { BenchmarkMetrics } from "../../types/benchmark.types";
import {
  attachSessionId,
  createAttempt,
  finalizeAttempt,
  logEvent,
  markAnswered,
  releaseContact,
  saveCallMetrics,
  saveDispatchMetrics,
  type ClaimedContact,
} from "../db/repositories/call-attempt.repo";
import { recordClassifyMs, saveOutcome } from "../db/repositories/outcome.repo";
import { classifyOutcome } from "../outcome/classifier";
import { toStoredTranscript, type StoredTranscript } from "../outcome/transcript";
import type { ConversationTurn } from "../../types/provider.types";
import { buildCampaignContext, CampaignContextError } from "../domain/campaign-context";
import { classifyError, type CallStatus, type FailureClass } from "../domain/call-status";
import { planRetry } from "./retry-planner";
import type { DispatchConfig } from "../config/dispatch.config";
import type { CampaignRecord } from "../domain/campaign-types";
import type { CampaignScript } from "../script/script-registry";
import type { SessionObserver } from "./session-observer";

/** The subset of DefaultVoiceSessionManager this module uses. */
export interface ManagerLike {
  createSession(request: SessionCreationRequest): Promise<{ id: SessionId }>;
  warmUpProviders(sessionId: SessionId): Promise<unknown>;
  start(sessionId: SessionId): Promise<unknown>;
  end(sessionId: SessionId): Promise<unknown>;
  getBenchmarkMetrics(sessionId: SessionId): Promise<BenchmarkMetrics>;
  /**
   * OPTIONAL, and read-only. `DefaultVoiceSessionManager` already
   * exposes this for the dashboard's live transcript; the campaign
   * layer reads the same projection to classify the outcome. Optional
   * so a manager without it still runs every call — it loses the
   * outcome label, not the call.
   */
  getTranscript?(sessionId: SessionId): readonly ConversationTurn[];
}

export interface CallRunnerDeps {
  readonly manager: ManagerLike;
  readonly observer: SessionObserver;
  readonly config: DispatchConfig;
  readonly campaign: CampaignRecord;
  readonly script: CampaignScript;
}

export interface CallOutcome {
  readonly dialled: boolean;
  readonly attemptId: string | undefined;
  readonly failureClass: FailureClass;
  readonly reason: string;
}

function toLanguage(value: string): SupportedLanguage {
  switch (value) {
    case "hi":
      return SupportedLanguage.HINDI;
    case "hi-en":
      return SupportedLanguage.HINGLISH;
    default:
      return SupportedLanguage.ENGLISH;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runCall(
  contact: ClaimedContact,
  deps: CallRunnerDeps,
  claimedAt: number,
): Promise<CallOutcome> {
  const { manager, observer, config, campaign, script } = deps;

  // ── 1. Reserve the attempt before anything can dial ─────────────
  const attempt = await createAttempt(campaign.id, contact, campaign.telephonyProvider);
  if (!attempt) {
    // The unique constraint refused it: this attempt number already
    // exists, so another worker or an earlier run already placed it.
    await releaseContact(contact.id, "PENDING");
    return {
      dialled: false,
      attemptId: undefined,
      failureClass: "SYSTEM",
      reason: "attempt already exists — refused to place a duplicate call",
    };
  }

  // Set by the observer below. Read by `finalize`, which is why they
  // live out here rather than inside the try block.
  let answered = false;
  let transcript: StoredTranscript | undefined;

  const finalize = async (
    failureClass: FailureClass,
    reason: string,
    statusSource: "observed" | "inferred",
    hangupReason?: string,
  ): Promise<CallOutcome> => {
    const decision = planRetry(failureClass, contact.nextAttemptNumber, config.retry);
    const status = decision.retry ? statusForAttempt(failureClass) : decision.contactStatus;
    await finalizeAttempt({
      attemptId: attempt.id,
      contactId: contact.id,
      status,
      failureClass,
      failureReason: reason,
      ...(hangupReason !== undefined ? { hangupReason } : {}),
      statusSource,
      nextAttemptAfter: decision.nextAttemptAfter,
      contactStatus: decision.contactStatus,
    });

    // The business result, written after the attempt is closed. A
    // classification failure must never change what happened to the
    // call, so it is contained here rather than allowed to escape.
    await classifyAndSave({
      attemptId: attempt.id,
      campaign,
      status,
      failureClass,
      failureReason: reason,
      answered,
      transcript,
    });

    return { dialled: true, attemptId: attempt.id, failureClass, reason };
  };

  // ── 2. Kill switch, checked before a session can exist ──────────
  if (!config.dialingEnabled) {
    await finalizeAttempt({
      attemptId: attempt.id,
      contactId: contact.id,
      status: "CANCELLED",
      failureClass: "SYSTEM",
      failureReason: "CAMPAIGN_DIALING_ENABLED is not true — no call was placed",
      statusSource: "observed",
      nextAttemptAfter: null,
      contactStatus: "PENDING",
    });
    return {
      dialled: false,
      attemptId: attempt.id,
      failureClass: "SYSTEM",
      reason: "dialing disabled",
    };
  }

  // ── 3. Script + agent, resolved before anyone's phone rings ─────
  let campaignContext;
  try {
    campaignContext = buildCampaignContext({
      campaignId: campaign.id,
      campaignType: campaign.campaignType,
      script,
      provider: contact.assignedProvider,
      customerName: contact.name,
      expectedScriptHash: campaign.scriptHash,
    });
  } catch (error) {
    const reason = error instanceof CampaignContextError ? error.message : String(error);
    return finalize("INVALID_NUMBER", reason, "observed");
  }

  const request: SessionCreationRequest = {
    language: toLanguage(campaign.language),
    direction: CallDirection.OUTBOUND,
    providerStack: {
      telephony: { category: ProviderCategory.TELEPHONY, id: campaign.telephonyProvider },
      speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
      languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
      // The contact's locked provider. Nothing else may set this.
      textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: contact.assignedProvider },
    },
    destinationNumber: contact.normalizedPhone,
    campaign: campaignContext,
  };

  const timings: Record<string, number | null> = {
    queueWaitMs: Date.now() - claimedAt,
    claimToDialMs: null,
    dialRequestMs: null,
    ringToAnswerMs: null,
    persistMs: null,
  };

  let sessionId: SessionId | undefined;
  let unwatch: (() => void) | undefined;

  try {
    const session = await manager.createSession(request);
    sessionId = session.id;
    await attachSessionId(attempt.id, sessionId);

    // ── 4. Observe the call through the existing hook ─────────────
    let ended = false;
    let errored = false;
    let lastActivityAt = Date.now();
    let answeredAt = 0;

    const finished = new Promise<void>((resolve) => {
      unwatch = observer.watch(sessionId as string, (event) => {
        lastActivityAt = Date.now();
        if (event.phase === "answered" && !answered) {
          answered = true;
          answeredAt = Date.now();
          void markAnswered(attempt.id);
        } else if (event.phase === "ended") {
          ended = true;
          resolve();
        } else if (event.phase === "errored") {
          errored = true;
          resolve();
        }
      });
    });

    await manager.warmUpProviders(sessionId);

    const dialStartedAt = Date.now();
    timings["claimToDialMs"] = dialStartedAt - claimedAt;
    await manager.start(sessionId);
    timings["dialRequestMs"] = Date.now() - dialStartedAt;

    // ── 5. Watchdog: ring timeout, max duration, max silence ──────
    // Enforced entirely from here, using the existing public `end()`.
    // No hangup logic is added to the pipeline.
    const watchdog = (async () => {
      const ringDeadline = dialStartedAt + config.ringTimeoutSeconds * 1000;
      while (!ended && !errored) {
        await wait(500);
        const now = Date.now();
        if (!answered && now > ringDeadline) return "NO_ANSWER" as const;
        if (answered) {
          if (now - answeredAt > config.maxCallSeconds * 1000) return "MAX_DURATION" as const;
          if (now - lastActivityAt > config.maxSilenceSeconds * 1000) return "MAX_SILENCE" as const;
        }
      }
      return undefined;
    })();

    const verdict = await Promise.race([finished.then(() => undefined), watchdog]);

    if (verdict !== undefined) {
      // The watchdog fired. End the call through the public method.
      await manager.end(sessionId).catch(() => undefined);
    }

    if (answered) timings["ringToAnswerMs"] = answeredAt - dialStartedAt;

    // Captured while the session record is still the freshest copy of
    // the conversation. The manager keeps ended sessions in memory, so
    // this is a read of state that already exists, after the call.
    transcript = captureTranscript(manager, sessionId);

    const persistStartedAt = Date.now();
    await persistMetrics(manager, attempt.id, campaign, contact, sessionId, timings, persistStartedAt);

    if (verdict === "NO_ANSWER") {
      return finalize("NO_ANSWER", "no answer within the ring timeout", "inferred");
    }
    if (verdict === "MAX_DURATION") {
      return finalize("COMPLETED", "ended by the watchdog at the maximum call duration", "observed", "watchdog:max_duration");
    }
    if (verdict === "MAX_SILENCE") {
      return finalize("COMPLETED", "ended by the watchdog after silence", "observed", "watchdog:max_silence");
    }
    if (errored) {
      return finalize("TEMPORARY", "the conversation pipeline reported an error", "observed");
    }
    if (!answered) {
      return finalize("NO_ANSWER", "the call ended before it was answered", "inferred");
    }
    return finalize("COMPLETED", "conversation completed", "observed", "remote_hangup");
  } catch (error) {
    const { failureClass, reason } = classifyError(error);
    if (sessionId) {
      transcript ??= captureTranscript(manager, sessionId);
      await manager.end(sessionId).catch(() => undefined);
    }
    await logEvent(campaign.id, "CALL_FAILED", reason, { attemptId: attempt.id, failureClass }, "error");
    return finalize(failureClass, reason, "observed");
  } finally {
    unwatch?.();
  }
}

function statusForAttempt(failureClass: FailureClass) {
  switch (failureClass) {
    case "COMPLETED":
      return "COMPLETED" as const;
    case "NO_ANSWER":
      return "NO_ANSWER" as const;
    case "BUSY":
      return "BUSY" as const;
    default:
      return "FAILED" as const;
  }
}

/**
 * Stores the conversation metrics the existing collector already
 * produced, plus the orchestration timings, in their two separate
 * tables. Nothing is recalculated here — `getBenchmarkMetrics` is the
 * source, verbatim, and `raw` keeps the whole object.
 */
async function persistMetrics(
  manager: ManagerLike,
  attemptId: string,
  campaign: CampaignRecord,
  contact: ClaimedContact,
  sessionId: SessionId,
  timings: Record<string, number | null>,
  persistStartedAt: number,
): Promise<void> {
  try {
    const metrics = await manager.getBenchmarkMetrics(sessionId);
    const turns = metrics.turnLatencies ?? [];
    const median = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
    };
    const pick = (key: "stt" | "llm" | "tts" | "total") =>
      median(turns.map((t) => t[key]?.milliseconds).filter((v): v is number => v !== undefined));

    const breakdown = metrics.estimatedCost?.breakdown ?? {};
    await saveCallMetrics(attemptId, campaign.id, contact.assignedProvider, metrics as unknown as Record<string, unknown>, {
      turnCount: turns.length,
      conversationSeconds: metrics.callDuration?.seconds ?? null,
      sttP50: pick("stt"),
      llmP50: pick("llm"),
      ttsP50: pick("tts"),
      totalP50: pick("total"),
      firstTurnTotal: turns[0]?.total?.milliseconds ?? null,
      cost: {
        telephony: breakdown.telephony ?? 0,
        stt: breakdown.speechToText ?? 0,
        llm: breakdown.languageModel ?? 0,
        tts: breakdown.textToSpeech ?? 0,
        total: metrics.estimatedCost?.amount ?? 0,
      },
    });
    timings["persistMs"] = Date.now() - persistStartedAt;
    await saveDispatchMetrics(attemptId, campaign.id, contact.assignedProvider, timings);
  } catch {
    // Metrics are diagnostic. Losing them must never turn a completed
    // call into a failed one, or worse, into a retry.
  }
}

/**
 * Reads the conversation out of the manager, if this manager exposes
 * it. Never throws: a session the manager has already forgotten, or a
 * manager without the accessor, costs the outcome label and nothing
 * else.
 */
function captureTranscript(manager: ManagerLike, sessionId: SessionId): StoredTranscript | undefined {
  if (typeof manager.getTranscript !== "function") return undefined;
  try {
    const turns = manager.getTranscript(sessionId);
    if (!turns || turns.length === 0) return undefined;
    return toStoredTranscript(turns);
  } catch {
    return undefined;
  }
}

/**
 * Classifies the finished call and stores the result.
 *
 * Deliberately swallows its own errors. An outcome is an
 * interpretation of a call that has already happened; a classifier
 * that could fail a call, or worse, cause a retry — a second call to a
 * real person because a JSON write failed — would be a far more
 * expensive bug than a missing label. Anything unclassified is
 * recoverable later from the stored transcript.
 */
async function classifyAndSave(input: {
  attemptId: string;
  campaign: CampaignRecord;
  status: CallStatus;
  failureClass: FailureClass;
  failureReason: string;
  answered: boolean;
  transcript: StoredTranscript | undefined;
}): Promise<void> {
  const startedAt = Date.now();
  try {
    const classification = classifyOutcome({
      campaignType: input.campaign.campaignType,
      status: input.status,
      failureClass: input.failureClass,
      answered: input.answered,
      transcript: input.transcript?.turns ?? [],
      failureReason: input.failureReason,
    });
    await saveOutcome({
      attemptId: input.attemptId,
      campaignId: input.campaign.id,
      classification,
      ...(input.transcript ? { transcript: input.transcript } : {}),
    });
    await recordClassifyMs(input.attemptId, Date.now() - startedAt);
  } catch {
    // Intentionally silent — see above.
  }
}
