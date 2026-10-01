# EstateFlow CRM — PWA & Offline Plan

Date: 2026-09-19

Status: scaffolding + contract. The PWA manifests, service worker, and offline queue functions are in place but the UI does not yet enqueue actions. This document is the strategy the next phase will execute.

The mobile field-staff experience ([src/views/mobile/Home.jsx](../src/views/mobile/Home.jsx), [src/views/mobile/MobileModules.jsx](../src/views/mobile/MobileModules.jsx)) is the primary surface that needs to keep working on patchy 3G/4G and dead zones — basements, lift shafts, sites with poor signal. The desktop admin does not need offline; admins work in offices with stable connectivity.

---

## 1. Installable PWA requirements

To be installable on Android, iOS, and desktop browsers, the manifest must declare:

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| `name`            | EstateFlow CRM                                                         |
| `short_name`      | EstateFlow                                                             |
| `start_url`       | `/` (single root; no `?utm_source=` query strings — install prompts require a clean URL). |
| `scope`           | `/` (the manifest must not be served from a deeper path or browsers will refuse install). |
| `display`         | `standalone` — full-screen, no browser chrome.                         |
| `orientation`     | `portrait-primary` (mobile shell is portrait-first; lock orientation on mobile). |
| `theme_color`     | `#0D7A5F` (brand green from [src/styles.css](../src/styles.css)).      |
| `background_color`| `#F7F5EF` (warm canvas from [src/styles.css](../src/styles.css)).      |
| `icons`           | At least one 192×192 PNG and one 512×512 PNG, both with `purpose: "any maskable"`. Placeholders are referenced from `public/manifest.webmanifest`; real artwork is a follow-up task. |
| `categories`      | `["business", "productivity"]`.                                        |
| `id`              | `/` (PWA uniqueness hint for Chromium; prevents the app being deduplicated with a sibling manifest later). |

In `index.html` the manifest is linked via `<link rel="manifest" href="/manifest.webmanifest">` and the page declares matching `<meta name="theme-color">` and `<meta name="apple-mobile-web-app-capable">` tags so iOS Safari renders the correct splash colour before the service worker takes over.

Install prompt strategy: do not auto-prompt. Show an in-app banner on the mobile shell after the user has performed at least three meaningful actions (check-in, photo upload, message send). Persist a `localStorage` flag so the prompt only appears once per device.

---

## 2. Mobile field-staff offline workflows

Five flows must keep working without connectivity:

1. **Check-in** — staff tap "Check in" at a site. GPS capture happens regardless of network; the action is queued and the UI shows "Pending sync" within seconds.
2. **Check-out** — symmetric to check-in. Computes `hoursWorked` from the local device clock; backend reconciles later.
3. **Visit update** — marking a visit complete, adding notes, rating, feedback. The lead context (lead name, project, phone) is already cached client-side from the last sync; staff can complete the visit without network.
4. **Photo upload** — staff photograph a site. The image is stored locally (as a Blob in IndexedDB — see §7); the metadata is queued immediately so the user gets a "queued" status; the actual upload happens when connectivity returns.
5. **Message send** — staff reply to a manager thread. The message is stored locally and queued. The thread recipient sees the message with a "pending sync" badge until the server acknowledges.

Two flows are explicitly *not* offline:

- **Lead creation** — leads require backend validation (duplicate phone detection, project availability) and benefit from server-generated ids. Offline creation is deferred to v2.
- **Permission matrix edits** — desktop admin only; not in scope.

---

## 3. Actions that must work offline

| Action           | Source view                         | Queued action type    |
| ---------------- | ----------------------------------- | --------------------- |
| Check-in         | [MobileHome onCheckIn](../src/views/mobile/Home.jsx)            | `attendance.checkIn`  |
| Check-out        | [MobileHome onCheckOut](../src/views/mobile/Home.jsx)           | `attendance.checkOut` |
| Mark visit done  | [MobileVisits](../src/views/mobile/MobileModules.jsx)            | `visit.update`        |
| Upload site photo| [MobilePhotos](../src/views/mobile/MobileModules.jsx)            | `photo.upload`        |
| Send message     | [MobileComms](../src/views/mobile/MobileModules.jsx)             | `message.send`        |

Each action's payload shape is defined in [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md). The contract is the source of truth — the queue function, the future sync worker, and the eventual API repository all read from it.

---

## 4. Sync lifecycle

Every queued action moves through four statuses. State transitions are explicit; the queue function is the only thing allowed to update them.

```text
         queueAction()
              │
              ▼
        ┌──────────┐  flush attempts it, network fails
        │ pending  │ ─────────────────────────────┐
        └──────────┘                              │
              │                                   │
              │ flush begins, network ok          │
              ▼                                   ▼
        ┌──────────┐                       ┌──────────┐
        │ syncing  │                       │  failed  │
        └──────────┘                       └──────────┘
              │                                   │
              │ server returns 2xx                │ user retries OR
              ▼                                   │ auto-retry on
        ┌──────────┐                               │ next online event
        │  synced  │                               │
        └──────────┘                               │
              │                                   │
              │ cleared by                        │
              │ clearSyncedActions()              │
              ▼                                   │
        (removed from queue)                      │
                                                 │
                       retry                     │
        pending  ◀────────────────────────  failed
```

Status meanings:

- **pending** — queued, not yet attempted. Eligible for the next sync sweep.
- **syncing** — a worker has the action and is talking to the server. Mutating this is idempotent; if the worker crashes, the next sweep will reset to pending after a heartbeat timeout (60 s default).
- **synced** — server returned 2xx. Eligible for `clearSyncedActions()`.
- **failed** — server returned a non-retriable error, or retriable error after `maxAttempts`. Stays in queue until user retries or a manual `markActionPending(id)` is called.

Sync triggers (the worker checks the queue on each of these):

- `online` window event (immediate).
- App `visibilitychange` to visible.
- Periodic background sync (Chromium only — needs `periodic-background-sync` permission on install).
- Manual trigger from a "Sync now" button in the mobile drawer.

The first three are wired in the next phase when the service worker gains a `sync` event handler.

---

## 5. Conflict handling

Offline mutations conflict with server state when the server record has changed between the last successful read and the queued write. The CRM has three conflict shapes:

### Last-write-wins (default)

For status flags (`checkOut`, `visit.status`, `message.read`) the server's last accepted timestamp wins. The queue worker posts the queued change; if the server returns 409, the worker overwrites with the queued payload *and* logs to `audit_log` with `metadata.conflictResolution: 'client-overwrite'`. Acceptable because the client is the source of operational truth for that field (a field executive is the only one who can mark a visit complete).

### Server-authoritative

For `attendance.checkIn` on a day that already has an open record, the server is authoritative. The server returns the existing open record; the client replaces its local optimistic record and surfaces a toast: "Your check-in was merged with an existing record."

For `attendance.checkOut`, the server computes `hoursWorked` from server-side timestamps when possible; the client's value is sent as `clientHoursWorked` for reconciliation but the server's value is canonical.

### Manual resolution

Lead ownership reassignment is the only field where manual resolution is required. If staff A marks a visit complete on a lead that staff B has been reassigned to, the server returns 409 with `{ error: 'lead-reassigned', newOwnerId }`. The client surfaces this as "This lead was reassigned. Open it to continue." and does not retry.

---

## 6. GPS timestamp vs server timestamp strategy

Field executives carry devices with drifting clocks; some operators manually set their phone time. The CRM must not trust the device clock for compliance-relevant timestamps.

### Source of truth

For **check-in / check-out**, the server's `receivedAt` is the canonical timestamp. The client's `clientTimestamp` is preserved as `metadata.deviceTime` for audit but never used for `hoursWorked` calculation.

### Why

A field executive could check out at 6 PM device-local time after their actual 5 PM shift end. Using the device clock for `hoursWorked` would understate hours worked. The server's `receivedAt` (set when the server accepts the request) is monotonic per user and immune to device clock drift.

### Clock skew detection

If `Math.abs(serverTime - clientTime) > 5 minutes`, the queue worker flags the action with `metadata.clockSkew = true` and emits a non-blocking diagnostic event. The action still succeeds, but the audit trail shows the drift.

### Display

The mobile shell shows "Checked in 2 hours ago" using the device clock (for human comfort). The server reports use the server timestamp. The audit log shows both.

---

## 7. Photo upload retry strategy

Photos are larger than other queued payloads (often 2-8 MB). They need a separate retry path:

### Storage

- Each `photo.upload` action stores the image Blob in IndexedDB under a key derived from the queue item id (`photo-{id}`). IndexedDB can hold the binary; localStorage cannot.
- The queue's `payload` carries only the IndexedDB key plus metadata. When the queue worker flushes, it reads the Blob from IndexedDB, computes the SHA-256 checksum, and posts to the S3 presigned URL.

### Retry policy

- Exponential backoff: 10 s, 30 s, 2 min, 5 min, 30 min, then give up to "failed".
- Resume from partial upload: if S3 supports multipart, the client uploads parts sequentially and resumes from the last successful part id, stored in the queue item's `metadata.lastPartIndex`.
- Quota exhaustion: if the device reports `QuotaExceededError` while storing the Blob, the queue worker surfaces an in-app alert "Storage is full. Free up space or sync existing photos." Photos remain queued but are not retrying.

### Cleanup

Once the server confirms the photo record is created, the queue worker deletes the Blob from IndexedDB. If the queue worker crashes mid-cleanup, a startup hook reaps orphaned Blobs whose queue ids are no longer in the queue.

---

## 8. Notification strategy

Three classes of notification:

### Install prompt

A single in-app banner on the mobile shell after the third successful action (see §1).

### Sync status

A small dot in the mobile bottom nav showing pending count. Tapping it opens a "Sync queue" drawer with each pending action and its status. No push notifications for sync — they're too noisy.

### Server-pushed events

For manager messages and reassignments, the service worker uses the Push API (with `push` permission requested only after the user opts in via a settings toggle). The push payload is a notification envelope, not the full message body — the SW opens IndexedDB, fetches the full message, and shows a notification. Payload encryption uses `aes-128-gcm` with a per-device key derived at install time; the key never leaves the device.

### Permission gating

| Permission              | When requested                              |
| ----------------------- | ------------------------------------------- |
| `geolocation`           | First check-in tap.                         |
| `notifications`         | After the user enables "Push for messages" in settings. |
| `periodic-background-sync` | At install, only if the browser supports it. |
| `camera`                | First "Capture photo" tap.                  |

The mobile shell never asks for `geolocation` upfront; only when the user actually checks in.

---

## 9. Security & privacy

### GPS

- GPS coordinates are **permitted only for staff with the `attendance.create` scope**; the permission system ([src/data/permissions.js](../src/data/permissions.js)) already enforces this for the action, but the queue worker must also check before flushing a queued check-in — a permission downgrade after queueing should not silently leak location.
- GPS coordinates are stored in the audit log, not just on the attendance record, so a tampered attendance row is detectable.
- Photos are EXIF-stripped by the backend during processing (see [docs/BACKEND_INTEGRATION_PLAN.md §5](BACKEND_INTEGRATION_PLAN.md)). The client also strips EXIF before queuing to fail safe.
- GPS accuracy is reported with every capture (`accuracy` field). Captures with `accuracy > 100 m` are surfaced with a "Low GPS confidence" badge.

### Photos

- Photos in IndexedDB are encrypted at rest using the Web Crypto API with a key derived from the user's auth token. The key is held only in memory after login and re-derived on app launch.
- Photos are never written to the OS camera roll automatically. The capture flow uses an `<input type="file" capture="environment">` so the user controls save behaviour in the OS camera app.

### Auth

- Refresh tokens are stored in IndexedDB (not localStorage) so they survive a service-worker reload.
- A queued action carries the auth context (user id) but **never** the access token. The flush worker re-acquires a fresh access token at flush time. Stale tokens in the queue are a non-issue.
- When the auth session expires while actions are queued, the worker pauses flush, surfaces a "Sign in again to sync" banner, and resumes when re-auth completes.

### Network exposure

- The service worker never caches CRM collection responses (leads, visits, attendance) — only the app shell. This avoids leaking data through a service worker cache shared across users on shared devices.
- The service worker never logs request bodies or response bodies.

---

## 10. Roadmap

| Phase  | Deliverable                                                            |
| ------ | ---------------------------------------------------------------------- |
| Done   | Manifest + service worker scaffolding.                                 |
| Done   | `offlineQueue` API in [src/services/offlineQueue.js](../src/services/offlineQueue.js). |
| Next   | Wire `queueAction()` into the five flows listed in §3.                  |
| Next   | Service worker `sync` event handler that drives the flush worker.      |
| Next   | IndexedDB adapter for photo Blob storage.                              |
| Next   | Push notification envelope + decryption.                                |
| Later  | Last-write-wins / manual conflict UI.                                   |
| Later  | Lead creation offline (requires duplicate-phone detection in queue).   |

Until the "Next" phases are wired, the queue API exists but is unused — the demo flows continue to write synchronously through the in-memory reducer.
