/**
 * runtime-health.ts
 *
 * TELEMETRY ONLY (P0 #2, 2026-10-01). How long the Node event loop was
 * blocked during one call, and WHY: garbage collection, our own CPU
 * work, or the container not getting CPU at all.
 *
 * WHY. Call 64f54e00: the media bridge's 20ms pump reported frames up to
 * 1.8s late, three times, each at the start of a long reply — the event
 * loop was blocked and the caller heard the voice break. Call 530e9440
 * then measured it: loopMaxMs 1505 with gcMaxMs 299 and NODE_ENV
 * production — not GC, not dev mode. What is left is our own CPU work
 * (synchronous logging included) or CPU throttling by the host. The
 * two look the same from inside the loop; they differ in CPU used:
 *
 *   stalls[].cpuMs ≈ gapMs   the process was RUNNING the whole time —
 *                            something synchronous in our code (or GC)
 *   stalls[].cpuMs ≪ gapMs   the process was NOT scheduled — the host
 *                            throttled it, which `cgroup` confirms
 *
 * `cgroup` is read from Linux cgroup v2 (`/sys/fs/cgroup/cpu.stat`,
 * `cpu.max`) where available: the container's CPU quota and how often,
 * and for how long, the kernel paused it during this call. Absent on
 * other systems.
 *
 * Nothing reads any of this to decide anything. The histogram is Node's
 * own (`monitorEventLoopDelay`), the GC observer is one process-wide
 * listener, and the stall watchdog is one unref'd 50ms interval per call.
 */

import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay, PerformanceObserver, type IntervalHistogram } from "node:perf_hooks";

export interface RuntimeStall {
  /** How long the loop did not run, ms. */
  readonly gapMs: number;
  /** CPU the process used (user + system) across that gap, ms. */
  readonly cpuMs: number;
  /** When it ended, ms since the call's probe started. */
  readonly atMs: number;
}

export interface CgroupCpuRecord {
  /** The container's CPU quota in cores (`cpu.max`); absent when unlimited. */
  readonly quotaCores?: number;
  /** Periods the kernel throttled the container during this call. */
  readonly throttledPeriods: number;
  /** Total time it was throttled during this call, ms. */
  readonly throttledMs: number;
}

export interface RuntimeHealthRecord {
  /** Worst event-loop delay seen during the call, ms. */
  readonly loopMaxMs: number;
  readonly loopP99Ms: number;
  readonly loopMeanMs: number;
  /** GC pauses while the call ran. */
  readonly gcCount: number;
  readonly gcTotalMs: number;
  readonly gcMaxMs: number;
  /** Was the server in production mode? Dev mode compiles routes on the main thread. */
  readonly nodeEnv: string;
  /** Resident memory at the end of the call, MB. */
  readonly rssMb: number;
  /** CPU the whole process used during the call, ms (all calls on this process share it). */
  readonly cpuMs: number;
  /** Loop stalls over `STALL_THRESHOLD_MS`: how many, and the worst few with their CPU. */
  readonly stallCount: number;
  readonly stalls: readonly RuntimeStall[];
  readonly cgroup?: CgroupCpuRecord;
}

/** Longer than any call (the watchdog's max duration is well under this). */
const MAX_PROBE_LIFETIME_MS = 30 * 60 * 1000;
/** The stall watchdog's tick. */
const WATCHDOG_TICK_MS = 50;
/** A tick this much later than due is a stall worth recording. */
const STALL_THRESHOLD_MS = 250;
/** How many of the worst stalls are kept. */
const MAX_STALLS_KEPT = 5;
/** How often `cpu.stat` is re-read. */
const CGROUP_READ_EVERY_MS = 5_000;

const active = new Set<RuntimeHealthProbe>();
let gcObserver: PerformanceObserver | undefined;

function ensureGcObserver(): void {
  if (gcObserver !== undefined) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        for (const probe of active) probe.noteGc(entry.duration);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    // A runtime without GC entries records none; nothing else changes.
    gcObserver = undefined;
  }
}

const nsToMs = (ns: number): number => Math.round(ns / 1e6);
const cpuNowMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

interface CgroupStat {
  readonly periods: number;
  readonly usec: number;
}

async function readCgroupStat(): Promise<CgroupStat | undefined> {
  try {
    const text = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    const field = (name: string): number | undefined => {
      const m = new RegExp(`^${name} (\\d+)$`, "m").exec(text);
      return m?.[1] !== undefined ? Number(m[1]) : undefined;
    };
    const periods = field("nr_throttled");
    const usec = field("throttled_usec");
    return periods !== undefined && usec !== undefined ? { periods, usec } : undefined;
  } catch {
    return undefined;
  }
}

async function readCgroupQuotaCores(): Promise<number | undefined> {
  try {
    const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim().split(/\s+/u);
    if (quota === undefined || quota === "max" || period === undefined) return undefined;
    const cores = Number(quota) / Number(period);
    return Number.isFinite(cores) && cores > 0 ? Math.round(cores * 100) / 100 : undefined;
  } catch {
    return undefined;
  }
}

export class RuntimeHealthProbe {
  private histogram: IntervalHistogram | undefined;
  private gcCount = 0;
  private gcTotalMs = 0;
  private gcMaxMs = 0;
  private frozen: RuntimeHealthRecord | undefined;

  private startedAtMs = 0;
  private cpuAtStartMs = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastTickAtMs = 0;
  private lastTickCpuMs = 0;
  private stallCount = 0;
  private stalls: RuntimeStall[] = [];

  private cgroupAtStart: CgroupStat | undefined;
  private cgroupLatest: CgroupStat | undefined;
  private quotaCores: number | undefined;
  private lastCgroupReadAtMs = 0;

  start(): void {
    if (this.histogram !== undefined || this.frozen !== undefined) return;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
    } catch {
      this.histogram = undefined;
    }
    ensureGcObserver();
    active.add(this);

    this.startedAtMs = Date.now();
    this.cpuAtStartMs = cpuNowMs();
    this.lastTickAtMs = this.startedAtMs;
    this.lastTickCpuMs = this.cpuAtStartMs;
    this.watchdog = setInterval(() => this.tick(), WATCHDOG_TICK_MS);
    this.watchdog.unref();
    void readCgroupStat().then((s) => {
      this.cgroupAtStart = s;
      this.cgroupLatest = s;
    });
    void readCgroupQuotaCores().then((q) => {
      this.quotaCores = q;
    });

    // A session that never reaches `markCallEnded` (a failed warm-up, a
    // crash) must not keep a histogram running for the life of the process.
    setTimeout(() => this.stop(), MAX_PROBE_LIFETIME_MS).unref();
  }

  private tick(): void {
    const now = Date.now();
    const cpu = cpuNowMs();
    const lateMs = now - this.lastTickAtMs - WATCHDOG_TICK_MS;
    if (lateMs >= STALL_THRESHOLD_MS) {
      this.stallCount += 1;
      const stall: RuntimeStall = {
        gapMs: Math.round(now - this.lastTickAtMs),
        cpuMs: Math.round(cpu - this.lastTickCpuMs),
        atMs: now - this.startedAtMs,
      };
      this.stalls.push(stall);
      this.stalls.sort((a, b) => b.gapMs - a.gapMs);
      if (this.stalls.length > MAX_STALLS_KEPT) this.stalls.length = MAX_STALLS_KEPT;
    }
    this.lastTickAtMs = now;
    this.lastTickCpuMs = cpu;
    if (now - this.lastCgroupReadAtMs >= CGROUP_READ_EVERY_MS && this.cgroupAtStart !== undefined) {
      this.lastCgroupReadAtMs = now;
      void readCgroupStat().then((s) => {
        if (s !== undefined && this.frozen === undefined) this.cgroupLatest = s;
      });
    }
  }

  /** Called by the shared GC observer. */
  noteGc(durationMs: number): void {
    this.gcCount += 1;
    this.gcTotalMs += durationMs;
    this.gcMaxMs = Math.max(this.gcMaxMs, durationMs);
  }

  /** The figures so far; after `stop()`, the figures at stop. */
  snapshot(): RuntimeHealthRecord {
    if (this.frozen !== undefined) return this.frozen;
    const h = this.histogram;
    const start = this.cgroupAtStart;
    const latest = this.cgroupLatest;
    return {
      loopMaxMs: h !== undefined ? nsToMs(h.max) : 0,
      loopP99Ms: h !== undefined ? nsToMs(h.percentile(99)) : 0,
      loopMeanMs: h !== undefined && Number.isFinite(h.mean) ? nsToMs(h.mean) : 0,
      gcCount: this.gcCount,
      gcTotalMs: Math.round(this.gcTotalMs),
      gcMaxMs: Math.round(this.gcMaxMs),
      nodeEnv: process.env.NODE_ENV ?? "unset",
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      cpuMs: this.startedAtMs === 0 ? 0 : Math.round(cpuNowMs() - this.cpuAtStartMs),
      stallCount: this.stallCount,
      stalls: [...this.stalls],
      ...(start !== undefined && latest !== undefined
        ? {
            cgroup: {
              ...(this.quotaCores !== undefined ? { quotaCores: this.quotaCores } : {}),
              throttledPeriods: latest.periods - start.periods,
              throttledMs: Math.round((latest.usec - start.usec) / 1000),
            },
          }
        : {}),
    };
  }

  stop(): void {
    if (this.frozen !== undefined) return;
    this.tick();
    this.frozen = this.snapshot();
    this.histogram?.disable();
    this.histogram = undefined;
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    active.delete(this);
  }
}
