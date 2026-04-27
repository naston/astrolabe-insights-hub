import type {
  ColorsResponse,
  Experiment,
  HealthResponse,
  IncludesResponse,
  MetricSeries,
  Run,
} from "./types";
import {
  seedColors,
  seedExperiments,
  seedIncludes,
  seedMetric,
  seedRuns,
} from "./seed-data";

const BASE = "/api";

/**
 * The seed-data fallback exists so the dashboard is fully reviewable
 * during design iteration without a live backend. It is NOT something a
 * production deployment should be silently serving — researchers seeing
 * fake experiments instead of "the API is down" would be a real footgun.
 *
 * Gate it behind a `?demo=1` query string so the design preview is
 * opt-in. Production astrolabe NUCs don't append `?demo=1`, so any API
 * failure surfaces as an empty / errored state via the polling hook.
 */
function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

const DEMO_MODE = isDemoMode();

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

/** Wraps a real API call with a seed-data fallback that fires only in
 *  demo mode (`?demo=1`). In production the fallback is a no-op
 *  pass-through; errors propagate to the caller's polling hook so the
 *  dashboard surfaces them honestly instead of papering over with fake
 *  experiments. */
async function withSeed<T>(
  call: () => Promise<T>,
  seed: () => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!DEMO_MODE) throw err;
    // Demo mode: serve the seed dataset so the UI stays navigable for
    // design previews. We deliberately don't log noisily on every tick.
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
