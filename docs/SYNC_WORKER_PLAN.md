# EstateFlow CRM — Sync Worker Plan

Date: 2026-09-19

Status: scaffold only. The worker drains the offline queue, marks each item `synced` or `failed`, and ships with no-network demo handlers. A future `apiRepository`-backed worker will replace the demo handlers one at a time without changing the worker loop.

The implementation lives at [src/services/syncWorker.js](../src/services/syncWorker.js) and is read by [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) §7 and [docs/OFFLINE_WIRING_NOTES.md](OFFLINE_WIRING_NOTES.md) §1–3.

---

## 1. Sync lifecycle

The queue contract defines four statuses: `pending`, `syncing`, `synced`, `failed`. The worker moves items across the boundaries below.

```text
queueAction()                    network ok                network fail / non-retriable
       │                              │                              │
       ▼                              ▼                              ▼
  ┌─────────┐                  ┌──────────┐                  ┌──────────┐
  │ pending │ ─── flush ────►  │  synced  │                  │  failed  │
  └─────────┘                  └──────────┘                  └──────────┘
       │                              │                              │
       │ flush finds no handler       │ clearSyncedActions()         │ markActionPending(id)
       ▼                              ▼                              │ user-driven
  ┌──────────┐                  (removed from queue)                  │
  │  failed  │  no-handler /                                            ▼
  │          │  invalid-payload                                  ┌──────────┐
  └──────────┘                                                   │ pending  │
                                                                └──────────┘
```

`syncing` is reserved for the future `apiRepository`-backed worker that may await `fetch()` and crash mid-flush. The demo worker goes straight `pending → synced | failed` because it never awaits network.

After a successful batch, [src/services/offlineQueue.js `clearSyncedActions()`](../src/services/offlineQueue.js) drops every `status === 'synced'` item so the queue stays small. The cleared count is reported in the result.

---

## 2. Handler contract

```js
// async (item, options) => void
// Throw an Error with shape { code, message, detail? } to mark failed.
// Any other thrown value is wrapped as { code: 'unknown', message: String(err) }.
//
//   item: a full queue record:
//     { id, type, payload, status, createdAt, updatedAt, attempts, metadata? }
//   options:
//     { trigger: 'manual' | 'auto', now: () => Date, handlers?: Map<string, handler> }
//
// Handlers MUST NOT mutate the store. The worker only flips queue status.
// Re-applying through actions.checkIn / actions.updateVisit / actions.sendMessage
// is explicitly disallowed — see docs/OFFLINE_WIRING_NOTES.md §3.
//
// Handlers return nothing. Returning a result object invites every handler
// to invent its own shape, and breaks the wrap-error logic.
```

The worker wraps the call:

- `await handler(...)` resolves → `markActionSynced(id)` and append `{ id, type, status: 'synced' }`.
- `throw { code, message, detail? }` → `markActionFailed(id, { code, message, detail })` and append `{ id, type, status: 'failed', error }`.
- `throw anything-else` → wrap as `{ code: 'unknown', message: String(err) }`, mark failed.
- No handler registered → mark failed with `{ code: 'no-handler', message: 'No sync handler for type X' }`.

### Registry

- `registerSyncHandler(type, handler)` — overwrites the slot for `type`. Throws if `type` is empty or `handler` is not a function.
- `unregisterSyncHandler(type)` — removes the slot. Items of that type will then fail with `code: 'no-handler'` until a handler is re-registered.
- `getSyncHandlers()` — returns a shallow copy of the registry. For inspection and tests.
- `registerDefaultHandlers()` — fills empty slots with the demo handlers below. Existing custom handlers are preserved (the function only writes if the slot is empty). Exposed so a test that called `unregisterSyncHandler` can re-install the demo without restarting the process.
- `__resetHandlers()` — clears every slot. For tests only.

### Demo handlers (registered at module load)

| type | behavior |
| --- | --- |
| `attendance.checkIn` | validate `payload.staffId` + `payload.location`; mark synced. |
| `attendance.checkOut` | validate `payload.staffId` + `payload.location`; mark synced. |
| `visit.update` | validate `payload.visitId` + `payload.patch.status`; mark synced. |
| `message.send` | validate `payload.threadId` + `payload.fromId` + `payload.body`; mark synced. |
| `photo.upload` | if `payload.metadata.blobPersistence === 'deferred'`, throw `{ code: 'photo-repick-required', message: 'Photo file must be re-selected before sync.', detail: { blobKey, caption, sourceFilename, projectId, category } }`. Otherwise validate `metadata.projectId` + `metadata.category`; mark synced. |

All validation failures throw `{ code: 'invalid-payload', message }`.

The demo handlers perform **no network calls**. They exist so the manual "Sync pending actions" affordance can ship today without lying to the user about server-side state.

---

## 3. Future apiRepository behavior

When the API repository exists at [src/services/apiRepository.js](../src/services/apiRepository.js) (per [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md)), each demo handler is replaced via:

```js
import { registerSyncHandler } from './syncWorker.js';
import { getRepository } from './index.js';

const repo = getRepository();
registerSyncHandler('attendance.checkIn', async (item) => {
  await repo.custom.attendance.checkIn({
    staffId: item.payload.staffId,
    siteId: item.payload.siteId,
    location: item.payload.location,
  });
});
// ... repeat for the other four types
```

The same wiring is expected at app startup. A future `src/services/registerApiHandlers.js` will own the wiring so `main.jsx` can call it once.

### Endpoint dispatch table

Per [docs/OFFLINE_QUEUE_CONTRACT.md §4](OFFLINE_QUEUE_CONTRACT.md) and [docs/BACKEND_INTEGRATION_PLAN.md §7](BACKEND_INTEGRATION_PLAN.md):

| type | Repository call |
| --- | --- |
| `attendance.checkIn` | `repo.custom.attendance.checkIn({ staffId, siteId, location })` |
| `attendance.checkOut` | `repo.custom.attendance.checkOut({ staffId, location, siteId, clientHoursWorked })` |
| `visit.update` | `repo.update('visits', visitId, patch)` |
| `message.send` | `repo.custom.messages.send({ threadId, fromId, body, channel })` |
| `photo.upload` | three-step: `repo.custom.photos.presignUpload()` → upload to `url` → `repo.custom.photos.create({ objectKey, ...metadata })`. Until Blob persistence lands, the worker prompts the user to re-pick the file before presign. |

### Idempotency-Key header

`metadata.idempotencyKey` is already set at queue time by [src/services/offlineActions.js](../src/services/offlineActions.js). The future `apiRepository` MUST forward this as `Idempotency-Key: <key>` on every POST/PATCH. Without it, a partial failure between server acceptance and local `markActionSynced` will create duplicate records on retry.

### Permission re-check

Per [docs/PWA_OFFLINE_PLAN.md §9](PWA_OFFLINE_PLAN.md), the future apiRepository handler must call `permCan(user, resource, action)` before flushing any queued action. A permission downgrade between enqueue and sync should not silently leak location or any other scoped data. Demo handlers skip this because they don't mutate any server-visible state.

---

## 4. Error handling

The worker treats errors uniformly via the wrapped `{ code, message, detail? }` shape, then writes that into the queue item's `error` field. The contract says:

- 2xx → mark synced.
- 4xx (non-retriable) → mark failed with the server's error body.
- 5xx or network error → leave at `pending`; next trigger retries.

Demo mode: every item that fails the demo validation path is non-retriable. The user fixes the issue (e.g. re-picks the photo file) and re-arms the item via the future "Retry" affordance, which calls `markActionPending(id)` and then `syncOneAction(id)`.

### Error codes the worker can produce

| code | source | retriable? |
| --- | --- | --- |
| `invalid-payload` | demo validation | no |
| `photo-repick-required` | demo photo.deferred | no |
| `no-handler` | registry miss | yes (after handler is registered) |
| `unknown` | any other thrown error | depends on the underlying cause |

The future API worker will add `network`, `unauthorized`, `conflict`, `server` codes from server responses.

---

## 5. Retry / backoff plan

The current scaffold retries implicitly: any item that fails (or stays pending because the worker wasn't triggered) is re-attempted the next time `syncQueuedActions` runs. The mobile drawer button is the manual trigger today.

When `startAutoSync()` is wired in a future phase, the worker will trigger on:

1. The `online` window event (immediate).
2. The `visibilitychange` event transitioning to `visible`.
3. A `FLUSH_QUEUE` message from the service worker (Chromium background sync).

A 5-second `lastTriggerAt` cooldown inside `startAutoSync()` prevents visibility flicker from spamming the queue. If `navigator.onLine === false`, the trigger short-circuits — attempting a flush with no connectivity just wastes time.

### Future exponential backoff

For network errors (`code: 'network'` or 5xx), the future API worker will apply:

```
backoff_ms = min(30 * 60 * 1000, 10_000 * 2 ** min(attempts, 6))
```

So: 10 s, 30 s, 1 min, 2 min, 4 min, 8 min, 16 min, 30 min. Items past `attempts >= 6` are flipped to `failed` with `code: 'max-attempts'` so the user gets a clear signal instead of an invisible retry loop.

The queue item's `attempts` counter (incremented by `markActionFailed`) is the source of truth. `markActionPending(id)` resets it to zero and clears the error.

---

## 6. Conflict handling

[docs/PWA_OFFLINE_PLAN.md §5](PWA_OFFLINE_PLAN.md) defines three conflict shapes; the worker applies them as follows.

### Last-write-wins (default)

Status flags (`visit.status`, `message.read`, `attendance.checkOut`). The client posts its queued payload; on 409 the worker overwrites with the queued payload and logs `metadata.conflictResolution: 'client-overwrite'`.

### Server-authoritative

For `attendance.checkIn` on a day with an existing open record, the server returns the existing record; the worker replaces the local optimistic record and surfaces a toast: "Your check-in was merged with an existing record."

For `attendance.checkOut`, the server's `hoursWorked` is canonical; the client's value is preserved as `metadata.clientHoursWorked` for audit.

### Manual resolution

Lead ownership reassignment is the only field with manual resolution. On a 409 with `{ error: 'lead-reassigned', newOwnerId }`, the worker surfaces "This lead was reassigned. Open it to continue." and does NOT retry.

### Conflict signaling today

The worker marks the item `failed` with the server's 409 body in `error.detail`. The drawer toast says "X needs attention." A future "Sync queue" page will list each failed item with its conflict reason and an action ("Open lead", "Retry", "Discard").

---

## 7. Photo re-pick handling

When the future API worker hits a `photo.upload` item with `payload.metadata.blobPersistence === 'deferred'`, it cannot complete the upload — the Blob is not in IndexedDB. The flow is:

1. Worker detects the marker.
2. Surface an in-app banner: "Photo '<caption>' needs to be re-uploaded."
3. User taps the banner → opens a file picker.
4. The picker captures a new Blob.
5. The Blob is persisted to IndexedDB under a new key (e.g. `photo-{id}`).
6. The queue item is updated via a future `markActionPhotoBlobPersisted(id, blobKey)` helper: `payload.metadata.blobPersistence = 'persisted'`, `payload.blobKey = blobKey`.
7. The worker resumes the normal flush: presign → S3 → create row.

The demo worker short-circuits at step 1: it marks the item `failed` with `code: 'photo-repick-required'` so the user sees the failure in the queue chip immediately. There is no in-app banner yet — the future drawer UI will surface it.

When `photo.upload` succeeds, the future worker must delete the Blob from IndexedDB to free space. A startup hook reaps orphaned Blobs whose queue ids are no longer in the queue, in case the worker crashed mid-cleanup.

---

## 8. Auto-sync (exported but not wired)

`syncWorker.js` exports three functions:

```js
startAutoSync()   // idempotent; subscribes to online / visibilitychange / SW message
stopAutoSync()    // flag-off (anonymous listeners can't be removed individually)
isAutoSyncOn()    // for debugging
```

**No entry point calls `startAutoSync()` today.** A comment block in [src/main.jsx](../src/main.jsx) documents this so the next phase can flip it on deliberately. The wiring decision stays in `main.jsx` where it belongs.

The future wiring will look like:

```js
// src/main.jsx (future)
import { startAutoSync } from './services/syncWorker.js';
startAutoSync(); // subscribe once at startup
```

`startAutoSync()` short-circuits when `navigator.onLine === false` so an offline tab doesn't burn CPU re-checking an unreachable queue.

---

## 9. Files changed in this task

- [src/services/syncWorker.js](../src/services/syncWorker.js) — new.
- [src/services/syncStatus.js](../src/services/syncStatus.js) — new.
- [src/services/syncWorker.smoke.mjs](../src/services/syncWorker.smoke.mjs) — new. Node smoke test, 7 cases.
- [src/main.jsx](../src/main.jsx) — added "Sync queue" section to `MobileMenuContents`; documented that `startAutoSync()` is not called.
- [src/styles.css](../src/styles.css) — `.sync-queue-summary { margin: 0 0 10px; }` to give the sync button breathing room.
- [package.json](../package.json) — added `"type": "module"` so the smoke test can run directly under Node.
- [docs/OFFLINE_WIRING_NOTES.md](OFFLINE_WIRING_NOTES.md) §3 — added the "Sync worker does NOT re-apply via the store" rationale.
- [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) §7 — added a one-line note that `syncWorker.js` ships the demo-flush scaffold.

No new module imports in any desktop view. No changes to [src/state/store.jsx](../src/state/store.jsx) reducer cases. No changes to [src/services/demoRepository.js](../src/services/demoRepository.js).

---

## 10. Known limitations

- **No API calls.** Demo handlers validate only; nothing leaves the device.
- **No `syncing` status.** The demo path is synchronous. Reserved for the future API worker.
- **No per-item retry UI.** Failed items need `markActionPending(id)` then `syncOneAction(id)`; the drawer exposes only the bulk "Sync pending actions" button.
- **No queue persistence on the worker side.** The queue itself persists across reloads; the worker's `inFlight` and `lastAutoTriggerAt` reset on reload.
- **No service-worker message channel.** The `FLUSH_QUEUE` message handler in `startAutoSync` is a stub; real Chromium background-sync wiring is a separate task.
