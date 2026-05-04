import type {
  ColorsResponse,
  Experiment,
  HealthResponse,
  IncludesResponse,
  MetricSeries,
  Run,
} from "./types";
import { seedColors, seedExperiments, seedIncludes, seedMetric, seedRuns } from "./seed-data";

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
  colors: (signal?: AbortSignal) =>
    withSeed(() => getJSON<ColorsResponse>("/config/colors", signal), seedColors, signal),
  health: (signal?: AbortSignal) => getJSON<HealthResponse>("/health", signal),
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
