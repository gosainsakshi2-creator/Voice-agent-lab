import { AudioLines } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface HeaderProps {
  readonly isSystemHealthy: boolean;
}

export function Header({ isSystemHealthy }: HeaderProps) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg border border-border-strong bg-surface-hover text-accent">
          <AudioLines className="size-4" strokeWidth={2} />
        </div>
        <div className="flex flex-col justify-center gap-0.5">
          <h1 className="text-[15px] font-semibold leading-none tracking-tight text-foreground">
            AI Voice Benchmark
          </h1>
          <p className="hidden text-xs leading-none text-muted-foreground sm:block">
            Benchmark and compare conversational AI voice stacks
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden items-center gap-2 rounded-full border border-border-strong bg-surface-hover py-1 pl-2.5 pr-3 sm:flex">
          <span className="relative flex size-1.5 items-center justify-center">
            {isSystemHealthy && (
              <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-success opacity-60" />
            )}
            <span
              className={`relative inline-flex size-1.5 rounded-full ${
                isSystemHealthy ? "bg-success" : "bg-warning"
              }`}
            />
          </span>
          <span className="text-xs font-medium text-foreground">
            {isSystemHealthy ? "All systems operational" : "Degraded performance"}
          </span>
        </div>

        <div className="h-6 w-px bg-border" aria-hidden />

        <Avatar className="size-8 border border-border-strong shadow-xs">
          <AvatarFallback className="bg-surface-hover text-[11px] font-semibold text-foreground">
            VA
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
