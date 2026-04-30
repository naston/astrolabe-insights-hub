import { createContext } from "react";

export type XAxisMode = "step" | "wall_time";

export interface ZoomDomain {
  min: number;
  max: number;
}

export interface ChartZoomCtx {
  domain: ZoomDomain | null;
  setDomain: (d: ZoomDomain | null) => void;
  reset: () => void;
}

/**
 * Shared between the Provider (which writes) and the hook (which reads).
 * Lives in its own file so neither the Provider's component-only file nor
 * the hook's non-component file mixes export kinds, which would defeat
 * Vite's React-Refresh boundary detection.
 */
export const ChartZoomContext = createContext<ChartZoomCtx | null>(null);
