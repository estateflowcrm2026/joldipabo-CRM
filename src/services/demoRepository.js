// Demo repository — the in-memory implementation of the Repository contract.
// Reads from the seed module directly. Writes succeed without persistence so
// the demo flows (create lead, check in, etc.) work the same as before.
//
// When a real backend exists, swap this out via setRepository(apiRepository).
// The store continues to manage UI state; the repository only owns the
// data origin.

import {
  USERS,
  PROJECTS,
  LEADS,
  SITE_VISITS,
  ATTENDANCE,
  PHOTOS,
  THREADS,
  MESSAGES,
  ACTIVITY,
  TEAMS,
  LISTINGS,
  MATCHES,
  ROLE_DEFINITIONS,
} from '../data/seed.js';

// Every entity in the demo is keyed by a stable id. Wrap as a Map for cheap
// lookups. The Maps are intentionally not exported — all access goes through
// the Repository methods below so we can later swap them for HTTP calls.

const clone = (value) =>
  typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

const tables = {
  users: new Map(USERS.map((r) => [r.id, r])),
  roles: new Map(Object.entries(ROLE_DEFINITIONS)),
  teams: new Map(TEAMS.map((r) => [r.id, r])),
  projects: new Map(PROJECTS.map((r) => [r.id, r])),
  leads: new Map(LEADS.map((r) => [r.id, r])),
  visits: new Map(SITE_VISITS.map((r) => [r.id, r])),
  attendance: new Map(ATTENDANCE.map((r) => [r.id, r])),
  photos: new Map(PHOTOS.map((r) => [r.id, r])),
  threads: new Map(THREADS.map((r) => [r.id, r])),
  messages: MESSAGES.slice(),
  activity: ACTIVITY.slice(),
  listings: new Map(LISTINGS.map((r) => [r.id, r])),
  matches: new Map(MATCHES.map((r) => [r.id, r])),
};

let nextId = 1000;
const makeId = (prefix) => `${prefix}-${(++nextId).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const nowIso = () => new Date().toISOString();
const todayDay = () => new Date().toISOString().slice(0, 10);

const assertEntity = (entity) => {
  if (!tables[entity] && entity !== 'roles') {
    throw new Error(`Unknown entity: ${entity}`);
  }
};

// Apply a `{ field__op: value }` filter. Supported ops mirror what a SQL
// builder would expose: eq, ne, in, nin, gt, gte, lt, lte, contains.
const matchesWhere = (record, where) => {
  if (!where) return true;
  for (const [rawKey, expected] of Object.entries(where)) {
    const lastSep = rawKey.lastIndexOf('__');
    const op = lastSep === -1 ? 'eq' : rawKey.slice(lastSep + 2);
    const field = lastSep === -1 ? rawKey : rawKey.slice(0, lastSep);
    const actual = record[field];
    switch (op) {
      case 'eq':
        if (actual !== expected) return false;
        break;
      case 'ne':
        if (actual === expected) return false;
        break;
      case 'in':
        if (!Array.isArray(expected) || !expected.includes(actual)) return false;
        break;
      case 'nin':
        if (Array.isArray(expected) && expected.includes(actual)) return false;
        break;
      case 'gt':
        if (!(actual > expected)) return false;
        break;
      case 'gte':
        if (!(actual >= expected)) return false;
        break;
      case 'lt':
        if (!(actual < expected)) return false;
        break;
      case 'lte':
        if (!(actual <= expected)) return false;
        break;
      case 'contains':
        if (typeof actual !== 'string' || !actual.toLowerCase().includes(String(expected).toLowerCase())) return false;
        break;
      default:
        break;
    }
  }
  return true;
};

const collectItems = (entity) => {
  if (entity === 'roles') return Array.from(tables.roles.values());
  return Array.from(tables[entity].values ? tables[entity].values() : tables[entity]);
};

const sortItems = (items, sortBy, sortDirection) => {
  if (!sortBy) return items;
  const dir = sortDirection === 'asc' ? 1 : -1;
  return items.slice().sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    return av < bv ? -dir : dir;
  });
};

const paginate = (items, pagination) => {
  const { limit = 100, offset = 0, cursor } = pagination || {};
  if (cursor) {
    const idx = items.findIndex((r) => r.id === cursor);
    const slice = idx === -1 ? items : items.slice(idx + 1);
    return {
      items: slice.slice(0, limit),
      nextCursor: slice.length > limit ? slice[limit - 1].id : undefined,
      total: items.length,
    };
  }
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
  };
};

export const demoRepository = {
  async list(entity, filters = {}) {
    assertEntity(entity);
    const items = sortItems(
      collectItems(entity).filter((r) => matchesWhere(r, filters.where)),
      filters.sortBy,
      filters.sortDirection
    );
    return paginate(items, filters.pagination);
  },

  async get(entity, id) {
    assertEntity(entity);
    if (entity === 'roles') {
      return clone(tables.roles.get(id) || null);
    }
    const record = tables[entity].get(id);
    return record ? clone(record) : null;
  },

  async create(entity, payload) {
    assertEntity(entity);
    const id = payload.id || makeId(entity.slice(0, 4));
    const record = {
      id,
      createdAt: payload.createdAt || nowIso(),
      updatedAt: nowIso(),
      ...payload,
    };
    if (entity === 'roles') {
      tables.roles.set(id, record);
    } else {
      tables[entity].set(id, record);
    }
    return { record: clone(record) };
  },

  async update(entity, id, changes) {
    assertEntity(entity);
    const store = entity === 'roles' ? tables.roles : tables[entity];
    const current = store.get(id);
    if (!current) {
      throw new Error(`Record not found: ${entity}#${id}`);
    }
    const next = { ...current, ...changes, id, updatedAt: nowIso() };
    store.set(id, next);
    return { record: clone(next) };
  },

  async remove(entity, id) {
    assertEntity(entity);
    const store = entity === 'roles' ? tables.roles : tables[entity];
    store.delete(id);
  },

  // Per-entity specialised methods. They mirror the future API surface
  // so call sites can stay abstract.
  custom: {
    leads: {
      async assign(id, staffId, teamId) {
        const lead = tables.leads.get(id);
        if (!lead) throw new Error(`Lead not found: ${id}`);
        const next = { ...lead, ownerId: staffId, teamId: teamId || lead.teamId, updatedAt: nowIso() };
        tables.leads.set(id, next);
        return { record: clone(next) };
      },
    },
    attendance: {
      async checkIn({ location, siteId, staffId }) {
        const record = {
          id: makeId('att'),
          staffId,
          date: todayDay(),
          checkIn: nowIso(),
          checkOut: null,
          checkInLocation: location,
          checkOutLocation: null,
          checkInSiteId: siteId || null,
          checkOutSiteId: null,
          status: 'Checked In',
          approvedBy: null,
          hoursWorked: null,
        };
        tables.attendance.set(record.id, record);
        return { record: clone(record) };
      },
      async checkOut({ staffId, location, siteId }) {
        for (const record of tables.attendance.values()) {
          if (record.staffId !== staffId) continue;
          if (record.checkOut) continue;
          const hours = (Date.now() - new Date(record.checkIn).getTime()) / (1000 * 60 * 60);
          const next = {
            ...record,
            checkOut: nowIso(),
            checkOutLocation: location,
            checkOutSiteId: siteId || record.checkInSiteId,
            status: 'Checked Out',
            hoursWorked: Number(hours.toFixed(2)),
            updatedAt: nowIso(),
          };
          tables.attendance.set(record.id, next);
          return { record: clone(next) };
        }
        throw new Error('No open attendance record to check out from.');
      },
      async approve(id, status) {
        const record = tables.attendance.get(id);
        if (!record) throw new Error(`Attendance not found: ${id}`);
        const next = { ...record, status, updatedAt: nowIso() };
        tables.attendance.set(id, next);
        return { record: clone(next) };
      },
    },
    photos: {
      async presignUpload({ filename }) {
        const objectKey = `photos/${makeId('obj')}-${filename}`;
        return {
          url: `https://example.invalid/upload/${objectKey}`,
          fields: { 'Content-Type': 'image/jpeg' },
          objectKey,
        };
      },
      async approve(id, approved) {
        const record = tables.photos.get(id);
        if (!record) throw new Error(`Photo not found: ${id}`);
        const next = { ...record, approved: Boolean(approved), updatedAt: nowIso() };
        tables.photos.set(id, next);
        return { record: clone(next) };
      },
    },
    messages: {
      async send({ threadId, fromId, body, channel = 'in-app' }) {
        const message = {
          id: makeId('msg'),
          threadId,
          fromId,
          body,
          channel,
          timestamp: nowIso(),
        };
        tables.messages.push(message);
        const thread = tables.threads.get(threadId);
        if (thread) {
          tables.threads.set(threadId, { ...thread, lastMessageAt: message.timestamp });
        }
        return { record: clone(message) };
      },
    },
    listings: {
      // Mirrors `POST /listings/:id/assign` — sets assignedTo and bumps updatedAt.
      async assign(id, staffId) {
        const listing = tables.listings.get(id);
        if (!listing) throw new Error(`Listing not found: ${id}`);
        if (!tables.users.has(staffId)) throw new Error(`Staff not found: ${staffId}`);
        const next = {
          ...listing,
          assignedTo: staffId,
          updatedAt: nowIso(),
        };
        tables.listings.set(id, next);
        return { record: clone(next) };
      },
      // Mirrors `POST /listings/:id/verify` — sets status.verification + verifiedBy + verifiedAt.
      async verify(id, status, reason = null, verifiedBy = null) {
        const listing = tables.listings.get(id);
        if (!listing) throw new Error(`Listing not found: ${id}`);
        const next = {
          ...listing,
          status: {
            ...listing.status,
            verification: status,
            verificationReason: reason,
            verifiedBy,
            verifiedAt: nowIso(),
          },
          updatedAt: nowIso(),
        };
        tables.listings.set(id, next);
        return { record: clone(next) };
      },
    },
  },
};

// The custom methods on demoRepository.custom.* are the only place per-entity
// specialised behaviour lives. Call sites use the explicit form:
//   await repo.custom.attendance.checkIn(...)
//   await repo.custom.leads.assign(...)
// Keeping the surface uniform makes it easy to swap to a real API repository
// later — both will expose the same `custom` object shape.

