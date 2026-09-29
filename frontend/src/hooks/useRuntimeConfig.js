/**
 * useRuntimeConfig — Issue #1583
 *
 * Fetches runtime configuration from GET /api/public-config so the frontend
 * does not need NEXT_PUBLIC_STELLAR_NETWORK baked into the bundle at build
 * time. The same Docker image therefore works unchanged for both testnet and
 * mainnet deployments.
 *
 * Values are read once on mount and stored in React state. A build-time
 * NEXT_PUBLIC_STELLAR_NETWORK env var is still accepted as a fallback for
 * local development without a running backend.
 *
 * Returned shape:
 *   {
 *     stellarNetwork: 'testnet' | 'mainnet',   // from backend runtime config
 *     apiVersion:     string | null,
 *     loading:        boolean,
 *     error:          Error | null,
 *     networkMismatch: boolean,  // true when build-time env disagrees with runtime
 *   }
 */

import { useState, useEffect } from 'react';

// Relative URL — works whether the app is served on its own origin or behind
// the Next.js /api/* proxy (next.config.js rewrites).
const CONFIG_URL = '/api/public-config';

let _cached = null; // module-level cache so multiple consumers share one fetch

export function useRuntimeConfig() {
  const [state, setState] = useState({
    stellarNetwork: _cached?.stellarNetwork ?? process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? null,
    apiVersion: _cached?.apiVersion ?? null,
    loading: _cached === null,
    error: null,
    networkMismatch: false,
  });

  useEffect(() => {
    if (_cached !== null) {
      // Already fetched — use the cached value immediately.
      const buildTimeNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      const mismatch =
        buildTimeNetwork != null &&
        buildTimeNetwork !== '' &&
        buildTimeNetwork !== _cached.stellarNetwork;
      setState({
        stellarNetwork: _cached.stellarNetwork,
        apiVersion: _cached.apiVersion,
        loading: false,
        error: null,
        networkMismatch: mismatch,
      });
      return;
    }

    let cancelled = false;
    fetch(CONFIG_URL, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`/api/public-config returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        _cached = data;
        const buildTimeNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
        const mismatch =
          buildTimeNetwork != null &&
          buildTimeNetwork !== '' &&
          buildTimeNetwork !== data.stellarNetwork;
        setState({
          stellarNetwork: data.stellarNetwork,
          apiVersion: data.apiVersion ?? null,
          loading: false,
          error: null,
          networkMismatch: mismatch,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Gracefully degrade: keep the build-time fallback value so the app
        // still renders, but surface the error for the mismatch guard.
        setState((prev) => ({ ...prev, loading: false, error: err }));
      });

    return () => { cancelled = true; };
  }, []);

  return state;
}

/**
 * Reset the module-level cache — useful for testing.
 */
export function _resetRuntimeConfigCache() {
  _cached = null;
}
