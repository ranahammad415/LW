/**
 * Guards against out-of-order WordPress pipeline webhooks rewinding a
 * client decision (or published row) back to pending.
 *
 * WP sends these fire-and-forget. A late `pipeline_sent_to_client` (or a
 * queued retry with a stale pending payload) can otherwise overwrite
 * client_approved / changes_requested_by_client after the client already
 * submitted.
 */

const CLIENT_LOCK_STATUSES = new Set([
  'client_approved',
  'changes_requested_by_client',
  'published',
]);

/** Legitimate moves that may leave a client-lock status. */
const EXPLICIT_BACKWARD_EVENTS = new Set([
  'pipeline_resubmitted',
  'pipeline_submitted',
  'pipeline_cancelled',
  'pipeline_published',
]);

const STALE_INCOMING_STATUSES = new Set([
  'pending_client_review',
  'pm_approved',
  'pending_pm_review',
]);

export function isClientLockStatus(status, isPublished = false) {
  return Boolean(isPublished) || CLIENT_LOCK_STATUSES.has(String(status || ''));
}

/**
 * True when this webhook must not be applied to the existing OS row.
 *
 * @param {object} opts
 * @param {string|null} [opts.existingStatus]
 * @param {boolean} [opts.existingIsPublished]
 * @param {string} [opts.eventType]
 * @param {string} [opts.incomingStatus]
 */
export function shouldIgnoreStaleClientRewind({
  existingStatus = null,
  existingIsPublished = false,
  eventType = '',
  incomingStatus = '',
} = {}) {
  if (!isClientLockStatus(existingStatus, existingIsPublished)) return false;

  const type = String(eventType || '').trim();
  if (EXPLICIT_BACKWARD_EVENTS.has(type)) return false;

  if (type === 'pipeline_sent_to_client') return true;

  const incoming = String(incomingStatus || '').trim();
  if (STALE_INCOMING_STATUSES.has(incoming)) return true;

  return false;
}

/**
 * Whether to drop stored clientDecision / comment / reviewedAt.
 * Never clear those fields while the OS row is already in a client-lock
 * status — even if eventType is pipeline_sent_to_client.
 */
export function shouldClearClientDecision({
  resolvedStatus = '',
  eventType = '',
  existingStatus = null,
  existingIsPublished = false,
} = {}) {
  if (isClientLockStatus(existingStatus, existingIsPublished)
    && !EXPLICIT_BACKWARD_EVENTS.has(String(eventType || '').trim())) {
    return false;
  }
  return (
    resolvedStatus === 'pending_client_review'
    || eventType === 'pipeline_sent_to_client'
  );
}
