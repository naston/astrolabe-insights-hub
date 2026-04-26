// Deterministic seed dataset used when the Go API isn't reachable.
// Designed to exercise every UI affordance: multiple repos, multiple versions
// per experiment, mix of states/outcomes, realistic loss curves, one live run.

import type {
  ColorsResponse,
  Experiment,
  ExperimentState,
  IncludesResponse,
  MetricSeries,
  Run,
} from "./types";

const HOUR = 3600;
const DAY = 24 * HOUR;

// Stable epoch — "now" for the seed clock. Frozen so we don't churn on every
// request, but `started_at` / `creation_time` are computed against real Date.now()
// so "5m ago" stays accurate as the user watches.
function now() {
  return Date.now();
}

interface SeedSpec {
  name: string;
  state: ExperimentState;
  outcome: Experiment["outcome"];
  gpu: string;
  versions: number;
  /** Seconds ago for the LATEST version's creation_time. */
  latestAgeSec: number;
  /** Latest version's duration in seconds. */
  duration: number;
  /** Whether the latest version is still running. */
  active?: boolean;
  /** History of FSM transitions for the latest version (oldest first). */
  history: ExperimentState[];
}

const SPECS: SeedSpec[] = [
  {
    name: "thesis-vit/scale-laws-256",
    state: "RUNNING",
    outcome: null,
    gpu: "8× H100",
    versions: 5,
    latestAgeSec: 42 * 60,
    duration: 42 * 60,
    active: true,
    history: ["PENDING", "ACQUIRING", "SETUP", "RUNNING"],
  },
  {
    name: "thesis-vit/baseline-128",
    state: "COMPLETED",
    outcome: "success",
    gpu: "4× A100",
    versions: 3,
    latestAgeSec: 8 * HOUR,
    duration: 4 * HOUR + 12 * 60,
    history: ["PENDING", "ACQUIRING", "SETUP", "RUNNING", "SUMMARIZING", "COMPLETED"],
  },
  {
    name: "rlhf/preference-mix-v4",
    state: "HEALING",
    outcome: null,
    gpu: "8× H100",
    versions: 2,
    latestAgeSec: 11 * 60,
    duration: 11 * 60,
    active: true,
    history: ["PENDING", "ACQUIRING", "SETUP", "RUNNING", "HEALING"],
  },
  {
    name: "rlhf/dpo-warmstart",
    state: "FAILED",
    outcome: "failure",
    gpu: "2× A100",
    versions: 4,
    latestAgeSec: 2 * DAY + 3 * HOUR,
    duration: 38 * 60,
    history: ["PENDING", "ACQUIRING", "SETUP", "RUNNING", "FAILED"],
  },
  {
    name: "infra/throughput-bench",
    state: "COMPLETED",
    outcome: "success",
    gpu: "1× H100",
    versions: 2,
    latestAgeSec: 6 * DAY,
    duration: 22 * 60,
    history: ["PENDING", "ACQUIRING", "RUNNING", "SUMMARIZING", "COMPLETED"],
  },
];

function buildHistory(states: ExperimentState[], latestStartMs: number, durationSec: number) {
  const slice = durationSec / Math.max(1, states.length);
  return states.map((s, i) => ({
    state: s,
    at: new Date(latestStartMs + i * slice * 1000).toISOString(),
  }));
}

export function seedExperiments(): Experiment[] {
  const t = now();
  return SPECS.map((s) => {
    const startedAt = new Date(t - s.latestAgeSec * 1000).toISOString();
    return {
      name: s.name,
      state: s.state,
      gpu_type: s.gpu,
      started_at: startedAt,
      duration: s.duration,
      outcome: s.outcome,
      run_count: s.versions,
      repo: s.name.split("/")[0],
      state_history: buildHistory(s.history, t - s.latestAgeSec * 1000, s.duration),
    };
  });
}

/** Deterministic hash so the same (experiment, version) gets the same id. */
function hashFor(name: string, version: number): string {
  let h = 0x811c9dc5;
  const seed = `${name}#v${version}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + "abcd1234";
}

export function seedRuns(experiment: string): Run[] {
  const spec = SPECS.find((s) => s.name === experiment);
  if (!spec) return [];
  const t = now();
  // Versions are spaced at increasing intervals (oldest first). The latest one
  // matches the experiment's started_at / duration / active flag.
  const out: Run[] = [];
  for (let i = 1; i <= spec.versions; i++) {
    const isLatest = i === spec.versions;
    // Older versions: spaced ~1-3 days back from latest
    const ageDays = (spec.versions - i) * (1.5 + (i % 2));
    const ageSec = isLatest
      ? spec.latestAgeSec
      : spec.latestAgeSec + ageDays * DAY;
    const duration = isLatest
      ? spec.duration
      : Math.round(spec.duration * (0.6 + ((i * 37) % 80) / 100));
    const active = isLatest && !!spec.active;
    const creationMs = t - ageSec * 1000;
    const endMs = active ? null : creationMs + duration * 1000;
    out.push({
      hash: hashFor(experiment, i),
      name: `v${i}`,
      experiment,
      creation_time: new Date(creationMs).toISOString(),
      end_time: endMs ? new Date(endMs).toISOString() : null,
      active,
      duration,
      metrics: [
        { name: "train/loss", context: null },
        { name: "eval/loss", context: null },
        { name: "eval/accuracy", context: null },
        { name: "lr", context: null },
        { name: "grad_norm", context: null },
      ],
      final_loss: active ? null : 0.4 + ((i * 17) % 100) / 250,
    });
  }
  return out;
}

export function seedIncludes(_experiment: string): IncludesResponse {
  return { includes: [] };
}

/** Synthesize a plausible curve for a given (run, metric) pair. */
export function seedMetric(hash: string, name: string): MetricSeries {
  // Derive a stable RNG-ish offset from the hash so each run looks distinct.
  let seed = 0;
  for (let i = 0; i < hash.length; i++) seed = (seed * 31 + hash.charCodeAt(i)) >>> 0;
  const offset = (seed % 100) / 100;

  const N = 200;
  const steps: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < N; i++) {
    steps.push(i * 50);
    let v: number;
    if (name.startsWith("train/loss") || name === "train/loss") {
      // Exponential decay from ~3.5 to ~0.4 with a little noise
      v = 0.35 + 3.0 * Math.exp(-i / (40 + offset * 30)) + (Math.sin(i / 7 + offset * 6) * 0.04);
    } else if (name === "eval/loss") {
      v = 0.55 + 2.5 * Math.exp(-i / (35 + offset * 25)) + (Math.sin(i / 9) * 0.05);
    } else if (name === "eval/accuracy") {
      v = 1 - Math.exp(-i / (30 + offset * 25)) * (0.85 - offset * 0.1);
    } else if (name === "lr") {
      // Cosine decay
      v = 1e-3 * 0.5 * (1 + Math.cos((Math.PI * i) / N));
    } else if (name === "grad_norm") {
      v = 1.5 + Math.exp(-i / 60) * 4 + Math.sin(i / 5) * 0.3;
    } else {
      v = Math.exp(-i / 50) + offset;
    }
    values.push(Number(v.toFixed(5)));
  }
  return { name, steps, values };
}

export function seedColors(): ColorsResponse {
  return {
    palette: [
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
    ],
  };
}
