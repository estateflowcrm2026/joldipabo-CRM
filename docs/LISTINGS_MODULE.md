# Listings module (Inventory)

The Listings module is Joldipabo's first-class surface for properties — every
rent, PG, land, office, resale, or owner-listed unit has a row. Sales managers,
site managers, channel partners, accounts, and field executives all see a
different slice of the same inventory.

This document captures the contract, permission model, demo data shape, and
backend wiring steps so the future `apiRepository` swap is a one-line change.

## Resources and scopes

| Resource key | Constant | Notes |
|---|---|---|
| `listings` | `RESOURCES.LISTINGS` | Single resource for all six categories. |

Permission actions follow the existing `ACTIONS` set:

| Action | Used by |
|---|---|
| `view` | Sidebar nav, list views, dashboard sections, mobile module |
| `create` | "New listing" button, mobile capture sheet |
| `edit` | Detail drawer (inline edit) |
| `assign` | "Reassign" / "Assign" actions |
| `approve` | "Verify" action on the listing |
| `export` | Reserved for the future CSV/Excel export |
| `delete` | "Mark off-market" soft delete |

### OWN-scope extension

The generic `can()` helper checks `record.ownerId === user.id`. Listings have
two ownership fields — `assignedTo` (the staff who manages the listing) and
`createdBy` (the staff who first captured it). For listing OWN-scope both
must count as "owned".

The extension is **the only place** `can()` reaches into a specific resource
name; everything else stays generic. It lives in
`src/data/permissions.js`:

```js
case SCOPES.OWN: {
  if (!user) return false;
  if (resource === RESOURCES.LISTINGS) {
    return Boolean(
      record.assignedTo === user.id || record.createdBy === user.id
    );
  }
  return record.ownerId === user.id;
}
```

`filterByScope` and `useVisible` inherit this automatically.

## Permission matrix

| role | view | create | edit | assign | approve | export | delete |
|---|---|---|---|---|---|---|---|
| super-admin | all | all | all | all | all | all | all |
| admin | all | all | all | all | all | all | all |
| sales-manager | team | all | team | team | team | team | team |
| site-manager | project | project | project | project | project | project | none |
| field-executive | own | all | own | none | none | own | none |
| telecaller | own | none | none | none | none | none | none |
| channel-partner-manager | team | team | team | team | team | team | team |
| accounts | all | none | none | none | none | all | none |

`super-admin` and `admin` get `all`; field executives get `own` view but
`all` create (so they can capture owner properties they go on to manage);
sales managers and CPMs get `team`; site managers get `project`; telecallers
read-only-OWN; accounts read-only-`all`.

## DTO shape

Each record follows the backend `server/db/schema/013_listings.sql` shape
verbatim. The same shape ships in `src/data/seed.js`:

```js
{
  id: 'list-001',
  tenantId: 'tenant-joldipabo',        // baked by the reducer — call sites omit it
  serviceCategory: 'rent',              // rent | pg | land | office | resale | owner-listed
  propertyType: '2BHK Apartment',
  listingIntent: 'rent-out',            // sell | rent-out | lease-out | list-pg | sell-plot | list-office
  title: '2BHK at Orchid Heights',
  description: 'Semi-furnished, 2 BHK facing east.',
  location: {
    address: 'Tower B, 12th floor, Orchid Heights, Whitefield',
    city: 'Bengaluru',
    locality: 'Whitefield',
    geo: { lat: 12.9698, lng: 77.7500, label: 'Orchid Heights' },
  },
  pricing: {
    price: null,                       // for sale / sell-plot
    rentMonthly: 45000,                 // for rent / pg
    deposit: 150000,
    maintenanceMonthly: 4000,
    areaSqft: 1180,
    pricePerSqft: null,
  },
  specs: {
    bedrooms: 2,
    bathrooms: 2,
    furnished: 'semi',                  // unfurnished | semi | full
    floor: 12,
    totalFloors: 22,
    parking: 1,
    amenities: ['Gym', 'Pool', 'Power backup'],
  },
  status: {
    availability: 'available',          // available | reserved | booked | off-market
    verification: 'verified',           // unverified | pending | verified | rejected
    verificationReason: null,
    verifiedBy: 'u-admin',
    verifiedAt: <iso>,
  },
  ownerContact: {
    name: 'Meera Iyer',
    phone: '+91 98456 11001',
    email: 'meera.iyer@example.com',
    relation: 'owner',                  // owner | agent | builder | family
  },
  assignedTo: 'u-fe-arjun',
  createdBy: 'u-fe-arjun',
  projectId: 'proj-orchid',
  photoCount: 6,
  notes: 'Pets allowed. Prefer working couple.',
  tags: ['furnished', 'east-facing'],
  createdAt: <iso>,
  updatedAt: <iso>,
}
```

## Lifecycle

Two state machines live on the same record:

### Availability (commercial lifecycle)

```
   ┌──────────┐   book   ┌─────────┐  sign   ┌────────┐
   │available ├─────────►│reserved ├────────►│booked  │
   └──┬───────┘          └────┬────┘         └────┬───┘
      │                        │                   │
      │ off-market             │ off-market        │ off-market
      ▼                        ▼                   ▼
                       ┌──────────────┐
                       │ off-market   │  (terminal soft-delete)
                       └──────────────┘
```

Soft delete: `actions.deleteListing(id)` flips `availability` to
`off-market` and bumps `updatedAt`. The reducer writes an activity log
entry (`deleted-listing`) but keeps the row — matches the backend's
"soft delete via status" semantics so the same UI works in API mode.

### Verification (audit lifecycle)

```
unverified ─► pending ─► verified
                │
                └──► rejected ─► pending (re-review)
```

`actions.verifyListing(id, decision, reason)` writes:

- `status.verification`
- `status.verificationReason` (when rejected)
- `status.verifiedBy = currentUser.id`
- `status.verifiedAt = now`

The activity log gets a verb matching the decision:

| Decision | Verb |
|---|---|
| `verified` | `verified-listing` |
| `rejected` | `rejected-listing` |
| `pending` | `verification-requested-listing` |

## Demo data index

Ten records cover all six categories, all four availability states, all four
verification states, and a mix of tenants/teams/owners:

| # | Category | Project | Tenant | Assignee | Availability | Verification |
|---|---|---|---|---|---|---|
| 1 | rent | proj-orchid | team-east | u-fe-arjun | available | verified |
| 2 | rent | proj-nexa | team-east | u-fe-neha | available | pending |
| 3 | pg | proj-nexa | team-east | u-fe-neha | available | verified |
| 4 | land | — | team-west | u-fe-kabir | available | pending |
| 5 | office | proj-skyline | team-west | u-fe-kabir | reserved | verified |
| 6 | resale | proj-parklane | team-hyd | u-cpm-mgr | available | verified |
| 7 | owner-listed | — | team-chennai | u-cpm-2 | available | unverified |
| 8 | rent | proj-marina | team-chennai | u-fe-kabir | booked | verified |
| 9 | pg | proj-orchid | team-east | u-fe-arjun | available | rejected |
| 10 | resale | proj-skyline | team-west | u-fe-kabir | off-market | verified |

This lets every role see at least a handful of listings, and lets the
verification/availability badges appear in every combination during demos.

## Routes and shells

### Desktop

- `src/layout/DesktopShell.jsx` adds `listings: Warehouse` to the `ICONS`
  map.
- `src/data/permissions.js` adds the resource to `NAV_RESOURCES` so the
  sidebar item appears for any role that has `view` access.
- `src/main.jsx` routes `RESOURCES.LISTINGS` to
  `<Listings />` from `src/views/desktop/Listings.jsx`.

### Mobile

- `src/layout/MobileShell.jsx` exposes `listings` as a 5th nav tab (alongside
  Home / Visits / Leads / Inbox). Photos drops from the bottom nav — it is
  still reachable from the MobileHome quick-action tile.
- `src/views/mobile/MobileModules.jsx` adds `<MobileListings>` with:
  - Filter pills by `serviceCategory`
  - "Add collected property" button (gated by `listings.create`)
  - Stacked cards with category pill, locality, price, verification badge,
    assignee avatar
  - Detail sheet (Modal) reusing the desktop drawer's contents
  - New-listing capture sheet (queues offline if needed)
- `src/views/mobile/Home.jsx` adds a "My listings" section showing the
  three most-recent available listings scoped to the current user.

## Backend wiring (future)

The backend already has `server/db/schema/013_listings.sql`. To activate the
real backend end-to-end:

1. Confirm `src/services/apiRepository.js` exposes:
   - `repo.list('listings', filters)`
   - `repo.get('listings', id)`
   - `repo.create('listings', payload)`
   - `repo.update('listings', id, changes)`
   - `repo.remove('listings', id)`
   - `repo.custom.listings.assign(id, staffId)`
   - `repo.custom.listings.verify(id, status, reason, verifiedBy)`

2. In `src/main.jsx` (or an `src/data/repositoryBootstrap.js`) call
   `setRepository(apiRepository)` once on startup. The desktop and mobile
   views pick up the new repository automatically because every list view
   goes through `useStore()` → `state.listings` and every mutator goes
   through the store reducer, which uses `repository` indirection (see
   `src/state/store.jsx` `guardedDispatch`).

3. Replace the demo `listing.capture` handler in
   `src/services/syncWorker.js` with a real implementation:
   ```js
   registerSyncHandler('listing.capture', async (item, { repo }) => {
     const owner = item.payload;
     const created = await repo.create('listings', {
       serviceCategory: owner.serviceCategory,
       propertyType: '2BHK Apartment',
       listingIntent: <derived>,
       title: `${owner.ownerName} — ${owner.locality || 'Owner listing'}`,
       location: { address: owner.locality, city: '', locality: owner.locality, geo: null },
       pricing: { rentMonthly: owner.askingPrice, /* ... */ },
       ownerContact: { name: owner.ownerName, phone: owner.ownerPhone, relation: 'owner' },
       assignedTo: item.metadata.userId,
       createdBy: item.metadata.userId,
       status: { availability: 'available', verification: 'unverified' },
       tags: [],
     });
     return created.record.id;
   });
   ```

4. Flip the env flag: `VITE_USE_API_REPOSITORY=true`. The list views and
   detail drawer continue to render unchanged because the DTO shape is
   already the backend shape.

## Offline capture flow

A field executive can capture an owner-listed property from the mobile app
while offline:

1. Tap **Listings** in the bottom nav → **Add collected property**.
2. Fill the minimal form (owner name + phone are required).
3. Submit → if offline, `queueListingCapture` adds a `listing.capture`
   item to the offline queue with a `listing.capture:{userId}:{ownerPhone}:{ms}`
   idempotency key.
4. The sync worker drains the queue when the user taps **Sync pending
   actions** (or, in the future, when `startAutoSync()` is wired up).
5. The demo handler validates the payload and marks the item `synced`
   without making a network call. The future apiRepository-backed worker
   will instead call `POST /api/v1/listings`.

See `docs/OFFLINE_QUEUE_CONTRACT.md` §4 for the queue type contract and
`docs/OFFLINE_WIRING_NOTES.md` §3 for the worker design.

## Files touched

| File | Purpose |
|---|---|
| `src/data/permissions.js` | Resource + matrix + nav + listings-aware OWN-scope |
| `src/data/seed.js` | 10-record seed + `findListing(id)` accessor |
| `src/services/demoRepository.js` | `listings` table + `custom.listings.{assign,verify}` |
| `src/state/store.jsx` | Reducer cases + `guardedDispatch` + `actions.{create,update,assign,verify,delete}Listing` |
| `src/services/offlineActions.js` | `queueListingCapture` typed helper |
| `src/services/syncWorker.js` | Default `listing.capture` demo handler |
| `src/views/desktop/Listings.jsx` | Desktop module |
| `src/views/mobile/MobileModules.jsx` | `MobileListings` + capture sheet |
| `src/views/mobile/Home.jsx` | "My listings" home section |
| `src/views/desktop/Dashboard.jsx` | Inventory pulse + verification pipeline |
| `src/main.jsx` | Desktop + mobile routing |
| `src/layout/DesktopShell.jsx` | `listings: Warehouse` icon |
| `src/layout/MobileShell.jsx` | `listings` as 5th nav tab |
| `src/styles.css` | Listing-specific styles |

## Cross-references

- **Lead ↔ Listing matching** — listings pair with leads through an explicit `leadListingMatches` relation with an automated score-suggestion pipeline. The matching module is documented in [docs/LEAD_LISTING_MATCHING.md](./LEAD_LISTING_MATCHING.md) and surfaces in both this drawer's **Interested leads** footer (read-only) and the desktop/mobile Lead drawer's **Matching listings** section. Site visits scheduled from a match carry a `listingId` source flag rendered as a chip on the visit card.

## Out of scope (deferred)

- Bulk operations (export, batch assign)
- Map view (the drawer already has an "Open in Maps" link using lat/lng)
- Listing → lead conversion
- Photo upload on listings (uses the existing `sitePhotos` flow today)
- Public MLS / external feed ingestion
- Hard delete (the soft-delete via `status.availability = 'off-market'`
  is the only delete path)

## Live mode (Phase 9C)

When the API repository is active (`VITE_USE_API_REPOSITORY=true`) the
Listings UI talks to the backend. Three things were reconciled to make that
path correct rather than merely quiet:

- **Write shape.** The UI builds the nested DTO (`location / pricing / specs /
  status / ownerContact`); the backend write validators take a FLAT body
  (`address`, `price`, `rentMonthly`, `bedrooms`, `ownerContactName`,
  `availabilityStatus`, …). Posting the nested object verbatim is accepted
  (2xx) and every nested field is silently dropped. `apiRepository.js` now
  flattens on create (`toBackendCreatePayload`) and patch (`toBackendPatch`),
  so owner contact, price, specs and location persist.
- **Read shape.** The backend emits `assignedTo` as `{ id, name, email }` and
  the project as `project`. `toFrontendListing` normalises `assignedTo` to an
  id string (what `can()`'s OWN scope and `filterByScope` compare) and adds
  `assignedToName` so the UI shows the real name.
- **Assignment is directory-backed.** `GET /api/v1/users` is the live staff
  directory (see [STAFF_DIRECTORY.md](./STAFF_DIRECTORY.md)), and
  `useAssignableStaff()` (`src/services/staffDirectory.js`) fetches it in
  live mode with loading / error / retry state. The Assign/Reassign
  controls and the create-form assignee picker offer real people; on
  directory failure they withhold the picker with a Retry affordance
  rather than offering seeded demo users whose ids 404. The create-form
  project picker stays demo-only — there is still no project directory
  endpoint, and seed project ids do not exist in the backend.

The offline `listing.capture` queue item replays against `POST /api/v1/listings`
and is marked synced only once the backend confirms (see
[docs/OFFLINE_WIRING_NOTES.md](./OFFLINE_WIRING_NOTES.md)).

The browser smoke for all of the above is `scripts/browser-smoke-listings.mjs`
(`npm run smoke:listings`).
