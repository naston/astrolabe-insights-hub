import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type XAxisMode = "step" | "wall_time";

export interface ZoomDomain {
  min: number;
  max: number;
}

interface ChartZoomCtx {
  domain: ZoomDomain | null;
  setDomain: (d: ZoomDomain | null) => void;
  reset: () => void;
}

const Ctx = createContext<ChartZoomCtx | null>(null);

export function ChartZoomProvider({ children }: { children: React.ReactNode }) {
  const [domain, setDomain] = useState<ZoomDomain | null>(null);
  const reset = useCallback(() => setDomain(null), []);
  const value = useMemo(() => ({ domain, setDomain, reset }), [domain, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChartZoom(): ChartZoomCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useChartZoom must be used inside ChartZoomProvider");
  return v;
}
