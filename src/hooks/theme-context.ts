import { createContext } from "react";

export type Theme = "light" | "dark";

export interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

/**
 * Shared between the Provider (which writes) and the hook (which reads).
 * Lives in its own file so the Provider's component-only file and the
 * hook's non-component file each export a single export kind, keeping
 * Vite's React-Refresh boundary detection happy.
 */
export const ThemeContext = createContext<ThemeCtx | null>(null);

export const THEME_STORAGE_KEY = "astrolabe-theme";
