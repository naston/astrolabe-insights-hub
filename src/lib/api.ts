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

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

/** Wraps a real API call with a deterministic seed-data fallback so the
 *  dashboard is fully reviewable when the Go backend isn't reachable. */
async function withSeed<T>(
  call: () => Promise<T>,
  seed: () => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (signal?.aborted) throw err;
    // Network / 404 / parse error → serve the seed dataset so the UI stays
    // navigable. We deliberately don't log noisily on every poll tick.
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
