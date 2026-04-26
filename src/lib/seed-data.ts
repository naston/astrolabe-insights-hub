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
  /** Number of versions of this experiment (each = a re-submit with tweaks). */
  versions: number;
  /**
   * Run names per version — e.g. an "architecture-comparison" experiment
   * declares ["BERT", "LatentBERT"], producing 2 runs per version. The
   * SAME run names appear across versions; that's how the user pivots from
   * "v1.BERT vs v1.LatentBERT" to "v2.BERT vs v2.LatentBERT" by switching
   * versions.
   */
  runNames: string[];
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
    name: "thesis-vit/arch-comparison",
    state: "RUNNING",
    outcome: null,
    gpu: "8× H100",
    versions: 3,
    runNames: ["BERT", "LatentBERT"],
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
    versions: 2,
    runNames: ["small", "medium", "large"],
    latestAgeSec: 8 * HOUR,
    duration: 4 * HOUR + 12 * 60,
    history: ["PENDING", "ACQUIRING", "SETUP", "RUNNING", "SUMMARIZING", "COMPLETED"],
  },
  {
    name: "rlhf/preference-mix",
    state: "HEALING",
    outcome: null,
    gpu: "8× H100",
    versions: 2,
    runNames: ["dpo", "ipo", "ppo"],
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
    runNames: ["llama-7b", "llama-13b"],
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
    runNames: ["fp16", "bf16", "fp8"],
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
    // Stable Linear-doc URL slug derived from the experiment name. Real
    // backend will populate this from each experiment's recorded
    // linear_doc_url; the seed mirrors the shape so the link wires through.
    const slug = s.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
    return {
      name: s.name,
      state: s.state,
      gpu_type: s.gpu,
      started_at: startedAt,
      duration: s.duration,
      outcome: s.outcome,
      // Total run count across every version. The latest version's run
      // count is what the home page expansion shows by default; this
      // top-line number reflects how many training executions have run
      // under this experiment in total (versions × runs-per-version).
      run_count: s.versions * s.runNames.length,
      version_count: s.versions,
      repo: s.name.split("/")[0],
      state_history: buildHistory(s.history, t - s.latestAgeSec * 1000, s.duration),
      linear_doc_url: `https://linear.app/astrolabe-demo/document/exp-${slug}`,
    };
  });
}

/** Deterministic hash so the same (experiment, version, run-name) gets the same id. */
function hashFor(experiment: string, version: number, runName: string): string {
  let h = 0x811c9dc5;
  const seed = `${experiment}#v${version}#${runName}`;
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
  // Cardinality: each experiment has spec.versions versions, and each version
  // contains spec.runNames.length runs (one per declared training job — e.g.
  // "BERT" + "LatentBERT" for an arch-comparison experiment). Older versions
  // are spaced back in time; the latest version uses the spec's latestAgeSec
  // / duration / active flag.
  const out: Run[] = [];
  for (let v = 1; v <= spec.versions; v++) {
    const isLatestVersion = v === spec.versions;
    // Older versions sit ~1-3 days behind the next version's creation time.
    const ageDays = (spec.versions - v) * (1.5 + (v % 2));
    const versionAgeSec = isLatestVersion
      ? spec.latestAgeSec
      : spec.latestAgeSec + ageDays * DAY;
    const versionDuration = isLatestVersion
      ? spec.duration
      : Math.round(spec.duration * (0.6 + ((v * 37) % 80) / 100));
    const versionActive = isLatestVersion && !!spec.active;
    // All runs in one version start at the same wall-clock time (same submit).
    const versionStartMs = t - versionAgeSec * 1000;
    for (let r = 0; r < spec.runNames.length; r++) {
      const runName = spec.runNames[r];
      const hash = hashFor(experiment, v, runName);
      // Per-run jitter so the runs in a version don't have identical durations.
      const runDuration = Math.max(
        30,
        Math.round(versionDuration * (0.85 + ((r * 23) % 30) / 100)),
      );
      const endMs = versionActive ? null : versionStartMs + runDuration * 1000;
      out.push({
        hash,
        name: runName,
        experiment,
        version: `v${v}`,
        creation_time: new Date(versionStartMs).toISOString(),
        end_time: endMs ? new Date(endMs).toISOString() : null,
        active: versionActive,
        duration: runDuration,
        metrics: [
          { name: "train/loss", context: null },
          { name: "eval/loss", context: null },
          { name: "eval/accuracy", context: null },
          { name: "lr", context: null },
          { name: "grad_norm", context: null },
        ],
        // Different runs in the same version land at slightly different final
        // losses — that's the point of comparing them.
        final_loss: versionActive
          ? null
          : 0.4 + ((v * 13 + r * 29) % 100) / 250,
      });
    }
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
