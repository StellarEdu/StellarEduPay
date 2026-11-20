// Issue #1998 — report history must never be shared across users or schools.
// Entries live in sessionStorage under `reportHistory:<userId>:<schoolId>` so
// they disappear when the tab/session ends, and every key is cleared on logout.

const KEY_PREFIX = 'reportHistory:';
const MAX_ENTRIES = 10;

function storage() {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  return window.sessionStorage;
}

/**
 * Build the per-user, per-school storage key.
 * Returns null when the user or school context is unknown, in which case
 * history is neither read nor written (fail closed).
 */
export function reportHistoryKey(userId, schoolId) {
  if (!userId || !schoolId) return null;
  return `${KEY_PREFIX}${userId}:${schoolId}`;
}

export function loadReportHistory(userId, schoolId) {
  const key = reportHistoryKey(userId, schoolId);
  const store = storage();
  if (!key || !store) return [];
  try {
    const raw = store.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to load report history:', err);
    return [];
  }
}

/**
 * Persist a new entry (newest first, capped) and return the updated list.
 * `params` must already be free of student identifiers.
 */
export function saveReportHistory(userId, schoolId, entry, existing = []) {
  const key = reportHistoryKey(userId, schoolId);
  const store = storage();
  const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
  if (!key || !store) return updated;
  try {
    store.setItem(key, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to save report history:', err);
  }
  return updated;
}

/** Remove every reportHistory:* key from sessionStorage (and legacy localStorage). */
export function clearReportHistory() {
  if (typeof window === 'undefined') return;
  for (const store of [window.sessionStorage, window.localStorage]) {
    if (!store) continue;
    try {
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
      // Legacy unscoped key from before #1998.
      store.removeItem('reportHistory');
    } catch (err) {
      console.error('Failed to clear report history:', err);
    }
  }
}
