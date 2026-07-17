/** Shared status labels — aligned with WP plugin wording. */
export const STATUS_LABELS = {
  draft: 'Draft',
  pending_pm_review: 'Pending PM Review',
  pm_approved: 'PM Approved',
  pending_client_review: 'Pending Client Review',
  client_approved: 'Client Approved',
  changes_requested_by_pm: 'Changes Requested (PM)',
  changes_requested_by_client: 'Changes Requested (Client)',
  cancelled: 'Cancelled',
  // Published is a first-class, derived state (see formatReview). `publish` is
  // the raw WP post status that can arrive via the wp-content-change webhook.
  published: 'Published',
  publish: 'Published',
};

/** Distinct colors per workflow stage (match WP plugin). */
export const STATUS_COLORS = {
  draft: '#646970',
  pending_pm_review: '#dba617',
  pm_approved: '#2271b1',
  pending_client_review: '#9b59b6',
  client_approved: '#00a32a',
  changes_requested_by_pm: '#b32d2e',
  changes_requested_by_client: '#b32d2e',
  cancelled: '#646970',
  published: '#2271b1',
  publish: '#2271b1',
};

/** Client-facing labels (slightly different for pending_client_review). */
export const CLIENT_STATUS_LABELS = {
  ...STATUS_LABELS,
  pending_client_review: 'Awaiting Your Review',
};

/** Worker-selected content/page type labels (aligned with WP plugin). */
export const CONTENT_TYPE_LABELS = {
  landing_page: 'Landing Page',
  pillar_page: 'Pillar Page',
  article: 'Article / Blog Page',
  service_page: 'Service Page',
  location_page: 'Location Page',
  home_page: 'Home Page',
  product_page: 'Product Page',
};

/** Resolve a content-type value to a display label (null-safe). */
export function contentTypeLabel(value) {
  if (!value) return null;
  return CONTENT_TYPE_LABELS[value] || value;
}

/**
 * Only persist comments that belong to this event type.
 * WP webhooks always send the full current pipeline row, which previously
 * caused the same PM/client note to repeat on every timeline entry.
 */
export function commentsForEventType(eventType, fields = {}) {
  const {
    workerNote = null,
    pmComment = null,
    clientComment = null,
    pmDecision = null,
    clientDecision = null,
  } = fields;

  switch (eventType) {
    case 'pipeline_submitted':
    case 'pipeline_resubmitted':
    case 'pipeline_changes_updated':
      return {
        workerNote,
        pmComment: null,
        clientComment: null,
        pmDecision: null,
        clientDecision: null,
      };
    case 'pipeline_pm_approved':
    case 'pipeline_pm_changes_requested':
      return {
        workerNote: null,
        pmComment,
        clientComment: null,
        pmDecision,
        clientDecision: null,
      };
    case 'pipeline_sent_to_client':
      return {
        workerNote: null,
        pmComment,
        clientComment: null,
        pmDecision: null,
        clientDecision: null,
      };
    case 'pipeline_client_approved':
    case 'pipeline_client_changes_requested':
      return {
        workerNote: null,
        pmComment: null,
        clientComment,
        pmDecision: null,
        clientDecision,
      };
    case 'pipeline_published':
    case 'pipeline_cancelled':
      return {
        workerNote: null,
        pmComment: null,
        clientComment: null,
        pmDecision: null,
        clientDecision: null,
      };
    default:
      return { workerNote, pmComment, clientComment, pmDecision, clientDecision };
  }
}

/** Scope comments for a status snapshot (sync / history backfill). */
export function commentsForStatus(status, fields = {}) {
  const {
    workerNote = null,
    pmComment = null,
    clientComment = null,
    pmDecision = null,
    clientDecision = null,
  } = fields;

  switch (status) {
    case 'pending_pm_review':
    case 'draft':
      return {
        workerNote,
        pmComment: null,
        clientComment: null,
        pmDecision: null,
        clientDecision: null,
      };
    case 'pm_approved':
    case 'changes_requested_by_pm':
      return {
        workerNote: null,
        pmComment,
        clientComment: null,
        pmDecision,
        clientDecision: null,
      };
    case 'pending_client_review':
      return {
        workerNote: null,
        pmComment,
        clientComment: null,
        pmDecision: null,
        clientDecision: null,
      };
    case 'client_approved':
    case 'changes_requested_by_client':
      return {
        workerNote: null,
        pmComment: null,
        clientComment,
        pmDecision: null,
        clientDecision,
      };
    default:
      return { workerNote, pmComment, clientComment, pmDecision, clientDecision };
  }
}

/** Parse WP mysql datetime / ISO strings into a Date, or null. */
export function parseWpDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Best "Updated" / activity time for a content review row.
 * Prefer WordPress / reviewer action times — never the OS pipeline-sync clock
 * (Prisma `updatedAt`), which is identical across every row after a bulk sync.
 */
export function reviewDisplayUpdatedAt(r) {
  const fromEvents = (r.events || [])
    .map((e) => eventDisplayAt(e))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // Once published, the publish time is the most recent meaningful activity.
  const publishedAt =
    r.isPublished && r.publishedAt
      ? (r.publishedAt instanceof Date ? r.publishedAt : parseWpDate(r.publishedAt))
      : null;

  return (
    publishedAt ||
    parseWpDate(r.clientReviewedAt) ||
    parseWpDate(r.pmReviewedAt) ||
    (r.wpUpdatedAt instanceof Date ? r.wpUpdatedAt : parseWpDate(r.wpUpdatedAt)) ||
    (r.wpCreatedAt instanceof Date ? r.wpCreatedAt : parseWpDate(r.wpCreatedAt)) ||
    fromEvents ||
    (r.createdAt instanceof Date ? r.createdAt : parseWpDate(r.createdAt))
  );
}

/**
 * Best display timestamp for an event: prefer reviewer action time, then
 * stored createdAt.
 */
export function eventDisplayAt(e) {
  return (
    parseWpDate(e.clientReviewedAt) ||
    parseWpDate(e.pmReviewedAt) ||
    (e.createdAt instanceof Date ? e.createdAt : parseWpDate(e.createdAt))
  );
}

export function formatHistoryEvent(e, labels = STATUS_LABELS) {
  const at = eventDisplayAt(e);
  const createdIso =
    e.createdAt instanceof Date
      ? e.createdAt.toISOString()
      : parseWpDate(e.createdAt)?.toISOString() || null;

  return {
    eventType: e.eventType || null,
    revisionNumber: e.revisionNumber,
    status: e.status,
    statusLabel: labels[e.status] || e.status,
    statusColor: STATUS_COLORS[e.status] || '#888',
    pmComment: e.pmComment,
    clientComment: e.clientComment,
    workerNote: e.workerNote,
    pmReviewedAt: e.pmReviewedAt,
    clientReviewedAt: e.clientReviewedAt,
    createdAt: createdIso,
    updatedAt: at?.toISOString() || createdIso,
  };
}
