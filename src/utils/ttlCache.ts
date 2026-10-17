/**
 * Small in-memory cache with a per-entry expiry and a size cap (oldest entry is
 * dropped first). It lives in the isolate's memory, so it is per isolate and
 * best effort: a cold isolate starts empty, and entries vanish when the isolate
 * is recycled. That is fine for stable reference data. Not used for anything a
 * user writes or that must be fresh.
 */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private maxEntries = 300) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    // Re-insert so recently used entries are the last to be evicted.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()): void {
    if (ttlMs <= 0) return;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: now + ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
