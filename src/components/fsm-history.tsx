import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FSM_ORDER, stateTone } from "@/lib/format";
import type { ExperimentState } from "@/lib/types";

interface Props {
  current: ExperimentState;
  history?: { state: ExperimentState; at: string }[];
}

const TONE_TEXT = {
  success: "text-[var(--success)]",
  destructive: "text-[var(--destructive)]",
  warning: "text-[var(--warning)]",
  info: "text-[var(--info)]",
  muted: "text-muted-foreground",
} as const;

const TONE_BG = {
  success: "bg-[var(--success)]",
  destructive: "bg-[var(--destructive)]",
  warning: "bg-[var(--warning)]",
  info: "bg-[var(--info)]",
  muted: "bg-muted-foreground/40",
} as const;

/**
 * FSM history strip — surfaces the full state machine so researchers can
 * see how the experiment transitioned (PENDING → ACQUIRING → SETUP → …).
 *
 * If the API doesn't return state_history yet, we synthesize a "visited"
 * track up to the current state so the chip still gives useful context.
 */
export function FSMHistory({ current, history }: Props) {
  // Build a Set of states we've visited
  const visited = new Set<ExperimentState>();
  if (history && history.length > 0) {
    for (const h of history) visited.add(h.state);
  } else {
    // synthesize from FSM order
    const idx = FSM_ORDER.indexOf(current);
    for (let i = 0; i <= idx; i++) visited.add(FSM_ORDER[i]);
  }

  // Build the timeline nodes — show ALL 8 states so the FSM is legible
  const states = FSM_ORDER.filter((s) =>
    // Hide the opposite terminal state if we know the current one
    current === "COMPLETED" ? s !== "FAILED" : current === "FAILED" ? s !== "COMPLETED" : true,
  );

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          State history
        </h3>
        {history && history.length > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {history.length} transitions
          </span>
        )}
      </div>
      <ol className="flex items-center gap-0">
        {states.map((s, i) => {
          const isVisited = visited.has(s);
          const isCurrent = s === current;
          const tone = stateTone(s);
          const last = i === states.length - 1;
          return (
            <li key={s} className="flex items-center flex-1 last:flex-none min-w-0">
              <div className="flex flex-col items-center gap-1 min-w-0">
                <div
                  className={cn(
                    "relative flex h-5 w-5 items-center justify-center rounded-full ring-2 transition-colors",
                    isCurrent
                      ? cn(TONE_BG[tone], "ring-[color-mix(in_oklab,var(--background)_0%,transparent)]")
                      : isVisited
                        ? cn("bg-muted", "ring-border-strong")
                        : "bg-background ring-border",
                  )}
                >
                  {isCurrent ? (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full bg-background",
                        stateTone(s) === "info" && "pulse-dot",
                      )}
                    />
                  ) : isVisited ? (
                    <Check className="h-3 w-3 text-muted-foreground" />
                  ) : null}
                </div>
                <span
                  className={cn(
                    "text-[9px] font-mono uppercase tracking-wider truncate",
                    isCurrent ? TONE_TEXT[tone] : "text-muted-foreground/70",
                  )}
                >
                  {s}
                </span>
              </div>
              {!last && (
                <div
                  className={cn(
                    "flex-1 h-px mx-1.5 -mt-3.5",
                    isVisited && visited.has(states[i + 1])
                      ? "bg-border-strong"
                      : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      {history && history.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] font-mono text-muted-foreground">
          {history.slice(-4).map((h, i) => (
            <li key={i} className="flex items-center justify-between">
              <span className="text-foreground">{h.state}</span>
              <span className="text-tabular">
                {new Date(h.at).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
