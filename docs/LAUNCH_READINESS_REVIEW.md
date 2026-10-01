# EstateFlow CRM Launch Readiness Review

Date: 2026-09-19

## Executive Summary

EstateFlow is directionally strong as a real estate CRM: the product shape is right, the role model is thoughtful, and the mobile field-staff concept is exactly where the product should lean. However, the current build is **not live-product ready yet** because the app currently opens to a blank screen and multiple action flows depend on a broken store contract.

Current recommendation: **do not launch or demo to a client until the P0 items below are fixed and verified in-browser across desktop and mobile.**

## Current Status

- Product concept: strong
- Information architecture: strong
- Permission model direction: strong
- Mobile field-staff UX direction: strong
- Production readiness: blocked
- Backend readiness: not started
- PWA/offline readiness: not started

## P0 Launch Blockers

### 1. Blank Page Runtime Crash

The app currently fails during load with:

```text
TypeError: offsetDate(...).toISOString is not a function
at src/data/seed.js:704
```

Cause:

`offsetDate()` returns an ISO string, but attendance seed records call `.toISOString()` on that returned string.

Affected examples:

- `src/data/seed.js:704`
- `src/data/seed.js:718`
- `src/data/seed.js:732`

Fix direction for Claude Code:

- Either make `offsetDate()` return a `Date` object and convert to ISO only at each call site, or add a separate helper such as `offsetIso()` / `offsetDay()`.
- Standardize all seed timestamp fields.
- Add a smoke test that loads the app and fails on console errors.

Acceptance criteria:

- Browser shows the CRM UI, not a blank page.
- No console errors on initial load.
- `npm run build` passes.

### 2. Store Exposes Actions Flat, Components Expect `actions`

Many components call `const { actions } = useStore()`, but `StoreProvider` spreads the action functions directly into the context value instead of exposing an `actions` object.

Examples:

- `src/views/mobile/Home.jsx:42`
- `src/views/desktop/Leads.jsx:404`
- `src/views/desktop/Staff.jsx`
- `src/components/ui.jsx:231`
- `src/main.jsx:85`
- `src/layout/DesktopShell.jsx:158`

Likely impact:

- Role switching fails.
- Toast dismissal fails.
- Mobile check-in/check-out fails.
- Lead creation/assignment fails.
- Staff editing fails.
- Photo upload and approval fail.
- Messaging fails.

Fix direction for Claude Code:

- Expose both patterns temporarily:

```js
const value = {
  state,
  currentUser,
  actions,
  ...actions,
  ...
};
```

- Then pick one convention and refactor consistently.

Acceptance criteria:

- Role switcher works.
- Toasts appear and dismiss.
- Mobile check-in/check-out works.
- Lead creation works.
- Photo upload works.
- Message sending works.

### 3. Guarded Mutators Dispatch Payload Incorrectly

`guardedDispatch()` dispatches `{ type, payload }`, but reducer cases read fields directly from `action`, such as `action.lead`, `action.leadId`, `action.changes`, `action.visit`, `action.photo`, and `action.message`.

Location:

- `src/state/store.jsx:340`

Examples of mismatch:

- `CREATE_LEAD` expects `action.lead`
- `UPDATE_LEAD` expects `action.leadId` and `action.changes`
- `CREATE_VISIT` expects `action.visit`
- `ADD_PHOTO` expects `action.photo`
- `SEND_MESSAGE` expects `action.message`

Fix direction for Claude Code:

- Either dispatch `dispatch({ type, ...payload })`, or update all reducer cases to read `action.payload`.
- Prefer `dispatch({ type, ...payload })` for the smallest change.

Acceptance criteria:

- Creating a lead adds complete lead data.
- Assigning a lead changes owner/team.
- Check-in creates attendance with location.
- Uploading a photo creates a photo record with project/category.
- Sending a message appends to the thread.

### 4. Hooks Are Called Inside Event Handlers

Some components call `useStore()` inside click handlers or nested render callbacks. React hooks must be called at component top level.

Examples:

- `src/layout/DesktopShell.jsx:138`
- `src/views/desktop/Attendance.jsx:199`
- `src/views/desktop/Attendance.jsx:208`
- `src/views/desktop/Roles.jsx:77`
- `src/views/desktop/Roles.jsx:79`

Fix direction for Claude Code:

- Pull required store functions at the top of the component.
- Pass handlers down as normal functions.

Acceptance criteria:

- Mobile preview switch works.
- Attendance approval works.
- Role matrix saving works.
- No “invalid hook call” runtime errors.

## P1 Product Readiness Issues

### 1. Real Backend Is Still Required

The current app is a frontend prototype with seed data. Before live use, it needs:

- Authentication
- Server-side permission enforcement
- Database-backed users, roles, leads, visits, attendance, photos, messages
- File storage for site photos
- Audit logs
- Environment separation: dev, staging, production

### 2. Permission Model Needs Backend Parity

The permission model is well placed in the frontend, but live protection must happen server-side too.

Backend endpoints should enforce:

- Role permission
- Scope permission
- Team/project ownership
- Record-level access
- Export restrictions
- Admin-only role edits
- System-role protection

### 3. Field Staff Mobile Needs Offline Strategy

For on-field staff, live readiness requires:

- Offline queue for check-ins
- Offline queue for site notes and photos
- Sync state per item
- Retry failures
- Clear “pending upload” status
- Device timestamp plus server timestamp reconciliation

### 4. PWA/App-Like Layer Missing

To feel like a mobile app:

- Web app manifest
- Install prompt
- App icon
- Splash screen
- Service worker
- Offline fallback
- Bottom safe-area support
- Push notification plan

## Product Acceptance Checklist

### Admin

- Can view command dashboard.
- Can switch modules without blank states.
- Can manage staff.
- Can view and edit non-system roles.
- Cannot edit protected system roles.
- Can review attendance approvals.
- Can approve/reject site photos.
- Can export only where allowed.

### Sales Manager

- Sees team-scoped leads only.
- Can assign team leads.
- Can review team attendance.
- Cannot edit global roles.
- Cannot view unrelated project data.

### Site Manager

- Sees project-scoped visits, leads, photos, attendance.
- Can approve site photos for assigned projects.
- Cannot access unrelated projects.

### Field Executive

- Mobile-first view loads directly.
- Can check in/out quickly.
- Can see today’s visits.
- Can call/WhatsApp/navigate quickly.
- Can upload site photos with project/category.
- Cannot access manager/admin modules.

### Telecaller

- Can access own leads and communication queue.
- Cannot access site photos.
- Cannot view field attendance beyond own scope.

### Accounts

- Can view relevant lead/payment/report context.
- Cannot mutate sales operations outside allowed scope.

## Claude Code Repair Brief

Please fix the current runtime and action-system blockers without changing the product direction.

Priority order:

1. Fix `offsetDate()` / seed date crash so the app renders.
2. Fix the store context contract so `actions` exists where components expect it.
3. Fix `guardedDispatch()` payload dispatching so reducer cases receive the fields they expect.
4. Remove all `useStore()` calls from event handlers and nested callback bodies.
5. Run in-browser smoke checks:
   - initial load has no console errors
   - role switching works
   - mobile preview works
   - check-in/check-out works
   - create lead works
   - assign lead works
   - attendance approval works
   - site photo upload works
   - send message works
6. Add a small smoke-test harness if possible so future builds catch blank-page crashes.

Do not redesign the app yet. Stabilize runtime behavior first.

## Live Product Roadmap

### Phase 1: Stabilized Demo

- Fix P0 blockers.
- Verify all roles.
- Add browser smoke checks.
- Prepare a clean client demo build.

### Phase 2: Backend Foundation

- Add authentication.
- Add database schema.
- Add server-side permission enforcement.
- Add file storage.
- Add audit logs.

### Phase 3: Field App Readiness

- Add PWA installability.
- Add offline queue.
- Add GPS/photo sync states.
- Add push notifications.

### Phase 4: Integrations

- WhatsApp templates.
- Email/SMS notifications.
- Calendar/site visit reminders.
- Export/reporting controls.
- Optional maps dashboard.

## Go/No-Go Decision

Current decision: **No-Go for live product and client demo.**

Reason: the app currently has a blank-page runtime crash and broken action wiring.

Next decision point: after P0 fixes are completed and the product acceptance checklist passes in browser.
