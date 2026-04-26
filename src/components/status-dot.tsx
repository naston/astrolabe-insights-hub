import { cn } from "@/lib/utils";
import { isActiveState, stateTone } from "@/lib/format";
import type { ExperimentState } from "@/lib/types";

const TONE_BG: Record<ReturnType<typeof stateTone>, string> = {
  success: "bg-[var(--success)]",
  destructive: "bg-[var(--destructive)]",
  warning: "bg-[var(--warning)]",
  info: "bg-[var(--info)]",
  muted: "bg-muted-foreground/60",
};

interface Props {
  state: ExperimentState;
  className?: string;
  size?: "sm" | "md";
}

/**
 * A single colored status dot. Pulses when the experiment is in an active
 * (in-flight) state so researchers can spot live runs at a glance.
 */
export function StatusDot({ state, className, size = "md" }: Props) {
  const tone = stateTone(state);
  const live = isActiveState(state);
  const dim = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  return (
    <span
      aria-label={state.toLowerCase()}
      className={cn("relative inline-flex items-center justify-center", className)}
    >
      <span
        className={cn(
          "inline-block rounded-full",
          dim,
          TONE_BG[tone],
          live && "pulse-dot",
        )}
      />
      {live && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-40",
            TONE_BG[tone],
            "blur-[3px]",
          )}
        />
      )}
    </span>
  );
}
