import { Link } from "@tanstack/react-router";
import { Moon, Sun, Telescope } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";

interface Props {
  children: React.ReactNode;
  /** Right-side slot in the top bar (e.g. freshness pill, action buttons). */
  rightSlot?: React.ReactNode;
}

export function AppShell({ children, rightSlot }: Props) {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center gap-4 px-6">
          {/* The Astrolabe logo doubles as the home link — separate "Home"
              nav item and the redundant "experiments" tag were both
              removed; the title alone carries enough weight. */}
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight hover:text-foreground"
          >
            <Telescope className="h-4 w-4 text-primary" strokeWidth={2.25} />
            <span>Astrolabe</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/cost"
              className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              activeProps={{ className: "rounded-md px-2 py-1 text-foreground bg-accent/40" }}
            >
              Cost
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {rightSlot}
            <button
              type="button"
              onClick={toggle}
              aria-label="Toggle theme"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground hover:text-foreground transition-colors"
            >
              {theme === "dark" ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
