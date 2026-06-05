/**
 * EXAMFORGE — Cache-first Firestore Sync Manager
 *
 * A cache-first, Firestore-updating access layer that provides instant UI
 * by returning cached data while keeping it fresh via background fetches and
 * real-time listeners (onSnapshot) for documents.
 *
 * Architecture:
 *   1. Read from cache first → return immediately for instant UI
 *   2. On cache miss → fetch from Firestore in background → cache it → return
 *   3. For documents: set up onSnapshot listener to keep cache perpetually fresh
 *   4. Collections/queries use the same cache-first strategy — IndexedDB is the
 *      persistent source of truth (never expires). Data stays fresh via onSnapshot
 *      listeners (documents) or cache warming (collections).
 *   5. Deduplicate concurrent requests for the same path
 *   6. Notify subscribers when data changes
 *
 * Usage:
 *   import { db } from './firebase-config.js';
 *   import { SyncManager } from './sync.js';
 *
 *   const sync = new SyncManager(db);
 *   const user = await sync.doc('users/abc123');
 *   const posts = await sync.collection('posts');
 *   const results = await sync.query('users/abc123/results', [
 *     where('score', '>=', 50),
 *     orderBy('timestamp', 'desc'),
 *     limit(20)
 *   ]);
 *
 *   // Subscribe to changes
 *   sync.subscribe('users/abc123', (data) => { console.log('Updated:', data); });
 *
 *   // Clean up
 *   sync.unsubscribe('users/abc123');
 *   sync.destroy();
 */

import { LocalCache } from './cache.js';

import {
  doc,
  getDoc,
  getDocs,
  collection,
  collectionGroup,
  query,
  onSnapshot,
  where,
  orderBy,
  limit,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

// ─── Global read counter ────────────────────────────────────────────────────

/**
 * Global read counter function for direct Firestore reads.
 * Tracks ALL Firestore reads (including sync.js internal ones) against a shared budget.
 * Returns true if budget is exhausted, false if OK to read.
 */
window.__efTrackRead = function(path) {
    if (typeof window.__efReads === 'undefined') window.__efReads = 0;
    if (typeof window.__efReadBudget === 'undefined') window.__efReadBudget = 10;

    if (window.__efReads >= window.__efReadBudget) {
        console.warn(`[Firestore] Budget exhausted (${window.__efReads}/${window.__efReadBudget}). Blocked: ${path}`);
        return true;
    }
    window.__efReads++;
    console.log(`[Firestore] Read ${window.__efReads}/${window.__efReadBudget}: ${path}`);
    return false;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** @type {number} Default TTL for cached documents (5 minutes) */
const DEFAULT_DOC_TTL_MS = 5 * 60 * 1000;

/** @type {number} Default TTL for cached collections (2 minutes) */
const DEFAULT_COLLECTION_TTL_MS = 2 * 60 * 1000;

/** @type {number} Default TTL for cached queries (1 minute) */
const DEFAULT_QUERY_TTL_MS = 1 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a consistent cache key from a Firestore path and optional constraints.
 *
 * For queries, we serialise the constraints into the key so that different
 * filters produce distinct cache entries.
 *
 * @param {string} path - The Firestore path
 * @param {Array} [constraints=[]] - Query constraints (where, orderBy, limit)
 * @returns {string} A unique cache key
 */
function buildCacheKey(path, constraints = []) {
  if (!constraints || constraints.length === 0) return path;
  // Serialise constraints into a deterministic suffix
  const serialised = constraints
    .map((c) => {
      if (c && typeof c === 'object' && c._firestoreQueryConstraint) {
        // Firestore constraint objects have internal representation;
        // we convert them to a simple descriptor.
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      }
      return String(c);
    })
    .join('::');
  return `${path}?q=${encodeURIComponent(serialised)}`;
}

/**
 * Resolves the Firestore data from a snapshot, handling both documents and
 * collection/query result sets.
 *
 * @param {import('firebase/firestore').DocumentSnapshot|import('firebase/firestore').QuerySnapshot} snap
 * @returns {object|null}
 */
function extractData(snap) {
  if (typeof snap.data === 'function') {
    // Document snapshot
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }
  // Query/collection snapshot — return array of docs
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ─── SyncManager ────────────────────────────────────────────────────────────

export class SyncManager {
  /**
   * @param {import('firebase/firestore').Firestore} db - The Firestore database instance.
   */
  constructor(db) {
    if (!db) {
      throw new Error('[SyncManager] A Firestore database instance (db) is required.');
    }

    /** @type {import('firebase/firestore').Firestore} */
    this._db = db;

    /** @type {LocalCache} */
    this._cache = new LocalCache();

    /**
     * In-memory session cache (instant — no I/O).
     * Maps cacheKey → { data, fetchedAt }
     * @type {Map<string, {data: *, fetchedAt: number}>}
     */
    this._memCache = new Map();

    /**
     * In-flight request deduplication map.
     * Maps cacheKey → Promise, so concurrent calls for the same path share one fetch.
     * @type {Map<string, Promise<any>>}
     */
    this._pending = new Map();

    /**
     * Active onSnapshot unsubscribers.
     * Maps cacheKey → unsubscribe function.
     * Only used for document listeners (collections use liveCollection instead).
     * @type {Map<string, Function>}
     */
    this._listeners = new Map();

    /**
     * Active collection onSnapshot unsubscribers.
     * Maps path → unsubscribe function.
     * Set up by liveCollection().
     * @type {Map<string, Function>}
     */
    this._collectionListeners = new Map();

    /**
     * Subscriber callbacks for change notifications.
     * Maps cacheKey → Set<callback>
     * @type {Map<string, Set<Function>>}
     */
    this._subscribers = new Map();

    /**
     * Periodic stale-cache sweeper interval ID.
     * @type {number|null}
     */
    this._sweeperInterval = null;

    // (Sweeper removed — IndexedDB is now the persistent source of truth)
  }

  // ─── In-memory session cache ───────────────────────────────────────────────

  /**
   * Retrieves data from the in-memory cache.
   * In-memory cache never expires — data persists for the session lifetime.
   *
   * @param {string} key - The cache key.
   * @returns {*|null} The cached data, or null if missing.
   */
  _getMemCache(key) {
    const entry = this._memCache.get(key);
    return entry ? entry.data : null;
  }

  /**
   * Stores data in the in-memory cache.
   * Data persists for the session lifetime — never expires.
   *
   * @param {string} key - The cache key.
   * @param {*} data - The data to cache.
   */
  _setMemCache(key, data) {
    this._memCache.set(key, { data, fetchedAt: Date.now() });
  }

  /**
   * Removes an entry from the in-memory cache.
   *
   * @param {string} key - The cache key to clear.
   */
  _clearMemCache(key) {
    this._memCache.delete(key);
  }

  /**
   * Clears all IndexedDB cache entries whose path starts with a given base path
   * followed by '?', i.e. related query caches like 'mock_exams?q=...'.
   *
   * This is called by refresh() to ensure query caches are invalidated when
   * the underlying collection is refreshed.
   *
   * @param {string} path - The base Firestore path (e.g. 'mock_exams').
   * @returns {Promise<void>}
   */
  async _clearRelatedQueryCaches(path) {
    const allEntries = await this._cache.entries();
    const prefix = path + '?';
    for (const entry of allEntries) {
      if (entry.path && entry.path.startsWith(prefix)) {
        await this._cache.delete(entry.path);
      }
    }
  }

  /**
   * Checks whether the global read budget has been exhausted.
   * Uses the shared window.__efReads / window.__efReadBudget counters.
   *
   * @param {string} path - The Firestore path (used for the error message / log).
   * @returns {boolean} true if budget is exhausted, false if OK to read.
   */
  _checkReadBudget(path) {
    if (typeof window.__efReads === 'undefined') window.__efReads = 0;
    if (typeof window.__efReadBudget === 'undefined') window.__efReadBudget = 10;

    if (window.__efReads >= window.__efReadBudget) {
      console.warn(`[Sync] Read budget exhausted (${window.__efReads}/${window.__efReadBudget}). Cannot fetch "${path}".`);
      return true;
    }
    window.__efReads++;
    console.log(`[Sync] Read ${window.__efReads}/${window.__efReadBudget}: "${path}"`);
    return false;
  }

  // ─── Private Internals ────────────────────────────────────────────────────

  // (Sweeper removed — IndexedDB is now the persistent source of truth)

  /**
   * Notifies all subscribers for a given cache key with the latest data.
   *
   * @param {string} cacheKey
   * @param {*} data
   */
  _notifySubscribers(cacheKey, data) {
    const subs = this._subscribers.get(cacheKey);
    if (subs && subs.size > 0) {
      subs.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[SyncManager] Subscriber error for "${cacheKey}":`, error);
        }
      });
    }
  }

  /**
   * Fetches a Firestore document, caches it, and notifies subscribers.
   *
   * @param {string} path - The document path (e.g., 'users/abc123').
   * @returns {Promise<object|null>} The document data, or null if it doesn't exist.
   */
  async _fetchDoc(path) {
    // Check read budget before making a Firestore call
    if (this._checkReadBudget(path)) {
      // Budget exhausted — try IndexedDB cache as fallback
      const cached = await this._cache.get(buildCacheKey(path));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path);
    const docRef = doc(this._db, path);
    try {
      const snap = await getDoc(docRef);
      const data = extractData(snap);

      if (data) {
        await this._cache.set(cacheKey, data, 'doc');
      } else {
        // Document was deleted — remove from cache
        await this._cache.delete(cacheKey);
      }

      this._notifySubscribers(cacheKey, data);
      return data;
    } catch (e) {
      if (e.code === 'unavailable' || e.code === 'not-found' || e.message?.includes('offline')) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Fetches a Firestore collection, caches it, and notifies subscribers.
   *
   * @param {string} path - The collection path (e.g., 'posts').
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchCollection(path) {
    // Check read budget before making a Firestore call
    if (this._checkReadBudget(path)) {
      const cached = await this._cache.get(buildCacheKey(path));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path);
    const colRef = collection(this._db, path);
    try {
      const snap = await getDocs(colRef);
      const data = extractData(snap);

      await this._cache.set(cacheKey, data, 'collection');
      this._notifySubscribers(cacheKey, data);
      return data;
    } catch (e) {
      if (e.code === 'unavailable' || e.message?.includes('offline')) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Fetches a Firestore query with constraints, caches it, and notifies subscribers.
   *
   * @param {string} path - The collection path.
   * @param {Array} constraints - Firestore query constraints.
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchQuery(path, constraints) {
    // Check read budget before making a Firestore call
    if (this._checkReadBudget(path)) {
      const cached = await this._cache.get(buildCacheKey(path, constraints));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path, constraints);
    const colRef = collection(this._db, path);
    const q = query(colRef, ...constraints);
    try {
      const snap = await getDocs(q);
      const data = extractData(snap);

      await this._cache.set(cacheKey, data, 'query');
      this._notifySubscribers(cacheKey, data);
      return data;
    } catch (e) {
      if (e.code === 'unavailable' || e.message?.includes('offline')) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Fetches a Firestore collectionGroup query, caches it, and notifies subscribers.
   *
   * Uses collectionGroup(db, collectionId) instead of collection(db, path) to query
   * across all subcollections with the given ID. Each result includes a `_refPath`
   * metadata field so callers can determine the parent document path.
   *
   * @param {string} collectionId - The collection ID to search across all subcollections.
   * @param {Array} constraints - Firestore query constraints.
   * @returns {Promise<Array<object>>} Array of document data with `_refPath` metadata.
   */
  async _fetchCollectionGroup(collectionId, constraints) {
    // Check read budget before making a Firestore call
    if (this._checkReadBudget('cg:' + collectionId)) {
      const cacheKey = 'cg:' + collectionId + ':' + JSON.stringify(constraints);
      const cached = await this._cache.get(cacheKey);
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "cg:${collectionId}"`);
    }

    const cacheKey = 'cg:' + collectionId + ':' + JSON.stringify(constraints);
    const colGroupRef = collectionGroup(this._db, collectionId);
    const q = query(colGroupRef, ...constraints);
    try {
      const snap = await getDocs(q);
      const data = snap.docs.map(d => ({
        id: d.id,
        _refPath: d.ref.path,
        ...d.data()
      }));

      await this._cache.set(cacheKey, data, 'query');
      this._notifySubscribers(cacheKey, data);
      return data;
    } catch (e) {
      if (e.code === 'unavailable' || e.message?.includes('offline')) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Generic fetch with deduplication.
   * If a fetch for the same cache key is already in-flight, returns its promise.
   *
   * @param {string} cacheKey
   * @param {Function} fetcher - An async function that performs the actual fetch.
   * @returns {Promise<any>}
   */
  async _dedupedFetch(cacheKey, fetcher) {
    // If there's already a pending request for this key, return it
    if (this._pending.has(cacheKey)) {
      return this._pending.get(cacheKey);
    }

    const promise = fetcher().finally(() => {
      // Clean up the pending entry only if it's still ours
      if (this._pending.get(cacheKey) === promise) {
        this._pending.delete(cacheKey);
      }
    });

    this._pending.set(cacheKey, promise);
    return promise;
  }

  /**
   * Sets up an onSnapshot listener for a Firestore document.
   * The listener updates the cache and notifies subscribers on every change.
   *
   * @param {string} path - The document path.
   */
  _setupDocListener(path) {
    const cacheKey = buildCacheKey(path);

    // Don't set up duplicate listeners
    if (this._listeners.has(cacheKey)) return;

    const docRef = doc(this._db, path);

    const unsubscribe = onSnapshot(
      docRef,
      async (snap) => {
        const data = extractData(snap);
        if (data) {
          await this._cache.set(cacheKey, data, 'doc');
          this._setMemCache(cacheKey, data);
        } else {
          await this._cache.delete(cacheKey);
          this._clearMemCache(cacheKey);
        }
        this._notifySubscribers(cacheKey, data);
      },
      (error) => {
        console.error(`[SyncManager] onSnapshot error for "${path}":`, error);
        // Firestore SDK auto-reconnects on transient errors; keep listener
        if (error.code !== 'unavailable') {
          this._listeners.delete(cacheKey);
        }
      }
    );

    this._listeners.set(cacheKey, unsubscribe);
  }

  /**
   * Logs a warning if a document path (not collection) pattern is unexpected.
   *
   * @param {string} path
   * @returns {boolean} Whether the path looks valid.
   */
  _validateDocPath(path) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid document path: "${path}"`);
    }
    // A document path should have an odd number of segments (collection/doc/collection/doc…)
    const segments = path.split('/').filter(Boolean);
    if (segments.length % 2 !== 0) {
      throw new Error(
        `[SyncManager] Invalid document path: "${path}" — expected an even number of segments (collection/doc pattern)`
      );
    }
    return true;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Fetches a Firestore document using a cache-first strategy.
   *
   * 1. Returns cached data immediately if available (in-memory first, then IndexedDB).
   * 2. Otherwise, fetches from Firestore in the background.
   * 3. Returns the data (from cache or Firestore) via the returned Promise.
   *
   * NOTE: This method does NOT set up real-time listeners. If you need live
   * updates, use `subscribe()` instead.
   *
   * @param {string} path - The document path (e.g., 'users/abc123').
   * @returns {Promise<object|null>} The document data, or null if it doesn't exist.
   */
  async doc(path) {
    this._validateDocPath(path);
    const cacheKey = buildCacheKey(path);

    // 1. Check in-memory cache first (instant — no I/O)
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache (always use if exists — no TTL)
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Firestore with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchDoc(path));
    this._setMemCache(cacheKey, data);

    return data;
  }

  /**
   * Fetches a Firestore collection using a cache-first strategy.
   *
   * Collections use the same cache-first approach as documents.
   * IndexedDB is the persistent source of truth — cached data never expires.
   * Data is cached and returned instantly on subsequent calls.
   *
   * @param {string} path - The collection path (e.g., 'posts').
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async collection(path) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid collection path: "${path}"`);
    }
    const cacheKey = buildCacheKey(path);

    // 1. Check in-memory cache first (instant)
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache (always use if exists — no TTL)
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Firestore
    const data = await this._dedupedFetch(cacheKey, () => this._fetchCollection(path));
    this._setMemCache(cacheKey, data);
    return data;
  }

  /**
   * Shorthand for `collection()` — same behaviour.
   *
   * @param {string} path - The collection path.
   * @returns {Promise<Array<object>>}
   */
  async docs(path) {
    return this.collection(path);
  }

  /**
   * Pre-loads data for multiple Firestore paths at session start.
   *
   * Iterates over the given paths, calling `doc()` for each one. This populates
   * both the IndexedDB cache and the in-memory cache so that subsequent reads
   * are served instantly without hitting Firestore.
   *
   * Failed preloads (e.g. due to read budget exhaustion or network errors) are
   * logged as warnings and do NOT halt preloading of remaining paths.
   *
   * @param {string[]} paths - Array of Firestore document paths to pre-load.
   * @returns {Promise<Object<string, *>>} A map of path → loaded data (null for failures).
   *
   * @example
   *   const data = await sync.preload([
   *     'users/abc123',
   *     'settings/app',
   *     'courses/xyz789'
   *   ]);
   *   console.log(data['users/abc123']);
   */
  async preload(paths) {
    if (!Array.isArray(paths)) {
      throw new Error('[SyncManager] preload() requires an array of paths');
    }
    const results = {};
    for (const path of paths) {
      try {
        results[path] = await this.doc(path);
      } catch (e) {
        console.warn(`[Sync] Preload failed for "${path}":`, e.message);
        results[path] = null;
      }
    }
    return results;
  }

  /**
   * Returns the number of Firestore reads used so far in this session.
   *
   * @returns {number} The number of reads consumed.
   */
  getReadsUsed() {
    return typeof window.__efReads === 'undefined' ? 0 : window.__efReads;
  }

  /**
   * Returns the total read budget allocated for this session.
   *
   * @returns {number} The maximum number of Firestore reads allowed.
   */
  getReadBudget() {
    return typeof window.__efReadBudget === 'undefined' ? 10 : window.__efReadBudget;
  }

  /**
   * Resets the read budget counter back to zero.
   *
   * Call this to allow additional Firestore reads beyond the original budget.
   * Useful after a session refresh or when the user explicitly requests a sync.
   */
  resetBudget() {
    window.__efReads = 0;
    const budget = typeof window.__efReadBudget === 'undefined' ? 10 : window.__efReadBudget;
    console.log(`[Sync] Read budget reset. New budget: ${budget} reads available.`);
  }

  /**
   * Fetches a Firestore collection with a real-time onSnapshot listener.
   *
   * Returns cached data immediately if available, then sets up an onSnapshot
   * listener that updates the cache and fires the onChange callback on every
   * snapshot change.
   *
   * @param {string} path - The collection path (e.g., 'unicourses').
   * @param {Function} [onChange] - Optional callback fired with updated data on every snapshot.
   * @returns {Promise<Array<object>>} Array of document data.
   *
   * @example
   *   const courses = await sync.liveCollection('unicourses', (data) => {
   *     console.log('Courses updated:', data);
   *   });
   */
  async liveCollection(path, onChange) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid collection path: "${path}"`);
    }

    // Return cached data immediately
    const cached = await this._cache.get(path);
    if (cached) {
      // Set up the listener in the background
      this._setupCollectionListener(path, onChange);
      return cached.data;
    }

    // Fetch from Firestore
    const data = await this._fetchCollection(path);

    // Set up listener
    this._setupCollectionListener(path, onChange);

    return data;
  }

  /**
   * Sets up an onSnapshot listener for a collection path.
   * The listener updates the cache and fires the onChange callback on every change.
   * Prevents duplicate listeners for the same path.
   *
   * @param {string} path - The collection path.
   * @param {Function} [onChange] - Optional callback fired with updated data.
   */
  _setupCollectionListener(path, onChange) {
    if (this._collectionListeners.has(path)) return;

    const parts = path.split('/').filter(Boolean);
    const colRef = collection(this._db, ...parts);

    const unsubscribe = onSnapshot(colRef, async (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      await this._cache.set(path, data, 'collection');
      this._setMemCache(path, data);
      this._notifySubscribers(path, data);
      if (onChange) onChange(data);
    }, (error) => {
      console.error(`[SyncManager] onSnapshot error for collection "${path}":`, error);
      this._collectionListeners.delete(path);
    });

    this._collectionListeners.set(path, unsubscribe);
  }

  /**
   * Fetches a Firestore query with constraints using a cache-first strategy.
   *
   * Like collections, queries use the same cache-first approach.
   * IndexedDB is the persistent source of truth — cached data never expires.
   * Each unique set of constraints produces its own cache entry.
   *
   * @param {string} path - The collection path to query.
   * @param {Array} constraints - Firestore query constraints (where, orderBy, limit, etc.).
   * @returns {Promise<Array<object>>} Array of document data.
   *
   * @example
   *   const results = await sync.query('users/uid/results', [
   *     where('score', '>=', 50),
   *     orderBy('timestamp', 'desc'),
   *     limit(20)
   *   ]);
   */
  async query(path, constraints = []) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid query path: "${path}"`);
    }
    if (!Array.isArray(constraints)) {
      throw new Error('[SyncManager] Query constraints must be an array');
    }
    const cacheKey = buildCacheKey(path, constraints);

    // 1. Check in-memory cache first (instant)
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache (always use if exists — no TTL)
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Firestore
    const data = await this._dedupedFetch(cacheKey, () => this._fetchQuery(path, constraints));
    this._setMemCache(cacheKey, data);
    return data;
  }

  /**
   * Fetches documents from a collection group using a cache-first strategy.
   *
   * Uses `collectionGroup(db, collectionId)` instead of `collection(db, path)` to
   * query across all subcollections with the given ID. Cache keys are prefixed
   * with 'cg:' to avoid collisions with regular queries.
   *
   * Like other queries, collectionGroup queries use the same cache-first approach.
   * IndexedDB is the persistent source of truth — cached data never expires.
   * Each unique combination of collectionId + constraints produces its own cache entry.
   * Deduplication ensures concurrent requests for the same parameters share
   * one Firestore fetch.
   *
   * Each returned document includes a `_refPath` metadata field containing the
   * full Firestore document path (e.g., "users/abc123/results/def456"), which
   * allows callers to determine the parent document or collection.
   *
   * @param {string} collectionId - The collection group ID (e.g., 'results').
   * @param {Array} [constraints=[]] - Firestore query constraints (where, orderBy, limit, etc.).
   * @returns {Promise<Array<object>>} Array of document data, each with `_refPath`.
   *
   * @example
   *   const results = await sync.collectionGroup('results', [
   *     where('quizId', '==', quizId)
   *   ]);
   *   results.forEach(r => {
   *     const uid = r._refPath.split('/')[1];
   *     console.log(r.id, uid, r.score);
   *   });
   */
  async collectionGroup(collectionId, constraints = []) {
    if (!collectionId || typeof collectionId !== 'string') {
      throw new Error(`[SyncManager] Invalid collectionGroup ID: "${collectionId}"`);
    }
    if (!Array.isArray(constraints)) {
      throw new Error('[SyncManager] Query constraints must be an array');
    }
    const cacheKey = 'cg:' + collectionId + ':' + JSON.stringify(constraints);

    // 1. Check in-memory cache first (instant)
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache (always use if exists — no TTL)
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Firestore
    const data = await this._dedupedFetch(cacheKey, () => this._fetchCollectionGroup(collectionId, constraints));
    this._setMemCache(cacheKey, data);
    return data;
  }

  /**
   * Subscribes to data changes for a given path.
   *
   * When the cached data is updated (via background fetch or onSnapshot),
   * the callback will be invoked with the latest data.
   *
   * @param {string} path - The Firestore path to subscribe to.
   * @param {Function} callback - Called with (data) on every change.
   * @returns {Promise<void>}
   *
   * @example
   *   sync.subscribe('users/abc123', (userData) => {
   *     renderProfile(userData);
   *   });
   */
  async subscribe(path, callback) {
    if (!path || typeof path !== 'string') {
      throw new Error('[SyncManager] subscribe() requires a valid path');
    }
    if (typeof callback !== 'function') {
      throw new Error('[SyncManager] subscribe() requires a callback function');
    }

    const cacheKey = buildCacheKey(path);

    // Immediately invoke the callback with cached data (if available)
    try {
      const cached = await this._cache.get(cacheKey);
      if (cached) {
        callback(cached.data);
      }
    } catch (error) {
      // Non-critical
    }

    // Set up real-time tracking for documents and collections.
    const segments = path.split('/').filter(Boolean);
    if (segments.length % 2 === 0) {
      this._setupDocListener(path);
    } else {
      this._setupCollectionListener(path, callback);
    }

    // Register the callback for future updates.
    if (!this._subscribers.has(cacheKey)) {
      this._subscribers.set(cacheKey, new Set());
    }
    this._subscribers.get(cacheKey).add(callback);
  }

  /**
   * Unsubscribes a callback from change notifications for a given path.
   *
   * If no callbacks remain for that path, the onSnapshot listener (if any)
   * is NOT automatically torn down — it stays active to keep the cache fresh.
   * Call `unsubscribe(path)` without a callback to remove ALL subscribers
   * and tear down the listener.
   *
   * @param {string} path - The Firestore path.
   * @param {Function} [callback] - Optional specific callback to remove.
   *   If omitted, ALL subscribers for this path are removed AND the listener
   *   is torn down.
   */
  unsubscribe(path, callback) {
    if (!path || typeof path !== 'string') {
      throw new Error('[SyncManager] unsubscribe() requires a valid path');
    }

    const cacheKey = buildCacheKey(path);
    const subs = this._subscribers.get(cacheKey);

    if (!subs) return;

    if (callback) {
      // Remove only the specified callback
      subs.delete(callback);
      if (subs.size === 0) {
        this._subscribers.delete(cacheKey);
      }
    } else {
      // Remove all subscribers and tear down the listener
      this._subscribers.delete(cacheKey);

      const unsubscribe = this._listeners.get(cacheKey);
      if (unsubscribe) {
        unsubscribe();
        this._listeners.delete(cacheKey);
      }
    }
  }

  /**
   * Forces a refresh of the cached data for a given path, bypassing the cache.
   *
   * Fetches the latest data from Firestore, updates the cache, and notifies
   * subscribers. Works for documents, collections, and queries.
   *
   * @param {string} path - The Firestore path to refresh.
   * @param {Array} [constraints] - Optional query constraints (only needed for query-type paths).
   * @returns {Promise<object|Array<object>|null>} The refreshed data.
   */
  async refresh(path, constraints = []) {
    if (!path || typeof path !== 'string') {
      throw new Error('[SyncManager] refresh() requires a valid path');
    }

    const segments = path.split('/').filter(Boolean);

    if (constraints && constraints.length > 0) {
      // Query refresh
      this._clearMemCache(buildCacheKey(path, constraints));
      return this._dedupedFetch(buildCacheKey(path, constraints), () =>
        this._fetchQuery(path, constraints)
      );
    }

    if (segments.length % 2 === 0) {
      // Document path
      const cacheKey = buildCacheKey(path);
      this._clearMemCache(cacheKey);
      return this._dedupedFetch(cacheKey, () => this._fetchDoc(path));
    }

    // Collection path
    const cacheKey = buildCacheKey(path);
    this._clearMemCache(cacheKey);

    // Clear any related query caches from mem cache (e.g. 'mock_exams?q=...')
    for (const key of this._memCache.keys()) {
      if (key.startsWith(path + '?')) this._memCache.delete(key);
    }

    // Also clear related query caches from IndexedDB
    this._clearRelatedQueryCaches(path).catch(err =>
      console.warn('[SyncManager] Error clearing related query caches:', err)
    );

    return this._dedupedFetch(cacheKey, () => this._fetchCollection(path));
  }

  /**
   * Destroys the SyncManager instance.
   *
   * Tears down all active onSnapshot listeners and clears the subscriber list.
   * Call this when the app/page is shutting down to prevent memory leaks.
   */
  destroy() {
    // Tear down all active listeners
    this._listeners.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn('[SyncManager] Error tearing down listener:', error);
      }
    });
    this._listeners.clear();

    // Tear down all active collection listeners
    this._collectionListeners.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn('[SyncManager] Error tearing down collection listener:', error);
      }
    });
    this._collectionListeners.clear();

    // Clear all subscribers
    this._subscribers.clear();

    // Reject any pending requests? No — they're user-facing Promises that
    // should still resolve. We just stop listening for future updates.
  }
}
