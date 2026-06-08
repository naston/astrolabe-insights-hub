/**
 * Shared "Runs" sidebar panel — used by both the Training tab and the
 * Eval tab. State lives in the parent (ExperimentBody) so toggling a
 * run's visibility on one tab affects the other.
 *
 * This was inlined in experiment.tsx until v1.6.x; extracted when the
 * Eval tab needed the same affordance. Keeping the JSX shared means
 * future polish (keyboard nav, drag-reorder, etc.) lands in one place.
 */
import { Plus, Search } from "lucide-react";
import type { ComparisonRunPick } from "@/components/comparison-modal";
import type { Run } from "@/lib/types";
import { CopyableHash } from "@/components/copyable-hash";
import { cn } from "@/lib/utils";

/** Per-run metadata used by the panel rows. */
export interface RunsPanelMeta {
  active: boolean;
  version?: string;
  experiment: string;
  name: string;
}

interface RunsPanelProps {
  /** Runs visible after applying ``runFilter`` — what actually renders. */
  visibleRuns: Array<Run | ComparisonRunPick>;
  /** Label of the currently-selected experiment version, for the chip. */
  selectedVersionLabel: string | undefined;
  /** Filter text the user typed. */
  runFilter: string;
  onRunFilterChange: (next: string) => void;
  /** Set of hashes currently hidden from charts/tables/traces. */
  hiddenRuns: Set<string>;
  setHiddenRuns: (next: Set<string>) => void;
  /** Color per run hash. */
  runColors: Record<string, string>;
  /** Per-hash metadata for the row body (version chip, active dot, …). */
  runMeta: Record<string, RunsPanelMeta>;
  /** Hashes of runs that came in via --include / the comparison modal. */
  comparisonHashes: Set<string>;
  /** True when more than one distinct submitter is represented. */
  showSubmitterLines: boolean;
  /** Opens the ComparisonModal — the parent owns the modal. */
  onAddRuns: () => void;
  /** Remove a comparison run from the working set. */
  onRemoveComparison: (hash: string) => void;
}

export function RunsPanel({
  visibleRuns,
  selectedVersionLabel,
  runFilter,
  onRunFilterChange,
  hiddenRuns,
  setHiddenRuns,
  runColors,
  runMeta,
  comparisonHashes,
  showSubmitterLines,
  onAddRuns,
  onRemoveComparison,
}: RunsPanelProps) {
  const allHidden = visibleRuns.every((r) => hiddenRuns.has(r.hash));
  const noneHidden = visibleRuns.every((r) => !hiddenRuns.has(r.hash));

  const toggleHidden = (hash: string) => {
    const next = new Set(hiddenRuns);
    if (next.has(hash)) next.delete(hash);
    else next.add(hash);
    setHiddenRuns(next);
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Runs ({visibleRuns.length})
          </span>
          {selectedVersionLabel && (
            <span className="text-[10px] font-mono text-muted-foreground">
              pinned: {selectedVersionLabel}
            </span>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            value={runFilter}
            onChange={(e) => onRunFilterChange(e.target.value)}
            placeholder="Filter runs…"
            className="w-full rounded-md border border-border bg-surface pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setHiddenRuns(new Set())}
            disabled={noneHidden}
            className="flex-1 rounded border border-border bg-surface py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-default"
          >
            Show all
          </button>
          <button
            onClick={() => setHiddenRuns(new Set(visibleRuns.map((r) => r.hash)))}
            disabled={allHidden}
            className="flex-1 rounded border border-border bg-surface py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-default"
          >
            Show none
          </button>
        </div>
        <button
          onClick={onAddRuns}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] py-1.5 text-xs font-medium text-foreground hover:bg-[color-mix(in_oklab,var(--primary)_20%,transparent)] transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add comparison runs
        </button>
      </div>
      <ul className="max-h-[320px] overflow-y-auto scrollbar-thin divide-y divide-border">
        {visibleRuns.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">No runs match.</li>
        )}
        {visibleRuns.map((r) => {
          const hidden = hiddenRuns.has(r.hash);
          const meta = runMeta[r.hash];
          const isComparison = comparisonHashes.has(r.hash);
          return (
            <li
              key={r.hash}
              className={cn(
                "group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50",
                hidden && "opacity-50",
              )}
            >
              <button
                onClick={() => toggleHidden(r.hash)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                aria-label={hidden ? "Show run" : "Hide run"}
              >
                <span
                  className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-border-strong"
                  style={{ backgroundColor: runColors[r.hash] }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {meta?.version && (
                      <span className="font-mono text-[10px] text-foreground/80 shrink-0">
                        {meta.version}
                      </span>
                    )}
                    <CopyableHash
                      hash={r.hash}
                      className="font-mono text-[10px] text-muted-foreground shrink-0"
                    />
                    <span className="truncate text-xs">{r.name}</span>
                    {meta?.active && (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot shrink-0" />
                    )}
                  </div>
                  {isComparison && (
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {r.experiment}
                      {showSubmitterLines && r.submitted_by && <span> · by {r.submitted_by}</span>}
                    </div>
                  )}
                  {!isComparison && showSubmitterLines && r.submitted_by && (
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      by {r.submitted_by}
                    </div>
                  )}
                </div>
              </button>
              {isComparison && (
                <button
                  onClick={() => onRemoveComparison(r.hash)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-muted"
                  aria-label="Remove comparison run"
                  title="Remove comparison run"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3 w-3"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
