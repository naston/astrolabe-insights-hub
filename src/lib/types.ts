// Astrolabe API types — mirror the Go backend contract exactly.

export type ExperimentState =
  | "PENDING"
  | "ACQUIRING"
  | "SETUP"
  | "RUNNING"
  | "HEALING"
  | "SUMMARIZING"
  | "COMPLETED"
  | "FAILED";

export type ExperimentOutcome = "success" | "failure" | "timeout" | "stopped" | null;

export interface Experiment {
  name: string;
  state: ExperimentState;
  gpu_type: string;
  started_at: string | null;
  duration: number; // seconds
  outcome: ExperimentOutcome;
  /** Total number of runs across every version (versions × runs-per-version). */
  run_count: number;
  /**
   * Number of versions of this experiment (each = one re-submit). Optional —
   * older API responses may not include it; the dashboard falls back to
   * counting versions from the runs payload when it's missing.
   */
  version_count?: number;
  // Optional, may be present in future API versions; falls back gracefully
  repo?: string | null;
  state_history?: { state: ExperimentState; at: string }[];
  /**
   * URL to the experiment's Linear writeup. When present, the dashboard's
   * "Linear doc" link points here. When missing, the dashboard falls back to
   * a Linear search URL — that's a soft landing, not a guarantee the doc
   * exists.
   */
  linear_doc_url?: string | null;
}

export interface RunMetricRef {
  name: string;
  context?: string | null;
}

export interface Run {
  hash: string;
  name: string;
  experiment: string;
  /**
   * Which version of the experiment this run belongs to ("v1", "v2", …).
   * One submit = one version = one or more runs (e.g. "BERT" + "LatentBERT"
   * are two runs of the same version of an "architecture-comparison"
   * experiment). Optional for backward compatibility — when missing, the
   * dashboard treats the run as version "v1".
   */
  version?: string;
  creation_time: string;
  end_time: string | null;
  active: boolean;
  duration: number;
  metrics: RunMetricRef[];
  final_loss: number | null;
}

export interface IncludeGroup {
  name: string;
  type: string;
  runs: Run[];
}

export interface IncludesResponse {
  includes: IncludeGroup[];
}

export interface MetricSeries {
  name: string;
  steps: number[];
  values: number[];
  // Optional wall-time stamps if backend provides them
  wall_times?: number[];
}

export interface ColorsResponse {
  palette: string[];
}

export interface HealthResponse {
  status: string;
}
