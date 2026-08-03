/**
 * async-queue.ts
 *
 * A minimal async push/pull queue implementing `AsyncIterable<T>`.
 * Used as the inbound-audio source for a session when its
 * `TelephonyProvider` does not (yet) implement the optional
 * `openMediaStream` streaming capability — callers push audio in
 * via `push()` (from wherever real-time audio eventually arrives:
 * a websocket bridge, a webhook, a test harness) and the pipeline
 * consumes it the same way it would consume a real media stream.
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          const value = this.buffered.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}
