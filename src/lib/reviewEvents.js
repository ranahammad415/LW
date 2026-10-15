/**
 * Shared content-review event handling for every CMS bridge (plan §3.4 O5).
 *
 * Extracted from the `wp-pipeline-event` webhook in routes/webhooks.js: the upsert of
 * WpContentReview, the AI summary backfill, the immutable WpContentReviewEvent row, the
 * realtime push, the content-map mirror and the notifications. The WordPress webhook and
 * the EmDash `/events` route both call `applyReviewEvent` with a normalized event
 * (`wordpress.normalizePipelineWebhook` / `emdash.normalizeReviewEvent`).
 *
 * Differences by source (everything else is identical):
 * - WORDPRESS: the stale client-rewind guard and the decision-clearing heuristics in
 *   lib/pipelineWebhookGuard.js apply (WP webhooks are fire-and-forget, unordered).
 * - EMDASH: ordering is enforced by the per-review `seq` before this is called, and the
 *   site sends the full Review, so decision fields are taken verbatim; cms* columns are
 *   written; the event row carries cmsSeq.
 */
import { prisma } from './prisma.js';
import { maybeGenerateSummary } from './wpSync.js';
import { notify, notifyTest } from './notificationService.js';
import { publish as publishRealtime } from './realtimeBus.js';
import { commentsForEventType, timestampsForEventType } from './pipelineFormat.js';
import { mirrorPipelineToMaps } from './contentMapSync.js';
import {
  shouldIgnoreStaleClientRewind,
  shouldClearClientDecision,
} from './pipelineWebhookGuard.js';

/**
 * Apply one normalized review event to the OS mirror.
 *
 * @param {object} p
 * @param {{id:string, leadPmId?:string|null, name?:string|null}} p.project
 * @param {import('./siteAdapters/types.js').NormalizedReviewEvent} p.event
 * @param {object} [p.log]  Fastify logger (content-map mirror)
 * @returns {Promise<{skipped?: string, review?: object, testResponse?: object}>}
 */
export async function applyReviewEvent({ project, event: n, log }) {
  const isEmdash = n.source === 'EMDASH';
  const {
    wpPipelineId,
    eventType,
    wpPostId,
    postTitle,
    postType,
    contentType,
    parentWpPostId,
    logMessage,
    status,
    revisionNumber,
    pmPreviewUrl,
    clientPreviewUrl,
    pmDecision,
    pmComment,
    clientDecision,
    clientComment,
    submittedByName,
    submittedById,
    pmMemberName,
    pmMemberId,
    workerNote,
    pmReviewedAt,
    clientReviewedAt,
    wpCreatedAt,
    wpUpdatedAt,
  } = n;

  // Fallback action URL: link to OS portal project page (never expires).
  // Deep-link to the Content Reviews tab so recipients land on the relevant
  // section instead of the default List View. The role-aware rewrite in
  // notificationService preserves the query string when swapping the path.
  const portalProjectUrl = `/portal/admin/projects/${project.id}?tab=content-reviews`;

  // Determine published/cancelled flags
  const isPublishEvent = eventType === 'pipeline_published';
  const isCancelEvent = eventType === 'pipeline_cancelled';

  let alreadyPublished = false;
  let existingAssigneeId = null;
  let existingStatus = null;
  let existingClientReviewedAt = null;
  try {
    const existingReview = await prisma.wpContentReview.findUnique({
      where: {
        projectId_wpPipelineId: { projectId: project.id, wpPipelineId },
      },
      select: { isPublished: true, assignedWorkerId: true, status: true, clientReviewedAt: true },
    });
    alreadyPublished = existingReview?.isPublished || false;
    existingClientReviewedAt = existingReview?.clientReviewedAt || null;
    existingAssigneeId = existingReview?.assignedWorkerId || null;
    existingStatus = existingReview?.status || null;
  } catch { /* fail-safe */ }

  if (
    !isEmdash &&
    shouldIgnoreStaleClientRewind({
      existingStatus,
      existingIsPublished: alreadyPublished,
      eventType,
      incomingStatus: status,
      existingClientReviewedAt,
      incomingPmReviewedAt: pmReviewedAt,
    })
  ) {
    return { skipped: 'stale_client_rewind' };
  }

  const resolvedStatus =
    isPublishEvent || alreadyPublished ? 'published' : status;
  // When WP re-enters a pending_* stage, drop stale decision fields so OS
  // badges match WP (e.g. changes_updated → pending_client_review).
  // EmDash sends the authoritative Review, so its decision fields are kept as sent.
  const shouldClearClient = isEmdash
    ? false
    : shouldClearClientDecision({
        resolvedStatus,
        eventType,
        existingStatus,
        existingIsPublished: alreadyPublished,
        existingClientReviewedAt,
        incomingPmReviewedAt: pmReviewedAt,
      });
  const shouldClearPm = isEmdash
    ? false
    : resolvedStatus === 'pending_pm_review' ||
      eventType === 'pipeline_resubmitted';

  const cmsData = isEmdash && n.cms
    ? {
        ...(n.cms.reviewId ? { cmsReviewId: n.cms.reviewId } : {}),
        ...(n.cms.entryId ? { cmsEntryId: n.cms.entryId } : {}),
        ...(n.cms.revisionId ? { cmsRevisionId: n.cms.revisionId } : {}),
        ...(n.cms.editUrl ? { cmsEditUrl: n.cms.editUrl } : {}),
        ...(n.cms.links ? { cmsLinks: n.cms.links } : {}),
        ...(Number.isInteger(n.cms.seq) ? { cmsSeq: n.cms.seq } : {}),
      }
    : {};

  // Upsert the content review record
  const review = await prisma.wpContentReview.upsert({
    where: {
      projectId_wpPipelineId: { projectId: project.id, wpPipelineId },
    },
    update: {
      wpPostId,
      postTitle,
      // Canonicalize to 'published' on the publish event, and never let a
      // later (out-of-order) event regress an already-published row back to
      // an approved/pending status.
      status: resolvedStatus,
      submittedByName,
      submittedById,
      pmMemberName,
      pmMemberId,
      // Defensive: only overwrite preview URLs when WP actually sent fresh
      // values. If the WP transient expired and the plugin sent empty
      // strings, we coerced to null above — don't wipe the previously
      // stored URL. (Task 1 in the WP plugin self-heals this; this is a
      // belt-and-suspenders for any future code path.)
      ...(pmPreviewUrl ? { pmPreviewUrl } : {}),
      ...(clientPreviewUrl ? { clientPreviewUrl } : {}),
      pmDecision: shouldClearPm ? null : pmDecision,
      pmComment,
      clientDecision: shouldClearClient ? null : clientDecision,
      clientComment: shouldClearClient ? null : clientComment,
      workerNote,
      // Don't wipe a previously stored content type if WP omits it on a
      // later event (only submit/resubmit reliably carry it).
      ...(contentType ? { contentType } : {}),
      // Persist the parent-page link for update-mode reviews (don't wipe if a
      // later event omits it).
      ...(parentWpPostId ? { parentWpPostId } : {}),
      pmReviewedAt: shouldClearPm ? null : pmReviewedAt,
      clientReviewedAt: shouldClearClient ? null : clientReviewedAt,
      revisionNumber,
      lastEventType: eventType,
      wpUpdatedAt,
      ...(wpCreatedAt ? { wpCreatedAt } : {}),
      // Never regress the published flag once set; only ever flip it true.
      ...(isPublishEvent || isCancelEvent
        ? { isPublished: true, ...(alreadyPublished ? {} : { publishedAt: new Date() }) }
        : {}),
      ...cmsData,
    },
    create: {
      projectId: project.id,
      wpPipelineId,
      wpPostId,
      postTitle,
      status: isPublishEvent ? 'published' : status,
      submittedByName,
      submittedById,
      // Default OS assignee to submitter; Admin/PM may reassign later.
      ...(submittedById && !existingAssigneeId
        ? { assignedWorkerId: submittedById, assignedWorkerName: submittedByName }
        : {}),
      pmMemberName,
      pmMemberId,
      pmPreviewUrl,
      clientPreviewUrl,
      pmDecision: shouldClearPm ? null : pmDecision,
      pmComment,
      clientDecision: shouldClearClient ? null : clientDecision,
      clientComment: shouldClearClient ? null : clientComment,
      workerNote,
      contentType,
      parentWpPostId,
      pmReviewedAt: shouldClearPm ? null : pmReviewedAt,
      clientReviewedAt: shouldClearClient ? null : clientReviewedAt,
      revisionNumber,
      lastEventType: eventType,
      wpCreatedAt: wpCreatedAt || new Date(),
      wpUpdatedAt,
      ...(isPublishEvent || isCancelEvent ? { isPublished: true, publishedAt: new Date() } : {}),
      ...cmsData,
    },
  });

  // Reflect pipeline progress on any matching content map node.
  mirrorPipelineToMaps(project.id, review, log).catch(() => {});

  // Generate / persist AI summary on initial submit, resubmit, OR resend
  // notification (so legacy rows created before AI summary existed get
  // backfilled the next time someone clicks Notify). Skipped silently on
  // failure — emails will fall back to empty summary line.
  if (!review.aiSummary && (eventType === 'pipeline_submitted' || eventType === 'pipeline_resubmitted' || eventType === 'pipeline_resend_notification')) {
    try {
      const rawExcerpt = String(n.summaryExcerpt || '').slice(0, 4000);
      if (rawExcerpt) {
        const aiSummary = await maybeGenerateSummary({ excerpt: rawExcerpt, isElementor: !!n.isElementor });
        if (aiSummary) {
          await prisma.wpContentReview.update({
            where: { id: review.id },
            data: { aiSummary },
          });
          review.aiSummary = aiSummary;
        }
      }
    } catch (err) {
      console.error('[pipeline-notify] aiSummary generation failed:', err.message);
    }
  }

  // Create immutable event log entry.
  // Skip resend-notification — it re-fires the same status/comments and
  // floods the timeline with duplicate rows at the same timestamp.
  // Skip links-regenerated — URL rotation should update stored previews without
  // adding a noisy timeline row (message still available via lastEventType).
  if (eventType !== 'pipeline_resend_notification' && eventType !== 'pipeline_links_regenerated') {
    try {
      // Dedupe the "Published" entry: the OS publish proxy, this
      // pipeline_published webhook, and the wp-content-change webhook can all
      // fire for a single publish. Only ever keep one published event.
      let skipCreate = false;
      if (isPublishEvent) {
        const existingPublished = await prisma.wpContentReviewEvent.findFirst({
          where: { contentReviewId: review.id, eventType: 'pipeline_published' },
          select: { id: true },
        });
        if (existingPublished) skipCreate = true;
      }

      if (!skipCreate) {
        const scoped = commentsForEventType(eventType, {
          workerNote,
          pmComment,
          clientComment,
          pmDecision,
          clientDecision,
        });
        const scopedTimes = timestampsForEventType(eventType, {
          pmReviewedAt,
          clientReviewedAt,
        });
        await prisma.wpContentReviewEvent.create({
          data: {
            contentReviewId: review.id,
            eventType,
            // Store the canonical 'published' status on publish events so the
            // timeline label is correct even if a legacy plugin sends the
            // lingering pipeline status (e.g. client_approved).
            status: isPublishEvent ? 'published' : status,
            revisionNumber,
            message: logMessage,
            workerNote: scoped.workerNote,
            pmComment: scoped.pmComment,
            pmDecision: scoped.pmDecision,
            clientComment: scoped.clientComment,
            clientDecision: scoped.clientDecision,
            pmReviewedAt: scopedTimes.pmReviewedAt,
            clientReviewedAt: scopedTimes.clientReviewedAt,
            ...(isEmdash && Number.isInteger(n.cms?.seq) ? { cmsSeq: n.cms.seq } : {}),
          },
        });
      }
    } catch {
      // Don't fail the webhook if event creation fails
    }
  }

  // Push realtime update to any subscribers of this project (PM / client portals).
  try {
    publishRealtime(project.id, 'wp:pipeline', {
      contentReviewId: review.id,
      wpPipelineId,
      wpPostId,
      postTitle,
      status,
      eventType,
      revisionNumber,
    });
  } catch { /* fail-safe */ }

  // Send notifications based on event type
  try {
    const testResponse = await notifyForReviewEvent({
      project,
      n,
      review,
      alreadyPublished,
      portalProjectUrl,
    });
    if (testResponse) return { review, testResponse };
  } catch {
    // Don't fail the webhook if notification fails
  }

  return { review };
}

async function notifyForReviewEvent({ project, n, review, alreadyPublished, portalProjectUrl }) {
  const {
    wpPipelineId,
    eventType,
    postTitle,
    postType,
    status,
    revisionNumber,
    pmPreviewUrl,
    clientPreviewUrl,
    submittedByName,
    submittedById,
  } = n;

  // Helper: fetch client user IDs for this project
  const getClientUserIds = async () => {
    try {
      const proj = await prisma.project.findUnique({
        where: { id: project.id },
        select: { clientId: true },
      });
      if (!proj?.clientId) return [];
      const clientUsers = await prisma.clientUser.findMany({
        where: { clientId: proj.clientId },
        select: { userId: true },
      });
      return clientUsers.map((cu) => cu.userId);
    } catch { return []; }
  };

  // Helper: fetch all active OWNER (admin) user IDs
  const getOwnerUserIds = async () => {
    try {
      const owners = await prisma.user.findMany({
        where: { role: 'OWNER', isActive: true },
        select: { id: true },
      });
      return owners.map((o) => o.id);
    } catch (err) {
      console.error('[pipeline-notify] getOwnerUserIds error:', err.message);
      return [];
    }
  };

  // Helper: dedupe + drop falsy
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

  // Resolve common recipient groups once per request
  const ownerIds = await getOwnerUserIds();
  const pmIds = uniq([project.leadPmId]);

  console.log(`[pipeline-notify] eventType=${eventType} status=${status} ownerIds=${JSON.stringify(ownerIds)} pmIds=${JSON.stringify(pmIds)} submittedById=${submittedById}`);

  // Common variables for all pipeline notifications
  const nowFormatted = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const commonVars = { postTitle, contentTitle: postTitle, projectName: project.name || '', postType, submittedBy: submittedByName || 'Team member', submittedAt: nowFormatted, aiSummary: review.aiSummary || '' };

  if (eventType === 'pipeline_submitted' || eventType === 'pipeline_resubmitted') {
    // PM(s) + Owners receive the "submitted for review" notification.
    const recipients = uniq([...pmIds, ...ownerIds]);
    if (recipients.length > 0) {
      const roundLabel = revisionNumber > 1 ? ` (Round ${revisionNumber})` : '';
      notify({
        slug: 'content_submitted_for_review',
        recipientIds: recipients,
        variables: { ...commonVars, roundLabel },
        actionUrl: pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
  } else if (eventType === 'pipeline_pm_approved') {
    // Notify submitter (worker) + Owners that PM approved
    const internal = uniq([submittedById, ...ownerIds]);
    if (internal.length > 0) {
      notify({
        slug: 'content_pm_approved',
        recipientIds: internal,
        variables: commonVars,
        actionUrl: clientPreviewUrl || pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
    // Notify client users that content is ready for their review
    const clientUserIds = await getClientUserIds();
    if (clientUserIds.length > 0) {
      notify({
        slug: 'content_ready_for_client_review',
        recipientIds: uniq(clientUserIds),
        variables: commonVars,
        actionUrl: clientPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
  } else if (eventType === 'pipeline_pm_changes_requested') {
    // Notify submitter/worker + PM(s) + Owners that PM requested changes
    const recipients = uniq([submittedById, ...pmIds, ...ownerIds]);
    if (recipients.length > 0) {
      notify({
        slug: 'content_pm_changes_requested',
        recipientIds: recipients,
        variables: commonVars,
        actionUrl: pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
  } else if (eventType === 'pipeline_client_approved') {
    // Notify PM(s) + submitter/worker + Owners
    const recipients = uniq([...pmIds, submittedById, ...ownerIds]);
    if (recipients.length > 0) {
      notify({
        slug: 'content_client_approved',
        recipientIds: recipients,
        variables: commonVars,
        actionUrl: pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
  } else if (eventType === 'pipeline_client_changes_requested') {
    // Notify PM(s) + submitter/worker + Owners
    const recipients = uniq([...pmIds, submittedById, ...ownerIds]);
    if (recipients.length > 0) {
      notify({
        slug: 'content_client_changes_requested',
        recipientIds: recipients,
        variables: commonVars,
        actionUrl: pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id },
      }).catch(() => {});
    }
  } else if (eventType === 'pipeline_published') {
    if (!alreadyPublished) {
      // Publish announcement: Owners + Client Managers + Client Viewers only.
      // Worker/PM are excluded — they triggered the publish themselves.
      const clientUserIds = await getClientUserIds();
      const recipients = uniq([...ownerIds, ...clientUserIds]);
      if (recipients.length > 0) {
        notify({
          slug: 'content_published',
          recipientIds: recipients,
          variables: commonVars,
          actionUrl: clientPreviewUrl || pmPreviewUrl || portalProjectUrl,
          metadata: { contentReviewId: review.id, projectId: project.id },
        }).catch(() => {});
      }
    }
  } else if (eventType === 'pipeline_resend_notification') {
    // Re-fire notifications based on the current pipeline status.
    const statusSlugMap = {
      pending_pm_review: 'content_submitted_for_review',
      pending_client_review: 'content_ready_for_client_review',
      pm_approved: 'content_pm_approved',
      client_approved: 'content_client_approved',
      changes_requested_by_pm: 'content_pm_changes_requested',
      changes_requested_by_client: 'content_client_changes_requested',
      // Legacy/alternate keys
      pm_changes_requested: 'content_pm_changes_requested',
      client_changes_requested: 'content_client_changes_requested',
    };
    const slug = statusSlugMap[status] || 'content_submitted_for_review';

    // ---------- TEST MODE ----------
    // If the WP plugin requested a test send, route the same template+vars
    // to the provided test addresses instead of real recipients. No DB writes.
    if (n.testMode) {
      const te = n.testEmails || {};
      const testRecipients = [];
      if (te.owner)  testRecipients.push({ email: String(te.owner).trim(),  audience: 'AGENCY_OWNER',   name: 'Test Owner' });
      if (te.pm)     testRecipients.push({ email: String(te.pm).trim(),     audience: 'AGENCY_TEAM',    name: 'Test PM' });
      if (te.client) testRecipients.push({ email: String(te.client).trim(), audience: 'CLIENT_MANAGER', name: 'Test Client' });
      console.log(`[pipeline-notify] TEST RESEND slug=${slug} testRecipients=${JSON.stringify(testRecipients.map(r => r.email))} status=${status}`);
      if (testRecipients.length > 0) {
        const results = await notifyTest({
          slug,
          variables: commonVars,
          actionUrl: clientPreviewUrl || pmPreviewUrl || portalProjectUrl,
          metadata: { contentReviewId: review.id, projectId: project.id, test: true },
          testRecipients,
        }).catch((err) => {
          console.error('[pipeline-notify] notifyTest() FAILED:', err);
          return [{ success: false, error: err.message }];
        });
        return {
          success: true,
          testMode: true,
          projectId: project.id,
          wpPipelineId,
          results,
        };
      } else {
        return { success: true, testMode: true, results: [], message: 'No test emails provided.' };
      }
    }
    // ---------- END TEST MODE ----------

    // Target only the responsible party based on current status
    let recipients;
    if (status === 'pending_pm_review') {
      // PM must review — notify PMs + Owners
      recipients = uniq([...pmIds, ...ownerIds]);
    } else if (status === 'pm_approved') {
      // PM approved, waiting for client assignment — notify Worker + Owners
      recipients = uniq([submittedById, ...ownerIds]);
    } else if (status === 'pending_client_review') {
      // Client must review — notify Clients + Owners
      const clientUserIds = await getClientUserIds();
      recipients = uniq([...clientUserIds, ...ownerIds]);
    } else if (status === 'client_approved') {
      // Client done, team should proceed — notify PMs + Worker + Owners
      recipients = uniq([...pmIds, submittedById, ...ownerIds]);
    } else if (status === 'changes_requested_by_pm' || status === 'pm_changes_requested') {
      // Worker must fix — notify Worker + Owners
      recipients = uniq([submittedById, ...ownerIds]);
    } else if (status === 'changes_requested_by_client' || status === 'client_changes_requested') {
      // Team must fix — notify PMs + Worker + Owners
      recipients = uniq([...pmIds, submittedById, ...ownerIds]);
    } else {
      // Fallback: notify PMs + Owners
      recipients = uniq([...pmIds, ...ownerIds]);
    }

    console.log(`[pipeline-notify] RESEND slug=${slug} recipients=${JSON.stringify(recipients)} status=${status}`);
    if (recipients.length > 0) {
      notify({
        slug,
        recipientIds: recipients,
        variables: commonVars,
        actionUrl: clientPreviewUrl || pmPreviewUrl || portalProjectUrl,
        metadata: { contentReviewId: review.id, projectId: project.id, resend: true },
      }).then(() => console.log(`[pipeline-notify] notify() resolved for slug=${slug}`)).catch((err) => console.error(`[pipeline-notify] notify() FAILED:`, err));
    } else {
      console.warn('[pipeline-notify] RESEND: no recipients found — skipping notify()');
    }
  }
  return null;
}
