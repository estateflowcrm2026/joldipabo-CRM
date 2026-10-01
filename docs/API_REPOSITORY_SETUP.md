# Frontend API repository — operator setup

> **Status:** bridge layer. Only the **listings** surface talks to the real backend today; every other entity still uses the in-memory demo. The default app is unchanged.

This document explains how to flip the frontend from `demoRepository` (in-memory seed data) to `apiRepository` (real backend) for listings, what to expect, and how to switch back.

---

## 1. What this is

Two new files sit next to the existing demo repository:

| File | Role |
| --- | --- |
| [`src/services/apiClient.js`](../src/services/apiClient.js) | Thin `fetch` wrapper. Owns the base URL, the bearer token, and the standard backend error envelope (`{ error: { code, message, detail? } }`). Throws `ApiError`. |
| [`src/services/apiRepository.js`](../src/services/apiRepository.js) | Repository implementation that calls `apiClient` for `listings` and delegates everything else to `demoRepository`. Exposes both `repo.list('listings', filters)` and a specialised `repo.custom.listings.*` namespace. |

The repo is **opt-in**. Nothing in the UI flips automatically — `src/services/index.js` only swaps the active repository when the `VITE_USE_API_REPOSITORY` env flag is `'true'`. Until then the build is byte-identical to before this work.

---

## 2. Bring up the backend

From [`server/README.md`](../server/README.md):

```bash
cd server

# Option A — docker compose (postgres:16, persistent named volume)
docker compose up -d

# Option B — system Postgres. Use whichever role/db matches your setup.
# createdb estateflow
# export DATABASE_URL=postgres://estateflow@localhost:5432/estateflow

# Apply schema + seed
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
npm run db:migrate
npm run db:seed

# Enable the dev-token shortcut, then start.
export DEV_AUTH_ENABLED=true
export DEV_AUTH_OFFLINE_FALLBACK=false   # fail-closed without DB
npm start                                  # http://0.0.0.0:4000
```

Confirm the backend is up before flipping the frontend:

```bash
curl http://127.0.0.1:4000/health
# → { "status": "ok" }

curl http://127.0.0.1:4000/ready
# → { "status": "ok", "database": "connected" }
```

End-to-end check against listings:

```bash
curl -H "Authorization: Bearer dev-super" http://127.0.0.1:4000/api/v1/listings | head
# → { "items": [...], "pagination": { "limit": ..., "offset": ..., "total": ... } }
```

---

## 3. Frontend env vars

All three are Vite-style, must be set at **build time** (not runtime).

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_USE_API_REPOSITORY` | *(unset)* | Set to `'true'` to enable the API repository. Any other value (or unset) keeps `demoRepository`. |
| `VITE_API_BASE_URL` | `http://localhost:4000/api/v1` | Backend root. Trailing slashes are stripped. |
| `VITE_DEV_AUTH_TOKEN` | *(unset)* | Default `Authorization: Bearer <value>` for every request. Replace with the real access token once login lands. |

A `.env.example` is not committed; set these in your shell or via your IDE's Vite config.

---

## 4. Enable the API repository

### Quick run

```bash
# In the project root (the Vite app), with the backend already up:
export VITE_USE_API_REPOSITORY=true
export VITE_API_BASE_URL=http://localhost:4000/api/v1
export VITE_DEV_AUTH_TOKEN=dev-super

npm run dev          # Vite dev server, picks up env on (re)start
# or
npm run build && npm run preview
```

Open the app. The default UI still renders from `demoRepository` because no UI calls `repo.list('listings')` yet — the bridge is wired for future listings views. The smoke script below exercises it directly.

### Programmatic swap (no rebuild)

```js
import { apiRepository, setRepository } from './src/services/index.js';
setRepository(apiRepository);
// later:
import { resetRepository } from './src/services/index.js';
resetRepository();   // back to demo
```

`setRepository(apiRepository)` overrides whatever `VITE_USE_API_REPOSITORY` says — useful in tests and Storybook.

---

## 5. Smoke test

`src/services/apiRepository.smoke.mjs` hits the live backend and asserts the listings DTO shape, the `get → list → get` round-trip, a 404 → `null` mapping, and a network-error mapping for an unreachable URL.

```bash
export VITE_USE_API_REPOSITORY=true
export VITE_API_BASE_URL=http://127.0.0.1:4000/api/v1
export VITE_DEV_AUTH_TOKEN=dev-super
node src/services/apiRepository.smoke.mjs
# → 6 assertions; exits 0 on full pass.

# Or, skip cleanly when the flag is absent:
node src/services/apiRepository.smoke.mjs
# → "[smoke] VITE_USE_API_REPOSITORY is not 'true' — skipping." (exit 2)
```

The smoke script is intentionally node-only. It monkey-patches `globalThis.fetch` so it can run without going through Vite's `import.meta.env` resolution.

---

## 6. Expected limitations

- **Listings only.** Every other entity still delegates to `demoRepository`. Calls like `repo.list('leads')` in API mode hit the in-memory store, not the backend. Future PRs will add `leads`, `visits`, `attendance`, etc.
- **No auth refresh.** `setAuthToken(t)` replaces the bearer token in memory; when the JWT expires you must call `setAuthToken(...)` again. There is no automatic refresh hook.
- **No token persistence.** Auth state lives in a module-scoped variable in `apiClient.js`. Reloading the page clears it (the env-var fallback kicks in if `VITE_DEV_AUTH_TOKEN` is set).
- **No retry, no backoff, no caching.** Failures throw `ApiError`. The UI is responsible for handling it.
- **Cursor pagination not supported on listings.** The backend uses limit/offset today. Passing `pagination.cursor` is silently ignored — there is no warning surface yet.
- **`where` operators (`__in`, `__gt`, …) are ignored on listings.** Only the supported subset is forwarded to the backend query string.
- **`POST /listings/:id/documents` and `GET /listings/:id/export.csv` are 501 on the server.** The frontend does not expose either surface in the apiRepository; calls to other listings endpoints that the server returns 501 for will surface as `ApiError { status: 501, code: 'not-implemented' }`.
- **Audit events are server-side only.** The frontend cannot see them through this client.

---

## 7. Switching back to demo mode

Three equivalent ways, in order of "blast radius":

1. **Per page reload:** unset `VITE_USE_API_REPOSITORY` and `npm run build && npm run preview` (or restart `npm run dev`).
2. **Per session in code:**
   ```js
   import { resetRepository } from './src/services/index.js';
   resetRepository();
   ```
3. **Per call:** import `demoRepository` directly when you need it.

There is no UI to flip the flag at runtime — by design.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ApiError { status: 0, code: 'network-error' }` | Backend not reachable, wrong port, or CORS. | Confirm `curl http://127.0.0.1:4000/health` works. Check `CORS_ORIGINS` in [`server/.env.example`](../server/.env.example) covers your Vite origin. |
| `ApiError { status: 401, code: 'unauthorized' }` | No bearer token, or token rejected. | Set `VITE_DEV_AUTH_TOKEN=dev-super` and ensure `DEV_AUTH_ENABLED=true` on the server. |
| `ApiError { status: 403, code: 'forbidden' }` | Dev token resolves to a role that lacks the action. | `dev-super` has every permission. The default matrix in [`server/src/rbac/permissions.js`](../server/src/rbac/permissions.js) is the source of truth. |
| `ApiError { status: 404, code: 'not-found' }` | Listing id does not exist, or is soft-deleted. | The repository maps 404 → `null` on `get()`. On `list()` it cannot happen because the endpoint returns `200 { items: [] }`. |
| Smoke script exits 2 immediately | `VITE_USE_API_REPOSITORY` is unset. | Export the env var. |
| Build compiles but the UI still uses demo data | You have not wired UI calls to `repo.list('listings')` yet — that is intentional today. | The bridge is wired for the next listings UI work, not for the existing screens. |
