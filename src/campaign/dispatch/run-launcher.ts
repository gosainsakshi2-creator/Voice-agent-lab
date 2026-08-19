/**
 * run-launcher.ts
 *
 * Everything that has to happen around a dispatcher run, in one place,
 * so "start" and "resume" cannot drift apart.
 *
 * The two are the same operation with different words in front of it:
 * a resume is a new run over the contacts that are still pending,
 * subject to the same preflight, the same dispatcher lock, the same
 * kill switch and the same call ceiling. Writing that twice in two
 * route handlers is how one of them ends up missing the ceiling.
 *
 * What this adds around the Phase 4 dispatcher, without changing it:
 *
 *   - the call ceiling, resolved from the environment, the pilot
 *     ladder and any per-campaign ceiling, smallest wins;
 *   - the durable control row, set to RUN once the run has cleared
 *     preflight, because a start IS the operator saying run — so an old
 *     PAUSE cannot linger and stop the run they just asked for, and a
 *     REFUSED start cannot clear a STOP that is still in force;
 *   - a control watcher, so a PAUSE or STOP issued from anywhere
 *     reaches this dispatcher.
 *
 * Phase 6 adds two more gates in the same place, for the same reason:
 *
 *   - the LOAD GUARDRAILS, so a configuration that would remove the
 *     CPS limiter or exceed the absolute ceilings is refused rather
 *     than run (see `load-guardrails.ts`);
 *   - the CALLING WINDOW, so a run cannot start outside the hours the
 *     deployment permits, plus a watcher that pauses the run if the
 *     window closes underneath it.
 *
 * Both are checked BEFORE the control row is written, alongside
 * preflight, so a refused start still cannot clear a stored STOP.
 */

import { getDispatchConfig, type DispatchConfig } from "../config/dispatch.config";
import { getCampaign } from "../db/repositories/campaign.repo";
import { getControl, setControl } from "../db/repositories/control.repo";
import { logEvent } from "../db/repositories/call-attempt.repo";
import { describeCallCeiling, type CallCeiling } from "../domain/pilot-stage";
import {
  CampaignDispatcher,
  getDispatcher,
  registerDispatcher,
  unregisterDispatcher,
  type DispatchManager,
  type DispatcherStatus,
} from "./dispatcher";
import { CampaignControlWatcher } from "./control-watcher";
import { CallingWindowWatcher } from "./calling-window-watcher";
import { checkLoadSafety } from "./load-guardrails";
import { getCallingWindow, isCallingWindowOpen, validateCallingWindow } from "../config/calling-window";

export interface LaunchInput {
  readonly campaignId: string;
  readonly manager: DispatchManager;
  readonly requestedBy: string;
  /** "start" or "resume" — recorded in the event log, nothing else. */
  readonly intent: "start" | "resume";
  readonly config?: DispatchConfig;
}

export type LaunchResult =
  | {
      readonly started: true;
      readonly status: DispatcherStatus;
      readonly ceiling: CallCeiling;
      readonly dialingEnabled: boolean;
      /** The window this run is allowed to dial in, for the response to echo. */
      readonly callingWindow: string;
      /** Legal-but-notable configuration findings. Never a reason to refuse. */
      readonly loadWarnings: readonly string[];
    }
  | { readonly started: false; readonly code: "NOT_FOUND" | "ALREADY_RUNNING" | "BLOCKED"; readonly blockers: readonly string[] };

/**
 * Starts a run and returns immediately. The run itself outlives the
 * request that asked for it — a campaign is not an HTTP transaction.
 */
export async function launchCampaignRun(input: LaunchInput): Promise<LaunchResult> {
  const config = input.config ?? getDispatchConfig();

  if (getDispatcher(input.campaignId)) {
    return { started: false, code: "ALREADY_RUNNING", blockers: ["This campaign is already running."] };
  }

  const campaign = await getCampaign(input.campaignId);
  if (!campaign) return { started: false, code: "NOT_FOUND", blockers: ["Campaign not found."] };

  // READ the stored instruction now; the RUN is written later, only if
  // this run actually starts. A start that preflight refuses must not
  // clear a stored STOP as a side effect — that would turn a failed
  // request into a silently un-stopped campaign.
  const control = await getControl(input.campaignId);

  const ceiling = describeCallCeiling({
    environmentMax: config.stageMaxCalls,
    pilotStage: campaign.pilotStage,
    campaignControlMax: control.maxCallsThisRun,
  });

  // ── Load guardrails ─────────────────────────────────────────────
  // Checked against the ceiling this run will actually be given, so a
  // configuration that removes the CPS limiter, deadlocks a lane, or
  // exceeds an absolute ceiling is refused before anything is written.
  const loadSafety = checkLoadSafety(config, ceiling.effective);
  if (!loadSafety.safe) {
    return { started: false, code: "BLOCKED", blockers: loadSafety.blockers };
  }

  // ── Calling window ──────────────────────────────────────────────
  const window = getCallingWindow();
  const windowValidation = validateCallingWindow(window);
  if (!windowValidation.ok) {
    return { started: false, code: "BLOCKED", blockers: windowValidation.blockers };
  }
  const windowVerdict = isCallingWindowOpen(window);
  if (!windowVerdict.open) {
    return { started: false, code: "BLOCKED", blockers: [windowVerdict.reason] };
  }

  const runConfig: DispatchConfig = { ...config, stageMaxCalls: ceiling.effective };
  const dispatcher = new CampaignDispatcher(input.campaignId, input.manager, runConfig);

  const { ok, blockers } = await dispatcher.preflight();
  if (!ok) return { started: false, code: "BLOCKED", blockers };

  // Past every check, so this run is genuinely starting. Clearing an
  // earlier PAUSE or STOP is the point: the operator is asking for
  // this run now, and a stale instruction must not stop it a second
  // later. The per-campaign ceiling is preserved — `maxCallsThisRun`
  // is left undefined here, which means "leave it alone", not null.
  await setControl({
    campaignId: input.campaignId,
    desiredState: "RUN",
    requestedBy: input.requestedBy,
    reason: input.intent === "resume" ? "Resumed by operator" : "Started by operator",
  });

  const watcher = new CampaignControlWatcher(input.campaignId, dispatcher, {
    onApply: (state, revision) => {
      void logEvent(
        input.campaignId,
        `CONTROL_APPLIED_${state}`,
        `Dispatcher applied a durable ${state} instruction (revision ${revision})`,
        { state, revision },
        "warn",
      ).catch(() => undefined);
    },
  });

  // Pauses this run if the calling window closes while it is running.
  // Only ever pauses — it has no path that resumes anything.
  const windowWatcher = new CallingWindowWatcher(dispatcher, {
    window,
    onClose: (reason) => {
      void logEvent(
        input.campaignId,
        "CALLING_WINDOW_CLOSED",
        `Paused: ${reason}`,
        { window: windowWatcher.describe() },
        "warn",
      ).catch(() => undefined);
    },
  });

  registerDispatcher(input.campaignId, dispatcher);
  await logEvent(input.campaignId, `RUN_${input.intent.toUpperCase()}`, `Run ${input.intent}ed`, {
    requestedBy: input.requestedBy,
    ceiling,
    dialingEnabled: runConfig.dialingEnabled,
    callingWindow: windowWatcher.describe(),
    loadWarnings: loadSafety.warnings,
  }).catch(() => undefined);

  watcher.start();
  windowWatcher.start();
  void dispatcher
    .run()
    .catch(() => undefined)
    .finally(() => {
      watcher.dispose();
      windowWatcher.dispose();
      unregisterDispatcher(input.campaignId);
    });

  return {
    started: true,
    status: dispatcher.getStatus(),
    ceiling,
    dialingEnabled: runConfig.dialingEnabled,
    callingWindow: windowWatcher.describe(),
    loadWarnings: loadSafety.warnings,
  };
}
