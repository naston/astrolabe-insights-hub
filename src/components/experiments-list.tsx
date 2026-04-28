import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cpu,
  Keyboard,
  RefreshCw,
  Search,
} from "lucide-react";

import { api } from "@/lib/api";
import type { Experiment, ExperimentState, Run } from "@/lib/types";
import { usePolling } from "@/hooks/use-polling";
import {
  formatDuration,
  formatRelative,
  formatTimestamp,
  inferRepo,
  isActiveState,
  shortHash,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { FilterDropdown } from "@/components/filter-dropdown";
import { StatusDot } from "@/components/status-dot";
import { OutcomeBadge, StateBadge } from "@/components/state-badge";
import { FreshnessPill } from "@/components/freshness-pill";
import { Kbd } from "@/components/shortcuts-help";

/**
 * Status filter buckets the FSM into four user-facing states.
 *
 * The actual ExperimentState enum has 8 values (PENDING, ACQUIRING,
 * SETUP, RUNNING, HEALING, SUMMARIZING, COMPLETED, FAILED). The filter
 * shelf collapses them to four buckets the operator actually thinks in:
 *
 * - running: any active state (ACQUIRING, SETUP, RUNNING, HEALING, SUMMARIZING)
 * - completed
 * - failed
 * - pending
 */
type StatusBucket = "running" | "completed" | "failed" | "pending";
const STATUS_OPTIONS: { value: StatusBucket; label: string }[] = [
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
];

function statusBucket(state: ExperimentState): StatusBucket {
  if (state === "COMPLETED") return "completed";
  if (state === "FAILED") return "failed";
  if (state === "PENDING") return "pending";
  return "running";
}

/**
 * Sort key — the column being sorted by, with explicit direction.
 *
 * Three sortable columns map to the existing table headers:
 *
 *  - "name-asc"     / "name-desc"      — Experiment column (A–Z / Z–A)
 *  - "state-asc"    / "state-desc"     — State column (active-first / failed-first)
 *  - "started-asc"  / "started-desc"   — Started column (oldest-first / recent-first)
 *
 * The default (no key in the URL) is "started-desc" semantically, but
 * we don't render a caret indicator on the Started header in that
 * case — keeping the home page visually clean when the user hasn't
 * picked a sort.
 *
 * Backward-compat for v0.4.0-shaped URLs (?sort=recent|oldest|name|status):
 * decoded into the new shape via legacySort below. Old bookmarks
 * keep working; their next interaction with the column headers
 * produces the new URL values.
 */
type SortColumn = "name" | "state" | "started";
type SortDirection = "asc" | "desc";
type SortKey = `${SortColumn}-${SortDirection}`;

const STATUS_RANK: Record<StatusBucket, number> = {
  running: 0,
  pending: 1,
  completed: 2,
  failed: 3,
};

/** Map ?sort= values (including the v0.4.0 names) to the new SortKey. */
function decodeSortKey(raw: string | undefined): SortKey | null {
  if (!raw) return null;
  // v0.4.0 shorthand → v0.4.1+ explicit shape.
  const legacy: Record<string, SortKey> = {
    recent: "started-desc",
    oldest: "started-asc",
    name: "name-asc",
    status: "state-asc",
  };
  if (raw in legacy) return legacy[raw];
  // New shape: validate against the 6 known values.
  const valid: SortKey[] = [
    "name-asc", "name-desc",
    "state-asc", "state-desc",
    "started-asc", "started-desc",
  ];
  return (valid as string[]).includes(raw) ? (raw as SortKey) : null;
}

/**
 * Compute what a click on `column` should produce.
 *
 * Cycle: unsorted → asc → desc → unsorted (clears the sort).
 *
 * Date-shaped columns (started) start with desc so the first click
 * shows "most recent first" — matches GitHub / general-purpose
 * conventions for date sorts. Other columns start asc.
 *
 * Returns the next SortKey, or null when the click should clear.
 */
function nextSortKey(column: SortColumn, current: SortKey | null): SortKey | null {
  const initial: SortDirection = column === "started" ? "desc" : "asc";
  if (!current || !current.startsWith(`${column}-`)) {
    return `${column}-${initial}` as SortKey;
  }
  // Already sorting by this column — flip or clear.
  const flipped: SortDirection = current.endsWith("-asc") ? "desc" : "asc";
  if (flipped === initial) {
    // We've completed the cycle (asc → desc → asc, or desc → asc → desc).
    // Clear back to default.
    return null;
  }
  return `${column}-${flipped}` as SortKey;
}

/** Decode a comma-joined search-param value into a list. */
function decodeList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Encode a list as a comma-joined search-param value (or undefined when empty). */
function encodeList(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  return values.join(",");
}

const POLL_MS = 3000;

interface ExperimentsListProps {
  onShowHelp: () => void;
}

export function ExperimentsList({ onShowHelp }: ExperimentsListProps) {
  const { data, error, loading, lastUpdated, refetch } = usePolling(
    (signal) => api.experiments(signal),
    [],
    { intervalMs: POLL_MS },
  );
  // Distinguish "first paint, no data yet" from "background re-fetch".
  // We only show loading affordances during the first load.
  const firstLoad = loading && data === undefined;

  const experiments = useMemo(() => data ?? [], [data]);

  // URL-state-driven filters + sort. The route validates these via
  // validateSearch so they always have a defined shape, but values
  // outside the known SortKey / StatusBucket sets fall through to
  // sensible defaults below.
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });

  const selectedStatus = decodeList(search.status);
  const selectedSubmitter = decodeList(search.submitter);
  const selectedRepo = decodeList(search.repo);
  // sortKey is null when no explicit sort is applied (default = started-desc, no caret).
  const sortKey: SortKey | null = decodeSortKey(search.sort);

  const updateSearch = (next: Partial<{
    status: string[];
    submitter: string[];
    repo: string[];
    sort: SortKey | null;
  }>) => {
    navigate({
      search: (prev) => ({
        ...prev,
        ...(next.status !== undefined && { status: encodeList(next.status) }),
        ...(next.submitter !== undefined && { submitter: encodeList(next.submitter) }),
        ...(next.repo !== undefined && { repo: encodeList(next.repo) }),
        // null → strip from URL; non-null → set verbatim.
        ...(next.sort !== undefined && { sort: next.sort ?? undefined }),
      }),
      replace: true,
    });
  };

  /** Click handler for sortable column headers. */
  const onColumnClick = (column: SortColumn) =>
    updateSearch({ sort: nextSortKey(column, sortKey) });

  const resetFilters = () =>
    navigate({ search: () => ({}), replace: true });

  // Free-text filter — local-only, doesn't survive page reload by
  // design (it's an in-the-moment scan, not a saved view).
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Available filter values, derived from the loaded experiment list
  // with counts for the dropdown's right-side hint.
  const submitterOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of experiments) {
      const key = e.submitted_by || "unknown";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([value, count]) => ({
      value,
      label: value,
      count,
    }));
  }, [experiments]);

  const repoOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of experiments) {
      const r = inferRepo(e);
      map.set(r, (map.get(r) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([value, count]) => ({
      value,
      label: value,
      count,
    }));
  }, [experiments]);

  const statusOptions = useMemo(() => {
    const counts = new Map<StatusBucket, number>();
    for (const e of experiments) {
      const b = statusBucket(e.state);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return STATUS_OPTIONS.map((opt) => ({
      ...opt,
      count: counts.get(opt.value) ?? 0,
    }));
  }, [experiments]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return experiments.filter((e) => {
      if (selectedStatus.length > 0 && !selectedStatus.includes(statusBucket(e.state))) {
        return false;
      }
      if (selectedSubmitter.length > 0) {
        const sub = e.submitted_by || "unknown";
        if (!selectedSubmitter.includes(sub)) return false;
      }
      if (selectedRepo.length > 0 && !selectedRepo.includes(inferRepo(e))) {
        return false;
      }
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.gpu_type?.toLowerCase().includes(q) ||
        e.state.toLowerCase().includes(q)
      );
    });
  }, [experiments, filter, selectedStatus, selectedSubmitter, selectedRepo]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    // Effective sort: explicit URL key, else the default ("started-desc").
    const effective: SortKey = sortKey ?? "started-desc";
    const direction: SortDirection = effective.endsWith("-desc") ? "desc" : "asc";
    const flip = direction === "desc" ? -1 : 1;

    if (effective.startsWith("name-")) {
      list.sort((a, b) => a.name.localeCompare(b.name) * flip);
    } else if (effective.startsWith("state-")) {
      list.sort((a, b) =>
        (STATUS_RANK[statusBucket(a.state)] - STATUS_RANK[statusBucket(b.state)]) * flip,
      );
    } else {
      // started-asc / started-desc (and the default).
      list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") * flip);
    }
    return list;
  }, [filtered, sortKey]);

  const anyFilterActive =
    selectedStatus.length > 0 ||
    selectedSubmitter.length > 0 ||
    selectedRepo.length > 0;

  const counts = useMemo(() => {
    const total = experiments.length;
    const active = experiments.filter((e) => isActiveState(e.state)).length;
    const completed = experiments.filter((e) => e.state === "COMPLETED").length;
    const failed = experiments.filter((e) => e.state === "FAILED").length;
    return { total, active, completed, failed };
  }, [experiments]);

  // Selection + keyboard nav
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rowRefs = useRef<Record<number, HTMLElement | null>>({});

  // Reset selection when filter / sort changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [filter, selectedStatus, selectedSubmitter, selectedRepo, sortKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
        return;
      }

      if (e.key === "Escape" && document.activeElement === filterInputRef.current) {
        if (filter) {
          setFilter("");
        } else {
          (document.activeElement as HTMLElement)?.blur();
        }
        return;
      }

      if (isEditable) return;

      if (e.key === "j") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(sorted.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        const exp = sorted[selectedIdx];
        if (exp) {
          e.preventDefault();
          navigate({
            to: "/experiment",
            search: { name: exp.name, version: "latest" },
          });
        }
      } else if (e.key === "x" || e.key === "o") {
        const exp = sorted[selectedIdx];
        if (exp) {
          e.preventDefault();
          setExpanded((m) => ({ ...m, [exp.name]: !m[exp.name] }));
        }
      } else if (e.key === "r") {
        e.preventDefault();
        refetch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sorted, selectedIdx, navigate, filter, refetch]);

  // Scroll selected row into view
  useEffect(() => {
    const el = rowRefs.current[selectedIdx];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIdx]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label="Total experiments" value={counts.total} />
        <KpiCard label="Active" value={counts.active} accent="info" pulse={counts.active > 0} />
        <KpiCard label="Completed" value={counts.completed} accent="success" />
        <KpiCard label="Failed" value={counts.failed} accent="destructive" />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={filterInputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-44 rounded-md border border-border bg-surface pl-8 pr-12 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition"
          />
          <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
        </div>

        <FilterDropdown
          label="Status"
          options={statusOptions}
          selected={selectedStatus}
          onChange={(next) => updateSearch({ status: next })}
        />
        <FilterDropdown
          label="Submitter"
          options={submitterOptions}
          selected={selectedSubmitter}
          onChange={(next) => updateSearch({ submitter: next })}
        />
        <FilterDropdown
          label="Repo"
          options={repoOptions}
          selected={selectedRepo}
          onChange={(next) => updateSearch({ repo: next })}
        />

        {/* Sort lives on the table headers — see SortableHeader below. */}
        {anyFilterActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Reset filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <FreshnessPill
            lastUpdated={lastUpdated}
            loading={loading}
            intervalMs={POLL_MS}
          />
          <button
            onClick={() => refetch()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground hover:text-foreground"
            aria-label="Refresh"
            title="Refresh now (r)"
          >
            {/* Spinner only animates during the very first load — background
                polls are silent per spec. */}
            <RefreshCw className={cn("h-3.5 w-3.5", firstLoad && "animate-spin")} />
          </button>
          <button
            onClick={onShowHelp}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-muted-foreground hover:text-foreground"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
            <Kbd>?</Kbd>
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-[28px_minmax(260px,1fr)_140px_140px_120px_110px_110px_90px] gap-3 border-b border-border bg-surface px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span></span>
          <SortableHeader
            label="Experiment"
            column="name"
            currentSort={sortKey}
            onClick={() => onColumnClick("name")}
          />
          <SortableHeader
            label="State"
            column="state"
            currentSort={sortKey}
            onClick={() => onColumnClick("state")}
          />
          <span>GPU</span>
          <SortableHeader
            label="Started"
            column="started"
            currentSort={sortKey}
            onClick={() => onColumnClick("started")}
          />
          <span>Duration</span>
          <span className="text-right">Versions</span>
          <span className="text-right">Outcome</span>
        </div>

        {error && (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            Failed to load experiments — {error.message}
          </div>
        )}

        {!error && sorted.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            {experiments.length === 0
              ? "Waiting for the orchestrator…"
              : "No experiments match the current filter."}
          </div>
        )}

        <ul className="divide-y divide-border">
          {sorted.map((exp, idx) => (
            <ExperimentRow
              key={exp.name}
              ref={(el) => {
                rowRefs.current[idx] = el;
              }}
              experiment={exp}
              selected={idx === selectedIdx}
              expanded={!!expanded[exp.name]}
              onSelect={() => setSelectedIdx(idx)}
              onToggle={() =>
                setExpanded((m) => ({ ...m, [exp.name]: !m[exp.name] }))
              }
            />
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
        <span>
          {sorted.length} of {experiments.length} experiments
        </span>
        <span className="flex items-center gap-2">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          <span>navigate</span>
          <span className="opacity-50">·</span>
          <Kbd>↵</Kbd>
          <span>open</span>
          <span className="opacity-50">·</span>
          <Kbd>x</Kbd>
          <span>expand runs</span>
        </span>
      </div>
    </div>
  );
}

interface KpiProps {
  label: string;
  value: number;
  accent?: "info" | "success" | "destructive";
  pulse?: boolean;
}

function KpiCard({ label, value, accent, pulse }: KpiProps) {
  const accentClass =
    accent === "info"
      ? "text-[var(--info)]"
      : accent === "success"
        ? "text-[var(--success)]"
        : accent === "destructive"
          ? "text-[var(--destructive)]"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {pulse && value > 0 && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot" />
        )}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold text-tabular", accentClass)}>
        {value}
      </div>
    </div>
  );
}

/**
 * A clickable sortable column header with caret indicator.
 *
 * Three sortable columns on the home-page table — Experiment / State
 * / Started — use this. Click cycles through asc → desc → cleared
 * (the URL ``sort`` param is removed, list returns to the default
 * "started-desc" without an indicator).
 *
 * The caret renders only when this column is the active sort. When
 * inactive, the header looks like the non-sortable headers; on
 * hover, a subtle foreground change signals it's clickable.
 */
function SortableHeader({
  label,
  column,
  currentSort,
  onClick,
}: {
  label: string;
  column: SortColumn;
  currentSort: SortKey | null;
  onClick: () => void;
}) {
  const isActive = currentSort?.startsWith(`${column}-`);
  const direction: SortDirection | null = isActive
    ? (currentSort!.endsWith("-asc") ? "asc" : "desc")
    : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-left transition-colors hover:text-foreground",
        isActive && "text-foreground",
      )}
      aria-sort={
        direction === "asc" ? "ascending"
        : direction === "desc" ? "descending"
        : "none"
      }
    >
      <span>{label}</span>
      {direction === "asc" && <ChevronUp className="h-3 w-3" />}
      {direction === "desc" && <ChevronDown className="h-3 w-3" />}
    </button>
  );
}

interface ExperimentRowProps {
  experiment: Experiment;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  ref?: React.Ref<HTMLLIElement>;
}

function ExperimentRow({
  experiment,
  selected,
  expanded,
  onSelect,
  onToggle,
  ref,
}: ExperimentRowProps) {
  const live = isActiveState(experiment.state);
  return (
    <li
      ref={ref}
      data-selected={selected}
      className={cn(
        "group relative",
        selected && "bg-[color-mix(in_oklab,var(--primary)_8%,transparent)]",
      )}
    >
      {selected && (
        <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
      )}
      <div
        className="grid grid-cols-[28px_minmax(260px,1fr)_140px_140px_120px_110px_110px_90px] gap-3 items-center px-3 py-2 cursor-pointer hover:bg-muted/50"
        onClick={onSelect}
        onDoubleClick={onToggle}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <Link
          to="/experiment"
          search={{ name: experiment.name, version: "latest" }}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2 min-w-0"
        >
          <StatusDot state={experiment.state} />
          <span className="truncate text-sm font-medium hover:text-primary transition-colors">
            {experiment.name}
          </span>
          {live && (
            <span className="ml-1 rounded bg-[color-mix(in_oklab,var(--info)_15%,transparent)] px-1 py-0.5 text-[9px] font-mono text-[var(--info)] uppercase tracking-wider">
              live
            </span>
          )}
        </Link>
        <StateBadge state={experiment.state} />
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono truncate">
          <Cpu className="h-3 w-3 shrink-0" />
          <span className="truncate">{experiment.gpu_type || "—"}</span>
        </span>
        <span
          className="text-xs text-muted-foreground font-mono text-tabular truncate"
          title={formatTimestamp(experiment.started_at)}
        >
          {formatRelative(experiment.started_at)}
        </span>
        <span className="text-xs text-foreground font-mono text-tabular">
          {formatDuration(experiment.duration)}
        </span>
        <span className="text-right">
          <VersionBadge
            versionCount={experiment.version_count ?? experiment.run_count}
            runCount={experiment.run_count}
          />
        </span>
        <span className="text-right">
          <OutcomeBadge outcome={experiment.outcome} />
        </span>
      </div>
      {expanded && <RunsPanel experimentName={experiment.name} />}
    </li>
  );
}

function RunsPanel({ experimentName }: { experimentName: string }) {
  // Polling at the same cadence as the parent list keeps things consistent.
  const { data, error } = usePolling(
    (signal) => api.runs(experimentName, signal),
    [experimentName],
    { intervalMs: POLL_MS },
  );

  // Group runs by version, then show the LATEST version's runs in the
  // expansion. Cross-version comparison happens on the detail page; the
  // home expansion is for "what's in this latest submit?" — typically the
  // 2-3 things being compared (e.g., BERT vs LatentBERT).
  const groups = useMemo(() => {
    if (!data) return null;
    const byVersion = new Map<string, { label: string; runs: Run[]; createdAt: string }>();
    for (const run of data) {
      const label = run.version || "v1";
      const entry = byVersion.get(label);
      if (entry) {
        entry.runs.push(run);
        if (run.creation_time < entry.createdAt) entry.createdAt = run.creation_time;
      } else {
        byVersion.set(label, {
          label,
          runs: [run],
          createdAt: run.creation_time,
        });
      }
    }
    return Array.from(byVersion.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [data]);

  const latest = groups && groups.length > 0 ? groups[groups.length - 1] : null;
  const olderVersionCount = groups ? Math.max(0, groups.length - 1) : 0;

  return (
    <div className="border-t border-border bg-surface/50 px-3 py-2 animate-fade-in">
      {error && !data && (
        <div className="px-2 py-3 text-xs text-destructive">
          Failed to load runs — {error.message}
        </div>
      )}
      {data && data.length === 0 && (
        <div className="px-2 py-3 text-xs text-muted-foreground">No runs yet.</div>
      )}
      {!data && !error && (
        <div className="px-2 py-3 text-xs text-muted-foreground/60 font-mono">·····</div>
      )}
      {latest && (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>
              <span className="text-foreground font-mono">{latest.label}</span>
              {" — "}
              {latest.runs.length} run{latest.runs.length === 1 ? "" : "s"}
              {" (latest version)"}
            </span>
            {olderVersionCount > 0 && (
              <Link
                to="/experiment"
                search={{ name: experimentName, version: "latest" }}
                className="font-mono text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                +{olderVersionCount} older version
                {olderVersionCount === 1 ? "" : "s"} →
              </Link>
            )}
          </div>
          <div className="grid grid-cols-[80px_minmax(0,1fr)_120px_120px_100px_90px] gap-3 border-b border-border bg-surface/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Hash</span>
            <span>Run</span>
            <span>Created</span>
            <span>Duration</span>
            <span className="text-right">Final loss</span>
            <span className="text-right">State</span>
          </div>
          <ul className="divide-y divide-border">
            {latest.runs.map((run) => (
              <RunRow
                key={run.hash}
                run={run}
                experimentName={experimentName}
                versionLabel={latest.label}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function VersionBadge({
  versionCount,
  runCount,
}: {
  versionCount: number;
  runCount: number;
}) {
  // Cardinality cue — make it obvious that one row = N versions of an
  // experiment, and each version typically holds multiple runs (e.g.
  // BERT + LatentBERT). Both numbers are useful at a scan: ×N v says
  // "this has been re-run N times", "M runs" says "M training jobs total."
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
      title={`${versionCount} version${versionCount === 1 ? "" : "s"} · ${runCount} run${runCount === 1 ? "" : "s"} total`}
    >
      <span className="text-tabular text-foreground font-medium">
        ×{versionCount}
      </span>
      <span className="opacity-60">v</span>
      <span className="opacity-40">·</span>
      <span className="text-tabular text-muted-foreground">{runCount}</span>
      <span className="opacity-60">r</span>
    </span>
  );
}

function RunRow({
  run,
  experimentName,
  versionLabel,
}: {
  run: Run;
  experimentName: string;
  versionLabel: string;
}) {
  return (
    <li className="grid grid-cols-[80px_minmax(0,1fr)_120px_120px_100px_90px] gap-3 items-center px-3 py-1.5 text-xs hover:bg-muted/50">
      <Link
        to="/experiment"
        search={{ name: experimentName, version: versionLabel }}
        className="font-mono text-muted-foreground hover:text-primary"
        onClick={(e) => e.stopPropagation()}
        title={`Open ${versionLabel} of this experiment`}
      >
        {shortHash(run.hash)}
      </Link>
      <span className="truncate font-medium">{run.name}</span>
      <span
        className="font-mono text-tabular text-muted-foreground"
        title={formatTimestamp(run.creation_time)}
      >
        {formatRelative(run.creation_time)}
      </span>
      <span className="font-mono text-tabular">{run.duration || "—"}</span>
      <span className="text-right font-mono text-tabular">
        {run.final_loss != null ? run.final_loss.toFixed(4) : "—"}
      </span>
      <span className="text-right">
        {run.active ? (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase text-[var(--info)] bg-[color-mix(in_oklab,var(--info)_15%,transparent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--info)] pulse-dot" />
            running
          </span>
        ) : (
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            done
          </span>
        )}
      </span>
    </li>
  );
}
