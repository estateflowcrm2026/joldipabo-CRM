// Route-level tests for the follow-up window filters on
// GET /api/v1/leads and GET /api/v1/contacts.
//
// Layered coverage:
//
//   1. Validation — pure HTTP, no DB needed (dev auth + offline
//      fallback). The validator fires after auth+RBAC but before the
//      data layer, so a bad window is a 400 even with no database:
//      * bad followUpSet                 → 400 invalid-enum
//      * bad followUpFrom                → 400 invalid-field
//      * followUpSet=unset + window      → 400 invalid-payload
//
//   2. DB-integration leads windows — runs only when DATABASE_URL is
//      set. Two sacrificial leads (one overdue, one upcoming) prove
//      the overdue/today/upcoming windows and oldest-due-first
//      ordering. Cleanup goes through DELETE /leads/:id, so no
//      direct SQL is needed.
//
//   3. DB-integration contacts shape — read-only: followUpSet=unset
//      returns 200 and every item carries a nextFollowUp key (the
//      effective MAX over the contact's calls, null when none).
//
// Contacts write-window coverage (create → log call with nextFollowUp
// → window asserts) lives in scripts/verify-followups.js instead:
// contacts have no DELETE endpoint and the app role is revoked DELETE
// on contacts, so fixture cleanup needs the admin role, which tests
// must not assume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { skipIfNoDb } from '../test-support/requireDb.js';

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

function withDevAuth() {
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
}

function withoutDevAuth() {
  delete process.env.DEV_AUTH_ENABLED;
  delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
}

// ---------------------------------------------------------------------------
// 1. Validation (no DB required)
// ---------------------------------------------------------------------------

for (const url of ['/api/v1/leads', '/api/v1/contacts']) {
  test(`GET ${url} rejects a bad followUpSet with 400`, async () => {
    withDevAuth();
    try {
      const app = await newApp();
      const res = await app.inject({
        method: 'GET',
        url: `${url}?followUpSet=someday`,
        headers: { authorization: 'Bearer dev-super' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'invalid-enum');
      await app.close();
    } finally {
      withoutDevAuth();
    }
  });

  test(`GET ${url} rejects a bad followUpFrom with 400`, async () => {
    withDevAuth();
    try {
      const app = await newApp();
      const res = await app.inject({
        method: 'GET',
        url: `${url}?followUpFrom=not-a-date`,
        headers: { authorization: 'Bearer dev-super' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'invalid-field');
      await app.close();
    } finally {
      withoutDevAuth();
    }
  });

  test(`GET ${url} rejects followUpSet=unset combined with a window`, async () => {
    withDevAuth();
    try {
      const app = await newApp();
      const res = await app.inject({
        method: 'GET',
        url: `${url}?followUpSet=unset&followUpFrom=2026-10-04T00:00:00.000Z`,
        headers: { authorization: 'Bearer dev-super' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'invalid-payload');
      await app.close();
    } finally {
      withoutDevAuth();
    }
  });
}

// ---------------------------------------------------------------------------
// 2. DB-integration leads windows (sacrificial fixtures, endpoint cleanup)
// ---------------------------------------------------------------------------

test('GET /api/v1/leads follow-up windows isolate overdue/upcoming, oldest-due-first', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  const marker = `FU_TEST_${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  const overdueDue = new Date(now - 2 * 86_400_000).toISOString();
  const upcomingDue = new Date(now + 2 * 86_400_000).toISOString();
  const nowIso = new Date(now).toISOString();
  const createdIds = [];
  try {
    const app = await newApp();
    const auth = { authorization: 'Bearer dev-super' };

    for (const [name, nextFollowUp] of [
      [`${marker} Overdue`, overdueDue],
      [`${marker} Upcoming`, upcomingDue],
    ]) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/leads',
        headers: auth,
        payload: { name, phone: '+910000000099', nextFollowUp },
      });
      assert.equal(created.statusCode, 201);
      createdIds.push(created.json().id);
    }
    const [overdueId, upcomingId] = createdIds;

    // followUpSet=set scoped to the fixtures: both present,
    // oldest-due-first.
    const set = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?followUpSet=set&q=${marker}&limit=10`,
      headers: auth,
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().pagination.total, 2);
    assert.deepEqual(
      set.json().items.map((item) => item.id),
      [overdueId, upcomingId],
    );
    for (const item of set.json().items) {
      assert.equal(typeof item.nextFollowUp, 'string');
    }

    // Overdue window: everything strictly before now.
    const overdue = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?followUpTo=${encodeURIComponent(nowIso)}&q=${marker}&limit=10`,
      headers: auth,
    });
    assert.equal(overdue.statusCode, 200);
    assert.deepEqual(overdue.json().items.map((item) => item.id), [overdueId]);

    // Upcoming window: everything at or after now.
    const upcoming = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?followUpFrom=${encodeURIComponent(nowIso)}&q=${marker}&limit=10`,
      headers: auth,
    });
    assert.equal(upcoming.statusCode, 200);
    assert.deepEqual(upcoming.json().items.map((item) => item.id), [upcomingId]);

    // Unset excludes both fixtures.
    const unset = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?followUpSet=unset&q=${marker}&limit=10`,
      headers: auth,
    });
    assert.equal(unset.statusCode, 200);
    assert.equal(unset.json().pagination.total, 0);

    // Own-scoped caller sees neither fixture.
    const field = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?followUpSet=set&q=${marker}&limit=10`,
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(field.statusCode, 200);
    assert.ok(
      !field.json().items.some((item) => createdIds.includes(item.id)),
      'own-scoped list must not leak another owner’s fixtures',
    );

    // Cleanup through the product path: soft-delete both fixtures.
    for (const leadId of createdIds) {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/leads/${leadId}`,
        headers: auth,
      });
      assert.equal(del.statusCode, 200);
    }
    createdIds.length = 0;
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    // A failed assertion above must not leave fixtures behind. The
    // soft-delete endpoint is idempotent-safe: deleting an already
    // deleted id 404s, which cleanup ignores.
    if (createdIds.length) {
      process.env.DEV_AUTH_ENABLED = 'true';
      try {
        const app = await newApp();
        for (const leadId of createdIds) {
          const del = await app.inject({
            method: 'DELETE',
            url: `/api/v1/leads/${leadId}`,
            headers: { authorization: 'Bearer dev-super' },
          });
          assert.ok([200, 404].includes(del.statusCode));
        }
        await app.close();
      } finally {
        delete process.env.DEV_AUTH_ENABLED;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. DB-integration contacts shape (read-only)
// ---------------------------------------------------------------------------

test('GET /api/v1/contacts followUpSet=unset returns 200 with effective nextFollowUp', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts?followUpSet=unset&limit=5',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().items));
    for (const item of res.json().items) {
      assert.ok('nextFollowUp' in item, 'list item carries the effective follow-up');
    }
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
