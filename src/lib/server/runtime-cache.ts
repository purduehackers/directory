import { getCache } from '@vercel/functions';

export type CacheSetOptions = {
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Optional cache tags for bulk invalidation via expireTag() */
  tags?: string[];
  /** Optional human-readable label for Vercel observability */
  name?: string;
};

type MemoryEntry = {
  value: unknown;
  expiresAt: number;
  tags: Set<string>;
};

const memoryStore = new Map<string, MemoryEntry>();
const tagIndex = new Map<string, Set<string>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function isVercelRuntimeAvailable(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function getMemoryValue<T>(key: string, now = Date.now()): T | undefined {
  const entry = memoryStore.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    deleteMemoryKey(key);
    return undefined;
  }
  return entry.value as T;
}

function setMemoryValue<T>(key: string, value: T, options: CacheSetOptions): void {
  deleteMemoryKey(key);
  const tags = new Set(options.tags ?? []);
  const expiresAt = Date.now() + Math.max(1, options.ttlMs);
  memoryStore.set(key, { value, expiresAt, tags });

  for (const tag of tags) {
    let keys = tagIndex.get(tag);
    if (!keys) {
      keys = new Set();
      tagIndex.set(tag, keys);
    }
    keys.add(key);
  }
}

function deleteMemoryKey(key: string): boolean {
  const existing = memoryStore.get(key);
  if (!existing) return false;
  for (const tag of existing.tags) {
    const keys = tagIndex.get(tag);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        tagIndex.delete(tag);
      }
    }
  }
  return memoryStore.delete(key);
}

function expireMemoryTags(tags: string[]): void {
  for (const tag of tags) {
    const keys = tagIndex.get(tag);
    if (!keys) continue;
    for (const key of [...keys]) {
      deleteMemoryKey(key);
    }
    tagIndex.delete(tag);
  }
}

export const runtimeCache = {
  /**
   * Retrieves a value from the L1/fallback memory store or L2 Vercel Runtime Cache.
   */
  async get<T>(key: string): Promise<T | undefined> {
    if (isVercelRuntimeAvailable()) {
      try {
        const cache = getCache();
        const remoteVal = (await cache.get(key)) as T | undefined;
        if (remoteVal !== undefined && remoteVal !== null) {
          return remoteVal;
        }
        // Authoritative L2 miss (or invalidated on another isolate): evict stale L1 copy
        deleteMemoryKey(key);
        return undefined;
      } catch (err) {
        console.warn(`[RuntimeCache] Vercel cache.get(${key}) fallback to memory:`, err);
      }
    }
    return getMemoryValue<T>(key);
  },

  /**
   * Persists a value into both the local memory fallback and L2 Vercel Runtime Cache.
   * Note: @vercel/functions expects `ttl` in seconds, so `ttlMs` is converted automatically.
   */
  async set<T>(key: string, value: T, options: CacheSetOptions): Promise<void> {
    setMemoryValue(key, value, options);

    if (isVercelRuntimeAvailable()) {
      try {
        const cache = getCache();
        const ttlSeconds = Math.max(1, Math.ceil(options.ttlMs / 1000));
        await cache.set(key, value, {
          ttl: ttlSeconds,
          tags: options.tags,
          name: options.name,
        });
      } catch (err) {
        console.warn(`[RuntimeCache] Vercel cache.set(${key}) failed (stored in memory):`, err);
      }
    }
  },

  /**
   * Deletes a single key from both local memory and L2 Vercel Runtime Cache.
   */
  async delete(key: string): Promise<boolean> {
    const deletedLocal = deleteMemoryKey(key);

    if (isVercelRuntimeAvailable()) {
      try {
        const cache = getCache();
        await cache.delete(key);
        return true;
      } catch (err) {
        console.warn(`[RuntimeCache] Vercel cache.delete(${key}) failed:`, err);
      }
    }
    return deletedLocal;
  },

  /**
   * Invalidates all cache entries associated with one or more tags across both L1 memory and L2 Vercel Runtime Cache.
   */
  async expireTag(tagOrTags: string | string[]): Promise<void> {
    const tags = Array.isArray(tagOrTags) ? tagOrTags : [tagOrTags];
    if (tags.length === 0) return;

    expireMemoryTags(tags);

    if (isVercelRuntimeAvailable()) {
      try {
        const cache = getCache();
        for (const tag of tags) {
          await cache.expireTag(tag);
        }
      } catch (err) {
        console.warn(`[RuntimeCache] Vercel cache.expireTag(${tags.join(',')}) failed:`, err);
      }
    }
  },

  /**
   * Read-through helper with singleflight request coalescing per isolate.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheSetOptions
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existingFlight = inFlightRequests.get(key) as Promise<T> | undefined;
    if (existingFlight) {
      return existingFlight;
    }

    const promise = (async () => {
      try {
        const freshValue = await fetcher();
        await this.set(key, freshValue, options);
        return freshValue;
      } finally {
        inFlightRequests.delete(key);
      }
    })();

    inFlightRequests.set(key, promise);
    return promise;
  },
};

export function resetRuntimeCacheForTesting(): void {
  memoryStore.clear();
  tagIndex.clear();
  inFlightRequests.clear();
}
