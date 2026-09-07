/**
 * Small in-process TTL cache with single-flight de-duplication.
 * Serverless instances are short-lived, so this mainly absorbs the burst of
 * parallel requests a dashboard refresh produces.
 */
export function createCache({ ttlMs = 60000, maxEntries = 200 } = {}) {
  const entries = new Map();
  const inflight = new Map();

  function prune() {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    async wrap(key, loader, ttl = ttlMs) {
      if (ttl <= 0) return loader();

      const hit = entries.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;

      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = (async () => {
        try {
          const value = await loader();
          entries.set(key, { value, expiresAt: Date.now() + ttl });
          prune();
          return value;
        } finally {
          inflight.delete(key);
        }
      })();

      inflight.set(key, promise);
      return promise;
    },
    clear() {
      entries.clear();
      inflight.clear();
    },
    get size() {
      return entries.size;
    }
  };
}
