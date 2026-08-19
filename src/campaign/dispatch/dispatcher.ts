/**
 * dispatcher.ts
 *
 * Three independent provider lanes over one campaign.
 *
 * Each lane claims, paces and dials only its own contacts, with its
 * own concurrency and CPS. A slow Sarvam cannot starve Cartesia, and
 * — because the claim query filters on `assigned_provider` and the
 * database refuses a mismatched attempt — no lane can ever dial
 * another lane's contact.
 *
 * Lanes run concurrently and interleaved rather than one after
 * another. That is a correctness requirement for the comparison this
 * campaign exists to produce: draining Cartesia first and Smallest AI
 * last would measure time-of-day answer rates and attribute the
 * difference to the vendor.
 *
 * MUST run in the same process as the media bridges: the session
 * manager is in-memory on `globalThis`, and the answer webhook and
 * audio WebSocket have to land on the process that owns the session.
 * The dispatcher lock enforces one dispatcher per campaign.
 */

import { getDispatchConfig, type DispatchConfig } from "../config/dispatch.config";
import {
  acquireDispatcherLock,
  campaignProgress,
  claimContacts,
  countPendingContacts,
  heartbeatDispatcherLock,
  logEvent,
  recoverOrphans,
  releaseContact,
  releaseDispatcherLock,
} from "../db/repositories/call-attempt.repo";
import { getCampaign, setCampaignStatus } from "../db/repositories/campaign.repo";
import { countContactsByProvider, countContactsMissingName } from "../db/repositories/contact.repo";
import { withTransaction } from "../db/client";
import { findScript } from "../script/script-registry";
import { validateCampaignScript } from "../script/script-validation";
import { CAMPAIGN_TTS_PROVIDERS, type CampaignTtsProvider, type CampaignRecord } from "../domain/campaign-types";
import { LaneGate, Semaphore, TokenBucket } from "./concurrency";
import { SessionObserver } from "./session-observer";
import { runCall, type ManagerLike } from "./call-runner";

export type DispatcherState = "IDLE" | "RUNNING" | "PAUSING" | "PAUSED" | "STOPPING" | "STOPPED";

/**
 * Exactly what the dispatcher needs from the voice agent: the existing
 * public lifecycle methods plus the existing state hook. Structural,
 * so `DefaultVoiceSessionManager` satisfies it without being modified
 * or wrapped.
 */
export type DispatchManager = ManagerLike & ConstructorParameters<typeof SessionObserver>[0];

export interface DispatcherStatus {
  readonly campaignId: string;
  readonly state: DispatcherState;
  readonly dialingEnabled: boolean;
  readonly callsPlacedThisRun: number;
  readonly stageMaxCalls: number;
  readonly lanes: Readonly<Record<string, { active: number; placed: number; available: number }>>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CampaignDispatcher {
  private state: DispatcherState = "IDLE";

  /** Read through a method so TypeScript does not narrow the field to
   *  whatever was last assigned inside `run()`. */
  private currentState(): DispatcherState {
    return this.state;
  }

  private callsPlacedThisRun = 0;
  private readonly placedByLane = new Map<string, number>();
  private readonly gates = new Map<CampaignTtsProvider, LaneGate>();
  private readonly observer: SessionObserver;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lanePromises: Promise<void>[] = [];

  constructor(
    private readonly campaignId: string,
    private readonly manager: DispatchManager,
    private readonly config: DispatchConfig = getDispatchConfig(),
    observer?: SessionObserver,
  ) {
    this.observer = observer ?? new SessionObserver(manager);

    const globalSemaphore = new Semaphore(config.globalMaxConcurrent);
    const globalBucket = new TokenBucket(config.globalCallsPerSecond);
    for (const provider of CAMPAIGN_TTS_PROVIDERS) {
      const limits = config.lanes[provider];
      this.gates.set(
        provider,
        new LaneGate(
          new Semaphore(limits.maxConcurrent),
          new TokenBucket(limits.callsPerSecond),
          globalSemaphore,
          globalBucket,
        ),
      );
      this.placedByLane.set(provider, 0);
    }
  }

  getStatus(): DispatcherStatus {
    const lanes: Record<string, { active: number; placed: number; available: number }> = {};
    for (const [provider, gate] of this.gates) {
      lanes[provider] = {
        active: gate.active,
        placed: this.placedByLane.get(provider) ?? 0,
        available: gate.available,
      };
    }
    return {
      campaignId: this.campaignId,
      state: this.state,
      dialingEnabled: this.config.dialingEnabled,
      callsPlacedThisRun: this.callsPlacedThisRun,
      stageMaxCalls: this.config.stageMaxCalls,
      lanes,
    };
  }

  /**
   * Everything that must be true before a single call is placed. Run
   * before the lock is taken, so a campaign that cannot dial does not
   * lock out a later, valid attempt.
   */
  async preflight(): Promise<{ ok: boolean; campaign?: CampaignRecord; blockers: string[] }> {
    const campaign = await getCampaign(this.campaignId);
    if (!campaign) return { ok: false, blockers: ["Campaign not found."] };

    const blockers: string[] = [];
    if (campaign.status !== "READY" && campaign.status !== "PAUSED") {
      blockers.push(`Campaign status is ${campaign.status}; it must be READY or PAUSED to run.`);
    }

    const [assigned, missingName] = await Promise.all([
      countContactsByProvider(this.campaignId),
      countContactsMissingName(this.campaignId),
    ]);
    if ([...assigned.values()].reduce((a, b) => a + b, 0) === 0) {
      blockers.push("No contacts have been imported.");
    }

    const check = validateCampaignScript({
      campaignType: campaign.campaignType,
      scriptId: campaign.scriptId,
      scriptVersion: campaign.scriptVersion,
      scriptHash: campaign.scriptHash,
      allocatedProviders: [...assigned.keys()],
      contactsMissingName: missingName,
    });
    blockers.push(...check.blockers);

    return { ok: blockers.length === 0, campaign, blockers };
  }

  /**
   * Starts the run. Resolves once every lane has drained, the stage
   * cap is reached, or pause/stop is requested.
   */
  async run(): Promise<DispatcherStatus> {
    if (this.currentState() === "RUNNING") return this.getStatus();

    const { ok, campaign, blockers } = await this.preflight();
    if (!ok || !campaign) {
      throw new Error(`Campaign cannot run:\n  - ${blockers.join("\n  - ")}`);
    }

    const script = findScript(campaign.scriptId, campaign.scriptVersion);
    if (!script) throw new Error(`Script "${campaign.scriptId} ${campaign.scriptVersion}" is missing.`);

    // One dispatcher per campaign, even across duplicate deploys.
    const owner = this.config.dispatcherId;
    const locked = await acquireDispatcherLock(this.campaignId, owner, this.config.lockStaleSeconds);
    if (!locked) {
      throw new Error("Another dispatcher already holds this campaign. Refusing to run a second one.");
    }

    // Reconcile anything a previous crash left mid-flight. Never
    // re-dials blind — orphans are closed and re-queued by policy.
    const recovered = await recoverOrphans(this.campaignId);
    if (recovered.attempts > 0 || recovered.contacts > 0) {
      await logEvent(this.campaignId, "RECOVERY", "Reconciled state left by a previous run", recovered, "warn");
    }

    this.state = "RUNNING";
    this.callsPlacedThisRun = 0;
    await withTransaction((client) => setCampaignStatus(client, this.campaignId, "RUNNING"));
    await logEvent(this.campaignId, "DISPATCH_STARTED", "Dispatcher started", {
      dialingEnabled: this.config.dialingEnabled,
      stageMaxCalls: this.config.stageMaxCalls,
      owner,
    });

    this.heartbeat = setInterval(() => {
      void heartbeatDispatcherLock(this.campaignId, owner).catch(() => undefined);
    }, 15_000);

    try {
      this.lanePromises = CAMPAIGN_TTS_PROVIDERS.map((provider) =>
        this.runLane(provider, campaign, script),
      );
      await Promise.all(this.lanePromises);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      await this.settleCampaignStatus();
      await releaseDispatcherLock(this.campaignId, owner).catch(() => undefined);
      this.observer.dispose();
      const settled = this.currentState();
      this.state = settled === "STOPPING" ? "STOPPED" : settled === "PAUSING" ? "PAUSED" : "IDLE";
    }

    return this.getStatus();
  }

  /** One provider's loop. Claims only its own contacts, forever its own. */
  private async runLane(
    provider: CampaignTtsProvider,
    campaign: CampaignRecord,
    script: NonNullable<ReturnType<typeof findScript>>,
  ): Promise<void> {
    const gate = this.gates.get(provider);
    if (!gate) return;
    const inFlight = new Set<Promise<void>>();

    while (this.currentState() === "RUNNING") {
      if (this.callsPlacedThisRun >= this.config.stageMaxCalls) break;

      const room = Math.min(
        gate.available,
        this.config.claimBatchSize,
        this.config.stageMaxCalls - this.callsPlacedThisRun,
      );

      if (room <= 0) {
        await wait(this.config.pollIntervalMs);
        continue;
      }

      const claimed = await claimContacts(campaign.id, provider, room, this.config.dispatcherId);

      if (claimed.length === 0) {
        // Nothing claimable. If nothing is in flight and nothing is
        // waiting, this lane is finished; otherwise a retry may become
        // due later, so wait rather than exiting early.
        if (inFlight.size === 0 && (await countPendingContacts(campaign.id, provider)) === 0) break;
        await wait(this.config.pollIntervalMs);
        continue;
      }

      for (const contact of claimed) {
        // Counted at claim time so a burst of parallel starts cannot
        // collectively overshoot the stage cap.
        this.callsPlacedThisRun += 1;
        this.placedByLane.set(provider, (this.placedByLane.get(provider) ?? 0) + 1);
        const claimedAt = Date.now();

        const task = (async () => {
          await gate.acquire();
          try {
            if (this.currentState() !== "RUNNING") {
              await releaseContact(contact.id, "PENDING");
              return;
            }
            await runCall(contact, {
              manager: this.manager,
              observer: this.observer,
              config: this.config,
              campaign,
              script,
            }, claimedAt);
          } catch (error) {
            await logEvent(
              campaign.id,
              "CALL_RUNNER_CRASH",
              error instanceof Error ? error.message : String(error),
              { contactId: contact.id, provider },
              "error",
            );
            await releaseContact(contact.id, "PENDING").catch(() => undefined);
          } finally {
            gate.release();
          }
        })();

        inFlight.add(task);
        void task.finally(() => inFlight.delete(task));
      }
    }

    // Let in-flight calls finish rather than cutting them off.
    await Promise.allSettled([...inFlight]);
  }

  /** Pause stops new claims; calls already in flight are allowed to finish. */
  pause(): void {
    if (this.currentState() === "RUNNING") this.state = "PAUSING";
  }

  /** Stop is the same, plus the campaign is marked STOPPED. */
  stop(): void {
    const current = this.currentState();
    if (current === "RUNNING" || current === "PAUSING") this.state = "STOPPING";
  }

  private async settleCampaignStatus(): Promise<void> {
    const remaining = await countPendingContacts(this.campaignId);
    const settled = this.currentState();
    const next =
      settled === "STOPPING" ? "STOPPED" : settled === "PAUSING" ? "PAUSED" : remaining === 0 ? "COMPLETED" : "READY";
    await withTransaction((client) => setCampaignStatus(client, this.campaignId, next));
    await logEvent(this.campaignId, "DISPATCH_FINISHED", `Dispatcher finished as ${next}`, {
      callsPlacedThisRun: this.callsPlacedThisRun,
      remaining,
    });
  }
}

// ── Process-wide registry ─────────────────────────────────────────
// Pinned to globalThis for the same reason the runtime is: Next's dev
// reloading would otherwise create a second dispatcher for a campaign
// that already has one running.

declare global {
  // eslint-disable-next-line no-var
  var __campaignDispatchers: Map<string, CampaignDispatcher> | undefined;
}

function registry(): Map<string, CampaignDispatcher> {
  globalThis.__campaignDispatchers ??= new Map();
  return globalThis.__campaignDispatchers;
}

export function getDispatcher(campaignId: string): CampaignDispatcher | undefined {
  return registry().get(campaignId);
}

export function registerDispatcher(campaignId: string, dispatcher: CampaignDispatcher): void {
  registry().set(campaignId, dispatcher);
}

export function unregisterDispatcher(campaignId: string): void {
  registry().delete(campaignId);
}

export { campaignProgress };
