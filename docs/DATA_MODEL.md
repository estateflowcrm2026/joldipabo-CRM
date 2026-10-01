# Joldipabo CRM — Data Model

Date: 2026-09-23

This document is the source of truth for the data shapes the frontend consumes and that a backend must serve. The frontend's seed data ([src/data/seed.js](../src/data/seed.js)) and the runtime store ([src/state/store.jsx](../src/state/store.jsx)) implement these shapes today; a backend service must serve the same shapes verbatim so the UI does not need to change when the demo is replaced with a real API.

Joldipabo is a multi-vertical real estate operations CRM. It supports **rent, PG / hostel, buy residential, sell residential, land buy/sell, office / commercial / shop / warehouse**, and **owner / landlord direct listings** alongside the existing **new-apartment project sales** flow. The existing Projects, Leads, and Site Visits entities continue to model the new-sale vertical. The new Listings entity and its photos/documents/amenities cover every other vertical. A single lead can be tied to a project's units (legacy field `projectId`) or to one or more Listings (`matchedListingIds`).

Conventions used below:

- `id` is always a string. IDs are stable; the client treats them as opaque.
- Timestamps are ISO-8601 strings in UTC unless explicitly typed (date-only `YYYY-MM-DD`).
- Enums are lowercase string literals, never integers.
- Foreign keys are the same string IDs as their referenced records.
- Arrays of related records (e.g. `user.projectIds`) are denormalised for read convenience; the source of truth is the join on the foreign key.
- Soft delete: no record is hard-deleted in the demo. `deletedAt` is reserved for the backend.
- Multi-tenant: every domain table carries a `tenantId` foreign key into the tenant (organisation) record. RLS policies are expected to scope reads by `current_setting('app.tenant_id')`. Scope filters (`own | team | project | all`) are applied in SQL `WHERE` clauses by the data layer; see [server/src/rbac/scopeFilters.js](../server/src/rbac/scopeFilters.js).

---

## Users

| Field        | Type                         | Notes                                                          |
| ------------ | ---------------------------- | -------------------------------------------------------------- |
| `id`         | string                       | Stable user ID.                                                |
| `name`       | string                       | Display name.                                                  |
| `email`      | string                       | Unique.                                                        |
| `phone`      | string                       | E.164 or local; UI builds tel/WhatsApp links.                  |
| `role`       | enum (RoleId)                | Foreign key into Roles.                                        |
| `teamId`     | string \| null               | Foreign key into Teams. `null` for unassigned.                 |
| `projectIds` | string[]                     | Foreign keys into Projects. Used for `project` scope.          |
| `designation`| string                       | Display title.                                                 |
| `status`     | `Active` \| `Inactive` \| `On Leave` | Operational status.                                  |
| `joinedAt`   | ISO timestamp                | Hire date.                                                     |
| `permissionMatrix` | object (see Roles)    | Per-user matrix overrides. May be omitted; defaults to role's. |

---

## Roles

System roles (`super-admin`, `admin`) are protected; custom roles are user-creatable.

| Field         | Type    | Notes                                                                |
| ------------- | ------- | -------------------------------------------------------------------- |
| `id`          | string  | URL-safe slug, e.g. `sales-manager`, `field-executive`.              |
| `name`        | string  | Display name.                                                        |
| `description` | string  | One-line purpose.                                                    |
| `color`       | string  | Hex token for UI badges.                                             |
| `accent`      | string  | Hex token for UI accents.                                            |
| `isSystem`    | boolean | `true` for built-ins — these cannot be deleted or fully overwritten. |

`ROLE_DEFINITIONS` in [src/data/permissions.js](../src/data/permissions.js) lists the 8 seeded roles.

---

## Permissions

Permissions are a 3-level structure: **role → resource → action → scope**. There is no separate `permissions` table; permissions live on the role's `permissionMatrix`.

```text
permissionMatrix: {
  leads:     { view: 'all',   create: 'team',  edit: 'team',  ... },
  listings:  { view: 'team',  create: 'all',   edit: 'own',   approve: 'team', export: 'all', ... },
  visits:    { view: 'project', ... },
  photos:    { view: 'own', ... },
  ...
}
```

- **Resource:** one of `dashboard | leads | listings | staff | roles | attendance | visits | photos | communications | reports | projects`. (11 resources as of 2026-09-23; `listings` was added to cover rent / PG / land / office / commercial / owner-listed verticals.)
- **Action:** one of `view | create | edit | assign | approve | export | delete`. The `approve` action also covers listing verification.
- **Scope:** one of `none | own | team | project | all`. Determines which records the action applies to. For `listings`, `project`-scoped principals see only listings whose `project_id` is in their `user.projectIds`; `team`-scoped principals see only listings in their `team_id`; `own`-scoped principals see only listings where they are the assigned field executive (`assigned_to = user.id`).

`DEFAULT_PERMISSION_MATRIX` in [src/data/permissions.js](../src/data/permissions.js) is the seeded per-role default. Admins can edit non-system role matrices at runtime; those edits become the role's stored matrix.

`can(user, resource, action, record)` is the canonical scope check. Backend must implement an equivalent function — never trust the frontend's gate alone.

---

## Projects

`Projects` is retained as the **new-apartment sales** entity. It is unchanged. Listings live alongside it for every other vertical.

| Field            | Type        | Notes                                                |
| ---------------- | ----------- | ---------------------------------------------------- |
| `id`             | string      | Stable project ID.                                   |
| `name`           | string      | Display name.                                        |
| `code`           | string      | Short project code (used in staff cards).            |
| `city`           | string      | City.                                                |
| `location`       | string      | Free-form area / address.                            |
| `stage`          | string      | `Pre-launch` \| `Booking open` \| `Possession soon` \| ... |
| `totalUnits`     | integer     | Total unit count.                                    |
| `availableUnits` | integer     | Units still on the market.                           |
| `priceRange`     | string      | Pre-formatted display string.                        |
| `image`          | string      | URL or relative path to cover image.                 |
| `managerId`      | string      | Foreign key into Users (typically a Site Manager).   |
| `amenities`      | string[]    | Bullet list.                                         |
| `reraNumber`     | string      | Regulatory registration number.                      |
| `possessionDate` | date        | Target handover date.                                |
| `type`           | string      | `Residential` \| `Luxury Residential` \| `Ultra Luxury` \| `Commercial` \| `Plot`. |

---

## Teams

| Field     | Type    | Notes                          |
| --------- | ------- | ------------------------------ |
| `id`      | string  | Stable team ID.                |
| `name`    | string  | Display name.                  |
| `region`  | string  | Free-form region description.  |
| `leadId`  | string  | Foreign key into Users (team lead). |

---

## Listings

`Listings` is the property catalogue for every vertical that is **not** a new-apartment project. It covers rent, PG / hostel beds and rooms, buy / sell residential, land parcels, office / commercial / shop / warehouse units, and direct owner / landlord listings. Listings are optionally attached to a Project (e.g. resale of a unit in an existing project); a row in `listings` with `projectId IS NULL` is a fully independent owner-listed property.

| Field                | Type                                              | Notes                                                                                       |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                 | string                                            | Stable listing ID (ULID).                                                                   |
| `tenantId`           | string                                            | Foreign key into the tenant organisation.                                                  |
| `serviceCategory`    | enum                                              | `rent` \| `pg` \| `buy` \| `sell` \| `land` \| `office` \| `commercial`. Drives dashboards + search faceting. |
| `propertyType`       | enum                                              | `apartment` \| `independent_house` \| `villa` \| `pg_bed` \| `pg_room` \| `land_parcel` \| `office` \| `shop` \| `warehouse` \| `plot`. |
| `listingIntent`      | enum                                              | `available_for_rent` \| `available_for_sale` \| `wanted` \| `client_requirement`. `wanted` and `client_requirement` capture buyer / tenant demand expressed as a listing. |
| `title`              | string                                            | Display title (e.g. "3BHK in Indiranagar with parking").                                    |
| `description`        | string                                            | Free-form.                                                                                  |
| `address`            | string                                            | Street address / building / landmark.                                                       |
| `city`               | string                                            | City.                                                                                       |
| `locality`           | string                                            | Neighbourhood / micro-market. Used as a filter and a dashboard dimension.                  |
| `geo`                | object \| null                                    | `{ lat: number, lng: number, accuracy?: number }` for map pins and proximity search.        |
| `price`              | number \| null                                    | Sale price (INR). Relevant for `buy`, `sell`, `land`, `commercial` sale intents.            |
| `rentMonthly`        | number \| null                                    | Monthly rent. Relevant for `rent`, `pg`, `office`, `commercial` lease intents.              |
| `deposit`            | number \| null                                    | Refundable deposit (months of rent or absolute INR).                                        |
| `areaSqft`           | number \| null                                    | Carpet / built-up area (sq ft).                                                             |
| `bedrooms`           | integer \| null                                   | 0 for studios, PG beds, land, commercial.                                                   |
| `bathrooms`          | integer \| null                                   | Number of bathrooms.                                                                        |
| `furnished`          | `unfurnished` \| `semi` \| `fully` \| null         | Furnishing status.                                                                          |
| `amenities`          | string[] / JSON                                   | Free-form amenity tags (e.g. `['Parking', 'Gym', '24x7 water']`). JSONB-backed.            |
| `availabilityStatus` | `available` \| `booked` \| `occupied` \| `withdrawn` | Operating lifecycle.                                                                      |
| `verificationStatus` | `unverified` \| `pending` \| `verified` \| `rejected` | Set by an admin / manager via `POST /listings/:id/verify`.                               |
| `ownerContactName`   | string                                            | Owner / landlord / seller contact name. Not a User FK — these are external parties.         |
| `ownerContactPhone`  | string                                            | Owner / landlord / seller phone.                                                            |
| `ownerContactEmail`  | string \| null                                    | Optional.                                                                                   |
| `assignedTo`         | string \| null                                    | Foreign key into Users. The field executive or partner collecting / managing this listing.  |
| `projectId`          | string \| null                                    | Optional FK into Projects. Set when the listing belongs to a new-sale project.             |
| `teamId`             | string \| null                                    | FK into Teams. Used by `team`-scoped principals.                                            |
| `notes`              | string                                            | Internal notes.                                                                             |
| `createdBy`          | string                                            | FK into Users.                                                                              |
| `createdAt`          | ISO timestamp                                     | Server-generated.                                                                           |
| `updatedAt`          | ISO timestamp                                     | Server-managed.                                                                             |
| `deletedAt`          | ISO timestamp \| null                             | Soft delete tombstone.                                                                      |

Indexes (see [server/src/db/indexes.sql §listings](../server/src/db/indexes.sql)): `(tenant_id, service_category)`, `(tenant_id, listing_intent)`, `(tenant_id, city)`, `(tenant_id, assigned_to)`, `(tenant_id, verification_status)`, plus partial indexes excluding `deleted_at IS NOT NULL`.

### Listing Photos

| Field         | Type                                                | Notes                                                            |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `id`          | string                                              | Stable photo ID.                                                 |
| `tenantId`     | string                                              | FK into tenant.                                                  |
| `listingId`   | string                                              | FK into Listings.                                                |
| `staffId`     | string                                              | FK into Users (uploader).                                        |
| `objectKey`   | string                                              | Object-storage key (S3 / GCS / equivalent).                      |
| `publicUrl`   | string                                              | Resolved CDN URL.                                                |
| `thumbnailUrl`| string \| null                                      | Optional smaller variant.                                        |
| `caption`     | string                                              | Short label.                                                     |
| `category`    | `Interior` \| `Exterior` \| `Amenities` \| `Floor Plan` \| `Document Cover` \| `Other` | Asset bucket. |
| `approved`    | boolean                                             | Review flag — gated by `listings:approve` before public view.    |
| `approvedBy`  | string \| null                                      | FK into Users (reviewer).                                        |
| `uploadedAt`  | ISO timestamp                                       | Server-generated.                                                |
| `processedAt` | ISO timestamp \| null                               | Set once the image pipeline (resize, blurhash) finishes.          |
| `deletedAt`   | ISO timestamp \| null                               | Soft delete.                                                     |

### Listing Documents

| Field         | Type     | Notes                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`          | string   | Stable document ID.                                                                         |
| `tenantId`    | string   | FK into tenant.                                                                             |
| `listingId`   | string   | FK into Listings.                                                                           |
| `name`        | string   | Display name (e.g. "Owner ID proof", "Rent agreement draft").                               |
| `objectKey`   | string   | Object-storage key.                                                                         |
| `mimeType`    | string   | PDF / image / etc.                                                                          |
| `uploadedBy`  | string   | FK into Users.                                                                              |
| `uploadedAt`  | ISO timestamp | Server-generated.                                                                       |
| `deletedAt`   | ISO timestamp \| null | Soft delete.                                                                       |

### Listing Matches (lead ↔ listing)

Soft many-to-many between Leads and Listings, populated by `listings` and `leads` flows:

| Field          | Type     | Notes                                                                                                |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`           | string   | Stable match ID.                                                                                     |
| `tenantId`     | string   | FK into tenant.                                                                                      |
| `leadId`       | string   | FK into Leads.                                                                                       |
| `listingId`    | string   | FK into Listings.                                                                                    |
| `matchScore`   | number \| null | Optional relevance (0-100). Mainly for ranking.                                               |
| `matchedAt`    | ISO timestamp | When the match was made (auto-suggest or manual).                                               |
| `matchedBy`    | string \| null | FK into Users when manually matched. `null` for automatic matching.                          |
| `status`       | `suggested` \| `viewed_by_lead` \| `visit_scheduled` \| `rejected_by_lead` \| `withdrawn` | Lifecycle of a match. |
| `note`         | string \| null | Internal note.                                                                              |

The Leads entity also stores a denormalised `matchedListingIds: string[]` for fast reads.

---

## Leads

`Leads` is extended to cover every vertical. The legacy `projectId` field stays for new-sale leads; new fields model rent/PG/buy/sell/land/office demand.

| Field                 | Type                                                                        | Notes                                                                                                  |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`                  | string                                                                      | Stable lead ID.                                                                                        |
| `name`                | string                                                                      | Display name.                                                                                          |
| `phone`               | string                                                                      | Primary phone.                                                                                         |
| `email`               | string \| null                                                              | Optional.                                                                                              |
| `serviceNeed`         | enum                                                                        | `rent` \| `pg` \| `buy` \| `sell` \| `land` \| `office` \| `commercial` \| `project_buy`. **Required** when `clientType` is set. |
| `clientType`          | enum                                                                        | `tenant` \| `buyer` \| `seller` \| `landlord` \| `investor` \| `business`. Classifies the counter-party. |
| `requirements`        | object                                                                      | Free-form per-vertical requirements (e.g. `{ furnished: true, pets: 'friendly', parking: 1 }` for rent). |
| `budgetMin`           | integer \| null                                                             | INR. Lower bound of either sale budget or rent budget.                                                 |
| `budgetMax`           | integer \| null                                                             | INR. Upper bound of sale budget.                                                                       |
| `rentMin`             | integer \| null                                                             | INR / month. Lower bound of rent range.                                                                |
| `rentMax`             | integer \| null                                                             | INR / month. Upper bound of rent range.                                                                |
| `preferredLocation`   | string \| null                                                              | Free-form locality / city hint.                                                                        |
| `desiredPropertyType` | enum                                                                        | `apartment` \| `independent_house` \| `villa` \| `pg_bed` \| `pg_room` \| `land_parcel` \| `office` \| `shop` \| `warehouse` \| `plot`. |
| `moveInDate`          | date \| null                                                                | Tenant target move-in date.                                                                            |
| `purchaseTimeline`    | `immediate` \| `within_3_months` \| `within_6_months` \| `within_12_months` \| `exploratory` \| null | Buyer / investor timeline.                                                                  |
| `matchedListingIds`   | string[]                                                                    | Foreign keys into Listings. Populated by the matching service.                                         |
| `projectId`           | string \| null                                                              | Foreign key into Projects (legacy new-sale path). Still the right FK for `serviceNeed = 'project_buy'`.|
| `status`              | `New` \| `Contacted` \| `Site Visit Scheduled` \| `Visit Done` \| `Negotiation` \| `Booked` \| `Lost` | Pipeline status. |
| `visitStatus`         | `no_visit_planned` \| `visit_planned` \| `visit_completed` \| `visit_cancelled` \| `no_show` \| null | Rolled up from the most recent Site Visit, or null when no visits have been scheduled. |
| `score`               | `hot` \| `warm` \| `cold`                                                   | Lead temperature.                                                                                      |
| `source`              | string                                                                      | `Walk-in` \| `Referral` \| `Website` \| `Meta Ads` \| `Channel Partner` \| `Direct` \| custom.        |
| `notes`               | string                                                                      | Free-form.                                                                                             |
| `ownerId`             | string \| null                                                              | Foreign key into Users. Drives `own`/`team` scope checks.                                             |
| `teamId`              | string \| null                                                              | Foreign key into Teams.                                                                                |
| `createdAt`           | ISO timestamp                                                               | Server-generated.                                                                                      |
| `createdBy`           | string                                                                      | Foreign key into Users.                                                                                |
| `nextFollowUp`        | ISO timestamp \| null                                                       | Scheduled next contact.                                                                                |

`ownerId` and `teamId` are what scope checks resolve against. Backend must populate both on create/assign. New-sale leads keep the legacy `budgetMin / budgetMax` shape; rent / PG / commercial leads populate the `rentMin / rentMax` pair instead.

---

## Site Visits

`Site Visits` is reused for **every vertical**. A visit is tied to a `projectId` for new-sale tours, or to a `listingId` for rent / PG / resale / commercial tours. The visit retains its original shape; new fields are optional.

| Field         | Type                                                              | Notes                                                                                       |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`          | string                                                            | Stable visit ID.                                                                            |
| `leadId`      | string                                                            | FK into Leads.                                                                              |
| `projectId`   | string \| null                                                    | FK into Projects (new-sale tours). One of `projectId` / `listingId` must be set.            |
| `listingId`   | string \| null                                                    | FK into Listings (rent / PG / resale / office / land tours). Optional.                       |
| `assignedTo`  | string                                                            | FK into Users (executive).                                                                  |
| `scheduledAt` | ISO timestamp                                                     | Planned visit time.                                                                         |
| `status`      | `Scheduled` \| `In Progress` \| `Completed` \| `Cancelled` \| `No Show` | Operational status.                                                                  |
| `notes`       | string                                                            | Pre-visit notes.                                                                            |
| `rating`      | integer \| null                                                   | 1-5, set on completion.                                                                     |
| `feedback`    | string \| null                                                    | Set on completion.                                                                          |
| `completedAt` | ISO timestamp \| null                                             | Set on completion.                                                                          |

---

## Attendance

| Field             | Type                          | Notes                                                                |
| ----------------- | ----------------------------- | -------------------------------------------------------------------- |
| `id`              | string                        | Stable record ID.                                                    |
| `staffId`         | string                        | Foreign key into Users.                                              |
| `date`            | date (`YYYY-MM-DD`)           | Local calendar day.                                                  |
| `checkIn`         | ISO timestamp                 | First check-in of the day.                                           |
| `checkOut`        | ISO timestamp \| null         | Set on check-out.                                                    |
| `checkInLocation` | object \| null                | `{ label, lat, lng, accuracy }`.                                     |
| `checkOutLocation`| object \| null                | Same shape as `checkInLocation`.                                     |
| `checkInSiteId`   | string \| null                | Project / Listing visited if on-site.                                |
| `checkOutSiteId`  | string \| null                | Same.                                                                 |
| `status`          | `Checked In` \| `On Field` \| `Late` \| `Checked Out` \| `Approved` | Operational status.                          |
| `approvedBy`      | string \| null                | Foreign key into Users (approver).                                   |
| `hoursWorked`     | number \| null                | Computed on check-out.                                               |

---

## Site Photos

> **DEPRECATED 2026-09-28.** The `photos` table is project-scoped, holds
> **0 rows**, and is unreachable: migration
> [`011-photos-deprecated.sql`](../server/src/db/011-photos-deprecated.sql)
> gave it an always-false RLS policy and revoked every `estateflow_app`
> privilege on it. It is described here because it is still part of the
> schema, not because anything should use it.
>
> **Use [`listing_photos`](#listing-photos) instead.** Two media tables
> with different scoping is how this gap existed: `photos` had no
> tenant policy while `listing_photos` did, so a future route against the
> wrong one would have bypassed isolation silently. Consolidating on
> `listing_photos` — and treating project-scoped media, if it is ever
> required, as a column or a join rather than a second table — is the
> intended end state. See
> [RLS_ROLLOUT_PLAN.md §8](RLS_ROLLOUT_PLAN.md).

Site photos model construction / amenity photos tied to a project. They are a separate stream from `Listing Photos`.

| Field         | Type                                                | Notes                                                            |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `id`          | string                                              | Stable photo ID.                                                 |
| `projectId`   | string                                              | Foreign key into Projects.                                       |
| `staffId`     | string                                              | Foreign key into Users (uploader).                               |
| `category`    | `Progress` \| `Amenities` \| `Inventory` \| `Handover` \| `Marketing` | Asset bucket.                            |
| `caption`     | string                                              | Short label.                                                     |
| `url`         | string                                              | Public URL or relative path. Backend stores object-storage URL.  |
| `geo`         | object \| null                                      | `{ lat, lng }`.                                                  |
| `uploadedAt`  | ISO timestamp                                       | Server-generated.                                                |
| `approved`    | boolean                                             | Review flag.                                                     |
| `approvedBy`  | string \| null                                      | Foreign key into Users (reviewer).                               |

---

## Communication Threads and Messages

Threads are 1-to-1 (or small group) conversations between users. Messages belong to exactly one thread.

### Threads

| Field            | Type     | Notes                                                  |
| ---------------- | -------- | ------------------------------------------------------ |
| `id`             | string   | Stable thread ID.                                      |
| `participants`   | string[] | Foreign keys into Users. Always non-empty.             |
| `subject`        | string   | Optional display subject.                              |
| `lastMessageAt`  | ISO timestamp | Sorted by this in inbox views.                    |
| `unread`         | boolean  | Per-viewer flag — backend must scope per viewer.       |

### Messages

| Field        | Type     | Notes                                                            |
| ------------ | -------- | ---------------------------------------------------------------- |
| `id`         | string   | Stable message ID.                                               |
| `threadId`   | string   | Foreign key into Threads.                                        |
| `fromId`     | string   | Foreign key into Users.                                          |
| `body`       | string   | Message content (plain text in demo; HTML allowed in production with sanitisation). |
| `timestamp`  | ISO timestamp | Server-generated.                                            |
| `channel`    | `in-app` \| `email` \| `sms` \| `whatsapp` | Channel the message was sent on. |

---

## Audit Activity

Append-only activity log. Every mutating action writes one row.

| Field      | Type                                                | Notes                                                              |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `id`       | string                                              | Stable event ID.                                                   |
| `userId`   | string                                              | Foreign key into Users — actor who performed the action.           |
| `action`   | string                                              | Verb, e.g. `created-lead`, `checked-in`, `uploaded-photo`, `approved-photo`, `assigned-lead`, `created-listing`, `verified-listing`, `updated-listing`, `assigned-listing`, `rejected-listing`, `verification-requested-listing`, `uploaded-listing-photo`, `deleted-listing`. |
| `entity`   | string                                              | Type of affected record, e.g. `lead`, `visit`, `attendance`, `photo`, `role`, `user`, `listing`, `listing_photo`, `listing_document`. |
| `entityId` | string                                              | Foreign key into the affected record.                              |
| `metadata` | object                                              | Free-form payload — before/after diff, scope, IP, etc.             |
| `timestamp`| ISO timestamp                                       | Server-generated.                                                  |

`ACTIVITY` in seed is the demo's audit feed. The backend must persist this server-side for compliance; it must be tamper-evident.

---

## Dashboard / reporting concepts

Apartment-only dashboards continue to work from Projects + Leads + Visits + Photos. The following cross-vertical metrics are derived from Listings + Listings Matches + Visits + Leads with the new `serviceNeed` field. They are listed here so backend route planning can stub counters in `reports` or expose them through a future `GET /dashboards/landing`:

- Rental listings active — `count(listings where service_category = 'rent' and availability_status = 'available' and deleted_at IS NULL)` per tenant.
- PG beds / rooms available — `count(listings where service_category = 'pg' and availability_status = 'available')`. Beds vs rooms distinction depends on `property_type ∈ {pg_bed, pg_room}`.
- Land listings active — `count(listings where service_category = 'land' and availability_status = 'available')`.
- Office listings active — `count(listings where service_category = 'office' and availability_status = 'available')`.
- Commercial listings active — `count(listings where service_category = 'commercial' and availability_status = 'available')`.
- Owner properties collected — `count(listings where createdBy = user.id)` per field executive.
- Client enquiries by vertical — `count(leads where serviceNeed = X)` per service category.
- Site visits by vertical — `count(visits where listing.service_category = X)` — Visits are bucketed by the underlying Listing's `service_category`.
- Listing-to-deal conversion — leads that reach `status = 'Booked'` divided by leads matched to a listing (`matches.status NOT IN ('rejected_by_lead','withdrawn')`) per service category.
- Field-executive listing collection performance — listings collected, photos uploaded, verification rate, and visits closed per executive, all scoped to `assigned_to = user.id`.

---

## Index summary

These are the entities a backend service should expose. They map 1:1 onto URL endpoints in the backend plan.

| Entity            | Collection name     | Endpoint root               |
| ----------------- | ------------------- | --------------------------- |
| Users             | `users`             | `/api/v1/users`             |
| Roles             | `roles`             | `/api/v1/roles`             |
| Teams             | `teams`             | `/api/v1/teams`             |
| Projects          | `projects`          | `/api/v1/projects`          |
| **Listings**      | **`listings`**      | **`/api/v1/listings`**      |
| **Listing Photos**| **`listing_photos`**| **`/api/v1/listings/:id/photos`** — supported, RLS-protected |
| ~~Site Photos~~ | ~~`photos`~~ | deprecated 2026-09-28: empty, unreachable, use `listing_photos` |
| **Listing Documents**| **`listing_documents`**| internal (no public endpoint yet) |
| **Listing Matches**| **`listing_matches`**| internal (no public endpoint yet) |
| Leads             | `leads`             | `/api/v1/leads`             |
| Visits            | `visits`            | `/api/v1/visits`            |
| Attendance        | `attendance`        | `/api/v1/attendance`        |
| Photos            | `photos`            | `/api/v1/photos`            |
| Threads           | `threads`           | `/api/v1/threads`           |
| Messages          | `messages`          | `/api/v1/messages`          |
| Audit log         | `activity`          | `/api/v1/activity`          |
