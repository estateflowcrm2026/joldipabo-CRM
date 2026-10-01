// Typed queue helpers for the five mobile field-staff actions that must
// work offline. Each helper:
//   - takes the minimum payload needed by the offline contract
//     (see docs/OFFLINE_QUEUE_CONTRACT.md §4)
//   - derives a stable idempotencyKey so re-tapping an action during a
//     session does not enqueue duplicates
//   - calls offlineQueue.queueAction
//   - returns the queue item id
//
// Nothing in this file touches the store. The views still call the store
// mutators when online; they only call these helpers when offline. The two
// paths are independent — when online, the queue is never touched.

import { queueAction } from './offlineQueue.js';

const dayKey = () => new Date().toISOString().slice(0, 10);

export const queueAttendanceCheckIn = ({
  staffId,
  location,
  siteId = null,
  clientTimestamp = new Date().toISOString(),
}) =>
  queueAction(
    'attendance.checkIn',
    { staffId, siteId, location, clientTimestamp },
    {
      metadata: {
        clientTimestamp,
        idempotencyKey: `attendance.checkIn:${staffId}:${dayKey()}`,
      },
    }
  );

export const queueAttendanceCheckOut = ({
  staffId,
  location,
  siteId = null,
  clientHoursWorked = null,
  clientTimestamp = new Date().toISOString(),
}) =>
  queueAction(
    'attendance.checkOut',
    {
      staffId,
      siteId,
      location,
      clientHoursWorked,
      clientTimestamp,
    },
    {
      metadata: {
        clientTimestamp,
        idempotencyKey: `attendance.checkOut:${staffId}:${dayKey()}`,
      },
    }
  );

export const queueVisitUpdate = ({ visitId, patch, userId }) =>
  queueAction(
    'visit.update',
    { visitId, patch },
    {
      metadata: {
        clientTimestamp: new Date().toISOString(),
        userId,
        // One queued patch per (visit, status) so a re-attempt with the
        // same completion does not duplicate, but a fresh edit later does.
        idempotencyKey: `visit.update:${visitId}:${patch.status || 'edit'}:${userId}`,
      },
    }
  );

// photo.upload queues metadata only today. The actual Blob persistence is
// deferred (see docs/OFFLINE_WIRING_NOTES.md). We keep the same
// idempotencyKey strategy so a re-tap of "Upload" while offline dedupes.
export const queuePhotoUpload = ({ metadata, blobKey, userId }) =>
  queueAction(
    'photo.upload',
    {
      blobKey: blobKey || null,
      metadata: {
        ...metadata,
        capturedAt: metadata.capturedAt || new Date().toISOString(),
        // Marker so the future sync worker knows this is a metadata-only
        // queue item and the file Blob needs separate handling.
        blobPersistence: 'deferred',
      },
    },
    {
      metadata: {
        clientTimestamp: new Date().toISOString(),
        userId,
        idempotencyKey: `photo.upload:${userId}:${(metadata.caption || 'photo')}:${metadata.capturedAt || 'now'}`,
      },
    }
  );

export const queueMessageSend = ({ threadId, fromId, body, channel = 'in-app' }) =>
  queueAction(
    'message.send',
    { threadId, fromId, body, channel },
    {
      metadata: {
        clientTimestamp: new Date().toISOString(),
        idempotencyKey: `message.send:${threadId}:${fromId}:${Date.now()}:${(body || '').slice(0, 32)}`,
      },
    }
  );

// Listing capture — used by the mobile "Add collected property" flow.
// The payload is intentionally small: owner name, owner phone, locality,
// serviceCategory, and the asking price in INR. The sync worker's
// `listing.capture` handler is responsible for turning this into a full
// Listing record when the queue drains.
export const queueListingCapture = ({
  ownerName,
  ownerPhone,
  locality = '',
  serviceCategory = 'rent',
  askingPrice = null,
  notes = '',
  userId,
}) =>
  queueAction(
    'listing.capture',
    {
      ownerName,
      ownerPhone,
      locality,
      serviceCategory,
      askingPrice,
      notes,
    },
    {
      metadata: {
        clientTimestamp: new Date().toISOString(),
        userId,
        // A capture is unique per (user, ownerPhone, ms timestamp). The millisecond
        // bucket is intentional — it lets two captures from the same owner on
        // different dates both go through while still deduping accidental
        // double-taps within the same instant.
        idempotencyKey: `listing.capture:${userId}:${ownerPhone}:${Date.now()}`,
      },
    }
  );

export const isOffline = () => {
  if (typeof navigator === 'undefined') return false;
  // navigator.onLine is the canonical hint. Some browsers (Safari iOS) can
  // report false-positives when the network is captive-portal only — treat
  // it as a hint, not a guarantee.
  return navigator.onLine === false;
};
