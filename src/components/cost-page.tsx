/**
 * Cost page. Lives at /cost, accessed via the home-page Spend KPI card
 * or the top-nav "Cost" link.
 *
 * Design notes (per plans/cost-tracking.md):
 *   - Detail page + home-page rows are intentionally COST-FREE. Cost lives
 *     in exactly two places: the home-page KPI ("Spend (30d)" — single number,
 *     signal) and this page (everything).
 *   - In-flight runs render with estimated cost + a [running] pill. We do
 *     NOT tick the number live; stability over scrolling beats real-time
 *     for a "where did the money go" view.
 *   - Tag dimension intentionally absent. astrolabe has no per-experiment
 *     tags today; revisit when the paper-tagging feature ships.
 *   - Experiments table uses rowspan-style multilevel rendering — accordion-
 *     style noted as a future option if the table grows past a screen.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp, ArrowDown, Minus } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FilterDropdown } from "@/components/filter-dropdown";
import { api } from "@/lib/api";
import type {
  CostExperimentEntry,
  CostGroupByDimension,
  CostResponse,
  CostVersionEntry,
} from "@/lib/types";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";

// Cost data is slower-changing than experiment state. Polling at 30s
// is plenty fresh — a five-minute lag on cost numbers doesn't degrade
// decisions, and the API call is heavier than /api/experiments.
const POLL_MS = 30_000;

const WINDOW_PRESETS: Array<{ value: string; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

const GROUP_BY_OPTIONS: Array<{ value: CostGroupByDimension; label: string }> = [
  { value: "submitter", label: "Submitter" },
  { value: "repo", label: "Repo" },
  { value: "gpu_type", label: "GPU type" },
  { value: "backend", label: "Backend" },
  { value: "outcome", label: "Outcome" },
];

type StackDim = CostGroupByDimension | "none";

const STACK_OPTIONS: Array<{ value: StackDim; label: string }> = [
  { value: "none", label: "None" },
  ...GROUP_BY_OPTIONS,
];

// Outcome bucket the multilevel rows are sorted into — matches the seed
// + future Go backend's normalization (raw outcomes like "timeout"/"stopped"
// collapse into "failed" for the cost page's coarse-grained rollup).
function normalizeOutcomeForFilter(v: { outcome: string | null; cents: number | null }): string {
  if (v.cents === null) return "in_flight";
  if (v.outcome === "success") return "success";
  return "failed";
}

const TERMINAL_FAIL_OUTCOMES = new Set(["failed", "timeout", "stopped"]);

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatHours(hours: number): string {
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}m`;
}

interface CostSearchParams {
  window?: string;
  group_by?: CostGroupByDimension;
  stack?: StackDim;
  f_submitter?: string;
  f_repo?: string;
  f_gpu?: string;
  f_outcome?: string;
}

// Comma-joined multi-select serialization, same convention as the home
// page filter shelf. Empty/missing = no filter.
function decodeList(s?: string): string[] {
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}
function encodeList(xs: string[]): string | undefined {
  return xs.length === 0 ? undefined : xs.join(",");
}

export function CostPage() {
  const search = useSearch({ from: "/cost" }) as CostSearchParams;
  const navigate = useNavigate({ from: "/cost" });

  const window = search.window ?? "30d";
  const groupBy: CostGroupByDimension = search.group_by ?? "submitter";
  const stack: StackDim = search.stack ?? "none";

  const filterSubmitters = decodeList(search.f_submitter);
  const filterRepos = decodeList(search.f_repo);
  const filterGpus = decodeList(search.f_gpu);
  const filterOutcomes = decodeList(search.f_outcome);

  useEffect(() => {
    document.title = "Astrolabe — Cost";
  }, []);

  const { data, error, loading, lastUpdated } = usePolling(
    (signal) => api.cost({ window, group_by: groupBy, stack }, signal),
    [window, groupBy, stack],
    { intervalMs: POLL_MS },
  );

  // resetScroll: false — every control on this page tweaks query params
  // for the same view. Scrolling to top on filter change is jarring
  // (the user is mid-scroll inside the experiments table and the page
  // yanks them away from what they were reading). Suppress consistently
  // across all setters so the behavior matches the user's mental model
  // of "I'm staying on the same page."
  const setWindow = (v: string) =>
    navigate({
      search: (s: CostSearchParams) => ({ ...s, window: v }),
      replace: true,
      resetScroll: false,
    });
  const setGroupBy = (v: CostGroupByDimension) =>
    navigate({
      search: (s: CostSearchParams) => ({ ...s, group_by: v }),
      replace: true,
      resetScroll: false,
    });
  const setStack = (v: StackDim) =>
    navigate({
      search: (s: CostSearchParams) => ({ ...s, stack: v }),
      replace: true,
      resetScroll: false,
    });
  const setFilter = (key: "f_submitter" | "f_repo" | "f_gpu" | "f_outcome", xs: string[]) =>
    navigate({
      search: (s: CostSearchParams) => ({ ...s, [key]: encodeList(xs) }),
      replace: true,
      resetScroll: false,
    });

  if (error) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-12">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load cost data — {error.message}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-12">
        <div className="text-sm text-muted-foreground">Loading cost data…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-6">
      <CostHeader data={data} window={window} setWindow={setWindow} />
      <CostChart data={data} stack={stack} setStack={setStack} />
      <CostBreakdown data={data} groupBy={groupBy} setGroupBy={setGroupBy} />
      <CostExperiments
        data={data}
        filterSubmitters={filterSubmitters}
        filterRepos={filterRepos}
        filterGpus={filterGpus}
        filterOutcomes={filterOutcomes}
        setFilter={setFilter}
      />
      {lastUpdated && (
        <p className="text-xs text-muted-foreground text-right">
          Updated {new Date(lastUpdated).toLocaleTimeString()}
          {loading && " · refreshing…"}
        </p>
      )}
    </div>
  );
}

// --- Header (total, delta, failed inline, window selector) -----------------

function CostHeader({
  data,
  window,
  setWindow,
}: {
  data: CostResponse;
  window: string;
  setWindow: (v: string) => void;
}) {
  // Failed-spend computed locally (per the API contract — see types.ts note
  // on why this isn't a backend field).
  const failedCents = useMemo(
    () =>
      data.experiments
        .flatMap((e) => e.versions)
        .filter((v) => v.outcome !== null && TERMINAL_FAIL_OUTCOMES.has(v.outcome))
        .reduce((sum, v) => sum + (v.cents ?? 0), 0),
    [data.experiments],
  );

  // "All time" has no meaningful prior window — there's nothing earlier to
  // compare against. Suppress the delta in that case rather than synthesize
  // a misleading 100% figure.
  const showDelta = data.window.label !== "all" && data.prior_total_cents > 0;
  const deltaPct = showDelta
    ? ((data.total_cents - data.prior_total_cents) / data.prior_total_cents) * 100
    : null;
  const failedPct = data.total_cents > 0 ? (failedCents / data.total_cents) * 100 : 0;

  return (
    <div className="space-y-2">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to experiments
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Spend</h1>
          <div className="mt-2 flex items-baseline gap-4">
            <span className="text-3xl font-semibold tabular-nums">
              {formatCents(data.total_cents)}
            </span>
            <span className="text-sm text-muted-foreground">
              in last {humanWindowLabel(window)}
            </span>
            {deltaPct !== null && (
              <DeltaPill pct={deltaPct} priorWindow={humanWindowLabel(window)} />
            )}
          </div>
          {failedCents > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              of which{" "}
              <span className="font-medium text-foreground">
                {formatCents(failedCents)}
              </span>{" "}
              ({failedPct.toFixed(0)}%) on failed runs
            </p>
          )}
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>
    </div>
  );
}

function DeltaPill({ pct, priorWindow }: { pct: number; priorWindow: string }) {
  const Icon = pct > 0.5 ? ArrowUp : pct < -0.5 ? ArrowDown : Minus;
  return (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium tabular-nums text-foreground">
        {Math.abs(pct).toFixed(0)}%
      </span>
      <span>vs prior {priorWindow}</span>
    </span>
  );
}

function WindowSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
      {WINDOW_PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChange(p.value)}
          className={cn(
            "px-3 py-1.5 text-sm border-r border-border last:border-r-0 transition-colors",
            value === p.value
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-muted-foreground hover:text-foreground hover:bg-accent/40",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function humanWindowLabel(value: string): string {
  switch (value) {
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "90d":
      return "90 days";
    case "all":
      return "all time";
    default:
      return value;
  }
}

// --- Chart (stacked bars by stacking dimension) -----------------------------

function CostChart({
  data,
  stack,
  setStack,
}: {
  data: CostResponse;
  stack: StackDim;
  setStack: (v: StackDim) => void;
}) {
  // Discover stack keys from the data — backend has already keyed
  // by_dimension to whatever stack dim was requested.
  const stackKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const b of data.time_series) {
      for (const k of Object.keys(b.by_dimension)) seen.add(k);
    }
    return Array.from(seen).sort();
  }, [data.time_series]);

  // Series visibility — clicking a legend item toggles the series in/out.
  // Reset whenever the user changes the stack dimension (keys change).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    setHidden(new Set());
  }, [stack]);

  // Recharts wants one row per bucket with stack keys as columns.
  // Hidden keys become 0 so the bar segment vanishes without recharts
  // re-laying out the rest of the chart.
  const chartData = useMemo(
    () =>
      data.time_series.map((b) => ({
        date: b.start,
        ...Object.fromEntries(
          stackKeys.map((k) => [k, hidden.has(k) ? 0 : (b.by_dimension[k] ?? 0) / 100]),
        ),
      })),
    [data.time_series, stackKeys, hidden],
  );

  // Hide the chart if there's literally no spend in the window.
  if (data.total_cents === 0) {
    return null;
  }

  const stackLabel = STACK_OPTIONS.find((o) => o.value === stack)?.label ?? "None";

  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">
          Spend by day
          {stack !== "none" && (
            <span className="text-muted-foreground"> (stacked by {stackLabel.toLowerCase()})</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Stack by</span>
          <Select value={stack} onValueChange={(v) => setStack(v as StackDim)}>
            <SelectTrigger className="h-7 w-[140px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STACK_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            dataKey="date"
            tickFormatter={(d) =>
              new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })
            }
            className="text-xs"
            tick={{ fill: "currentColor" }}
            // Auto-skip labels so the axis doesn't crush itself on
            // 30d+ windows (30 daily buckets → ~30 labels by default).
            // preserveStartEnd keeps the boundary dates visible so the
            // axis stays interpretable; minTickGap lets Recharts pick
            // how many in between fit at this width.
            interval="preserveStartEnd"
            minTickGap={40}
          />
          <YAxis
            tickFormatter={(v) => `$${v}`}
            className="text-xs"
            tick={{ fill: "currentColor" }}
            width={50}
          />
          <Tooltip
            formatter={(v: number) => `$${v.toFixed(2)}`}
            labelFormatter={(d) => new Date(d).toLocaleDateString()}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          {stackKeys.map((k, idx) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="cost"
              fill={STACK_PALETTE[idx % STACK_PALETTE.length]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {/* Custom legend: rendered below the chart so toggling a series
          doesn't shift the chart canvas. Clicking a swatch toggles
          visibility. Only render when there are actual stack segments
          (skip when stack=none — only one "all" series, no point). */}
      {stackKeys.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          {stackKeys.map((k, idx) => {
            const isHidden = hidden.has(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 transition-opacity hover:bg-accent/40",
                  isHidden && "opacity-40",
                )}
                aria-pressed={!isHidden}
              >
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: STACK_PALETTE[idx % STACK_PALETTE.length] }}
                />
                <span className={cn(isHidden && "line-through")}>{k}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STACK_PALETTE = ["#4E79A7", "#F28E2B", "#59A14F", "#E15759", "#B07AA1", "#76B7B2"];

// --- Group-by breakdown table ----------------------------------------------

function CostBreakdown({
  data,
  groupBy,
  setGroupBy,
}: {
  data: CostResponse;
  groupBy: CostGroupByDimension;
  setGroupBy: (v: CostGroupByDimension) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <span className="text-sm font-medium">Group by</span>
        <Select
          value={groupBy}
          onValueChange={(v) => setGroupBy(v as CostGroupByDimension)}
        >
          <SelectTrigger className="h-8 w-[160px] text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUP_BY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-4 py-2 text-left font-medium">
              {GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label.toUpperCase()}
            </th>
            <th className="px-4 py-2 text-right font-medium">SUBMITS</th>
            <th className="px-4 py-2 text-right font-medium">HOURS</th>
            <th className="px-4 py-2 text-right font-medium">COST</th>
            <th className="px-4 py-2 text-right font-medium">% OF TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {data.breakdown.rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground text-sm">
                No spend in window.
              </td>
            </tr>
          )}
          {data.breakdown.rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2 font-medium">{row.key}</td>
              <td className="px-4 py-2 text-right tabular-nums">{row.submits}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatHours(row.hours)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">
                {formatCents(row.cents)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                {row.pct.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Experiments table (multilevel: rowspan-style) -------------------------

function CostExperiments({
  data,
  filterSubmitters,
  filterRepos,
  filterGpus,
  filterOutcomes,
  setFilter,
}: {
  data: CostResponse;
  filterSubmitters: string[];
  filterRepos: string[];
  filterGpus: string[];
  filterOutcomes: string[];
  setFilter: (
    key: "f_submitter" | "f_repo" | "f_gpu" | "f_outcome",
    xs: string[],
  ) => void;
}) {
  // Filter option lists are computed from the unfiltered window so the
  // dropdowns always show every value that COULD be filtered to, not just
  // the ones surviving the current filter set. Counts reflect how many
  // experiments (not versions) match in the unfiltered view.
  const filterOptions = useMemo(() => {
    const submitterCounts = new Map<string, number>();
    const repoCounts = new Map<string, number>();
    const gpuCounts = new Map<string, number>();
    const outcomeCounts = new Map<string, number>();
    for (const e of data.experiments) {
      // Per-experiment submitter / repo aren't on the type yet (will arrive
      // when the Go API populates them); seed funnels everything under
      // a single bucket for now. We pull from the first version's gpu and
      // a normalized outcome.
      const v0 = e.versions[0];
      const submitter = data.breakdown.dimension === "submitter" ? "nathan" : "nathan"; // placeholder; backend will return real
      const repo = "naston/ProjectOrion"; // placeholder; real backend will pass through
      submitterCounts.set(submitter, (submitterCounts.get(submitter) ?? 0) + 1);
      repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
      gpuCounts.set(v0.gpu_type, (gpuCounts.get(v0.gpu_type) ?? 0) + 1);
      // Outcome bucket uses the normalized {success, failed, in_flight}
      // axis — same vocabulary the breakdown dropdown shows, so a user
      // who filtered "failed" here gets the same set that contributed to
      // the "of which X on failed runs" header line.
      const o = normalizeOutcomeForFilter(v0);
      outcomeCounts.set(o, (outcomeCounts.get(o) ?? 0) + 1);
    }
    const opts = (m: Map<string, number>) =>
      Array.from(m.entries()).map(([value, count]) => ({ value, label: value, count }));
    return {
      submitters: opts(submitterCounts),
      repos: opts(repoCounts),
      gpus: opts(gpuCounts),
      outcomes: opts(outcomeCounts),
    };
  }, [data.experiments, data.breakdown.dimension]);

  // Apply filters. The chart + breakdown table are intentionally NOT
  // filtered (they always represent the unfiltered window — that's the
  // "where did the money go" frame). Filtering only narrows this table.
  const filteredExperiments = useMemo(() => {
    return data.experiments.filter((e) => {
      const v0 = e.versions[0];
      // Submitter / repo are not on the version shape today; treat all
      // experiments as matching when no filter is applied. Once the real
      // backend ships per-experiment submitter/repo on the cost type,
      // wire those checks here.
      if (filterGpus.length > 0 && !filterGpus.includes(v0.gpu_type)) return false;
      if (filterOutcomes.length > 0) {
        const bucket = normalizeOutcomeForFilter(v0);
        if (!filterOutcomes.includes(bucket)) return false;
      }
      // Submitter / repo filters: until per-experiment fields land,
      // accept everything (no narrowing). The dropdowns still render so
      // the affordance is visible.
      if (filterSubmitters.length > 0) return true;
      if (filterRepos.length > 0) return true;
      return true;
    });
  }, [data.experiments, filterSubmitters, filterRepos, filterGpus, filterOutcomes]);

  const sorted = useMemo(() => {
    const exps = [...filteredExperiments].sort((a, b) => b.total_cents - a.total_cents);
    return exps.map((e) => ({
      ...e,
      versions: [...e.versions].sort((a, b) => versionRank(b.version) - versionRank(a.version)),
    }));
  }, [filteredExperiments]);

  const anyFilter =
    filterSubmitters.length +
      filterRepos.length +
      filterGpus.length +
      filterOutcomes.length >
    0;

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-medium">Experiments in window</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <FilterDropdown
            label="Submitter"
            options={filterOptions.submitters}
            selected={filterSubmitters}
            onChange={(xs) => setFilter("f_submitter", xs)}
          />
          <FilterDropdown
            label="Repo"
            options={filterOptions.repos}
            selected={filterRepos}
            onChange={(xs) => setFilter("f_repo", xs)}
          />
          <FilterDropdown
            label="GPU"
            options={filterOptions.gpus}
            selected={filterGpus}
            onChange={(xs) => setFilter("f_gpu", xs)}
          />
          <FilterDropdown
            label="Outcome"
            options={filterOptions.outcomes}
            selected={filterOutcomes}
            onChange={(xs) => setFilter("f_outcome", xs)}
          />
          {anyFilter && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setFilter("f_submitter", []);
                setFilter("f_repo", []);
                setFilter("f_gpu", []);
                setFilter("f_outcome", []);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {sorted.length} of {data.experiments.length}
        </span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {data.experiments.length === 0
            ? "No experiments in window."
            : "No experiments match the current filters."}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left font-medium">EXPERIMENT</th>
              <th className="px-4 py-2 text-left font-medium">VERSION</th>
              <th className="px-4 py-2 text-left font-medium">GPU</th>
              <th className="px-4 py-2 text-right font-medium">HOURS</th>
              <th className="px-4 py-2 text-right font-medium">COST</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, eIdx) => (
              <ExperimentRows key={e.name} experiment={e} isLast={eIdx === sorted.length - 1} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ExperimentRows({
  experiment,
  isLast,
}: {
  experiment: CostExperimentEntry;
  isLast: boolean;
}) {
  return (
    <>
      {experiment.versions.map((v, vIdx) => {
        const isFirstVersion = vIdx === 0;
        const isLastVersion = vIdx === experiment.versions.length - 1;
        // rowspan: experiment cell rendered ONCE on the first version row
        // and spans all version rows. Only put a bottom border on the LAST
        // version row, so a clean horizontal rule separates one experiment
        // from the next without slicing through versions of the same one.
        return (
          <tr
            key={v.version}
            className={cn(
              "border-border",
              isLastVersion && !isLast && "border-b",
            )}
          >
            {isFirstVersion && (
              <td
                rowSpan={experiment.versions.length}
                className={cn(
                  "px-4 py-2 align-top font-medium",
                  // Visual separation between experiments — light right
                  // border that runs the full height of the multi-row group.
                  "border-r border-border/60",
                )}
              >
                <Link
                  to="/experiment"
                  search={{ name: experiment.name, version: "latest" }}
                  className="hover:text-primary transition-colors"
                >
                  {experiment.name}
                </Link>
              </td>
            )}
            <VersionCells version={v} />
          </tr>
        );
      })}
    </>
  );
}

function VersionCells({ version }: { version: CostVersionEntry }) {
  const inFlight = version.cents === null;
  const isFail =
    version.outcome !== null && TERMINAL_FAIL_OUTCOMES.has(version.outcome);
  return (
    <>
      <td className="px-4 py-2 tabular-nums text-muted-foreground">{version.version}</td>
      <td className="px-4 py-2 text-muted-foreground">{version.gpu_type}</td>
      <td className="px-4 py-2 text-right tabular-nums">
        {version.hours === null ? "—" : formatHours(version.hours)}
      </td>
      <td
        className={cn(
          "px-4 py-2 text-right tabular-nums",
          isFail && "text-destructive",
          inFlight && "text-muted-foreground italic",
        )}
      >
        {inFlight ? (
          <span className="inline-flex items-center gap-2">
            <span>~{formatCents(version.estimated_cents)}</span>
            <span className="rounded-sm border border-info/30 bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info uppercase tracking-wide not-italic">
              Running
            </span>
          </span>
        ) : (
          formatCents(version.cents!)
        )}
      </td>
    </>
  );
}

function versionRank(v: string): number {
  // "v3" → 3, "v10" → 10, anything weird → 0 (sorts last).
  const m = /^v(\d+)$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}
