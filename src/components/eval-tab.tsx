/**
 * Eval tab — renders benchmark results for the runs currently in scope.
 *
 * Scaffolded against MOCK DATA so the layout can be critiqued before
 * the producer-side helper (``astrolabe.eval_results.log_eval_table``)
 * and the Go API endpoint (``/api/runs/evals``) land. Swap
 * ``useMockEvals`` for the real fetch hook when they do.
 *
 * Design — see plans/eval-runs.md:
 *   * Two block types dispatched by data shape: TableBlock (all step=0)
 *     and TraceBlock (any step > 0). One eval Aim run produces one
 *     block.
 *   * TableBlock rows are RUNS (latent-bert-256, latent-bert-512, ...);
 *     columns are tasks within the task_set. ``avg`` is researcher-
 *     logged, not dashboard-computed.
 *   * Blocks are interleaved by task_set so a task_set's leaderboard +
 *     trajectory appear together.
 *   * Currently-viewed run is highlighted with a small dot.
 */
import { useEffect, useMemo, useState } from "react";
import type { ComparisonRunPick } from "@/components/comparison-modal";
import type { Run } from "@/lib/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CopyableHash } from "@/components/copyable-hash";

// ---------------------------------------------------------------- types

/** One eval Aim run's contribution to the dashboard. */
export interface EvalArtifact {
  /** Hash of the eval Aim run (not the model run). */
  evalRunHash: string;
  /** Hash of the model run this eval scores — the join key for the table. */
  modelRunHash: string;
  /** Human label: 'glue', 'mmlu', 'agent-rollouts-2026q2', etc. */
  taskSet: string;
  /** ISO timestamp of the eval's creation_time. */
  completedAt: string;
  /** Discriminator for block rendering. */
  shape: "table" | "trace";
  /** For shape='table': one entry per task. */
  table?: Array<{
    task: string;
    metric: string;      // 'matthews', 'accuracy', ...
    lastValue: number;
  }>;
  /** For shape='trace': one entry per metric, each with a step-series. */
  trace?: Array<{
    task: string;        // 'cola'
    metric: string;      // 'matthews'
    series: Array<{ step: number; value: number }>;
  }>;
}

interface EvalTabProps {
  /** All runs currently visible — same set as the Training tab's charts. */
  runs: Array<{ hash: string; name: string; experiment: string }>;
  /** Hash of the currently-viewed run (gets the highlight dot). */
  currentRunHash: string | undefined;
  /** Color map keyed by run hash (matches Training tab palette). */
  runColors: Record<string, string>;
  /** Run hashes the user has toggled off via the shared RunsPanel. Hidden
   * runs drop from table rows and trace chart lines. */
  hiddenRunHashes?: Set<string>;
}

// ---------------------------------------------------------------- data fetch

interface FetchState {
  artifacts: EvalArtifact[];
  loading: boolean;
  error: string | null;
}

/**
 * Discover eval Aim runs for each model run in scope, then resolve
 * each eval run's metric series into a renderable EvalArtifact.
 *
 * Fetch graph per model run:
 *   /api/runs/<model_hash>/evals          → manifest (one per task_set)
 *   /api/runs/<eval_hash>/info            → metric names (eval/<task>/<metric>)
 *   /api/runs/<eval_hash>/metrics/<name>  → step + value series per metric
 *
 * Shape dispatch: a metric's series with any step > 0 makes the whole
 * eval-run a "trace" artifact; otherwise "table". This matches the
 * producer-side intent (log_eval_table always tracks at step=0;
 * mid-training rolling evals use start_eval_run with step>0).
 *
 * Refetches when ``runs`` changes by hash-set; in-flight requests are
 * aborted so a fast-switching version selector doesn't paint stale
 * data over fresh.
 */
function useRealEvals(runs: EvalTabProps["runs"]): FetchState {
  const [state, setState] = useState<FetchState>({
    artifacts: [],
    loading: true,
    error: null,
  });

  // Stable dependency: hash list joined as a string so [a,b] vs [a,b]
  // doesn't re-trigger from new array identity.
  const runsKey = runs.map((r) => r.hash).join(",");

  useEffect(() => {
    if (runs.length === 0) {
      setState({ artifacts: [], loading: false, error: null });
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;

    async function buildArtifactsForRun(
      modelRunHash: string,
    ): Promise<EvalArtifact[]> {
      const manifest = await api.evals(modelRunHash, ctrl.signal);
      // For each eval Aim run, fetch info (to enumerate metric names)
      // then fetch each metric's series. The series tell us shape +
      // values; we can't tell shape from the manifest alone.
      const built = await Promise.all(
        manifest.map(async (entry) => {
          const info = await api.runInfo(entry.aim_run_hash, ctrl.signal);
          const metricNames = (info.traces?.metric ?? [])
            .map((m) => m.name)
            // Only metrics following the eval/<task>/<metric> convention
            // can be parsed into table columns. Loose metrics off-shape
            // (e.g., eval/wall_time) are kept for the trace path but
            // dropped from the table renderer.
            .filter((n) => n.startsWith("eval/"));

          const seriesByMetric = await Promise.all(
            metricNames.map(async (name) => ({
              name,
              series: await api.metric(entry.aim_run_hash, name, ctrl.signal),
            })),
          );

          // Shape dispatch: any series with a step > 0 makes the whole
          // artifact a trace. The producer-side intent is
          // ``log_eval_table → step=0``; ``start_eval_run + multi-step
          // → trace``.
          const anyMultiStep = seriesByMetric.some(({ series }) =>
            (series.steps ?? []).some((s) => s > 0),
          );

          const completedAtIso = new Date(
            (entry.creation_time ?? 0) * 1000,
          ).toISOString();

          if (!anyMultiStep) {
            const table = seriesByMetric
              .map(({ name, series }) => {
                const parts = name.split("/");
                // ``eval/<task>/<metric>`` — three parts. Skip on
                // unexpected shapes so a stray metric can't crash the
                // section.
                if (parts.length < 3) return null;
                const task = parts[1];
                const metric = parts.slice(2).join("/");
                const lastValue = series.values?.length
                  ? series.values[series.values.length - 1]
                  : NaN;
                if (!Number.isFinite(lastValue)) return null;
                return { task, metric, lastValue };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);
            return {
              evalRunHash: entry.aim_run_hash,
              modelRunHash,
              taskSet: entry.task_set,
              completedAt: completedAtIso,
              shape: "table" as const,
              table,
            };
          }

          const trace = seriesByMetric
            .map(({ name, series }) => {
              const parts = name.split("/");
              if (parts.length < 3) return null;
              const task = parts[1];
              const metric = parts.slice(2).join("/");
              const points = (series.steps ?? []).map((step, i) => ({
                step,
                value: series.values?.[i] ?? NaN,
              }));
              return { task, metric, series: points };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          return {
            evalRunHash: entry.aim_run_hash,
            modelRunHash,
            taskSet: entry.task_set,
            completedAt: completedAtIso,
            shape: "trace" as const,
            trace,
          };
        }),
      );
      return built;
    }

    async function fetchAll() {
      setState((s) => ({ ...s, loading: true }));
      try {
        const perRun = await Promise.all(
          runs.map((r) => buildArtifactsForRun(r.hash)),
        );
        if (cancelled) return;
        const flattened = perRun.flat();
        setState({ artifacts: flattened, loading: false, error: null });
      } catch (e) {
        if (cancelled || ctrl.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ artifacts: [], loading: false, error: msg });
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey]);

  return state;
}

// ---------------------------------------------------------------- main

export function EvalTab({
  runs,
  currentRunHash,
  runColors,
  hiddenRunHashes,
}: EvalTabProps) {
  // Filter out runs the user has hidden via the shared RunsPanel before
  // anything else — table rows and trace lines both respect the toggle.
  const visibleRuns = useMemo(
    () => (hiddenRunHashes ? runs.filter((r) => !hiddenRunHashes.has(r.hash)) : runs),
    [runs, hiddenRunHashes],
  );

  const { artifacts, loading, error } = useRealEvals(visibleRuns);

  // Group artifacts by (task_set). Each group becomes one block; the
  // shape is read from the first artifact in the group (all artifacts
  // in a group share the same shape by construction — see plan).
  const groups = useMemo(() => {
    const byTaskSet = new Map<string, EvalArtifact[]>();
    for (const a of artifacts) {
      const list = byTaskSet.get(a.taskSet) ?? [];
      list.push(a);
      byTaskSet.set(a.taskSet, list);
    }
    return Array.from(byTaskSet.entries())
      .map(([taskSet, items]) => ({
        taskSet,
        shape: items[0].shape,
        completedAt: items[0].completedAt,
        items,
      }))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }, [artifacts]);

  // Empty-state copy: distinguish "no runs visible" (everything hidden
  // via the RunsPanel) from "no eval data has been logged for any of
  // these runs." Same neutral surface either way, but the actionable
  // message differs.
  if (visibleRuns.length === 0 && runs.length > 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
        All runs are hidden. Toggle one back on from the Runs panel to
        see its eval results.
      </div>
    );
  }

  // Error surfaces before empty-state. The API call may fail because
  // the Go backend isn't reachable; api.evals has a seed fallback that
  // returns [] on unreachable, so a non-null error here means a real
  // HTTP error (4xx/5xx). Surface it so the user can see something's
  // wrong instead of silently rendering "no eval data."
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center text-sm">
        <div className="font-medium text-destructive">
          Failed to load eval data
        </div>
        <div className="mt-1 text-xs font-mono text-muted-foreground">
          {error}
        </div>
      </div>
    );
  }

  // Loading skeleton — only on the FIRST render (artifacts empty + loading).
  // Subsequent fetches (version switch) keep the previous artifacts
  // visible so the table doesn't flash empty during refetch.
  if (loading && artifacts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
        Loading eval data…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
        No eval data for these runs yet. Eval data appears here once a
        researcher calls{" "}
        <code className="rounded bg-background/60 px-1 py-0.5 font-mono">
          astrolabe.eval_results.log_eval_table(...)
        </code>{" "}
        against one of these run hashes.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) =>
        g.shape === "table" ? (
          <EvalTableBlock
            key={g.taskSet}
            taskSet={g.taskSet}
            completedAt={g.completedAt}
            artifacts={g.items}
            runs={visibleRuns}
            currentRunHash={currentRunHash}
            runColors={runColors}
          />
        ) : (
          <EvalTraceBlock
            key={g.taskSet}
            taskSet={g.taskSet}
            completedAt={g.completedAt}
            artifacts={g.items}
            runs={visibleRuns}
            currentRunHash={currentRunHash}
            runColors={runColors}
          />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- table block

function EvalTableBlock({
  taskSet,
  completedAt,
  artifacts,
  runs,
  currentRunHash,
  runColors,
}: {
  taskSet: string;
  completedAt: string;
  artifacts: EvalArtifact[];
  runs: EvalTabProps["runs"];
  currentRunHash: string | undefined;
  runColors: Record<string, string>;
}) {
  // Build a stable column set: union of tasks across all artifacts in the
  // block. ``avg`` always renders last per the plan convention.
  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const a of artifacts) {
      for (const row of a.table ?? []) set.add(row.task);
    }
    const cols = Array.from(set);
    const avg = cols.find((c) => c === "avg");
    const rest = cols.filter((c) => c !== "avg").sort();
    return avg ? [...rest, avg] : rest;
  }, [artifacts]);

  // Quick lookup: model run hash → its row from the artifact.
  const rowByHash = useMemo(() => {
    const map = new Map<string, EvalArtifact>();
    for (const a of artifacts) map.set(a.modelRunHash, a);
    return map;
  }, [artifacts]);

  // Metric label per task — for the column header tooltip. Picks the
  // first non-empty metric label we find for that task across artifacts.
  const metricByTask = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of artifacts) {
      for (const row of a.table ?? []) {
        if (!map[row.task]) map[row.task] = row.metric;
      }
    }
    return map;
  }, [artifacts]);

  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
            {taskSet}
          </h3>
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            table block
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          evaluated {completedAt.slice(0, 10)}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">run</th>
              {columns.map((col) => (
                <th
                  key={col}
                  className={cn(
                    "text-right px-3 py-1.5 font-medium",
                    col === "avg" && "border-l border-border",
                  )}
                  title={metricByTask[col] ? `metric: ${metricByTask[col]}` : col}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => {
              const artifact = rowByHash.get(r.hash);
              const isCurrent = r.hash === currentRunHash;
              return (
                <tr key={r.hash} className="hover:bg-muted/50">
                  <td className="px-3 py-1.5 align-middle">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-sm shrink-0 ring-1 ring-border-strong"
                        style={{ backgroundColor: runColors[r.hash] ?? "#888" }}
                      />
                      {isCurrent && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-[var(--info)] shrink-0"
                          title="Currently viewed run"
                        />
                      )}
                      <span className="text-foreground truncate">{r.name}</span>
                      <CopyableHash
                        hash={r.hash}
                        className="font-mono text-[10px] text-muted-foreground shrink-0"
                      />
                    </div>
                  </td>
                  {columns.map((col) => {
                    const cell = artifact?.table?.find((row) => row.task === col);
                    return (
                      <td
                        key={col}
                        className={cn(
                          "px-3 py-1.5 align-middle text-right text-tabular",
                          col === "avg" && "border-l border-border font-medium",
                          !cell && "text-muted-foreground/60",
                        )}
                      >
                        {cell ? cell.lastValue.toFixed(3) : "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- trace block

function EvalTraceBlock({
  taskSet,
  completedAt,
  artifacts,
  runs,
  currentRunHash,
  runColors,
}: {
  taskSet: string;
  completedAt: string;
  artifacts: EvalArtifact[];
  runs: EvalTabProps["runs"];
  currentRunHash: string | undefined;
  runColors: Record<string, string>;
}) {
  // Group trace series by (task, metric) so we render one mini-chart
  // per metric, with one line per run.
  const charts = useMemo(() => {
    type ChartKey = string;
    const map = new Map<
      ChartKey,
      {
        task: string;
        metric: string;
        lines: Array<{
          runHash: string;
          series: Array<{ step: number; value: number }>;
        }>;
      }
    >();
    for (const a of artifacts) {
      for (const t of a.trace ?? []) {
        const key = `${t.task}/${t.metric}`;
        const entry = map.get(key) ?? { task: t.task, metric: t.metric, lines: [] };
        entry.lines.push({ runHash: a.modelRunHash, series: t.series });
        map.set(key, entry);
      }
    }
    return Array.from(map.values());
  }, [artifacts]);

  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
            {taskSet}
          </h3>
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            trace block
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          last updated {completedAt.slice(0, 10)}
        </span>
      </header>
      <div className="p-4 space-y-4">
        {charts.map((chart) => (
          <div key={`${chart.task}/${chart.metric}`}>
            <div className="mb-2 flex items-baseline gap-2 text-xs font-mono text-muted-foreground">
              <span className="text-foreground">{chart.task}</span>
              <span className="opacity-60">·</span>
              <span>{chart.metric}</span>
            </div>
            <MiniTraceChart lines={chart.lines} runColors={runColors} currentRunHash={currentRunHash} />
            <ul className="mt-2 flex flex-wrap gap-3 text-[10px] font-mono">
              {chart.lines.map((line) => {
                const run = runs.find((r) => r.hash === line.runHash);
                if (!run) return null;
                const isCurrent = line.runHash === currentRunHash;
                return (
                  <li key={line.runHash} className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: runColors[line.runHash] ?? "#888" }}
                    />
                    <span className={cn(isCurrent ? "text-foreground" : "text-muted-foreground")}>
                      {run.name}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Inline-SVG trace renderer — intentionally simple so the layout can be
 * critiqued without reaching for Recharts. Real wiring uses the existing
 * MetricChart component which already handles tooltips, zoom, etc.
 */
function MiniTraceChart({
  lines,
  runColors,
  currentRunHash,
}: {
  lines: Array<{ runHash: string; series: Array<{ step: number; value: number }> }>;
  runColors: Record<string, string>;
  currentRunHash: string | undefined;
}) {
  // Compute bounds across all lines so all paths share an axis.
  const { minStep, maxStep, minValue, maxValue } = useMemo(() => {
    let minS = Infinity, maxS = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const line of lines) {
      for (const pt of line.series) {
        if (pt.step < minS) minS = pt.step;
        if (pt.step > maxS) maxS = pt.step;
        if (pt.value < minV) minV = pt.value;
        if (pt.value > maxV) maxV = pt.value;
      }
    }
    return { minStep: minS, maxStep: maxS, minValue: minV, maxValue: maxV };
  }, [lines]);

  const W = 600;
  const H = 180;
  const PAD = 8;

  // Value range can be zero when every point of every line has the
  // same value (e.g. an eval metric that didn't change between
  // checkpoints, like CoLA matthews=0.02564 at both step 10 and 20).
  // The old fallback ``Math.max(0.0001, 0)`` mapped all points to
  // y=H-PAD, hiding the line against the bottom border. Center the
  // line vertically when the range collapses — that way a flat trace
  // is clearly visible, not "the chart is broken".
  const valueRange = maxValue - minValue;
  const valueIsConstant = !Number.isFinite(valueRange) || valueRange === 0;

  const xs = (step: number) =>
    PAD + ((step - minStep) / Math.max(1, maxStep - minStep)) * (W - 2 * PAD);
  const ys = (value: number) => {
    if (valueIsConstant) return H / 2;
    return H - PAD - ((value - minValue) / valueRange) * (H - 2 * PAD);
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44 rounded-md border border-border bg-background/40">
      {lines.map((line) => {
        const color = runColors[line.runHash] ?? "#888";
        const isCurrent = line.runHash === currentRunHash;
        const path = line.series
          .map((pt, idx) => `${idx === 0 ? "M" : "L"} ${xs(pt.step).toFixed(1)} ${ys(pt.value).toFixed(1)}`)
          .join(" ");
        return (
          <path
            key={line.runHash}
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={isCurrent ? 2.4 : 1.4}
            strokeOpacity={isCurrent ? 1 : 0.65}
          />
        );
      })}
      {/* When every point shares one value the line is informative but
          the number isn't visible anywhere else on the chart. Drop a
          single text label so the reader knows what the flat line is at. */}
      {valueIsConstant && Number.isFinite(minValue) && (
        <text
          x={W - PAD}
          y={H / 2 - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[10px]"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
        >
          {minValue.toFixed(4)}
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- exports

/**
 * Convenience wrapper — takes the same run-set shape the experiment
 * page already builds (``allRuns`` from experiment.tsx) so the page
 * can drop this in without restructuring its state.
 */
export function EvalTabFromAllRuns({
  allRuns,
  currentRunHash,
  runColors,
  hiddenRunHashes,
}: {
  allRuns: Array<Run | ComparisonRunPick>;
  currentRunHash: string | undefined;
  runColors: Record<string, string>;
  hiddenRunHashes?: Set<string>;
}) {
  const runs = allRuns.map((r) => ({
    hash: r.hash,
    name: r.name,
    experiment: "experiment" in r ? r.experiment : "",
  }));
  return (
    <EvalTab
      runs={runs}
      currentRunHash={currentRunHash}
      runColors={runColors}
      hiddenRunHashes={hiddenRunHashes}
    />
  );
}
