import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Filter as FilterIcon,
  Keyboard,
  RefreshCw,
  Search,
} from "lucide-react";

import { api } from "@/lib/api";
import type { Experiment, Run } from "@/lib/types";
import { usePolling } from "@/hooks/use-polling";
import {
  formatDuration,
  formatRelative,
  formatTimestamp,
  inferRepo,
  isActiveState,
  shortHash,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { StatusDot } from "@/components/status-dot";
import { OutcomeBadge, StateBadge } from "@/components/state-badge";
import { FreshnessPill } from "@/components/freshness-pill";
import { Kbd } from "@/components/shortcuts-help";

const POLL_MS = 3000;

interface ExperimentsListProps {
  onShowHelp: () => void;
}

export function ExperimentsList({ onShowHelp }: ExperimentsListProps) {
  const { data, error, loading, lastUpdated, refetch } = usePolling(
    (signal) => api.experiments(signal),
    [],
    { intervalMs: POLL_MS },
  );
  // Distinguish "first paint, no data yet" from "background re-fetch".
  // We only show loading affordances during the first load.
  const firstLoad = loading && data === undefined;

  const experiments = useMemo(() => data ?? [], [data]);

  // Repo filter (multi-select chip group) + free-text filter
  const [filter, setFilter] = useState("");
  const [activeRepo, setActiveRepo] = useState<string | "all">("all");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const repos = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of experiments) {
      const r = inferRepo(e);
      map.set(r, (map.get(r) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [experiments]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return experiments.filter((e) => {
      if (activeRepo !== "all" && inferRepo(e) !== activeRepo) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.gpu_type?.toLowerCase().includes(q) ||
        e.state.toLowerCase().includes(q)
      );
    });
  }, [experiments, filter, activeRepo]);

  const counts = useMemo(() => {
    const total = experiments.length;
    const active = experiments.filter((e) => isActiveState(e.state)).length;
    const completed = experiments.filter((e) => e.state === "COMPLETED").length;
    const failed = experiments.filter((e) => e.state === "FAILED").length;
    return { total, active, completed, failed };
  }, [experiments]);

  // Selection + keyboard nav
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();
  const rowRefs = useRef<Record<number, HTMLElement | null>>({});

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [filter, activeRepo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
        return;
      }

      if (e.key === "Escape" && document.activeElement === filterInputRef.current) {
        if (filter) {
          setFilter("");
        } else {
          (document.activeElement as HTMLElement)?.blur();
        }
        return;
      }

      if (isEditable) return;

      if (e.key === "j") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        const exp = filtered[selectedIdx];
        if (exp) {
          e.preventDefault();
          navigate({
            to: "/experiment",
            search: { name: exp.name },
          });
        }
      } else if (e.key === "x" || e.key === "o") {
        const exp = filtered[selectedIdx];
        if (exp) {
          e.preventDefault();
          setExpanded((m) => ({ ...m, [exp.name]: !m[exp.name] }));
        }
      } else if (e.key === "r") {
        e.preventDefault();
        refetch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, selectedIdx, navigate, filter, refetch]);

  // Scroll selected row into view
  useEffect(() => {
    const el = rowRefs.current[selectedIdx];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIdx]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="Total experiments" value={counts.total} />
        <KpiCard label="Active" value={counts.active} accent="info" pulse={counts.active > 0} />
        <KpiCard label="Completed" value={counts.completed} accent="success" />
        <KpiCard label="Failed" value={counts.failed} accent="destructive" />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={filterInputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter experiments…"
            className="w-full rounded-md border border-border bg-surface pl-8 pr-12 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition"
          />
          <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
          <FilterIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <RepoChip
            label="All"
            count={counts.total}
            active={activeRepo === "all"}
            onClick={() => setActiveRepo("all")}
          />
          {repos.map(([repo, count]) => (
            <RepoChip
              key={repo}
              label={repo}
              count={count}
              active={activeRepo === repo}
              onClick={() => setActiveRepo(repo)}
            />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <FreshnessPill
            lastUpdated={lastUpdated}
            loading={loading}
            intervalMs={POLL_MS}
          />
          <button
            onClick={() => refetch()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground hover:text-foreground"
            aria-label="Refresh"
            title="Refresh now (r)"
          >
            {/* Spinner only animates during the very first load — background
                polls are silent per spec. */}
            <RefreshCw className={cn("h-3.5 w-3.5", firstLoad && "animate-spin")} />
          </button>
          <button
            onClick={onShowHelp}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-muted-foreground hover:text-foreground"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
            <Kbd>?</Kbd>
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-[28px_minmax(260px,1fr)_140px_140px_120px_110px_110px_90px] gap-3 border-b border-border bg-surface px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span></span>
          <span>Experiment</span>
          <span>State</span>
          <span>GPU</span>
          <span>Started</span>
          <span>Duration</span>
          <span className="text-right">Versions</span>
          <span className="text-right">Outcome</span>
        </div>

        {error && (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            Failed to load experiments — {error.message}
          </div>
        )}

        {!error && filtered.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            {experiments.length === 0
              ? "Waiting for the orchestrator…"
              : "No experiments match the current filter."}
          </div>
        )}

        <ul className="divide-y divide-border">
          {filtered.map((exp, idx) => (
            <ExperimentRow
              key={exp.name}
              ref={(el) => {
                rowRefs.current[idx] = el;
              }}
              experiment={exp}
              selected={idx === selectedIdx}
              expanded={!!expanded[exp.name]}
              onSelect={() => setSelectedIdx(idx)}
              onToggle={() =>
                setExpanded((m) => ({ ...m, [exp.name]: !m[exp.name] }))
              }
            />
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
        <span>
          {filtered.length} of {experiments.length} experiments
        </span>
        <span className="flex items-center gap-2">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          <span>navigate</span>
          <span className="opacity-50">·</span>
          <Kbd>↵</Kbd>
          <span>open</span>
          <span className="opacity-50">·</span>
          <Kbd>x</Kbd>
          <span>expand runs</span>
        </span>
      </div>
    </div>
  );
}

interface KpiProps {
  label: string;
  value: number;
  accent?: "info" | "success" | "destructive";
  pulse?: boolean;
}

function KpiCard({ label, value, accent, pulse }: KpiProps) {
  const accentClass =
    accent === "info"
      ? "text-[var(--info)]"
      : accent === "success"
        ? "text-[var(--success)]"
        : accent === "destructive"
          ? "text-[var(--destructive)]"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {pulse && value > 0 && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot" />
        )}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold text-tabular", accentClass)}>
        {value}
      </div>
    </div>
  );
}

function RepoChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
        active
          ? "border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,transparent)] text-foreground"
          : "border-border bg-surface text-muted-foreground hover:text-foreground hover:border-border-strong",
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="font-mono text-[10px] text-tabular opacity-70">{count}</span>
    </button>
  );
}

interface ExperimentRowProps {
  experiment: Experiment;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  ref?: React.Ref<HTMLLIElement>;
}

function ExperimentRow({
  experiment,
  selected,
  expanded,
  onSelect,
  onToggle,
  ref,
}: ExperimentRowProps) {
  const live = isActiveState(experiment.state);
  return (
    <li
      ref={ref}
      data-selected={selected}
      className={cn(
        "group relative",
        selected && "bg-[color-mix(in_oklab,var(--primary)_8%,transparent)]",
      )}
    >
      {selected && (
        <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
      )}
      <div
        className="grid grid-cols-[28px_minmax(260px,1fr)_140px_140px_120px_110px_110px_90px] gap-3 items-center px-3 py-2 cursor-pointer hover:bg-muted/50"
        onClick={onSelect}
        onDoubleClick={onToggle}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <Link
          to="/experiment"
          search={{ name: experiment.name, version: "latest" }}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2 min-w-0"
        >
          <StatusDot state={experiment.state} />
          <span className="truncate text-sm font-medium hover:text-primary transition-colors">
            {experiment.name}
          </span>
          {live && (
            <span className="ml-1 rounded bg-[color-mix(in_oklab,var(--info)_15%,transparent)] px-1 py-0.5 text-[9px] font-mono text-[var(--info)] uppercase tracking-wider">
              live
            </span>
          )}
        </Link>
        <StateBadge state={experiment.state} />
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono truncate">
          <Cpu className="h-3 w-3 shrink-0" />
          <span className="truncate">{experiment.gpu_type || "—"}</span>
        </span>
        <span
          className="text-xs text-muted-foreground font-mono text-tabular truncate"
          title={formatTimestamp(experiment.started_at)}
        >
          {formatRelative(experiment.started_at)}
        </span>
        <span className="text-xs text-foreground font-mono text-tabular">
          {formatDuration(experiment.duration)}
        </span>
        <span className="text-right">
          <VersionBadge count={experiment.run_count} />
        </span>
        <span className="text-right">
          <OutcomeBadge outcome={experiment.outcome} />
        </span>
      </div>
      {expanded && <RunsPanel experimentName={experiment.name} />}
    </li>
  );
}

function RunsPanel({ experimentName }: { experimentName: string }) {
  // Polling at the same cadence as the parent list keeps things consistent.
  const { data, error } = usePolling(
    (signal) => api.runs(experimentName, signal),
    [experimentName],
    { intervalMs: POLL_MS },
  );

  // We intentionally suppress the "loading…" word during background polls.
  // The first paint shows a tiny skeleton hint instead, then content lands silently.
  return (
    <div className="border-t border-border bg-surface/50 px-3 py-2 animate-fade-in">
      {error && !data && (
        <div className="px-2 py-3 text-xs text-destructive">
          Failed to load versions — {error.message}
        </div>
      )}
      {data && data.length === 0 && (
        <div className="px-2 py-3 text-xs text-muted-foreground">No versions yet.</div>
      )}
      {!data && !error && (
        <div className="px-2 py-3 text-xs text-muted-foreground/60 font-mono">·····</div>
      )}
      {data && data.length > 0 && (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-[60px_80px_minmax(0,1fr)_120px_120px_100px_90px] gap-3 border-b border-border bg-surface px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Version</span>
            <span>Hash</span>
            <span>Run</span>
            <span>Created</span>
            <span>Duration</span>
            <span className="text-right">Final loss</span>
            <span className="text-right">State</span>
          </div>
          <ul className="divide-y divide-border">
            {/* Render newest-first so v1 of N reads the same as the version selector */}
            {[...data]
              .sort(
                (a, b) =>
                  new Date(b.creation_time).getTime() -
                  new Date(a.creation_time).getTime(),
              )
              .map((run, i, all) => (
                <RunRow
                  key={run.hash}
                  run={run}
                  experimentName={experimentName}
                  versionLabel={`v${all.length - i}`}
                />
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function VersionBadge({ count }: { count: number }) {
  // Cardinality cue — make it obvious that one row = N submits.
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
      title={`${count} submitted version${count === 1 ? "" : "s"}`}
    >
      <span className="text-tabular text-foreground font-medium">×{count}</span>
      <span className="opacity-60">v</span>
    </span>
  );
}

function RunRow({
  run,
  experimentName,
  versionLabel,
}: {
  run: Run;
  experimentName: string;
  versionLabel: string;
}) {
  return (
    <li className="grid grid-cols-[60px_80px_minmax(0,1fr)_120px_120px_100px_90px] gap-3 items-center px-3 py-1.5 text-xs hover:bg-muted/50">
      <Link
        to="/experiment"
        search={{ name: experimentName, version: versionLabel }}
        className="font-mono text-tabular text-foreground hover:text-primary"
        onClick={(e) => e.stopPropagation()}
      >
        {versionLabel}
      </Link>
      <span className="font-mono text-muted-foreground">{shortHash(run.hash)}</span>
      <span className="truncate font-medium">{run.name}</span>
      <span
        className="font-mono text-tabular text-muted-foreground"
        title={formatTimestamp(run.creation_time)}
      >
        {formatRelative(run.creation_time)}
      </span>
      <span className="font-mono text-tabular">{formatDuration(run.duration)}</span>
      <span className="text-right font-mono text-tabular">
        {run.final_loss != null ? run.final_loss.toFixed(4) : "—"}
      </span>
      <span className="text-right">
        {run.active ? (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase text-[var(--info)] bg-[color-mix(in_oklab,var(--info)_15%,transparent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot" />
            running
          </span>
        ) : (
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            done
          </span>
        )}
      </span>
    </li>
  );
}
