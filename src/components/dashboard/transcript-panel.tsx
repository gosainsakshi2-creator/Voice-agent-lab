import { AudioLines } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { SessionStateBadge } from "@/components/dashboard/session-state-badge";
import { SessionStateStepper } from "@/components/dashboard/session-state-stepper";
import { formatClockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SessionState } from "@/types/enums";
import type { ConversationTurn } from "@/types/provider.types";

interface TranscriptPanelProps {
  readonly currentTestLabel: string;
  readonly sessionState: SessionState;
  readonly transcript: readonly ConversationTurn[];
}

const ROLE_META: Record<ConversationTurn["role"], { label: string; dotClassName: string; textClassName: string }> = {
  system: { label: "System", dotClassName: "bg-subtle-foreground", textClassName: "text-subtle-foreground" },
  user: { label: "Caller", dotClassName: "bg-accent", textClassName: "text-accent" },
  assistant: {
    label: "AI Agent",
    dotClassName: "bg-[var(--color-state-speaking)]",
    textClassName: "text-[var(--color-state-speaking)]",
  },
};

export function TranscriptPanel({ currentTestLabel, sessionState, transcript }: TranscriptPanelProps) {
  const isLive =
    sessionState === SessionState.LISTENING ||
    sessionState === SessionState.THINKING ||
    sessionState === SessionState.SPEAKING;

  return (
    <Card className="flex h-full min-h-0 flex-col shadow-sm">
      <CardHeader className="gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-subtle-foreground">
              Current Test
            </span>
            <span className="font-mono text-[13px] text-foreground">{currentTestLabel}</span>
          </div>
          <SessionStateBadge state={sessionState} pulse={isLive} />
        </div>
        <SessionStateStepper state={sessionState} />
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollArea className="min-h-0 flex-1">
          {transcript.length === 0 ? (
            <div className="flex h-full min-h-[26rem] flex-col items-center justify-center gap-3 px-8 py-16 text-center">
              <div className="flex size-11 items-center justify-center rounded-full border border-border-strong bg-surface-hover text-subtle-foreground">
                <AudioLines className="size-5" strokeWidth={1.75} />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">No active session</p>
                <p className="max-w-[26rem] text-[13px] leading-relaxed text-muted-foreground">
                  Configure a provider stack on the left and press Start Call to begin
                  benchmarking a live conversation.
                </p>
              </div>
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <tbody>
                {transcript.map((entry, index) => {
                  console.log("ENTRY TIMESTAMP:", entry.timestamp, typeof entry.timestamp);
                  const meta = ROLE_META[entry.role];
                  return (
                    <tr
                      key={index}
                      className={cn(
                        "group border-b border-border/70 align-top transition-colors hover:bg-surface-hover/50",
                        entry.role === "system" && "bg-surface-hover/25",
                      )}
                    >
                      <td className="w-[4.5rem] whitespace-nowrap py-3 pl-5 pr-2 font-mono text-[11px] tabular-nums text-subtle-foreground">
                        {formatClockTime(entry.timestamp)}{
  entry.timestamp
    ? formatClockTime(new Date(entry.timestamp))
    : "--:--:--"
}
                      </td>
                      <td className="w-28 whitespace-nowrap px-2 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn("size-1.5 rounded-full", meta.dotClassName)} />
                          <span className={cn("text-[11px] font-medium tracking-wide", meta.textClassName)}>
                            {meta.label}
                          </span>
                        </span>
                      </td>
                      <td className="px-2 py-3 pr-6 leading-relaxed text-foreground/90">
                        {entry.content}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
