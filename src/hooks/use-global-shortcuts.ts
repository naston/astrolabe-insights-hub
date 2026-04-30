import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "@/hooks/use-theme";

interface Options {
  onHelpToggle?: () => void;
}

/**
 * Global keyboard shortcuts that apply on every page (g h, t, ?).
 * Page-specific shortcuts (j/k/Enter on experiment list) live with their page.
 */
export function useGlobalShortcuts({ onHelpToggle }: Options = {}) {
  const navigate = useNavigate();
  const { toggle } = useTheme();

  useEffect(() => {
    let lastG = 0;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // ? help — works even outside inputs
      if (e.key === "?") {
        e.preventDefault();
        onHelpToggle?.();
        return;
      }

      if (isEditable) return;

      if (e.key === "g") {
        lastG = Date.now();
        return;
      }
      if (e.key === "h" && Date.now() - lastG < 800) {
        e.preventDefault();
        navigate({ to: "/" });
        lastG = 0;
        return;
      }
      if (e.key === "t") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, toggle, onHelpToggle]);
}
