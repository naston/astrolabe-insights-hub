import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { ExperimentsList } from "@/components/experiments-list";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";

/**
 * Search-param shape for the home page.
 *
 * Each filter is a comma-joined list of selected values; sort is a
 * single keyword. Empty / missing values mean "no filter" / default
 * sort. Storing as comma-joined keeps the URL compact when several
 * values are selected and survives copy-paste.
 */
export type SearchParams = {
  status?: string;
  submitter?: string;
  repo?: string;
  sort?: string;
};

export const Route = createFileRoute("/")({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    status: typeof search.status === "string" ? search.status : undefined,
    submitter: typeof search.submitter === "string" ? search.submitter : undefined,
    repo: typeof search.repo === "string" ? search.repo : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
  }),
});

function Index() {
  const [helpOpen, setHelpOpen] = useState(false);
  useGlobalShortcuts({ onHelpToggle: () => setHelpOpen((o) => !o) });

  return (
    <AppShell>
      <ExperimentsList onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </AppShell>
  );
}
