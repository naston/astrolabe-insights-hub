import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "@/lib/api";
import type { MetricSeries } from "@/lib/types";
import { useChartZoom, type XAxisMode } from "@/hooks/use-chart-zoom";
import { cn } from "@/lib/utils";

const ACTIVE_POLL_MS = 2000;

export interface ChartRunSpec {
  hash: string;
  name: string;
  experiment: string;
  color: string;
  active: boolean;
  visible: boolean;
}

interface MetricChartProps {
  metricName: string;
  runs: ChartRunSpec[];
  xMode: XAxisMode;
  /** Hash-keyed start times so we can compute wall_time even when the API only provides steps. */
  runCreationMs: Record<string, number>;
}

interface SeriesPoint {
  x: number; // step or epoch ms
  // run-hash-keyed values
  [runHash: string]: number | undefined;
}

/**
 * One metric across many runs. Subscribes to `useChartZoom` so dragging on
 * any chart updates the shared X-domain across every other chart.
 *
 * Polls metrics for active runs only at `ACTIVE_POLL_MS`. Inactive runs are
 * fetched once and then cached for the lifetime of the component.
 */
export function MetricChart({
  metricName,
  runs,
  xMode,
  runCreationMs,
}: MetricChartProps) {
  const { domain, setDomain, reset } = useChartZoom();
  const [seriesByRun, setSeriesByRun] = useState<Record<string, MetricSeries>>({});
  const [errorByRun, setErrorByRun] = useState<Record<string, string>>({});

  // Stable list of run keys we need to fetch
  const runKey = runs.map((r) => `${r.hash}:${r.active ? 1 : 0}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    const fetchAll = async () => {
      await Promise.all(
        runs.map(async (run) => {
          try {
            const m = await api.metric(run.hash, metricName, ctrl.signal);
            if (cancelled) return;
            setSeriesByRun((prev) => ({ ...prev, [run.hash]: m }));
          } catch (err) {
            if (cancelled || ctrl.signal.aborted) return;
            setErrorByRun((prev) => ({
              ...prev,
              [run.hash]: err instanceof Error ? err.message : String(err),
            }));
          }
        }),
      );
    };

    void fetchAll();

    // Only poll if at least one run is active
    const anyActive = runs.some((r) => r.active);
    let id: number | undefined;
    if (anyActive) {
      id = window.setInterval(() => {
        // Only re-fetch active runs on interval ticks
        Promise.all(
          runs
            .filter((r) => r.active)
            .map(async (run) => {
              try {
                const m = await api.metric(run.hash, metricName, ctrl.signal);
                if (cancelled) return;
                setSeriesByRun((prev) => ({ ...prev, [run.hash]: m }));
              } catch {
                /* swallow polling errors */
              }
            }),
        );
      }, ACTIVE_POLL_MS);
    }

    return () => {
      cancelled = true;
      ctrl.abort();
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, metricName]);

  // Merge series into a single dataset keyed by x.
  const data = useMemo<SeriesPoint[]>(() => {
    const map = new Map<number, SeriesPoint>();
    for (const run of runs) {
      const series = seriesByRun[run.hash];
      if (!series) continue;
      const start = runCreationMs[run.hash] ?? 0;
      for (let i = 0; i < series.steps.length; i++) {
        const step = series.steps[i];
        const value = series.values[i];
        if (value == null || !isFinite(value)) continue;
        const wall =
          series.wall_times?.[i] != null
            ? series.wall_times[i] * 1000
            : start + step * 1000;
        const x = xMode === "step" ? step : wall;
        const existing = map.get(x) ?? { x };
        existing[run.hash] = value;
        map.set(x, existing);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.x - b.x);
  }, [seriesByRun, runs, xMode, runCreationMs]);

  // Drag-to-zoom state — we track refAreaLeft / refAreaRight on the X axis.
  const [refLeft, setRefLeft] = useState<number | null>(null);
  const [refRight, setRefRight] = useState<number | null>(null);
  const dragging = useRef(false);

  const xDomain: [number | string, number | string] = domain
    ? [domain.min, domain.max]
    : ["dataMin", "dataMax"];

  const visibleRuns = runs.filter((r) => r.visible);
  const totalPoints = data.length;
  const hasData = visibleRuns.length > 0 && totalPoints > 0;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">{metricName}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {visibleRuns.length} run{visibleRuns.length === 1 ? "" : "s"} ·{" "}
            {totalPoints} pts
          </span>
        </div>
        {domain && (
          <button
            onClick={reset}
            className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            reset zoom
          </button>
        )}
      </div>
      <div
        className={cn(
          "h-[260px] w-full",
          !hasData && "flex items-center justify-center text-xs text-muted-foreground",
        )}
        onDoubleClick={reset}
      >
        {!hasData ? (
          <span>No data yet…</span>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 12, right: 16, left: 8, bottom: 8 }}
              onMouseDown={(e) => {
                if (e?.activeLabel != null) {
                  dragging.current = true;
                  setRefLeft(Number(e.activeLabel));
                  setRefRight(Number(e.activeLabel));
                }
              }}
              onMouseMove={(e) => {
                if (dragging.current && e?.activeLabel != null) {
                  setRefRight(Number(e.activeLabel));
                }
              }}
              onMouseUp={() => {
                if (
                  dragging.current &&
                  refLeft != null &&
                  refRight != null &&
                  refLeft !== refRight
                ) {
                  const min = Math.min(refLeft, refRight);
                  const max = Math.max(refLeft, refRight);
                  setDomain({ min, max });
                }
                dragging.current = false;
                setRefLeft(null);
                setRefRight(null);
              }}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="x"
                type="number"
                domain={xDomain}
                allowDataOverflow
                stroke="var(--muted-foreground)"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(v: number) =>
                  xMode === "step"
                    ? formatStep(v)
                    : new Date(v).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                }
              />
              <YAxis
                stroke="var(--muted-foreground)"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                width={48}
                tickFormatter={(v: number) => formatY(v)}
              />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
                content={(props: unknown) => (
                  <ChartTooltip
                    {...(props as TooltipProps)}
                    runs={visibleRuns}
                    xMode={xMode}
                  />
                )}
              />
              {visibleRuns.map((run) => (
                <Line
                  key={run.hash}
                  type="monotone"
                  dataKey={run.hash}
                  stroke={run.color}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {refLeft != null && refRight != null && (
                <ReferenceArea
                  x1={refLeft}
                  x2={refRight}
                  fill="var(--primary)"
                  fillOpacity={0.12}
                  stroke="var(--primary)"
                  strokeOpacity={0.3}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function formatStep(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatY(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000 || abs < 0.01) return v.toExponential(1);
  if (abs >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: number;
  runs: ChartRunSpec[];
  xMode: XAxisMode;
}

function ChartTooltip({ active, payload, label, runs, xMode }: TooltipProps) {
  if (!active || !payload || payload.length === 0 || label == null) return null;
  const runByHash = new Map(runs.map((r) => [r.hash, r]));
  return (
    <div className="rounded-md border border-border bg-popover/95 backdrop-blur px-2 py-1.5 shadow-lg text-xs font-mono">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {xMode === "step"
          ? `step ${formatStep(label)}`
          : new Date(label).toLocaleTimeString()}
      </div>
      <ul className="space-y-0.5">
        {payload
          .slice()
          .sort((a, b) => b.value - a.value)
          .map((p) => {
            const run = runByHash.get(p.dataKey);
            return (
              <li
                key={p.dataKey}
                className="flex items-center gap-2 text-foreground"
              >
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: p.color }}
                />
                <span className="truncate max-w-[180px]">{run?.name ?? p.dataKey}</span>
                <span className="ml-auto text-tabular">{formatY(p.value)}</span>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
