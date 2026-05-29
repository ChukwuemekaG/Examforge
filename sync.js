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
 *   4. For collections/queries: use TTL-based refresh (no unlimited listeners)
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

// ─── Constants ──────────────────────────────────────────────────────────────

/** @type {number} Default TTL for cached documents (5 minutes) */
const DEFAULT_DOC_TTL_MS = 5 * 60 * 1000;

/** @type {number} Default TTL for cached collections (2 minutes) */
const DEFAULT_COLLECTION_TTL_MS = 2 * 60 * 1000;

/** @type {number} Default TTL for cached queries (1 minute) */
const DEFAULT_QUERY_TTL_MS = 1 * 60 * 1000;

/** @type {number} Interval for the periodic stale-cache sweeper (5 minutes) */
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * Determines the TTL for a cache entry based on its type.
 *
 * @param {'doc'|'collection'|'query'} type
 * @returns {number} TTL in milliseconds
 */
function getTTL(type) {
  switch (type) {
    case 'doc':
      return DEFAULT_DOC_TTL_MS;
    case 'collection':
      return DEFAULT_COLLECTION_TTL_MS;
    case 'query':
      return DEFAULT_QUERY_TTL_MS;
    default:
      return DEFAULT_DOC_TTL_MS;
  }
}

/**
 * Checks whether a cache entry is still fresh (within its TTL).
 *
 * @param {object} entry - The cache entry with a `fetchedAt` property.
 * @param {number} ttlMs - Time-to-live in milliseconds.
 * @returns {boolean}
 */
function isFresh(entry, ttlMs) {
  if (!entry || !entry.fetchedAt) return false;
  return Date.now() - entry.fetchedAt < ttlMs;
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
     * Maps cacheKey → { data, fetchedAt, ttl }
     * @type {Map<string, {data: *, fetchedAt: number, ttl: number}>}
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
     * Only used for document listeners (collections use TTL refresh instead).
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

    // Start the periodic stale-cache sweeper to clean up expired entries
    this._startSweeper();
  }

  // ─── In-memory session cache ───────────────────────────────────────────────

  /**
   * Retrieves data from the in-memory cache if it hasn't expired.
   *
   * @param {string} key - The cache key.
   * @returns {*|null} The cached data, or null if missing/expired.
   */
  _getMemCache(key) {
    const entry = this._memCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > entry.ttl) {
      this._memCache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * Stores data in the in-memory cache with a bounded TTL.
   * Maximum TTL is capped at 30 seconds for memory freshness.
   *
   * @param {string} key - The cache key.
   * @param {*} data - The data to cache.
   * @param {number} [ttl] - Time-to-live in milliseconds (max 30000).
   */
  _setMemCache(key, data, ttl) {
    const memTtl = ttl ? Math.min(ttl, 30000) : 30000;
    this._memCache.set(key, { data, fetchedAt: Date.now(), ttl: memTtl });
  }

  /**
   * Removes an entry from the in-memory cache.
   *
   * @param {string} key - The cache key to clear.
   */
  _clearMemCache(key) {
    this._memCache.delete(key);
  }

  // ─── Private Internals ────────────────────────────────────────────────────

  /**
   * Starts a periodic timer that deletes stale cache entries.
   * This prevents the IndexedDB cache from growing unboundedly.
   */
  _startSweeper() {
    // Use the shortest TTL (for queries) as the sweep granularity
    this._sweeperInterval = setInterval(async () => {
      // Delete everything older than the doc TTL (the most generous ceiling)
      // since entries with shorter TTLs are already stale by then
      try {
        const deleted = await this._cache.deleteStale(DEFAULT_DOC_TTL_MS);
        if (deleted > 0) {
          // console.debug(`[SyncManager] Sweeper deleted ${deleted} stale cache entries`);
        }
      } catch (error) {
        // Silently fail — the cache is non-critical infrastructure
        console.warn('[SyncManager] Cache sweeper encountered an error:', error);
      }
    }, STALE_SWEEP_INTERVAL_MS);

    // Allow the process to exit if this is the only timer running
    if (this._sweeperInterval && this._sweeperInterval.unref) {
      this._sweeperInterval.unref();
    }
  }

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
    const cacheKey = buildCacheKey(path);
    const docRef = doc(this._db, path);
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
  }

  /**
   * Fetches a Firestore collection, caches it, and notifies subscribers.
   *
   * @param {string} path - The collection path (e.g., 'posts').
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchCollection(path) {
    const cacheKey = buildCacheKey(path);
    const colRef = collection(this._db, path);
    const snap = await getDocs(colRef);
    const data = extractData(snap);

    await this._cache.set(cacheKey, data, 'collection');
    this._notifySubscribers(cacheKey, data);
    return data;
  }

  /**
   * Fetches a Firestore query with constraints, caches it, and notifies subscribers.
   *
   * @param {string} path - The collection path.
   * @param {Array} constraints - Firestore query constraints.
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchQuery(path, constraints) {
    const cacheKey = buildCacheKey(path, constraints);
    const colRef = collection(this._db, path);
    const q = query(colRef, ...constraints);
    const snap = await getDocs(q);
    const data = extractData(snap);

    await this._cache.set(cacheKey, data, 'query');
    this._notifySubscribers(cacheKey, data);
    return data;
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
    const cacheKey = 'cg:' + collectionId + ':' + JSON.stringify(constraints);
    const colGroupRef = collectionGroup(this._db, collectionId);
    const q = query(colGroupRef, ...constraints);
    const snap = await getDocs(q);
    const data = snap.docs.map(d => ({
      id: d.id,
      _refPath: d.ref.path,
      ...d.data()
    }));

    await this._cache.set(cacheKey, data, 'query');
    this._notifySubscribers(cacheKey, data);
    return data;
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
          this._clearMemCache(cacheKey);
        } else {
          await this._cache.delete(cacheKey);
          this._clearMemCache(cacheKey);
        }
        this._notifySubscribers(cacheKey, data);
      },
      (error) => {
        console.error(`[SyncManager] onSnapshot error for "${path}":`, error);
        // If the listener fails (e.g., permission denied), clean it up
        this._listeners.delete(cacheKey);
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
   * 1. Returns cached data immediately if fresh.
   * 2. Otherwise, fetches from Firestore in the background.
   * 3. Sets up a real-time onSnapshot listener so the cache stays fresh.
   * 4. Returns the data (from cache or Firestore) via the returned Promise.
   *
   * @param {string} path - The document path (e.g., 'users/abc123').
   * @returns {Promise<object|null>} The document data, or null if it doesn't exist.
   */
  async doc(path) {
    this._validateDocPath(path);
    const cacheKey = buildCacheKey(path);

    // 1. Check in-memory cache first (instant — no I/O)
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) {
      this._setupDocListener(path);
      return memData;
    }

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && isFresh(cached, DEFAULT_DOC_TTL_MS)) {
      this._setMemCache(cacheKey, cached.data, DEFAULT_DOC_TTL_MS);
      // Set up the listener in the background if not already active
      this._setupDocListener(path);
      return cached.data;
    }

    // 3. Cache miss or stale — fetch from Firestore with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchDoc(path));
    this._setMemCache(cacheKey, data, DEFAULT_DOC_TTL_MS);

    // 4. Set up real-time listener (if not already active)
    this._setupDocListener(path);

    return data;
  }

  /**
   * Fetches a Firestore collection using a cache-first strategy.
   *
   * Collections use TTL-based refresh rather than onSnapshot to avoid
   * expensive unlimited listeners. Data is cached and returned instantly
   * on subsequent calls within the TTL window.
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

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && isFresh(cached, DEFAULT_COLLECTION_TTL_MS)) {
      this._setMemCache(cacheKey, cached.data, DEFAULT_COLLECTION_TTL_MS);
      return cached.data;
    }

    // 3. Cache miss or stale — fetch from Firestore with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchCollection(path));
    this._setMemCache(cacheKey, data, DEFAULT_COLLECTION_TTL_MS);
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
      this._clearMemCache(path);
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
   * Like collections, queries use TTL-based refresh rather than onSnapshot.
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

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && isFresh(cached, DEFAULT_QUERY_TTL_MS)) {
      this._setMemCache(cacheKey, cached.data, DEFAULT_QUERY_TTL_MS);
      return cached.data;
    }

    // 3. Cache miss or stale — fetch from Firestore with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchQuery(path, constraints));
    this._setMemCache(cacheKey, data, DEFAULT_QUERY_TTL_MS);
    return data;
  }

  /**
   * Fetches documents from a collection group using a cache-first strategy.
   *
   * Uses `collectionGroup(db, collectionId)` instead of `collection(db, path)` to
   * query across all subcollections with the given ID. Cache keys are prefixed
   * with 'cg:' to avoid collisions with regular queries.
   *
   * Like queries, collectionGroup queries use TTL-based refresh. Each unique
   * combination of collectionId + constraints produces its own cache entry.
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

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && isFresh(cached, DEFAULT_QUERY_TTL_MS)) {
      this._setMemCache(cacheKey, cached.data, DEFAULT_QUERY_TTL_MS);
      return cached.data;
    }

    // 3. Cache miss or stale — fetch from Firestore with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchCollectionGroup(collectionId, constraints));
    this._setMemCache(cacheKey, data, DEFAULT_QUERY_TTL_MS);
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
   * @param {Function} [onError] - Optional error handler called with (error).
   * @returns {Promise<void>}
   *
   * @example
   *   sync.subscribe('users/abc123', (userData) => {
   *     renderProfile(userData);
   *   });
   */
  async subscribe(path, callback, onError) {
    if (!path || typeof path !== 'string') {
      throw new Error('[SyncManager] subscribe() requires a valid path');
    }
    if (typeof callback !== 'function') {
      throw new Error('[SyncManager] subscribe() requires a callback function');
    }

    const cacheKey = buildCacheKey(path);

    // Register the callback
    if (!this._subscribers.has(cacheKey)) {
      this._subscribers.set(cacheKey, new Set());
    }
    this._subscribers.get(cacheKey).add(callback);

    // Ensure a listener exists for document paths
    const segments = path.split('/').filter(Boolean);
    if (segments.length % 2 === 0) {
      // Looks like a document path — set up listener if not already active
      try {
        this._setupDocListener(path);
      } catch (error) {
        if (onError) onError(error);
        else console.error(`[SyncManager] Error setting up listener for "${path}":`, error);
      }
    }

    // Immediately invoke the callback with cached data (if available)
    try {
      const cached = await this._cache.get(cacheKey);
      if (cached) {
        callback(cached.data);
      }
    } catch (error) {
      // Non-critical — the subscriber will get updates when data arrives
    }
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
    return this._dedupedFetch(cacheKey, () => this._fetchCollection(path));
  }

  /**
   * Destroys the SyncManager instance.
   *
   * Tears down all active onSnapshot listeners, clears the subscriber list,
   * and stops the periodic cache sweeper. Call this when the app/page is
   * shutting down to prevent memory leaks.
   */
  destroy() {
    // Stop the sweeper
    if (this._sweeperInterval) {
      clearInterval(this._sweeperInterval);
      this._sweeperInterval = null;
    }

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
