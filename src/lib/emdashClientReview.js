/**
 * Contract v1.1.0 §21 (Phase 2 stage 1): client review from the OS on EmDash projects.
 *
 * One code path for both callers: the client portal (CLIENT users, requireClientWriter) and an OWNER acting for the
 * client from the PM portal (onBehalfOf). The site is the authority: it checks status + round, stores the suggestions
 * and emits the pipeline_client_* event that notifies (the synchronous response only updates the mirror, so nothing is
 * notified twice). Suggestions are text-only and never applied by the OS.
 */
import { prisma } from './prisma.js';
import { loadEmdashConnection, mirrorEmdashReview, closeForeignReview, storeEmdashSuggestions } from './cmsStore.js';
import { CmsBridgeError, emdashRoutes, hasClientReviewFromOs, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';
import { buildClientReviewBody, clientReviewErrorMessage, clientContentView } from './siteAdapters/clientReview.js';

const INTERACTIVE = { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, timeoutMs: 10_000 };
/** Statuses in which a client may look at an EmDash review from the OS portal. */
export const CLIENT_VISIBLE_STATUSES = Object.freeze(['pending_client_review', 'changes_requested_by_client', 'client_approved']);

// Per-instance guards: a double click / two tabs never send two calls from one instance. Across PM2 instances the
// site's status + round check rejects the second call (INVALID_TRANSITION), so no DB lock is needed.
const inFlight = new Set();
const rate = new Map();
const RATE_PER_MIN = 20;

function rateLimited(userId, now = Date.now()) {
  let b = rate.get(userId);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    rate.set(userId, b);
  }
  b.count += 1;
  if (rate.size > 5000) for (const [k, v] of rate) if (now >= v.resetAt) rate.delete(k);
  return b.count > RATE_PER_MIN;
}

/** Load the EmDash project + review row; throws CmsBridgeError for every refusal. */
export async function loadClientReviewContext(projectId, rowId, { requireCapability = true } = {}) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true },
  });
  if (!project) throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Project not found' });
  if (project.cmsType !== 'EMDASH') {
    throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Review this page on its review link.' });
  }
  if (project.cmsRepairNeededAt) {
    throw new CmsBridgeError({
      status: 503,
      code: 'NOT_PAIRED',
      message: 'The website connection needs to be renewed by the agency. Use the review link for now.',
    });
  }
  if (requireCapability && !hasClientReviewFromOs(project)) {
    throw new CmsBridgeError({
      status: 409,
      code: 'CLIENT_REVIEW_UNAVAILABLE',
      message: 'This site does not take decisions from Agency OS yet. Use the review link instead.',
      details: { fallback: 'review-link' },
    });
  }
  const row = await prisma.wpContentReview.findFirst({
    where: { id: String(rowId), projectId },
    select: {
      id: true,
      wpPipelineId: true,
      cmsReviewId: true,
      cmsEntryId: true,
      status: true,
      isPublished: true,
      revisionNumber: true,
    },
  });
  if (!row || !row.cmsReviewId) throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Content review not found' });
  return { project, row };
}

/**
 * Send a client decision (§21.2). `input`: { decision, comment, suggestions, expectedRound }.
 * Returns { review row (mirrored), suggestions stored }.
 */
export async function submitEmdashClientDecision({ projectId, rowId, user, input, clientAccountId = null, log }) {
  const { row } = await loadClientReviewContext(projectId, rowId);
  if (row.isPublished || row.status !== 'pending_client_review') {
    throw new CmsBridgeError({
      status: 409,
      code: 'INVALID_TRANSITION',
      message: clientReviewErrorMessage({ code: 'INVALID_TRANSITION' }),
      details: { currentStatus: row.status, currentRound: row.revisionNumber },
    });
  }
  const expectedRound = input?.expectedRound == null ? row.revisionNumber : Number(input.expectedRound);
  if (expectedRound !== row.revisionNumber) {
    throw new CmsBridgeError({
      status: 409,
      code: 'CONFLICT_REV',
      message: clientReviewErrorMessage({ code: 'CONFLICT_REV' }),
      details: { currentStatus: row.status, currentRound: row.revisionNumber },
    });
  }
  // expectedRev is optional in the contract; the OS mirror's rev can lag (link rotations), so round + status are
  // the stale-decision guard and expectedRev is not sent.
  const body = buildClientReviewBody({
    reviewId: row.cmsReviewId,
    expectedRound,
    decision: input?.decision,
    comment: input?.comment,
    suggestions: input?.suggestions,
    user,
    clientAccountId: user.role === 'OWNER' ? clientAccountId : null,
  });

  if (rateLimited(user.id)) {
    throw new CmsBridgeError({ status: 429, code: 'RATE_LIMITED', message: 'Too many decisions in a minute. Wait a moment and try again.' });
  }
  if (inFlight.has(row.id)) {
    throw new CmsBridgeError({ status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', message: 'This decision is already being sent.' });
  }
  inFlight.add(row.id);
  try {
    const { conn } = await loadEmdashConnection(projectId);
    let res;
    try {
      res = await emdashRoutes.pipelineClientReview(conn, body, INTERACTIVE);
    } catch (err) {
      if (err instanceof CmsBridgeError) {
        // §21.2: CONFLICT_REV / INVALID_TRANSITION carry the current Review: refresh the mirror so the UI shows it.
        if ((err.code === 'CONFLICT_REV' || err.code === 'INVALID_TRANSITION') && err.details?.review) {
          await mirrorEmdashReview(projectId, err.details.review, { log }).catch(() => {});
        }
        if (err.code === 'SITE_MISMATCH') await closeForeignReview(projectId, row.wpPipelineId).catch(() => {});
        const friendly = clientReviewErrorMessage(err);
        if (friendly) err.message = friendly;
        if (err.code === 'NOT_IMPLEMENTED') {
          err.details = { ...(err.details || {}), fallback: 'review-link' };
          await rememberNoClientReview(projectId).catch(() => {});
        }
      }
      throw err;
    }
    const mirrored = res?.review ? await mirrorEmdashReview(projectId, res.review, { log }) : null;
    await storeEmdashSuggestions(projectId, res?.suggestions, { siteId: conn.siteId, cmsReviewId: row.cmsReviewId }).catch((e) =>
      log?.warn?.({ err: { message: e?.message } }, 'Storing EmDash suggestions failed')
    );
    await prisma.wpContentReview
      .update({
        where: { id: row.id },
        data: {
          cmsClientActor: {
            name: body.actor.name,
            role: body.actor.role,
            source: 'os',
            onBehalfOfClient: !!body.onBehalfOf,
          },
        },
      })
      .catch(() => {});
    log?.info?.(
      { projectId, reviewRowId: row.id, decision: body.decision, role: body.actor.role, suggestions: body.suggestions?.length || 0, replay: !!res?.idempotentReplay },
      'EmDash client decision sent'
    );
    return { review: mirrored, suggestionsSent: body.suggestions?.length || 0 };
  } finally {
    inFlight.delete(row.id);
  }
}

/**
 * The site answered 501 for a v1.1.0 route: hide the in-app review until the next heartbeat / site-info, which
 * rewrites cmsCapabilities from what the site advertises.
 */
async function rememberNoClientReview(projectId) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsCapabilities: true } });
  const caps = p?.cmsCapabilities && typeof p.cmsCapabilities === 'object' ? p.cmsCapabilities : {};
  if (caps.clientReviewFromOs === false) return;
  await prisma.project.update({ where: { id: projectId }, data: { cmsCapabilities: { ...caps, clientReviewFromOs: false } } });
}

/** Heal the suggestion mirror from the site (`pipeline-suggestions`, ≤ 3 pages of 100). */
export async function refreshEmdashSuggestions(projectId, row, { log } = {}) {
  const { conn } = await loadEmdashConnection(projectId);
  let cursor;
  let total = 0;
  for (let page = 0; page < 3; page += 1) {
    const res = await emdashRoutes.pipelineSuggestions(conn, { reviewId: row.cmsReviewId, ...(cursor ? { cursor } : {}) }, INTERACTIVE);
    const items = Array.isArray(res?.items) ? res.items : [];
    total += await storeEmdashSuggestions(projectId, items, { siteId: conn.siteId, cmsReviewId: row.cmsReviewId });
    cursor = res?.next;
    if (!cursor || !items.length) break;
  }
  log?.info?.({ projectId, reviewRowId: row.id, written: total }, 'EmDash suggestions refreshed');
  return total;
}

/** Client-safe content of the draft under review (entry-get includeFields). */
export async function loadClientContentView(projectId, row) {
  if (!row.cmsEntryId) throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Page not found' });
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.entryGetFields(conn, row.cmsEntryId, 'draft', INTERACTIVE);
  return clientContentView(res?.entry);
}

/** API shape of a mirrored suggestion. Clients get no site ids, block keys or revision ids. */
export function formatSuggestion(s, { forClient = false } = {}) {
  return {
    id: s.id,
    round: s.round,
    field: s.targetField,
    ...(forClient ? {} : { blockKey: s.targetBlockKey || null, appliedRevisionId: s.appliedRevisionId || null }),
    quote: s.quote,
    proposedText: s.proposedText,
    note: s.note || null,
    state: s.state,
    // EmDash SEO is not revisioned: the plugin never applies SEO suggestions; editors change SEO by hand, then Accept.
    applicable: !String(s.targetField || '').startsWith('seo.'),
    source: s.source,
    createdByName: s.createdByName || null,
    onBehalfOfClient: !!s.onBehalfOfClient,
    decidedByName: s.decidedByName || null,
    decidedAt: s.decidedAt ? new Date(s.decidedAt).toISOString() : null,
    decisionNote: s.decisionNote || null,
    createdAt: (s.siteCreatedAt || s.createdAt) ? new Date(s.siteCreatedAt || s.createdAt).toISOString() : null,
  };
}

export async function listSuggestions(contentReviewId, { forClient = false } = {}) {
  const [rows, review] = await Promise.all([
    prisma.cmsReviewSuggestion.findMany({
      where: { contentReviewId },
      orderBy: [{ round: 'desc' }, { siteCreatedAt: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    }),
    prisma.wpContentReview.findUnique({ where: { id: contentReviewId }, select: { status: true, isPublished: true } }),
  ]);
  // The site closes still-open suggestions when the review is published or cancelled (§21.3).
  const ended = !!review && (review.isPublished || review.status === 'published' || review.status === 'cancelled');
  return rows.map((r) => formatSuggestion(ended && r.state === 'open' ? { ...r, state: 'closed' } : r, { forClient }));
}

/** Map a client-review error to { status, body } (no site internals for clients). */
export function clientReviewErrorResponse(err, log) {
  if (!(err instanceof CmsBridgeError)) {
    if (err?.name === 'CmsKeyConfigError') return { status: 503, body: { message: 'The website connection is not configured on the server.' } };
    log?.error?.({ err }, 'EmDash client review failed');
    return { status: 500, body: { message: 'Could not send the decision. Try again.' } };
  }
  const auth = ['BAD_SIGNATURE', 'UNKNOWN_KEY', 'UNKNOWN_SITE', 'STALE_TIMESTAMP', 'REPLAY'].includes(err.code);
  let status = err.status || 502;
  if (auth || status === 401 || status >= 500) status = status === 501 ? 409 : 502;
  const message = auth ? 'The website did not accept Agency OS. Ask your project manager to check the connection.' : err.message;
  return {
    status,
    body: {
      code: err.code,
      message,
      ...(err.details?.fallback ? { fallback: err.details.fallback } : {}),
      ...(err.details?.currentRound ? { currentRound: err.details.currentRound } : {}),
      ...(err.details?.currentStatus ? { currentStatus: err.details.currentStatus } : {}),
    },
  };
}
