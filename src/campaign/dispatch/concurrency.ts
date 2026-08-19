/**
 * concurrency.ts
 *
 * Per-lane concurrency and calls-per-second, plus the global caps that
 * sit above them.
 *
 * Two limits, not one, because they bound different resources. The
 * semaphore bounds how many calls are LIVE at once — Deepgram sockets,
 * telephony channels, and the event-loop budget every concurrent audio
 * pump competes for. The token bucket bounds how fast new calls START,
 * which is what carriers rate-limit. A lane can be under its
 * concurrency cap and still have to wait for a CPS token.
 */

export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  get available(): number {
    return Math.max(0, this.capacity - this.inUse);
  }

  get active(): number {
    return this.inUse;
  }

  async acquire(): Promise<void> {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inUse += 1;
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Calls-per-second limiter. Refills continuously rather than in
 * one-second steps, so a lane configured at 1 CPS paces evenly instead
 * of firing a burst on each tick.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = Math.max(1, Math.ceil(ratePerSecond)),
  ) {
    this.tokens = this.burst;
  }

  private refill(now: number): void {
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefill = now;
  }

  /** Resolves once a token is available. Never rejects. */
  async take(): Promise<void> {
    // A non-positive rate means "no CPS limit configured"; the
    // semaphore is still in force, so this cannot become unbounded.
    if (this.ratePerSecond <= 0) return;
    for (;;) {
      this.refill(Date.now());
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((deficit / this.ratePerSecond) * 1000));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** A lane's own limits plus the shared global ones. */
export class LaneGate {
  constructor(
    private readonly laneSemaphore: Semaphore,
    private readonly laneBucket: TokenBucket,
    private readonly globalSemaphore: Semaphore,
    private readonly globalBucket: TokenBucket,
  ) {}

  /** How many more calls this lane may start right now. */
  get available(): number {
    return Math.min(this.laneSemaphore.available, this.globalSemaphore.available);
  }

  get active(): number {
    return this.laneSemaphore.active;
  }

  async acquire(): Promise<void> {
    await this.globalBucket.take();
    await this.laneBucket.take();
    await this.globalSemaphore.acquire();
    await this.laneSemaphore.acquire();
  }

  release(): void {
    this.laneSemaphore.release();
    this.globalSemaphore.release();
  }
}
