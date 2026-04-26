import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  lastUpdated: number | null;
  loading?: boolean;
  intervalMs: number;
  className?: string;
}

/**
 * Tiny "last updated Ns ago" pill with a heartbeat dot. Re-renders once a
 * second so the relative timestamp ticks live.
 */
export function FreshnessPill({ lastUpdated, loading, intervalMs, className }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const label = (() => {
    if (!lastUpdated) return loading ? "loading…" : "—";
    const diff = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
    if (diff < 2) return "just now";
    return `${diff}s ago`;
  })();

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-muted-foreground",
        className,
      )}
      title={`Polling every ${Math.round(intervalMs / 1000)}s`}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]",
          loading ? "pulse-dot" : "opacity-80",
        )}
      />
      <span className="text-tabular">{label}</span>
    </div>
  );
}
