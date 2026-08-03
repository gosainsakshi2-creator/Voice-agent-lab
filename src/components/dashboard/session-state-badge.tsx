import { SESSION_STATE_META } from "@/lib/session-state-meta";
import type { SessionState } from "@/types/enums";
import { cn } from "@/lib/utils";

interface SessionStateBadgeProps {
  readonly state: SessionState;
  readonly className?: string;
  readonly pulse?: boolean;
}

export function SessionStateBadge({ state, className, pulse }: SessionStateBadgeProps) {
  const meta = SESSION_STATE_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-hover px-3 py-1.5 text-xs font-medium text-foreground shadow-xs",
        className,
      )}
    >
      <span className="relative flex size-2 items-center justify-center">
        {pulse && (
          <span
            className="absolute inline-flex size-2 animate-ping rounded-full opacity-40 [animation-duration:1.8s]"
            style={{ backgroundColor: meta.colorVar }}
          />
        )}
        <span className="relative inline-flex size-1.5 rounded-full" style={{ backgroundColor: meta.colorVar }} />
      </span>
      {meta.label}
    </span>
  );
}
