import { createHash } from 'node:crypto';

/**
 * Process-local TTL + LRU cache. Never persist credentials or model payloads to disk.
 */
export class TtlLruCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.entries.has(key)) this.entries.delete(key);
    const expiresAt = ttlMs === null || ttlMs === Infinity ? null : Date.now() + ttlMs;
    this.entries.set(key, { value, expiresAt });
    this.#evictIfNeeded();
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  size() {
    this.#purgeExpired();
    return this.entries.size;
  }

  #purgeExpired() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  #evictIfNeeded() {
    this.#purgeExpired();
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function credentialFingerprint(credential) {
  if (!credential) return 'none';
  const material = `${credential.type || 'unknown'}:${credential.value || ''}`;
  return sha256Hex(material).slice(0, 16);
}

export function cacheKeyParts(parts) {
  return parts.map((part) => String(part ?? '')).join('|');
}
