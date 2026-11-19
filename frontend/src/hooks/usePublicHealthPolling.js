import { useState, useEffect, useRef } from "react";

/**
 * usePublicHealthPolling — issue #1831.
 *
 * The public parent pay page must work on flaky mobile networks, so it does
 * not hold a long-lived SSE connection. Instead it polls a small public
 * endpoint with exponential back-off and reports the same status shape as
 * usePaymentEvents, so SseDegradedBanner can be reused unchanged.
 *
 *   - Polls every `intervalMs` (default 20 s) while the tab is visible.
 *   - After each failure the delay doubles, capped at `maxIntervalMs` (60 s).
 *   - A single failure is not user-visible: the banner appears only after
 *     `failuresBeforeBanner` consecutive failures (default 3).
 *   - Polling pauses while the document is hidden and resumes (immediately)
 *     when it becomes visible again, saving battery and data.
 *
 * @param {object}   [options]
 * @param {boolean}  [options.enabled=true]
 * @param {string}   [options.url='/api/public-config']
 * @param {number}   [options.intervalMs=20000]
 * @param {number}   [options.maxIntervalMs=60000]
 * @param {number}   [options.failuresBeforeBanner=3]
 * @param {Function} [options.fetchImpl=fetch]  - injectable for tests
 * @returns {{ degraded: boolean, connectionStatus: 'connected'|'reconnecting' }}
 */
export function usePublicHealthPolling({
  enabled = true,
  url = "/api/public-config",
  intervalMs = 20000,
  maxIntervalMs = 60000,
  failuresBeforeBanner = 3,
  fetchImpl,
} = {}) {
  const [failures, setFailures] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    const doFetch = fetchImpl || ((u, opts) => window.fetch(u, opts));
    let timer = null;
    let cancelled = false;
    let controller = null;

    const schedule = (delay) => {
      clearTimeout(timer);
      if (cancelled) return;
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Resume from the visibility listener instead of spinning in the background.
        return;
      }
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let ok = false;
      try {
        const res = await doFetch(url, {
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        });
        ok = Boolean(res && res.ok);
      } catch {
        ok = false;
      }
      if (cancelled) return;

      if (ok) {
        failuresRef.current = 0;
        setFailures(0);
        schedule(intervalMs);
      } else {
        failuresRef.current += 1;
        setFailures(failuresRef.current);
        const backoff = Math.min(intervalMs * 2 ** (failuresRef.current - 1), maxIntervalMs);
        schedule(backoff);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };

    failuresRef.current = 0;
    setFailures(0);
    tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (controller) controller.abort();
    };
  }, [enabled, url, intervalMs, maxIntervalMs, fetchImpl]);

  const showBanner = failures >= failuresBeforeBanner;
  return {
    degraded: false,
    connectionStatus: showBanner ? "reconnecting" : "connected",
  };
}

export default usePublicHealthPolling;
