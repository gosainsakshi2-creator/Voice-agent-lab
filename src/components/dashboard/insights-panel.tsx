import { Cable, Captions, Cpu, Volume2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricRow } from "@/components/dashboard/metric-row";
import { average, formatCurrency, formatDurationSeconds, formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BenchmarkMetrics } from "@/types/benchmark.types";
import type { ProviderDescriptor, ProviderHealthStatus } from "@/types/provider.types";
import { ProviderCategory } from "@/types/enums";

interface StackEntry {
  readonly categoryLabel: string;
  readonly icon: typeof Cable;
  readonly descriptor: ProviderDescriptor;
}

interface InsightsPanelProps {
  readonly stackEntries: readonly StackEntry[];
  readonly health: readonly ProviderHealthStatus[];
  readonly metrics: BenchmarkMetrics;
  readonly liveCallDurationSeconds: number;
  readonly isCallActive: boolean;
}

const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  [ProviderCategory.TELEPHONY]: "Telephony",
  [ProviderCategory.SPEECH_TO_TEXT]: "STT",
  [ProviderCategory.LANGUAGE_MODEL]: "LLM",
  [ProviderCategory.TEXT_TO_SPEECH]: "Voice",
};

export function InsightsPanel({
  stackEntries,
  health,
  metrics,
  liveCallDurationSeconds,
  isCallActive,
}: InsightsPanelProps) {
  const sttAvg = average(metrics.turnLatencies.map((t) => t.stt.milliseconds));
  const llmAvg = average(metrics.turnLatencies.map((t) => t.llm.milliseconds));
  const ttsAvg = average(metrics.turnLatencies.map((t) => t.tts.milliseconds));
  const totalAvg = average(metrics.turnLatencies.map((t) => t.total.milliseconds));
  const durationSeconds = isCallActive ? liveCallDurationSeconds : metrics.callDuration.seconds;

  return (
    <div className="flex h-full flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Current Stack</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {stackEntries.map(({ categoryLabel, icon: Icon, descriptor }) => (
            <div
              key={descriptor.category}
              className="flex items-center gap-3 rounded-md py-1.5 transition-colors hover:bg-surface-hover/60"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-hover text-muted-foreground">
                <Icon className="size-3.5" strokeWidth={1.75} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[10px] font-medium uppercase tracking-[0.04em] text-subtle-foreground">
                  {categoryLabel}
                </span>
                <span className="truncate font-mono text-[13px] text-foreground">
                  {descriptor.displayName}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">
                {descriptor.version}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {health.map((entry) => (
            <div
              key={entry.identifier.id}
              className="flex items-center justify-between gap-2 rounded-md py-1.5 transition-colors hover:bg-surface-hover/60"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    entry.isHealthy ? "bg-success" : "bg-danger",
                  )}
                />
                <span className="text-[13px] text-foreground">
                  {CATEGORY_LABEL[entry.identifier.category]}
                </span>
                <span className="truncate font-mono text-[11px] text-subtle-foreground">
                  {entry.identifier.id}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : "—"}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="flex-1">
        <CardHeader>
          <CardTitle>Performance Metrics</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0 border-b border-border pb-1">
            <MetricRow label="STT Latency" value={formatMs(sttAvg)} hint="avg" />
            <MetricRow label="LLM Latency" value={formatMs(llmAvg)} hint="avg" />
            <MetricRow label="TTS Latency" value={formatMs(ttsAvg)} hint="avg" />
            <MetricRow label="Total Latency" value={formatMs(totalAvg)} hint="avg" />
          </div>
          <div className="grid grid-cols-2 gap-x-4 pt-1">
            <MetricRow
              label="Estimated Cost"
              value={formatCurrency(metrics.estimatedCost.amount, metrics.estimatedCost.currency)}
            />
            <MetricRow label="Call Duration" value={formatDurationSeconds(durationSeconds)} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const STACK_CATEGORY_ICONS = {
  [ProviderCategory.TELEPHONY]: Cable,
  [ProviderCategory.SPEECH_TO_TEXT]: Captions,
  [ProviderCategory.LANGUAGE_MODEL]: Cpu,
  [ProviderCategory.TEXT_TO_SPEECH]: Volume2,
} as const;

export { CATEGORY_LABEL as STACK_CATEGORY_LABEL };
