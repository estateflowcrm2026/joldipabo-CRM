# Lead ↔ Listing Matching

Connects the existing **Lead** module ([src/views/desktop/Leads.jsx](../src/views/desktop/Leads.jsx)) and **Listings** module ([src/views/desktop/Listings.jsx](../src/views/desktop/Listings.jsx)) with an explicit relation plus an automated match-suggestion pipeline. A site visit can now be traced back to the listing that triggered it.

> **Status:** Demo implementation wired through `demoRepository`. The data shape and public function signature are designed to mirror the future `POST /api/v1/leads/:id/match-suggestions` endpoint and a `leadListingMatches` table on the Postgres backend.

---

## 0. Presentation Workflow

The headline demo story — every screen, button and chip in this phase serves this flow:

```
A client walks in / calls / fills the website form
        │
        ▼
Staff creates a Lead (project, unit type, budget, optional notes)
        │
        ▼
Staff opens the lead's detail drawer
        │
        ▼
The CRM ranks every in-scope listing against that lead's requirements
(city · project · locality · category · budget fit · property type)
        │
        ▼
Staff reviews "Matching listings" — only well-fitting ones (score ≥ 45),
no off-market, no incompatible categories
        │
        ▼
Staff taps "Match" on the right property — relation is recorded
(recommended → matched → visited → rejected lifecycle)
        │
        ▼
Staff taps "Schedule visit" — modal pre-attached with the listing
(project, notes pre-fill with "From listing match: <title>")
        │
        ▼
Visit lands on the Site Visits board. The visit card carries
a "Matched from listing X" chip so the audit trail is unbroken
        │
        ▼
Field-executive sees the visit on mobile, navigates to property,
calls owner, completes visit. Listing now has 'visited' status
in the match lifecycle.

   On the field, tapping a lead card opens the mobile lead sheet
   showing the top 3 ranked listings — each with Call / WhatsApp
   / Navigate / Schedule visit buttons for in-the-moment execution.
   No match management on mobile: just the field actions.
```

A new stakeholder reading this section first should be able to recite that flow back before reading any further.

---

## 1. Goals

- Connect the two first-class resources (Leads and Listings) with an explicit, persistable match relation.
- Auto-suggest listings from each lead's stated requirements, with hard filters preventing absurd pairings (4BHK buyer never sees a PG bed, etc.).
- Carry the listing context from match → visit so the audit trail isn't lost when a visit gets scheduled from a recommendation.
- Mobile-friendly top-3 in field workflows (no match-management UI on mobile; just field actions).

---

## 2. Data model — `leadListingMatches`

New table in [src/data/seed.js](../src/data/seed.js) (`MATCHES` array) and in [src/state/store.jsx](../src/state/store.jsx) (`state.matches`). Each row is one explicit lead-listing relation:

```js
{
  id:          string,         // makeId('match') — see store.jsx
  leadId:      string,         // state.leads[i].id
  listingId:   string,         // state.listings[i].id
  matchStatus: 'recommended' | 'matched' | 'rejected' | 'visited',
                             // recommended  — staff suggested this listing
                             // matched      — lead acknowledged, took it forward
                             // visited      — a visit was scheduled from this match
                             // rejected     — explicitly dropped
  score:       number,         // 0..100, captured at match time
  reason:      string,         // human-readable why, e.g. "Project, Budget, Property type — score 75/100"
  createdBy:   string,         // userId who created the relation
  createdAt:   ISO string,
  updatedAt:   ISO string,
}
```

**Storage semantics.** `score` and `reason` are computed at create time from the lead + listing as they stood then, and stored. Editing the lead or listing later does **not** retroactively change existing match reasons — the audit trail reflects the moment of decision.

**Uniqueness.** One match per `(leadId, listingId)`. Creating a second match for an existing pair refreshes the `matchStatus` (no duplicate rows). See [src/state/store.jsx](../src/state/store.jsx) `CREATE_MATCH` case.

---

## 3. Match-score algorithm

Two-stage pipeline implemented in [src/services/matchListings.js](../src/services/matchListings.js). Pure module — no React, no store.

### 3.1 Hard filters — drop before scoring

A listing is **excluded** from matches if any of these are true:

- `listing.status.availability !== 'available'` — so `off-market`, `booked`, **and** `reserved` are all dropped. A buyer must never see a reserved office or a booked villa as a recommendation.
- **Incompatible listing intent.** The lead's effective intent comes from `project.serviceCategory` mapped via `mapCategoryToIntent`:

  | `derivedIntent` | Compatible listing intents |
  | ---------------- | -------------------------- |
  | `rent`           | `rent-out`, `list-pg`      |
  | `sale`           | `sell`, `sell-plot`        |
  | `lease`          | `lease-out`, `rent-out`    |

  If the project has no recognisable category, `derivedIntent === null` and the intent filter is skipped — Signal #1 handles the case with a soft default instead of zero.

- **Off-budget by more than 30%.** If `listing.pricing.price` or `listing.pricing.rentMonthly × 12` is `> 1.30 × lead.budgetMax`, drop the listing.

If the hard-filter step empties the candidate pool, `rankLeadMatches` returns `[]` and the UI shows **"No strong matches yet"**. If there are 1–4 borderline listings in the 35–44 score range, the desktop lead drawer reveals them under a **"Show lower-confidence matches (n)"** footer; never below 35.

### 3.2 Scoring — weighted, capped at 100

After filtering, `scoreLeadListing(lead, listing, project)` returns `{ score, reason }`. Anything below the score floor of 45 is dropped.

| #  | Signal                                       | Weight | Notes |
| -- | -------------------------------------------- | -----: | ----- |
| 1  | Category alignment (intent match)            |     20 | Full intent match → 20. Missing intent (project has no `serviceCategory`) → 5 (soft default — we don't zero it out). |
| 2  | Same `projectId`                             |     30 | Strongest signal — explicit project interest. |
| 3  | `listing.location.city` matches derived      |     15 | Derived from `project.city` when available, else `null` → no signal. |
| 4  | `listing.location.locality` matches derived  |     10 | Derived from `project.location` ("Whitefield, Bengaluru" → "Whitefield"), else `null` → no signal. |
| 5  | Intent-aware budget fit                      | up to 15 | Rent/PG leads: `lead.budgetMax` vs `rentMonthly × 12`. Sale/land: `lead.budgetMax` vs `pricing.price`. Inside budget → 15, within 20% over → 8, else 0. |
| 6  | Property-type fuzzy match                    | up to 10 | Regex `/(\d+)\s*BHK/i`. Full match → 10, ±1 BHK → 5. |

`reason` is built by comma-joining the matched-signal names plus a trailing `"— score 75/100"`.

### 3.3 Lead-shape gap — calmer fallback

Today's lead has `unitType`, `budgetMin/Max`, `projectId`, but no `locality`, `city`, or `serviceCategory`. We **derive** those from the lead's project:

- `derivedCity = project?.city`
- `derivedLocality = project.location.split(',')[0]` (handles "Whitefield, Bengaluru")
- `derivedIntent = mapCategoryToIntent(project?.serviceCategory)`, else `null`

`null` is **never zeroed**. It triggers the soft default path in Signal #1 (5/20) and zero in Signals #3 and #4. This avoids silently hiding listings when the seed is incomplete.

### 3.4 Public API

```js
// Pure, no React, no store.
scoreLeadListing(lead, listing, project) → { score: number, reason: string }

// Hard filter → score → filter score < 45 → sort desc → cap topN.
rankLeadMatches(lead, listings, projects, { topN = 10 } = {}) → Array<{ listing, score, reason }>

// Same as rankLeadMatches but with a lower floor (35) — used only by the
// desktop lead drawer's "Show lower-confidence matches (n)" footer.
rankLeadMatchesLoose(lead, listings, projects, { topN = 5, minScore = 35 } = {}) → Array
```

`rankLeadMatches` is the single entry point the UI uses. The desktop lead drawer renders all returned entries; the mobile lead sheet renders `slice(0, 3)`.

---

## 4. Permissions

**No new `RESOURCES` entry, no new matrix row.** The match is implicitly scoped through the pair — to **create / update / delete** a match, the caller must hold both:

- `leads.edit` on the lead (the match is a side-effect on the lead's workflow), and
- `listings.view` on the listing (they need to see it to recommend it).

This is enforced in `guardedDispatch` ([src/state/store.jsx](../src/state/store.jsx)) at the `CREATE_MATCH` / `UPDATE_MATCH_STATUS` / `DELETE_MATCH` cases — the same `can()` helper the rest of the app uses. To **view** a match in either drawer, the caller must have `leads.view` on the lead AND `listings.view` on the listing; the read-scope helper `filterByScope(user, 'listings', 'view', state.listings)` already drives `state.listings` visibility on both drawers.

A field-executive (`u-fe-arjun`) only sees matches on leads he/she owns where the listing is also `assignedTo === arjun || createdBy === arjun`. This falls out naturally from the existing `can()` arms — the listing OWN-scope extension in [src/data/permissions.js](../src/data/permissions.js) treats a listing as owned when either field matches.

---

## 5. UI surfaces

### 5.1 Desktop — LeadDrawer "Matching listings" ([src/views/desktop/Leads.jsx](../src/views/desktop/Leads.jsx))

A new section between **Site Visits** and **Notes**. It shows:
- Summary chips tallying matches by status (`recommended · matched · visited · rejected`).
- Existing matches for this lead (if any) with a quick toggle (Mark matched / Mark visited / Remove).
- Up to 10 auto-suggested listings, each rendered with score badge (≥75 green, 50–74 amber, <50 gray), title, locality + price + verification tone, the `reason` text, and two buttons only:
  - **Match / Unmatch** — toggles `matchStatus`. The button label flips per status (`recommended → Match`, `matched → Mark visited`, `visited → Re-match`, `rejected → Undo`).
  - **Schedule visit** — opens the local `MatchScheduleVisitSheet` (see §7).
- A **"Show lower-confidence matches (n)"** footer link when the auto-suggested list (score ≥ 45) is empty. Never above 35.

### 5.2 Desktop — ListingDrawer "Interested leads" ([src/views/desktop/Listings.jsx](../src/views/desktop/Listings.jsx))

Read-only section below Tags. Shows every lead that has a match against this listing — name, unitType, budget band, match-status pill. No link, no button, no `onClick`. Each row passes through `can(currentUser, 'leads', 'view', lead)` so a field-exec only sees their own leads.

### 5.3 Desktop — visit card "Matched from listing X" chip ([src/views/desktop/SiteVisits.jsx](../src/views/desktop/SiteVisits.jsx))

When `visit.listingId` is set on the visit, a small dashed-border chip renders at the top of the visit-card body: `🔗 Matched from "2BHK at Orchid Heights"`. Non-interactive text — clicking it is deferred to a future enhancement. Hidden if the current user lacks `listings.view` on that listing.

### 5.4 Mobile — Lead sheet ([src/views/mobile/MobileModules.jsx](../src/views/mobile/MobileModules.jsx))

Tapping a lead card on the mobile Leads tab opens `MobileLeadSheet`. It mirrors the desktop summary and shows **top 3 matching listings** (`slice(0, 3)` of `rankLeadMatches`). Each card row has exactly four field buttons:
- **Call owner** — `tel:` deep-link via `buildTelLink`.
- **WhatsApp owner** — `wa.me` deep-link via `buildWhatsAppLink`, pre-messaged.
- **Navigate** — opens `maps.google.com/?q=lat,lng` in a new tab; falls back to nothing when geo is missing.
- **Schedule visit** — opens inline `MobileNewVisitSheet` (see §7).

No match-management buttons on mobile: no Match / Unmatch / Browse-all. Mobile stays focused on the in-the-moment field action.

### 5.5 Mobile — Listing sheet "Interested leads" footer

`MobileListingSheet` shows an "Interested leads" footer (max 3 rows, read-only chips) when this listing has any matches. Same `leads.view` gate as the desktop listing drawer.

### 5.6 Mobile — visit card "Matched from listing X" chip

The mobile visit list renders the same chip at the top of `mobile-visit-large` when `visit.listingId` is set and the user has `listings.view` on it.

---

## 6. Visit prefill + source flag

`actions.createVisit` already exists ([src/state/store.jsx](../src/state/store.jsx) line 624) and the reducer accepts arbitrary `action.visit` fields via `{ ... }`, so `listingId` rides through the spread without reducer changes.

Two schedule sheets carry that listingId from match → visit:

- **Desktop `MatchScheduleVisitSheet`** — defined locally in [src/views/desktop/Leads.jsx](../src/views/desktop/Leads.jsx). Three fields: **when** (datetime-local, default `now + 2h`), **assigned staff** (filter to FE / sales-manager, default `currentUser.id`), and **notes** (pre-filled with `"From listing match: <title>"`). Submit calls `actions.createVisit({ leadId, projectId: prefilledListing.projectId || lead.projectId, staffId, scheduledFor, notes, listingId })`.
- **Mobile `MobileNewVisitSheet`** — same payload shape, defined inline in [src/views/mobile/MobileModules.jsx](../src/views/mobile/MobileModules.jsx).

Both also bump the match lifecycle to `'visited'` (idempotent via the uniqueness check) so the match record and the visit record stay aligned.

**Why a local desktop sheet rather than sharing `NewVisitModal`.** `NewVisitModal` is declared at module scope inside `SiteVisits.jsx` and isn't safely exportable. Extracting it would require threading `prefilledLead` + `prefilledListing` props through the module, growing `SiteVisits.jsx` for a non-visit use. The local sheet is ~70 lines, has the same `actions.createVisit` payload, and avoids cross-file plumbing. Risk: a future change to visit fields must be made in both places — acceptable for v1.

---

## 7. Edge cases the matcher filters out

The hard-filter pipeline drops these long before they ever reach the score step:

| Scenario                                                                | Outcome                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| Lead `budgetMax = ₹1.35 Cr`; listing ₹2.4 Cr villa                      | Dropped — exceeds 1.30 × budgetMax cap.            |
| Reserved office in inventory + 4BHK sale buyer                           | Dropped — `availability !== 'available'`.          |
| Booked 2BHK + 2BHK rent lead                                            | Dropped — `availability !== 'available'`.          |
| 4BHK sale lead + rent-out 2BHK                                          | Dropped — incompatible category intent.             |
| Lead on `proj-orchid` + PG listing in `proj-nexa` (PG-friendly listing) | **Survives** — PG is rent-compatible.               |
| Lead with no project (orphan)                                           | Soft default — Signal #1 gives 5/20 instead of zero. |
| Listing missing pricing                                                 | Dropped from Signal #5 (no signal, no penalty).    |
| Listing is off-market / reserved / booked / deleted                     | Dropped — never reaches score.                     |
| Match already exists for `(leadId, listingId)`                          | Uniqueness enforced — second match refreshes status, doesn't duplicate. |

A 4BHK buyer must never see a PG bed, an office, or an over-budget villa as a recommendation. The hard filters guarantee that.

---

## 8. Future backend parity

When `apiRepository` ([src/services/apiRepository.js](../src/services/apiRepository.js)) lands, the swap is mechanical:

1. **Add a `matches` table** mirroring the schema in §2.
2. **Mirror the `custom.matches` namespace on the apiRepository** with `score` / `rank` calling the backend.
3. **Future REST endpoint:** `POST /api/v1/leads/:id/match-suggestions` returns the same `{ listing, score, reason }[]` shape that `rankLeadMatches` returns today.
4. **Cache headers:** `Cache-Control: private, max-age=60` — match scores are computed once per lead visit; subsequent visits reuse the cache for up to a minute while the lead/listing state has not changed.

The function signature in [src/services/matchListings.js](../src/services/matchListings.js) is the **contract** the future API mirrors. The demo scorer (deterministic + tunable) is documented as such; the production scorer can be an ML model with the same input/output shape.

---

## 9. Demo data index

Seeded rows in [src/data/seed.js](../src/data/seed.js) `MATCHES` array:

| match id   | lead                                | listing                  | status       | Tests                                                                                       |
| ---------- | ----------------------------------- | ------------------------ | ------------ | ------------------------------------------------------------------------------------------- |
| `match-001` | `lead-006` Ramesh (2BHK ₹90–105L, proj-parklane) | `list-006` Parklane resale 2BHK ₹95L | `matched`    | In-project, in-budget, same BHK — strong fit.                                              |
| `match-002` | `lead-011` Vivek (2BHK ₹85L–1Cr)                | `list-006` Parklane resale 2BHK | `recommended` | Lead later lost. Stored as recommended lifecycle.                                           |
| `match-003` | `lead-003` Anita Group (4BHK ₹3.5–4.2 Cr)       | `list-007` Chennai 4BHK villa ₹3.2 Cr | `recommended` | Cross-project but BHK + budget + category fit.                                             |
| `match-004` | `lead-005` Pooja (4BHK ₹3.6–4 Cr)                | `list-007` Chennai 4BHK villa | `recommended` | Same listing, HNW comparison shopper.                                                       |
| `match-005` | `lead-008` Aditya Group (4BHK Sky Villa ₹4.5–5.5 Cr) | `list-007` Chennai 4BHK villa | `visited`    | Lifecycle through to visited.                                                              |
| `match-006` | `lead-002` Prakash (2BHK ₹1.1–1.35 Cr)          | `list-006` Parklane resale 2BHK ₹95L | `rejected`   | Same BHK and in-budget, but city mismatch — Prakash lives in Bengaluru, listing in Hyderabad. Stored as a rejected example of why cross-city was rejected. |

Every seeded pair obeys the hard-filter rules — none of them are absurd. Bad pairs (4BHK sale vs. office, etc.) live only in [src/services/matchListings.test.js](../src/services/matchListings.test.js) as `should be filtered out` assertions.

---

## 10. Verification

1. `npm run build` passes — no new warnings beyond the existing lucide-react "use client" diagnostics.
2. `node src/services/matchListings.test.js` — 16/16 smoke tests pass.
3. **Desktop smoke:**
   - Admin → Leads → open Prakash (`lead-002`). Drawer shows Matching-listings section, summary chips, and the `match-006` row (rejected) above the algorithmic suggestions. Tap **Match** on a different listing — match lifecycle advances; tap **Schedule visit** — modal pre-attached, project preselected, notes pre-fill. Submit. Land on Site Visits → visit card shows **"Matched from listing X"** chip.
   - The same lead must **not** show any over-budget or non-available listing. Pick an irregular lead (Sneha, status=Cold) — confirm the matcher shows the soft-default path.
   - Switch to **Field Executive (Arjun)** — leads drawer only shows FE's leads; matches on those leads only; "Interested leads" on listing drawers only shows leads he/she owns.
   - Switch to **Accounts (Nandini)** — all-scoped view (read-only); Match / Schedule buttons hidden (no `leads.edit`).
4. **Mobile smoke (520px viewport):**
   - Leads tab → tap a lead card → `MobileLeadSheet` opens with **Top matching listings** (up to 3). Each card has Call / WhatsApp / Navigate / Schedule buttons only. Submit Schedule → toast + sheet closes; new visit lands on the visit list with the **"Matched from listing X"** chip.
   - Listings tab → tap a listing with matches → sheet shows **Interested leads** (3 chips max, read-only).
   - **No full match-management** on mobile: no Match/Unmatch toggle, no Browse-all modal.
5. **Recent fixes intact:**
   - `src/main.jsx` `MobileMenuContents` continues to destructure `currentUser` from `useStore()`.
   - `src/views/desktop/Listings.jsx` uses string actions (`'view'`/`'create'`/etc.), never `ACTIONS.VIEW`.
   - Legacy "EstateFlow" strings preserved verbatim: `estateflow:offline-queue:v1`, `estateflow-server`, Postgres role/db `estateflow`.
