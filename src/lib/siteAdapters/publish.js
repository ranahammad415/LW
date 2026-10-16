/**
 * Contract v1.3.0 §24 (allowOsPublish, decision D1): OS pre-check for publish / schedule, ported exactly from
 * oasis-astro packages/os-bridge-contract/src/constants.mjs `osPublishDecision` (2c59003). The site decides again and
 * also runs its own review gate and the emdash-seo publish gate (409 PUBLISH_BLOCKED).
 */

export const ACTIVE_STATUSES = Object.freeze([
  'pending_pm_review',
  'pm_approved',
  'changes_requested_by_pm',
  'pending_client_review',
  'changes_requested_by_client',
  'client_approved',
  'scheduled',
]);
export const OS_PUBLISH_ROLES = Object.freeze(['OWNER', 'PM']);
export const OVERRIDE_REASON_MIN = 20;
export const SCHEDULE_MAX_AHEAD_DAYS = 365;
export const STAFF_PREVIEW_MAX_TTL_SEC = 3600;

export function osPublishDecision(review, { actor, override = false, overrideReason = null }, capabilities = {}) {
  if (!capabilities.publishFromOs) return { error: 'PUBLISH_NOT_ALLOWED', message: 'This site does not allow publishing from Agency OS. Publish in the site admin.' };
  if (actor?.kind !== 'human') return { error: 'PUBLISH_NOT_ALLOWED', message: 'Agents never publish' };
  if (!OS_PUBLISH_ROLES.includes(actor.role)) return { error: 'FORBIDDEN', message: 'Only an OWNER or PM may publish from Agency OS' };
  if (override) {
    if (actor.role !== 'OWNER') return { error: 'FORBIDDEN', message: 'Only an OWNER may override the review state' };
    if (!overrideReason || overrideReason.trim().length < OVERRIDE_REASON_MIN) return { error: 'VALIDATION', message: `overrideReason needs at least ${OVERRIDE_REASON_MIN} characters` };
    if (!ACTIVE_STATUSES.includes(review.status)) return { error: 'INVALID_TRANSITION', message: `Review is ${review.status}` };
    return { ok: true, override: true };
  }
  if (review.status !== 'client_approved') return { error: 'INVALID_TRANSITION', message: `Publishing needs client_approved (now ${review.status}); an OWNER may override with a reason` };
  return { ok: true, override: false };
}

/** Schedule time: a future instant at most SCHEDULE_MAX_AHEAD_DAYS ahead. Returns an ISO string or an error. */
export function checkScheduleAt(at, now = Date.now()) {
  const t = typeof at === 'string' || at instanceof Date ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(t)) return { error: 'VALIDATION', message: 'Pick a date and time.' };
  if (t <= now + 60_000) return { error: 'VALIDATION', message: 'The time must be in the future.' };
  if (t > now + SCHEDULE_MAX_AHEAD_DAYS * 86_400_000) return { error: 'VALIDATION', message: `At most ${SCHEDULE_MAX_AHEAD_DAYS} days ahead.` };
  return { ok: true, at: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
