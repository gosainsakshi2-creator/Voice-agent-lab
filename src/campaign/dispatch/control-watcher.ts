/**
 * control-watcher.ts
 *
 * Makes a durable PAUSE or STOP reach a dispatcher that is already
 * running, in whichever process happens to hold it.
 *
 * Deliberately a separate module that DRIVES the dispatcher through
 * its existing public `pause()` and `stop()` rather than a change
 * inside it. The Phase 4 dispatcher is verified and running; this adds
 * a second way to reach the same two methods, and if the watcher were
 * deleted tomorrow the dispatcher would behave exactly as it does now.
 *
 * The watcher only ever moves a campaign towards stopping. There is no
 * path here that starts a run, raises a limit, or resumes anything: a
 * resume is a new run, requested explicitly, and it goes through the
 * same preflight and the same dispatcher lock as any other start.
 */

import { getControl, type CampaignControl, type ControlState } from "../db/repositories/control.repo";
import { optionalEnvNumber } from "../../providers/shared/env";

/** The two methods the watcher needs. `CampaignDispatcher` already has them. */
export interface ControllableDispatcher {
  pause(): void;
  stop(): void;
}

export interface ControlWatcherOptions {
  readonly pollIntervalMs?: number;
  /** Injected in tests so the watcher can be driven without a database. */
  readonly readControl?: (campaignId: string) => Promise<CampaignControl>;
  readonly onApply?: (state: ControlState, revision: number) => void;
}

/**
 * Applies one instruction to one dispatcher.
 *
 * Pure, synchronous and exported so the decision can be tested without
 * a timer, a database or a dispatcher. Returns what it did rather than
 * nothing, so a caller can log it truthfully.
 */
export function applyControl(
  dispatcher: ControllableDispatcher,
  state: ControlState,
): "paused" | "stopped" | "none" {
  if (state === "PAUSE") {
    dispatcher.pause();
    return "paused";
  }
  if (state === "STOP") {
    dispatcher.stop();
    return "stopped";
  }
  return "none";
}

export class CampaignControlWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastRevisionApplied = -1;
  private polling = false;

  constructor(
    private readonly campaignId: string,
    private readonly dispatcher: ControllableDispatcher,
    private readonly options: ControlWatcherOptions = {},
  ) {}

  /**
   * Reads the instruction once and applies it if it is new.
   *
   * A revision that has already been acted on is skipped, so a STOP
   * does not re-fire every two seconds for the rest of the run. A
   * repeated instruction arrives as a HIGHER revision and is applied
   * again — "stop, I mean it" is not a duplicate.
   */
  async poll(): Promise<"paused" | "stopped" | "none"> {
    if (this.polling) return "none";
    this.polling = true;
    try {
      const read = this.options.readControl ?? getControl;
      const control = await read(this.campaignId);
      if (control.revision <= this.lastRevisionApplied) return "none";
      this.lastRevisionApplied = control.revision;
      const applied = applyControl(this.dispatcher, control.desiredState);
      if (applied !== "none") this.options.onApply?.(control.desiredState, control.revision);
      return applied;
    } catch {
      // A database blip must not take down a running campaign. The
      // next tick reads the instruction again; nothing is lost,
      // because the instruction is a stored state rather than a
      // message that could have been consumed.
      return "none";
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const interval =
      this.options.pollIntervalMs ?? optionalEnvNumber("CAMPAIGN_CONTROL_POLL_MS", 2_000);
    // Read once immediately: a PAUSE issued while nothing was running
    // is already in force when the run starts, and must not wait out a
    // full poll interval — and a batch of calls, before taking effect.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), interval);
    // Never hold the process open on the watcher's account.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
