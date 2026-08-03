import type { ReactNode } from "react";

interface MetricRowProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
}

/**
 * A single stat tile: label is secondary (small, muted, uppercase),
 * value is the visual focus (large, tabular, high-contrast) — the
 * inverse emphasis of a typical form row, appropriate for a metrics
 * surface where the number is what the reader scans for.
 */
export function MetricRow({ label, value, hint }: MetricRowProps) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-subtle-foreground">
        {label}
      </span>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-xl font-semibold tabular-nums leading-none text-foreground">
          {value}
        </span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
