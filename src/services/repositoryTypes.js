// Repository contract — the interface every backend implementation must
// satisfy. Today only a demo implementation exists; tomorrow an API
// implementation will live alongside it. JSDoc typedefs only; no runtime.

/**
 * @typedef {'users'
 *   | 'roles'
 *   | 'teams'
 *   | 'projects'
 *   | 'leads'
 *   | 'visits'
 *   | 'attendance'
 *   | 'photos'
 *   | 'threads'
 *   | 'messages'
 *   | 'activity'} EntityName
 */

/**
 * @typedef {Object} Pagination
 * @property {number} [limit]   Max records to return (default 100, max 500).
 * @property {number} [offset]  Records to skip.
 * @property {string} [cursor]  Opaque cursor for keyset pagination (preferred over offset).
 */

/**
 * @typedef {Object} ListFilters
 * @property {Pagination} [pagination]
 * @property {string} [sortBy]    Field name to sort by.
 * @property {'asc'|'desc'} [sortDirection]
 * @property {Object<string, any>} [where]  Field → value filters. Operators are
 *   passed as `{ field__eq: value, field__in: [...] }` to keep the API
 *   predictable and avoid leaking SQL/ORM specifics.
 */

/**
 * @typedef {Object} ListResult
 * @property {Array<Object>} items
 * @property {number} total    Total matching records (may be omitted when
 *   pagination is cursor-based and the count is unknown).
 * @property {string} [nextCursor]
 */

/**
 * @typedef {Object} WriteResult
 * @property {Object} record   The persisted record (with server-generated id
 *   and timestamps).
 */

/**
 * Repository contract. Every entity collection exposes the same shape so the
 * store / hooks can treat them generically.
 *
 * All methods return Promises even when synchronous, so the future API
 * implementation can drop in without changing call sites.
 *
 * @typedef {Object} Repository
 * @property {(entity: EntityName, filters?: ListFilters) => Promise<ListResult>} list
 * @property {(entity: EntityName, id: string) => Promise<Object|null>} get
 * @property {(entity: EntityName, payload: Object) => Promise<WriteResult>} create
 * @property {(entity: EntityName, id: string, changes: Object) => Promise<WriteResult>} update
 * @property {(entity: EntityName, id: string) => Promise<void>} remove
 *
 * Optional helpers (every implementation should provide when supported):
 * @property {?Object<string, Function>} [custom]   Per-entity specialised
 *   methods, e.g. `attendance.checkIn`, `photos.presignUpload`. Custom methods
 *   are documented per-entity in the README and are NOT part of the generic
 *   contract — they vary by backend capability.
 *
 * @typedef {Object} AttendanceCustom
 * @property {(input: { location: Object, siteId?: string }) => Promise<WriteResult>} checkIn
 * @property {(input: { location: Object, siteId?: string }) => Promise<WriteResult>} checkOut
 * @property {(id: string, status: string) => Promise<WriteResult>} approve
 *
 * @typedef {Object} PhotoCustom
 * @property {(input: { filename: string, contentType: string, size: number }) => Promise<{ url: string, fields: Object, objectKey: string }>} presignUpload
 * @property {(id: string, approved: boolean) => Promise<WriteResult>} approve
 *
 * @typedef {Object} LeadCustom
 * @property {(id: string, staffId: string, teamId?: string) => Promise<WriteResult>} assign
 *
 * @typedef {Object} MessageCustom
 * @property {(threadId: string, body: string, channel?: string) => Promise<WriteResult>} send
 */

export const ENTITY_NAMES = Object.freeze([
  'users',
  'roles',
  'teams',
  'projects',
  'leads',
  'visits',
  'attendance',
  'photos',
  'threads',
  'messages',
  'activity',
]);
