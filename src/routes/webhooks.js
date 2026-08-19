import { prisma } from '../lib/prisma.js';
import { maybeGenerateSummary, autoSyncSitemap } from '../lib/wpSync.js';
import { notify, notifyTest } from '../lib/notificationService.js';
import { publish as publishRealtime } from '../lib/realtimeBus.js';
import { commentsForEventType, timestampsForEventType, parseWpDate } from '../lib/pipelineFormat.js';
import { reconcileProjectMapsSafe, mirrorPipelineToMaps } from '../lib/contentMapSync.js';

export async function wpWebhookRoutes(app) {
  app.post('/wp-content-change', async (request, reply) => {
    const body = request.body || {};
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) {
      return reply.status(401).send({ message: 'Missing apiKey' });
    }

    const project = await prisma.project.findFirst({
      where: { wpApiKey: apiKey },
      select: { id: true, wpUrl: true, name: true },
    });
    if (!project) {
      return reply.status(401).send({ message: 'Invalid API key' });
    }

    const wpPostId = Number(body.wpPostId);
    if (!Number.isInteger(wpPostId) || wpPostId <= 0) {
      return reply.status(400).send({ message: 'Invalid wpPostId' });
    }

    const title = String(body.title || '').slice(0, 500);
    const postType = String(body.type || body.postType || 'page').slice(0, 50);
    const status = String(body.status || 'publish').slice(0, 50);
    const url = String(body.url || '').slice(0, 500);
    const content = String(body.snapshotHtml || body.content || '').slice(0, 200000);
    const contentExcerpt = String(body.contentExcerpt || '').slice(0, 1000) || null;
    const isElementor = body.isElementor === true;
    const modifiedAt = body.modifiedAt ? new Date(body.modifiedAt) : new Date();
    const eventType = ['created', 'updated', 'deleted'].includes(
      String(body.eventType || '').toLowerCase()
    )
      ? String(body.eventType || '').toLowerCase()
      : 'updated';

    // Handle deleted event: mark page as deleted and trigger sitemap sync
    if (eventType === 'deleted') {
      const existingPage = await prisma.wpPage.findUnique({
        where: { projectId_wpPostId: { projectId: project.id, wpPostId } },
      });
      if (existingPage) {
        await prisma.wpPage.update({
          where: { id: existingPage.id },
          data: { status: 'deleted', syncedAt: new Date() },
        });
        await prisma.wpPageSnapshot.create({
          data: {
            wpPageId: existingPage.id,
            title: existingPage.title,
            content: '',
            status: 'deleted',
            contentHash: String(Date.now()),
            eventType: 'deleted',
            contentExcerpt: null,
            aiSummary: null,
            wpUserId: body.agencyUserId ? String(body.agencyUserId).slice(0, 255) : null,
            wpUserName: body.agencyUserName ? String(body.agencyUserName).slice(0, 255) : null,
            ipAddress: body.ipAddress ? String(body.ipAddress).slice(0, 100) : null,
            userAgent: body.userAgent ? String(body.userAgent).slice(0, 500) : null,
            isElementor: false,
            syncedAt: new Date(),
          },
        });
      }

      // Auto-sync sitemap in background on delete
      autoSyncSitemap(project.id).catch(() => {});

      // Auto-cancel any active pipeline reviews for this post
      try {
        await prisma.wpContentReview.updateMany({
          where: { projectId: project.id, wpPostId, isPublished: false },
          data: { isPublished: true, publishedAt: new Date(), lastEventType: 'pipeline_cancelled', status: 'cancelled' },
        });
      } catch { /* fail-safe */ }

      try {
        publishRealtime(project.id, 'wp:content-change', {
          wpPostId,
          status: 'deleted',
          eventType: 'deleted',
        });
      } catch { /* fail-safe */ }

      return reply.send({ success: true, projectId: project.id, wpPostId, event: 'deleted' });
    }

    const aiSummary = await maybeGenerateSummary({ excerpt: contentExcerpt, isElementor });

    const upsertedPage = await prisma.wpPage.upsert({
      where: { projectId_wpPostId: { projectId: project.id, wpPostId } },
      update: {
        title,
        slug: String(body.slug || '').slice(0, 500),
        status,
        postType,
        url,
        content,
        excerpt: contentExcerpt,
        template: body.template ? String(body.template).slice(0, 200) : null,
        seoTitle: body.seoTitle ? String(body.seoTitle).slice(0, 500) : null,
        seoDescription: body.seoDescription ? String(body.seoDescription).slice(0, 1000) : null,
        contentHash: String(body.contentHash || '').slice(0, 64) || String(Date.now()),
        modifiedAt,
        syncedAt: new Date(),
      },
      create: {
        projectId: project.id,
        wpPostId,
        title,
        slug: String(body.slug || '').slice(0, 500),
        status,
        postType,
        url,
        content,
        excerpt: contentExcerpt,
        template: body.template ? String(body.template).slice(0, 200) : null,
        seoTitle: body.seoTitle ? String(body.seoTitle).slice(0, 500) : null,
        seoDescription: body.seoDescription ? String(body.seoDescription).slice(0, 1000) : null,
        contentHash: String(body.contentHash || '').slice(0, 64) || String(Date.now()),
        modifiedAt,
        syncedAt: new Date(),
      },
    });

    await prisma.wpPageSnapshot.create({
      data: {
        wpPageId: upsertedPage.id,
        title,
        content,
        status,
        template: body.template ? String(body.template).slice(0, 200) : null,
        seoTitle: body.seoTitle ? String(body.seoTitle).slice(0, 500) : null,
        seoDescription: body.seoDescription ? String(body.seoDescription).slice(0, 1000) : null,
        featuredImageUrl: body.featuredImageUrl ? String(body.featuredImageUrl).slice(0, 500) : null,
        contentHash: String(body.contentHash || '').slice(0, 64) || String(Date.now()),
        eventType,
        contentExcerpt,
        aiSummary,
        wpUserId: body.agencyUserId ? String(body.agencyUserId).slice(0, 255) : null,
        wpUserName: body.agencyUserName ? String(body.agencyUserName).slice(0, 255) : null,
        ipAddress: body.ipAddress ? String(body.ipAddress).slice(0, 100) : null,
        userAgent: body.userAgent ? String(body.userAgent).slice(0, 500) : null,
        isElementor,
        syncedAt: new Date(),
      },
    });

    // Auto-sync sitemap in background when a page is created
    if (eventType === 'created') {
      autoSyncSitemap(project.id).catch(() => {});
    }

    if (status === 'publish') {
      try {
        const review = await prisma.wpContentReview.findFirst({
          where: { projectId: project.id, wpPostId, isPublished: false },
        });

        if (review) {
          // Update it to published
          await prisma.wpContentReview.update({
            where: { id: review.id },
            data: {
              isPublished: true,
              publishedAt: new Date(),
              lastEventType: 'pipeline_published',
              status: 'published',
            },
          });

          // Also write an event log entry for history
          await prisma.wpContentReviewEvent.create({
            data: {
              contentReviewId: review.id,
              eventType: 'pipeline_published',
              status: 'published',
              revisionNumber: review.revisionNumber,
            },
          });

          // Send content_published notification
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

          const getOwnerUserIds = async () => {
            try {
              const owners = await prisma.user.findMany({
                where: { role: 'OWNER', isActive: true },
                select: { id: true },
              });
              return owners.map((o) => o.id);
            } catch { return []; }
          };

          const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

          const ownerIds = await getOwnerUserIds();
          const clientUserIds = await getClientUserIds();
          const recipients = uniq([...ownerIds, ...clientUserIds]);

          if (recipients.length > 0) {
            const nowFormatted = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
            const commonVars = {
              postTitle: review.postTitle || title,
              contentTitle: review.postTitle || title,
              projectName: project.name || '',
              postType: review.postType || postType || 'Page',
              submittedBy: review.submittedByName || 'Team member',
              submittedAt: nowFormatted,
              aiSummary: review.aiSummary || '',
            };

            const portalProjectUrl = `/portal/admin/projects/${project.id}?tab=content-reviews`;

            notify({
              slug: 'content_published',
              recipientIds: recipients,
              variables: commonVars,
              actionUrl: review.clientPreviewUrl || review.pmPreviewUrl || portalProjectUrl,
              metadata: { contentReviewId: review.id, projectId: project.id },
            }).catch(() => {});
          }

          // Realtime publish pipeline update
          try {
            publishRealtime(project.id, 'wp:pipeline', {
              contentReviewId: review.id,
              wpPipelineId: review.wpPipelineId,
              wpPostId,
              postTitle: review.postTitle,
              status: 'published',
              eventType: 'pipeline_published',
              revisionNumber: review.revisionNumber,
            });
          } catch { /* fail-safe */ }
        }
      } catch (err) {
        console.error('[wp-content-change] Pipeline publish handling failed:', err.message);
      }
    }

    try {
      publishRealtime(project.id, 'wp:content-change', {
        wpPostId,
        status,
        eventType,
        title,
      });
    } catch { /* fail-safe */ }

    // Reflect the change on any content map. Detached so it cannot affect the
    // webhook response the WP plugin is waiting on.
    reconcileProjectMapsSafe(project.id, request.log);

    return reply.send({ success: true, projectId: project.id, wpPostId });
  });

  /* ─── Pipeline event webhook from WP plugin ─── */
  app.post('/wp-pipeline-event', async (request, reply) => {
    const body = request.body || {};
    console.log('[wp-pipeline-event] RECEIVED:', JSON.stringify({ eventType: body.eventType, status: body.status, pipelineId: body.pipelineId, postTitle: body.postTitle }));
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) {
      return reply.status(401).send({ message: 'Missing apiKey' });
    }

    const project = await prisma.project.findFirst({
      where: { wpApiKey: apiKey },
      select: { id: true, leadPmId: true, name: true },
    });
    if (!project) {
      return reply.status(401).send({ message: 'Invalid API key' });
    }

    const wpPipelineId = Number(body.pipelineId);
    if (!Number.isInteger(wpPipelineId) || wpPipelineId <= 0) {
      return reply.status(400).send({ message: 'Invalid pipelineId' });
    }

    const eventType = String(body.eventType || '').trim();
    const wpPostId = Number(body.postId) || 0;
    const postTitle = String(body.postTitle || '').slice(0, 500);
    const postType = body.postType ? String(body.postType).slice(0, 50) : 'Page';
    // Worker-selected content/page type (landing_page, pillar_page, article, ...).
    const contentType = body.contentType ? String(body.contentType).slice(0, 50) : null;
    // "Update Content" workflow: the live parent page a review draft was cloned
    // from, and a generic human-readable log line (e.g. content-type change).
    const parentWpPostId = Number.isInteger(Number(body.parentPostId)) && Number(body.parentPostId) > 0
      ? Number(body.parentPostId)
      : null;
    const logMessage = body.logMessage ? String(body.logMessage).slice(0, 500) : null;
    const status = String(body.status || '').slice(0, 50);
    const revisionNumber = Number(body.revisionNumber) || 1;
    const pmPreviewUrl = String(body.pmPreviewUrl || '').slice(0, 1000) || null;
    const clientPreviewUrl = String(body.clientPreviewUrl || '').slice(0, 1000) || null;
    // Fallback action URL: link to OS portal project page (never expires).
    // Deep-link to the Content Reviews tab so recipients land on the relevant
    // section instead of the default List View. The role-aware rewrite in
    // notificationService preserves the query string when swapping the path.
    const portalProjectUrl = `/portal/admin/projects/${project.id}?tab=content-reviews`;
    const pmDecision = body.pmDecision ? String(body.pmDecision).slice(0, 50) : null;
    const pmComment = body.pmComment ? String(body.pmComment).slice(0, 10000) : null;
    const clientDecision = body.clientDecision ? String(body.clientDecision).slice(0, 50) : null;
    const clientComment = body.clientComment ? String(body.clientComment).slice(0, 10000) : null;

    const submittedByName = body.submittedBy?.name ? String(body.submittedBy.name).slice(0, 200) : null;
    const submittedById = body.submittedBy?.memberId ? String(body.submittedBy.memberId).slice(0, 100) : null;
    const pmMemberName = body.pmAssigned?.name ? String(body.pmAssigned.name).slice(0, 200) : null;
    const pmMemberId = body.pmAssigned?.memberId ? String(body.pmAssigned.memberId).slice(0, 100) : null;
    const workerNote = body.workerNote ? String(body.workerNote).slice(0, 10000) : null;
    const pmReviewedAt = body.pmReviewedAt ? String(body.pmReviewedAt).slice(0, 50) : null;
    const clientReviewedAt = body.clientReviewedAt ? String(body.clientReviewedAt).slice(0, 50) : null;
    const wpCreatedAt = parseWpDate(body.createdAt);
    const wpUpdatedAt = parseWpDate(body.updatedAt) || new Date();

    // Determine published/cancelled flags
    const isPublishEvent = eventType === 'pipeline_published';
    const isCancelEvent = eventType === 'pipeline_cancelled';

    let alreadyPublished = false;
    let existingAssigneeId = null;
    try {
      const existingReview = await prisma.wpContentReview.findUnique({
        where: {
          projectId_wpPipelineId: { projectId: project.id, wpPipelineId },
        },
        select: { isPublished: true, assignedWorkerId: true },
      });
      alreadyPublished = existingReview?.isPublished || false;
      existingAssigneeId = existingReview?.assignedWorkerId || null;
    } catch { /* fail-safe */ }

    const resolvedStatus =
      isPublishEvent || alreadyPublished ? 'published' : status;
    // When WP re-enters a pending_* stage, drop stale decision fields so OS
    // badges match WP (e.g. changes_updated → pending_client_review).
    const shouldClearClient =
      resolvedStatus === 'pending_client_review' ||
      eventType === 'pipeline_sent_to_client';
    const shouldClearPm =
      resolvedStatus === 'pending_pm_review' ||
      eventType === 'pipeline_resubmitted';

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
      },
    });

    // Reflect pipeline progress on any matching content map node.
    mirrorPipelineToMaps(project.id, review, request.log).catch(() => {});

    // Generate / persist AI summary on initial submit, resubmit, OR resend
    // notification (so legacy rows created before AI summary existed get
    // backfilled the next time someone clicks Notify). Skipped silently on
    // failure — emails will fall back to empty summary line.
    if (!review.aiSummary && (eventType === 'pipeline_submitted' || eventType === 'pipeline_resubmitted' || eventType === 'pipeline_resend_notification')) {
      try {
        const rawExcerpt = String(body.postExcerpt || body.postContent || '').slice(0, 4000);
        if (rawExcerpt) {
          const aiSummary = await maybeGenerateSummary({ excerpt: rawExcerpt, isElementor: !!body.isElementor });
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
            pmReviewedAt: body.pmReviewedAt ? String(body.pmReviewedAt).slice(0, 50) : null,
            clientReviewedAt: body.clientReviewedAt ? String(body.clientReviewedAt).slice(0, 50) : null,
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
        if (body.testMode === true || body.testMode === 'true' || body.testMode === 1) {
          const te = body.testEmails || {};
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
            return reply.send({
              success: true,
              testMode: true,
              projectId: project.id,
              wpPipelineId,
              results,
            });
          } else {
            return reply.send({ success: true, testMode: true, results: [], message: 'No test emails provided.' });
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
          console.warn('[pipeline-notify] RESEND: no recipients found \u2014 skipping notify()');
        }
      }
    } catch {
      // Don't fail the webhook if notification fails
    }

    return reply.send({ success: true, projectId: project.id, wpPipelineId });
  });

  /* ─── First-party lead / intent events from WP Bridge tracker ─── */
  const LEAD_EVENT_TYPES = new Set(['phone_click', 'email_click', 'form_submit', 'thank_you_page']);
  const leadRateBuckets = new Map(); // key -> { count, resetAt }

  function allowLeadIngest(key, max = 120, windowMs = 60_000) {
    const now = Date.now();
    let bucket = leadRateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      leadRateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (leadRateBuckets.size > 5000) {
      for (const [k, v] of leadRateBuckets) {
        if (now >= v.resetAt) leadRateBuckets.delete(k);
      }
    }
    return bucket.count <= max;
  }

  function utcDateOnly(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  function bumpLeadBreakdowns(existing, { ruleId, ruleLabel, eventType, pagePath }) {
    const breakdowns =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? {
            rules: Array.isArray(existing.rules) ? [...existing.rules] : [],
            paths: Array.isArray(existing.paths) ? [...existing.paths] : [],
          }
        : { rules: [], paths: [] };

    const ruleKey = `${eventType}::${ruleId || ruleLabel || 'default'}`;
    let ruleRow = breakdowns.rules.find(
      (r) => `${r.eventType}::${r.ruleId || r.ruleLabel || 'default'}` === ruleKey
    );
    if (!ruleRow) {
      ruleRow = {
        ruleId: ruleId || null,
        ruleLabel: ruleLabel || null,
        eventType,
        count: 0,
      };
      breakdowns.rules.push(ruleRow);
    }
    ruleRow.count += 1;
    if (ruleLabel) ruleRow.ruleLabel = ruleLabel;

    if (pagePath) {
      let pathRow = breakdowns.paths.find((p) => p.path === pagePath);
      if (!pathRow) {
        pathRow = { path: pagePath, count: 0 };
        breakdowns.paths.push(pathRow);
      }
      pathRow.count += 1;
    }

    return breakdowns;
  }

  app.post('/wp-lead-event', async (request, reply) => {
    const body = request.body || {};
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) {
      return reply.status(401).send({ message: 'Missing apiKey' });
    }

    const ip =
      request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
      request.ip ||
      'unknown';
    if (!allowLeadIngest(`${apiKey}:${ip}`)) {
      return reply.status(429).send({ message: 'Rate limit exceeded' });
    }

    const project = await prisma.project.findFirst({
      where: { wpApiKey: apiKey },
      select: { id: true },
    });
    if (!project) {
      return reply.status(401).send({ message: 'Invalid API key' });
    }

    const eventType = String(body.eventType || '').trim().toLowerCase();
    if (!LEAD_EVENT_TYPES.has(eventType)) {
      return reply.status(400).send({ message: 'Invalid eventType' });
    }

    const ruleId = body.ruleId != null ? String(body.ruleId).slice(0, 80) : null;
    const ruleLabel = body.ruleLabel != null ? String(body.ruleLabel).slice(0, 255) : null;
    const pageUrl = body.pageUrl != null ? String(body.pageUrl).slice(0, 1000) : null;
    const pagePath = body.pagePath != null ? String(body.pagePath).slice(0, 500) : null;
    const visitorId = body.visitorId != null ? String(body.visitorId).slice(0, 80) : null;
    const occurredAtRaw = body.occurredAt ? new Date(body.occurredAt) : new Date();
    const occurredAt = Number.isNaN(occurredAtRaw.getTime()) ? new Date() : occurredAtRaw;
    const meta =
      body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : null;

    const isLead = eventType === 'form_submit' || eventType === 'thank_you_page';
    const day = utcDateOnly(occurredAt);

    await prisma.siteLeadEvent.create({
      data: {
        projectId: project.id,
        eventType,
        ruleId,
        ruleLabel,
        pageUrl,
        pagePath,
        visitorId,
        occurredAt,
        meta,
      },
    });

    const existing = await prisma.siteLeadDailyMetric.findUnique({
      where: { projectId_date: { projectId: project.id, date: day } },
    });

    const counterPatch = {
      phoneClicks: eventType === 'phone_click' ? 1 : 0,
      emailClicks: eventType === 'email_click' ? 1 : 0,
      formSubmits: eventType === 'form_submit' ? 1 : 0,
      thankYouViews: eventType === 'thank_you_page' ? 1 : 0,
      leads: isLead ? 1 : 0,
    };

    const breakdowns = bumpLeadBreakdowns(existing?.breakdowns, {
      ruleId,
      ruleLabel,
      eventType,
      pagePath,
    });

    if (existing) {
      await prisma.siteLeadDailyMetric.update({
        where: { id: existing.id },
        data: {
          phoneClicks: { increment: counterPatch.phoneClicks },
          emailClicks: { increment: counterPatch.emailClicks },
          formSubmits: { increment: counterPatch.formSubmits },
          thankYouViews: { increment: counterPatch.thankYouViews },
          leads: { increment: counterPatch.leads },
          breakdowns,
        },
      });
    } else {
      await prisma.siteLeadDailyMetric.create({
        data: {
          projectId: project.id,
          date: day,
          ...counterPatch,
          breakdowns,
        },
      });
    }

    return reply.code(204).send();
  });
}
