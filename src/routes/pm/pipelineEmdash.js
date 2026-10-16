/**
 * EmDash branch of the PM pipeline routes (plan O3). routes/pm/pipeline.js keeps the
 * guards and the access check, then hands EmDash projects to these handlers; WordPress
 * projects keep their original code path untouched.
 *
 * Every call is a signed `POST /_emdash/api/plugins/agency-os-bridge/<route>` with the
 * acting OS user as `actor` (contract osActor). The OS mirror is updated from the returned
 * Review without advancing cmsSeq, so the matching event (arriving on /events) is still
 * applied and notified exactly once.
 *
 * Publish/schedule from the OS is OUT in Phase 1 (contract §1): Publish answers
 * 403 PUBLISH_NOT_ALLOWED with the entry's admin edit URL ("Publish in site admin").
 */
import { prisma } from '../../lib/prisma.js';
import { recordPipelineTombstone } from '../../lib/pipelineReviewGuard.js';
import { loadEmdashConnection, mirrorEmdashReview, closeForeignReview } from '../../lib/cmsStore.js';
import {
  CmsBridgeError,
  emdashRoutes,
  osActor,
  publishNotAllowed,
  INTERACTIVE_RETRY_DELAYS_MS,
} from '../../lib/siteAdapters/emdash.js';
import { CmsKeyConfigError } from '../../lib/cmsKeyCrypto.js';
import { osPublishDecision, checkScheduleAt, STAFF_PREVIEW_MAX_TTL_SEC } from '../../lib/siteAdapters/publish.js';

const INTERACTIVE = { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, timeoutMs: 8000 };

const reviewInclude = {
  events: { orderBy: { createdAt: 'desc' }, take: 50 },
  project: { select: { name: true, cmsType: true, cmsCapabilities: true, client: { select: { agencyName: true } } } },
};

/** Map a bridge/config error to an OS JSON response ({ message, code }). */
export function sendEmdashError(reply, err, log) {
  if (err instanceof CmsKeyConfigError) {
    log?.error?.('CMS_KEY_ENCRYPTION_KEY is not set');
    return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: err.message });
  }
  if (!(err instanceof CmsBridgeError)) {
    log?.error?.({ err }, 'EmDash pipeline call failed');
    return reply.status(500).send({ message: 'EmDash request failed' });
  }
  log?.warn?.({ code: err.code, status: err.status }, 'EmDash site call failed');
  if (err.code === 'SITE_MISMATCH') {
    return reply.status(409).send({
      code: 'SITE_MISMATCH',
      message: 'This review belongs to a previous site pairing. It was closed in Agency OS; the site handles it locally.',
    });
  }
  const authFailure = ['BAD_SIGNATURE', 'UNKNOWN_KEY', 'UNKNOWN_SITE', 'STALE_TIMESTAMP', 'REPLAY'].includes(err.code);
  let status = err.status;
  if (authFailure || status >= 500 || status === 401) status = 502;
  const message = authFailure
    ? `The EmDash site rejected Agency OS's signature (${err.code}). Re-pair the site from the Website tab if this persists.`
    : err.message;
  return reply.status(status).send({
    code: err.code,
    message,
    ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}),
    ...(err.details?.editUrl ? { editUrl: err.details.editUrl } : {}),
  });
}

/** v1.0.5: close the OS row when the site says the review belongs to another siteId. */
async function onSiteMismatch(projectId, wpPipelineId, err, log) {
  if (!(err instanceof CmsBridgeError) || err.code !== 'SITE_MISMATCH') return;
  await closeForeignReview(projectId, wpPipelineId).catch((e) => log?.warn?.({ err: e }, 'closeForeignReview failed'));
}

async function loadReview(projectId, wpPipelineId) {
  const pipelineId = Number(wpPipelineId);
  if (!pipelineId) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Invalid pipeline id' });
  const row = await prisma.wpContentReview.findUnique({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
    select: { id: true, cmsReviewId: true, cmsEntryId: true, cmsEditUrl: true, status: true, isPublished: true },
  });
  if (!row || !row.cmsReviewId) {
    throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Content review not found' });
  }
  return row;
}

async function mirrorAndFormat(projectId, review, formatReview, log) {
  const row = review ? await mirrorEmdashReview(projectId, review, { log }) : null;
  if (!row?.id) return null;
  const full = await prisma.wpContentReview.findUnique({ where: { id: row.id }, include: reviewInclude });
  return full ? formatReview(full) : null;
}

/** POST .../review (PM decision). OWNER sends override:true, as WP's as_admin (audited on the site). */
export async function emdashPmReview({ request, reply, projectId, wpPipelineId, decision, comment, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    const { conn } = await loadEmdashConnection(projectId);
    const isOwner = request.user.role === 'OWNER';
    if (isOwner) {
      request.log.info({ projectId, wpPipelineId, reviewer: request.user.name, decision }, 'Admin override on EmDash pipeline-review');
    }
    const res = await emdashRoutes.pipelineReview(
      conn,
      {
        reviewId: row.cmsReviewId,
        decision,
        comment: comment || null,
        actor: osActor(request.user),
        ...(isOwner ? { override: true } : {}),
      },
      INTERACTIVE
    );
    const pipeline = await mirrorAndFormat(projectId, res.review, formatReview, request.log);
    return reply.send({ success: true, pipeline });
  } catch (err) {
    // v1.0.1 §8.2: after the client asked for changes the worker already has them; a PM
    // "request changes" there is refused (409). Approve sends the revised page back to the client
    // (or marks it ready to publish when the client chose "minor changes, then publish").
    if (err instanceof CmsBridgeError && err.code === 'INVALID_TRANSITION' && decision === 'changes_requested') {
      err.message =
        'The client already requested changes and the worker has them. When the page is revised, use Approve to send it back to the client.';
    }
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    return sendEmdashError(reply, err, request.log);
  }
}

/** Human OWNER/PM actor for publish/schedule (v1.3.0 §24.2: agents never publish). */
function publishActor(user) {
  return { kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), role: user.role };
}

async function projectCaps(projectId) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsCapabilities: true } });
  return p?.cmsCapabilities && typeof p.cmsCapabilities === 'object' ? p.cmsCapabilities : {};
}

/** Local refusal in the contract's terms (osPublishDecision / schedule checks). */
function decisionError(d, editUrl) {
  // e2e O10: keep the decision's own message ("Approved. Publish in the site admin." only fits a site without OS publish).
  if (d.error === 'PUBLISH_NOT_ALLOWED') {
    const e = publishNotAllowed(editUrl);
    return new CmsBridgeError({ status: e.status, code: e.code, message: d.message || e.message, retryable: false, details: e.details });
  }
  const status = d.error === 'FORBIDDEN' ? 403 : d.error === 'INVALID_TRANSITION' ? 409 : 400;
  return new CmsBridgeError({ status, code: d.error, message: d.message, retryable: false });
}

/** v1.3.0 messages for the publish family. */
function publishErrorMessage(err) {
  if (err.code === 'PUBLISH_BLOCKED') {
    const gates = Array.isArray(err.details?.gates) ? err.details.gates : [];
    return gates.length
      ? `Publishing was blocked by ${gates.length} rule${gates.length > 1 ? 's' : ''} on the site. Nothing was published.`
      : 'Publishing was blocked by the site. Nothing was published.';
  }
  if (err.code === 'PUBLISH_NOT_ALLOWED') return 'This site does not allow publishing from Agency OS. Publish in the site admin.';
  if (err.code === 'INVALID_TRANSITION') return 'The review is not approved by the client (or its state changed). Reload; an OWNER may override with a reason.';
  return null;
}

/**
 * POST .../publish. v1.3.0: with the site's publishFromOs capability → signed pipeline-publish (human OWNER/PM;
 * client_approved, or OWNER override with a reason ≥ 20 chars). Without it → 403 PUBLISH_NOT_ALLOWED + editUrl
 * (no site call, v1 behaviour).
 */
export async function emdashPublish({ request, reply, projectId, wpPipelineId, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    const caps = await projectCaps(projectId);
    const b = request.body || {};
    const override = b.override === true;
    const overrideReason = override ? String(b.overrideReason || '').trim().slice(0, 1000) : null;
    const actor = publishActor(request.user);
    const d = osPublishDecision({ status: row.status }, { actor, override, overrideReason }, caps);
    if (!d.ok) return sendEmdashError(reply, decisionError(d, row.cmsEditUrl), request.log);
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.pipelinePublish(
      conn,
      { reviewId: row.cmsReviewId, actor, ...(d.override ? { override: true, overrideReason } : {}) },
      INTERACTIVE
    );
    if (d.override) request.log.info({ projectId, wpPipelineId, by: request.user.id }, 'EmDash publish with OWNER override');
    const pipeline = res?.review && formatReview ? await mirrorAndFormat(projectId, res.review, formatReview, request.log) : null;
    return reply.send({ success: true, pipeline, publishedAt: res?.publishedAt || null, seoCheck: res?.seoCheck ?? null });
  } catch (err) {
    if (err instanceof CmsBridgeError) {
      const m = publishErrorMessage(err);
      if (m) err.message = m;
      if (err.code === 'CONFLICT_REV' && err.details?.review) await mirrorEmdashReview(projectId, err.details.review, { log: request.log }).catch(() => {});
    }
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    return sendEmdashError(reply, err, request.log);
  }
}

/** POST .../schedule { at, override?, overrideReason? } (capability scheduleFromOs). */
export async function emdashSchedule({ request, reply, projectId, wpPipelineId, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    const caps = await projectCaps(projectId);
    const b = request.body || {};
    const override = b.override === true;
    const overrideReason = override ? String(b.overrideReason || '').trim().slice(0, 1000) : null;
    const actor = publishActor(request.user);
    // Same rules as publish; the site advertises scheduling separately.
    const d = osPublishDecision({ status: row.status }, { actor, override, overrideReason }, { publishFromOs: caps.scheduleFromOs === true });
    if (!d.ok) return sendEmdashError(reply, decisionError(d, row.cmsEditUrl), request.log);
    const when = checkScheduleAt(b.at);
    if (!when.ok) return sendEmdashError(reply, decisionError(when, row.cmsEditUrl), request.log);
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.pipelineSchedule(
      conn,
      { reviewId: row.cmsReviewId, at: when.at, actor, ...(d.override ? { override: true, overrideReason } : {}) },
      INTERACTIVE
    );
    const pipeline = res?.review && formatReview ? await mirrorAndFormat(projectId, res.review, formatReview, request.log) : null;
    return reply.send({ success: true, pipeline });
  } catch (err) {
    if (err instanceof CmsBridgeError) {
      const m = publishErrorMessage(err);
      if (m) err.message = m;
    }
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    return sendEmdashError(reply, err, request.log);
  }
}

/** POST .../unschedule (scheduled → client_approved). */
export async function emdashUnschedule({ request, reply, projectId, wpPipelineId, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    const caps = await projectCaps(projectId);
    if (caps.scheduleFromOs !== true) return sendEmdashError(reply, publishNotAllowed(row.cmsEditUrl), request.log);
    if (row.status !== 'scheduled') {
      return sendEmdashError(reply, new CmsBridgeError({ status: 409, code: 'INVALID_TRANSITION', message: 'The review is not scheduled.' }), request.log);
    }
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.pipelineUnschedule(conn, { reviewId: row.cmsReviewId, actor: publishActor(request.user) }, INTERACTIVE);
    const pipeline = res?.review && formatReview ? await mirrorAndFormat(projectId, res.review, formatReview, request.log) : null;
    return reply.send({ success: true, pipeline });
  } catch (err) {
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    return sendEmdashError(reply, err, request.log);
  }
}

/**
 * POST .../preview-link → a short-lived staff preview URL of the entry's draft (v1.3.0 §24.3). Returned to the
 * caller only: never stored, never logged, never shown to clients.
 */
export async function emdashStaffPreview({ request, reply, projectId, wpPipelineId }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    const caps = await projectCaps(projectId);
    if (caps.previewLinks !== true || !row.cmsEntryId) {
      return sendEmdashError(reply, new CmsBridgeError({ status: 409, code: 'NOT_IMPLEMENTED', message: 'This site does not offer staff previews.' }), request.log);
    }
    const ttl = Math.min(STAFF_PREVIEW_MAX_TTL_SEC, Math.max(60, Number(request.body?.ttlSeconds) || STAFF_PREVIEW_MAX_TTL_SEC));
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.previewLink(conn, { entryId: row.cmsEntryId, ttlSeconds: ttl, actor: osActor(request.user) }, INTERACTIVE);
    reply.header('cache-control', 'no-store');
    return reply.send({ url: res.url, expiresAt: res.expiresAt, editUrl: res.editUrl || row.cmsEditUrl || null });
  } catch (err) {
    return sendEmdashError(reply, err, request.log);
  }
}

/** POST .../renew-preview | regenerate-preview-links → pipeline-rotate-links. Same response shape as WP. */
export async function emdashRenewPreview({ request, reply, projectId, wpPipelineId, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    if (row.isPublished || row.status === 'cancelled' || row.status === 'published') {
      return reply.status(400).send({ message: 'Review links can only be regenerated while the pipeline is active.' });
    }
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.pipelineRotateLinks(conn, { reviewId: row.cmsReviewId, actor: osActor(request.user) }, INTERACTIVE);
    const pmPreviewUrl = res.pmPreviewUrl ? String(res.pmPreviewUrl).slice(0, 1000) : null;
    const clientPreviewUrl = res.clientPreviewUrl ? String(res.clientPreviewUrl).slice(0, 1000) : null;
    const updated = await prisma.wpContentReview.update({
      where: { id: row.id },
      data: {
        ...(pmPreviewUrl ? { pmPreviewUrl } : {}),
        ...(clientPreviewUrl ? { clientPreviewUrl } : {}),
        lastEventType: 'pipeline_links_regenerated',
        wpUpdatedAt: new Date(),
      },
      include: reviewInclude,
    });
    return reply.send({
      success: true,
      pmPreviewUrl: updated.pmPreviewUrl,
      clientPreviewUrl: updated.clientPreviewUrl,
      pipeline: formatReview(updated),
    });
  } catch (err) {
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    if (err instanceof CmsBridgeError && err.status !== 404 && err.status !== 400) {
      // Same contract as the WP handler: HTTP 200 + success:false so edge proxies keep CORS.
      return reply.send({ success: false, code: err.code, message: err.message });
    }
    return sendEmdashError(reply, err, request.log);
  }
}

/** POST .../change-type → pipeline-change-type. */
export async function emdashChangeType({ request, reply, projectId, wpPipelineId, contentType, formatReview }) {
  try {
    const row = await loadReview(projectId, wpPipelineId);
    if (row.isPublished || row.status === 'cancelled') {
      return reply.status(400).send({ message: 'Content type can only be changed while the review is active.' });
    }
    const { conn } = await loadEmdashConnection(projectId);
    const res = await emdashRoutes.pipelineChangeType(
      conn,
      { reviewId: row.cmsReviewId, contentType, actor: osActor(request.user) },
      INTERACTIVE
    );
    const pipeline = await mirrorAndFormat(projectId, res.review, formatReview, request.log);
    return reply.send({ success: true, pipeline });
  } catch (err) {
    await onSiteMismatch(projectId, wpPipelineId, err, request.log);
    return sendEmdashError(reply, err, request.log);
  }
}

/** DELETE .../:wpPipelineId (OWNER): best-effort pipeline-cancel force, then tombstone + delete in the OS. */
export async function emdashDelete(args) {
  try {
    return await emdashDeleteInner(args);
  } catch (err) {
    // Never leak raw errors to the client (review C3).
    return sendEmdashError(args.reply, err, args.request.log);
  }
}

async function emdashDeleteInner({ request, reply, projectId, wpPipelineId }) {
  const pipelineId = Number(wpPipelineId);
  const existing = await prisma.wpContentReview.findUnique({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
    select: { id: true, cmsReviewId: true, status: true, isPublished: true },
  });
  if (existing?.cmsReviewId && !existing.isPublished && existing.status !== 'cancelled') {
    try {
      const { conn } = await loadEmdashConnection(projectId);
      await emdashRoutes.pipelineCancel(
        conn,
        { reviewId: existing.cmsReviewId, force: true, reason: 'Deleted in Agency OS', actor: osActor(request.user) },
        INTERACTIVE
      );
    } catch (err) {
      // NOT_FOUND / INVALID_TRANSITION: already gone or closed on the site; still wipe the OS row.
      const tolerated =
        err instanceof CmsBridgeError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_TRANSITION' || err.code === 'SITE_MISMATCH');
      if (!tolerated) {
        if (err instanceof CmsBridgeError && err.retryable) {
          return reply.status(502).send({ code: err.code, message: err.message || 'Unable to cancel the review on the EmDash site.' });
        }
        request.log.warn({ code: err?.code }, 'EmDash pipeline-cancel failed; OS delete will still proceed');
      }
    }
  }
  await recordPipelineTombstone({ projectId, wpPipelineId: pipelineId, deletedById: request.user?.id || null });
  if (existing) await prisma.wpContentReview.delete({ where: { id: existing.id } });
  return reply.send({ success: true });
}
