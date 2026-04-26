import type { ExperimentState, ExperimentOutcome } from "./types";

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortHash(hash: string, n = 7): string {
  return hash.length <= n ? hash : hash.slice(0, n);
}

export function isActiveState(s: ExperimentState): boolean {
  return (
    s === "ACQUIRING" ||
    s === "SETUP" ||
    s === "RUNNING" ||
    s === "HEALING" ||
    s === "SUMMARIZING"
  );
}

/** Map state → semantic palette token name (used by StateBadge / dots). */
export function stateTone(state: ExperimentState):
  | "success"
  | "destructive"
  | "warning"
  | "info"
  | "muted" {
  switch (state) {
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "destructive";
    case "HEALING":
      return "warning";
    case "RUNNING":
    case "ACQUIRING":
    case "SETUP":
    case "SUMMARIZING":
      return "info";
    case "PENDING":
    default:
      return "muted";
  }
}

export function outcomeTone(o: ExperimentOutcome):
  | "success"
  | "destructive"
  | "warning"
  | "muted" {
  switch (o) {
    case "success":
      return "success";
    case "failure":
      return "destructive";
    case "timeout":
    case "stopped":
      return "warning";
    default:
      return "muted";
  }
}

/** Canonical FSM order — used for the transition history strip. */
export const FSM_ORDER: ExperimentState[] = [
  "PENDING",
  "ACQUIRING",
  "SETUP",
  "RUNNING",
  "HEALING",
  "SUMMARIZING",
  "COMPLETED",
  "FAILED",
];

/** Pull a "repo" out of an experiment name like "myrepo/exp-name". */
export function inferRepo(exp: { repo?: string | null; name: string }): string {
  if (exp.repo) return exp.repo;
  const slash = exp.name.indexOf("/");
  if (slash > 0) return exp.name.slice(0, slash);
  return "default";
}
