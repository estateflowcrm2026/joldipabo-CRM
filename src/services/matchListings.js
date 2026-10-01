// Lead-to-listing match scorer. Pure module — no React, no store.
//
// Two-stage pipeline:
//
//   1. HARD FILTERS — drop incompatible listings before scoring. The UI
//      should never see an absurd match (a 4BHK buyer matched to a PG bed,
//      or a budget lead matched to a reserved office). The hard filter rules
//      are documented inline below; changing them changes the demo story.
//
//   2. SCORING — for listings that survive, add up weighted signals:
//      category intent alignment (20), same project (30), city (15),
//      locality (10), intent-aware budget fit (up to 15), BHK match (up to 10).
//      Anything below the score floor (45) is dropped before reaching the UI.
//
// Lead-shape gap: today's lead has `unitType`, `budgetMin/Max`, `projectId`
// but no `locality`, `city`, or `category`. We derive those from the lead's
// project (`project.city`, parsed from `project.location`) so matches work
// against today's seed. When the project is missing or unrecognised, the
// matcher degrades gracefully rather than guessing aggressively: a "soft
// default" path gives Signal #1 a 5/20 instead of zero, and other
// city/locality signals are simply no-ops.
//
// This is a DEMO scorer. The future backend (`POST /api/v1/leads/:id/
// match-suggestions`) will replace it, but the public function signature is
// the contract the future API will mirror.

// ---------- Intent vocabulary ----------

// Map of lead-derived "intent" → compatible listing intents.
const INTENT_COMPATIBILITY = {
  rent:        new Set(['rent-out', 'list-pg']),
  sale:        new Set(['sell', 'sell-plot']),
  lease:       new Set(['lease-out', 'rent-out']),
  office:      new Set(['lease-out']),
};

// Map project.serviceCategory → derived intent. Returns `null` when the
// project has no recognisable category — the caller handles this via the
// "soft default" path. We accept whatever the project carries; if the seed
// doesn't include serviceCategory (today's seed doesn't), this falls back to
// `null` for everyone and we lean on the listing's own intent instead.
function mapCategoryToIntent(category) {
  if (!category) return null;
  const c = String(category).toLowerCase();
  if (c === 'rent') return 'rent';
  if (c === 'pg') return 'rent';
  if (c === 'sale') return 'sale';
  if (c === 'land') return 'sale';
  if (c === 'office') return 'lease';
  if (c === 'resale') return 'sale';
  if (c === 'owner-listed') return 'sale';
  return null;
}

// Derive the lead's effective intent from the lead's project.
function deriveLeadIntent(lead, project) {
  if (!project) return null;
  return mapCategoryToIntent(project.serviceCategory);
}

// Derive city and locality from the project's `location` string. The seed
// stores `location` as "Whitefield, Bengaluru" so we split on comma. Returns
// `{ city, locality }` with `null` for fields that can't be parsed.
function deriveProjectCityLocality(project) {
  if (!project) return { city: null, locality: null };
  // Prefer the explicit `city` field when available.
  const city = project.city || null;
  let locality = null;
  if (typeof project.location === 'string') {
    const parts = project.location.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) locality = parts[0];
    else if (parts.length === 1) locality = parts[0];
  }
  return { city, locality };
}

// ---------- Hard filters ----------

// A listing passes the hard filter iff:
//   - status.availability === 'available'
//   - listing intent is compatible with the lead-derived intent
//     (or the lead intent is `null`, in which case no intent filter)
//   - the listing's effective annual cost is within 1.30 × lead.budgetMax
function passesHardFilter(lead, listing, leadIntent) {
  if (!listing) return false;
  if (!listing.status || listing.status.availability !== 'available') return false;

  // Intent compatibility. If the lead intent is null, we don't filter by
  // intent — the soft default in scoring handles it. Otherwise the listing
  // intent must be in the lead's compatible set.
  if (leadIntent) {
    const compat = INTENT_COMPATIBILITY[leadIntent];
    if (compat && !compat.has(listing.listingIntent)) {
      return false;
    }
  }

  // Budget hard cap (1.30 × lead.budgetMax). For rent/lease intents we
  // annualise monthly rent; for sale intents we use the outright price.
  if (lead && (lead.budgetMax || lead.budgetMin)) {
    const cap = Number(lead.budgetMax || lead.budgetMin) * 1.30;
    const intent = listing.listingIntent;
    const pricing = listing.pricing || {};
    let cost = null;
    if (intent === 'sell' || intent === 'sell-plot') {
      cost = pricing.price;
    } else if (intent === 'lease-out') {
      cost = pricing.rentMonthly ? pricing.rentMonthly * 12 : null;
    } else {
      // rent-out, list-pg
      cost = pricing.rentMonthly ? pricing.rentMonthly * 12 : null;
    }
    if (cost && cap && cost > cap) return false;
  }

  return true;
}

// ---------- Scoring ----------

function scoreCategory(leadIntent, listing) {
  // 20 = full intent match; 10 = partial; 5 = soft default (lead intent null).
  if (!leadIntent) return { points: 5, label: 'category (soft)' };
  const compat = INTENT_COMPATIBILITY[leadIntent];
  if (compat && compat.has(listing.listingIntent)) {
    return { points: 20, label: 'category' };
  }
  return { points: 10, label: 'category (partial)' };
}

function scoreProject(lead, listing) {
  if (lead.projectId && listing.projectId && lead.projectId === listing.projectId) {
    return { points: 30, label: 'project' };
  }
  return { points: 0, label: null };
}

function scoreCity(derivedCity, listing) {
  if (derivedCity && listing.location && listing.location.city === derivedCity) {
    return { points: 15, label: 'city' };
  }
  return { points: 0, label: null };
}

function scoreLocality(derivedLocality, listing) {
  if (derivedLocality && listing.location && listing.location.locality === derivedLocality) {
    return { points: 10, label: 'locality' };
  }
  return { points: 0, label: null };
}

function scoreBudget(lead, listing) {
  // Intent-aware: compare against the appropriate dimension.
  if (!lead || (!lead.budgetMax && !lead.budgetMin)) return { points: 0, label: null };
  const intent = listing.listingIntent;
  const pricing = listing.pricing || {};
  let cost = null;
  if (intent === 'sell' || intent === 'sell-plot') {
    cost = pricing.price;
  } else if (intent === 'lease-out') {
    cost = pricing.rentMonthly ? pricing.rentMonthly * 12 : null;
  } else {
    cost = pricing.rentMonthly ? pricing.rentMonthly * 12 : null;
  }
  if (!cost) return { points: 0, label: null };

  const max = Number(lead.budgetMax || lead.budgetMin);
  if (!max) return { points: 0, label: null };
  if (cost <= max) return { points: 15, label: 'budget' };
  if (cost <= max * 1.20) return { points: 8, label: 'budget (near)' };
  return { points: 0, label: null };
}

function scoreBhk(lead, listing) {
  // Extract BHK numbers from both sides via /(\d+)\s*BHK/i. The listing's
  // `propertyType` carries the canonical token; the lead's `unitType` may
  // be looser ("4BHK Duplex").
  const leadMatch = (lead.unitType || '').match(/(\d+)\s*BHK/i);
  const listMatch = (listing.propertyType || '').match(/(\d+)\s*BHK/i);
  if (!leadMatch || !listMatch) return { points: 0, label: null };
  const leadBhk = Number(leadMatch[1]);
  const listBhk = Number(listMatch[1]);
  if (leadBhk === listBhk) return { points: 10, label: 'property type' };
  if (Math.abs(leadBhk - listBhk) === 1) return { points: 5, label: 'property type (near)' };
  return { points: 0, label: null };
}

// ---------- Public API ----------

// `scoreLeadListing(lead, listing, project)` returns `{ score, reason }`.
// Score is 0..100; reason is a short human-readable string built from the
// signals that fired.
export function scoreLeadListing(lead, listing, project) {
  if (!lead || !listing) return { score: 0, reason: 'no data' };
  const leadIntent = deriveLeadIntent(lead, project);
  const { city: derivedCity, locality: derivedLocality } = deriveProjectCityLocality(project);

  const signals = [
    scoreCategory(leadIntent, listing),
    scoreProject(lead, listing),
    scoreCity(derivedCity, listing),
    scoreLocality(derivedLocality, listing),
    scoreBudget(lead, listing),
    scoreBhk(lead, listing),
  ];

  const score = signals.reduce((sum, s) => sum + s.points, 0);
  const labels = signals.map((s) => s.label).filter(Boolean);
  const reason = labels.length
    ? `${labels.join(', ')} — score ${score}/100`
    : `weak match — score ${score}/100`;
  return { score, reason };
}

// `rankLeadMatches(lead, listings, projects, { topN })` — single entry point
// the UI uses. Hard filter → score → drop score < 45 → sort desc → cap topN.
// Returns `Array<{ listing, score, reason }>`. Listings that don't survive
// the hard filter are never included.
//
// The mobile sheet and the desktop lead drawer both call this; the mobile
// sheet does `slice(0, 3)` on the result.
export function rankLeadMatches(lead, listings, projects, { topN = 10 } = {}) {
  if (!lead || !Array.isArray(listings)) return [];
  const project = (projects || []).find((p) => p.id === lead.projectId);
  const leadIntent = deriveLeadIntent(lead, project);

  const scored = [];
  for (const listing of listings) {
    if (!passesHardFilter(lead, listing, leadIntent)) continue;
    const { score, reason } = scoreLeadListing(lead, listing, project);
    if (score < 45) continue;
    scored.push({ listing, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// `rankLeadMatchesLoose` — same as rankLeadMatches but with a lower score
// floor (35 instead of 45). Used only by the desktop lead drawer's
// "Show lower-confidence matches" footer when the strict ranking is empty.
// Always returns an array; the UI decides whether to show the toggle.
export function rankLeadMatchesLoose(lead, listings, projects, { topN = 5, minScore = 35 } = {}) {
  if (!lead || !Array.isArray(listings)) return [];
  const project = (projects || []).find((p) => p.id === lead.projectId);
  const leadIntent = deriveLeadIntent(lead, project);

  const scored = [];
  for (const listing of listings) {
    if (!passesHardFilter(lead, listing, leadIntent)) continue;
    const { score, reason } = scoreLeadListing(lead, listing, project);
    if (score < minScore) continue;
    scored.push({ listing, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
