import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const SHORTCUTS: { keys: string[]; label: string; scope: string }[] = [
  { keys: ["j"], label: "Move down", scope: "Experiments" },
  { keys: ["k"], label: "Move up", scope: "Experiments" },
  { keys: ["↵"], label: "Open selected experiment", scope: "Experiments" },
  { keys: ["/"], label: "Focus filter", scope: "Experiments" },
  { keys: ["g", "h"], label: "Go home", scope: "Global" },
  { keys: ["t"], label: "Toggle theme", scope: "Global" },
  { keys: ["?"], label: "Toggle this help", scope: "Global" },
  { keys: ["Esc"], label: "Close dialog / clear filter", scope: "Global" },
];

export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  const grouped = SHORTCUTS.reduce<Record<string, typeof SHORTCUTS>>((acc, s) => {
    (acc[s.scope] ||= []).push(s);
    return acc;
  }, {});

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-4">
          {Object.entries(grouped).map(([scope, items]) => (
            <div key={scope}>
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {scope}
              </div>
              <ul className="divide-y divide-border">
                {items.map((s) => (
                  <li key={s.label} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[20px] items-center justify-center rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
