/**
 * EXAMFORGE — IndexedDB Local Cache
 *
 * A zero-dependency ES module that wraps IndexedDB with a clean Promise-based API.
 * Designed for caching Firestore data (documents, collections, queries) locally
 * with automatic cache invalidation via TTL (time-to-live).
 *
 * Database schema:
 *   DB name:    'examforge-cache'
 *   Version:    1
 *   Store:      'cache'  (auto-incremented, keyPath: 'path')
 *   Indexes:    'type' (doc|collection|query), 'fetchedAt' (timestamp)
 *
 * Usage:
 *   import { LocalCache } from './cache.js';
 *   const cache = new LocalCache();
 *   await cache.set('users/abc123', { name: 'John' }, 'doc');
 *   const entry = await cache.get('users/abc123');
 *   // → { path: 'users/abc123', data: {...}, type: 'doc', fetchedAt: 1234567890 }
 */

const DB_NAME = 'examforge-cache';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

/**
 * Opens (or creates) the IndexedDB connection.
 * Handles version upgrades gracefully — when the schema changes, the old
 * database is deleted and recreated without throwing.
 *
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // If the store already exists (e.g., from a previous version), delete it
      // so we can rebuild with the correct schema. This is the safest approach
      // for a local cache where persistence across schema changes isn't critical.
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }

      // Create the object store with 'path' as the key path
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });

      // Index for filtering by cache entry type (doc, collection, query)
      store.createIndex('type', 'type', { unique: false });

      // Index for TTL-based cache invalidation (sorted by fetch time ascending)
      store.createIndex('fetchedAt', 'fetchedAt', { unique: false });
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error('[LocalCache] Failed to open database:', event.target.error);
      reject(event.target.error);
    };

    // Handle the case where the browser blocks the upgrade (e.g., in private
    // browsing on some browsers). We reject so callers can fall back gracefully.
    request.onblocked = (event) => {
      console.warn('[LocalCache] Database upgrade blocked — another tab may still be using it.');
      // If the old database exists, we can still try to use it. But for consistency,
      // we reject and let the caller decide how to handle it.
      reject(new Error('Database upgrade blocked'));
    };
  });
}

/**
 * Performs a read operation on the cache store.
 *
 * @param {string} mode - 'readonly' or 'readwrite'
 * @param {function(IDBObjectStore): IDBRequest} operation
 * @returns {Promise<any>}
 */
async function withStore(mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = operation(store);

    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = (event) => {
      db.close();
      console.error('[LocalCache] Transaction error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Performs a readwrite operation that may not return a direct result (e.g., put, delete).
 *
 * @param {function(IDBObjectStore): IDBRequest} operation
 * @returns {Promise<void>}
 */
async function withWrite(operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    operation(store);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = (event) => {
      db.close();
      console.error('[LocalCache] Write error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * LocalCache — a Promise-based IndexedDB wrapper for local data caching.
 *
 * All methods return Promises and should be awaited.
 * The cache stores entries keyed by their Firestore path.
 */
export class LocalCache {
  /**
   * Opens the database connection. No configuration needed.
   */
  constructor() {
    // Database connection is opened lazily on each operation.
    // This avoids blocking the constructor and allows the caller to
    // create the cache instance without worrying about async setup.
  }

  /**
   * Retrieves a cache entry by its path.
   *
   * @param {string} path - The Firestore document/collection path.
   * @returns {Promise<object|null>} The cache entry, or null if not found.
   *   Entry shape: { path: string, data: any, type: string, fetchedAt: number }
   */
  async get(path) {
    if (!path || typeof path !== 'string') {
      throw new Error('[LocalCache] get() requires a valid string path');
    }
    try {
      const result = await withStore('readonly', (store) => store.get(path));
      return result || null;
    } catch (error) {
      console.error(`[LocalCache] Error getting "${path}":`, error);
      return null;
    }
  }

  /**
   * Stores a value in the cache.
   *
   * @param {string} path - The Firestore path to use as the key.
   * @param {*} data - The data to cache (any JSON-serializable value).
   * @param {string} type - The entry type: 'doc', 'collection', or 'query'.
   * @returns {Promise<void>}
   */
  async set(path, data, type) {
    if (!path || typeof path !== 'string') {
      throw new Error('[LocalCache] set() requires a valid string path');
    }
    if (!type || !['doc', 'collection', 'query'].includes(type)) {
      throw new Error('[LocalCache] set() requires type: "doc", "collection", or "query"');
    }

    const entry = {
      path,
      data,
      type,
      fetchedAt: Date.now(),
    };

    try {
      await withWrite((store) => store.put(entry));
    } catch (error) {
      console.error(`[LocalCache] Error setting "${path}":`, error);
    }
  }

  /**
   * Deletes a single cache entry by path.
   *
   * @param {string} path - The Firestore path to delete.
   * @returns {Promise<void>}
   */
  async delete(path) {
    if (!path || typeof path !== 'string') {
      throw new Error('[LocalCache] delete() requires a valid string path');
    }
    try {
      await withWrite((store) => store.delete(path));
    } catch (error) {
      console.error(`[LocalCache] Error deleting "${path}":`, error);
    }
  }

  /**
   * Clears ALL entries from the cache.
   *
   * @returns {Promise<void>}
   */
  async clear() {
    try {
      await withWrite((store) => store.clear());
    } catch (error) {
      console.error('[LocalCache] Error clearing cache:', error);
    }
  }

  /**
   * Retrieves all cache entries of a given type.
   *
   * @param {string} type - The type to filter by: 'doc', 'collection', or 'query'.
   * @returns {Promise<Array<object>>} Array of matching cache entries.
   */
  async getAllByType(type) {
    if (!type || typeof type !== 'string') {
      throw new Error('[LocalCache] getAllByType() requires a valid type string');
    }
    try {
      const results = await withStore('readonly', (store) => {
        const index = store.index('type');
        return index.getAll(IDBKeyRange.only(type));
      });
      return results || [];
    } catch (error) {
      console.error(`[LocalCache] Error getting all by type "${type}":`, error);
      return [];
    }
  }

  /**
   * Returns all entries that are older than the given age in milliseconds.
   * Useful for manual cache invalidation or displaying stale indicators.
   *
   * @param {number} maxAgeMs - Maximum age in milliseconds before an entry is considered stale.
   * @returns {Promise<Array<object>>} Array of stale cache entries.
   */
  async getStale(maxAgeMs) {
    if (typeof maxAgeMs !== 'number' || maxAgeMs < 0) {
      throw new Error('[LocalCache] getStale() requires a non-negative number (maxAgeMs)');
    }
    const cutoff = Date.now() - maxAgeMs;
    try {
      const results = await withStore('readonly', (store) => {
        const index = store.index('fetchedAt');
        // Entries fetched BEFORE the cutoff are stale
        return index.getAll(IDBKeyRange.upperBound(cutoff, false));
      });
      return results || [];
    } catch (error) {
      console.error('[LocalCache] Error getting stale entries:', error);
      return [];
    }
  }

  /**
   * Deletes all entries older than the given age in milliseconds.
   * Returns a count of deleted entries.
   *
   * @param {number} maxAgeMs - Maximum age in milliseconds before an entry is considered stale.
   * @returns {Promise<number>} Number of entries deleted.
   */
  async deleteStale(maxAgeMs) {
    if (typeof maxAgeMs !== 'number' || maxAgeMs < 0) {
      throw new Error('[LocalCache] deleteStale() requires a non-negative number (maxAgeMs)');
    }
    const staleEntries = await this.getStale(maxAgeMs);
    if (staleEntries.length === 0) return 0;

    // Batch delete in a single transaction
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let deleted = 0;

      staleEntries.forEach((entry) => {
        const req = store.delete(entry.path);
        req.onsuccess = () => { deleted++; };
      });

      tx.oncomplete = () => {
        db.close();
        resolve(deleted);
      };
      tx.onerror = (event) => {
        db.close();
        reject(event.target.error);
      };
    });
  }

  /**
   * Checks whether a cache entry exists for the given path.
   *
   * @param {string} path - The Firestore path to check.
   * @returns {Promise<boolean>}
   */
  async has(path) {
    if (!path || typeof path !== 'string') {
      throw new Error('[LocalCache] has() requires a valid string path');
    }
    try {
      const entry = await this.get(path);
      return entry !== null;
    } catch {
      return false;
    }
  }

  /**
   * Returns an array of all cache entries (path + data + type + fetchedAt).
   *
   * @returns {Promise<Array<object>>} Full cache contents.
   */
  async entries() {
    try {
      const results = await withStore('readonly', (store) => store.getAll());
      return results || [];
    } catch (error) {
      console.error('[LocalCache] Error getting all entries:', error);
      return [];
    }
  }
}
