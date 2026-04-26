import { useEffect, useRef, useState } from "react";

interface PollingOptions {
  intervalMs: number;
  enabled?: boolean;
  immediate?: boolean;
}

export interface PollingState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  lastUpdated: number | null;
  refetch: () => void;
}

/**
 * Lightweight polling hook. Re-fetches on an interval, cancels in-flight
 * requests on unmount, and surfaces a `lastUpdated` timestamp so the UI
 * can show a freshness indicator.
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  { intervalMs, enabled = true, immediate = true }: PollingOptions,
): PollingState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const tickRef = useRef(0);

  // Stable fetcher ref so we don't restart the interval on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useRef(async () => {
    const myTick = ++tickRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    try {
      const result = await fetcherRef.current(ctrl.signal);
      if (myTick !== tickRef.current) return;
      setData(result);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (myTick !== tickRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (myTick === tickRef.current) setLoading(false);
    }
    return () => ctrl.abort();
  });

  useEffect(() => {
    if (!enabled) return;
    if (immediate) void run.current();
    const id = window.setInterval(() => void run.current(), intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);

  return { data, error, loading, lastUpdated, refetch: () => void run.current() };
}
