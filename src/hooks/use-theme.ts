import { useContext } from "react";

import { ThemeContext, type ThemeCtx } from "./theme-context";

export type { Theme } from "./theme-context";

export function useTheme(): ThemeCtx {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside ThemeProvider");
  return v;
}
