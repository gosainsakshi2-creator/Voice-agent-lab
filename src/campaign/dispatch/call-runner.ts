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
 *   4. every exit path goes through `finalize`, which classifies the
 *      call, derives the contact's disposition, decides the retry, and
 *      then closes the attempt and moves the contact in one
 *      transaction.
 *
 * The watchdog that runs before step 4 also ends a call the moment the
 * customer has given a FINAL answer and the agent has finished replying
 * to it. That is a HANGUP, not a verdict: the answer is read from the
 * existing classifier and `disposition.ts`, and the call then takes the
 * same `finalize` path a remote hangup takes.
 *
 * Step 4's internal order changed in Phase 7 and the order is the
 * point: the call is INTERPRETED before its fate is decided. Deciding
 * first and interpreting afterwards is what made "call me later" and
 * "no, never" the same outcome for a contact.
 */

import { CallDirection, ProviderCategory, SessionState, SupportedLanguage } from "../../types/enums";
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
import { isFinalYes, syncFinalYesToSheet } from "../integrations/final-yes-sheet";
import { dispositionFor } from "../outcome/disposition";
import { containsPhrase, hasExplicitRefusal, normaliseText } from "../outcome/conversation-events";
import type { OutcomeClassification } from "../outcome/outcome-types";
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
  /**
   * OPTIONAL, and read-only. Epoch-ms of the last conversation activity
   * the pipeline heard (streaming STT, interim segments included), or
   * `0` when nothing has been heard yet. Optional so a manager without
   * it behaves exactly as before.
   */
  lastActivityAt?(sessionId: SessionId): number;
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
    // The attempt's own status does not depend on the retry decision:
    // it is the mechanical result of this call. Computing it first is
    // what lets the call be interpreted before its fate is decided.
    const status = statusForAttempt(failureClass);

    // ── 1. What did this call MEAN? ───────────────────────────────
    // Before the retry decision, not after it. A conversation that
    // ended is not the same thing as a person who decided, and the
    // planner cannot tell the difference without being told.
    //
    // Never throws: a classifier fault yields `undefined`, and the
    // planner then behaves exactly as it did before this existed.
    const classification = classifySafely({
      campaign,
      status,
      failureClass,
      failureReason: reason,
      answered,
      transcript,
      // The approved script, so the classifier can also record whether
      // the AGENT stayed on it. Diagnostic only: it changes no label,
      // no disposition and no retry.
      scriptText: script.systemPromptAppendix,
    });

    // ── 2. Project onto the contact-level disposition ─────────────
    const disposition = classification
      ? dispositionFor({ outcomeType: classification.outcomeType, failureClass })
      : undefined;

    // ── 3. Decide retry vs terminal, with the outcome in hand ─────
    const decision = planRetry(
      failureClass,
      contact.nextAttemptNumber,
      config.retry,
      new Date(),
      classification && disposition
        ? {
            campaignType: campaign.campaignType,
            disposition: disposition.disposition,
            outcomeType: classification.outcomeType,
          }
        : undefined,
    );

    // ── 4. Close the attempt and move the contact, atomically ─────
    // Unchanged from before: a terminal decision names the attempt's
    // status, a retry falls back to the mechanical one.
    const attemptStatus = decision.retry ? status : decision.contactStatus;
    await finalizeAttempt({
      attemptId: attempt.id,
      contactId: contact.id,
      status: attemptStatus,
      failureClass,
      failureReason: reason,
      ...(hangupReason !== undefined ? { hangupReason } : {}),
      statusSource,
      nextAttemptAfter: decision.nextAttemptAfter,
      contactStatus: decision.contactStatus,
      ...(disposition
        ? {
            disposition: disposition.disposition,
            closureReason: `${disposition.reason} — ${decision.reason}`,
          }
        : {}),
      ...(classification ? { lastOutcomeType: classification.outcomeType } : {}),
      closed: !decision.retry,
    });

    // ── 5. Store the interpretation ──────────────────────────────
    // After the attempt is closed, and contained: a failure to persist
    // an outcome must never change what happened to the call.
    await saveClassification({
      attemptId: attempt.id,
      campaignId: campaign.id,
      classification,
      transcript,
    });

    // ── 6. Mirror a definitive FINAL_YES to the registrations sheet ─
    // LAST, deliberately. The outcome is already persisted by step 5
    // and the contact already moved by step 4, so the sheet is a
    // downstream copy of a decision that is final either way. The call
    // never throws and never rejects (see `final-yes-sheet.ts`), so no
    // sheet, credential or Google failure can reach the retry planner,
    // the disposition, the attempt row or the campaign's state.
    //
    // It decides nothing: it reads the `confirmed_at_gate` verdict the
    // classifier already produced and the FINAL_YES disposition already
    // written above, and writes a row only when both agree.
    await syncFinalYesToSheet({
      campaignId: campaign.id,
      contactId: contact.id,
      attemptId: attempt.id,
      classification,
      ...(disposition ? { disposition: disposition.disposition } : { disposition: undefined }),
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
    // The session's own current state, taken from the transition every
    // observer event already carries. Read by the silence clock below
    // and by nothing else: no new manager API, no extra polling, and no
    // second source of truth — this is the same transition stream that
    // already stamps `lastActivityAt` one line down.
    let sessionState: string = SessionState.CALLING;
    // Set by the watchdog when the conversation has reached a final
    // answer, and read once below to name the hangup.
    let finalAnswer: "FINAL_YES" | "FINAL_NO" | undefined;

    const finished = new Promise<void>((resolve) => {
      unwatch = observer.watch(sessionId as string, (event) => {
        lastActivityAt = Date.now();
        sessionState = String(event.transition.to);
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

    // ── 5. Watchdog: ring timeout, max duration, max silence, and a
    //      conversation that has reached a final answer ────────────
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
          // State transitions alone under-report activity: while the
          // caller is speaking the session stays in LISTENING, so a
          // transition-only clock treats a talking caller as silence
          // and hangs up on a live conversation. The pipeline's own
          // heard-audio stamp is the other half of the signal; a
          // genuinely silent call produces neither, so real silence
          // still ends the call at exactly the same deadline.
          const heardAt = pipelineActivityAt(manager, sessionId as SessionId);
          // ...but both of those clocks measure the CALLER, and a caller
          // is SUPPOSED to be silent while the agent is THINKING or
          // SPEAKING. Neither clock advances during a reply, so a reply
          // longer than the window read as a dead line and hung up on
          // the person mid-sentence. Silence is therefore only counted
          // in LISTENING, the one state in which the agent is waiting to
          // be spoken to and hearing nothing genuinely means nothing is
          // there. The window is unchanged and re-arms by itself: the
          // pipeline holds SPEAKING until playback has drained (see
          // `drainPlayback`) and only then transitions back to
          // LISTENING, and that transition stamps `lastActivityAt`
          // above — so the deadline runs from the moment the agent
          // stopped talking. MAX_DURATION still bounds a call that never
          // leaves THINKING or SPEAKING.
          if (
            sessionState === SessionState.LISTENING &&
            now - Math.max(lastActivityAt, heardAt) > config.maxSilenceSeconds * 1000
          ) {
            return "MAX_SILENCE" as const;
          }
          // The person has decided, and has already heard the agent's
          // reply to it. Nothing is left on this call, so it ends here
          // instead of holding the line open until the silence timeout.
          // Read-only — see `definitiveAnswerSoFar`.
          finalAnswer = definitiveAnswerSoFar(manager, sessionId as SessionId, campaign);
          if (finalAnswer) return "FINAL_ANSWER" as const;
          // SECOND, and only if the above found nothing: the AGENT has
          // said goodbye. The conversation reached its end without the
          // person giving a verdict the classifier can close a contact
          // on — which is a real and common way a call finishes, and
          // was the one ending that left the line open until the
          // silence window expired. Read-only, and checked after
          // `definitiveAnswerSoFar` so a FINAL_YES / FINAL_NO still
          // takes its own path and names its own hangup. See
          // `agentClosedIn`.
          if (agentClosedSoFar(manager, sessionId as SessionId)) return "AGENT_CLOSED" as const;
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
    if (verdict === "FINAL_ANSWER") {
      // A completed conversation, and the most completed kind there is.
      // `finalize` re-reads the finished transcript exactly as it does
      // for every other completed call, so the stored outcome, the
      // disposition, the retry decision and the sheet row are produced
      // by the same code that produced them before this early hangup
      // existed. All this changed is that the line is no longer held
      // open after the conversation is over.
      return finalize(
        "COMPLETED",
        `the person gave a definitive answer (${finalAnswer}) and the call was ended`,
        "observed",
        `agent_hangup:${String(finalAnswer).toLowerCase()}`,
      );
    }
    if (verdict === "AGENT_CLOSED") {
      // A conversation that ran to its end. `finalize` re-reads the
      // finished transcript exactly as it does for every other
      // completed call, so the stored outcome, the disposition, the
      // retry decision and the sheet row are produced by the same
      // unchanged code — all this changed is that the line is no longer
      // held open after the agent has said goodbye.
      return finalize(
        "COMPLETED",
        "the agent delivered its closing line and the call was ended",
        "observed",
        "agent_hangup:closing",
      );
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
 * Reads the finished call, in memory, with no database access.
 *
 * Separated from persistence because the retry decision now depends on
 * it: the classification has to exist BEFORE the contact is moved, and
 * a write is not something to do inside that window.
 *
 * Returns `undefined` rather than throwing. That is the safety property
 * the whole reordering rests on — an unreadable call falls back to the
 * pre-Phase-7 telephony retry policy, so the worst case of a classifier
 * bug is the behaviour this system already had, never a lost contact or
 * an extra call to a real person.
 */
function classifySafely(input: {
  campaign: CampaignRecord;
  status: CallStatus;
  failureClass: FailureClass;
  failureReason: string;
  answered: boolean;
  transcript: StoredTranscript | undefined;
  scriptText?: string;
}): OutcomeClassification | undefined {
  try {
    return classifyOutcome({
      campaignType: input.campaign.campaignType,
      status: input.status,
      failureClass: input.failureClass,
      answered: input.answered,
      transcript: input.transcript?.turns ?? [],
      failureReason: input.failureReason,
      ...(input.scriptText !== undefined ? { scriptText: input.scriptText } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Wrong-number phrases that cannot mean anything else, in the words of
 * the person themselves.
 *
 * A strict subset of the classifier's own WRONG_NUMBER table, and
 * deliberately NOT an import of it: this list exists to be narrower.
 * Nothing here is a fragment of a longer innocent sentence, so a live
 * call is only cut on a phrase that has one reading.
 */
const UNMISTAKABLE_WRONG_NUMBER = [
  "wrong number", "wrong person", "no such person", "you have the wrong",
  "he does not live here", "she does not live here",
  "galat number", "koi aur hai",
  "गलत नंबर",
] as const;

/**
 * Has the person given a FINAL answer, with the agent's reply to it
 * already spoken?
 *
 * Introduces no verdict of its own. The label comes from
 * `classifyOutcome`, its contact-level meaning from `dispositionFor`,
 * and the FINAL_YES test is `isFinalYes` — the same conjunction the
 * registrations-sheet mirror uses, so a call that hangs up on a yes is
 * by construction a call that produces a sheet row.
 *
 * Two deliberate narrowings, both about never cutting a live call
 * short:
 *
 *   1. The last turn must be the AGENT's. The pipeline commits an
 *      assistant turn only after that reply's audio has drained (see
 *      `drainPlayback`), so this is the moment the confirmation the
 *      person just heard finished — not the moment they said yes. It
 *      also means the live partial utterance `getTranscript` appends
 *      while somebody is still speaking is never read as an answer, and
 *      that a person who keeps talking is never hung up on mid-sentence.
 *
 *   2. A FINAL_NO must be UNMISTAKABLE. A bare "no" is a refusal to the
 *      post-call classifier, but mid-call it is just as often "no, I
 *      hadn't heard of it" — and the classifier itself lets a yes at the
 *      gate override an earlier no, so hanging up on one would throw
 *      away registrations that were still coming. `opt_out` is final the
 *      moment it is said — every phrase in that table is a compliance
 *      signal and none of them has an innocent reading. An
 *      `explicit_no` counts only when the person's own last words match
 *      the existing explicit-refusal table, and a `wrong_person` only
 *      when those same last words match UNMISTAKABLE_WRONG_NUMBER.
 *      `wrong_person` needs that second test because the classifier's
 *      wrong-number table carries the partials "this is not" and bare
 *      "galat" for a FINISHED transcript, where they are read together
 *      with everything else that was said. Mid-call they also match
 *      "no, this is not what I asked", "this is not clear" and "galat
 *      samajh gaye" — questions and objections, matched without the
 *      answer-readability guard affirmations and negations get, and
 *      ranked above the gate. The classifier itself calls this reason
 *      `confidence: "medium"`; a medium-confidence signal may label a
 *      call afterwards, but it may not cut one short.
 *
 * Never throws, for the same reason `classifySafely` does not: an
 * unreadable conversation must cost the early hangup and nothing else.
 */
export function definitiveAnswerIn(
  turns: readonly ConversationTurn[],
  campaignType: string,
): "FINAL_YES" | "FINAL_NO" | undefined {
  if (turns.length === 0 || turns[turns.length - 1]?.role !== "assistant") return undefined;

  const stored = toStoredTranscript(turns);
  const classification = classifyOutcome({
    campaignType,
    // The conversation is over as far as this reading is concerned: the
    // same two values `finalize` passes for a completed call.
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: stored.turns,
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });

  if (isFinalYes(classification, disposition)) return "FINAL_YES";
  if (disposition !== "FINAL_NO") return undefined;
  if (classification.primaryReason === "opt_out") return "FINAL_NO";
  if (
    classification.primaryReason !== "explicit_no" &&
    classification.primaryReason !== "wrong_person"
  ) {
    return undefined;
  }

  const lastCustomerTurn = [...stored.turns].reverse().find((turn) => turn.role === "user");
  if (!lastCustomerTurn) return undefined;
  const lastWords = normaliseText(lastCustomerTurn.text);
  if (classification.primaryReason === "wrong_person") {
    return containsPhrase(lastWords, UNMISTAKABLE_WRONG_NUMBER) ? "FINAL_NO" : undefined;
  }
  return hasExplicitRefusal(lastWords) ? "FINAL_NO" : undefined;
}

/**
 * Sign-offs, and ONLY sign-offs.
 *
 * The agent reaching the end of the conversation is a real end-of-call
 * signal that no existing check could see. `definitiveAnswerIn` above
 * reads what the PERSON said, through the classifier — so it fires on a
 * yes at the gate and on an unmistakable refusal, and on nothing else.
 * A conversation that finished without either (the classifier's
 * `unclear`, `affirmative_not_at_gate`, `callback_requested`,
 * `interested_not_confirmed`) produced no verdict, so the watchdog held
 * the line open after the agent had already said goodbye and the call
 * ended on the silence window — or, if the person offered one more
 * pleasantry, on the silence window after THAT.
 *
 * Every phrase here is a thing said only when leaving. Deliberately
 * absent: "namaste" / "namaskar", which this script's own opening line
 * uses as a greeting, and any bare courtesy ("thank you", "ok",
 * "shukriya" on its own) that is said just as often mid-call.
 */
const AGENT_CLOSINGS = [
  "take care", "goodbye", "good bye", "bye bye", "bye",
  "have a great day", "have a good day", "have a nice day", "have a lovely day",
  "have a great evening", "have a good evening", "enjoy your day",
  "thanks for your time", "thank you for your time", "thanks for the time",
  "thank you for the time", "thanks for listening",
  "see you today", "see you there", "see you soon", "see you at the session",
  "see you in the session", "see you live",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "apna dhyan rakhiye", "apna dhyan rakhna", "dhyan rakhiye",
  "aapka din shubh ho", "shubh din", "phir milenge", "milte hain",
  "aapke samay ke liye dhanyavaad", "samay ke liye dhanyavaad",
  "अपना ध्यान रखिए", "अपना ध्यान रखना", "फिर मिलेंगे", "मिलते हैं",
  "आपका दिन शुभ हो", "समय के लिए धन्यवाद",
] as const;

/**
 * A sign-off turn is SHORT. The approved script's blocks and the
 * agent's answers to questions run well past this (measured at
 * 213-286 characters, ~35-50 words, on the v2/v3 prompt stack), so the
 * cap is what keeps a long turn that happens to contain a closing
 * phrase from reading as one.
 */
const AGENT_CLOSING_MAX_WORDS = 12;

/**
 * At most this many words may follow the sign-off phrase and still
 * leave the turn a sign-off.
 *
 * The original reading of guard 3 was `endsWith` — the turn had to stop
 * on the phrase itself with nothing after it. Production showed that is
 * not how the agent says goodbye. This script is name-driven
 * (`{{customer_name}}`, `requiresName: true`), the whole prompt stack
 * addresses the person by name, and the closing is the most natural
 * place in a call to use it. The reported ending was:
 *
 *     "Take care, Sakshi."   ->   " take care sakshi "
 *
 * which does not END on " take care ", so no closing was ever seen, no
 * `AGENT_CLOSED` verdict was produced, and the line was held open until
 * the silence window — by which point the person had already hung up
 * and Vobiz answered `endCall` with a 404. The same was true of "Sure.
 * Have a good day, Sakshi." and "Thank you, have a great day ahead."
 *
 * Two words is what a trailing vocative costs ("sakshi", "sakshi ji",
 * "sir", "ma'am") plus the occasional trailing adverb ("ahead", "now").
 * It is deliberately NOT enough for a clause.
 */
const AGENT_CLOSING_MAX_TRAILING_WORDS = 2;

/**
 * Words that CARRY A SENTENCE ON rather than trail off the end of one.
 *
 * This is the other half of the tail rule, and it is what keeps the
 * relaxation from re-opening the false positive guard 3 exists to
 * close. A vocative or an adverb ends a sentence; a preposition,
 * conjunction, article, pronoun or auxiliary continues it. So:
 *
 *     "Take care, Sakshi."                    tail ["sakshi"]      -> a closing
 *     "Have a great day at work, and I..."    tail ["at", ...]     -> NOT a closing
 *     "Just take care to join early..."       tail ["to", ...]     -> NOT a closing
 *
 * A closed word class, so the list is complete rather than a sample,
 * and it costs nothing to keep the Hinglish connectors in it: a Hindi
 * closing is followed by "ji" (a honorific, deliberately absent below)
 * far more often than by "aur" or "ke".
 */
const CLOSING_CONTINUATION_WORDS = new Set([
  // Conjunctions and subordinators.
  "and", "or", "but", "so", "if", "when", "while", "before", "after", "until",
  "till", "then", "because", "since", "though", "although", "unless", "that",
  "which", "who", "whom", "whose", "as",
  // Prepositions.
  "to", "of", "for", "with", "at", "in", "into", "on", "from", "by", "about",
  "over", "under", "through", "during", "per",
  // Articles and determiners.
  "the", "a", "an", "my", "your", "our", "their", "his", "her", "its", "this",
  "these", "those", "some", "any", "no", "not",
  // Pronouns.
  "i", "we", "you", "they", "he", "she", "it", "me", "us", "them", "him",
  // Auxiliaries and common verbs that open a clause.
  "is", "are", "am", "was", "were", "be", "been", "being", "will", "would",
  "can", "could", "should", "shall", "may", "might", "must", "do", "does",
  "did", "have", "has", "had", "let", "get", "got",
  // Hindi / Hinglish connectors, transliterated and in Devanagari.
  "aur", "ki", "ka", "ke", "ko", "se", "me", "mein", "par", "hai", "hain",
  "hoga", "kar", "karo", "karke", "lekin", "agar", "jo", "tak", "liye",
  "wala", "wali", "phir", "yeh", "woh", "kya",
  "और", "की", "का", "के", "को", "से", "में", "पर", "है", "हैं", "लेकिन", "अगर",
  "जो", "तक", "लिए", "क्या",
]);

/**
 * Does the normalised turn FINISH on one of the phrases above — either
 * exactly, or with a short trailing vocative and nothing else?
 *
 * `lastIndexOf`, so a turn that uses a closing phrase twice is measured
 * from the LAST one: "take care to join early... anyway, take care" is
 * read on the ending, not on the mid-sentence use.
 */
function endsWithClosing(normalised: string): boolean {
  for (const phrase of AGENT_CLOSINGS) {
    const needle = ` ${phrase} `;
    const at = normalised.lastIndexOf(needle);
    if (at === -1) continue;

    const tail = normalised.slice(at + needle.length).trim();
    // Ends exactly on the phrase — the original reading, unchanged.
    if (tail.length === 0) return true;

    const trailing = tail.split(/\s+/);
    if (trailing.length > AGENT_CLOSING_MAX_TRAILING_WORDS) continue;
    if (trailing.some((word) => CLOSING_CONTINUATION_WORDS.has(word))) continue;
    return true;
  }
  return false;
}

/**
 * Has the AGENT closed the conversation, with its closing line already
 * spoken in full?
 *
 * Introduces no verdict of its own and reads no classifier: this is the
 * hangup condition only. Whatever the call MEANT is still decided by
 * `classifyOutcome` and `dispositionFor` inside `finalize`, from the
 * finished transcript, exactly as it is for every other completed call
 * — so the disposition, the retry decision and the registrations-sheet
 * row are produced by unchanged code. `definitiveAnswerSoFar` is
 * checked FIRST at the one call site, so a FINAL_YES or a FINAL_NO
 * still ends the call as `agent_hangup:final_yes` / `final_no` and
 * nothing about those two paths is reachable from here.
 *
 * Four guards, and each one exists to answer a specific way this could
 * cut a live call short:
 *
 *   1. The last turn must be the AGENT's. `ConversationPipeline`
 *      commits an assistant turn only after that reply's audio has
 *      DRAINED (see `drainPlayback`), so this is the moment the closing
 *      the person just heard finished playing — never before. It also
 *      means the live partial utterance `getTranscript` appends while
 *      somebody is still speaking blocks this, so a person who is
 *      talking is never hung up on mid-sentence.
 *
 *   2. The person must have said something. A call where only the agent
 *      spoke is a machine or a line nobody answered into, and it is
 *      already handled by the voicemail path and the silence window.
 *
 *   3. The turn must END on a sign-off, not merely contain one — where
 *      "end on" allows at most a two-word trailing vocative and no
 *      continuation word (see `endsWithClosing`), because the agent
 *      really says "Take care, Sakshi." and not "Take care." This is
 *      what separates that from "Just take care to join a few minutes
 *      early, the link will be on WhatsApp" — the same phrase,
 *      mid-conversation, in a turn that carries on afterwards.
 *      Combined with the word cap, a closing phrase used as an
 *      ordinary verb inside a longer reply cannot reach this.
 *
 *   4. The turn must ask nothing. A turn with a question in it is a
 *      handover point, not an ending, whatever else it contains — and
 *      the person is about to answer it.
 *
 * Never throws, for the same reason `definitiveAnswerIn` does not.
 */
export function agentClosedIn(turns: readonly ConversationTurn[]): boolean {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (!turns.some((turn) => turn.role === "user" && turn.content.trim().length > 0)) return false;

  // Tested on the RAW text: `normaliseText` strips punctuation, so the
  // question mark is gone by the time the phrase match runs.
  if (last.content.includes("?")) return false;

  const normalised = normaliseText(last.content);
  const wordCount = normalised.trim().length === 0 ? 0 : normalised.trim().split(/\s+/).length;
  if (wordCount === 0 || wordCount > AGENT_CLOSING_MAX_WORDS) return false;

  return endsWithClosing(normalised);
}

/**
 * Last activity the pipeline itself heard, contained the same way
 * `definitiveAnswerSoFar` is: a manager that does not expose it, or a
 * session that has not been heard from, reports `0` and the watchdog
 * falls back to state transitions alone.
 */
function pipelineActivityAt(manager: ManagerLike, sessionId: SessionId): number {
  if (typeof manager.lastActivityAt !== "function") return 0;
  try {
    const at = manager.lastActivityAt(sessionId);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** The same reading, against a live session, contained. */
function agentClosedSoFar(manager: ManagerLike, sessionId: SessionId): boolean {
  if (typeof manager.getTranscript !== "function") return false;
  try {
    return agentClosedIn(manager.getTranscript(sessionId));
  } catch {
    return false;
  }
}

/** The same reading, against a live session, contained. */
function definitiveAnswerSoFar(
  manager: ManagerLike,
  sessionId: SessionId,
  campaign: CampaignRecord,
): "FINAL_YES" | "FINAL_NO" | undefined {
  if (typeof manager.getTranscript !== "function") return undefined;
  try {
    return definitiveAnswerIn(manager.getTranscript(sessionId), campaign.campaignType);
  } catch {
    return undefined;
  }
}

/**
 * Stores the interpretation, and the transcript it was made from.
 *
 * Deliberately swallows its own errors. An outcome row is a record of a
 * call that has already happened and whose contact has already been
 * moved; a failed JSON write must not be able to fail the call. Anything
 * unstored here is recoverable from `findUnclassifiedAttempts`.
 */
async function saveClassification(input: {
  attemptId: string;
  campaignId: string;
  classification: OutcomeClassification | undefined;
  transcript: StoredTranscript | undefined;
}): Promise<void> {
  if (!input.classification) return;
  const startedAt = Date.now();
  try {
    await saveOutcome({
      attemptId: input.attemptId,
      campaignId: input.campaignId,
      classification: input.classification,
      ...(input.transcript ? { transcript: input.transcript } : {}),
    });
    await recordClassifyMs(input.attemptId, Date.now() - startedAt);
  } catch {
    // Intentionally silent — see above.
  }
}
