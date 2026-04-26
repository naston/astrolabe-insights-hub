import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  lastUpdated: number | null;
  loading?: boolean;
  intervalMs: number;
  className?: string;
}

type Freshness = "fresh" | "stale" | "disconnected" | "unknown";

/**
 * Quiet freshness indicator — a single colored dot that signals data
 * staleness at a glance without animating in the user's peripheral vision.
 *
 * Color encodes state:
 * - green: fresh (data updated within ~2× the polling interval)
 * - amber: stale (a poll likely missed)
 * - red:   disconnected (no successful update in a long time, or never)
 *
 * Hover the dot for the exact "Last updated <iso> (Ns ago)" tooltip — the
 * detail is still there for anyone who wants it, but the headline view is
 * just one static-looking pixel of color.
 *
 * Re-renders once every five seconds (slow enough to not draw the eye, fast
 * enough that the dot turns amber within a few seconds of becoming stale).
 */
export function FreshnessPill({ lastUpdated, intervalMs, className }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const status = classify(lastUpdated, intervalMs);

  const dotClass = {
    fresh: "bg-[var(--success)]",
    stale: "bg-[var(--warning)]",
    disconnected: "bg-[var(--destructive)]",
    unknown: "bg-muted-foreground/40",
  }[status];

  const ringClass = {
    fresh: "ring-[color-mix(in_oklab,var(--success)_30%,transparent)]",
    stale: "ring-[color-mix(in_oklab,var(--warning)_30%,transparent)]",
    disconnected: "ring-[color-mix(in_oklab,var(--destructive)_30%,transparent)]",
    unknown: "ring-transparent",
  }[status];

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface hover:border-border-strong",
              className,
            )}
            aria-label={tooltipText(lastUpdated, status)}
          >
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full ring-2",
                dotClass,
                ringClass,
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-[11px]">
          {tooltipText(lastUpdated, status)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function classify(lastUpdated: number | null, intervalMs: number): Freshness {
  if (!lastUpdated) return "unknown";
  const ageMs = Math.max(0, Date.now() - lastUpdated);
  // Fresh while we're within ~2× the polling cadence (one missed tick is OK).
  if (ageMs <= intervalMs * 2) return "fresh";
  // Stale once we've missed several ticks but still within ~30s.
  if (ageMs <= 30_000) return "stale";
  return "disconnected";
}

function tooltipText(lastUpdated: number | null, status: Freshness): string {
  if (!lastUpdated) {
    if (status === "disconnected") return "Disconnected — no data received";
    return "Awaiting first update";
  }
  const ageS = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
  const iso = new Date(lastUpdated).toISOString().replace("T", " ").slice(0, 19);
  const ageLabel =
    ageS < 2 ? "just now" : ageS < 60 ? `${ageS}s ago` : `${Math.floor(ageS / 60)}m ago`;
  const headline = {
    fresh: "Fresh",
    stale: "Stale — last poll missed",
    disconnected: "Disconnected",
    unknown: "Awaiting first update",
  }[status];
  return `${headline} · last updated ${iso} UTC (${ageLabel})`;
}
