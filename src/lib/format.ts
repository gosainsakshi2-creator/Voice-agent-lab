/**
 * format.ts
 *
 * Pure presentation-layer formatting helpers for the Benchmark
 * Dashboard. No business logic — these only transform already
 * computed values (from BenchmarkMetrics, SessionSnapshot, etc.)
 * into display strings.
 */

export function formatMs(milliseconds: number): string {
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(2)}s`;
  }
  return `${Math.round(milliseconds)}ms`;
}

export function formatDurationSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${amount.toFixed(4)} ${currency}`;
  }
}

export function formatClockTime(date: Date): string {
  console.log("formatClockTime received:", date);

  const d = new Date(date);

  console.log("converted:", d, d.getTime());

  if (isNaN(d.getTime())) {
    return "--:--:--";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
