# EstateFlow CRM — Sync Worker Tests

Date: 2026-09-19

Companion to [docs/SYNC_WORKER_PLAN.md](SYNC_WORKER_PLAN.md). Two kinds of tests live here: **automated** (a Node smoke test that runs against `localStorage` shim) and **manual** (browser recipes that exercise the full UI flow with the dev server).

Run the automated smoke test from the project root:

```bash
node src/services/syncWorker.smoke.mjs
```

The script covers seven cases end-to-end. Each prints `✓ …` on success. The script exits non-zero on any failure.

---

## Automated smoke test (`src/services/syncWorker.smoke.mjs`)

### 1. End-to-end flush — 4 synced, 1 failed

Queues one of each type (`attendance.checkIn`, `attendance.checkOut`, `visit.update`, `message.send`, `photo.upload` with `blobPersistence: 'deferred'`), then calls `syncQueuedActions({ trigger: 'manual' })`.

Asserts:

- `result.synced === 4`
- `result.failed === 1`
- The photo outcome has `status: 'failed'` and `error.code === 'photo-repick-required'`
- The photo failure `error.detail` includes `blobKey`, `caption`, `sourceFilename`, `projectId`, `category`
- After flush, `listQueuedActions()` has exactly one item (the failed photo)
- `getQueueStats()` reports `failed: 1, pending: 0, synced: 0` (synced items were cleared)
- `getSyncStatus()` reports `lastSyncAt` and `lastSyncResult` correctly

### 2. Re-flush is idempotent on already-failed items

Calls `syncQueuedActions()` a second time. Asserts the failed photo is left alone — the worker only acts on `status === 'pending'`, so a failed item stays failed until the user explicitly re-arms it via `markActionPending(id)`.

### 3. Invalid payloads fail with `invalid-payload`

Queues three items with missing required fields (`attendance.checkIn` without `staffId`, `message.send` without `body`, `visit.update` without `patch.status`).

Asserts:

- `result.synced === 0`
- `result.failed === 3`
- Every failed outcome has `error.code === 'invalid-payload'`

### 4. Idempotency dedup at queue time

Calls `queueAction('attendance.checkIn', payload, { metadata: { idempotencyKey: 'k' } })` twice with the same key.

Asserts:

- The two calls return the same id (deduped at `queueAction` time)
- The flush reports exactly one item, not two

This is the dedup behavior set up in [src/services/offlineQueue.js](../src/services/offlineQueue.js) — the worker benefits from it without any extra logic.

### 5. In-flight guard

`await Promise.all([syncQueuedActions(), syncQueuedActions()])`.

Asserts:

- Both promises resolve to the **same** result object (the second call returned the in-flight promise of the first)
- The flush ran exactly once and reported all 3 queued items

### 6. Registry replace / unregister

Replaces the `attendance.checkIn` handler with one that always throws `{ code: 'upstream-503' }`. Flushes — asserts the failure carries the new code. Unregisters — flushes again — asserts the next item fails with `code: 'no-handler'`. Calls `registerDefaultHandlers()` — asserts the demo handler is back.

### 7. `syncOneAction(id)`

Calls `syncOneAction(id, { trigger: 'manual' })` on a single item id. Asserts it returns `{ id, type, status: 'synced' }` without touching any other queue items.

---

## Manual browser tests (Chrome DevTools)

These exercise the full UI flow against `npm run dev`.

### M1. Sync queue section appears only when the queue has items

1. `npm run dev`
2. Open `http://127.0.0.1:5180` and switch to mobile preview.
3. Sign in as a field-executive role.
4. Open the side drawer (top-left menu icon).
5. **Expected:** "Sync queue" section shows "All queued actions are synced." — no button.

### M2. Offline check-in + sync round-trip

1. DevTools → Network → **Offline**.
2. Tap **Check in**. Confirm the "Saved offline. Will sync later." toast.
3. Top-bar should show a red "Offline" chip and a green "1" chip.
4. Open the drawer. **Expected:** "Sync queue" section reads "1 pending · 0 need attention · last synced …".
5. Tap **Sync pending actions**. Drawer closes.
6. **Expected toast:** "1 item synced."
7. Open the drawer again. **Expected:** "All queued actions are synced."
8. Top-bar queue chip clears. Top-bar offline chip clears (DevTools back to "No throttling" first).

### M3. Mixed queue — sync + photo re-pick failure

1. DevTools → Network → **Offline**.
2. Trigger each action at least once: check-in, mark a visit complete, send a message, queue a photo (or simulate by calling `queuePhotoUpload` from the console).
3. DevTools → Network → **No throttling**.
4. Open the drawer. Section shows "3 pending · 1 need attention" (the photo carries the failure from the previous task's wiring).
5. Tap **Sync pending actions**.
6. **Expected toast:** "3 synced, 1 needs attention."
7. Top-bar chip should show "1" (the failed photo is still in the queue).
8. DevTools → Application → Local Storage → `estateflow:offline-queue:v1` should contain one item, the failed photo, with `error.code: 'photo-repick-required'`.

### M4. Idempotency in practice (re-tap while offline)

1. DevTools → Network → **Offline**.
2. Tap **Check in**, wait, tap **Check in** again.
3. Open the drawer. Section reads "1 pending", not "2".
4. The top-bar queue chip is "1".
5. DevTools → Application → Local Storage → `estateflow:offline-queue:v1` has one item, not two.

### M5. Online check-in does NOT queue

1. DevTools → Network → **No throttling** (default).
2. Tap **Check in**.
3. The "On duty" hero card flips immediately to "Since HH:MM".
4. Open the drawer. Section reads "All queued actions are synced."
5. DevTools → Application → Local Storage → `estateflow:offline-queue:v1` is unchanged.

### M6. Auto-sync is NOT wired

1. With the drawer open and a failed item present, look at the network tab. No `fetch()` calls should fire on tab focus, on `online` event (DevTools Network → Offline → No throttling), or on visibility change.
2. The only way the queue drains is the "Sync pending actions" button.

### M7. Console / network

Throughout M2–M6, the browser console should have:

- No errors.
- No unhandled promise rejections.
- No warnings about unknown toast tones or missing handlers.
- DevTools → Network → JS / Fetch / XHR: no requests fired by the worker (the demo handler does no I/O).

---

## Acceptance

| Acceptance criterion | Where it lives |
| --- | --- |
| Build passes | `npm run build` → `✓ built in …ms` |
| Smoke test passes | `node src/services/syncWorker.smoke.mjs` → "Smoke test PASSED." |
| Manual M1–M7 | As above |
| No new console errors in dev or production build | DevTools → Console in `npm run dev` and `npm run preview` |
| `package.json` declares `"type": "module"` | The smoke test runs directly under Node without a bundler |
