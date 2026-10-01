// Offline action queue.
//
// Stores pending mutations that need to be replayed against the backend
// once network is available. Today the only writer is the demo (none of the
// demo flows enqueue yet); tomorrow the mobile field-staff flows enqueue
// every check-in, check-out, visit update, photo upload, and message.
//
// Storage: localStorage under a versioned key. Photos (binary Blobs) are not
// stored here — see docs/OFFLINE_QUEUE_CONTRACT.md §6 for the IndexedDB plan.
//
// Failure modes this file must tolerate:
//   - Private / restricted browsers that disable localStorage: degrade to
//     an in-memory log so the rest of the app does not crash.
//   - Corrupt JSON from a previous bad write: clear and start fresh.
//   - QuotaExceededError when writing: log the failure and keep the
//     in-memory list (the next attempt may succeed after sync).

const STORAGE_KEY = 'estateflow:offline-queue:v1';

// Every type the sync worker can handle must appear here, or
// queueAction() throws and the item is dropped on the floor. Keep the
// two lists in sync — syncWorker.smoke.mjs asserts that every handler
// type is allow-listed. `listing.capture` was missing from this set
// until 2026-09-24, which silently lost every offline listing capture
// (offlineActions.js#queueListingCapture enqueues it; validatePayload
// rejected it before it was ever persisted).
const ALLOWED_TYPES = new Set([
  'attendance.checkIn',
  'attendance.checkOut',
  'visit.update',
  'photo.upload',
  'message.send',
  'listing.capture',
]);

// True when storage has already failed — every read/write tries once and
// re-checks, but this guard short-circuits to keep the hot paths cheap.
let storageBroken = false;
let memoryFallback = [];

// ULIDs are time-ordered so the queue flushes oldest-first by default.
// Using a tiny inline implementation to avoid pulling in a dependency for
// one helper. The output is 26 characters: 10 of timestamp + 16 of random.
const generateId = () => {
  const time = Date.now().toString(36).padStart(10, '0');
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random += Math.floor(Math.random() * 36).toString(36);
  }
  return `${time}-${random}`;
};

const nowIso = () => new Date().toISOString();

const safeRead = () => {
  if (storageBroken) return memoryFallback.slice();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[offlineQueue] read failed, using memory fallback:', err);
    storageBroken = true;
    return memoryFallback.slice();
  }
};

const safeWrite = (items) => {
  if (storageBroken) {
    memoryFallback = items.slice();
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[offlineQueue] write failed, using memory fallback:', err);
    storageBroken = true;
    memoryFallback = items.slice();
  }
};

const updateItem = (id, mutator) => {
  const items = safeRead();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return null;
  const next = mutator(items[idx]);
  if (!next) return null;
  items[idx] = next;
  safeWrite(items);
  return next;
};

// Validate payload by `type`. Loosely typed because the contract defines
// the exact shape; this only rejects obvious mistakes early.
const validatePayload = (type, payload) => {
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`[offlineQueue] unsupported type: ${type}`);
  }
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    throw new Error(`[offlineQueue] payload must be an object (got ${typeof payload})`);
  }
};

/**
 * Enqueue a new action.
 * @param {string} type  one of the QueuedActionType values
 * @param {object} payload  per-type payload; see docs/OFFLINE_QUEUE_CONTRACT.md §4
 * @param {{ metadata?: object, idempotencyKey?: string }} [options]
 * @returns {Promise<string>} the assigned queue id (or the existing id if idempotencyKey matched)
 */
export const queueAction = async (type, payload, options = {}) => {
  validatePayload(type, payload);

  const items = safeRead();

  // Idempotency: callers may pass either `options.idempotencyKey` (top-level)
  // or stash it inside `options.metadata.idempotencyKey` (used by the typed
  // helpers in src/services/offlineActions.js). Accept both.
  const incomingKey = options.idempotencyKey || options.metadata?.idempotencyKey;
  if (incomingKey) {
    const existing = items.find(
      (item) =>
        item.type === type &&
        item.metadata &&
        item.metadata.idempotencyKey === incomingKey &&
        item.status !== 'synced'
    );
    if (existing) return existing.id;
  }

  const metadata = options.metadata ? { ...options.metadata } : {};
  if (options.idempotencyKey) {
    metadata.idempotencyKey = options.idempotencyKey;
  }

  const id = generateId();
  const item = {
    id,
    type,
    payload,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempts: 0,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
  items.push(item);
  safeWrite(items);
  return id;
};

/**
 * Read a snapshot of the queue. Returns a fresh array; never mutate the
 * returned items directly — use the helper functions for state changes.
 * @param {{ status?: string, type?: string }} [filters]
 */
export const listQueuedActions = (filters = {}) => {
  const items = safeRead();
  return items.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.type && item.type !== filters.type) return false;
    return true;
  });
};

/**
 * Read a single item by id.
 * @param {string} id
 */
export const getQueuedAction = (id) => {
  return safeRead().find((item) => item.id === id) || null;
};

/**
 * Mark an action synced. Idempotent.
 * @param {string} id
 */
export const markActionSynced = (id) => {
  return updateItem(id, (item) => ({
    ...item,
    status: 'synced',
    updatedAt: nowIso(),
  }));
};

/**
 * Mark an action failed. Increments `attempts` and stores the error.
 * @param {string} id
 * @param {{ code: string, message: string, detail?: object }} error
 */
export const markActionFailed = (id, error) => {
  if (!error || typeof error !== 'object') {
    throw new Error('[offlineQueue] error must be an object { code, message }');
  }
  return updateItem(id, (item) => ({
    ...item,
    status: 'failed',
    updatedAt: nowIso(),
    attempts: (item.attempts || 0) + 1,
    error: {
      code: error.code || 'unknown',
      message: error.message || '',
      detail: error.detail,
    },
  }));
};

/**
 * Re-arm a failed action — set it back to `pending` so the next flush
 * attempts it. Useful when a user retries from the mobile drawer.
 * @param {string} id
 */
export const markActionPending = (id) => {
  return updateItem(id, (item) => ({
    ...item,
    status: 'pending',
    updatedAt: nowIso(),
    error: undefined,
  }));
};

/**
 * Drop every item whose status is `synced`. Returns the count cleared.
 */
export const clearSyncedActions = () => {
  const items = safeRead();
  const kept = items.filter((item) => item.status !== 'synced');
  const cleared = items.length - kept.length;
  if (cleared > 0) safeWrite(kept);
  return cleared;
};

/**
 * Wipe the entire queue. Used by tests and explicit "Clear local data" actions.
 */
export const resetQueue = () => {
  if (!storageBroken) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort
    }
  }
  memoryFallback = [];
};

/**
 * Stats about the current queue. Used by the mobile drawer "Sync queue" UI
 * in a future phase. Today this is informational only.
 */
export const getQueueStats = () => {
  const items = safeRead();
  const counts = { pending: 0, syncing: 0, synced: 0, failed: 0 };
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return { total: items.length, ...counts };
};
