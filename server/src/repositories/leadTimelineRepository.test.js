// Unit tests for the pure timeline merge: buildTimelineItems.
//
// No DB required — rows are plain objects shaped like the pg rows the
// getLeadTimeline queries return. Covers ordering, shapes, corrupt-row
// tolerance, and the documented gaps (no audit_log, no status-transition
// times, no bookings).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTimelineItems } from './leadTimelineRepository.js';

const LEAD = {
  id: 'ld_1',
  contactId: 'c_1',
  createdAt: '2026-09-10T10:00:00.000Z',
  createdBy: 'u-raj',
  source: 'walk-in',
  status: 'New',
  nextFollowUp: '2026-09-20T10:00:00.000Z',
};

test('merges all sources in journey order, oldest-first', () => {
  const items = buildTimelineItems({
    lead: LEAD,
    leadCreatorName: 'Raj',
    contact: {
      id: 'c_1',
      created_at: '2026-09-01T09:00:00.000Z',
      requirements: '2bhk rent',
      notes: null,
      created_by: 'u-tele',
      creator_name: 'Tele',
      phone: '+9111',
    },
    calls: [
      {
        id: 'cc_1',
        occurred_at: '2026-09-05T09:00:00.000Z',
        outcome: 'interested',
        notes: 'wants visit',
        agent_id: 'u-asha',
        agent_name: 'Asha',
        direction: 'outbound',
        duration_seconds: 120,
        next_follow_up: '2026-09-06T09:00:00.000Z',
      },
    ],
    events: [
      {
        id: 'e_1',
        visit_id: 'v_1',
        status: 'Scheduled',
        note: null,
        actor_id: 'u-raj',
        actor_name: 'Raj',
        occurred_at: '2026-09-12T09:00:00.000Z',
        scheduled_at: '2026-09-15T09:00:00.000Z',
        assigned_to: 'u-asha',
        assigned_name: 'Asha',
      },
    ],
    viewings: [
      {
        id: 'w_1',
        visit_id: 'v_1',
        listing_id: 'l_1',
        listing_title: 'Sunrise 2BHK',
        agent_id: 'u-asha',
        agent_name: 'Asha',
        shown_at: '2026-09-15T10:00:00.000Z',
        assistance_status: 'assisted',
        feedback: 'liked it',
      },
    ],
  });

  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((i) => i.type),
    ['contact_created', 'call', 'lead_created', 'visit_event', 'viewing', 'follow_up'],
  );
  // Chronological: each item is at-or-after the previous one.
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i].occurredAt >= items[i - 1].occurredAt, `item ${i} out of order`);
  }
  // Spot-check shapes.
  assert.equal(items[0].id, 'contact_c_1');
  assert.deepEqual(items[0].actor, { id: 'u-tele', name: 'Tele' });
  assert.equal(items[1].title, 'Call – Interested');
  assert.deepEqual(items[1].actor, { id: 'u-asha', name: 'Asha' });
  assert.equal(items[1].meta.nextFollowUp, '2026-09-06T09:00:00.000Z');
  assert.equal(items[2].title, 'Converted to lead');
  assert.deepEqual(items[2].actor, { id: 'u-raj', name: 'Raj' });
  assert.equal(items[3].title, 'Visit – Scheduled');
  assert.equal(items[3].meta.assignedTo, 'u-asha');
  assert.equal(items[4].title, 'Shown: Sunrise 2BHK');
  assert.equal(items[4].detail, 'liked it');
  assert.equal(items[5].title, 'Follow-up due');
  assert.equal(items[5].actor, null);
});

test('same-timestamp items break ties in journey order, then by id', () => {
  const at = '2026-09-10T10:00:00.000Z';
  const items = buildTimelineItems({
    lead: { ...LEAD, createdAt: at, nextFollowUp: null, contactId: null },
    contact: { id: 'c_1', created_at: at },
    calls: [{ id: 'cc_b', occurred_at: at }, { id: 'cc_a', occurred_at: at }],
    events: [{ id: 'e_1', visit_id: 'v_1', status: 'Scheduled', occurred_at: at }],
    viewings: [{ id: 'w_1', visit_id: 'v_1', shown_at: at, listing_id: 'l_1' }],
  });
  assert.deepEqual(
    items.map((i) => i.id),
    ['contact_c_1', 'lead_ld_1', 'call_cc_a', 'call_cc_b', 'event_e_1', 'viewing_w_1'],
  );
});

test('corrupt timestamps are skipped, never fatal', () => {
  const items = buildTimelineItems({
    lead: { ...LEAD, createdAt: 'not-a-date', nextFollowUp: 'also-bad' },
    contact: { id: 'c_1', created_at: 'bad' },
    calls: [{ id: 'cc_1', occurred_at: 'bad' }],
    events: [{ id: 'e_1', occurred_at: 'bad' }],
    viewings: [{ id: 'w_1', shown_at: 'bad' }],
  });
  assert.deepEqual(items, []);
});

test('lead without contact or follow-up renders lead_created only', () => {
  const items = buildTimelineItems({
    lead: { ...LEAD, contactId: null, nextFollowUp: null },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'lead_created');
  assert.equal(items[0].title, 'Lead created');
});

test('unknown call outcome falls back to the raw value, missing to Logged', () => {
  const items = buildTimelineItems({
    calls: [
      { id: 'a', occurred_at: '2026-09-05T09:00:00.000Z', outcome: 'weird' },
      { id: 'b', occurred_at: '2026-09-06T09:00:00.000Z', outcome: null },
    ],
  });
  assert.equal(items[0].title, 'Call – weird');
  assert.equal(items[1].title, 'Call – Logged');
});

test('empty input returns an empty list', () => {
  assert.deepEqual(buildTimelineItems({}), []);
  assert.deepEqual(buildTimelineItems(), []);
});
