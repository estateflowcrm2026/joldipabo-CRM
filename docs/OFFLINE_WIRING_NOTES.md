# EstateFlow CRM — Offline Wiring Notes

Date: 2026-09-19

Status: wired. The mobile field-staff flows detect offline state, queue the right action with the right shape, show a clear toast, and surface a top-bar indicator with the pending count.

**Update (Phase 9C).** The sync worker now replays one type end to end.
In LIVE mode (`VITE_USE_API_REPOSITORY=true`) the `listing.capture` handler
posts to `POST /api/v1/listings` and the item is marked synced only after
the backend returns the created row. A failed request leaves the item
`failed` (retry state) in the queue. The other five types have no backend
endpoint yet, so their live handler throws `live-replay-not-wired` rather
than letting the demo handler mark the item synced — a demo handler must
never mark a live item synced. In DEMO mode the validate-only handlers are
unchanged. See `src/services/syncWorker.js` (`DEMO_HANDLERS` / `LIVE_HANDLERS`).

This document describes what is wired, what is metadata-only, how to test the offline path manually, and what the future sync worker must do.

---

## 1. What is wired

| Mobile action                | Online path (unchanged)                                    | Offline path                                                       | Source view                                          |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Check-in                     | `actions.checkIn(location, siteId)` via reducer            | `queueAttendanceCheckIn({...})` via `offlineActions.js`            | [src/views/mobile/Home.jsx onCheckIn](../src/views/mobile/Home.jsx) |
| Check-out                    | `actions.checkOut(location, siteId)` via reducer           | `queueAttendanceCheckOut({...})`                                   | [src/views/mobile/Home.jsx onCheckOut](../src/views/mobile/Home.jsx) |
| Mark visit complete          | `actions.updateVisit(id, patch)`                           | `queueVisitUpdate({visitId, patch, userId})`                       | [src/views/mobile/MobileModules.jsx MobileVisits](../src/views/mobile/MobileModules.jsx) |
| Upload site photo            | `actions.addPhoto({...})` per file                         | `queuePhotoUpload({...})` per file with metadata only              | [src/views/mobile/MobileModules.jsx MobilePhotos](../src/views/mobile/MobileModules.jsx) |
| Send message                 | `actions.sendMessage({threadId, text})`                    | `queueMessageSend({threadId, fromId, body, channel})`              | [src/views/mobile/MobileModules.jsx MobileThread](../src/views/mobile/MobileModules.jsx) |
| Add collected property (listing) | `actions.createListing({...})` from the capture sheet     | `queueListingCapture({ownerName, ownerPhone, locality, serviceCategory, askingPrice, notes, userId})` | [src/views/mobile/MobileModules.jsx NewListingSheet](../src/views/mobile/MobileModules.jsx) |

For each offline path the user sees a toast: **"Saved offline. Will sync later."** (the exact wording varies per action but the meaning is consistent).

Online detection uses two signals:

1. `online` from the store context — driven by `window.online` / `window.offline` events subscribed in [src/state/store.jsx](../src/state/store.jsx).
2. `isOffline()` from [src/services/offlineActions.js](../src/services/offlineActions.js) — a `navigator.onLine === false` check at call time.

Both must be false for the queue path to engage. The store flag is the cached value; the runtime check guards against stale state at the moment of the click.

### Top-bar status indicator

[src/layout/MobileShell.jsx](../src/layout/MobileShell.jsx) renders two chips on the mobile top bar:

- **Offline** — red chip with `CloudOff` icon, only when `online === false`.
- **N** — green chip with `Inbox` icon, only when the queue has one or more pending/failed items. N is the count.

The indicator re-reads the queue every 4 s and immediately on `storage`, `online`, and `offline` events so the badge stays in sync without each view subscribing.

---

## 2. What is metadata-only

Photo upload offline does NOT persist the binary photo. The queue item carries:

```jsonc
{
  "blobKey": null,                  // explicitly null
  "metadata": {
    "projectId": "...",
    "category": "...",
    "caption": "...",
    "sourceFilename": "...",
    "capturedAt": "...",
    "queueIndex": 0,
    "blobPersistence": "deferred"   // marker for the sync worker
  }
}
```

The `<input type="file">` produces an `objectURL` (`URL.createObjectURL`) that is **not durable** — it dies with the page. We do not try to store the file Blob in IndexedDB yet because:

- IndexedDB writes are async and can fail (`QuotaExceededError`).
- Photo files are 2-8 MB and would bloat localStorage fast.
- The user might close the app between capture and sync.

When the future sync worker processes a `photo.upload` queue item with `blobPersistence: 'deferred'`, it must surface an in-app prompt: "Photo capture for visit X needs to be re-uploaded. Pick a file." — there is no way to recover the bytes otherwise. This is a known limitation, not a bug.

Everything else (attendance, visit, message) carries enough data in the queue payload to replay without re-prompting the user.

---

## 3. How to test offline mode manually

### Option A — Chrome DevTools

1. `npm run dev`
2. Open `http://127.0.0.1:5180` and switch to mobile preview (or open on a real phone via the network host).
3. Open DevTools → Application → Service Workers. You should see `/sw.js` registered.
4. DevTools → Network → throttling dropdown → choose **Offline**.
5. Switch to a field-executive role (so the check-in button is visible).
6. Tap **Check in**. You should see the toast "Saved offline. Will sync later."
7. DevTools → Application → Local Storage → `estateflow:offline-queue:v1` should contain a JSON array with one item.
8. The top bar should show an "Offline" chip plus a green "1" chip.
9. Switch throttling back to "No throttling". The chips clear once `online` fires.

### Option B — DevTools console override

In DevTools console:

```js
Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
window.dispatchEvent(new Event('offline'));
```

Then perform a check-in. Restore with:

```js
Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
window.dispatchEvent(new Event('online'));
```

### Option C — Real phone with airplane mode

Build the production bundle (`npm run build`), serve `dist/` over LAN, install the PWA on the phone, then toggle airplane mode and try each flow.

### What to verify

- Online check-in still completes and the "On duty" header updates immediately (unchanged behavior).
- Offline check-in queues an item and the top-bar indicator shows the count.
- Re-tapping the offline check-in does NOT enqueue a duplicate (idempotency by `${staffId}:${day}` key).
- Photo upload offline queues metadata only and the toast mentions re-upload.
- Mark visit complete offline queues one `visit.update` and does NOT mutate the local visit state — the visit still shows "Scheduled" until a future sync replays. This is intentional: we don't fake the local write, because the user should be able to see "this needs sync."
- The sync worker ([src/services/syncWorker.js](../src/services/syncWorker.js)) **does NOT re-apply actions through the store** — it only flips queue status (`pending → synced | failed`). Calling `actions.checkIn` / `actions.updateVisit` / `actions.sendMessage` from inside the worker is explicitly disallowed: the wiring contract above says we don't fake the local write, and re-applying would also create a duplicate permission-check seam with the future `apiRepository` worker. See [docs/SYNC_WORKER_PLAN.md §2](SYNC_WORKER_PLAN.md) for the handler contract.
- Send message offline queues the message; the local message list does not show it (same reason as above).
- Online → offline → online → the queue chip clears only when the sync worker (not yet implemented) drains it.

---

## 4. What the future sync worker must do

When implemented (likely in a follow-up task), the worker lives at [src/services/syncWorker.js](../src/services/syncWorker.js) (future). Its contract is:

1. Subscribe to `online`, `visibilitychange`, and the service worker's `sync` event.
2. On trigger, `listQueuedActions({ status: 'pending' })` ordered by `createdAt` ascending.
3. For each item, dispatch by `type`:

   | `type`                  | Repository call                                                                            |
   | ----------------------- | ------------------------------------------------------------------------------------------ |
   | `attendance.checkIn`    | `apiRepository.custom.attendance.checkIn({staffId, location, siteId})`                     |
   | `attendance.checkOut`   | `apiRepository.custom.attendance.checkOut({staffId, location, siteId, clientHoursWorked})` |
   | `visit.update`          | `apiRepository.update('visits', visitId, patch)`                                           |
   | `photo.upload`          | (see note below)                                                                           |
   | `message.send`          | `apiRepository.custom.messages.send({threadId, fromId, body, channel})`                    |
   | `listing.capture`       | `apiRepository.create('listings', {...expanded DTO from payload...})`                       |

4. On 2xx → `markActionSynced(id)`.
5. On 4xx (non-retriable) → `markActionFailed(id, { code, message, detail })`.
6. On 5xx or network error → leave at `pending`; next trigger retries.
7. After each batch, `clearSyncedActions()`.

### Photo upload specifics

When the worker hits a `photo.upload` item with `blobPersistence: 'deferred'`:

1. Surface an in-app banner: "Photo '<caption>' needs to be re-uploaded."
2. On user action, open a file picker and capture the new Blob.
3. Persist the Blob to IndexedDB (the [src/services/photoStore.js](../src/services/photoStore.js) helper from the queue contract document).
4. Update the queue item's `metadata.blobPersistence` to `'persisted'` and `blobKey` to the IndexedDB key.
5. Continue the normal flush: presign → S3 → create row.

### Conflict handling

The conflict policy from [docs/PWA_OFFLINE_PLAN.md §5](../docs/PWA_OFFLINE_PLAN.md) applies. The worker must:

- Surface 409 conflict resolutions as a non-blocking toast on the mobile drawer.
- Never silently overwrite a server-side reassignment (`lead.ownerId`).

### Listing capture specifics

The `listing.capture` payload is a thin capture-only shape (owner name,
phone, locality, category, asking price, notes). The worker expands it
into the full Listing DTO before posting to `POST /api/v1/listings`:

1. Derive `listingIntent` from `serviceCategory` (rent → `rent-out`,
   pg → `list-pg`, land → `sell-plot`, office → `list-office`, resale →
   `sell`, owner-listed → `sell`).
2. Set `propertyType` to a placeholder (`'2BHK Apartment'`) so the new
   record is editable in the desktop module after sync.
3. Populate `assignedTo` and `createdBy` from `metadata.userId` (the field
   executive who captured it).
4. Initial `status.availability = 'available'`, `status.verification =
   'unverified'` so the listing flows through the normal verification
   pipeline.
5. The DTO is otherwise identical to the shape in
   [docs/LISTINGS_MODULE.md](LISTINGS_MODULE.md) — no client-side schema
   transform beyond filling those defaults.

---

## 5. Files changed in this task

- [src/services/offlineActions.js](../src/services/offlineActions.js) — new, typed helpers + idempotency keys.
- [src/services/offlineQueue.js](../src/services/offlineQueue.js) — `queueAction` now also reads `idempotencyKey` from `options.metadata.idempotencyKey` so the typed helpers benefit from dedupe without passing a top-level option.
- [src/state/store.jsx](../src/state/store.jsx) — added `online` state, `online`/`offline` event subscription, exposed `online` on the context value.
- [src/views/mobile/Home.jsx](../src/views/mobile/Home.jsx) — check-in/check-out branch on `online === false || isOffline()`.
- [src/views/mobile/MobileModules.jsx](../src/views/mobile/MobileModules.jsx) — visit update, photo upload, message send all branch on offline.
- [src/layout/MobileShell.jsx](../src/layout/MobileShell.jsx) — top-bar Offline + queue-count chips, with a 4 s polling refresh.
- [src/styles.css](../src/styles.css) — `.mobile-status-chip`, `.mobile-status-offline`, `.mobile-status-queue` styles.

No new module imports in any desktop view. No changes to [src/state/store.jsx](../src/state/store.jsx) reducer cases. The reducer is untouched — the only change is one extra `useState` and an effect to track `online`.

---

## 6. Known limitations

- **No real persistence for photo blobs.** Documented above. Worker must prompt user to re-pick.
- **No optimistic UI update for queued visit/message/photo.** The local state shows the action as not-yet-done until the sync worker applies it. We chose this over fake-locally-update-and-rollback because rollback is harder to get right than honesty.
- **No queue management UI in the drawer.** Only the badge. A full "Sync queue" drawer with retry / delete controls is in the PWA roadmap ([docs/PWA_OFFLINE_PLAN.md §10](../docs/PWA_OFFLINE_PLAN.md)).
- **No push notifications** when items sync. That's the next phase.
