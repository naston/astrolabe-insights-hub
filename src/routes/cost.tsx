import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { CostPage } from "@/components/cost-page";
import type { CostGroupByDimension } from "@/lib/types";

/**
 * Search-param shape for the cost page. Mirrors the index route's style
 * — typed validateSearch keeps the URL contract explicit and lets
 * useNavigate produce typed search updates.
 */
export type CostSearchParams = {
  window?: string;
  group_by?: CostGroupByDimension;
  /** Stacking dimension for the time-series chart. ``none`` (or unset)
   *  renders a single flat bar per day showing total spend; other values
   *  produce a stacked bar by that axis. Independent of group_by, which
   *  drives the breakdown table — chart and table answer different
   *  questions and shouldn't be coupled. */
  stack?: CostGroupByDimension | "none";
  /** Comma-joined multi-select filters for the experiments-in-window
   *  table. The chart and breakdown ignore these — they always represent
   *  the unfiltered window — so the filters narrow the bottom table
   *  without distorting the "where did the money go" view. */
  f_submitter?: string;
  f_repo?: string;
  f_gpu?: string;
  f_outcome?: string;
};

const GROUP_BY_VALUES: ReadonlyArray<CostGroupByDimension> = [
  "submitter",
  "repo",
  "gpu_type",
  "outcome",
  "backend",
];

const STACK_VALUES: ReadonlyArray<CostGroupByDimension | "none"> = ["none", ...GROUP_BY_VALUES];

export const Route = createFileRoute("/cost")({
  component: Cost,
  validateSearch: (search: Record<string, unknown>): CostSearchParams => ({
    window: typeof search.window === "string" ? search.window : undefined,
    group_by:
      typeof search.group_by === "string" &&
      GROUP_BY_VALUES.includes(search.group_by as CostGroupByDimension)
        ? (search.group_by as CostGroupByDimension)
        : undefined,
    stack:
      typeof search.stack === "string" &&
      STACK_VALUES.includes(search.stack as CostGroupByDimension | "none")
        ? (search.stack as CostGroupByDimension | "none")
        : undefined,
    f_submitter: typeof search.f_submitter === "string" ? search.f_submitter : undefined,
    f_repo: typeof search.f_repo === "string" ? search.f_repo : undefined,
    f_gpu: typeof search.f_gpu === "string" ? search.f_gpu : undefined,
    f_outcome: typeof search.f_outcome === "string" ? search.f_outcome : undefined,
  }),
});

function Cost() {
  return (
    <AppShell>
      <CostPage />
    </AppShell>
  );
}
