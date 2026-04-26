import { cn } from "@/lib/utils";
import { stateTone, outcomeTone } from "@/lib/format";
import type { ExperimentState, ExperimentOutcome } from "@/lib/types";

const TONE_CLASS: Record<
  "success" | "destructive" | "warning" | "info" | "muted",
  string
> = {
  success:
    "text-[var(--success)] bg-[color-mix(in_oklab,var(--success)_15%,transparent)] ring-[color-mix(in_oklab,var(--success)_30%,transparent)]",
  destructive:
    "text-[var(--destructive)] bg-[color-mix(in_oklab,var(--destructive)_15%,transparent)] ring-[color-mix(in_oklab,var(--destructive)_30%,transparent)]",
  warning:
    "text-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_15%,transparent)] ring-[color-mix(in_oklab,var(--warning)_30%,transparent)]",
  info: "text-[var(--info)] bg-[color-mix(in_oklab,var(--info)_15%,transparent)] ring-[color-mix(in_oklab,var(--info)_30%,transparent)]",
  muted: "text-muted-foreground bg-muted ring-border",
};

interface StateBadgeProps {
  state: ExperimentState;
  className?: string;
}

export function StateBadge({ state, className }: StateBadgeProps) {
  const tone = stateTone(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset font-mono",
        TONE_CLASS[tone],
        className,
      )}
    >
      {state}
    </span>
  );
}

interface OutcomeBadgeProps {
  outcome: ExperimentOutcome;
  className?: string;
}

export function OutcomeBadge({ outcome, className }: OutcomeBadgeProps) {
  if (!outcome) return <span className="text-muted-foreground/60 text-xs">—</span>;
  const tone = outcomeTone(outcome);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset",
        TONE_CLASS[tone],
        className,
      )}
    >
      {outcome}
    </span>
  );
}
