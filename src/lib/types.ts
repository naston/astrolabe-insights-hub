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
  /**
   * Submitter identity (OS username from astrolabe.user / ExperimentRecord.
   * submitted_by). Empty string for legacy experiments that pre-date v1.2.1;
   * the home-page Submitter filter buckets those under "unknown".
   */
  submitted_by?: string;
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
  /** Unix timestamp (seconds, float) when the run was created. */
  creation_time: number;
  /** Unix timestamp (seconds, float) when the run ended; 0 if active. */
  end_time: number | null;
  active: boolean;
  /** Pre-formatted duration string from the Go API (e.g. "5m 12s", "2h 15m"). */
  duration: string;
  metrics: RunMetricRef[];
  final_loss: number | null;
  /**
   * Submitter identity for this run. Used by the stats table to show
   * "by alice" when comparing across users. Empty for legacy runs.
   */
  submitted_by?: string;
}

/**
 * Resolution shape for a single --include argument, returned from
 * /api/experiments/{name}/includes. The Go API resolves each include
 * against four shapes: hash → experiment name → run name → unknown.
 *
 * - "hash":       single Aim run hash matched directly
 * - "experiment": Aim experiment name matched (multi-run)
 * - "run-name":   Aim run.name matched somewhere in the corpus;
 *                 resolves to the SINGLE most recent matching run
 *                 (researchers wanting wider scope use the experiment
 *                 name or a specific hash)
 * - "unknown":    no match; runs is empty. Frontend renders the
 *                 include as a struck-out chip rather than silently
 *                 dropping it
 */
export type IncludeType = "hash" | "experiment" | "run-name" | "unknown";

export interface IncludeGroup {
  name: string;
  type: IncludeType;
  /** Aim run hashes — empty for type="unknown". */
  runs: string[];
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
