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

/** Convert a timestamp value (ISO string OR Unix seconds-as-number) to ms. */
function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0) return null;
    // The Aim REST API returns creation_time / end_time as Unix
    // seconds (float). Convert to ms for Date.
    return value * 1000;
  }
  const ms = new Date(value).getTime();
  if (!isFinite(ms)) return null;
  return ms;
}

export function formatRelative(value: string | number | null | undefined): string {
  const ms = toMs(value);
  if (ms == null) return "—";
  const diff = (Date.now() - ms) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function formatTimestamp(value: string | number | null | undefined): string {
  const ms = toMs(value);
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, {
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
    s === "ACQUIRING" || s === "SETUP" || s === "RUNNING" || s === "HEALING" || s === "SUMMARIZING"
  );
}

/** Map state → semantic palette token name (used by StateBadge / dots). */
export function stateTone(
  state: ExperimentState,
): "success" | "destructive" | "warning" | "info" | "muted" {
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

export function outcomeTone(o: ExperimentOutcome): "success" | "destructive" | "warning" | "muted" {
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

/**
 * Strip a git remote URL down to the repo name for display.
 *
 * `git@github.com:naston/ProjectOrion.git`        → `ProjectOrion`
 * `https://github.com/naston/ProjectOrion`        → `ProjectOrion`
 * `https://github.com/naston/ProjectOrion.git`    → `ProjectOrion`
 *
 * Falls back to the input string when the URL doesn't parse — better
 * to render the raw value than render nothing.
 */
export function prettifyRepo(raw: string): string {
  if (!raw) return raw;
  // Strip a trailing .git so "Foo.git" → "Foo".
  let s = raw.replace(/\.git$/i, "");
  // Take the segment after the last "/" or ":" — handles both SSH
  // (git@host:owner/repo) and HTTPS (https://host/owner/repo) forms.
  const lastSep = Math.max(s.lastIndexOf("/"), s.lastIndexOf(":"));
  if (lastSep >= 0) s = s.slice(lastSep + 1);
  return s || raw;
}

/** Pull a "repo" out of an experiment name like "myrepo/exp-name". */
export function inferRepo(exp: { repo?: string | null; name: string }): string {
  if (exp.repo) return prettifyRepo(exp.repo);
  const slash = exp.name.indexOf("/");
  if (slash > 0) return exp.name.slice(0, slash);
  return "default";
}
