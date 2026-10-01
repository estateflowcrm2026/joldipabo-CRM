// Centralised app store. Exposes:
//   - the data collections (users, projects, leads, visits, attendance, photos, threads, messages)
//   - the current viewer (the user whose role/permissions apply)
//   - a "view mode" toggle (desktop / mobile)
//   - mutators that route through permission checks
//
// All UI consumes the same store; nothing reaches into seed.js directly.
// This keeps the data model swappable for a real API later — only mutators
// need to change.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import {
  USERS as SEED_USERS,
  PROJECTS as SEED_PROJECTS,
  LEADS as SEED_LEADS,
  SITE_VISITS as SEED_VISITS,
  ATTENDANCE as SEED_ATTENDANCE,
  PHOTOS as SEED_PHOTOS,
  THREADS as SEED_THREADS,
  MESSAGES as SEED_MESSAGES,
  ACTIVITY as SEED_ACTIVITY,
  TEAMS as SEED_TEAMS,
  LISTINGS as SEED_LISTINGS,
  MATCHES as SEED_MATCHES,
} from '../data/seed.js';
import { isDemoMode } from '../services/demoFlags.js';
import {
  can as permCan,
  scopeOf,
  DEFAULT_PERMISSION_MATRIX,
  ROLE_DEFINITIONS,
  mergeMatrix,
  isSystemRole,
} from '../data/permissions.js';
import { scoreLeadListing } from '../services/matchListings.js';
import { getSession, subscribeToSession } from '../services/authSession.js';

const StoreContext = createContext(null);

const initialState = {
  users: SEED_USERS,
  projects: SEED_PROJECTS,
  leads: SEED_LEADS,
  visits: SEED_VISITS,
  attendance: SEED_ATTENDANCE,
  photos: SEED_PHOTOS,
  threads: SEED_THREADS,
  messages: SEED_MESSAGES,
  activity: SEED_ACTIVITY,
  teams: SEED_TEAMS,
  listings: SEED_LISTINGS, // Demo seed; API mode fetches via listingsData.jsx
  matches: SEED_MATCHES,
  currentUserId: 'u-admin', // default to Admin so all modules are reachable
  viewMode: 'desktop', // 'desktop' | 'mobile'
  toasts: [],
};

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_CURRENT_USER':
      return { ...state, currentUserId: action.userId };
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.mode };
    case 'TOGGLE_VIEW_MODE':
      return { ...state, viewMode: state.viewMode === 'desktop' ? 'mobile' : 'desktop' };
    case 'UPDATE_LEAD':
      return {
        ...state,
        leads: state.leads.map((lead) =>
          lead.id === action.leadId ? { ...lead, ...action.changes } : lead
        ),
      };
    case 'CREATE_LEAD': {
      const lead = { id: makeId('lead'), createdAt: new Date().toISOString(), ...action.lead };
      return {
        ...state,
        leads: [lead, ...state.leads],
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'created-lead', entity: 'lead', entityId: lead.id, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    }
    case 'DELETE_LEAD':
      return { ...state, leads: state.leads.filter((lead) => lead.id !== action.leadId) };
    case 'ASSIGN_LEAD':
      return {
        ...state,
        leads: state.leads.map((lead) =>
          lead.id === action.leadId
            ? { ...lead, ownerId: action.staffId, teamId: action.teamId || lead.teamId }
            : lead
        ),
      };
    case 'UPDATE_VISIT':
      return {
        ...state,
        visits: state.visits.map((visit) =>
          visit.id === action.visitId ? { ...visit, ...action.changes } : visit
        ),
      };
    case 'CREATE_VISIT': {
      const visit = { id: makeId('vis'), status: 'Scheduled', ...action.visit };
      return { ...state, visits: [visit, ...state.visits] };
    }
    case 'CHECK_IN': {
      const record = {
        id: makeId('att'),
        staffId: state.currentUserId,
        date: new Date().toISOString().slice(0, 10),
        checkIn: new Date().toISOString(),
        checkOut: null,
        checkInLocation: action.location,
        checkOutLocation: null,
        checkInSiteId: action.siteId || null,
        checkOutSiteId: null,
        status: 'Checked In',
        approvedBy: null,
        hoursWorked: null,
      };
      return {
        ...state,
        attendance: [record, ...state.attendance],
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'checked-in', entity: 'attendance', entityId: record.id, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    }
    case 'CHECK_OUT': {
      return {
        ...state,
        attendance: state.attendance.map((record) => {
          if (record.staffId !== state.currentUserId) return record;
          if (record.checkOut) return record;
          const hours =
            (Date.now() - new Date(record.checkIn).getTime()) / (1000 * 60 * 60);
          return {
            ...record,
            checkOut: new Date().toISOString(),
            checkOutLocation: action.location,
            checkOutSiteId: action.siteId || record.checkInSiteId,
            status: 'Checked Out',
            hoursWorked: Number(hours.toFixed(2)),
          };
        }),
      };
    }
    case 'APPROVE_ATTENDANCE':
      return {
        ...state,
        attendance: state.attendance.map((record) =>
          record.id === action.attendanceId
            ? { ...record, status: action.status, approvedBy: state.currentUserId }
            : record
        ),
      };
    case 'ADD_PHOTO': {
      const photo = {
        id: makeId('ph'),
        staffId: state.currentUserId,
        uploadedAt: new Date().toISOString(),
        approved: false,
        ...action.photo,
      };
      return {
        ...state,
        photos: [photo, ...state.photos],
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'uploaded-photo', entity: 'photo', entityId: photo.id, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    }
    case 'APPROVE_PHOTO':
      return {
        ...state,
        photos: state.photos.map((photo) =>
          photo.id === action.photoId ? { ...photo, approved: action.approved } : photo
        ),
      };
    case 'CREATE_LISTING': {
      const listing = {
        id: makeId('list'),
        tenantId: 'tenant-joldipabo',
        serviceCategory: 'rent',
        listingIntent: 'rent-out',
        status: {
          availability: 'available',
          verification: 'unverified',
          verificationReason: null,
          verifiedBy: null,
          verifiedAt: null,
        },
        photoCount: 0,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...action.listing,
      };
      return {
        ...state,
        listings: [listing, ...state.listings],
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'created-listing', entity: 'listing', entityId: listing.id, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    }
    case 'UPDATE_LISTING':
      return {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === action.listingId
            ? { ...listing, ...action.changes, updatedAt: new Date().toISOString() }
            : listing
        ),
      };
    case 'ASSIGN_LISTING':
      return {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === action.listingId
            ? { ...listing, assignedTo: action.staffId, updatedAt: new Date().toISOString() }
            : listing
        ),
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'assigned-listing', entity: 'listing', entityId: action.listingId, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    case 'VERIFY_LISTING': {
      // Map status to the canonical activity action verb used by the audit feed.
      const verb =
        action.status === 'verified'
          ? 'verified-listing'
          : action.status === 'rejected'
            ? 'rejected-listing'
            : 'verification-requested-listing';
      return {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === action.listingId
            ? {
                ...listing,
                status: {
                  ...listing.status,
                  verification: action.status,
                  verificationReason: action.reason ?? listing.status.verificationReason ?? null,
                  verifiedBy: state.currentUserId,
                  verifiedAt: new Date().toISOString(),
                },
                updatedAt: new Date().toISOString(),
              }
            : listing
        ),
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: verb, entity: 'listing', entityId: action.listingId, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    }
    case 'DELETE_LISTING':
      // Soft delete: the demo's seed repository treats remove() as hard-delete,
      // but in the front-end we keep the listing and flip availability to
      // 'off-market' so the UI matches the backend's soft-delete semantics.
      return {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === action.listingId
            ? {
                ...listing,
                status: { ...listing.status, availability: 'off-market' },
                updatedAt: new Date().toISOString(),
              }
            : listing
        ),
        activity: [
          { id: makeId('act'), userId: state.currentUserId, action: 'deleted-listing', entity: 'listing', entityId: action.listingId, timestamp: new Date().toISOString() },
          ...state.activity,
        ],
      };
    case 'CREATE_MATCH': {
      // Uniqueness: one match per (leadId, listingId). If a row already exists,
      // update its matchStatus + score + reason rather than creating a duplicate.
      const now = new Date().toISOString();
      const existing = state.matches.find(
        (m) => m.leadId === action.leadId && m.listingId === action.listingId
      );
      const activityEntry = {
        id: makeId('act'),
        userId: state.currentUserId,
        action: 'matched-listing',
        entity: 'match',
        entityId: null,
        timestamp: now,
      };
      if (existing) {
        activityEntry.entityId = existing.id;
        return {
          ...state,
          matches: state.matches.map((m) =>
            m.id === existing.id
              ? { ...m, matchStatus: action.matchStatus, score: action.score, reason: action.reason, updatedAt: now }
              : m
          ),
          activity: [activityEntry, ...state.activity],
        };
      }
      const match = {
        id: makeId('match'),
        leadId: action.leadId,
        listingId: action.listingId,
        matchStatus: action.matchStatus,
        score: action.score,
        reason: action.reason,
        createdBy: state.currentUserId,
        createdAt: now,
        updatedAt: now,
      };
      activityEntry.entityId = match.id;
      return {
        ...state,
        matches: [match, ...state.matches],
        activity: [activityEntry, ...state.activity],
      };
    }
    case 'UPDATE_MATCH_STATUS': {
      const now = new Date().toISOString();
      return {
        ...state,
        matches: state.matches.map((m) =>
          m.id === action.matchId ? { ...m, matchStatus: action.matchStatus, updatedAt: now } : m
        ),
        activity: [
          {
            id: makeId('act'),
            userId: state.currentUserId,
            action: 'matched-listing',
            entity: 'match',
            entityId: action.matchId,
            timestamp: now,
          },
          ...state.activity,
        ],
      };
    }
    case 'DELETE_MATCH':
      return {
        ...state,
        matches: state.matches.filter((m) => m.id !== action.matchId),
        activity: [
          {
            id: makeId('act'),
            userId: state.currentUserId,
            action: 'unmatched-listing',
            entity: 'match',
            entityId: action.matchId,
            timestamp: new Date().toISOString(),
          },
          ...state.activity,
        ],
      };
    case 'SEND_MESSAGE': {
      const message = {
        id: makeId('msg'),
        fromId: state.currentUserId,
        timestamp: new Date().toISOString(),
        channel: 'in-app',
        ...action.message,
      };
      return {
        ...state,
        messages: [...state.messages, message],
        threads: state.threads.map((thread) =>
          thread.id === message.threadId
            ? { ...thread, lastMessageAt: message.timestamp, unread: false }
            : thread
        ),
      };
    }
    case 'CREATE_THREAD': {
      const thread = {
        id: makeId('thr'),
        lastMessageAt: new Date().toISOString(),
        unread: false,
        participants: [state.currentUserId, action.otherId],
        ...action.thread,
      };
      return { ...state, threads: [thread, ...state.threads] };
    }
    case 'UPDATE_USER':
      return {
        ...state,
        users: state.users.map((user) =>
          user.id === action.userId ? { ...user, ...action.changes } : user
        ),
      };
    case 'UPDATE_ROLE_MATRIX': {
      // Only super-admin / admin can mutate role matrices; mutator enforces.
      const baseRole = action.roleId;
      const isSystem = isSystemRole(baseRole);
      return {
        ...state,
        users: state.users.map((user) =>
          user.role === baseRole
            ? { ...user, permissionMatrix: mergeMatrix(DEFAULT_PERMISSION_MATRIX[baseRole], action.overrides) }
            : user
        ),
      };
    }
    case 'PUSH_TOAST':
      return { ...state, toasts: [...state.toasts, { id: makeId('tst'), ...action.toast }] };
    case 'DISMISS_TOAST':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.toastId) };
    default:
      return state;
  }
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Track online status so views can branch on offline behavior without
  // each subscribing to window events. Default true on the server / when
  // navigator is missing.
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );

  // Apply view-mode override when window narrows below tablet width.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 760px)');
    const apply = () => {
      if (mq.matches) dispatch({ type: 'SET_VIEW_MODE', mode: 'mobile' });
    };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // Online/offline subscription. Cheap; runs once.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // Re-sync once on mount in case the value changed between render and effect.
    setOnline(navigator.onLine !== false);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // In live mode, the signed-in identity comes from the session, not from
  // the seeded currentUserId. The server remains authoritative for actual
  // authorization; this only drives UI gating and scope filtering.
  const [sessionUser, setSessionUser] = useState(() => getSession()?.user ?? null);
  useEffect(() => {
    return subscribeToSession((session) => setSessionUser(session?.user ?? null));
  }, []);

  const currentUser = useMemo(() => {
    if (!isDemoMode() && sessionUser) {
      // Normalize: ensure permissionMatrix exists for UI gating
      if (sessionUser.permissionMatrix) return sessionUser;
      if (sessionUser.role && DEFAULT_PERMISSION_MATRIX[sessionUser.role]) {
        return { ...sessionUser, permissionMatrix: DEFAULT_PERMISSION_MATRIX[sessionUser.role] };
      }
      return sessionUser;
    }
    return state.users.find((u) => u.id === state.currentUserId);
  }, [isDemoMode, sessionUser, state.users, state.currentUserId]);

  const toast = useCallback((message, tone = 'info') => {
    const id = makeId('tst');
    dispatch({ type: 'PUSH_TOAST', toast: { message, tone } });
    setTimeout(() => dispatch({ type: 'DISMISS_TOAST', toastId: id }), 3200);
  }, []);

  const guardedDispatch = useCallback(
    (type, payload) => {
      // Each mutator has an explicit permission check below. UI should also gate
      // the action buttons — this is defence in depth.
      switch (type) {
        case 'CREATE_LEAD':
          if (!permCan(currentUser, 'leads', 'create')) {
            toast('You do not have permission to create leads.', 'error');
            return false;
          }
          break;
        case 'UPDATE_LEAD':
        case 'ASSIGN_LEAD':
        case 'DELETE_LEAD': {
          const lead = state.leads.find((l) => l.id === payload.leadId);
          if (!lead || !permCan(currentUser, 'leads', 'edit', lead)) {
            toast('You cannot modify this lead.', 'error');
            return false;
          }
          break;
        }
        case 'CREATE_VISIT':
          if (!permCan(currentUser, 'visits', 'create')) {
            toast('You cannot create visits.', 'error');
            return false;
          }
          break;
        case 'UPDATE_VISIT': {
          const visit = state.visits.find((v) => v.id === payload.visitId);
          if (!visit || !permCan(currentUser, 'visits', 'edit', visit)) {
            toast('You cannot edit this visit.', 'error');
            return false;
          }
          break;
        }
        case 'APPROVE_ATTENDANCE':
          if (!permCan(currentUser, 'attendance', 'approve')) {
            toast('You cannot approve attendance.', 'error');
            return false;
          }
          break;
        case 'ADD_PHOTO':
          if (!permCan(currentUser, 'photos', 'create')) {
            toast('You cannot upload photos.', 'error');
            return false;
          }
          break;
        case 'APPROVE_PHOTO':
          if (!permCan(currentUser, 'photos', 'approve')) {
            toast('You cannot approve photos.', 'error');
            return false;
          }
          break;
        case 'CREATE_LISTING':
          if (!permCan(currentUser, 'listings', 'create')) {
            toast('You do not have permission to create listings.', 'error');
            return false;
          }
          break;
        case 'UPDATE_LISTING':
        case 'ASSIGN_LISTING':
        case 'VERIFY_LISTING': {
          const listing = state.listings.find((l) => l.id === payload.listingId);
          if (!listing) {
            toast('Listing not found.', 'error');
            return false;
          }
          // EDIT covers UPDATE; ASSIGN and VERIFY use their own scope.
          const requiredAction =
            type === 'UPDATE_LISTING'
              ? 'edit'
              : type === 'ASSIGN_LISTING'
                ? 'assign'
                : 'approve';
          if (!permCan(currentUser, 'listings', requiredAction, listing)) {
            toast('You do not have permission for this listing action.', 'error');
            return false;
          }
          break;
        }
        case 'DELETE_LISTING': {
          const listing = state.listings.find((l) => l.id === payload.listingId);
          if (!listing || !permCan(currentUser, 'listings', 'delete', listing)) {
            toast('You cannot remove this listing.', 'error');
            return false;
          }
          break;
        }
        case 'UPDATE_USER':
          if (!permCan(currentUser, 'staff', 'edit')) {
            toast('You cannot edit staff.', 'error');
            return false;
          }
          break;
        case 'UPDATE_ROLE_MATRIX':
          if (!permCan(currentUser, 'roles', 'edit')) {
            toast('You cannot edit role permissions.', 'error');
            return false;
          }
          if (isSystemRole(payload.roleId)) {
            toast('System roles are protected.', 'error');
            return false;
          }
          break;
        case 'SEND_MESSAGE':
          if (!permCan(currentUser, 'communications', 'create')) {
            toast('You cannot send messages.', 'error');
            return false;
          }
          break;
        case 'CREATE_MATCH':
        case 'UPDATE_MATCH_STATUS':
        case 'DELETE_MATCH': {
          // Match scope is implicit: you need leads.edit on the lead AND
          // listings.view on the listing. Resolve both from the payload.
          const matchId = payload.matchId;
          const existingMatch = state.matches.find((m) => m.id === matchId);
          const leadId = payload.leadId || existingMatch?.leadId;
          const listingId = payload.listingId || existingMatch?.listingId;
          const lead = state.leads.find((l) => l.id === leadId);
          const listing = state.listings.find((l) => l.id === listingId);
          if (!lead || !listing) {
            toast('Match target lead or listing not found.', 'error');
            return false;
          }
          if (!permCan(currentUser, 'leads', 'edit', lead)) {
            toast('You cannot modify this lead.', 'error');
            return false;
          }
          if (!permCan(currentUser, 'listings', 'view', listing)) {
            toast('You cannot see this listing.', 'error');
            return false;
          }
          break;
        }
        default:
          break;
      }
      dispatch({ type, ...payload });
      return true;
    },
    [currentUser, state.leads, state.visits, state.listings, state.matches, toast]
  );

  const actions = useMemo(
    () => ({
      setCurrentUser: (userId) => dispatch({ type: 'SET_CURRENT_USER', userId }),
      setViewMode: (mode) => dispatch({ type: 'SET_VIEW_MODE', mode }),
      toggleViewMode: () => dispatch({ type: 'TOGGLE_VIEW_MODE' }),
      createLead: (lead) => guardedDispatch('CREATE_LEAD', { lead }),
      updateLead: (leadId, changes) => guardedDispatch('UPDATE_LEAD', { leadId, changes }),
      deleteLead: (leadId) => guardedDispatch('DELETE_LEAD', { leadId }),
      assignLead: (leadId, staffId, teamId) =>
        guardedDispatch('ASSIGN_LEAD', { leadId, staffId, teamId }),
      createVisit: (visit) => guardedDispatch('CREATE_VISIT', { visit }),
      updateVisit: (visitId, changes) => guardedDispatch('UPDATE_VISIT', { visitId, changes }),
      checkIn: (location, siteId) => guardedDispatch('CHECK_IN', { location, siteId }),
      checkOut: (location, siteId) => guardedDispatch('CHECK_OUT', { location, siteId }),
      approveAttendance: (attendanceId, status) =>
        guardedDispatch('APPROVE_ATTENDANCE', { attendanceId, status }),
      addPhoto: (photo) => guardedDispatch('ADD_PHOTO', { photo }),
      approvePhoto: (photoId, approved) => guardedDispatch('APPROVE_PHOTO', { photoId, approved }),
      createListing: (listing) => guardedDispatch('CREATE_LISTING', { listing }),
      updateListing: (listingId, changes) => guardedDispatch('UPDATE_LISTING', { listingId, changes }),
      assignListing: (listingId, staffId) => guardedDispatch('ASSIGN_LISTING', { listingId, staffId }),
      verifyListing: (listingId, status, reason) =>
        guardedDispatch('VERIFY_LISTING', { listingId, status, reason }),
      deleteListing: (listingId) => guardedDispatch('DELETE_LISTING', { listingId }),
      createMatch: (leadId, listingId, matchStatus = 'recommended') => {
        // Score and reason are computed at the moment of match — they
        // capture the lead + listing as they stood then, so the audit trail
        // doesn't drift if either side is edited later.
        const lead = state.leads.find((l) => l.id === leadId);
        const listing = state.listings.find((l) => l.id === listingId);
        const project = state.projects.find((p) => p.id === lead?.projectId);
        const { score, reason } = scoreLeadListing(lead, listing, project);
        return guardedDispatch('CREATE_MATCH', { leadId, listingId, matchStatus, score, reason });
      },
      updateMatchStatus: (matchId, matchStatus) =>
        guardedDispatch('UPDATE_MATCH_STATUS', { matchId, matchStatus }),
      deleteMatch: (matchId) => guardedDispatch('DELETE_MATCH', { matchId }),
      sendMessage: (message) => guardedDispatch('SEND_MESSAGE', { message }),
      createThread: (thread) => guardedDispatch('CREATE_THREAD', { thread }),
      updateUser: (userId, changes) => guardedDispatch('UPDATE_USER', { userId, changes }),
      updateRoleMatrix: (roleId, overrides) =>
        guardedDispatch('UPDATE_ROLE_MATRIX', { roleId, overrides }),
      dismissToast: (toastId) => dispatch({ type: 'DISMISS_TOAST', toastId }),
      toast,
    }),
    [guardedDispatch, toast]
  );

  const value = useMemo(
    () => ({
      state,
      currentUser,
      online,
      actions,
      // Also expose actions flat so any caller that did
      // `const { setCurrentUser } = useStore()` keeps working while we migrate.
      ...actions,
      roleDefinitions: ROLE_DEFINITIONS,
      scopeOf: (resource, action) => scopeOf(currentUser, resource, action),
      can: (resource, action, record = null) => permCan(currentUser, resource, action, record),
    }),
    [state, currentUser, online, actions]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
}

// Convenience hook for derived collections. Keeps permission filtering
// in one place so list views stay declarative.
export function useVisible(collection, resource, action) {
  const { state, currentUser } = useStore();
  return useMemo(() => {
    const records = state[collection] || [];
    if (!currentUser) return [];
    return records.filter((record) => permCan(currentUser, resource, action, record));
  }, [state, currentUser, collection, resource, action]);
}
