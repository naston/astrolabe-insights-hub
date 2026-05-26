import { useCallback, useEffect, useRef, useState } from "react";

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
 *
 * Implementation notes (see plans/dashboard-scaling.md, Q4):
 *
 * 1. **AbortController is the cancellation primitive.** The previous
 *    implementation used a monotonic `tickRef` to discard "stale"
 *    responses by checking `myTick !== tickRef.current` after the
 *    await. That had two failure modes:
 *
 *    - If a poll started while a previous one was still in flight, the
 *      previous response was silently dropped. When response latency >
 *      polling interval, the dropped response could be the only one
 *      we'd ever receive — UI sat on `firstLoad` forever despite valid
 *      data arriving over the wire.
 *    - Discarded requests still ran to completion server-side, wasting
 *      aim-api worker time. With a small worker pool and N concurrent
 *      users, this amplified into queueing.
 *
 *    Aborting the previous in-flight request gives us both behaviors
 *    for free: the dropped response throws (so we don't commit it),
 *    and the server-side fetch is canceled (so the worker is freed).
 *    The latest-response-wins behavior we wanted from the tick check
 *    falls out naturally because the aborted promise never resolves.
 *
 * 2. **Polling is post-completion, not fixed-interval.** The previous
 *    implementation used `setInterval(run, intervalMs)`, which fires
 *    every `intervalMs` *regardless of whether the previous run had
 *    finished*. Under load this generated request pile-up: a 5s
 *    response with a 3s interval started a new request every 3s while
 *    earlier ones were still in flight. After 30s there were ~10
 *    requests queued at the browser's per-origin connection limit (6
 *    in Chrome), and each new poll made it worse.
 *
 *    We use `setTimeout` chained after each request completes. The
 *    "interval" becomes a gap between completions, which is what we
 *    actually want — under load we naturally slow down instead of
 *    racing ourselves. Under normal latency (response << interval)
 *    the user-visible polling cadence is unchanged.
 *
 * 3. The `refetch()` callback aborts any in-flight request and fires a
 *    fresh one immediately. The next post-completion `setTimeout`
 *    re-arms from there.
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

  // Stable fetcher ref so we don't restart the timer on every render.
  // The effect depends on `deps`, so a real dep change does re-run.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Active in-flight request's AbortController. Mutated across renders
  // and across the effect's lifetime — refs are the right shape here.
  const abortRef = useRef<AbortController | null>(null);
  // The post-completion setTimeout ID, so cleanup + refetch can cancel
  // the next scheduled poll before it fires.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the polling loop has been torn down (unmount or
  // dep-change) so a late-resolving promise doesn't call setState on
  // an unmounted component or restart a timer the caller wanted gone.
  const aliveRef = useRef(true);

  // Single-instance request runner. Declared with useRef so the same
  // function identity is shared across renders — the timer callback
  // and the refetch handler both reach into this ref.
  const runRef = useRef<() => Promise<void>>(async () => {});
  // Companion ref for the re-arm closure so `refetch` can invoke the
  // same schedule the effect set up, instead of duplicating logic.
  const scheduleRef = useRef<() => void>(() => {});

  runRef.current = async () => {
    if (!aliveRef.current) return;
    // Abort any prior in-flight request before starting a new one.
    // The previous request's promise will throw with AbortError,
    // which the catch block ignores — no setState side effects.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const result = await fetcherRef.current(ctrl.signal);
      // If our request was aborted (a newer one started, or the
      // effect tore down), don't commit — the newer request will
      // commit its own result.
      if (ctrl.signal.aborted || !aliveRef.current) return;
      setData(result);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      // AbortError on abort()ed signals is expected — silent drop.
      if (ctrl.signal.aborted || !aliveRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // setLoading(false) only if we're still the active in-flight.
      // If a newer poll started while we were awaiting, it has its
      // own loading=true sequence; don't trample it.
      if (abortRef.current === ctrl && aliveRef.current) {
        setLoading(false);
      }
    }
  };

  // Effect owns the timer lifecycle. Recreated when deps change.
  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;

    const schedule = () => {
      if (!aliveRef.current || !enabled) return;
      // Clear any pending timer before arming a new one so two
      // concurrent code paths re-arming the chain (e.g., a normal
      // poll completing AND a manual refetch() resolving at nearly
      // the same time) collapse into a single live timer rather
      // than spawning parallel chains that double on every cycle.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(async () => {
        await runRef.current();
        schedule();
      }, intervalMs);
    };
    scheduleRef.current = schedule;

    if (immediate) {
      // Fire-and-schedule: the first poll runs right away, the chain
      // continues on a setTimeout AFTER it resolves.
      void (async () => {
        await runRef.current();
        schedule();
      })();
    } else {
      schedule();
    }

    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Aborting on teardown prevents a slow response from calling
      // setState on an unmounted component.
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, immediate, ...deps]);

  const refetch = useCallback(() => {
    // Cancel the queued next poll and fire one right now. The runner
    // aborts any in-flight before starting; the recursive schedule
    // chain re-arms automatically via scheduleRef after the manual
    // fire resolves.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void (async () => {
      await runRef.current();
      scheduleRef.current();
    })();
  }, []);

  return { data, error, loading, lastUpdated, refetch };
}
