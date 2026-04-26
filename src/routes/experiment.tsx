import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Filter as FilterIcon,
  Plus,
  Search,
} from "lucide-react";

import { api, DEFAULT_PALETTE } from "@/lib/api";
import type { Experiment, Run } from "@/lib/types";
import { usePolling } from "@/hooks/use-polling";
import {
  formatDuration,
  formatRelative,
  formatTimestamp,
  isActiveState,
  shortHash,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { AppShell } from "@/components/app-shell";
import { StatusDot } from "@/components/status-dot";
import { StateBadge } from "@/components/state-badge";
import { FreshnessPill } from "@/components/freshness-pill";
import { FSMHistory } from "@/components/fsm-history";
import {
  ChartZoomProvider,
  type XAxisMode,
} from "@/hooks/use-chart-zoom";
import { MetricChart, type ChartRunSpec } from "@/components/metric-chart";
import { ComparisonModal, type ComparisonRunPick } from "@/components/comparison-modal";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";

const searchSchema = z.object({
  name: z.string().catch("").default(""),
  // `version` is "latest" or "vN" (1-indexed, oldest = v1).
  version: z.string().catch("latest").default("latest"),
});

export const Route = createFileRoute("/experiment")({
  validateSearch: (search: Record<string, unknown>) => searchSchema.parse(search),
  head: ({ match }) => {
    const name = (match.search as { name?: string }).name ?? "Experiment";
    return {
      meta: [
        { title: `${name} — Astrolabe` },
        {
          name: "description",
          content: `Live metrics dashboard for experiment ${name}.`,
        },
        { property: "og:title", content: `${name} — Astrolabe` },
        {
          property: "og:description",
          content: `Live metrics dashboard for experiment ${name}.`,
        },
      ],
    };
  },
  component: ExperimentPage,
});

const RUNS_POLL_MS = 3000;
const PRIMARY_METRIC = "train/loss";
const SECONDARY_METRICS = ["eval/loss", "eval/accuracy"];

function ExperimentPage() {
  const { name, version } = Route.useSearch();
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalShortcuts({ onHelpToggle: () => setHelpOpen((o) => !o) });

  if (!name) {
    return (
      <AppShell>
        <div className="mx-auto max-w-md px-6 py-16 text-center">
          <h1 className="text-lg font-semibold">Missing experiment name</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Open an experiment from the home page.
          </p>
          <Link
            to="/"
            className="mt-4 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Go home
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <ChartZoomProvider>
      <ExperimentBody
        experimentName={name}
        versionParam={version || "latest"}
        onShowHelp={() => setHelpOpen(true)}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </ChartZoomProvider>
  );
}

interface VersionInfo {
  /** "v1", "v2", … (1-indexed, oldest first). */
  label: string;
  run: Run;
}

function ExperimentBody({
  experimentName,
  versionParam,
  onShowHelp,
}: {
  experimentName: string;
  versionParam: string;
  onShowHelp: () => void;
}) {
  const navigate = useNavigate();

  // Experiments list (so we can find this experiment's metadata)
  const expState = usePolling(
    (signal) => api.experiments(signal),
    [],
    { intervalMs: RUNS_POLL_MS },
  );
  const experiment: Experiment | undefined = useMemo(
    () => expState.data?.find((e) => e.name === experimentName),
    [expState.data, experimentName],
  );

  // Runs for this experiment — each run is one submitted "version".
  const runsState = usePolling(
    (signal) => api.runs(experimentName, signal),
    [experimentName],
    { intervalMs: RUNS_POLL_MS },
  );

  // Build the canonical version list (oldest = v1) ordered by creation_time.
  const versions: VersionInfo[] = useMemo(() => {
    const sorted = [...(runsState.data ?? [])].sort(
      (a, b) =>
        new Date(a.creation_time).getTime() - new Date(b.creation_time).getTime(),
    );
    return sorted.map((run, i) => ({ label: `v${i + 1}`, run }));
  }, [runsState.data]);

  // Resolve the selected version. "latest" tracks the most recent submit.
  const isLatestPin = versionParam === "latest";
  const selectedVersion: VersionInfo | undefined = useMemo(() => {
    if (versions.length === 0) return undefined;
    if (isLatestPin) return versions[versions.length - 1];
    const match = versions.find((v) => v.label === versionParam);
    return match ?? versions[versions.length - 1];
  }, [versions, versionParam, isLatestPin]);

  const isOnLatest =
    selectedVersion && selectedVersion === versions[versions.length - 1];

  // Color palette from API (with fallback)
  const [palette, setPalette] = useState<string[]>(DEFAULT_PALETTE);
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .colors(ctrl.signal)
      .then((c) => {
        if (c.palette && c.palette.length > 0) setPalette(c.palette);
      })
      .catch(() => {
        /* keep default */
      });
    return () => ctrl.abort();
  }, []);

  // Comparison runs (from other experiments) — held in local state.
  const [comparison, setComparison] = useState<ComparisonRunPick[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  // The "primary" run shown in charts is just the selected version.
  // Comparison overlays are appended; switching versions does NOT clear them.
  const allRuns = useMemo(() => {
    const native: ComparisonRunPick[] = selectedVersion
      ? [
          {
            hash: selectedVersion.run.hash,
            name: selectedVersion.label,
            experiment: selectedVersion.run.experiment,
          },
        ]
      : [];
    return [...native, ...comparison.filter((c) => !native.find((n) => n.hash === c.hash))];
  }, [selectedVersion, comparison]);

  // Per-run metadata: active flag + creationMs (for wall-time x-axis).
  const runMeta = useMemo(() => {
    const map: Record<
      string,
      { active: boolean; creationMs: number; experiment: string; name: string }
    > = {};
    if (selectedVersion) {
      const r = selectedVersion.run;
      map[r.hash] = {
        active: r.active,
        creationMs: new Date(r.creation_time).getTime(),
        experiment: r.experiment,
        name: selectedVersion.label,
      };
    }
    // Comparison runs default to inactive — we don't poll them.
    for (const c of comparison) {
      map[c.hash] ??= {
        active: false,
        creationMs: 0,
        experiment: c.experiment,
        name: c.name,
      };
    }

  // Per-run metadata: active flag + creationMs (for wall-time x-axis).
  const runMeta = useMemo(() => {
    const map: Record<
      string,
      { active: boolean; creationMs: number; experiment: string; name: string }
    > = {};
    for (const r of runsState.data ?? []) {
      map[r.hash] = {
        active: r.active,
        creationMs: new Date(r.creation_time).getTime(),
        experiment: r.experiment,
        name: r.name,
      };
    }
    // Comparison runs default to inactive — we don't poll them.
    for (const c of comparison) {
      map[c.hash] ??= {
        active: false,
        creationMs: 0,
        experiment: c.experiment,
        name: c.name,
      };
    }
    return map;
  }, [runsState.data, comparison]);

  // Sidebar: per-run visibility toggles
  const [hiddenRuns, setHiddenRuns] = useState<Set<string>>(new Set());
  const [runFilter, setRunFilter] = useState("");
  const [xMode, setXMode] = useState<XAxisMode>("step");

  const runColors = useMemo(() => {
    const map: Record<string, string> = {};
    allRuns.forEach((r, i) => {
      map[r.hash] = palette[i % palette.length];
    });
    return map;
  }, [allRuns, palette]);

  const visibleRuns = useMemo(() => {
    const q = runFilter.trim().toLowerCase();
    return allRuns.filter((r) => (q ? r.name.toLowerCase().includes(q) : true));
  }, [allRuns, runFilter]);

  // Build the chart-run specs (visible + active flag + color).
  const chartRuns: ChartRunSpec[] = useMemo(() => {
    return visibleRuns.map((r) => ({
      hash: r.hash,
      name: r.name,
      experiment: r.experiment,
      color: runColors[r.hash] ?? "#888",
      active: runMeta[r.hash]?.active ?? false,
      visible: !hiddenRuns.has(r.hash),
    }));
  }, [visibleRuns, runColors, runMeta, hiddenRuns]);

  const runCreationMs = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [hash, meta] of Object.entries(runMeta)) {
      map[hash] = meta.creationMs;
    }
    return map;
  }, [runMeta]);

  // Discover available metrics across all runs (native + included)
  const metricNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of runsState.data ?? []) {
      for (const m of r.metrics ?? []) set.add(m.name);
    }
    // Always offer the canonical primary metric even if no run has reported it yet
    if (!set.size) set.add(PRIMARY_METRIC);

    const ordered: string[] = [];
    if (set.has(PRIMARY_METRIC)) {
      ordered.push(PRIMARY_METRIC);
      set.delete(PRIMARY_METRIC);
    }
    for (const m of SECONDARY_METRICS) {
      if (set.has(m)) {
        ordered.push(m);
        set.delete(m);
      }
    }
    return [...ordered, ...Array.from(set).sort()];
  }, [runsState.data]);

  // Visible metric set — start with primary + secondary, let user toggle.
  const [hiddenMetrics, setHiddenMetrics] = useState<Set<string>>(new Set());
  const visibleMetrics = metricNames.filter((m) => !hiddenMetrics.has(m));

  const allHidden = visibleRuns.every((r) => hiddenRuns.has(r.hash));
  const noneHidden = visibleRuns.every((r) => !hiddenRuns.has(r.hash));

  const elapsed = experiment ? experiment.duration : 0;
  const live = experiment ? isActiveState(experiment.state) : false;

  return (
    <AppShell
      rightSlot={
        <FreshnessPill
          lastUpdated={Math.max(
            expState.lastUpdated ?? 0,
            runsState.lastUpdated ?? 0,
          ) || null}
          loading={expState.loading || runsState.loading}
          intervalMs={RUNS_POLL_MS}
        />
      }
    >
      <div className="mx-auto w-full max-w-[1600px] px-6 py-5 space-y-5">
        {/* Header */}
        <div className="flex items-start gap-4">
          <Link
            to="/"
            className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground hover:text-foreground"
            aria-label="Back to experiments"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {experiment && <StatusDot state={experiment.state} />}
              <h1 className="text-xl font-semibold tracking-tight truncate">
                {experimentName}
              </h1>
              {experiment && <StateBadge state={experiment.state} />}
              {live && (
                <span className="rounded bg-[color-mix(in_oklab,var(--info)_15%,transparent)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--info)] uppercase tracking-wider">
                  live
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-4 text-xs text-muted-foreground font-mono">
              <span className="text-tabular">elapsed {formatDuration(elapsed)}</span>
              <span className="opacity-50">·</span>
              <span title={experiment?.started_at ? formatTimestamp(experiment.started_at) : ""}>
                started {formatRelative(experiment?.started_at)}
              </span>
              <span className="opacity-50">·</span>
              <span>gpu {experiment?.gpu_type ?? "—"}</span>
              <span className="opacity-50">·</span>
              <span>{allRuns.length} runs</span>
              {comparison.length > 0 && (
                <>
                  <span className="opacity-50">·</span>
                  <span className="text-foreground">
                    +{comparison.length} comparison
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* FSM history */}
        {experiment && (
          <FSMHistory
            current={experiment.state}
            history={experiment.state_history}
          />
        )}

        {/* Body — charts grid + sidebar */}
        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5">
          {/* Charts column */}
          <div className="space-y-4 min-w-0">
            {visibleMetrics.length === 0 && (
              <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
                All metrics hidden — toggle one back on from the sidebar.
              </div>
            )}
            {visibleMetrics.map((metricName) => (
              <MetricChart
                key={metricName}
                metricName={metricName}
                runs={chartRuns}
                xMode={xMode}
                runCreationMs={runCreationMs}
              />
            ))}
          </div>

          {/* Sidebar */}
          <aside className="space-y-3">
            {/* X-axis selector */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                X-axis
              </div>
              <div className="flex rounded-md border border-border bg-surface p-0.5 text-xs">
                <SegButton
                  active={xMode === "step"}
                  onClick={() => setXMode("step")}
                >
                  Step
                </SegButton>
                <SegButton
                  active={xMode === "wall_time"}
                  onClick={() => setXMode("wall_time")}
                >
                  Wall time
                </SegButton>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
                Drag any chart to zoom — all charts sync. Double-click to reset.
              </p>
            </div>

            {/* Filter + show-all/none */}
            <div className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Runs
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  value={runFilter}
                  onChange={(e) => setRunFilter(e.target.value)}
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
                  onClick={() =>
                    setHiddenRuns(new Set(visibleRuns.map((r) => r.hash)))
                  }
                  disabled={allHidden}
                  className="flex-1 rounded border border-border bg-surface py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-default"
                >
                  Show none
                </button>
              </div>
              <button
                onClick={() => setModalOpen(true)}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] py-1.5 text-xs font-medium text-foreground hover:bg-[color-mix(in_oklab,var(--primary)_20%,transparent)] transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add comparison runs
              </button>
            </div>

            {/* Legend */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Legend ({visibleRuns.length})
                </span>
                <FilterIcon className="h-3 w-3 text-muted-foreground" />
              </div>
              <ul className="max-h-[280px] overflow-y-auto scrollbar-thin divide-y divide-border">
                {visibleRuns.length === 0 && (
                  <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No runs match.
                  </li>
                )}
                {visibleRuns.map((r) => {
                  const hidden = hiddenRuns.has(r.hash);
                  const meta = runMeta[r.hash];
                  const isComparison = comparison.some((c) => c.hash === r.hash);
                  return (
                    <li
                      key={r.hash}
                      className={cn(
                        "group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50",
                        hidden && "opacity-50",
                      )}
                    >
                      <button
                        onClick={() =>
                          setHiddenRuns((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.hash)) next.delete(r.hash);
                            else next.add(r.hash);
                            return next;
                          })
                        }
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        aria-label={hidden ? "Show run" : "Hide run"}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-border-strong"
                          style={{ backgroundColor: runColors[r.hash] }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {shortHash(r.hash)}
                            </span>
                            <span className="truncate text-xs">{r.name}</span>
                            {meta?.active && (
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot shrink-0" />
                            )}
                          </div>
                          {isComparison && (
                            <div className="text-[10px] text-muted-foreground font-mono truncate">
                              {r.experiment}
                            </div>
                          )}
                        </div>
                      </button>
                      {isComparison && (
                        <button
                          onClick={() =>
                            setComparison((prev) =>
                              prev.filter((c) => c.hash !== r.hash),
                            )
                          }
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

            {/* Metric toggles */}
            {metricNames.length > 1 && (
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-3 py-2 border-b border-border text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Metrics
                </div>
                <ul className="max-h-[200px] overflow-y-auto scrollbar-thin">
                  {metricNames.map((m) => {
                    const hidden = hiddenMetrics.has(m);
                    return (
                      <li key={m}>
                        <button
                          onClick={() =>
                            setHiddenMetrics((prev) => {
                              const next = new Set(prev);
                              if (next.has(m)) next.delete(m);
                              else next.add(m);
                              return next;
                            })
                          }
                          className={cn(
                            "w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted/50 flex items-center gap-2",
                            hidden && "text-muted-foreground line-through",
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              hidden ? "bg-muted-foreground/40" : "bg-primary",
                            )}
                          />
                          {m}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Stats footer */}
            <RunStatsTable runs={runsState.data ?? []} />
          </aside>
        </div>
      </div>

      <ComparisonModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        currentExperiment={experimentName}
        alreadyAdded={new Set(comparison.map((c) => c.hash))}
        onAdd={(run) => {
          setComparison((prev) =>
            prev.find((c) => c.hash === run.hash) ? prev : [...prev, run],
          );
        }}
      />
    </AppShell>
  );
}

function SegButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 rounded px-2 py-1 transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RunStatsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return null;
  const losses = runs
    .map((r) => r.final_loss)
    .filter((v): v is number => v != null && isFinite(v));
  const best = losses.length > 0 ? Math.min(...losses) : null;
  const median =
    losses.length > 0
      ? losses.slice().sort((a, b) => a - b)[Math.floor(losses.length / 2)]
      : null;
  const totalDuration = runs.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
        Run stats
      </div>
      <dl className="grid grid-cols-2 gap-y-1.5 gap-x-3 text-xs font-mono">
        <dt className="text-muted-foreground">Best loss</dt>
        <dd className="text-right text-tabular">
          {best != null ? best.toFixed(4) : "—"}
        </dd>
        <dt className="text-muted-foreground">Median</dt>
        <dd className="text-right text-tabular">
          {median != null ? median.toFixed(4) : "—"}
        </dd>
        <dt className="text-muted-foreground">Σ duration</dt>
        <dd className="text-right text-tabular">{formatDuration(totalDuration)}</dd>
        <dt className="text-muted-foreground">Active</dt>
        <dd className="text-right text-tabular">
          {runs.filter((r) => r.active).length}
        </dd>
      </dl>
    </div>
  );
}
