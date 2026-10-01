// Listings smoke harness.
//
// Drives a running backend (assumed at http://127.0.0.1:4000 by default)
// through the routes that are DB-backed today:
//   * GET /health
//   * GET /ready
//   * GET /api/v1/listings  — no auth → 401
//   * GET /api/v1/listings  — Bearer dev-super → 200, items non-empty
//   * GET /api/v1/listings?serviceCategory=rent — only rent rows
//   * GET /api/v1/listings?serviceCategory=pg   — only pg rows
//   * GET /api/v1/listings/:id — detail for one returned row → 200
//   * GET /api/v1/listings — Bearer dev-field (own scope) → 200, scoped subset
//
// Exits 0 only if every assertion passes. Exits 2 with a clear hint
// when the backend isn't reachable or DATABASE_URL is unset.
//
// This script is a CLIENT — it never starts the server. Run it after
// `npm start` (or `npm run dev`) in a separate shell. See
// server/README.md "Local smoke test".

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4000';
const TENANT = 'org_acme';

let failures = 0;
const summary = [];

function record(name, ok, detail) {
  if (ok) {
    summary.push(`  ✓ ${name}`);
  } else {
    failures += 1;
    summary.push(`  ✗ ${name} — ${detail}`);
  }
}

function envHint() {
  return [
    'Local smoke test could not reach the backend.',
    '',
    'Run in another shell:',
    '  cd server',
    '  docker compose up -d',
    '  export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev',
    '  export DEV_AUTH_ENABLED=true',
    '  npm run db:migrate',
    '  npm run db:seed',
    '  npm start',
    '',
    'Then re-run:  npm run smoke:listings',
  ].join('\n');
}

async function http(path, { method = 'GET', token = null, expect } = {}) {
  const url = `${BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers });
  } catch (err) {
    throw new Error(`fetch ${url} failed: ${err?.message || err}`);
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(
      `GET ${path} expected ${expect} got ${res.status}: ${JSON.stringify(body)}`,
    );
  }
  return { status: res.status, body };
}

async function waitForBackend() {
  // /health is up as soon as Fastify is listening, even without a DB.
  const deadline = Date.now() + 5_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await http('/health', { expect: 200 });
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw new Error(`backend not reachable at ${BASE} — ${lastErr?.message || lastErr}`);
}

async function main() {
  console.log(`[smoke] target = ${BASE}`);
  console.log(`[smoke] tenant = ${TENANT}`);

  // 1. /health — proves Fastify is listening.
  try {
    const r = await waitForBackend();
    record('GET /health → 200', r.status === 200 && r.body?.status === 'ok',
      `status=${r.status} body=${JSON.stringify(r.body)}`);
  } catch (err) {
    console.error(envHint());
    record('GET /health → 200', false, err.message);
    return finish(2);
  }

  // 2. /ready — best-effort; not-configured is acceptable but should be reported.
  try {
    const r = await http('/ready');
    const db = r.body?.database;
    const ok = r.status === 200 && (db === 'connected' || db === 'not-configured');
    record(`GET /ready → 200 (database=${db ?? 'unknown'})`, ok,
      `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (db === 'not-configured') {
      console.log('[smoke] note: DATABASE_URL is not configured; dev-token routes will 503.');
    }
  } catch (err) {
    record('GET /ready', false, err.message);
  }

  // 3. /api/v1/listings without auth → 401.
  try {
    const r = await http('/api/v1/listings', { expect: 401 });
    record('GET /api/v1/listings (no auth) → 401',
      r.body?.error?.code === 'unauthorized',
      `body=${JSON.stringify(r.body)}`);
  } catch (err) {
    record('GET /api/v1/listings (no auth) → 401', false, err.message);
  }

  // 4. /api/v1/listings with dev-super → 200, items non-empty.
  let listBody = null;
  try {
    const r = await http('/api/v1/listings', { token: 'dev-super', expect: 200 });
    listBody = r.body;
    const total = listBody?.pagination?.total;
    const items = Array.isArray(listBody?.items) ? listBody.items : [];
    record(`GET /api/v1/listings (dev-super) → 200, items=${items.length}, total=${total}`,
      items.length > 0 && total >= items.length,
      `body=${JSON.stringify({ total, returned: items.length })}`);
  } catch (err) {
    record('GET /api/v1/listings (dev-super) → 200', false, err.message);
  }

  // 5. serviceCategory=rent — every returned row must have serviceCategory=rent.
  try {
    const r = await http('/api/v1/listings?serviceCategory=rent&limit=50',
      { token: 'dev-super', expect: 200 });
    const items = r.body?.items || [];
    const allRent = items.length > 0 && items.every((i) => i.serviceCategory === 'rent');
    record(`GET /api/v1/listings?serviceCategory=rent → ${items.length} items, all rent`,
      allRent,
      `categories=${[...new Set(items.map((i) => i.serviceCategory))].join(',') || '∅'}`);
  } catch (err) {
    record('GET /api/v1/listings?serviceCategory=rent', false, err.message);
  }

  // 6. serviceCategory=pg — every returned row must have serviceCategory=pg.
  try {
    const r = await http('/api/v1/listings?serviceCategory=pg&limit=50',
      { token: 'dev-super', expect: 200 });
    const items = r.body?.items || [];
    const allPg = items.length > 0 && items.every((i) => i.serviceCategory === 'pg');
    record(`GET /api/v1/listings?serviceCategory=pg → ${items.length} items, all pg`,
      allPg,
      `categories=${[...new Set(items.map((i) => i.serviceCategory))].join(',') || '∅'}`);
  } catch (err) {
    record('GET /api/v1/listings?serviceCategory=pg', false, err.message);
  }

  // 7. Detail route — pick the first item from the unfiltered list and fetch it.
  try {
    const first = listBody?.items?.[0];
    if (!first) throw new Error('no items in list body — cannot test detail');
    const r = await http(`/api/v1/listings/${first.id}`,
      { token: 'dev-super', expect: 200 });
    record(`GET /api/v1/listings/${first.id} → 200 (title="${r.body?.title}")`,
      r.body?.id === first.id,
      `body.id=${r.body?.id}`);
  } catch (err) {
    record('GET /api/v1/listings/:id', false, err.message);
  }

  // 8. dev-field (own scope) — every returned row must be assigned to u-asha.
  try {
    const r = await http('/api/v1/listings?limit=50',
      { token: 'dev-field', expect: 200 });
    const items = r.body?.items || [];
    const allAsha = items.every((i) => i.assignedTo?.id === 'u-asha');
    record(`GET /api/v1/listings (dev-field, own scope) → ${items.length} items, all assigned to u-asha`,
      items.length > 0 && allAsha,
      `assigned=${[...new Set(items.map((i) => i.assignedTo?.id))].join(',') || '∅'}`);
  } catch (err) {
    record('GET /api/v1/listings (dev-field)', false, err.message);
  }

  // 9+. Optional write lifecycle — opt-in via SMOKE_WRITE=1.
  if (process.env.SMOKE_WRITE === '1') {
    await runWriteLifecycle();
  }

  return finish(0);
}

/**
 * Optional write lifecycle:
 *   create → patch → assign → verify → photo → delete
 * Run with `SMOKE_WRITE=1 npm run smoke:listings`.
 *
 * Runs only the happy path; RBAC / 404 / 400 paths are exercised by
 * the route test suite (src/routes/listings.write.test.js).
 */
async function runWriteLifecycle() {
  let createdId = null;

  // 9. Create a sacrificial listing under dev-super.
  try {
    const res = await fetch(`${BASE}/api/v1/listings`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-super',
      },
      body: JSON.stringify({
        serviceCategory: 'rent',
        propertyType: 'apartment',
        listingIntent: 'available_for_rent',
        title: 'Smoke-write 1BHK',
        rentMonthly: 25000,
        city: 'Bangalore',
      }),
    });
    const body = await res.json();
    createdId = body?.id;
    record(`POST /api/v1/listings (dev-super) → ${res.status} (id=${createdId})`,
      res.status === 201 && Boolean(createdId) && body?.title === 'Smoke-write 1BHK',
      `status=${res.status} id=${createdId} title=${body?.title} code=${body?.error?.code}`);
    if (!createdId) return;
  } catch (err) {
    record('POST /api/v1/listings', false, err.message);
    return; // cannot continue without an id
  }

  // 10. Patch the title.
  try {
    const url = `${BASE}/api/v1/listings/${createdId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-super',
      },
      body: JSON.stringify({ title: 'Smoke-write PATCHED 1BHK', notes: 'patched' }),
    });
    const body = await res.json();
    record(`PATCH /api/v1/listings/:id → ${res.status} (title="${body?.title}")`,
      res.status === 200 && body?.title === 'Smoke-write PATCHED 1BHK',
      `status=${res.status} title=${body?.title}`);
  } catch (err) {
    record('PATCH /api/v1/listings/:id', false, err.message);
  }

  // 11. Assign to dev-accounts (u-anil).
  try {
    const res = await fetch(`${BASE}/api/v1/listings/${createdId}/assign`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-super',
      },
      body: JSON.stringify({ assignedUserId: 'u-anil', reason: 'smoke reassign' }),
    });
    const body = await res.json();
    record(`POST /api/v1/listings/:id/assign → ${res.status} (assignedTo=${body?.assignedTo?.id})`,
      res.status === 200 && body?.assignedTo?.id === 'u-anil',
      `status=${res.status} assignedTo=${body?.assignedTo?.id}`);
  } catch (err) {
    record('POST /api/v1/listings/:id/assign', false, err.message);
  }

  // 12. Verify the listing.
  try {
    const res = await fetch(`${BASE}/api/v1/listings/${createdId}/verify`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-super',
      },
      body: JSON.stringify({ status: 'verified' }),
    });
    const body = await res.json();
    record(`POST /api/v1/listings/:id/verify → ${res.status} (verification=${body?.status?.verification})`,
      res.status === 200 && body?.status?.verification === 'verified',
      `status=${res.status} verification=${body?.status?.verification}`);
  } catch (err) {
    record('POST /api/v1/listings/:id/verify', false, err.message);
  }

  // 13. Add a photo metadata row.
  try {
    const res = await fetch(`${BASE}/api/v1/listings/${createdId}/photos`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-super',
      },
      body: JSON.stringify({
        objectKey: `listings/${createdId}/smoke-hall.jpg`,
        caption: 'Smoke hall',
        category: 'Interior',
      }),
    });
    const body = await res.json();
    record(`POST /api/v1/listings/:id/photos → ${res.status} (category=${body?.category})`,
      res.status === 201 && body?.category === 'Interior',
      `status=${res.status} category=${body?.category}`);
  } catch (err) {
    record('POST /api/v1/listings/:id/photos', false, err.message);
  }

  // 14. Soft delete the listing.
  try {
    const res = await fetch(`${BASE}/api/v1/listings/${createdId}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer dev-super',
      },
    });
    const body = await res.json();
    record(`DELETE /api/v1/listings/:id → ${res.status} (ok=${body?.ok})`,
      res.status === 200 && body?.ok === true,
      `status=${res.status} body=${JSON.stringify(body)}`);
  } catch (err) {
    record('DELETE /api/v1/listings/:id', false, err.message);
  }

  // 15. Subsequent GET on the deleted id returns 404.
  try {
    const r = await http(`/api/v1/listings/${createdId}`,
      { token: 'dev-super', expect: 404 });
    record(`GET /api/v1/listings/${createdId} (post-delete) → 404`, true, '');
  } catch (err) {
    record('GET /api/v1/listings/:id post-delete', false, err.message);
  }
}

function finish(code) {
  console.log('\n[smoke] results:');
  for (const line of summary) console.log(line);
  console.log(`[smoke] ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(code || (failures === 0 ? 0 : 1));
}

main().catch((err) => {
  console.error('[smoke] unhandled error:', err?.stack || err);
  finish(1);
});
