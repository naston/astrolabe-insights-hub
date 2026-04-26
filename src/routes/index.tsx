import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { ExperimentsList } from "@/components/experiments-list";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Astrolabe — Experiments" },
      {
        name: "description",
        content:
          "Live overview of every ML experiment running on this Astrolabe cluster.",
      },
      { property: "og:title", content: "Astrolabe — Experiments" },
      {
        property: "og:description",
        content: "Live overview of every ML experiment running on this cluster.",
      },
    ],
  }),
  component: Index,
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
