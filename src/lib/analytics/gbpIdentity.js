/**
 * Google Business Profile identity: what we persist from a profile response and how a Find-business candidate is
 * matched to the project's site (docs/ledger/features/local-seo.md §Identity).
 */
import { sameSite, registrableDomain } from './domainMatch.js';
import { storedCid } from './gmbIdentifier.js';

export const IDENTITY_SOURCES = Object.freeze(['native', 'dataforseo', 'manual']);

/** The project's own site (registrable domain): DataForSEO domain, else the CMS site URL, else the client website. */
export function projectSiteDomain(project) {
  return (
    registrableDomain(project?.dataforseoDomain) ||
    registrableDomain(project?.wpUrl) ||
    registrableDomain(project?.client?.websiteUrl) ||
    ''
  );
}

/** True when the candidate's website is on the project's site (strict registrable-domain match). */
export function candidateMatchesSite(candidate, siteDomain) {
  if (!siteDomain) return false;
  return sameSite(candidate?.url || candidate?.domain || '', siteDomain);
}

/**
 * Project update data from a normalised profile (businessDataProvider.profileFromItem). Every field the response
 * carries is persisted; missing fields never blank a stored value. gmbCid only ever receives a digits-only CID.
 * @param {object} profile
 * @param {{ source: 'native'|'dataforseo'|'manual', now?: Date, verified?: boolean, setName?: boolean, setIdentitySource?: boolean }} opts
 */
export function identityDataFromProfile(profile, { source, now = new Date(), verified = false, setName = false, setIdentitySource = false } = {}) {
  if (!profile) return {};
  const data = { gmbProfileSyncedAt: now };
  const cid = storedCid(profile.cid);
  if (cid) data.gmbCid = cid;
  if (profile.placeId) data.gmbPlaceId = String(profile.placeId).slice(0, 255);
  if (profile.featureId) data.gmbFeatureId = String(profile.featureId).slice(0, 100);
  if (typeof profile.lat === 'number' && Math.abs(profile.lat) <= 90) data.gmbLat = profile.lat;
  if (typeof profile.lng === 'number' && Math.abs(profile.lng) <= 180) data.gmbLng = profile.lng;
  if (profile.address) data.gmbAddress = String(profile.address).slice(0, 500);
  if (profile.phone) data.gmbPhone = String(profile.phone).slice(0, 50);
  if (profile.category) data.gmbCategory = String(profile.category).slice(0, 255);
  if (profile.url) data.gmbWebsite = String(profile.url).slice(0, 500);
  if (typeof profile.rating === 'number') data.gmbRating = Math.round(profile.rating * 100) / 100;
  if (typeof profile.reviewsCount === 'number') data.gmbReviewsCount = Math.max(0, Math.round(profile.reviewsCount));
  if (setName && profile.title) data.gmbLocationName = String(profile.title).slice(0, 255);
  if (setIdentitySource && IDENTITY_SOURCES.includes(source)) data.gmbIdentitySource = source;
  if (verified) data.gmbIdentityVerifiedAt = now;
  return data;
}

/** Staff identity card (no secrets; staff only). */
export function identityView(project) {
  return {
    name: project.gmbLocationName || null,
    cid: project.gmbCid && /^\d+$/.test(project.gmbCid) ? project.gmbCid : null,
    legacyIdentifier: project.gmbCid && !/^\d+$/.test(project.gmbCid) ? project.gmbCid : null,
    placeId: project.gmbPlaceId || null,
    featureId: project.gmbFeatureId || null,
    nativeLocationId: project.gmbLocationId || null,
    lat: project.gmbLat ?? null,
    lng: project.gmbLng ?? null,
    address: project.gmbAddress || null,
    phone: project.gmbPhone || null,
    category: project.gmbCategory || null,
    website: project.gmbWebsite || null,
    rating: project.gmbRating ?? null,
    reviewsCount: project.gmbReviewsCount ?? null,
    profileSyncedAt: project.gmbProfileSyncedAt || null,
    source: project.gmbIdentitySource || null,
    verifiedAt: project.gmbIdentityVerifiedAt || null,
    syncError: project.gmbSyncError || null,
    location: {
      code: project.localLocationCode ?? null,
      name: project.localLocationName || null,
      languageCode: project.localLanguageCode || 'en',
    },
  };
}
