import { SESSION_STATE_META, SESSION_STATE_STEPPER_ORDER } from "@/lib/session-state-meta";
import { SessionState } from "@/types/enums";
import { cn } from "@/lib/utils";

interface SessionStateStepperProps {
  readonly state: SessionState;
}

export function SessionStateStepper({ state }: SessionStateStepperProps) {
  if (state === SessionState.ERROR) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
        <span className="size-1.5 rounded-full bg-danger" />
        Session error — see last error detail
      </div>
    );
  }

  const currentIndex = SESSION_STATE_STEPPER_ORDER.indexOf(state);

  return (
    <div className="flex items-center overflow-x-auto">
      {SESSION_STATE_STEPPER_ORDER.map((step, index) => {
        const meta = SESSION_STATE_META[step];
        const isActive = index === currentIndex;
        const isPast = index < currentIndex;
        return (
          <div key={step} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                isActive
                  ? "border-border-strong bg-surface-raised text-foreground shadow-xs"
                  : isPast
                    ? "border-transparent text-muted-foreground"
                    : "border-transparent text-subtle-foreground/60",
              )}
            >
              <span
                className="size-1.5 rounded-full"
                style={{
                  backgroundColor: isActive || isPast ? meta.colorVar : "var(--color-border-strong)",
                }}
              />
              {meta.label}
            </div>
            {index < SESSION_STATE_STEPPER_ORDER.length - 1 && (
              <span className="mx-0.5 h-px w-3 shrink-0 bg-border" />
            )}
          </div>
        );
      })}
    </div>
  );
}
