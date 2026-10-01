// Smoke tests for src/services/matchListings.js. Pure node — no test runner.
// Run with: `node src/services/matchListings.test.js`.
// Exit code 0 = all assertions passed; non-zero = at least one failed.

import { scoreLeadListing, rankLeadMatches } from './matchListings.js';

let failed = 0;
let passed = 0;

function assert(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}`);
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ----- Fixtures -----
const projectOrchid = { id: 'proj-orchid', city: 'Bengaluru', location: 'Whitefield, Bengaluru' };
const projectNexa = { id: 'proj-nexa', city: 'Bengaluru', location: 'Indiranagar, Bengaluru' };
const projectSkyline = { id: 'proj-skyline', city: 'Bengaluru', location: 'Hebbal, Bengaluru' };
const projects = [projectOrchid, projectNexa, projectSkyline];

// Compact rent lead — fits a 1BHK / studio budget.
const rentLead = {
  id: 'lead-rent-1',
  projectId: 'proj-orchid',
  unitType: '2BHK',
  budgetMin: 200000,
  budgetMax: 500000,
};
const saleLead = {
  id: 'lead-sale-1',
  projectId: 'proj-nexa',
  unitType: '3BHK',
  budgetMin: 20000000,
  budgetMax: 28000000,
};
const pgLead = {
  id: 'lead-pg-1',
  projectId: 'proj-nexa',
  unitType: '1BHK',
  budgetMin: 100000,
  budgetMax: 250000,
};

// Available, in-budget, same project — should rank highly
const rentListingFit = {
  id: 'list-fit',
  serviceCategory: 'rent',
  listingIntent: 'rent-out',
  propertyType: '2BHK Apartment',
  projectId: 'proj-orchid',
  location: { city: 'Bengaluru', locality: 'Whitefield' },
  pricing: { rentMonthly: 45000, price: null },
  status: { availability: 'available', verification: 'verified' },
};
// Incompatible intent (office) — should be hard-filtered out
const officeListing = {
  id: 'list-office',
  serviceCategory: 'office',
  listingIntent: 'lease-out',
  propertyType: 'Managed Office',
  projectId: 'proj-skyline',
  location: { city: 'Bengaluru', locality: 'Hebbal' },
  pricing: { rentMonthly: 280000, price: null },
  status: { availability: 'available', verification: 'verified' },
};
// Reserved — should be hard-filtered out
const reservedListing = {
  ...rentListingFit,
  id: 'list-reserved',
  status: { availability: 'reserved', verification: 'verified' },
};
// Booked — should be hard-filtered out
const bookedListing = {
  ...rentListingFit,
  id: 'list-booked',
  status: { availability: 'booked', verification: 'verified' },
};
// Off-market — should be hard-filtered out
const offMarketListing = {
  ...rentListingFit,
  id: 'list-off-market',
  status: { availability: 'off-market', verification: 'verified' },
};
// Over-budget — should be hard-filtered out (annual cost > 1.30 × 1.5 Cr cap)
const overBudgetListing = {
  ...rentListingFit,
  id: 'list-over-budget',
  pricing: { rentMonthly: 200000, price: null }, // 200k * 12 = 2.4 Cr > 1.95 Cr cap
};
// Incompatible intent (PG for rent lead with 2BHK) — PG is rent-compatible, so this DOES survive
const pgListing = {
  id: 'list-pg',
  serviceCategory: 'pg',
  listingIntent: 'list-pg',
  propertyType: 'Single Room (PG)',
  projectId: 'proj-nexa',
  location: { city: 'Bengaluru', locality: 'Indiranagar' },
  pricing: { rentMonthly: 14500, price: null },
  status: { availability: 'available', verification: 'verified' },
};

// ----- Tests -----

group('hard filters', () => {
  const rank = rankLeadMatches(rentLead, [
    rentListingFit,
    officeListing,
    reservedListing,
    bookedListing,
    offMarketListing,
    overBudgetListing,
    pgListing,
  ], projects);

  const ids = rank.map((r) => r.listing.id);
  assert('excludes off-market', !ids.includes('list-off-market'));
  assert('excludes booked', !ids.includes('list-booked'));
  assert('excludes reserved', !ids.includes('list-reserved'));
  assert('excludes incompatible category (office)', !ids.includes('list-office'));
  assert('excludes over-budget by more than 30%', !ids.includes('list-over-budget'));
  assert('keeps a good match', ids.includes('list-fit'));
});

group('ranking sorts strong above weak', () => {
  // The weaker listing still survives the hard filter (in-budget, compatible
  // intent, available) and scores >= 45, but lower than the strong match.
  const weaker = {
    ...rentListingFit,
    id: 'list-weaker',
    projectId: 'proj-orchid',                              // SAME project (so project score 30 too)
    location: { city: 'Bengaluru', locality: 'Indiranagar' }, // city OK, locality wrong
    pricing: { rentMonthly: 30000, price: null },                    // cheaper → budget 15
    propertyType: '3BHK Apartment',                                // ±1 BHK → 5
  };
  const rank = rankLeadMatches(rentLead, [weaker, rentListingFit], projects);
  assert('strong match outranks weaker match',
    rank.length === 2 && rank[0].listing.id === 'list-fit' && rank[1].listing.id === 'list-weaker');
});

group('returns empty when no strong match exists', () => {
  const rank = rankLeadMatches(rentLead, [officeListing, reservedListing, overBudgetListing], projects);
  assert('empty array when nothing survives', Array.isArray(rank) && rank.length === 0);
});

group('sale lead matches sale listings only', () => {
  const saleListing = {
    id: 'list-sale',
    serviceCategory: 'resale',
    listingIntent: 'sell',
    propertyType: '3BHK Apartment',
    projectId: 'proj-nexa',
    location: { city: 'Bengaluru', locality: 'Indiranagar' },
    pricing: { rentMonthly: null, price: 25000000 },
    status: { availability: 'available', verification: 'verified' },
  };
  const rank = rankLeadMatches(saleLead, [rentListingFit, saleListing, officeListing], projects);
  const ids = rank.map((r) => r.listing.id);
  assert('sale listing matches sale lead', ids.includes('list-sale'));
  assert('rent listing filtered out for sale lead', !ids.includes('list-fit'));
  assert('office listing filtered out for sale lead', !ids.includes('list-office'));
});

group('PG lead matches PG listings', () => {
  const rank = rankLeadMatches(pgLead, [rentListingFit, pgListing], projects);
  const ids = rank.map((r) => r.listing.id);
  // rent lead has project=orchid; pgListing has project=orchid. The intent
  // is null (no project.serviceCategory), so the intent filter doesn't
  // drop either. Budget hard cap: 250000 * 1.30 = 325000. rentListingFit
  // annual = 45000 * 12 = 540000, well above 325000 → dropped. pgListing
  // annual = 14500 * 12 = 174000, well under 325000 → kept. Score for
  // pgListing: city 15 + locality 10 + budget 15 + BHK 10 (1BHK vs
  // "Single Room (PG)" — no BHK number, scoreBhk returns 0) + project 30
  // (same proj-nexa) + category soft 5 = 75. Survives floor of 45.
  assert('PG listing survives', ids.includes('list-pg'));
  assert('rent listing dropped on budget', !ids.includes('list-fit'));
});

group('scoreLeadListing returns reason string', () => {
  const result = scoreLeadListing(rentLead, rentListingFit, projectOrchid);
  assert('reason is a non-empty string', typeof result.reason === 'string' && result.reason.length > 0);
  assert('score is a number', typeof result.score === 'number');
  assert('score >= 45 for the good match', result.score >= 45);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
