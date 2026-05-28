// Deterministic seed dataset used when the Go API isn't reachable.
// Designed to exercise every UI affordance: multiple repos, multiple versions
// per experiment, mix of states/outcomes, realistic loss curves, one live run.

import type {
  ColorsResponse,
  CostResponse,
  Experiment,
  ExperimentState,
  IncludesResponse,
  MetricSeries,
  Run,
} from "./types";

// Live Lambda rates pulled 2026-05-28 from /instance-types. Cents per hour.
// Update via the snippet in plans/cost-tracking.md when Lambda revises pricing.
const LAMBDA_RATES_CENTS_PER_HOUR: Record<string, number> = {
  cpu_4x_general: 20,
  cpu_4x_generalx: 20,
  gpu_1x_a10: 129,
  gpu_1x_a100: 199,
  gpu_1x_a100_sxm4: 199,
  gpu_1x_a6000: 109,
  gpu_1x_b200_sxm6: 699,
  gpu_1x_gh200: 229,
  gpu_1x_h100_pcie: 329,
  gpu_1x_h100_sxm5: 429,
  gpu_1x_rtx6000: 69,
  gpu_2x_a100: 398,
  gpu_2x_a6000: 218,
  gpu_2x_b200_sxm6: 1378,
  gpu_2x_h100_sxm5: 838,
  gpu_4x_a100: 796,
  gpu_4x_a6000: 436,
  gpu_4x_b200_sxm6: 2716,
  gpu_4x_h100_sxm5: 1636,
  gpu_8x_a100: 1592,
  gpu_8x_a100_80gb_sxm4: 2232,
  gpu_8x_b200_sxm6: 5352,
  gpu_8x_h100_sxm5: 3192,
  gpu_8x_v100: 632,
  gpu_8x_v100_n: 632,
};

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

/** Format an integer-seconds duration into the "5m 12s" / "2h 15m" shape
 *  the Go API emits. Used by seed-data so the demo runs match the live
 *  API's data shape. */
function formatRunDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

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
    const slug = s.name
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-|-$/g, "");
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
    const versionAgeSec = isLatestVersion ? spec.latestAgeSec : spec.latestAgeSec + ageDays * DAY;
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
        // Match the Aim REST API shape: creation_time / end_time are
        // Unix seconds (float), duration is a pre-formatted string.
        creation_time: versionStartMs / 1000,
        end_time: endMs ? endMs / 1000 : null,
        active: versionActive,
        duration: formatRunDuration(runDuration),
        metrics: [
          { name: "train/loss", context: null },
          { name: "eval/loss", context: null },
          { name: "eval/accuracy", context: null },
          { name: "lr", context: null },
          { name: "grad_norm", context: null },
        ],
        // Different runs in the same version land at slightly different final
        // losses — that's the point of comparing them.
        final_loss: versionActive ? null : 0.4 + ((v * 13 + r * 29) % 100) / 250,
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
      v = 0.35 + 3.0 * Math.exp(-i / (40 + offset * 30)) + Math.sin(i / 7 + offset * 6) * 0.04;
    } else if (name === "eval/loss") {
      v = 0.55 + 2.5 * Math.exp(-i / (35 + offset * 25)) + Math.sin(i / 9) * 0.05;
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

// --- Cost page seed ----------------------------------------------------------
//
// Real experiment timings pulled from lake1's state files on 2026-05-28 to keep
// the seed grounded — these are the actual durations + outcomes the cost page
// would render against a fresh NUC with this exact history. New experiments
// added to the spec list should follow the same pattern.

interface CostExperimentSpec {
  name: string;
  /** ISO date of the most recent submit, kept stable for layout work. */
  date: string;
  gpu: string;
  state: ExperimentState;
  outcome: Experiment["outcome"];
  /** Hours billed. Null for in-flight rows. */
  hours: number | null;
  /** Budget × rate, used for the in-flight estimate display. */
  estimatedHours: number;
  submitter: string;
  /** Comma-separated list of version labels in DESC order — newest first. */
  versions: string[];
}

const COST_SEED_SPECS: CostExperimentSpec[] = [
  {
    name: "02-muon-optimizer",
    date: "2026-05-06",
    gpu: "gpu_8x_a100",
    state: "COMPLETED",
    outcome: "success",
    hours: 1.34,
    estimatedHours: 8.0,
    submitter: "nathan",
    versions: ["v3", "v2", "v1"],
  },
  {
    name: "mla-arch-exploration",
    date: "2026-04-29",
    gpu: "gpu_8x_a100",
    state: "COMPLETED",
    outcome: "success",
    hours: 34.03,
    estimatedHours: 36.0,
    submitter: "nathan",
    versions: ["v1"],
  },
  {
    name: "05-mlm50",
    date: "2026-05-26",
    gpu: "gpu_8x_a100",
    state: "FAILED",
    outcome: "timeout",
    hours: 2.14,
    estimatedHours: 8.0,
    submitter: "nathan",
    versions: ["v1"],
  },
  {
    name: "04-handoff-diag",
    date: "2026-05-27",
    gpu: "gpu_8x_a100",
    state: "COMPLETED",
    outcome: "success",
    hours: 0.25,
    estimatedHours: 2.0,
    submitter: "nathan",
    versions: ["v2", "v1"],
  },
  {
    name: "04-muon-adamw-handoff",
    date: "2026-05-28",
    gpu: "gpu_8x_a100",
    state: "ACQUIRING",
    outcome: null,
    hours: null, // in-flight
    estimatedHours: 8.0,
    submitter: "nathan",
    versions: ["v1"],
  },
  {
    name: "astrolabe-include-test",
    date: "2026-04-27",
    gpu: "gpu_1x_a10",
    state: "COMPLETED",
    outcome: "success",
    hours: 0.10,
    estimatedHours: 0.5,
    submitter: "nathan",
    versions: ["v1"],
  },
  {
    name: "astrolabe-infra-test",
    date: "2026-04-27",
    gpu: "gpu_1x_a10",
    state: "COMPLETED",
    outcome: "success",
    hours: 0.12,
    estimatedHours: 0.5,
    submitter: "nathan",
    versions: ["v1"],
  },
];

function centsForHours(gpu: string, hours: number): number {
  const rate = LAMBDA_RATES_CENTS_PER_HOUR[gpu] ?? LAMBDA_RATES_CENTS_PER_HOUR.gpu_8x_a100;
  return Math.round(rate * hours);
}

function pickRate(gpu: string): number {
  return LAMBDA_RATES_CENTS_PER_HOUR[gpu] ?? LAMBDA_RATES_CENTS_PER_HOUR.gpu_8x_a100;
}

type CostGroupBy = "submitter" | "repo" | "gpu_type" | "outcome";

function groupByKey(spec: CostExperimentSpec, dim: CostGroupBy): string {
  switch (dim) {
    case "submitter":
      return spec.submitter;
    case "repo":
      // Seed doesn't track per-experiment repo; everything is ProjectOrion
      // until the real backend lands. When tests/multi-repo data arrives,
      // this key resolves to the actual repo URL.
      return "naston/ProjectOrion";
    case "gpu_type":
      return spec.gpu;
    case "outcome":
      // Normalize to {success, failed, in_flight} for the breakdown axis.
      // Astrolabe's raw outcome vocabulary is finer-grained (success,
      // failure, timeout, stopped, null) but for cost-rollup the
      // collapsed bucket matches the user's mental model — "how much did
      // we spend on runs that didn't succeed". Consistent with the
      // header's TERMINAL_FAIL_OUTCOMES set in cost-page.tsx.
      if (spec.outcome === null) return "in_flight";
      if (spec.outcome === "success") return "success";
      return "failed";
  }
}

export function seedCost(params?: {
  window?: string;
  group_by?: CostGroupBy;
  /** Stacking dimension for the chart's by_dimension series. "none" (or
   *  unset) collapses to a single "all" series so the chart renders as
   *  flat bars per day. */
  stack?: CostGroupBy | "none";
}): CostResponse {
  const groupBy: CostGroupBy = params?.group_by ?? "submitter";
  const stack: CostGroupBy | "none" = params?.stack ?? "none";
  const window = params?.window ?? "30d";
  // Window range. Anchored to a stable "today" so the seed is deterministic
  // across loads — layout work shouldn't churn with the wall clock. "all"
  // reaches back far enough to include every spec.
  const end = new Date("2026-05-28T17:00:00Z");
  const windowDays: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, all: 365 };
  const days = windowDays[window] ?? 30;
  const start = new Date(end);
  start.setDate(end.getDate() - days);

  // Filter specs to the window so picking 7d hides experiments older than
  // a week, etc. Without this, every window shows the same total.
  const specsInWindow = COST_SEED_SPECS.filter((s) => {
    const t = new Date(`${s.date}T00:00:00Z`).getTime();
    return t >= start.getTime() && t <= end.getTime();
  });

  // Per-experiment entries — synthesize versions from the spec's count.
  // For multi-version specs, divide the recorded hours across versions
  // so totals stay believable (the per-version split doesn't have to be
  // exact for layout work; the SUM is what matters).
  const experiments = specsInWindow.map((s) => {
    const inFlight = s.hours === null;
    const perVersionHours = inFlight ? null : (s.hours as number) / s.versions.length;
    const versions = s.versions.map((v, idx) => {
      // Slight per-version variation so the multilevel table doesn't look
      // suspiciously uniform — v1 a bit shorter than vN. Skip the variation
      // for in-flight (just one version).
      const h =
        perVersionHours === null
          ? null
          : perVersionHours * (1 + (idx - (s.versions.length - 1) / 2) * 0.2);
      return {
        version: v,
        gpu_type: s.gpu,
        state: idx === 0 ? s.state : ("COMPLETED" as ExperimentState),
        outcome: idx === 0 ? s.outcome : ("success" as Experiment["outcome"]),
        hours: h,
        cents: h === null ? null : centsForHours(s.gpu, h),
        estimated_cents: centsForHours(s.gpu, s.estimatedHours),
      };
    });
    const totalHours = versions.reduce<number>(
      (sum, v) => sum + (v.hours ?? 0),
      0,
    );
    const totalCents = versions.reduce<number>(
      (sum, v) => sum + (v.cents ?? 0),
      0,
    );
    return {
      name: s.name,
      total_hours: totalHours,
      total_cents: totalCents,
      versions,
    };
  });

  const totalCents = experiments.reduce((sum, e) => sum + e.total_cents, 0);

  // Time-series: bucket the in-window experiments into days. For seed
  // simplicity, assign each experiment's full cost to its `date`. Real
  // backend will pro-rate across days for runs that span midnight; layout
  // doesn't care.
  const timeSeries: CostResponse["time_series"] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const exps = specsInWindow.filter((s) => s.date === iso);
    const byDim: Record<string, number> = {};
    let dayTotal = 0;
    for (const s of exps) {
      const h = s.hours ?? s.estimatedHours;
      const cents = centsForHours(s.gpu, h);
      // Key the contribution by the requested stack dimension. "none" all
      // funnels into a single "all" series so the chart renders flat bars
      // with one segment per day.
      const key = stack === "none" ? "all" : groupByKey(s, stack);
      byDim[key] = (byDim[key] ?? 0) + cents;
      dayTotal += cents;
    }
    timeSeries.push({
      start: iso,
      total_cents: dayTotal,
      by_dimension: byDim,
    });
  }

  // Breakdown — recomputed per the requested dimension so the seed
  // mirrors what the real backend will produce for ?group_by=<dim>.
  const groups = new Map<string, { submits: number; hours: number; cents: number }>();
  for (const s of specsInWindow) {
    const key = groupByKey(s, groupBy);
    const cur = groups.get(key) ?? { submits: 0, hours: 0, cents: 0 };
    const h = s.hours ?? 0;
    cur.submits += s.versions.length;
    cur.hours += h;
    cur.cents += centsForHours(s.gpu, h);
    groups.set(key, cur);
  }
  const breakdownRows = Array.from(groups.entries())
    .map(([key, g]) => ({
      key,
      submits: g.submits,
      hours: Number(g.hours.toFixed(2)),
      cents: g.cents,
      pct: totalCents > 0 ? (g.cents / totalCents) * 100 : 0,
    }))
    .sort((a, b) => b.cents - a.cents);

  // Mirror the requested window in the response label so the header text
  // and "is there a prior window?" check match. The seed isn't actually
  // re-bucketing experiments per window (layout work, not data work) — but
  // the label is what suppresses the delta on "all", so it MUST be honored.
  const labelMap: Record<string, CostResponse["window"]["label"]> = {
    "7d": "7d",
    "30d": "30d",
    "90d": "90d",
    all: "all",
  };
  const label = labelMap[params?.window ?? "30d"] ?? "30d";

  return {
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      label,
      bucket: "daily",
    },
    total_cents: totalCents,
    // "All time" has no meaningful prior window; zero it out so the
    // delta-suppression check on the frontend fires regardless of which
    // path it uses (label-check or value-check). Other windows synthesize
    // ~15% less than current so the delta arrow shows a believable "↑ %".
    prior_total_cents:
      label === "all" ? 0 : Math.round(totalCents * 0.83),
    time_series: timeSeries,
    breakdown: {
      dimension: groupBy,
      rows: breakdownRows,
    },
    experiments,
  };
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
