/**
 * calling-window.ts
 *
 * The hours a campaign is allowed to dial in.
 *
 * Phase 6 found this missing: every other limit in the campaign layer
 * existed — concurrency, CPS, the call ceiling, the retry cap — but
 * nothing stopped a run from starting at 03:00, and a reminder campaign
 * that rings two thousand people at three in the morning is not a
 * performance problem, it is a compliance one.
 *
 * Deliberately its own module, read through the same
 * `providers/shared/env` helpers as every other campaign limit, and
 * evaluated by a PURE function so the decision can be tested at any
 * hour of any day without touching the clock. The dispatcher is not
 * modified: `run-launcher` refuses to start outside the window, and
 * `calling-window-watcher` drives the existing public `pause()` when a
 * window closes underneath a running campaign.
 *
 * The window is a CEILING on when calls may go out, never an
 * instruction to place them: nothing here starts a run.
 */

import { optionalEnv } from "../../providers/shared/env";

export interface CallingWindow {
  /** Minutes past local midnight, inclusive. */
  readonly startMinute: number;
  /** Minutes past local midnight, exclusive. */
  readonly endMinute: number;
  /** IANA zone the two figures above are expressed in. */
  readonly timeZone: string;
  /** Permitted weekdays, 0 = Sunday .. 6 = Saturday. */
  readonly days: readonly number[];
  /**
   * When false the window is still reported everywhere, and refuses
   * nothing. Off is a deliberate, visible operator decision rather
   * than the absence of a setting.
   */
  readonly enforced: boolean;
  /** Verbatim environment strings, so a misconfiguration can be quoted back. */
  readonly raw: {
    readonly start: string;
    readonly end: string;
    readonly days: string;
    readonly timeZone: string;
  };
}

export const CALLING_WINDOW_DEFAULTS = {
  start: "10:00",
  end: "20:00",
  timeZone: "Asia/Kolkata",
  /** All seven days. Narrow it per deployment; this file will not guess. */
  days: "0,1,2,3,4,5,6",
} as const;

/** "09:30" -> 570. Returns undefined for anything that is not HH:MM. */
export function parseClockMinute(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

export function formatClockMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseDays(value: string): readonly number[] {
  const days = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

export function getCallingWindow(): CallingWindow {
  const rawStart = optionalEnv("CAMPAIGN_CALLING_WINDOW_START", CALLING_WINDOW_DEFAULTS.start);
  const rawEnd = optionalEnv("CAMPAIGN_CALLING_WINDOW_END", CALLING_WINDOW_DEFAULTS.end);
  const rawDays = optionalEnv("CAMPAIGN_CALLING_WINDOW_DAYS", CALLING_WINDOW_DEFAULTS.days);
  const rawZone = optionalEnv("CAMPAIGN_CALLING_WINDOW_TIMEZONE", CALLING_WINDOW_DEFAULTS.timeZone);

  // An unparsable bound falls back to the DEFAULT rather than to "no
  // window": a typo must never widen the hours people can be called
  // in. `validateCallingWindow` reports the typo separately so it gets
  // fixed rather than silently absorbed.
  const startMinute =
    parseClockMinute(rawStart) ?? parseClockMinute(CALLING_WINDOW_DEFAULTS.start) ?? 600;
  const endMinute =
    parseClockMinute(rawEnd) ?? parseClockMinute(CALLING_WINDOW_DEFAULTS.end) ?? 1200;
  const days = parseDays(rawDays);

  return {
    startMinute,
    endMinute,
    timeZone: rawZone,
    days: days.length > 0 ? days : parseDays(CALLING_WINDOW_DEFAULTS.days),
    enforced: optionalEnv("CAMPAIGN_CALLING_WINDOW_ENFORCED", "true") !== "false",
    raw: { start: rawStart, end: rawEnd, days: rawDays, timeZone: rawZone },
  };
}

export interface LocalClock {
  readonly minuteOfDay: number;
  readonly weekday: number;
  readonly label: string;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The wall clock in the window's own time zone.
 *
 * Uses `Intl` rather than offset arithmetic of our own, so IST's
 * half-hour offset and any future daylight change are the platform's
 * problem and not a hand-rolled bug. Throws only on an invalid zone,
 * which `validateCallingWindow` checks for separately.
 */
export function localClock(window: CallingWindow, at: Date): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // Some ICU versions render midnight as "24" under hour12:false.
  const hour = Number(value("hour")) % 24;
  const minute = Number(value("minute"));
  const weekday = WEEKDAY_INDEX[value("weekday")] ?? 0;

  return {
    minuteOfDay: hour * 60 + minute,
    weekday,
    label: `${value("weekday")} ${String(hour).padStart(2, "0")}:${value("minute")} ${window.timeZone}`,
  };
}

export interface WindowVerdict {
  readonly open: boolean;
  /** Why, in a sentence an operator can act on. */
  readonly reason: string;
  readonly clock: LocalClock;
}

/**
 * Is the window open at `at`?
 *
 * A window whose end is not after its start (a wrap past midnight) is
 * reported CLOSED here rather than interpreted. Interpreting it would
 * mean guessing whether the operator meant "22:00 to 06:00" or made a
 * typo, and the safe reading of an ambiguous instruction about calling
 * people at night is not to call them. `validateCallingWindow` reports
 * it as a configuration error so it gets fixed.
 */
export function isCallingWindowOpen(window: CallingWindow, at: Date = new Date()): WindowVerdict {
  const clock = localClock(window, at);

  if (!window.enforced) {
    return {
      open: true,
      reason: `Calling window is NOT enforced (CAMPAIGN_CALLING_WINDOW_ENFORCED=false). Local time is ${clock.label}.`,
      clock,
    };
  }
  if (window.endMinute <= window.startMinute) {
    return {
      open: false,
      reason:
        `Calling window is misconfigured: end (${formatClockMinute(window.endMinute)}) is not after ` +
        `start (${formatClockMinute(window.startMinute)}). Refusing to interpret a window that wraps midnight.`,
      clock,
    };
  }
  if (!window.days.includes(clock.weekday)) {
    return {
      open: false,
      reason:
        `${WEEKDAY_NAMES[clock.weekday]} is not a permitted calling day ` +
        `(CAMPAIGN_CALLING_WINDOW_DAYS=${window.raw.days}). Local time is ${clock.label}.`,
      clock,
    };
  }
  if (clock.minuteOfDay < window.startMinute || clock.minuteOfDay >= window.endMinute) {
    return {
      open: false,
      reason: `Outside the calling window ${describeCallingWindow(window)}. Local time is ${clock.label}.`,
      clock,
    };
  }
  return {
    open: true,
    reason: `Inside the calling window ${describeCallingWindow(window)}. Local time is ${clock.label}.`,
    clock,
  };
}

export function describeCallingWindow(window: CallingWindow): string {
  const days =
    window.days.length === 7 ? "every day" : window.days.map((day) => WEEKDAY_NAMES[day]).join(",");
  return `${formatClockMinute(window.startMinute)}-${formatClockMinute(window.endMinute)} ${window.timeZone} (${days})`;
}

export interface CallingWindowValidation {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Configuration errors in the window itself, separate from whether it
 * happens to be open right now.
 */
export function validateCallingWindow(window: CallingWindow): CallingWindowValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (parseClockMinute(window.raw.start) === undefined) {
    blockers.push(
      `CAMPAIGN_CALLING_WINDOW_START="${window.raw.start}" is not HH:MM; the default ${CALLING_WINDOW_DEFAULTS.start} is in force.`,
    );
  }
  if (parseClockMinute(window.raw.end) === undefined) {
    blockers.push(
      `CAMPAIGN_CALLING_WINDOW_END="${window.raw.end}" is not HH:MM; the default ${CALLING_WINDOW_DEFAULTS.end} is in force.`,
    );
  }
  if (window.endMinute <= window.startMinute) {
    blockers.push(
      `Calling window end (${formatClockMinute(window.endMinute)}) must be after its start ` +
        `(${formatClockMinute(window.startMinute)}). A window that wraps midnight is refused, not interpreted.`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone }).format(new Date(0));
  } catch {
    blockers.push(
      `CAMPAIGN_CALLING_WINDOW_TIMEZONE="${window.timeZone}" is not a valid IANA time zone.`,
    );
  }
  if (window.days.length === 0) {
    blockers.push(`CAMPAIGN_CALLING_WINDOW_DAYS="${window.raw.days}" contains no valid weekday (0-6).`);
  }
  if (!window.enforced) {
    warnings.push(
      "CAMPAIGN_CALLING_WINDOW_ENFORCED=false — nothing will stop this campaign dialling at any hour.",
    );
  }
  if (window.endMinute - window.startMinute > 13 * 60) {
    warnings.push(
      `The calling window spans ${((window.endMinute - window.startMinute) / 60).toFixed(1)} hours. ` +
        "Confirm that is within the regulations for the numbers being called.",
    );
  }

  return { ok: blockers.length === 0, blockers, warnings };
}
