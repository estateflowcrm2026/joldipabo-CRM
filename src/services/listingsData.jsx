// Listings data layer — loads listings from the active repository and exposes
// loading / error / retry state to the UI.
//
// WHY THIS EXISTS
// ---------------
// The store seeds `state.listings` with demo data. In API mode that seed must
// never reach the UI — an API failure must show an error, not silently fall
// back to seed. This module is the single source of truth for listings in the
// UI:
//
//   * Demo mode (the demo repository is active): returns the seed from the
//     store, status 'ready', no error. Mutations route through the store
//     reducer (synchronous, optimistic).
//   * Live mode (the API repository is active): fetches via
//     `getRepository().list('listings')` on mount and on retry. Status cycles
//     'loading' → 'ready' | 'error'. On error, listings is [] — never seed.
//     Mutations route through the repository, await the backend's
//     confirmation, then update local state.
//
// Mode is decided by `isApiRepositoryActive()` (the VITE_USE_API_REPOSITORY
// selection), never by the demo role-switcher flag.
//
// The provider wraps the app in main.jsx. Views consume `useListings()`.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getRepository, isApiRepositoryActive } from './index.js';
import { useStore } from '../state/store.jsx';

const ListingsContext = createContext(null);

/**
 * Load listings from the active repository.
 *
 * @returns {Promise<{items: object[], pagination: object}>}
 */
async function fetchListings() {
  const repo = getRepository();
  const result = await repo.list('listings', {
    pagination: { limit: 500, offset: 0 },
  });
  return result;
}

export function ListingsProvider({ children }) {
  // Live = the backend-backed repository is active. This is read from the
  // repository selection (`VITE_USE_API_REPOSITORY`), NOT the demo
  // role-switcher flag — see isApiRepositoryActive() for why.
  const live = isApiRepositoryActive();
  const demo = !live;
  const store = useStore();
  const [state, setState] = useState({
    listings: [],
    status: demo ? 'ready' : 'loading',
    error: null,
  });
  const [mutating, setMutating] = useState(false);

  // Track the latest request so a stale response cannot overwrite a newer one.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    try {
      const result = await fetchListings();
      if (requestId !== requestIdRef.current) return;
      setState({
        listings: result.items || [],
        status: 'ready',
        error: null,
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setState({
        listings: [],
        status: 'error',
        error: err,
      });
    }
  }, []);

  // Initial load. In demo mode the store already has the seed; in API mode
  // we fetch from the backend.
  useEffect(() => {
    if (demo) {
      // Demo: seed is already in the store; nothing to fetch.
      return undefined;
    }
    load();
    return undefined;
  }, [demo, load]);

  // In demo mode, listings come from the store (seed + demo mutations).
  // In live mode, listings come from the API fetch above.
  const listings = demo ? store.state.listings : state.listings;
  const status = demo ? 'ready' : state.status;
  const error = demo ? null : state.error;

  // ---- Mutations --------------------------------------------------------
  // Each mutation routes through the store in demo mode (sync reducer) or
  // through the repository in live mode (async API call). In live mode the
  // promise resolves only AFTER the backend confirms (a 2xx with the row),
  // so a caller can close a sheet on `result.ok` and keep it open otherwise.
  //
  // This layer does NOT toast: user feedback (success and failure) belongs
  // to the view that owns the form, so it can show a specific message and
  // keep the form open on failure. Every mutation returns
  // `{ ok, message?, record?, error? }`.

  const createListing = useCallback(
    async (payload) => {
      if (demo) {
        const ok = store.actions.createListing(payload);
        if (ok === false) return { ok: false, message: 'You do not have permission to create listings.' };
        return { ok: true };
      }
      setMutating(true);
      try {
        const result = await getRepository().create('listings', payload);
        const record = result.record || result;
        setState((prev) => ({
          ...prev,
          listings: [record, ...prev.listings],
        }));
        return { ok: true, record };
      } catch (err) {
        const message = err.message || 'Could not create listing.';
        return { ok: false, error: err, message };
      } finally {
        setMutating(false);
      }
    },
    [demo, store]
  );

  const updateListing = useCallback(
    async (listingId, changes) => {
      if (demo) {
        const ok = store.actions.updateListing(listingId, changes);
        if (ok === false) return { ok: false, message: 'You do not have permission to edit this listing.' };
        return { ok: true };
      }
      setMutating(true);
      try {
        const result = await getRepository().update('listings', listingId, changes);
        const record = result.record || result;
        setState((prev) => ({
          ...prev,
          listings: prev.listings.map((l) => (l.id === listingId ? record : l)),
        }));
        return { ok: true, record };
      } catch (err) {
        const message = err.message || 'Could not update listing.';
        return { ok: false, error: err, message };
      } finally {
        setMutating(false);
      }
    },
    [demo, store]
  );

  const assignListing = useCallback(
    async (listingId, staffId) => {
      if (demo) {
        const ok = store.actions.assignListing(listingId, staffId);
        if (ok === false) return { ok: false, message: 'You do not have permission to assign this listing.' };
        return { ok: true };
      }
      setMutating(true);
      try {
        const result = await getRepository().custom.listings.assign(listingId, staffId);
        const record = result.record || result;
        setState((prev) => ({
          ...prev,
          listings: prev.listings.map((l) => (l.id === listingId ? record : l)),
        }));
        return { ok: true, record };
      } catch (err) {
        const message = err.message || 'Could not assign listing.';
        return { ok: false, error: err, message };
      } finally {
        setMutating(false);
      }
    },
    [demo, store]
  );

  const verifyListing = useCallback(
    async (listingId, decision, reason) => {
      if (demo) {
        const ok = store.actions.verifyListing(listingId, decision, reason);
        if (ok === false) return { ok: false, message: 'You do not have permission to verify this listing.' };
        return { ok: true };
      }
      setMutating(true);
      try {
        const result = await getRepository().custom.listings.verify(
          listingId,
          decision,
          reason
        );
        const record = result.record || result;
        setState((prev) => ({
          ...prev,
          listings: prev.listings.map((l) => (l.id === listingId ? record : l)),
        }));
        return { ok: true, record };
      } catch (err) {
        const message = err.message || 'Could not update verification.';
        return { ok: false, error: err, message };
      } finally {
        setMutating(false);
      }
    },
    [demo, store]
  );

  const removeListing = useCallback(
    async (listingId) => {
      if (demo) {
        const ok = store.actions.deleteListing(listingId);
        if (ok === false) return { ok: false, message: 'You do not have permission to remove this listing.' };
        return { ok: true };
      }
      setMutating(true);
      try {
        await getRepository().remove('listings', listingId);
        setState((prev) => ({
          ...prev,
          listings: prev.listings.filter((l) => l.id !== listingId),
        }));
        return { ok: true };
      } catch (err) {
        const message = err.message || 'Could not remove listing.';
        return { ok: false, error: err, message };
      } finally {
        setMutating(false);
      }
    },
    [demo, store]
  );

  const value = useMemo(
    () => ({
      listings,
      status,
      error,
      retry: load,
      isDemo: demo,
      mutating,
      createListing,
      updateListing,
      assignListing,
      verifyListing,
      removeListing,
    }),
    [
      listings,
      status,
      error,
      load,
      demo,
      mutating,
      createListing,
      updateListing,
      assignListing,
      verifyListing,
      removeListing,
    ]
  );

  return (
    <ListingsContext.Provider value={value}>
      {children}
    </ListingsContext.Provider>
  );
}

/**
 * Consume the listings data layer.
 *
 * @returns {{
 *   listings: object[],
 *   status: 'loading' | 'ready' | 'error',
 *   error: Error | null,
 *   retry: () => Promise<void>,
 *   isDemo: boolean,
 *   mutating: boolean,
 *   createListing: (payload: object) => Promise<{ok: boolean, record?: object, error?: Error, message?: string}>,
 *   updateListing: (listingId: string, changes: object) => Promise<{ok: boolean, record?: object, error?: Error, message?: string}>,
 *   assignListing: (listingId: string, staffId: string) => Promise<{ok: boolean, record?: object, error?: Error, message?: string}>,
 *   verifyListing: (listingId: string, decision: string, reason: string) => Promise<{ok: boolean, record?: object, error?: Error, message?: string}>,
 *   removeListing: (listingId: string) => Promise<{ok: boolean, error?: Error, message?: string}>,
 * }}
 */
export function useListings() {
  const ctx = useContext(ListingsContext);
  if (!ctx) throw new Error('useListings must be used inside <ListingsProvider>');
  return ctx;
}

/**
 * Resolve a listing's assignee for display.
 *
 * Live records carry the backend's name on `assignedToName`; demo records
 * only carry the id, which is looked up in the local roster. Preferring the
 * embedded name means a live listing shows the real assignee ("Demo Super")
 * rather than a same-id seed user or "Unassigned".
 *
 * @param {object|null} listing
 * @param {object[]} [users]  the local roster (seed) for demo lookups
 * @returns {{ id: string, name: string, email: string|null }|null}
 */
export function resolveAssignee(listing, users) {
  if (!listing) return null;
  const assigned = listing.assignedTo;
  const id = typeof assigned === 'string' ? assigned : assigned?.id ?? null;
  if (!id) return null;
  const local = users?.find((u) => u.id === id) || null;
  return {
    id,
    name: listing.assignedToName || local?.name || id,
    email: local?.email ?? null,
  };
}
