# EstateFlow CRM Browser Smoke Test Results

Date: 2026-09-19

Test URL: `http://127.0.0.1:5180/`

## Summary

The app now renders successfully in browser. The original blank page is resolved, mobile mode works, and the Leads table DOM warning is gone.

Desktop core flows are healthy:

- Initial load: pass
- Current console on initial load: pass
- Role switching: pass
- Scoped lead view: pass
- Create lead: pass
- Assign lead: pass, with one stale-drawer polish issue
- Attendance approval: pass
- Site photo upload: pass
- Site photo approval: pass
- Communication send: pass

Remaining launch blockers:

1. Mobile mode does not render.
2. Leads table logs invalid nested-button DOM warnings.

## Passed Checks

### Initial Load

The dashboard renders correctly at `http://127.0.0.1:5180/`.

Observed:

- Sidebar visible
- Dashboard visible
- Stat cards visible
- Pipeline, hot leads, visits, project performance, and activity sections visible
- No current console errors on initial load

### Role Switching

Switched from Admin to Field Executive.

Observed:

- User changed from Rohan Desai/Admin to Arjun Mehta/Field Executive
- Role-restricted navigation changed
- Roles & Permissions disappeared for field executive
- Dashboard data became scoped to field executive records

### Lead Scope

Opened Leads as Field Executive.

Observed:

- Field executive saw 4 scoped leads
- Admin later saw 13 scoped leads

### Create Lead

Created a test lead:

- Name: Smoke Test Buyer
- Phone: +91 90000 11122
- Email: smoke@example.com
- Notes: Browser smoke test lead.

Observed:

- Lead count increased
- Test lead appeared in the table
- Success toast appeared

### Assign Lead

Switched back to Admin and assigned Smoke Test Buyer to Neha Rao.

Observed:

- Assign modal opened
- Staff dropdown worked
- Success toast appeared
- Reopening the lead detail showed Neha Rao as owner

Polish issue:

- If the detail drawer is already open during assignment, it continues to show the old owner until closed/reopened.

### Attendance Approval

Opened Attendance and approved Maya Iyer’s Late record.

Observed:

- Status changed from Late to Approved
- Late check-ins count changed from 1 to 0

### Site Photo Upload

Uploaded local smoke-test image:

- Caption: Browser smoke test photo
- Project: Orchid Heights
- Category: Progress

Observed:

- Total photos increased from 6 to 7
- Pending review increased from 2 to 3
- Uploaded photo appeared in gallery
- Success toast appeared

### Site Photo Approval

Approved the uploaded smoke-test photo.

Observed:

- Photo status changed from Pending to Approved
- Approved count increased from 4 to 5
- Pending review decreased from 3 to 2

### Communication Send

Sent message:

```text
Smoke test: confirming communication hub send works.
```

Observed:

- Message appeared in thread
- Composer cleared

## Failed / Blocked Checks

### Mobile Preview

Mobile mode is blocked.

Observed:

- Clicking “Mobile preview” does not switch to mobile shell.
- Browser viewport is narrow (`window.innerWidth` about 486px).
- `window.matchMedia('(max-width: 760px)').matches` is `true`.
- App still renders `.app-shell-desktop`.

Likely cause:

`src/main.jsx` reads `viewMode` directly:

```js
const { viewMode } = useStore();
return viewMode === 'mobile' ? <MobileApp /> : <DesktopApp />;
```

But the store exposes `viewMode` inside `state.viewMode`, not as a flat top-level field.

Fix direction:

Either expose `viewMode` flat from `StoreProvider`, or update `main.jsx` to read:

```js
const { state } = useStore();
return state.viewMode === 'mobile' ? <MobileApp /> : <DesktopApp />;
```

Acceptance criteria:

- Clicking “Mobile preview” shows the mobile shell.
- On a narrow viewport, the app automatically opens the mobile shell.
- Field executive mobile home appears with check-in/out controls.
- Mobile check-in/out passes with GPS-denied fallback.

### Leads Table Invalid DOM Warning

Status: fixed and verified.

Previous warning:

```text
In HTML, <button> cannot be a descendant of <button>.
```

Cause:

Lead rows are rendered as a `<button className="lead-row" role="row">`, and action buttons such as Assign / More are rendered inside that button.

Fix direction:

- Do not use a button as the entire row container when it contains buttons.
- Use a non-button container, such as `div role="row" tabIndex="0"`, with keyboard handlers for row activation.
- Keep Assign / More as real buttons.

Verified:

- Leads table interaction still works.
- Assign / More still work.
- No nested button console warning after opening desktop Leads and opening lead detail.

## Final Browser Pass

Final pass completed after the last two fixes:

- Mobile shell renders on narrow viewport.
- Mobile drawer can switch back to desktop view.
- Mobile check-in works.
- Mobile check-out works.
- GPS-denied path saves a manual location tag.
- Desktop Leads opens without console warnings.
- Desktop lead row / More action still opens the detail drawer.
- Current console for `http://127.0.0.1:5180` is clean during the verified flows.

## Remaining Non-Blocking Polish

- Lead detail drawer can display stale owner data immediately after reassignment until it is closed and reopened.
- Existing smoke toasts remain visible for a while after actions; this is acceptable for demo but could be tidied.

## Demo Readiness

Current decision: **Demo-ready frontend prototype.**

Important caveat: this is still not a live business product until backend authentication, server-side permissions, persistent storage, file storage, audit logs, and PWA/offline behavior are implemented.

## Next Claude Code Prompt

```text
Browser smoke testing is mostly passing now, but two issues remain.

1. Mobile mode does not render.

At http://127.0.0.1:5180, clicking “Mobile preview” does nothing. The viewport is narrow and matchMedia('(max-width: 760px)').matches is true, but the app still renders .app-shell-desktop.

Likely cause:
src/main.jsx reads:
const { viewMode } = useStore();
return viewMode === 'mobile' ? <MobileApp /> : <DesktopApp />;

But StoreProvider exposes viewMode under state.viewMode, not as a top-level context field.

Fix either by exposing viewMode flat from StoreProvider or by updating main.jsx to read state.viewMode.

Acceptance:
- Clicking Mobile preview shows the mobile shell.
- Narrow viewport auto-loads the mobile shell.
- Field executive mobile home shows check-in/out controls.

2. Leads table logs invalid nested button warnings.

React warning:
In HTML, <button> cannot be a descendant of <button>.

Cause:
Lead rows are rendered as a button and contain action buttons such as Assign / More.

Fix:
Use a non-button row container, such as div role="row" tabIndex="0", with keyboard handlers for row activation. Keep Assign / More as real buttons.

After fixes:
- Run npm run build.
- Verify initial load has no console errors/warnings.
- Verify Mobile preview works.
- Verify mobile check-in/out works.
- Verify Leads row click, Assign, and More still work.

Do not redesign or add features. This is a targeted smoke-test cleanup pass.
```
