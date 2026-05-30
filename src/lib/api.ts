import type {
  ColorsResponse,
  CostResponse,
  EvalManifestEntry,
  Experiment,
  HealthResponse,
  IncludesResponse,
  MetricSeries,
  Run,
  RunInfo,
} from "./types";
import { seedColors, seedCost, seedExperiments, seedIncludes, seedMetric, seedRuns } from "./seed-data";

const BASE = "/api";

/** Thrown when the backend is reachable but returned an HTTP error (4xx/5xx).
 *  Distinguished from network errors so withSeed can decide whether to
 *  serve the deterministic seed dataset (only on actual unreachability,
 *  never on backend errors — those should propagate so the UI shows real
 *  state instead of papering over with synthetic data). */
class HTTPError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly path: string,
  ) {
    super(`${status} ${statusText} — ${path}`);
    this.name = "HTTPError";
  }
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new HTTPError(res.status, res.statusText, path);
  return (await res.json()) as T;
}

/** Wraps a real API call with a deterministic seed-data fallback so the
 *  dashboard is fully reviewable when the Go backend isn't reachable.
 *
 *  Seed activation is deliberately narrow: only true fetch failures
 *  (network down, no server at /api, CORS) trigger the fallback. HTTP
 *  errors from a reachable backend (4xx/5xx) propagate to the caller
 *  so the UI shows the real state — empty data, missing run, server
 *  error — instead of fabricating a 200-point exponential decay curve
 *  for runs that simply haven't logged anything yet. */
async function withSeed<T>(
  call: () => Promise<T>,
  seed: () => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (signal?.aborted) throw err;
    // Backend reachable but returned a non-2xx — propagate.
    if (err instanceof HTTPError) throw err;
    // Network / fetch / parse error → serve seed so the UI stays
    // navigable in offline-preview mode. We deliberately don't log
    // noisily on every poll tick.
    return seed();
  }
}

export const api = {
  experiments: (signal?: AbortSignal) =>
    withSeed(() => getJSON<Experiment[]>("/experiments", signal), seedExperiments, signal),
  runs: (experiment: string, signal?: AbortSignal) =>
    withSeed(
      () => getJSON<Run[]>(`/experiments/${encodeURIComponent(experiment)}/runs`, signal),
      () => seedRuns(experiment),
      signal,
    ),
  includes: (experiment: string, signal?: AbortSignal) =>
    withSeed(
      () =>
        getJSON<IncludesResponse>(
          `/experiments/${encodeURIComponent(experiment)}/includes`,
          signal,
        ),
      () => seedIncludes(experiment),
      signal,
    ),
  metric: (hash: string, name: string, signal?: AbortSignal) =>
    withSeed(
      () =>
        getJSON<MetricSeries>(
          `/runs/${encodeURIComponent(hash)}/metrics/${encodeURIComponent(name)}`,
          signal,
        ),
      () => seedMetric(hash, name),
      signal,
    ),
  /** Eval-discovery manifest — returns the eval Aim runs that score a
   *  given training run, deduped by task_set keeping newest. Empty
   *  array when no evals exist, which the dashboard renders as
   *  "no eval data yet" empty state. */
  evals: (modelRunHash: string, signal?: AbortSignal) =>
    withSeed(
      () =>
        getJSON<EvalManifestEntry[]>(
          `/runs/${encodeURIComponent(modelRunHash)}/evals`,
          signal,
        ),
      () => [],
      signal,
    ),
  /** Run info — props + metric names. Used by the Eval tab to enumerate
   *  ``eval/<task>/<metric>`` metric names on an eval run before
   *  fetching each series. Seed returns an empty traces list. */
  runInfo: (hash: string, signal?: AbortSignal) =>
    withSeed(
      () =>
        getJSON<RunInfo>(
          `/runs/${encodeURIComponent(hash)}/info`,
          signal,
        ),
      () => ({ params: {}, traces: { metric: [] } }),
      signal,
    ),
  colors: (signal?: AbortSignal) =>
    withSeed(() => getJSON<ColorsResponse>("/config/colors", signal), seedColors, signal),
  health: (signal?: AbortSignal) => getJSON<HealthResponse>("/health", signal),
  /**
   * Cost page payload. Query params drive every panel: ``window``
   * (7d|30d|90d|all|custom), ``group_by`` (submitter|repo|gpu_type|outcome),
   * and ``stack`` (the time-series stacking dimension; defaults to gpu_type
   * on the backend).
   *
   * Seed fallback returns a deterministic 30d/submitter snapshot anchored
   * to 2026-05-28 so layout work doesn't depend on a reachable Go API.
   */
  cost: (
    params: { window?: string; group_by?: string; stack?: string },
    signal?: AbortSignal,
  ) =>
    withSeed(
      () => {
        const qs = new URLSearchParams();
        if (params.window) qs.set("window", params.window);
        if (params.group_by) qs.set("group_by", params.group_by);
        if (params.stack) qs.set("stack", params.stack);
        const q = qs.toString();
        return getJSON<CostResponse>(`/cost${q ? `?${q}` : ""}`, signal);
      },
      () =>
        seedCost({
          window: params.window,
          group_by: params.group_by as
            | "submitter"
            | "repo"
            | "gpu_type"
            | "outcome"
            | undefined,
          stack: params.stack as
            | "submitter"
            | "repo"
            | "gpu_type"
            | "outcome"
            | "none"
            | undefined,
        }),
      signal,
    ),
};

// Default Astrolabe palette — used when /api/config/colors is unavailable
// (also doubles as a deterministic local fallback for offline previews).
export const DEFAULT_PALETTE = [
  "#4E79A7",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#B07AA1",
  "#76B7B2",
  "#EDC948",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
  "#86BCB6",
  "#D37295",
  "#A0CBE8",
  "#FFBE7D",
  "#8CD17D",
];
