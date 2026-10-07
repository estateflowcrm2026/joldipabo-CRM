// Tests for the live lead-match scorer + saved-matches repository.
//
// Layered:
//   1. Pure scorer units (no DB): hard filters, weighted signals, ranking.
//   2. Repository units over a fake pg client (no DB): list skips
//      out-of-scope listings silently, refresh upserts suggested rows but
//      preserves human statuses, update validates + 404s cross-scope.
//   3. Validator units: validateMatchUpdate / validateRefreshOptions.
//
// Fixtures mirror the seed vocabulary: listing_intent is one of
// available_for_rent / available_for_sale / wanted / client_requirement;
// service_category is rent/pg/buy/sell/land/office/commercial; the lead
// carries service_need + pipe-delimited preferred_location.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  passesHardFilter,
  projectLocality,
  rankLeadMatches,
  scoreLeadListing,
  splitLocationTokens,
} from './leadMatchScorer.js';
import {
  listMatches,
  refreshMatches,
  updateMatch,
  validateMatchUpdate,
  validateRefreshOptions,
} from './leadMatchesRepository.js';

function lead(over = {}) {
  return {
    id: 'ld_1',
    serviceNeed: 'rent',
    preferredLocation: 'Indiranagar | Koramangala',
    desiredPropertyType: 'apartment',
    requirements: {},
    projectId: null,
    project: null,
    pricing: { budgetMin: null, budgetMax: null, rentMin: 45000, rentMax: 75000 },
    owner: { id: 'u-asha' },
    teamId: 't_north',
    ...over,
  };
}

function listing(over = {}) {
  return {
    id: 'l_1',
    serviceCategory: 'rent',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
    location: { city: 'Bangalore', locality: 'Indiranagar' },
    pricing: { price: null, rentMonthly: 65000 },
    specs: { bedrooms: 3 },
    status: { availability: 'available' },
    assignedTo: { id: 'u-asha' },
    teamId: 't_north',
    project: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure scorer
// ---------------------------------------------------------------------------

test('splitLocationTokens splits pipes, commas and semicolons', () => {
  assert.deepEqual(splitLocationTokens('Indiranagar | Koramangala'), ['indiranagar', 'koramangala']);
  assert.deepEqual(splitLocationTokens('A, B; C'), ['a', 'b', 'c']);
  assert.deepEqual(splitLocationTokens(null), []);
  assert.deepEqual(splitLocationTokens(''), []);
});

test('projectLocality takes the first comma-part', () => {
  assert.equal(projectLocality('Whitefield, Bengaluru'), 'whitefield');
  assert.equal(projectLocality(null), null);
});

test('demand intents never pass the hard filter', () => {
  for (const intent of ['wanted', 'client_requirement', 'other']) {
    assert.equal(
      passesHardFilter(lead(), listing({ listingIntent: intent })),
      false,
      intent,
    );
  }
});

test('intent mismatch fails the hard filter (rent lead vs sale listing)', () => {
  assert.equal(
    passesHardFilter(lead(), listing({ listingIntent: 'available_for_sale', serviceCategory: 'sell' })),
    false,
  );
});

test('category mismatch fails the hard filter (rent lead vs pg listing)', () => {
  assert.equal(
    passesHardFilter(lead(), listing({ serviceCategory: 'pg' })),
    false,
  );
});

test('non-available listings fail the hard filter', () => {
  assert.equal(passesHardFilter(lead(), listing({ status: { availability: 'booked' } })), false);
  assert.equal(passesHardFilter(lead(), listing({ status: { availability: 'occupied' } })), false);
});

test('over-budget listings fail the hard filter (>1.30x ceiling)', () => {
  // Ceiling 75k/mo; 100k/mo is 1.33x → dropped.
  assert.equal(passesHardFilter(lead(), listing({ pricing: { rentMonthly: 100000 } })), false);
  // 90k/mo is 1.2x → survives the filter (scored as near-budget).
  assert.equal(passesHardFilter(lead(), listing({ pricing: { rentMonthly: 90000 } })), true);
});

test('scoreLeadListing weights a strong fit above the floor', () => {
  const { score, reason } = scoreLeadListing(lead(), listing());
  // category 20 + locality 10 + budget 15 + property type 6 = 51.
  assert.equal(score, 51);
  assert.match(reason, /category/);
  assert.match(reason, /locality/);
  assert.match(reason, /budget/);
});

test('same-project signal dominates', () => {
  const l = lead({ projectId: 'p_1', project: { id: 'p_1' } });
  const li = listing({ project: { id: 'p_1' } });
  const { score } = scoreLeadListing(l, li, { city: 'Bangalore', location: 'Indiranagar, Bengaluru' });
  // category 20 + project 30 + city 15 + locality 10 + budget 15 + property 6 = 96.
  assert.equal(score, 96);
});

test('rankLeadMatches drops below-floor pairs and sorts desc', () => {
  const ranked = rankLeadMatches(
    lead(),
    [
      listing({ id: 'l_good' }),
      listing({ id: 'l_nope', serviceCategory: 'pg' }),
      listing({ id: 'l_far', location: { city: 'Mumbai', locality: 'Bandra' }, pricing: { rentMonthly: 70000 } }),
    ],
  );
  // l_good scores 45 (kept); l_nope filtered; l_far scores 35 (dropped).
  assert.deepEqual(ranked.map((r) => r.listing.id), ['l_good']);
});

test('rankLeadMatches honours topN and minScore', () => {
  const ranked = rankLeadMatches(lead(), [listing({ id: 'l_a' }), listing({ id: 'l_b' })], null, {
    topN: 1,
    minScore: 0,
  });
  assert.equal(ranked.length, 1);
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test('validateMatchUpdate accepts status and/or note', () => {
  assert.deepEqual(validateMatchUpdate({ status: 'viewed_by_lead' }), { status: 'viewed_by_lead' });
  assert.deepEqual(validateMatchUpdate({ note: '  called  ' }), { note: 'called' });
  assert.deepEqual(validateMatchUpdate({ note: null }), { note: null });
  assert.deepEqual(
    validateMatchUpdate({ status: 'withdrawn', note: 'x' }),
    { status: 'withdrawn', note: 'x' },
  );
});

test('validateMatchUpdate rejects unknown status, bad note, empty body', () => {
  assert.throws(() => validateMatchUpdate({ status: 'matched' }), /status must be one of/);
  assert.throws(() => validateMatchUpdate({ note: 42 }), /note must be a string/);
  assert.throws(() => validateMatchUpdate({}), /Provide status and\/or note/);
  assert.throws(() => validateMatchUpdate(null), /must be an object/);
});

test('validateRefreshOptions defaults and bounds', () => {
  assert.deepEqual(validateRefreshOptions({}), { topN: 10, minScore: 45 });
  assert.deepEqual(validateRefreshOptions({ topN: '5', minScore: '35' }), { topN: 5, minScore: 35 });
  assert.throws(() => validateRefreshOptions({ topN: 0 }), /topN must be/);
  assert.throws(() => validateRefreshOptions({ topN: 26 }), /topN must be/);
  assert.throws(() => validateRefreshOptions({ minScore: 101 }), /minScore must be/);
});

// ---------------------------------------------------------------------------
// 2. Repository over a fake pg client
// ---------------------------------------------------------------------------

const SUPER = {
  id: 'u-admin',
  tenantId: 'org_acme',
  permissionMatrix: {
    leads: { view: 'all', edit: 'all' },
    listings: { view: 'all' },
  },
};

const FIELD = {
  id: 'u-asha',
  tenantId: 'org_acme',
  teamId: 't_north',
  permissionMatrix: {
    leads: { view: 'own', edit: 'own' },
    listings: { view: 'own' },
  },
};

function leadRow() {
  return {
    id: 'ld_1',
    tenant_id: 'org_acme',
    name: 'Meera',
    phone: '+9111',
    email: null,
    project_id: null,
    status: 'New',
    score: 'hot',
    budget_min: null,
    budget_max: null,
    source: null,
    notes: null,
    owner_id: 'u-asha',
    team_id: 't_north',
    created_by: 'u-asha',
    next_follow_up: null,
    service_need: 'rent',
    client_type: 'tenant',
    requirements: {},
    rent_min: 45000,
    rent_max: 75000,
    preferred_location: 'Indiranagar | Koramangala',
    desired_property_type: 'apartment',
    move_in_date: null,
    purchase_timeline: null,
    matched_listing_ids: [],
    visit_status: null,
    contact_id: null,
    owner_user_id: 'u-asha',
    owner_user_name: 'Asha',
    owner_user_email: null,
    team_pk: 't_north',
    team_name: 'North',
    project_pk: null,
    project_name: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    deleted_at: null,
  };
}

function listingRow(id, over = {}) {
  return {
    id,
    tenant_id: 'org_acme',
    service_category: 'rent',
    property_type: 'apartment',
    listing_intent: 'available_for_rent',
    title: `Listing ${id}`,
    description: null,
    address: null,
    city: 'Bangalore',
    locality: 'Indiranagar',
    geo: null,
    price: null,
    rent_monthly: '65000',
    deposit: null,
    area_sqft: null,
    bedrooms: 3,
    bathrooms: null,
    furnished: null,
    amenities: [],
    availability_status: 'available',
    verification_status: 'verified',
    owner_contact_name: null,
    owner_contact_phone: null,
    owner_contact_email: null,
    assigned_to: 'u-asha',
    team_id: 't_north',
    project_id: null,
    notes: null,
    created_by: 'u-asha',
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    deleted_at: null,
    assigned_user_id: 'u-asha',
    assigned_user_name: 'Asha',
    assigned_user_email: null,
    project_pk: null,
    project_name: null,
    project_city: null,
    ...over,
  };
}

// Minimal pg stand-in: answers the exact statements the repository
// issues, keyed by unmistakable SQL fragments.
function makeClient({ matches = [], listings = [] } = {}) {
  const written = [];
  return {
    written,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ');
      if (sql.includes('FROM leads l')) {
        return { rows: [leadRow()], rowCount: 1 };
      }
      if (sql.includes('FROM projects')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM listing_matches m')) {
        return { rows: matches.map((m) => ({ ...m })), rowCount: matches.length };
      }
      if (sql.includes('FROM listing_matches')) {
        return { rows: matches.map((m) => ({ ...m })), rowCount: matches.length };
      }
      if (sql.includes('/* scope:candidates */')) {
        return { rows: listings.map((l) => ({ ...l })), rowCount: listings.length };
      }
      if (sql.includes('FROM listings l')) {
        const ids = params.slice(1);
        const rows = listings.filter((l) => ids.includes(l.id));
        return { rows: rows.map((l) => ({ ...l })), rowCount: rows.length };
      }
      if (sql.startsWith('INSERT INTO listing_matches')) {
        written.push({ op: 'insert', params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE listing_matches')) {
        written.push({ op: 'update', sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT m.* FROM listing_matches m')) {
        return { rows: matches.map((m) => ({ ...m })), rowCount: matches.length };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    },
  };
}

test('listMatches skips out-of-scope listings silently', async () => {
  const matches = [
    { id: 'lm_1', lead_id: 'ld_1', listing_id: 'l_mine', match_score: '45.00', status: 'suggested', note: null, matched_at: new Date(), matched_by: null },
    { id: 'lm_2', lead_id: 'ld_1', listing_id: 'l_theirs', match_score: '90.00', status: 'suggested', note: null, matched_at: new Date(), matched_by: null },
  ];
  const listings = [
    listingRow('l_mine'),
    listingRow('l_theirs', { assigned_to: 'u-vijay', assigned_user_id: 'u-vijay', assigned_user_name: 'Vijay' }),
  ];
  const client = makeClient({ matches, listings });
  const result = await listMatches(FIELD, 'ld_1', { client });
  assert.equal(result.leadId, 'ld_1');
  // l_theirs is outside u-asha's listings:view (own) → skipped, not 404.
  assert.deepEqual(result.items.map((i) => i.listingId), ['l_mine']);
  assert.equal(result.items[0].listing.title, 'Listing l_mine');
  assert.match(result.items[0].reason, /score/);
});

test('listMatches 404s an out-of-scope lead', async () => {
  const other = {
    ...FIELD,
    id: 'u-stranger',
    permissionMatrix: {
      leads: { view: 'own', edit: 'own' },
      listings: { view: 'all' },
    },
  };
  const client = makeClient({ matches: [], listings: [] });
  await assert.rejects(() => listMatches(other, 'ld_1', { client }), /Lead not found/);
});

test('refreshMatches upserts suggested rows and preserves human statuses', async () => {
  const matches = [
    { id: 'lm_human', lead_id: 'ld_1', listing_id: 'l_mine', match_score: '40.00', status: 'viewed_by_lead', note: null, matched_at: new Date(), matched_by: null },
  ];
  const client = makeClient({ matches, listings: [listingRow('l_mine')] });
  const result = await refreshMatches(
    { user: SUPER, leadId: 'ld_1', topN: 10, minScore: 0 },
    { client },
  );
  assert.equal(result.leadId, 'ld_1');
  // l_mine re-ranks (score 45) → score refreshed, status preserved via UPDATE.
  const update = client.written.find((w) => w.op === 'update');
  assert.ok(update, 'expected an UPDATE for the human-status row');
  assert.match(update.sql, /match_score/);
  assert.ok(!update.sql.includes('matched_by'), 'human-status row must not reset matched_by');
  assert.ok(result.items.some((i) => i.listingId === 'l_mine' && i.status === 'viewed_by_lead'));
});

test('refreshMatches inserts new suggested rows for fresh candidates', async () => {
  const client = makeClient({ matches: [], listings: [listingRow('l_new')] });
  await refreshMatches({ user: SUPER, leadId: 'ld_1', topN: 10, minScore: 0 }, { client });
  const insert = client.written.find((w) => w.op === 'insert');
  assert.ok(insert, 'expected an INSERT for the fresh candidate');
  assert.ok(insert.params.includes('l_new'));
});

test('refreshMatches 404s when the lead is outside edit scope', async () => {
  const other = {
    ...FIELD,
    id: 'u-stranger',
    permissionMatrix: {
      leads: { view: 'all', edit: 'own' },
      listings: { view: 'all' },
    },
  };
  const client = makeClient({ matches: [], listings: [] });
  await assert.rejects(
    () => refreshMatches({ user: other, leadId: 'ld_1' }, { client }),
    /Lead not found/,
  );
});

test('updateMatch writes status+note and returns the row', async () => {
  const before = {
    id: 'lm_1', lead_id: 'ld_1', listing_id: 'l_mine', match_score: '45.00',
    status: 'suggested', note: null, matched_at: new Date(), matched_by: null,
  };
  const after = { ...before, status: 'viewed_by_lead', note: 'called' };
  let reads = 0;
  const listings = [listingRow('l_mine')];
  const client = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ');
      if (sql.includes('FROM leads l')) return { rows: [leadRow()], rowCount: 1 };
      if (sql.includes('FROM projects')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM listing_matches m')) {
        reads += 1;
        return { rows: [{ ...(reads === 1 ? before : after) }], rowCount: 1 };
      }
      if (sql.includes('FROM listing_matches')) {
        reads += 1;
        return { rows: [{ ...(reads === 1 ? before : after) }], rowCount: 1 };
      }
      if (sql.includes('FROM listings l')) return { rows: listings.map((l) => ({ ...l })), rowCount: 1 };
      if (sql.startsWith('UPDATE listing_matches')) {
        assert.match(sql, /status = /);
        assert.match(sql, /note = /);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    },
  };
  const row = await updateMatch(
    { user: SUPER, leadId: 'ld_1', listingId: 'l_mine', changes: { status: 'viewed_by_lead', note: 'called' } },
    { client },
  );
  assert.equal(row.status, 'viewed_by_lead');
  assert.equal(row.note, 'called');
  assert.equal(row.listingId, 'l_mine');
});

test('updateMatch 404s an out-of-scope listing', async () => {
  const before = {
    id: 'lm_1', lead_id: 'ld_1', listing_id: 'l_theirs', match_score: '45.00',
    status: 'suggested', note: null, matched_at: new Date(), matched_by: null,
  };
  const listings = [
    listingRow('l_theirs', { assigned_to: 'u-vijay', assigned_user_id: 'u-vijay', assigned_user_name: 'Vijay' }),
  ];
  const client = {
    async query(text) {
      const sql = text.replace(/\s+/g, ' ');
      if (sql.includes('FROM leads l')) return { rows: [leadRow()], rowCount: 1 };
      if (sql.includes('FROM projects')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM listing_matches')) return { rows: [before], rowCount: 1 };
      if (sql.includes('FROM listings l')) return { rows: listings, rowCount: 1 };
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    },
  };
  await assert.rejects(
    () => updateMatch({ user: FIELD, leadId: 'ld_1', listingId: 'l_theirs', changes: { status: 'withdrawn' } }, { client }),
    /Match not found/,
  );
});
