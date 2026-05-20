import { prisma } from '../lib/prisma.js';
import { maybeGenerateSummary, autoSyncSitemap } from '../lib/wpSync.js';
import { notify } from '../lib/notificationService.js';
import { publish as publishRealtime } from '../lib/realtimeBus.js';

export async function wpWebhookRoutes(app) {
  app.post('/wp-content-change', async (request, reply) => {
    const body = request.body || {};
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) {
      return reply.status(401).send({ message: 'Missing apiKey' });
    }

    const project = await prisma.project.findFirst({
      where: { wpApiKey: apiKey },
      select: { id: true, wpUrl: true },
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

    try {
      publishRealtime(project.id, 'wp:content-change', {
        wpPostId,
        status,
        eventType,
        title,
      });
    } catch { /* fail-safe */ }

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
      select: { id: true, leadPmId: true, secondaryPmId: true, name: true },
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
    const status = String(body.status || '').slice(0, 50);
    const revisionNumber = Number(body.revisionNumber) || 1;
    const pmPreviewUrl = String(body.pmPreviewUrl || '').slice(0, 1000) || null;
    const clientPreviewUrl = String(body.clientPreviewUrl || '').slice(0, 1000) || null;
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

    // Determine published/cancelled flags
    const isPublishEvent = eventType === 'pipeline_published';
    const isCancelEvent = eventType === 'pipeline_cancelled';

    // Upsert the content review record
    const review = await prisma.wpContentReview.upsert({
      where: {
        projectId_wpPipelineId: { projectId: project.id, wpPipelineId },
      },
      update: {
        wpPostId,
        postTitle,
        status,
        submittedByName,
        submittedById,
        pmMemberName,
        pmMemberId,
        pmPreviewUrl,
        clientPreviewUrl,
        pmDecision,
        pmComment,
        clientDecision,
        clientComment,
        workerNote,
        pmReviewedAt,
        clientReviewedAt,
        revisionNumber,
        lastEventType: eventType,
        ...(isPublishEvent || isCancelEvent ? { isPublished: true, publishedAt: new Date() } : {}),
      },
      create: {
        projectId: project.id,
        wpPipelineId,
        wpPostId,
        postTitle,
        status,
        submittedByName,
        submittedById,
        pmMemberName,
        pmMemberId,
        pmPreviewUrl,
        clientPreviewUrl,
        pmDecision,
        pmComment,
        clientDecision,
        clientComment,
        workerNote,
        pmReviewedAt,
        clientReviewedAt,
        revisionNumber,
        lastEventType: eventType,
        ...(isPublishEvent || isCancelEvent ? { isPublished: true, publishedAt: new Date() } : {}),
      },
    });

    // Create immutable event log entry
    try {
      await prisma.wpContentReviewEvent.create({
        data: {
          contentReviewId: review.id,
          eventType,
          status,
          revisionNumber,
          workerNote,
          pmComment,
          pmDecision,
          clientComment,
          clientDecision,
          pmReviewedAt: body.pmReviewedAt ? String(body.pmReviewedAt).slice(0, 50) : null,
          clientReviewedAt: body.clientReviewedAt ? String(body.clientReviewedAt).slice(0, 50) : null,
        },
      });
    } catch {
      // Don't fail the webhook if event creation fails
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
      const pmIds = uniq([project.leadPmId, project.secondaryPmId]);

      console.log(`[pipeline-notify] eventType=${eventType} status=${status} ownerIds=${JSON.stringify(ownerIds)} pmIds=${JSON.stringify(pmIds)} submittedById=${submittedById}`);

      // Common variables for all pipeline notifications
      const nowFormatted = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const commonVars = { postTitle, projectName: project.name || '', postType, submittedBy: submittedByName || 'Team member', submittedAt: nowFormatted };

      if (eventType === 'pipeline_submitted' || eventType === 'pipeline_resubmitted') {
        // PM(s) + Owners receive the "submitted for review" notification.
        const recipients = uniq([...pmIds, ...ownerIds]);
        if (recipients.length > 0) {
          const roundLabel = revisionNumber > 1 ? ` (Round ${revisionNumber})` : '';
          notify({
            slug: 'content_submitted_for_review',
            recipientIds: recipients,
            variables: { ...commonVars, roundLabel },
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
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
            actionUrl: clientPreviewUrl || pmPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
        // Notify client users that content is ready for their review
        const clientUserIds = await getClientUserIds();
        if (clientUserIds.length > 0) {
          notify({
            slug: 'content_ready_for_client_review',
            recipientIds: uniq(clientUserIds),
            variables: commonVars,
            actionUrl: clientPreviewUrl,
            metadata: { contentReviewId: review.id },
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
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
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
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
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
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      } else if (eventType === 'pipeline_published') {
        // Notify PM(s) + submitter/worker + Owners + Clients (so everyone knows it went live)
        const clientUserIds = await getClientUserIds();
        const recipients = uniq([...pmIds, submittedById, ...ownerIds, ...clientUserIds]);
        if (recipients.length > 0) {
          notify({
            slug: 'content_published',
            recipientIds: recipients,
            variables: commonVars,
            actionUrl: clientPreviewUrl || pmPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
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
        const clientUserIds = await getClientUserIds();
        // Include everyone relevant: PMs + worker + owners + clients
        const recipients = uniq([...pmIds, submittedById, ...ownerIds, ...clientUserIds]);
        console.log(`[pipeline-notify] RESEND slug=${slug} recipients=${JSON.stringify(recipients)} status=${status}`);
        if (recipients.length > 0) {
          notify({
            slug,
            recipientIds: recipients,
            variables: commonVars,
            actionUrl: clientPreviewUrl || pmPreviewUrl,
            metadata: { contentReviewId: review.id, resend: true },
          }).then(() => console.log(`[pipeline-notify] notify() resolved for slug=${slug}`)).catch((err) => console.error(`[pipeline-notify] notify() FAILED:`, err));
        } else {
          console.warn('[pipeline-notify] RESEND: no recipients found — skipping notify()');
        }
      }
    } catch {
      // Don't fail the webhook if notification fails
    }

    return reply.send({ success: true, projectId: project.id, wpPipelineId });
  });
}
