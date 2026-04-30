import { useCallback, useMemo, useState } from "react";

import { ChartZoomContext, type ZoomDomain } from "./chart-zoom-context";

export function ChartZoomProvider({ children }: { children: React.ReactNode }) {
  const [domain, setDomain] = useState<ZoomDomain | null>(null);
  const reset = useCallback(() => setDomain(null), []);
  const value = useMemo(() => ({ domain, setDomain, reset }), [domain, reset]);
  return <ChartZoomContext.Provider value={value}>{children}</ChartZoomContext.Provider>;
}
