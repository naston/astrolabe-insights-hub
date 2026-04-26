import type {
  ColorsResponse,
  Experiment,
  HealthResponse,
  IncludesResponse,
  MetricSeries,
  Run,
} from "./types";

const BASE = "/api";

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

export const api = {
  experiments: (signal?: AbortSignal) =>
    getJSON<Experiment[]>("/experiments", signal),
  runs: (experiment: string, signal?: AbortSignal) =>
    getJSON<Run[]>(`/experiments/${encodeURIComponent(experiment)}/runs`, signal),
  includes: (experiment: string, signal?: AbortSignal) =>
    getJSON<IncludesResponse>(
      `/experiments/${encodeURIComponent(experiment)}/includes`,
      signal,
    ),
  metric: (hash: string, name: string, signal?: AbortSignal) =>
    getJSON<MetricSeries>(
      `/runs/${encodeURIComponent(hash)}/metrics/${encodeURIComponent(name)}`,
      signal,
    ),
  colors: (signal?: AbortSignal) => getJSON<ColorsResponse>("/config/colors", signal),
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
