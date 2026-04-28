import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Experiment, Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelative } from "@/lib/format";
import { CopyableHash } from "@/components/copyable-hash";

export interface ComparisonRunPick {
  hash: string;
  name: string;
  experiment: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current experiment — excluded from picker. */
  currentExperiment: string;
  /** Hashes already added so we can highlight them. */
  alreadyAdded: Set<string>;
  onAdd: (run: ComparisonRunPick) => void;
}

export function ComparisonModal({
  open,
  onOpenChange,
  currentExperiment,
  alreadyAdded,
  onAdd,
}: Props) {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExp, setSelectedExp] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  // Load experiments when opening
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    api
      .experiments(ctrl.signal)
      .then((list) => {
        setExperiments(list.filter((e) => e.name !== currentExperiment));
        setSelectedExp((curr) => curr ?? list.find((e) => e.name !== currentExperiment)?.name ?? null);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, currentExperiment]);

  // Load runs when an experiment is selected
  useEffect(() => {
    if (!open || !selectedExp) {
      setRuns([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api
      .runs(selectedExp, ctrl.signal)
      .then((r) => setRuns(r))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, selectedExp]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const filteredExps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return experiments;
    return experiments.filter((e) => e.name.toLowerCase().includes(q));
  }, [experiments, filter]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-3xl h-[560px] rounded-lg border border-border bg-popover shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Add comparison runs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Overlay runs from other experiments onto this dashboard.
            </p>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 min-h-0">
          {/* Experiment list */}
          <div className="w-64 border-r border-border flex flex-col bg-surface">
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter experiments…"
                  className="w-full rounded border border-border bg-card pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <ul className="flex-1 overflow-y-auto scrollbar-thin">
              {filteredExps.map((e) => (
                <li key={e.name}>
                  <button
                    onClick={() => setSelectedExp(e.name)}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs truncate hover:bg-muted/60 transition-colors border-l-2",
                      selectedExp === e.name
                        ? "bg-muted border-primary text-foreground"
                        : "border-transparent text-muted-foreground",
                    )}
                  >
                    <div className="font-medium truncate">{e.name}</div>
                    <div className="text-[10px] opacity-70 font-mono mt-0.5">
                      {e.run_count} runs · {e.state.toLowerCase()}
                    </div>
                  </button>
                </li>
              ))}
              {filteredExps.length === 0 && (
                <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No experiments
                </li>
              )}
            </ul>
          </div>
          {/* Runs */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground font-mono">
              {selectedExp ? selectedExp : "Select an experiment"}
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {loading && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  Loading runs…
                </div>
              )}
              {!loading && runs.length === 0 && selectedExp && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No runs in this experiment.
                </div>
              )}
              <ul className="divide-y divide-border">
                {runs.map((r) => {
                  const added = alreadyAdded.has(r.hash);
                  return (
                    <li
                      key={r.hash}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <CopyableHash
                            hash={r.hash}
                            className="font-mono text-[11px] text-muted-foreground"
                          />
                          <span className="truncate font-medium">{r.name}</span>
                          {r.active && (
                            <span className="rounded bg-[color-mix(in_oklab,var(--info)_15%,transparent)] px-1 py-0.5 text-[9px] font-mono uppercase text-[var(--info)]">
                              live
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground font-mono text-tabular">
                          {formatDuration(r.duration)} ·{" "}
                          {formatRelative(r.creation_time)} ·{" "}
                          {r.final_loss != null
                            ? `loss ${r.final_loss.toFixed(4)}`
                            : "no final loss"}
                        </div>
                      </div>
                      <button
                        disabled={added}
                        onClick={() =>
                          onAdd({
                            hash: r.hash,
                            name: r.name,
                            experiment: r.experiment,
                          })
                        }
                        className={cn(
                          "shrink-0 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                          added
                            ? "border-border bg-muted text-muted-foreground cursor-not-allowed"
                            : "border-primary/50 bg-[color-mix(in_oklab,var(--primary)_15%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--primary)_25%,transparent)]",
                        )}
                      >
                        {added ? "Added" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{alreadyAdded.size} comparison runs added</span>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border bg-surface px-3 py-1 text-xs hover:bg-muted"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
