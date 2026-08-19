/**
 * ui.tsx — presentation primitives for the campaign screens.
 *
 * Presentation only. Nothing here fetches, mutates, computes a rate or
 * decides what a number means; every component receives a finished
 * value and is responsible purely for how it reads on screen.
 *
 * The vocabulary is deliberately small, because the campaign page's
 * old problem was not a lack of components but a lack of repetition:
 * seven cards each inventing their own label size. One StatCard, one
 * DataTable, one Callout, one EmptyState, used everywhere.
 */

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/* ── Section shell ────────────────────────────────────────────────── */

/**
 * One band of the page. The eyebrow carries the sequence ("01") so the
 * screen still reads as an ordered workflow without a numbered bullet
 * competing with the heading for attention.
 */
export function Section({
  eyebrow,
  title,
  description,
  children,
  id,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-1">
        {eyebrow ? (
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">
            {eyebrow}
          </span>
        ) : null}
        <h2 className="text-[17px] font-semibold leading-tight tracking-tight text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A small uppercase label above a group inside a card. */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Status ───────────────────────────────────────────────────────── */

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-subtle-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-accent",
};

const PILL_TONE: Record<Tone, string> = {
  neutral: "border-border-strong bg-surface-hover text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/25 bg-danger/10 text-danger",
  info: "border-accent/25 bg-accent/10 text-accent",
};

/** A status chip: coloured dot, then the label. Never colour alone. */
export function StatusPill({
  tone = "neutral",
  children,
  pulse = false,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium leading-4",
        PILL_TONE[tone],
        className,
      )}
    >
      <span className="relative flex size-1.5 shrink-0 items-center justify-center">
        {pulse ? (
          <span
            className={cn("absolute inline-flex size-1.5 animate-ping rounded-full opacity-60", DOT_TONE[tone])}
          />
        ) : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", DOT_TONE[tone])} />
      </span>
      {children}
    </span>
  );
}

/** A quiet key/value chip for header metadata. */
export function MetaChip({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-subtle-foreground">
        {label}
      </span>
      <span
        className={cn(
          "truncate text-[12.5px] font-medium text-foreground",
          mono && "font-mono text-[12px]",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Metrics ──────────────────────────────────────────────────────── */

const STAT_ACCENT: Record<Tone, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-accent",
};

/**
 * A metric tile: small muted label, large tabular number, optional
 * one-line hint. The number is the thing being scanned for, so it is
 * the only element with any weight.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-hover/40 px-3.5 py-3",
        className,
      )}
    >
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[21px] font-semibold leading-none tabular-nums",
          STAT_ACCENT[tone],
        )}
      >
        {value}
      </span>
      {hint ? (
        <span className="truncate text-[11px] leading-4 text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

/** Responsive metric grid: never narrower than a readable tile. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Callout ──────────────────────────────────────────────────────── */

const CALLOUT_TONE: Record<Tone, string> = {
  neutral: "border-border-strong bg-surface-hover/60",
  success: "border-success/25 bg-success/[0.07]",
  warning: "border-warning/25 bg-warning/[0.07]",
  danger: "border-danger/25 bg-danger/[0.07]",
  info: "border-accent/25 bg-accent/[0.07]",
};

const CALLOUT_ICON_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-accent",
};

const CALLOUT_ICON: Record<Tone, typeof Info> = {
  neutral: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
  info: Info,
};

/**
 * A single-line headline with secondary detail underneath. The headline
 * is a plain sentence, not shouted, and the detail is where the
 * environment-variable-level truth lives.
 */
export function Callout({
  tone = "neutral",
  title,
  children,
  action,
  role = "status",
}: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div
      role={role}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3.5 py-3",
        CALLOUT_TONE[tone],
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", CALLOUT_ICON_TONE[tone])} aria-hidden />
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
        <p className="text-[13px] font-medium leading-snug tracking-tight text-foreground">{title}</p>
        {children ? (
          <div className="text-[12px] leading-relaxed text-muted-foreground">{children}</div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/* ── Empty state ──────────────────────────────────────────────────── */

/** A named absence: what is missing, and what would fill it. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon?: typeof Info;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-8 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-hover text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
      ) : null}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {hint ? <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ── Table ────────────────────────────────────────────────────────── */

export interface Column {
  readonly key: string;
  readonly header: string;
  /** Right-aligned by default for numeric columns. */
  readonly align?: "left" | "right";
  /** Shown as help text under the header group rather than in the cell. */
  readonly hint?: string;
}

/**
 * The one table on the page. Horizontal scroll is contained inside the
 * card, so a twelve-column comparison never widens the document.
 */
export function DataTable({
  columns,
  rows,
  empty,
  className,
}: {
  columns: readonly Column[];
  rows: readonly (readonly ReactNode[])[];
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="No data yet" />}</>;
  }
  return (
    <div className={cn("-mx-1 overflow-x-auto rounded-lg border border-border", className)}>
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead>
          <tr className="bg-surface-hover/60">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                title={column.hint}
                className={cn(
                  "whitespace-nowrap px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-subtle-foreground",
                  column.align === "right" ? "text-right" : "text-left",
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-t border-border transition-colors hover:bg-surface-hover/40"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 tabular-nums text-foreground",
                    columns[cellIndex]?.align === "right" ? "text-right" : "text-left",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The provider cell: the comparison variable, so it is never muted. */
export function ProviderCell({ provider }: { provider: string }) {
  return (
    <span className="flex items-center gap-2 font-medium text-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-accent/70" aria-hidden />
      {provider}
    </span>
  );
}

/* ── Progressive disclosure ───────────────────────────────────────── */

/**
 * The long-form explanation, folded. The text is preserved verbatim —
 * only its claim on the reader's attention is reduced.
 */
export function Note({ summary = "How to read this", children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-surface-hover/25 px-3.5 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <svg
          viewBox="0 0 12 12"
          className="size-3 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        >
          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
