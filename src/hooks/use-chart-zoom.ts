import { useContext } from "react";

import { ChartZoomContext, type ChartZoomCtx } from "./chart-zoom-context";

export type { XAxisMode, ZoomDomain } from "./chart-zoom-context";

export function useChartZoom(): ChartZoomCtx {
  const v = useContext(ChartZoomContext);
  if (!v) throw new Error("useChartZoom must be used inside ChartZoomProvider");
  return v;
}
