/**
 * EXAMFORGE — Turso-based Sync Manager
 *
 * A cache-first, Turso-updating access layer that provides instant UI
 * by returning cached data while keeping it fresh via background fetches.
 * Uses IndexedDB (LocalCache) for persistent caching and polling for
 * live updates (since Turso doesn't have real-time listeners).
 *
 * Architecture:
 *   1. Read from memory cache first → return immediately for instant UI
 *   2. On miss → check IndexedDB cache
 *   3. On miss → fetch from Turso → cache it → return
 *   4. Subscribe uses polling at configurable intervals
 *   5. Deduplicate concurrent requests for the same path
 *
 * Usage:
 *   import { SyncManager } from './sync.js';
 *
 *   const sync = new SyncManager();
 *   const user = await sync.doc('users/abc123');
 *   const posts = await sync.collection('posts');
 *   const results = await sync.query('users', [{ field: 'role', op: '=', value: 'student' }]);
 *
 *   // Subscribe to changes (polling-based)
 *   sync.subscribe('users/abc123', (data) => { console.log('Updated:', data); });
 *
 *   // Clean up
 *   sync.unsubscribe('users/abc123');
 *   sync.destroy();
 */

import { execOne, exec, execute, trackRead } from './src/db/client.js';
import { LocalCache } from './cache.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** @type {number} Default polling interval for subscribe (30 seconds) */
const DEFAULT_POLL_MS = 30 * 1000;

/** @type {number} Default polling interval for liveCollection (15 seconds) */
const DEFAULT_COLLECTION_POLL_MS = 15 * 1000;

/** @type {Object<string, string>} Map Firestore-style path prefixes to actual Turso table names */
const TABLE_MAP = {
  '_notifications': 'broadcast_notifications',
  '_schedules': 'broadcast_schedules',
  '_admin_panel': 'admin_panel',
  '_stats': 'counters'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a consistent cache key from a path and optional constraints.
 *
 * @param {string} path - The document/collection path
 * @param {Array} [constraints=[]] - Query constraints
 * @returns {string} A unique cache key
 */
function buildCacheKey(path, constraints = []) {
  if (!constraints || constraints.length === 0) return path;
  const serialised = constraints
    .map((c) => {
      if (c && typeof c === 'object') {
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

// ─── SyncManager ────────────────────────────────────────────────────────────

export class SyncManager {
  /**
   * Creates a new SyncManager instance.
   * No database instance required — Turso client handles connections internally.
   */
  constructor(db) {
    this.db = db; // kept for backward compat, not used
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
     * Active polling interval IDs for subscribe().
     * Maps cacheKey → intervalId
     * @type {Map<string, number>}
     */
    this._pollers = new Map();

    /**
     * Active polling interval IDs for liveCollection().
     * Maps path → intervalId
     * @type {Map<string, number>}
     */
    this._collectionPollers = new Map();

    /**
     * Subscriber callbacks for change notifications.
     * Maps cacheKey → Set<callback>
     * @type {Map<string, Set<Function>>}
     */
    this._subscribers = new Map();

    /**
     * Track the latest known data for polling comparison.
     * Maps cacheKey → JSON-stringified data
     * @type {Map<string, string>}
     */
    this._snapshots = new Map();
  }

  // ─── In-memory session cache ───────────────────────────────────────────────

  /**
   * Retrieves data from the in-memory cache.
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
   * followed by '?', i.e. related query caches.
   *
   * @param {string} path - The base path (e.g. 'users').
   * @returns {Promise<void>}
   */
  async _clearRelatedQueryCaches(path) {
    try {
      const allEntries = await this._cache.entries();
      const prefix = path + '?';
      for (const entry of allEntries) {
        if (entry.path && entry.path.startsWith(prefix)) {
          await this._cache.delete(entry.path);
        }
      }
    } catch (err) {
      console.warn('[SyncManager] Error clearing related query caches:', err);
    }
  }

  // ─── Private Internals ────────────────────────────────────────────────────

  /**
   * Notifies all subscribers for a given cache key with the latest data.
   *
   * @param {string} cacheKey
   * @param {*} data
   */
  _notifySubscribers(cacheKey, data) {
    const subs = this._subscribers.get(cacheKey);
    if (subs && subs.size > 0) {
      const snapshot = JSON.stringify(data);
      const prev = this._snapshots.get(cacheKey);
      // Only notify if data actually changed
      if (prev === snapshot) return;
      this._snapshots.set(cacheKey, snapshot);

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
   * Parses a document path like "users/abc123" into [table, id].
   *
   * @param {string} path
   * @returns {[string|null, string|null]}
   */
  _parsePath(path) {
    const parts = (path || '').split('/').filter(Boolean);
    if (parts.length === 2) return [parts[0], parts[1]];
    if (parts.length === 1) return [parts[0], null];
    return [null, null];
  }

  /**
   * Extracts the table name from a path.
   * Handles "users", "users/abc123", "users/abc123/results", etc.
   *
   * @param {string} path
   * @returns {string|null}
   */
  _parseTable(path) {
    const parts = (path || '').split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const raw = parts[0];
    return TABLE_MAP[raw] || raw;
  }

  /**
   * Validates that the table name is safe (alphanumeric + underscores only).
   *
   * @param {string} table
   * @returns {boolean}
   */
  _isValidTable(table) {
    return typeof table === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table);
  }

  /**
   * Sanitizes a value for SQL to prevent injection via the LIKE clause etc.
   * Returns the value as-is for parameterised queries — Turso handles escaping.
   *
   * @param {*} value
   * @returns {*}
   */
  _sanitizeValue(value) {
    return value;
  }

  /**
   * Fetches a single document from Turso.
   *
   * @param {string} path - The document path (e.g., 'users/abc123').
   * @returns {Promise<object|null>} The document data, or null if it doesn't exist.
   */
  async _fetchDoc(path) {
    const [table, id] = this._parsePath(path);
    if (!table || !id || !this._isValidTable(table)) return null;

    if (trackRead(path)) {
      // Budget exhausted — try cache as fallback
      const cached = await this._cache.get(buildCacheKey(path));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path);
    try {
      const data = await execOne(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      if (data) {
        await this._cache.set(cacheKey, data, 'doc');
      } else {
        await this._cache.delete(cacheKey);
      }
      this._notifySubscribers(cacheKey, data);
      return data || null;
    } catch (e) {
      console.error(`[SyncManager] Error fetching doc "${path}":`, e);
      return null;
    }
  }

  /**
   * Fetches a collection from Turso.
   *
   * @param {string} path - The collection path (e.g., 'users').
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchCollection(path) {
    const table = this._parseTable(path);
    if (!table || !this._isValidTable(table)) return [];

    if (trackRead(path)) {
      const cached = await this._cache.get(buildCacheKey(path));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path);
    try {
      const rows = await exec(`SELECT * FROM ${table}`);
      await this._cache.set(cacheKey, rows, 'collection');
      this._notifySubscribers(cacheKey, rows);
      return rows;
    } catch (e) {
      console.error(`[SyncManager] Error fetching collection "${path}":`, e);
      return [];
    }
  }

  /**
   * Fetches a query with constraints from Turso.
   *
   * @param {string} path - The collection path.
   * @param {Array} constraints - Query constraints [{field, op, value}].
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async _fetchQuery(path, constraints) {
    const table = this._parseTable(path);
    if (!table || !this._isValidTable(table)) return [];

    if (trackRead(path)) {
      const cached = await this._cache.get(buildCacheKey(path, constraints));
      if (cached && cached.data) return cached.data;
      throw new Error(`[Sync] Read budget exhausted for "${path}"`);
    }

    const cacheKey = buildCacheKey(path, constraints);
    try {
      let sql = `SELECT * FROM ${table}`;
      let params = [];

      if (constraints && constraints.length > 0) {
        const whereClauses = [];
        for (const c of constraints) {
          if (c.field && c.op && c.value !== undefined) {
            whereClauses.push(`${c.field} ${c.op} ?`);
            params.push(c.value);
          }
          // Handle special constraints like orderBy
          if (c.type === 'orderBy' && c.field) {
            // We handle this after WHERE
          }
          if (c.type === 'limit' && c.value !== undefined) {
            // We handle this at the end
          }
        }
        if (whereClauses.length > 0) {
          sql += ' WHERE ' + whereClauses.join(' AND ');
        }

        // Handle orderBy and limit after WHERE
        let orderByClauses = [];
        let limitValue = null;
        for (const c of constraints) {
          if (c.type === 'orderBy' && c.field) {
            const dir = c.direction === 'desc' ? 'DESC' : 'ASC';
            orderByClauses.push(`${c.field} ${dir}`);
          }
          if (c.type === 'limit' && c.value !== undefined) {
            limitValue = parseInt(c.value, 10);
          }
        }
        if (orderByClauses.length > 0) {
          sql += ' ORDER BY ' + orderByClauses.join(', ');
        }
        if (limitValue !== null) {
          sql += ' LIMIT ?';
          params.push(limitValue);
        }
      }

      const rows = await exec(sql, params);
      await this._cache.set(cacheKey, rows, 'query');
      this._notifySubscribers(cacheKey, rows);
      return rows;
    } catch (e) {
      console.error(`[SyncManager] Error fetching query "${path}":`, e);
      return [];
    }
  }

  /**
   * Generic fetch with deduplication.
   *
   * @param {string} cacheKey
   * @param {Function} fetcher - An async function that performs the actual fetch.
   * @returns {Promise<any>}
   */
  async _dedupedFetch(cacheKey, fetcher) {
    if (this._pending.has(cacheKey)) {
      return this._pending.get(cacheKey);
    }

    const promise = fetcher().finally(() => {
      if (this._pending.get(cacheKey) === promise) {
        this._pending.delete(cacheKey);
      }
    });

    this._pending.set(cacheKey, promise);
    return promise;
  }

  /**
   * Validates a document path.
   *
   * @param {string} path
   * @returns {boolean}
   */
  _validateDocPath(path) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid document path: "${path}"`);
    }
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
   * Fetches a document using a cache-first strategy.
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

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Turso with deduplication
    const data = await this._dedupedFetch(cacheKey, () => this._fetchDoc(path));
    this._setMemCache(cacheKey, data);

    return data;
  }

  /**
   * Fetches a collection using a cache-first strategy.
   *
   * @param {string} path - The collection path (e.g., 'users').
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async collection(path) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid collection path: "${path}"`);
    }
    const cacheKey = buildCacheKey(path);

    // 1. Check in-memory cache first
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Turso
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
   * Pre-loads data for multiple paths at session start.
   *
   * @param {string[]} paths - Array of document paths to pre-load.
   * @returns {Promise<Object<string, *>>} A map of path → loaded data (null for failures).
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
   * Returns the number of reads used so far in this session.
   *
   * @returns {number}
   */
  getReadsUsed() {
    return typeof window.__efReads === 'undefined' ? 0 : window.__efReads;
  }

  /**
   * Returns the total read budget allocated for this session.
   *
   * @returns {number}
   */
  getReadBudget() {
    return typeof window.__efReadBudget === 'undefined' ? 10 : window.__efReadBudget;
  }

  /**
   * Resets the read budget counter back to zero.
   */
  resetBudget() {
    window.__efReads = 0;
    const budget = typeof window.__efReadBudget === 'undefined' ? 10 : window.__efReadBudget;
    console.log(`[Sync] Read budget reset. New budget: ${budget} reads available.`);
  }

  /**
   * Fetches a query with constraints using a cache-first strategy.
   *
   * @param {string} path - The collection path to query.
   * @param {Array} constraints - Query constraints [{field, op, value}, {type: 'orderBy', field, direction}, {type: 'limit', value}].
   * @returns {Promise<Array<object>>} Array of document data.
   *
   * @example
   *   const results = await sync.query('users', [
   *     { field: 'role', op: '=', value: 'student' },
   *     { type: 'orderBy', field: 'exaRating', direction: 'desc' },
   *     { type: 'limit', value: 20 }
   *   ]);
   */
  async query(path, constraints) {
    const cacheKey = path + '_' + JSON.stringify(constraints);
    const cached = await this._cache.get(cacheKey);
    if (cached) return cached.data;
    
    const table = this._parseTable(path);
    if (!table) return [];
    
    let sql = `SELECT * FROM ${table}`;
    let params = [];
    
    // Handle constraints array (Firestore-style or raw)
    if (constraints && constraints.length > 0) {
      // Check if first element has .field property (Firestore QConstraint)
      const first = constraints[0];
      if (first && typeof first === 'object' && first.field !== undefined) {
        const whereClauses = [];
        constraints.forEach(c => {
          if (c.field && c.op) {
            const op = c.op === '==' ? '=' : c.op;
            whereClauses.push(`${c.field} ${op} ?`);
            params.push(c.value);
          }
        });
        if (whereClauses.length > 0) sql += ' WHERE ' + whereClauses.join(' AND ');
      }
    }
    
    // Handle orderBy, limit passed separately or as extra args
    // (Firestore constraints may include orderBy/limit)
    // For now, just order by created_at DESC as default
    sql += ' ORDER BY created_at DESC LIMIT 50';
    
    const rows = await exec(sql, params);
    await this._cache.set(cacheKey, rows, 'query');
    return rows;
  }

  /**
   * Fetches a collection group query.
   * Since Turso is SQL-based, this maps to SELECT * FROM table.
   *
   * @param {string} collectionId - The collection/table name.
   * @param {Array} [constraints=[]] - Query constraints.
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async collectionGroup(collectionId, constraints = []) {
    if (!collectionId || typeof collectionId !== 'string') {
      throw new Error(`[SyncManager] Invalid collectionGroup ID: "${collectionId}"`);
    }
    if (!Array.isArray(constraints)) {
      throw new Error('[SyncManager] Query constraints must be an array');
    }
    const cacheKey = 'cg:' + collectionId + ':' + JSON.stringify(constraints);

    // 1. Check in-memory cache first
    const memData = this._getMemCache(cacheKey);
    if (memData !== null) return memData;

    // 2. Check IndexedDB cache
    const cached = await this._cache.get(cacheKey);
    if (cached && cached.data) {
      this._setMemCache(cacheKey, cached.data);
      return cached.data;
    }

    // 3. No cache — fetch from Turso
    const table = collectionId;
    if (!this._isValidTable(table)) return [];

    if (trackRead('cg:' + collectionId)) {
      const fallback = await this._cache.get(cacheKey);
      if (fallback && fallback.data) return fallback.data;
      throw new Error(`[Sync] Read budget exhausted for "cg:${collectionId}"`);
    }

    try {
      let sql = `SELECT * FROM ${table}`;
      let params = [];

      if (constraints && constraints.length > 0) {
        const whereClauses = [];
        const orderByClauses = [];
        let limitValue = null;

        for (const c of constraints) {
          if (c.field && c.op && c.value !== undefined) {
            whereClauses.push(`${c.field} ${c.op} ?`);
            params.push(c.value);
          } else if (c.type === 'orderBy' && c.field) {
            const dir = c.direction === 'desc' ? 'DESC' : 'ASC';
            orderByClauses.push(`${c.field} ${dir}`);
          } else if (c.type === 'limit' && c.value !== undefined) {
            limitValue = parseInt(c.value, 10);
          }
        }

        if (whereClauses.length > 0) {
          sql += ' WHERE ' + whereClauses.join(' AND ');
        }
        if (orderByClauses.length > 0) {
          sql += ' ORDER BY ' + orderByClauses.join(', ');
        }
        if (limitValue !== null) {
          sql += ' LIMIT ?';
          params.push(limitValue);
        }
      }

      const rows = await exec(sql, params);
      await this._cache.set(cacheKey, rows, 'query');
      this._setMemCache(cacheKey, rows);
      return rows;
    } catch (e) {
      console.error(`[SyncManager] Error fetching collectionGroup "${collectionId}":`, e);
      return [];
    }
  }

  /**
   * Subscribes to data changes for a given path using polling.
   *
   * Instead of Firestore's real-time onSnapshot, this uses a periodic
   * poll to check for changes and notifies the callback when data changes.
   *
   * @param {string} path - The path to subscribe to.
   * @param {Function} callback - Called with (data) on every change.
   * @param {number} [pollMs=30000] - Polling interval in milliseconds.
   * @returns {Promise<void>}
   *
   * @example
   *   sync.subscribe('users/abc123', (userData) => {
   *     renderProfile(userData);
   *   });
   */
  async subscribe(path, callback, pollMs = DEFAULT_POLL_MS) {
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
        this._snapshots.set(cacheKey, JSON.stringify(cached.data));
      }
    } catch (error) {
      // Non-critical
    }

    // Register the callback
    if (!this._subscribers.has(cacheKey)) {
      this._subscribers.set(cacheKey, new Set());
    }
    this._subscribers.get(cacheKey).add(callback);

    // Start polling if not already running
    if (!this._pollers.has(cacheKey)) {
      const intervalId = setInterval(async () => {
        try {
          const segments = path.split('/').filter(Boolean);
          let data;
          if (segments.length % 2 === 0) {
            // Document path
            data = await this._fetchDoc(path);
          } else {
            // Collection path
            data = await this._fetchCollection(path);
          }
          if (data !== undefined) {
            this._setMemCache(cacheKey, data);
            this._notifySubscribers(cacheKey, data);
          }
        } catch (e) {
          console.warn(`[SyncManager] Poll error for "${path}":`, e.message);
        }
      }, pollMs);
      this._pollers.set(cacheKey, intervalId);
    }
  }

  /**
   * Sets up a polling-based live collection.
   *
   * @param {string} path - The collection path.
   * @param {Function} [onChange] - Optional callback fired with updated data.
   * @param {number} [pollMs=15000] - Polling interval in milliseconds.
   * @returns {Promise<Array<object>>} Array of document data.
   */
  async liveCollection(path, onChange, pollMs = DEFAULT_COLLECTION_POLL_MS) {
    if (!path || typeof path !== 'string') {
      throw new Error(`[SyncManager] Invalid collection path: "${path}"`);
    }

    // Return cached data immediately
    const cached = await this._cache.get(path);
    if (cached) {
      // Start polling in the background
      this._setupCollectionPoller(path, onChange, pollMs);
      return cached.data;
    }

    // Fetch from Turso
    const data = await this._fetchCollection(path);

    // Start polling
    this._setupCollectionPoller(path, onChange, pollMs);

    return data;
  }

  /**
   * Sets up a polling interval for a collection.
   *
   * @param {string} path - The collection path.
   * @param {Function} [onChange] - Optional callback fired with updated data.
   * @param {number} pollMs - Polling interval in milliseconds.
   */
  _setupCollectionPoller(path, onChange, pollMs) {
    if (this._collectionPollers.has(path)) return;

    const intervalId = setInterval(async () => {
      try {
        const data = await this._fetchCollection(path);
        if (data) {
          this._setMemCache(path, data);
          if (onChange) onChange(data);
        }
      } catch (e) {
        console.warn(`[SyncManager] Collection poll error for "${path}":`, e.message);
      }
    }, pollMs);
    this._collectionPollers.set(path, intervalId);
  }

  /**
   * Unsubscribes a callback from change notifications for a given path.
   *
   * @param {string} path - The path.
   * @param {Function} [callback] - Optional specific callback to remove.
   *   If omitted, ALL subscribers for this path are removed AND the poller is stopped.
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
        this._stopPoller(cacheKey);
      }
    } else {
      // Remove all subscribers and stop the poller
      this._subscribers.delete(cacheKey);
      this._stopPoller(cacheKey);
    }
  }

  /**
   * Stops a polling interval for a given cache key.
   *
   * @param {string} cacheKey
   */
  _stopPoller(cacheKey) {
    const intervalId = this._pollers.get(cacheKey);
    if (intervalId) {
      clearInterval(intervalId);
      this._pollers.delete(cacheKey);
    }
    this._snapshots.delete(cacheKey);
  }

  /**
   * Forces a refresh of the cached data for a given path, bypassing the cache.
   *
   * @param {string} path - The path to refresh.
   * @param {Array} [constraints] - Optional query constraints.
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

    // Clear any related query caches from mem cache
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
   * Tears down all active polling intervals and clears subscriber lists.
   */
  destroy() {
    // Stop all document pollers
    this._pollers.forEach((intervalId) => {
      try {
        clearInterval(intervalId);
      } catch (error) {
        console.warn('[SyncManager] Error clearing poller:', error);
      }
    });
    this._pollers.clear();

    // Stop all collection pollers
    this._collectionPollers.forEach((intervalId) => {
      try {
        clearInterval(intervalId);
      } catch (error) {
        console.warn('[SyncManager] Error clearing collection poller:', error);
      }
    });
    this._collectionPollers.clear();

    // Clear all subscribers
    this._subscribers.clear();
    this._snapshots.clear();
    this._memCache.clear();
  }
}

export default SyncManager;
