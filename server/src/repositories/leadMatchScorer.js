// Lead ↔ listing match scorer (live backend).
//
// Deterministic, no ML. Same two-stage pipeline as the demo scorer
// (src/services/matchListings.js) — hard filters, then weighted signals —
// but written against the REAL backend vocabulary, which differs from the
// demo seed in three ways:
//
//   * `listing_intent` is one of available_for_rent / available_for_sale /
//     wanted / client_requirement. Only the two `available_for_*` intents
//     are supply; `wanted` and `client_requirement` rows are demand and
//     must never be suggested as properties.
//   * The lead carries `service_need` (rent/pg/buy/sell/land/office/
//     commercial/project_buy), a pipe-delimited `preferred_location`
//     ("Indiranagar | Koramangala"), `desired_property_type`, and a free
//     `requirements` jsonb (which may hold `bedrooms`) — there is no
//     `unitType` / `budgetMin` / BHK-string convention.
//   * The listing carries `service_category`, `property_type`, direct
//     `city` / `locality` columns, `price` / `rent_monthly`, and integer
//     `bedrooms` — there is no nested pricing/location shape.
//
// Inputs are backend DTOs (as returned by toLeadDTO / toListingDTO) plus a
// `{ city, location }` project row. Pure module — no DB, no React — so the
// ranking is unit-testable without Postgres.
//
// Scoring weights mirror the demo scorer so scores stay comparable:
// category 20, same project 30, city 15, locality 10, budget up to 15,
// property fit up to 10. Floor 45 (loose 35), cap topN.

// Lead `service_need` → compatible listing `service_category` values.
const SERVICE_COMPATIBILITY = {
  rent:        new Set(['rent']),
  pg:          new Set(['pg']),
  buy:         new Set(['buy', 'sell']),
  project_buy: new Set(['buy', 'sell']),
  sell:        new Set(['sell', 'buy', 'land']),
  land:        new Set(['land']),
  office:      new Set(['office']),
  commercial:  new Set(['commercial', 'office']),
};

// Offer intents — the only listing_intent values that are supply.
const OFFER_INTENTS = new Set(['available_for_rent', 'available_for_sale']);

// Lead need → required offer intent. Rent/PG compare monthly rent;
// buy/sell/land compare outright price; office/commercial can be either
// (the seed leases offices but sells commercial units).
function requiredIntent(serviceNeed) {
  if (serviceNeed === 'rent' || serviceNeed === 'pg') return 'available_for_rent';
  if (
    serviceNeed === 'buy' ||
    serviceNeed === 'project_buy' ||
    serviceNeed === 'sell' ||
    serviceNeed === 'land'
  ) {
    return 'available_for_sale';
  }
  return null;
}

// Split "Indiranagar | Koramangala" (also tolerating commas/semicolons)
// into lowercase tokens. Returns [] when there is nothing to split.
export function splitLocationTokens(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(/[|,;]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

// First comma-part of a project location ("Whitefield, Bengaluru" →
// "whitefield"). Null when unparseable.
export function projectLocality(location) {
  if (!location || typeof location !== 'string') return null;
  const first = location.split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first ? first.toLowerCase() : null;
}

// Effective monthly cost of a listing for rent-like needs, outright price
// for sale-like needs. Null when the listing carries no usable figure.
function listingCost(listing, forRent) {
  const pricing = listing?.pricing || {};
  if (forRent) {
    const monthly = Number(pricing.rentMonthly);
    return Number.isFinite(monthly) && monthly > 0 ? monthly : null;
  }
  const price = Number(pricing.price);
  if (Number.isFinite(price) && price > 0) return price;
  const monthly = Number(pricing.rentMonthly);
  if (Number.isFinite(monthly) && monthly > 0) return monthly * 12;
  return null;
}

// Lead-side ceiling in the same units: monthly rent or outright price.
function leadCeiling(lead, forRent) {
  const pricing = lead?.pricing || {};
  if (forRent) {
    const max = Number(pricing.rentMax ?? pricing.rentMin);
    return Number.isFinite(max) && max > 0 ? max : null;
  }
  const max = Number(pricing.budgetMax ?? pricing.budgetMin);
  return Number.isFinite(max) && max > 0 ? max : null;
}

/**
 * Hard filter. A listing is a candidate iff:
 *   - availability is 'available'
 *   - listing_intent is supply AND matches the lead's required intent
 *     (when the lead need implies one)
 *   - service_category is compatible with the lead's service_need
 *     (when the need is recognised)
 *   - effective cost is within 1.30 × the lead ceiling (when both known)
 *
 * @param {object} lead — backend lead DTO
 * @param {object} listing — backend listing DTO
 * @returns {boolean}
 */
export function passesHardFilter(lead, listing) {
  if (!listing) return false;
  if (!listing.status || listing.status.availability !== 'available') return false;
  if (!OFFER_INTENTS.has(listing.listingIntent)) return false;

  const need = lead?.serviceNeed ?? null;
  const wantIntent = requiredIntent(need);
  if (wantIntent && listing.listingIntent !== wantIntent) return false;

  if (need) {
    const compat = SERVICE_COMPATIBILITY[need];
    if (compat && !compat.has(listing.serviceCategory)) return false;
  }

  const forRent = listing.listingIntent === 'available_for_rent';
  const cost = listingCost(listing, forRent);
  const ceiling = lead ? leadCeiling(lead, forRent) : null;
  if (cost != null && ceiling != null && cost > ceiling * 1.3) return false;

  return true;
}

function scoreCategory(need, listing) {
  if (!need) return { points: 5, label: 'category (soft)' };
  const compat = SERVICE_COMPATIBILITY[need];
  if (!compat) return { points: 5, label: 'category (soft)' };
  if (compat.has(listing.serviceCategory)) return { points: 20, label: 'category' };
  return { points: 0, label: null };
}

function scoreProject(lead, listing) {
  const listingProjectId = listing?.project?.id ?? null;
  if (lead?.projectId && listingProjectId && lead.projectId === listingProjectId) {
    return { points: 30, label: 'project' };
  }
  return { points: 0, label: null };
}

function scoreCity(project, listing) {
  const city = (project?.city || '').trim().toLowerCase();
  const listingCity = (listing?.location?.city || '').trim().toLowerCase();
  if (city && listingCity && city === listingCity) return { points: 15, label: 'city' };
  return { points: 0, label: null };
}

function scoreLocality(lead, project, listing) {
  const listingLocality = (listing?.location?.locality || '').trim().toLowerCase();
  if (!listingLocality) return { points: 0, label: null };
  const tokens = new Set(splitLocationTokens(lead?.preferredLocation));
  const projLocal = projectLocality(project?.location);
  if (projLocal) tokens.add(projLocal);
  if (tokens.has(listingLocality)) return { points: 10, label: 'locality' };
  return { points: 0, label: null };
}

function scoreBudget(lead, listing) {
  const forRent = listing.listingIntent === 'available_for_rent';
  const cost = listingCost(listing, forRent);
  const ceiling = lead ? leadCeiling(lead, forRent) : null;
  if (cost == null || ceiling == null || ceiling <= 0) return { points: 0, label: null };
  if (cost <= ceiling) return { points: 15, label: 'budget' };
  if (cost <= ceiling * 1.2) return { points: 8, label: 'budget (near)' };
  return { points: 0, label: null };
}

function scoreProperty(lead, listing) {
  let points = 0;
  const labels = [];
  if (
    lead?.desiredPropertyType &&
    listing?.propertyType &&
    lead.desiredPropertyType === listing.propertyType
  ) {
    points += 6;
    labels.push('property type');
  }
  const wantBed = Number(lead?.requirements?.bedrooms);
  const hasBed = Number(listing?.specs?.bedrooms);
  if (Number.isFinite(wantBed) && Number.isFinite(hasBed)) {
    if (wantBed === hasBed) {
      points += 4;
      labels.push('bedrooms');
    } else if (Math.abs(wantBed - hasBed) === 1) {
      points += 2;
      labels.push('bedrooms (near)');
    }
  }
  if (points === 0) return { points: 0, label: null };
  return { points, label: labels.join(' + ') };
}

/**
 * Score one lead/listing pair. Returns `{ score, reason }`; score is
 * 0..100, reason names the signals that fired.
 */
export function scoreLeadListing(lead, listing, project = null) {
  if (!lead || !listing) return { score: 0, reason: 'no data' };
  const need = lead.serviceNeed ?? null;
  const signals = [
    scoreCategory(need, listing),
    scoreProject(lead, listing),
    scoreCity(project, listing),
    scoreLocality(lead, project, listing),
    scoreBudget(lead, listing),
    scoreProperty(lead, listing),
  ];
  const score = signals.reduce((sum, s) => sum + s.points, 0);
  const labels = signals.map((s) => s.label).filter(Boolean);
  const reason = labels.length
    ? `${labels.join(', ')} — score ${score}/100`
    : `weak match — score ${score}/100`;
  return { score, reason };
}

/**
 * Rank candidate listings for a lead: hard filter → score → drop below
 * `minScore` → sort desc → cap `topN`. Returns
 * `Array<{ listing, score, reason }>`.
 */
export function rankLeadMatches(lead, listings, project = null, { topN = 10, minScore = 45 } = {}) {
  if (!lead || !Array.isArray(listings)) return [];
  const scored = [];
  for (const listing of listings) {
    if (!passesHardFilter(lead, listing)) continue;
    const { score, reason } = scoreLeadListing(lead, listing, project);
    if (score < minScore) continue;
    scored.push({ listing, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(topN, 0));
}
