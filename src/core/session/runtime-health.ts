/**
 * runtime-health.ts
 *
 * TELEMETRY ONLY (P0 #2, 2026-10-01). How long the Node event loop was
 * blocked during one call, and how much of it was garbage collection.
 *
 * WHY. Call 64f54e00: the media bridge's 20ms pump reported frames up to
 * 1.8s late, three times, each at the start of a long reply — the event
 * loop was blocked and the caller heard the voice break. A read of the
 * reply path found nothing that costs more than ~30ms, so the cause is
 * outside the app code that was read: GC after the TTS-cache warm-up,
 * synchronous stdout, dev-mode compilation, or CPU starvation. This
 * records which, per call, into `call_metrics.raw.runtime`.
 *
 * Nothing reads it to decide anything. The histogram is Node's own
 * (`monitorEventLoopDelay`, sampled in libuv, not on the JS thread); the
 * GC observer is one process-wide listener that adds entries to whichever
 * probes are running. A probe that is never stopped stays cheap, and
 * `stop()` is idempotent.
 */

import { monitorEventLoopDelay, PerformanceObserver, type IntervalHistogram } from "node:perf_hooks";

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
}

/** Longer than any call (the watchdog's max duration is well under this). */
const MAX_PROBE_LIFETIME_MS = 30 * 60 * 1000;

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

export class RuntimeHealthProbe {
  private histogram: IntervalHistogram | undefined;
  private gcCount = 0;
  private gcTotalMs = 0;
  private gcMaxMs = 0;
  private frozen: RuntimeHealthRecord | undefined;

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
    // A session that never reaches `markCallEnded` (a failed warm-up, a
    // crash) must not keep a histogram running for the life of the process.
    setTimeout(() => this.stop(), MAX_PROBE_LIFETIME_MS).unref();
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
    return {
      loopMaxMs: h !== undefined ? nsToMs(h.max) : 0,
      loopP99Ms: h !== undefined ? nsToMs(h.percentile(99)) : 0,
      loopMeanMs: h !== undefined && Number.isFinite(h.mean) ? nsToMs(h.mean) : 0,
      gcCount: this.gcCount,
      gcTotalMs: Math.round(this.gcTotalMs),
      gcMaxMs: Math.round(this.gcMaxMs),
      nodeEnv: process.env.NODE_ENV ?? "unset",
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }

  stop(): void {
    if (this.frozen !== undefined) return;
    this.frozen = this.snapshot();
    this.histogram?.disable();
    this.histogram = undefined;
    active.delete(this);
  }
}
