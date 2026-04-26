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
  run_count: number;
  // Optional, may be present in future API versions; falls back gracefully
  repo?: string | null;
  state_history?: { state: ExperimentState; at: string }[];
}

export interface RunMetricRef {
  name: string;
  context?: string | null;
}

export interface Run {
  hash: string;
  name: string;
  experiment: string;
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
