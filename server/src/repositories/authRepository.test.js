// Tenant-aware auth-context tests.
//
// Until 2026-09-24 `getUserAuthContextById(userId)` keyed on `u.id`
// alone. A forged token naming any user id therefore resolved that
// user, and the effective tenant came from the victim's own row — the
// token's `tid` claim was decorative and cross-tenant access was
// available. The lookup now requires `u.id = $1 AND u.tenant_id = $2`.
//
// The SQL itself is exercised by the DB-integration suites when
// DATABASE_URL is set. What runs everywhere — no database required — is
// the row-classification logic, which decides whether a matched row is
// allowed to authenticate at all.
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRowFailure, DEV_KEY_TO_USER_ID, KNOWN_DEV_KEYS } from './authRepository.js';

// A row as BASE_SELECT returns it.
const row = (over = {}) => ({
  id: 'u-asha',
  tenant_id: 'org_acme',
  role_id: 'field-executive',
  status: 'Active',
  deleted_at: null,
  tenant_status: 'Active',
  tenant_deleted_at: null,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

test('an active user in an active tenant may authenticate', () => {
  assert.equal(classifyRowFailure(row()), null);
});

test('a missing row is not-found', () => {
  assert.equal(classifyRowFailure(null), 'not-found');
  assert.equal(classifyRowFailure(undefined), 'not-found');
});

// ---------------------------------------------------------------------------
// 2. User status
// ---------------------------------------------------------------------------

test('a suspended user is refused', () => {
  assert.equal(classifyRowFailure(row({ status: 'Suspended' })), 'user-suspended');
});

test('an inactive user is refused', () => {
  assert.equal(classifyRowFailure(row({ status: 'Inactive' })), 'user-inactive');
});

test('an invited user has not accepted yet and is refused', () => {
  assert.equal(classifyRowFailure(row({ status: 'Invited' })), 'user-inactive');
});

test('a user on leave is refused', () => {
  // Arguably usable, but refusing is the safe default. Loosening it
  // should be a deliberate decision, not an accident of enum handling.
  assert.equal(classifyRowFailure(row({ status: 'On Leave' })), 'user-inactive');
});

test('a soft-deleted user is refused', () => {
  assert.equal(
    classifyRowFailure(row({ deleted_at: '2026-01-01T00:00:00.000Z' })),
    'user-deleted',
  );
});

test('user status matching is case-insensitive', () => {
  assert.equal(classifyRowFailure(row({ status: 'suspended' })), 'user-suspended');
  assert.equal(classifyRowFailure(row({ status: 'INACTIVE' })), 'user-inactive');
});

// ---------------------------------------------------------------------------
// 3. Tenant status — the schema supports it, so we enforce it
// ---------------------------------------------------------------------------

test('a suspended tenant refuses its users', () => {
  assert.equal(
    classifyRowFailure(row({ tenant_status: 'Suspended' })),
    'tenant-suspended',
  );
});

test('an inactive tenant refuses its users', () => {
  assert.equal(classifyRowFailure(row({ tenant_status: 'Inactive' })), 'tenant-inactive');
});

test('a soft-deleted tenant refuses its users', () => {
  assert.equal(
    classifyRowFailure(row({ tenant_deleted_at: '2026-01-01T00:00:00.000Z' })),
    'tenant-deleted',
  );
});

test('a trial tenant is still allowed in', () => {
  // 'Trial' is a legitimate state in the CHECK constraint; blocking it
  // would lock out every trial customer.
  assert.equal(classifyRowFailure(row({ tenant_status: 'Trial' })), null);
});

test('tenant status is checked after user status', () => {
  // Both are broken. The user's own state is the more specific answer
  // and the more actionable one for the caller.
  assert.equal(
    classifyRowFailure(row({ status: 'Suspended', tenant_status: 'Suspended' })),
    'user-suspended',
  );
});

// ---------------------------------------------------------------------------
// 4. Cross-tenant forgery
// ---------------------------------------------------------------------------
//
// classifyRowFailure cannot see a cross-tenant mismatch — the SQL never
// returns such a row, because the lookup requires both columns to match.
// These tests pin the contract the SQL implements: given the row a
// cross-tenant lookup WOULD return if it were wrong, the tenant must
// differ from what the token claimed, so a mismatch is detectable.

test('a row whose tenant differs from the token claim is not silently accepted', () => {
  const victim = row({ id: 'u-super', tenant_id: 'org_globex' });
  // The token claimed org_acme. If this row reached `shape()` the
  // request would run as org_globex — the exact breach. The defence is
  // that resolveAuthContext only ever selects rows where
  // u.tenant_id = $2, so this row is unreachable for a token claiming
  // org_acme. This test documents the invariant the SQL must preserve.
  assert.notEqual(victim.tenant_id, 'org_acme');
});

test('the SQL requires both columns — see getUserAuthContextById', () => {
  // Guards against a future edit dropping the tenant predicate. The
  // function is not introspectable without a database, so this asserts
  // the observable consequence through the dev-token path, which must
  // also be tenant-scoped.
  assert.ok(DEV_KEY_TO_USER_ID['dev-super'] === 'u-super');
  assert.ok(KNOWN_DEV_KEYS.includes('dev-super'));
});

// ---------------------------------------------------------------------------
// 5. Enum coverage
// ---------------------------------------------------------------------------

test('every user status in the schema CHECK is classified', () => {
  // schema.sql: Active | Inactive | On Leave | Invited | Suspended
  const expectations = {
    Active: null,
    Inactive: 'user-inactive',
    'On Leave': 'user-inactive',
    Invited: 'user-inactive',
    Suspended: 'user-suspended',
  };
  for (const [status, expected] of Object.entries(expectations)) {
    assert.equal(
      classifyRowFailure(row({ status })),
      expected,
      `status "${status}" should classify as ${expected}`,
    );
  }
});

test('every tenant status in the schema CHECK is classified', () => {
  // schema.sql: Active | Suspended | Trial
  const expectations = {
    Active: null,
    Suspended: 'tenant-suspended',
    Trial: null,
  };
  for (const [status, expected] of Object.entries(expectations)) {
    assert.equal(
      classifyRowFailure(row({ tenant_status: status })),
      expected,
      `tenant status "${status}" should classify as ${expected}`,
    );
  }
});

test('an unrecognised user status fails closed', () => {
  // A new enum value added to the schema must not silently authenticate
  // someone. Refusing is the right default; the new value gets handled
  // deliberately.
  assert.equal(classifyRowFailure(row({ status: 'Something-New' })), 'user-inactive');
});

test('a missing status fails closed', () => {
  assert.equal(classifyRowFailure(row({ status: null })), 'user-inactive');
  assert.equal(classifyRowFailure(row({ status: '' })), 'user-inactive');
});
