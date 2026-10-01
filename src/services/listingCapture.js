// Listing capture — expansion of the thin "Add collected property" payload
// into a full Listing DTO.
//
// WHY THIS EXISTS
// ---------------
// The mobile field-executive flow collects only the minimum a person standing
// in front of a property can type: owner name, owner phone, locality,
// service category, an optional asking price, and free-text notes. Two
// callers need to turn that into a full record:
//
//   1. The online path in MobileModules.jsx (NewListingSheet.submit), which
//      posts it straight away.
//   2. The offline replay path in syncWorker.js (the `listing.capture`
//      handler), which drains the queue once the network is back.
//
// Keeping the expansion in one place means the record created offline is
// byte-for-byte the record created online — the same title, intent, pricing
// split, and defaults. Divergence here would show up as "my offline capture
// looks different from my online one", which is exactly the kind of bug
// that is invisible until a field team relies on it.

const RENT_LIKE = new Set(['rent', 'pg', 'office']);

/**
 * Derive the backend `listingIntent` from a service category.
 *
 * @param {string} serviceCategory
 * @returns {'available_for_rent'|'available_for_sale'}
 */
export function intentForCategory(serviceCategory) {
  return RENT_LIKE.has(serviceCategory) ? 'available_for_rent' : 'available_for_sale';
}

/**
 * Expand a thin capture payload into a full Listing DTO (the nested shape the
 * repository and the UI speak).
 *
 * @param {object} capture
 * @param {string} capture.ownerName
 * @param {string} capture.ownerPhone
 * @param {string} [capture.locality]
 * @param {string} [capture.serviceCategory]
 * @param {number|string|null} [capture.askingPrice]
 * @param {string} [capture.notes]
 * @param {string} [capture.userId]      — the capturing staff member; becomes
 *                                         assignedTo + createdBy.
 * @param {string|null} [capture.projectId]
 * @returns {object} a Listing DTO
 */
export function listingFromCapture(capture = {}) {
  const {
    ownerName,
    ownerPhone,
    locality = '',
    serviceCategory = 'rent',
    askingPrice = null,
    notes = '',
    userId = null,
    projectId = null,
  } = capture;

  const price = askingPrice === '' || askingPrice === null || askingPrice === undefined
    ? null
    : Number(askingPrice);
  const isRentLike = RENT_LIKE.has(serviceCategory);

  return {
    serviceCategory,
    propertyType: 'apartment',
    listingIntent: intentForCategory(serviceCategory),
    title: `${ownerName} — ${locality || 'Owner listing'}`,
    description: notes,
    location: {
      address: locality,
      city: '',
      locality,
      geo: null,
    },
    pricing: {
      price: isRentLike ? null : price,
      rentMonthly: isRentLike ? price : null,
      deposit: null,
      maintenanceMonthly: null,
      areaSqft: null,
      pricePerSqft: null,
    },
    specs: {
      bedrooms: null,
      bathrooms: null,
      furnished: 'unfurnished',
      floor: null,
      totalFloors: null,
      parking: null,
      amenities: [],
    },
    status: {
      availability: 'available',
      verification: 'unverified',
      verificationReason: null,
      verifiedBy: null,
      verifiedAt: null,
    },
    ownerContact: {
      name: ownerName,
      phone: ownerPhone,
      email: null,
      relation: 'owner',
    },
    assignedTo: userId,
    createdBy: userId,
    projectId,
    photoCount: 0,
    notes,
    tags: [],
  };
}
