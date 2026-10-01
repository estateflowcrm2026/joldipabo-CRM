// Lightweight RBAC primitives test. Runs under `node --test` (Node 20+).
//
// Covers the five scopes for can() + scopeOf(), filterByScope(),
// isSystemRole() and mergeMatrix(). End-to-end route tests are out of
// scope for the scaffold.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  DEFAULT_PERMISSION_MATRIX,
  RESOURCES,
  SCOPES,
  ROLE_DEFINITIONS,
  can,
  filterByScope,
  isSystemRole,
  mergeMatrix,
  scopeOf,
} from './permissions.js';

const user = (overrides = {}) => ({
  id: 'u-asha',
  teamId: 't-north',
  projectIds: ['p-skyline'],
  permissionMatrix: {},
  ...overrides,
});

test('SCOPES is the documented 5-tuple', () => {
  assert.deepEqual(Object.values(SCOPES).sort(), ['all', 'none', 'own', 'project', 'team']);
});

test('ACTIONS is the documented 7-tuple', () => {
  assert.equal(ACTIONS.length, 7);
  assert.deepEqual([...ACTIONS].sort(), ['approve', 'assign', 'create', 'delete', 'edit', 'export', 'view']);
});

test('scopeOf returns none for missing matrix', () => {
  assert.equal(scopeOf(null, 'leads', 'view'), 'none');
  assert.equal(scopeOf({}, 'leads', 'view'), 'none');
  assert.equal(scopeOf({ permissionMatrix: { leads: {} } }, 'leads', 'view'), 'none');
});

test('can denies on scope none', () => {
  const u = user({ permissionMatrix: { leads: { view: 'none' } } });
  assert.equal(can(u, 'leads', 'view'), false);
});

test('can allows on scope all without a record', () => {
  const u = user({ permissionMatrix: { leads: { view: 'all' } } });
  assert.equal(can(u, 'leads', 'view'), true);
  assert.equal(can(u, 'leads', 'view', { ownerId: 'someone-else' }), true);
});

test('can(scope=own) matches only owner', () => {
  const u = user({ permissionMatrix: { leads: { view: 'own' } } });
  assert.equal(can(u, 'leads', 'view', { ownerId: 'u-asha' }), true);
  assert.equal(can(u, 'leads', 'view', { ownerId: 'someone-else' }), false);
});

test('can(scope=team) requires matching teamId on both sides', () => {
  const u = user({ teamId: 't-north', permissionMatrix: { leads: { view: 'team' } } });
  assert.equal(can(u, 'leads', 'view', { teamId: 't-north' }), true);
  assert.equal(can(u, 'leads', 'view', { teamId: 't-south' }), false);
  assert.equal(can(u, 'leads', 'view', {}), false);
});

test('can(scope=project) uses projectIds array', () => {
  const u = user({ projectIds: ['p-skyline', 'p-heights'], permissionMatrix: { photos: { view: 'project' } } });
  assert.equal(can(u, 'photos', 'view', { projectId: 'p-skyline' }), true);
  assert.equal(can(u, 'photos', 'view', { projectId: 'p-other' }), false);
});

test('filterByScope returns [] for scope none and applies predicates otherwise', () => {
  const u = user({ permissionMatrix: { leads: { view: 'own' } } });
  const records = [
    { id: 'l1', ownerId: 'u-asha' },
    { id: 'l2', ownerId: 'someone-else' },
  ];
  assert.deepEqual(filterByScope(u, 'leads', 'view', records), [records[0]]);
  assert.deepEqual(filterByScope({ permissionMatrix: { leads: { view: 'none' } } }, 'leads', 'view', records), []);
});

test('isSystemRole marks super-admin and admin', () => {
  assert.equal(isSystemRole('super-admin'), true);
  assert.equal(isSystemRole('admin'), true);
  assert.equal(isSystemRole('sales-manager'), false);
  assert.equal(isSystemRole('made-up'), false);
});

test('mergeMatrix overrides per resource / action', () => {
  const base = { leads: { view: 'own', create: 'own' }, photos: { view: 'own' } };
  const out = mergeMatrix(base, { leads: { view: 'all' } });
  assert.deepEqual(out.leads.view, 'all');
  assert.deepEqual(out.leads.create, 'own');
  assert.deepEqual(out.photos.view, 'own');
});

test('ROLE_DEFINITIONS includes all 8 seeded roles', () => {
  assert.deepEqual(
    Object.keys(ROLE_DEFINITIONS).sort(),
    [
      'accounts',
      'admin',
      'channel-partner-manager',
      'field-executive',
      'sales-manager',
      'site-manager',
      'super-admin',
      'telecaller',
    ],
  );
});

test('RESOURCES is the documented 11-tuple (listings added 2026-09-23)', () => {
  assert.equal(Object.keys(RESOURCES).length, 11);
  assert.equal(RESOURCES.LISTINGS, 'listings');
});

test('every role has a listings entry with the 7 actions', () => {
  const expectedActions = [
    'view', 'create', 'edit', 'assign', 'approve', 'export', 'delete',
  ];
  for (const roleId of Object.keys(ROLE_DEFINITIONS)) {
    const row = DEFAULT_PERMISSION_MATRIX[roleId].listings;
    assert.ok(row, `${roleId} is missing a listings matrix row`);
    for (const action of expectedActions) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, action),
        `${roleId}.listings is missing action ${action}`,
      );
      assert.ok(
        ['none', 'own', 'team', 'project', 'all'].includes(row[action]),
        `${roleId}.listings.${action} has an out-of-range scope: ${row[action]}`,
      );
    }
  }
});

test('listings.approve defaults: super-admin/admin all, sales-manager team, site-manager project, field-executive/telecaller none, channel-partner-manager none, accounts none', () => {
  const m = DEFAULT_PERMISSION_MATRIX;
  assert.equal(m['super-admin'].listings.approve, 'all');
  assert.equal(m.admin.listings.approve, 'all');
  assert.equal(m['sales-manager'].listings.approve, 'team');
  assert.equal(m['site-manager'].listings.approve, 'project');
  assert.equal(m['field-executive'].listings.approve, 'none');
  assert.equal(m.telecaller.listings.approve, 'none');
  assert.equal(m['channel-partner-manager'].listings.approve, 'none');
  assert.equal(m.accounts.listings.approve, 'none');
});

test('can(scope=own) on listings matches assignedTo, not ownerId', () => {
  const u = user({ permissionMatrix: { listings: { view: 'own' } } });
  assert.equal(can(u, 'listings', 'view', { assignedTo: 'u-asha' }), true);
  assert.equal(can(u, 'listings', 'view', { assignedTo: 'someone-else' }), false);
  // ownerId should NOT count for the listings resource.
  assert.equal(can(u, 'listings', 'view', { ownerId: 'u-asha' }), false);
});
