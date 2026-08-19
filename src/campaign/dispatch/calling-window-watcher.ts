/**
 * calling-window-watcher.ts
 *
 * Pauses a running campaign when its calling window closes.
 *
 * Deliberately built the same way `control-watcher.ts` is: a separate
 * object that DRIVES the dispatcher through its existing public
 * `pause()` rather than a change inside the dispatcher. The Phase 4
 * dispatcher is verified and running; if this watcher were deleted
 * tomorrow the dispatcher would behave exactly as it does now.
 *
 * Like the control watcher, it only ever moves a campaign towards
 * stopping. There is no path here that starts a run or resumes one when
 * the window reopens — a resume is a new run, requested explicitly,
 * through the same preflight and the same dispatcher lock. That
 * asymmetry is on purpose: nobody should discover at 10:00 that a
 * campaign they paused last night has begun dialling on a timer.
 *
 * Calls already in flight are NOT cut off, because `pause()` does not
 * cut them off. Ending a conversation mid-sentence at 20:00:00 would be
 * a worse experience than letting a two-minute call finish, and the
 * per-call watchdog still bounds how long that can be.
 */

import {
  describeCallingWindow,
  getCallingWindow,
  isCallingWindowOpen,
  type CallingWindow,
} from "../config/calling-window";
import { optionalEnvNumber } from "../../providers/shared/env";
import type { ControllableDispatcher } from "./control-watcher";

export interface CallingWindowWatcherOptions {
  readonly pollIntervalMs?: number;
  readonly window?: CallingWindow;
  /** Injected in tests so the watcher can be driven without waiting for a real hour. */
  readonly now?: () => Date;
  readonly onClose?: (reason: string) => void;
}

export class CallingWindowWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pausedForWindow = false;

  constructor(
    private readonly dispatcher: ControllableDispatcher,
    private readonly options: CallingWindowWatcherOptions = {},
  ) {}

  private get window(): CallingWindow {
    return this.options.window ?? getCallingWindow();
  }

  /**
   * Checks the clock once and pauses if the window has closed.
   *
   * Pauses at most once per watcher: a dispatcher that is already
   * pausing does not need to be told again every thirty seconds, and a
   * repeated `pause()` would put a `PAUSING` state back over a
   * `STOPPING` one that an operator asked for in the meantime.
   */
  poll(): "paused" | "already-paused" | "open" {
    const verdict = isCallingWindowOpen(this.window, this.options.now?.() ?? new Date());
    if (verdict.open) return "open";
    if (this.pausedForWindow) return "already-paused";

    this.pausedForWindow = true;
    this.dispatcher.pause();
    this.options.onClose?.(verdict.reason);
    return "paused";
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.pollIntervalMs ?? optionalEnvNumber("CAMPAIGN_WINDOW_POLL_MS", 30_000);
    // Read once immediately for the same reason the control watcher
    // does: a window that is already closed must not allow one poll
    // interval — and a batch of calls — before it takes effect.
    this.poll();
    this.timer = setInterval(() => this.poll(), interval);
    // Never hold the process open on the watcher's account.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  describe(): string {
    return describeCallingWindow(this.window);
  }
}
