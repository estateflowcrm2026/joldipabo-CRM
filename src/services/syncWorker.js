// Sync worker scaffold.
//
// Drains the offline action queue and replays each item against a pluggable
// handler. Handlers are chosen for the active mode:
//
//   * Demo mode (demo repository): the demo handlers validate the payload
//     only — no network calls, no fetch(), no real backend. They exist so we
//     can ship the manual "Sync now" affordance without lying to the user
//     that the data was sent to a server.
//   * Live mode (API repository): `listing.capture` is replayed against
//     POST /api/v1/listings and is marked synced only once the backend
//     returns the created row. Types with no backend endpoint yet throw a
//     clear `live-replay-not-wired` error so the item stays queued in a
//     retry state rather than being falsely marked synced. A demo handler
//     must never mark a live item synced.
//
// The worker loop, the queue mutation surface, and the public API stay the
// same across modes.
//
// Design notes:
//   - Handlers throw { code, message, detail? } to mark failed; return nothing.
//   - The worker is sequential (oldest-first). A future parallel implementation
//     would change toast ordering; not needed today.
//   - The worker does NOT re-apply actions through the store reducer —
//     see docs/OFFLINE_WIRING_NOTES.md §3 for why.
//   - Auto-sync is exported as startAutoSync()/stopAutoSync() but not called
//     from main.jsx; that wiring decision is intentionally manual for now.
//
// NOT part of this scaffold:
//   - markActionSyncing / syncing status (the demo path is synchronous;
//     syncing is reserved for the future API worker that may crash mid-flush)
//   - photo Blob persistence (see docs/OFFLINE_QUEUE_CONTRACT.md §6)
//   - permission re-check inside the worker (the live handler relies on the
//     backend to refuse an out-of-scope write)

import {
  listQueuedActions,
  getQueuedAction,
  markActionSynced,
  markActionFailed,
  clearSyncedActions,
} from './offlineQueue.js';
import { recordSync } from './syncStatus.js';
import { getRepository, isApiRepositoryActive } from './index.js';
import { listingFromCapture } from './listingCapture.js';

// ---------- Handler registry ----------

const handlers = new Map();

export const registerSyncHandler = (type, handler) => {
  if (!type || typeof type !== 'string') {
    throw new Error('[syncWorker] handler type must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new Error('[syncWorker] handler must be a function');
  }
  handlers.set(type, handler);
};

export const unregisterSyncHandler = (type) => {
  handlers.delete(type);
};

export const getSyncHandlers = () => new Map(handlers);

// Test seam: clears the registry so a test can re-register cleanly.
export const __resetHandlers = () => {
  handlers.clear();
};

// ---------- Demo handlers ----------
//
// Each handler validates the payload shape from
// docs/OFFLINE_QUEUE_CONTRACT.md §4 and throws a structured error on
// validation failure. No network calls. No store mutations.

const badPayload = (message) => {
  const err = new Error(message);
  err.code = 'invalid-payload';
  err.message = message;
  return err;
};

const isPresent = (v) => v !== undefined && v !== null && v !== '';
const isLocation = (loc) =>
  loc && typeof loc === 'object' && isPresent(loc.lat) && isPresent(loc.lng);

const demoAttendanceCheckIn = async (item) => {
  if (!isPresent(item.payload?.staffId)) throw badPayload('attendance.checkIn: missing staffId');
  if (!isLocation(item.payload?.location)) throw badPayload('attendance.checkIn: missing location');
};

const demoAttendanceCheckOut = async (item) => {
  if (!isPresent(item.payload?.staffId)) throw badPayload('attendance.checkOut: missing staffId');
  if (!isLocation(item.payload?.location)) throw badPayload('attendance.checkOut: missing location');
};

const demoVisitUpdate = async (item) => {
  if (!isPresent(item.payload?.visitId)) throw badPayload('visit.update: missing visitId');
  if (!item.payload?.patch || typeof item.payload.patch !== 'object') {
    throw badPayload('visit.update: missing patch');
  }
  if (!isPresent(item.payload.patch.status)) {
    throw badPayload('visit.update: patch.status is required');
  }
};

const demoMessageSend = async (item) => {
  if (!isPresent(item.payload?.threadId)) throw badPayload('message.send: missing threadId');
  if (!isPresent(item.payload?.fromId)) throw badPayload('message.send: missing fromId');
  if (!isPresent(item.payload?.body)) throw badPayload('message.send: missing body');
};

const demoPhotoUpload = async (item) => {
  // The contract puts blobPersistence inside payload.metadata (the user-supplied
  // object), NOT the queue item's top-level metadata. See
  // docs/OFFLINE_WIRING_NOTES.md §2.
  const meta = item.payload?.metadata;
  if (meta?.blobPersistence === 'deferred') {
    const err = new Error('Photo file must be re-selected before sync.');
    err.code = 'photo-repick-required';
    err.detail = {
      blobKey: item.payload.blobKey || null,
      caption: meta.caption || null,
      sourceFilename: meta.sourceFilename || null,
      projectId: meta.projectId || null,
      category: meta.category || null,
    };
    throw err;
  }
  if (!isPresent(meta?.projectId)) throw badPayload('photo.upload: missing metadata.projectId');
  if (!isPresent(meta?.category)) throw badPayload('photo.upload: missing metadata.category');
};

// Demo handler for the field-exec "Add collected property" flow.
// The future apiRepository-backed worker will replace this with a
// `POST /api/v1/listings` call via `repo.create('listings', ...)`.
// For the demo we only validate the payload and mark synced — the actual
// record creation is not performed by the worker (see
// docs/OFFLINE_WIRING_NOTES.md §3 — the worker doesn't re-apply through the
// store). In API mode the future apiRepository handler will do both.
const demoListingCapture = async (item) => {
  if (!isPresent(item.payload?.ownerName)) throw badPayload('listing.capture: missing ownerName');
  if (!isPresent(item.payload?.ownerPhone)) throw badPayload('listing.capture: missing ownerPhone');
  if (!isPresent(item.payload?.serviceCategory)) throw badPayload('listing.capture: missing serviceCategory');
};

// ---------- Live handlers ----------
//
// Live mode = the API repository is active. A demo handler must NEVER mark a
// live item synced: it validates the payload and returns, which the worker
// reads as success — so the item would be cleared from the queue even though
// the backend never saw it. That is exactly the failure this section exists
// to prevent.
//
// `listing.capture` is replayable end-to-end, so it gets a real handler that
// posts to POST /api/v1/listings and only resolves once the backend returns
// the created row. The other types have no backend endpoint in this phase
// (attendance / visits / messages / photos are still placeholders server
// side), so their live handler throws a clear, non-retriable error: the item
// stays in the queue as "needs attention" rather than being silently lost.

/**
 * Replay a queued listing capture against the real backend.
 *
 * Expands the thin capture payload into the full Listing DTO (the same
 * expansion the online form uses — see listingCapture.js) and POSTs it. The
 * worker marks the item synced only if this resolves, i.e. only after the
 * API confirms creation.
 */
const liveListingCapture = async (item) => {
  const p = item.payload || {};
  if (!isPresent(p.ownerName)) throw badPayload('listing.capture: missing ownerName');
  if (!isPresent(p.ownerPhone)) throw badPayload('listing.capture: missing ownerPhone');
  if (!isPresent(p.serviceCategory)) throw badPayload('listing.capture: missing serviceCategory');

  const dto = listingFromCapture({
    ownerName: p.ownerName,
    ownerPhone: p.ownerPhone,
    locality: p.locality,
    serviceCategory: p.serviceCategory,
    askingPrice: p.askingPrice,
    notes: p.notes,
    userId: item.metadata?.userId ?? null,
    projectId: null,
  });

  // Throws on any non-2xx / network failure → the worker marks the item
  // failed with the server's code + message and leaves it in the queue.
  await getRepository().create('listings', dto);
};

/**
 * Build a live handler for a type with no backend endpoint yet. It throws so
 * the item is marked failed (retry state) rather than falsely synced.
 */
const liveUnavailableHandler = (type) => async () => {
  const err = new Error(
    `Live sync for "${type}" is not wired yet — the backend has no endpoint for it in this phase. The action stays queued.`,
  );
  err.code = 'live-replay-not-wired';
  throw err;
};

// ---------- Registration ----------

const DEMO_HANDLERS = {
  'attendance.checkIn': demoAttendanceCheckIn,
  'attendance.checkOut': demoAttendanceCheckOut,
  'visit.update': demoVisitUpdate,
  'message.send': demoMessageSend,
  'photo.upload': demoPhotoUpload,
  'listing.capture': demoListingCapture,
};

const LIVE_HANDLERS = {
  'attendance.checkIn': liveUnavailableHandler('attendance.checkIn'),
  'attendance.checkOut': liveUnavailableHandler('attendance.checkOut'),
  'visit.update': liveUnavailableHandler('visit.update'),
  'message.send': liveUnavailableHandler('message.send'),
  'photo.upload': liveUnavailableHandler('photo.upload'),
  'listing.capture': liveListingCapture,
};

// Register the handlers for the active mode. The future apiRepository-backed
// worker overwrites slots via registerSyncHandler; we only fill empty slots so
// a test or a caller-installed handler is not clobbered.
export const registerDefaultHandlers = () => {
  const defaults = isApiRepositoryActive() ? LIVE_HANDLERS : DEMO_HANDLERS;
  for (const [type, handler] of Object.entries(defaults)) {
    if (!handlers.has(type)) handlers.set(type, handler);
  }
};

registerDefaultHandlers();

// ---------- Worker loop ----------

// Items are processed sequentially. Snapshot the queue once; do not re-read
// mid-flush — handlers mutate status, and a re-read would skip or double
// items.
const collectPending = () => {
  const items = listQueuedActions({ status: 'pending' });
  // Sort oldest-first by createdAt ascending. The queue helper doesn't sort
  // today (see docs/OFFLINE_QUEUE_CONTRACT.md §7.2) so we do it here.
  return items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
};

const noHandlerError = (type) => {
  const err = new Error(`No sync handler for type ${type}`);
  err.code = 'no-handler';
  return err;
};

const runHandler = async (item, options) => {
  const handler = options.handlers?.get(item.type) ?? handlers.get(item.type);
  if (!handler) throw noHandlerError(item.type);
  await handler(item, options);
};

const wrapError = (err) => {
  if (err && typeof err === 'object' && err.code) {
    return {
      code: err.code,
      message: err.message || '',
      detail: err.detail,
    };
  }
  return {
    code: 'unknown',
    message: err instanceof Error ? err.message : String(err),
  };
};

// Module-level in-flight guard. Scoped to syncQueuedActions only so that
// syncOneAction remains re-entrant (future "Retry this item" button).
let inFlight = null;

export const syncQueuedActions = async (options = {}) => {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const trigger = options.trigger || 'manual';
    const items = collectPending();
    const results = [];

    for (const item of items) {
      try {
        await runHandler(item, { trigger, now: () => Date.now(), handlers: options.handlers });
        markActionSynced(item.id);
        results.push({ id: item.id, type: item.type, status: 'synced' });
      } catch (err) {
        const wrapped = wrapError(err);
        markActionFailed(item.id, wrapped);
        results.push({ id: item.id, type: item.type, status: 'failed', error: wrapped });
      }
    }

    // Per docs/OFFLINE_QUEUE_CONTRACT.md §7.7: clear synced items after the
    // batch. Report the count so the caller can include it in the toast.
    const cleared = clearSyncedActions();

    const summary = {
      synced: results.filter((r) => r.status === 'synced').length,
      failed: results.filter((r) => r.status === 'failed').length,
      items: results,
      cleared,
    };

    // Record the result for syncStatus.js to expose.
    recordSync(summary);

    return summary;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
};

// syncOneAction replays a single item. queueItemOrId may be a string id or
// a full item object. Re-entrant (no inFlight guard) so a future "Retry
// this item" button can call it without conflicting with syncQueuedActions.
export const syncOneAction = async (queueItemOrId, options = {}) => {
  const item =
    typeof queueItemOrId === 'string'
      ? getQueuedAction(queueItemOrId)
      : queueItemOrId;

  if (!item) {
    const wrapped = { code: 'not-found', message: 'Queue item not found.' };
    return { id: null, type: null, status: 'failed', error: wrapped };
  }

  const trigger = options.trigger || 'manual';

  try {
    await runHandler(item, { trigger, now: () => Date.now(), handlers: options.handlers });
    markActionSynced(item.id);
    return { id: item.id, type: item.type, status: 'synced' };
  } catch (err) {
    const wrapped = wrapError(err);
    markActionFailed(item.id, wrapped);
    return { id: item.id, type: item.type, status: 'failed', error: wrapped };
  }
};

// ---------- Auto-sync stubs (not wired) ----------
//
// These are exported for the future phase that flips on background flushing.
// They are intentionally NOT called from src/main.jsx today. See the comment
// block there for the rationale.

const AUTO_TRIGGER_COOLDOWN_MS = 5000;
let autoSyncOn = false;
let lastAutoTriggerAt = 0;
const triggerFlush = () => syncQueuedActions({ trigger: 'auto' });

const onAutoEvent = (source) => {
  if (!autoSyncOn) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  if (now - lastAutoTriggerAt < AUTO_TRIGGER_COOLDOWN_MS) return;
  lastAutoTriggerAt = now;
  // Source is informational only today (logged in the future).
  void source;
  triggerFlush().catch(() => {
    // Swallow — the worker already marks individual items failed; an outer
    // rejection here would just be a noisy console error.
  });
};

export const startAutoSync = () => {
  if (autoSyncOn || typeof window === 'undefined') return;
  autoSyncOn = true;
  window.addEventListener('online', () => onAutoEvent('online'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onAutoEvent('visibility');
  });
  // Service worker background-sync: best-effort, no controller is fine.
  if (navigator?.serviceWorker?.controller) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event?.data?.type === 'FLUSH_QUEUE') onAutoEvent('sw-sync');
    });
  }
};

export const stopAutoSync = () => {
  // Listeners were anonymous so we can't remove them individually; the flag
  // suppresses further triggers. Re-call startAutoSync to reset.
  autoSyncOn = false;
};

export const isAutoSyncOn = () => autoSyncOn;
