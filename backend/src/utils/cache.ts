/**
 * Lightweight in-memory TTL cache for dashboard API responses.
 *
 * WHY: Neon free tier has a 5GB/month data transfer cap.
 * Dashboard queries pull 50k–200k rows on every request.
 * With no cache, a single user refreshing the dashboard 10 times
 * transfers the same massive dataset 10 times.
 *
 * With a 5-minute cache: 10 refreshes = 1 DB query.
 * Result: ~90% reduction in Neon data transfer.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/**
 * Get a cached value or compute it fresh and store it.
 * @param key     - Unique cache key (include filter params to avoid stale data cross-filter)
 * @param ttlMs   - Time to live in milliseconds (default: 5 minutes)
 * @param compute - Async function that fetches the real data
 */
export const cached = async <T>(
  key: string,
  ttlMs: number = 5 * 60 * 1000,
  compute: () => Promise<T>
): Promise<T> => {
  const now = Date.now();
  const entry = store.get(key) as CacheEntry<T> | undefined;

  if (entry && entry.expiresAt > now) {
    return entry.data;
  }

  const data = await compute();
  store.set(key, { data, expiresAt: now + ttlMs });
  return data;
};

/** Manually invalidate all keys matching a prefix (call after sync completes) */
export const invalidatePrefix = (prefix: string): void => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
};

/** Clear the entire cache (e.g. after a full rolling sync) */
export const clearCache = (): void => {
  store.clear();
  console.log('[CACHE] Full cache cleared');
};

/** Cache stats for debugging */
export const cacheStats = () => ({
  entries: store.size,
  keys: Array.from(store.keys()),
});
