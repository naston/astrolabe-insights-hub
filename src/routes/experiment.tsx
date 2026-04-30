import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowLeft, ChevronDown, ExternalLink, Plus, Search } from "lucide-react";

import { api, DEFAULT_PALETTE } from "@/lib/api";
import type { Experiment, MetricSeries, Run } from "@/lib/types";
import { usePolling } from "@/hooks/use-polling";
import { formatDuration, formatRelative, formatTimestamp, isActiveState } from "@/lib/format";
import { CopyableHash } from "@/components/copyable-hash";
import { cn } from "@/lib/utils";

import { AppShell } from "@/components/app-shell";
import { StatusDot } from "@/components/status-dot";
import { StateBadge } from "@/components/state-badge";
import { FreshnessPill } from "@/components/freshness-pill";
import { FSMHistory } from "@/components/fsm-history";
import { ChartZoomProvider } from "@/hooks/chart-zoom-provider";
import { type XAxisMode } from "@/hooks/use-chart-zoom";
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
  /** "v1", "v2", … (1-indexed, oldest first). Derived from `Run.version`. */
  label: string;
  /** All runs that belong to this version (e.g., BERT + LatentBERT). */
  runs: Run[];
  /** Earliest creation_time (Unix seconds) across the version's runs — used for ordering and "age". */
  createdAt: number;
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
  const expState = usePolling((signal) => api.experiments(signal), [], {
    intervalMs: RUNS_POLL_MS,
  });
  const experiment: Experiment | undefined = useMemo(
    () => expState.data?.find((e) => e.name === experimentName),
    [expState.data, experimentName],
  );

  // Runs for this experiment — each run is one submitted "version".
  const runsState = usePolling((signal) => api.runs(experimentName, signal), [experimentName], {
    intervalMs: RUNS_POLL_MS,
  });

  // Group runs by version. One submit (= one version) typically contains
  // multiple runs (one per declared training job — e.g. BERT + LatentBERT).
  // Runs without a version field default to "v1" so legacy data still loads.
  const versions: VersionInfo[] = useMemo(() => {
    const byVersion = new Map<string, Run[]>();
    for (const run of runsState.data ?? []) {
      const label = run.version || "v1";
      const list = byVersion.get(label) ?? [];
      list.push(run);
      byVersion.set(label, list);
    }
    return Array.from(byVersion.entries())
      .map(([label, runs]): VersionInfo => {
        // creation_time is Unix seconds (number) from the Aim REST API.
        // Math.min for proper numeric comparison, not Array.sort()
        // which would default to string-lexicographic ordering.
        const createdAt = runs.length > 0 ? Math.min(...runs.map((r) => r.creation_time)) : 0;
        return { label, runs, createdAt };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [runsState.data]);

  // Resolve the selected version. "latest" tracks the most recent submit.
  const isLatestPin = versionParam === "latest";
  const selectedVersion: VersionInfo | undefined = useMemo(() => {
    if (versions.length === 0) return undefined;
    if (isLatestPin) return versions[versions.length - 1];
    const match = versions.find((v) => v.label === versionParam);
    return match ?? versions[versions.length - 1];
  }, [versions, versionParam, isLatestPin]);

  const isOnLatest = selectedVersion && selectedVersion === versions[versions.length - 1];

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
  // Seeded from the experiment's --include list (the astrolabe submit
  // flag), then user-extendable via the "Add comparison runs" modal.
  // Without this fetch the --include flag is silently ignored on the
  // dashboard side: the Go API exposes /api/experiments/{name}/includes
  // but nothing reads it.
  const [comparison, setComparison] = useState<ComparisonRunPick[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  // Track which run hashes the user has explicitly removed via the X
  // button. We respect those across re-fetches of /includes so the
  // include doesn't keep re-adding a run the user dismissed.
  const [removedFromIncludes, setRemovedFromIncludes] = useState<Set<string>>(new Set());

  // Includes that came back type="unknown" — no Aim runs matched the
  // string. We track these so we can render an "unresolved" banner
  // instead of silently dropping them. v1.4.x: previously these went
  // to /dev/null and the user just got a smaller comparison set than
  // they asked for.
  const [unresolvedIncludes, setUnresolvedIncludes] = useState<string[]>([]);

  // Fetch and auto-populate comparison runs from the experiment's
  // --include list. Reruns when the experiment changes (deep links from
  // Linear / git tags). Polls at the experiment-list cadence so newly
  // landed runs from an included experiment appear without a refresh.
  useEffect(() => {
    if (!experimentName) return;
    let cancelled = false;
    const ctrl = new AbortController();
    async function load() {
      try {
        const data = await api.includes(experimentName, ctrl.signal);
        if (cancelled) return;
        const seedHashes: ComparisonRunPick[] = [];
        const unresolved: string[] = [];
        for (const group of data.includes ?? []) {
          if (group.type === "unknown") {
            unresolved.push(group.name);
            continue;
          }
          for (const hash of group.runs) {
            if (hash && !removedFromIncludes.has(hash)) {
              seedHashes.push({
                hash,
                name: group.name,
                experiment: group.name,
              });
            }
          }
        }
        // Merge: keep user-added comparisons that aren't in the include
        // (so the modal-driven additions persist alongside the auto-seed).
        setComparison((prev) => {
          const seen = new Set(seedHashes.map((s) => s.hash));
          const userOnly = prev.filter((p) => !seen.has(p.hash));
          return [...seedHashes, ...userOnly];
        });
        setUnresolvedIncludes(unresolved);
      } catch {
        /* keep prior state on error — quiet polling */
      }
    }
    load();
    const id = window.setInterval(load, RUNS_POLL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [experimentName, removedFromIncludes]);

  // The detail page overlays the runs of one *version* (the selected version
  // — typically "latest"). The version selector picks which submit's runs
  // are shown; comparison runs from OTHER experiments are appended on top.
  // Cross-version comparison happens by switching the version selector, not
  // by overlaying every version on the same chart (that gets unreadable
  // fast for experiments with several runs per version).
  const allRuns = useMemo(() => {
    const native: ComparisonRunPick[] =
      selectedVersion?.runs.map((r) => ({
        hash: r.hash,
        name: r.name,
        experiment: r.experiment,
        submitted_by: r.submitted_by,
      })) ?? [];
    return [...native, ...comparison.filter((c) => !native.find((n) => n.hash === c.hash))];
  }, [selectedVersion, comparison]);

  // Per-run metadata: active flag + creationMs (for wall-time x-axis) +
  // the version label so we can show "v3" alongside the run's identity.
  const runMeta = useMemo(() => {
    const map: Record<
      string,
      {
        active: boolean;
        creationMs: number;
        experiment: string;
        name: string;
        version?: string;
      }
    > = {};
    for (const v of versions) {
      for (const r of v.runs) {
        map[r.hash] = {
          active: r.active,
          // creation_time from the Go API is Unix seconds (float).
          creationMs: r.creation_time * 1000,
          experiment: r.experiment,
          name: r.name,
          version: v.label,
        };
      }
    }
    // Comparison runs from other experiments — we don't poll them, no version label.
    for (const c of comparison) {
      map[c.hash] ??= {
        active: false,
        creationMs: 0,
        experiment: c.experiment,
        name: c.name,
      };
    }
    return map;
  }, [versions, comparison]);

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

  // "by alice" line on each run — only renders when the visible runs
  // span more than one distinct submitter. Single-user contexts (the
  // common case) get no extra visual weight; multi-user contexts
  // (comparison runs from other people) make the identity explicit.
  const showSubmitterLines = useMemo(() => {
    const submitters = new Set<string>();
    for (const r of allRuns) {
      if (r.submitted_by) submitters.add(r.submitted_by);
    }
    return submitters.size > 1;
  }, [allRuns]);

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

  // Discover available metrics across all runs (native + included)
  const metricNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of runsState.data ?? []) {
      for (const m of r.metrics ?? []) {
        // wall_time is logged by the AstrolabeLogger as a way to map
        // step → elapsed-seconds for the X-axis "Wall time" toggle.
        // It's not a metric researchers care to plot on its own; hide
        // it from the metric list (and therefore the chart panel).
        if (m.name === "wall_time") continue;
        set.add(m.name);
      }
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
          lastUpdated={Math.max(expState.lastUpdated ?? 0, runsState.lastUpdated ?? 0) || null}
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
              <h1 className="text-xl font-semibold tracking-tight truncate">{experimentName}</h1>
              {experiment?.submitted_by && (
                <span
                  className="text-xs text-muted-foreground font-mono"
                  title={`Submitted by ${experiment.submitted_by}`}
                >
                  by {experiment.submitted_by}
                </span>
              )}
              {experiment && <StateBadge state={experiment.state} />}
              {live && (
                <span className="rounded bg-[color-mix(in_oklab,var(--info)_15%,transparent)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--info)] uppercase tracking-wider">
                  live
                </span>
              )}
              <VersionSelector
                versions={versions}
                selectedLabel={selectedVersion?.label}
                pinnedLatest={isLatestPin}
                onSelect={(label) => {
                  navigate({
                    to: "/experiment",
                    search: { name: experimentName, version: label },
                  });
                }}
              />
              {!isLatestPin && !isOnLatest && versions.length > 0 && (
                <button
                  onClick={() =>
                    navigate({
                      to: "/experiment",
                      search: { name: experimentName, version: "latest" },
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--warning)] hover:bg-[color-mix(in_oklab,var(--warning)_20%,transparent)]"
                  title="Pin to the most recent submit"
                >
                  ← jump to latest
                </button>
              )}
              <a
                href={experiment?.linear_doc_url || linearSearchFallback(experimentName)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-border-strong"
                title={
                  experiment?.linear_doc_url
                    ? "Open the experiment writeup in Linear"
                    : "No Linear doc URL recorded — opening Linear search as a fallback"
                }
              >
                Linear doc
                <ExternalLink className="h-3 w-3" />
              </a>
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
              <span>
                {selectedVersion?.label ?? "—"} of {versions.length || "—"}
              </span>
              {comparison.length > 0 && (
                <>
                  <span className="opacity-50">·</span>
                  <span className="text-foreground">+{comparison.length} comparison</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* FSM history */}
        {experiment && <FSMHistory current={experiment.state} history={experiment.state_history} />}

        {/* Unresolved-include banner. v1.4.x surfaces include strings
            that didn't match any hash, experiment, or run name —
            previously those silently disappeared from the comparison
            set, leaving the user wondering why their compare list
            came back short. Run-name matches now resolve to a single
            latest run, so the wider-scope warning has gone away. */}
        {unresolvedIncludes.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
            <div className="text-warning-foreground">
              <span className="font-medium">
                Unresolved include{unresolvedIncludes.length > 1 ? "s" : ""}:
              </span>{" "}
              {unresolvedIncludes.map((n, i) => (
                <span key={n}>
                  {i > 0 && ", "}
                  <code className="rounded bg-background/60 px-1 py-0.5 line-through">{n}</code>
                </span>
              ))}
              <span className="ml-1 text-muted-foreground">
                — no Aim experiment, run, or hash matched.
              </span>
            </div>
          </div>
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
                <SegButton active={xMode === "step"} onClick={() => setXMode("step")}>
                  Step
                </SegButton>
                <SegButton active={xMode === "wall_time"} onClick={() => setXMode("wall_time")}>
                  Wall time
                </SegButton>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
                Drag any chart to zoom — all charts sync. Double-click to reset.
              </p>
            </div>

            {/* Runs — single consolidated panel: filter, show-all/none, add-comparison,
                and the legend list with per-row visibility toggles. The legend IS the
                runs list; splitting them into two boxes was duplication. */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Runs ({visibleRuns.length})
                  </span>
                  {selectedVersion && (
                    <span className="text-[10px] font-mono text-muted-foreground">
                      pinned: {selectedVersion.label}
                    </span>
                  )}
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
                    onClick={() => setHiddenRuns(new Set(visibleRuns.map((r) => r.hash)))}
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
              <ul className="max-h-[320px] overflow-y-auto scrollbar-thin divide-y divide-border">
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
                              {showSubmitterLines && r.submitted_by && (
                                <span> · by {r.submitted_by}</span>
                              )}
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
                          onClick={() => {
                            setComparison((prev) => prev.filter((c) => c.hash !== r.hash));
                            // Suppress this hash from the auto-include
                            // refetch loop so it doesn't re-appear on
                            // the next poll. Modal re-add (re-include
                            // via the modal) clears it; full page
                            // reload also clears.
                            setRemovedFromIncludes((prev) => new Set([...prev, r.hash]));
                          }}
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

            {/* Per-run stats — one row per run of the selected version, with
                a metric + best/last selector so the headline column is
                explicit (and "winner" gets a tinted row when best). */}
            <RunStatsTable
              versionLabel={selectedVersion?.label}
              runs={selectedVersion?.runs ?? []}
              runColors={runColors}
              availableMetrics={metricNames}
              showSubmitterLines={showSubmitterLines}
            />
          </aside>
        </div>
      </div>

      <ComparisonModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        currentExperiment={experimentName}
        alreadyAdded={new Set(comparison.map((c) => c.hash))}
        onAdd={(run) => {
          setComparison((prev) => (prev.find((c) => c.hash === run.hash) ? prev : [...prev, run]));
          // If this run was previously removed (X), un-suppress it so
          // re-adding via the modal sticks across the next include refetch.
          setRemovedFromIncludes((prev) => {
            if (!prev.has(run.hash)) return prev;
            const next = new Set(prev);
            next.delete(run.hash);
            return next;
          });
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

type StatsMeasurement = "best" | "last";

/** Heuristic — does "best" mean min or max for this metric name? */
function metricDirection(name: string): "min" | "max" {
  // Loss-shaped metrics where lower is better.
  if (/loss|error|perplexity|\bppl\b|nll/i.test(name)) return "min";
  // Score-shaped metrics where higher is better.
  if (/accuracy|f1|auc|precision|recall|score|\bbleu\b|\brouge\b/i.test(name)) return "max";
  // Default to min for anything unclassified — most ML metrics that you'd
  // want to "find the best of" are loss-shaped.
  return "min";
}

/**
 * Per-run stats table for the sidebar. One row per run of the SELECTED
 * version — the runs being compared in the charts above. For an
 * "architecture-comparison" experiment with two models, this is two rows
 * (BERT, LatentBERT) with their respective metrics; switching the version
 * selector swaps which version's runs populate the table.
 *
 * The table's headline column is configurable: the user picks which metric
 * to show, and whether to display the **best** value (min or max depending
 * on the metric — losses minimize, scores maximize) or the **last** logged
 * value. Both are useful for different questions: "which run won?" wants
 * best, "what was the run's final state?" wants last.
 */
function RunStatsTable({
  versionLabel,
  runs,
  runColors,
  availableMetrics,
  showSubmitterLines,
}: {
  versionLabel: string | undefined;
  runs: Run[];
  runColors: Record<string, string>;
  availableMetrics: string[];
  showSubmitterLines: boolean;
}) {
  // Default to train/loss when present, otherwise the first available metric.
  const defaultMetric = useMemo(() => {
    if (availableMetrics.includes("train/loss")) return "train/loss";
    return availableMetrics[0] ?? "train/loss";
  }, [availableMetrics]);
  const [metric, setMetric] = useState<string>(defaultMetric);
  const [measurement, setMeasurement] = useState<StatsMeasurement>("best");

  // Re-default when the available list changes (e.g. switching experiments).
  useEffect(() => {
    if (!availableMetrics.includes(metric)) {
      setMetric(defaultMetric);
    }
  }, [availableMetrics, defaultMetric, metric]);

  // Fetch the chosen metric for each run. Refreshes every 5s so active runs
  // see updated values without burning the chart-poll cadence (2s) on the
  // sidebar.
  const [series, setSeries] = useState<Record<string, MetricSeries | null>>({});
  const runHashes = useMemo(() => runs.map((r) => r.hash).join(","), [runs]);
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function fetchAll() {
      const entries = await Promise.all(
        runs.map(async (r): Promise<[string, MetricSeries | null]> => {
          try {
            const s = await api.metric(r.hash, metric, ctrl.signal);
            return [r.hash, s];
          } catch {
            return [r.hash, null];
          }
        }),
      );
      if (!cancelled) {
        setSeries(Object.fromEntries(entries));
      }
    }
    fetchAll();
    const id = window.setInterval(fetchAll, 5000);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [runHashes, metric, runs]);

  const direction = metricDirection(metric);
  const computed = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const r of runs) {
      const s = series[r.hash];
      if (!s || s.values.length === 0) {
        out[r.hash] = null;
        continue;
      }
      if (measurement === "last") {
        out[r.hash] = s.values[s.values.length - 1];
      } else {
        out[r.hash] = direction === "min" ? Math.min(...s.values) : Math.max(...s.values);
      }
    }
    return out;
  }, [series, runs, measurement, direction]);

  if (runs.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Run stats
          </span>
          {versionLabel && (
            <span className="text-[10px] font-mono text-muted-foreground">{versionLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            title="Metric shown in the value column"
          >
            {availableMetrics.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="flex rounded-md border border-border bg-surface p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setMeasurement("best")}
              className={cn(
                "px-2 py-0.5 rounded transition-colors",
                measurement === "best"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={`Best value across the run (${direction === "min" ? "minimum" : "maximum"} of ${metric})`}
            >
              best
            </button>
            <button
              type="button"
              onClick={() => setMeasurement("last")}
              className={cn(
                "px-2 py-0.5 rounded transition-colors",
                measurement === "last"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={`Last logged value of ${metric}`}
            >
              last
            </button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">run</th>
              <th className="text-left px-2 py-1.5 font-medium">hash</th>
              <th
                className="text-right px-2 py-1.5 font-medium"
                title={`${metric} · ${measurement}`}
              >
                <span className="truncate inline-block max-w-[80px] align-middle">{metric}</span>
                <span className="opacity-60"> · {measurement}</span>
              </th>
              <th className="text-right px-2 py-1.5 font-medium">dur</th>
              <th className="text-right px-2 py-1.5 font-medium">state</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => {
              const stateLabel = r.active ? "live" : r.end_time ? "done" : "—";
              const value = computed[r.hash];
              // Highlight the row that holds the best value across all runs
              // — quick "which one won?" cue when measurement = best.
              const isWinner =
                measurement === "best" &&
                value != null &&
                Object.values(computed)
                  .filter((v): v is number => v != null)
                  .every((other) => (direction === "min" ? value <= other : value >= other));
              return (
                <tr
                  key={r.hash}
                  className={cn(
                    "hover:bg-muted/50",
                    isWinner && "bg-[color-mix(in_oklab,var(--success)_8%,transparent)]",
                  )}
                >
                  <td className="px-2 py-1.5 align-middle">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 rounded-sm shrink-0"
                        style={{ backgroundColor: runColors[r.hash] ?? "#888" }}
                      />
                      <span className="text-foreground truncate">{r.name}</span>
                      {showSubmitterLines && r.submitted_by && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          by {r.submitted_by}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 align-middle text-muted-foreground">
                    <CopyableHash hash={r.hash} />
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 align-middle text-right text-tabular",
                      isWinner && "text-[var(--success)] font-medium",
                    )}
                  >
                    {value != null ? value.toFixed(4) : "—"}
                  </td>
                  <td className="px-2 py-1.5 align-middle text-right text-tabular text-muted-foreground">
                    {r.duration || "—"}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 align-middle text-right",
                      r.active && "text-[var(--info)]",
                      !r.active && r.end_time && "text-muted-foreground",
                    )}
                  >
                    {stateLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Soft-landing fallback when the experiment record has no recorded
 * `linear_doc_url`. Opens Linear's search with the experiment name so the
 * user can still find the doc — but this is a last resort, not the primary
 * link target. Real backends should populate `linear_doc_url` directly.
 */
function linearSearchFallback(experimentName: string): string {
  const q = encodeURIComponent(experimentName);
  return `https://linear.app/search?q=${q}`;
}

interface VersionSelectorProps {
  versions: VersionInfo[];
  selectedLabel: string | undefined;
  pinnedLatest: boolean;
  onSelect: (label: string) => void;
}

function VersionSelector({
  versions,
  selectedLabel,
  pinnedLatest,
  onSelect,
}: VersionSelectorProps) {
  const [open, setOpen] = useState(false);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onClick = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (versions.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-mono text-muted-foreground">
        no versions
      </span>
    );
  }

  // Newest first in the dropdown
  const ordered = [...versions].reverse();
  const latest = versions[versions.length - 1];

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono",
          pinnedLatest
            ? "border-border bg-surface text-muted-foreground hover:text-foreground"
            : "border-primary/40 bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] text-foreground",
        )}
        title="Switch version"
      >
        <span className="text-tabular text-foreground font-medium">{selectedLabel ?? "—"}</span>
        <span className="opacity-60">of {versions.length}</span>
        {pinnedLatest && (
          <span className="rounded bg-muted px-1 py-px text-[9px] uppercase tracking-wider text-muted-foreground">
            latest
          </span>
        )}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover shadow-xl overflow-hidden"
          role="menu"
        >
          <button
            onClick={() => {
              onSelect("latest");
              setOpen(false);
            }}
            className={cn(
              "w-full text-left px-3 py-2 text-xs font-mono hover:bg-muted flex items-center justify-between border-b border-border",
              pinnedLatest && "bg-[color-mix(in_oklab,var(--primary)_10%,transparent)]",
            )}
            role="menuitem"
          >
            <span className="flex items-center gap-2">
              <span className="text-foreground font-medium">latest</span>
              <span className="text-muted-foreground">→ {latest.label}</span>
            </span>
            <span className="text-[10px] text-muted-foreground">tracks newest</span>
          </button>
          <ul className="max-h-[280px] overflow-y-auto scrollbar-thin">
            {ordered.map((v) => {
              const isSelected = v.label === selectedLabel && !pinnedLatest;
              const runCount = v.runs.length;
              return (
                <li key={v.label}>
                  <button
                    onClick={() => {
                      onSelect(v.label);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted flex items-center justify-between gap-3",
                      isSelected && "bg-[color-mix(in_oklab,var(--primary)_10%,transparent)]",
                    )}
                    role="menuitem"
                    title={`${v.label} — ${runCount} run${runCount === 1 ? "" : "s"} — ${formatTimestamp(v.createdAt)}`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-foreground shrink-0">{v.label}</span>
                      <span className="text-[10px] text-muted-foreground truncate">
                        {runCount} run{runCount === 1 ? "" : "s"}
                        {v.runs.length > 0 && (
                          <>
                            {" · "}
                            {v.runs.map((r) => r.name).join(", ")}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground text-tabular shrink-0">
                      {formatRelative(v.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
