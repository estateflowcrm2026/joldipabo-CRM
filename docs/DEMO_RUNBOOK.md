# Joldipabo — Client Demo Runbook

Friday 2 October. This is the operator's guide: how to start it, what to
show, what to avoid, and how to get back to a clean state.

---

## 1. What this build is

A **seeded, in-memory demo**. It needs no database, no backend, and no
credentials. Open it and it is already signed in as the Admin user.

| | |
|---|---|
| Data | 13 staff, 5 projects, 12 leads, 10 properties, 7 site visits, photos, message threads — all from `src/data/seed.js` |
| Backend | **None.** `VITE_USE_API_REPOSITORY=false`, so nothing is fetched and nothing is saved |
| Sign-in | Not required. The demo build is signed in by definition |
| Persistence | Only the offline queue (browser localStorage). "Reset demo" clears it |

### What is real vs. what is prototype

This matters if the client asks "does it actually save?".

| Area | In this demo build | In the live product today |
|---|---|---|
| Properties (Inventory) | In-memory | **Real.** Create / edit / verify / assign / off-market persist to Postgres with row-level permissions and an audit trail |
| Sign-in, sessions, MFA | Bypassed | **Real.** Argon2id passwords, short-lived access tokens, rotating refresh cookie, TOTP |
| Leads, site visits, attendance, photos, messaging, staff, projects, roles | In-memory | **Prototype.** The backend routes for these are placeholders; the front end runs on seed data |

Say it plainly if asked: *"Properties and the security layer are built on the
real database. The other modules are the working interface over sample data —
that's what we're prioritising next."*

---

## 2. Hosted demo (preferred)

Import the GitHub repository into Vercel with the repository root as the
project root. The tracked `vercel.json` builds the seeded demo to `dist`; do
not add Supabase, JWT, or other server secrets to this frontend project.

Before sharing the link, open the deployed URL on a desktop and a phone.
Confirm that the **Demo mode** badge and role switcher appear, and that there
is no sign-in screen. Then run the journey against the actual deployment:

```powershell
$env:DEMO_URL = 'https://YOUR-VERCEL-URL'
$env:DEMO_SCREENSHOTS_DIR = Join-Path $env:TEMP 'joldipabo-demo-smoke'
npm run smoke:demo       # expect 43 passed, 0 failed
```

Replace the placeholder with the real deployment URL. Keep that URL handy for
the client and staff; no same-Wi-Fi connection is needed. Anyone with access
to the preview can use the demo role switcher. All names and records in this
build are sample data, and changes disappear on reload. Do not enter real
client or property information into the demo.

## 3. Start it on the laptop (fallback)

From `D:\New Downloads\CRM-RE`:

```bash
npm run demo:build      # builds the demo bundle (once, or after any change)
npm run demo:preview    # serves it on http://localhost:4173
```

Then open **http://localhost:4173** in Chrome.

> Use the **built preview**, not `npm run demo` (the dev server). The preview
> has no hot-reload overlay and no dev-only chrome, so nothing unexpected can
> appear on screen.

**Before the meeting, run the smoke test.** It drives the whole journey and
fails on any console error, blank screen, layout overflow or visit-row overlap:

```bash
npm run demo:preview        # in one terminal
npm run smoke:demo          # in another — expect "43 passed, 0 failed"
```

---

## 4. On the client's phone (local fallback)

The demo is a PWA, so the client can hold it in their hand.

1. Make sure the phone is on the **same Wi-Fi** as the laptop.
2. Find the laptop's address. This machine is currently **192.168.1.2**, so:

   ```bash
   npx vite preview --host --port 4173
   ```

   (The `--host` flag is what exposes it to the network. `npm run demo:preview`
   already includes it.)
3. On the phone, open **http://192.168.1.2:4173**.
4. Optional: Share → *Add to Home Screen* to get the Joldipabo icon.

**Two things to know about the phone:**

- **GPS check-in still works.** Geolocation is blocked on a plain `http://`
  address, so the app falls back to a "manual tag" and completes the check-in
  anyway. It will say *"GPS unavailable — saved with a manual tag."* That is
  expected and fine; on a real deployment (HTTPS) it uses the live GPS fix.
- If the phone cannot reach the laptop, Windows Firewall is blocking port
  4173. Allow Node.js on **private networks**, or skip the phone and present
  from the laptop.

---

## 5. The five-minute presentation route

This is the recommended order. It tells one story: *capture → enquire →
visit → field → manage.*

| # | Screen | Do this | What to say |
|---|---|---|---|
| 1 | **Dashboard** | Land here. Point at the inventory pulse and the verification pipeline. | "Everything a real-estate operator runs, on one screen." |
| 2 | **Inventory** | Click the category filter and step through **Rent → PG → Land → Office → Resale**. | "One inventory for every vertical — rental, PG, land, office, resale." |
| 3 | **Inventory → New listing** | Fill Owner name, phone, Title, Locality, Monthly rent → **Create listing**. | "A field exec captures a property in twenty seconds." |
| 4 | **Leads** | Open a hot lead; show the matching listings panel. | "Every enquiry is matched against live inventory automatically." |
| 5 | **Site Visits** | Show the schedule and a completed visit with its rating. | "Visits are scheduled, completed in the field, and rated." |
| 6 | **Role switcher → Arjun Mehta (Field Executive)**, then **Mobile preview** | Tap **Check in**, then **Capture & upload site photo**. | "The field team checks in on site and uploads proof." |
| 7 | **Open menu → Switch to desktop**, **Role switcher → Vikram Bhatia (Sales Manager)**, then **Attendance** | Show today's field attendance. | "The manager sees who is on site, right now." |
| 8 | **Reset demo** (top-right) | One click, confirm. | "And it resets instantly for you to try." |

**Timing note:** steps 6–7 are the ones people remember. Do not rush them.

### If you only have ninety seconds

Dashboard → Inventory (filter Rent, then PG) → New listing → Role switcher to
Field Executive → Mobile preview → Check in. That is the whole product in one
breath.

---

## 6. The "client try it" route

Hand over the laptop (or their phone) with the hosted Vercel URL on screen.
If the hosted site is unavailable, use the local fallback:

> **http://localhost:4173**

Tell them:

1. **Switch role** (top-right, next to the avatar). Every role sees a
   different app — try *Field Executive*, then *Sales Manager*.
2. **Add a property** — Inventory → New listing. It appears immediately.
3. **Mobile preview** (top-right). This is the field app.
4. **Reset demo** (top-right) when they are done. It restores everything.

Two minutes of free exploration is enough. Nothing they can tap breaks
anything, and nothing is saved.

---

## 7. Resetting

**Reset demo** is in the desktop top bar and in the mobile menu (hamburger →
Demo info). It clears the offline queue and reloads, restoring the seed.

If you ever need a harder reset, close the tab and reopen it, or in DevTools
run `localStorage.clear()` and reload.

---

## 8. Go / no-go checklist

Run through this **on the presentation machine, on the day**.

- [ ] The hosted Vercel URL loads on laptop and phone (or the local fallback is ready)
- [ ] `npm run smoke:demo` against the chosen URL reports **43 passed, 0 failed**
- [ ] Chrome DevTools console is **empty** on the Dashboard
- [ ] The Joldipabo logo appears top-left on desktop and in the mobile header
- [ ] The **Demo mode** badge is visible in the top bar
- [ ] **Reset demo** is visible top-right and works (confirm dialog → seeded dashboard)
- [ ] Role switcher lists 13 people and switching changes the sidebar
- [ ] Inventory filter shows **Rent, PG, Land, Office, Resale, Owner-listed** and each returns rows
- [ ] **New listing** creates a property that appears in the table
- [ ] Mobile preview opens and **Check in** puts the field exec on duty
- [ ] A photo upload adds a tile to the gallery
- [ ] Attendance shows today's field records for the manager
- [ ] Browser is at **100% zoom** and the window is maximised
- [ ] Laptop is on mains power and notifications are silenced

If the phone route is in play:

- [ ] Phone is on the same Wi-Fi and http://192.168.1.2:4173 loads
- [ ] Check-in works on the phone (it will say "manual tag" — that is correct)

---

## 9. Things not to show

| Avoid | Why |
|---|---|
| **Roles & Permissions** screen | It is functional but reads as a settings matrix, not a product story. It invites "can I edit this?" questions with no payoff in five minutes. |
| **Reports** | Real charts over sample data. Fine if asked, but it does not advance the narrative and can raise "where does this number come from?" |
| **Communication / Inbox** | Threads and messages are seed data. The composer works, but nothing is delivered anywhere. |
| **Staff** | A roster table. Nothing wrong with it, but it is not a differentiator. |
| The **"Demo mode"** badge explained at length | Say "this is a seeded demo build" once, move on. Do not let it become the topic. |
| Deep **offline / sync** questions | The demo has an offline queue, but replay for everything except properties is not wired. Deflect to "next phase" rather than demoing it. |
| DevTools open | The console is clean, but the bundle shows seed data by design. Keep it closed. |

Also avoid: renaming a role matrix, editing a seeded property's owner to
something odd, or leaving the app on a filtered view before handing it over.
**Reset demo** before each hand-over.

---

## 10. If something goes wrong

| Symptom | Fix |
|---|---|
| Blank white screen | Hard-reload: **Ctrl + Shift + R**. The service worker is network-first for the page, so this picks up the current build. |
| Stale UI after a rebuild | Same — **Ctrl + Shift + R**. Or DevTools → Application → Service Workers → Unregister, then reload. |
| Page will not load at all | Is `npm run demo:preview` still running in its terminal? |
| "Reset demo" does not clear something | Close the tab and reopen it. |
| Phone cannot connect | Windows Firewall — allow Node.js on private networks, or present from the laptop. |
| GPS prompt appears on the laptop | Deny it. Check-in completes with a manual tag. |

---

## 11. Reference

- Seed data: [`src/data/seed.js`](../src/data/seed.js)
- Demo flags: [`src/services/demoFlags.js`](../src/services/demoFlags.js), `.env.demo.local`
- Reset: [`src/services/demoReset.js`](../src/services/demoReset.js)
- Journey smoke test: [`scripts/browser-smoke-demo.mjs`](../scripts/browser-smoke-demo.mjs)
- Product context: [`docs/LISTINGS_MODULE.md`](./LISTINGS_MODULE.md)
