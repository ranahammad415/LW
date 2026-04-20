import { prisma } from '../lib/prisma.js';
import { maybeGenerateSummary, autoSyncSitemap } from '../lib/wpSync.js';
import { notify } from '../lib/notificationService.js';

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

    return reply.send({ success: true, projectId: project.id, wpPostId });
  });

  /* ─── Pipeline event webhook from WP plugin ─── */
  app.post('/wp-pipeline-event', async (request, reply) => {
    const body = request.body || {};
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

      // Common variables for all pipeline notifications
      const nowFormatted = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const commonVars = { postTitle, projectName: project.name || '', postType, submittedBy: submittedByName || 'Team member', submittedAt: nowFormatted };

      if (eventType === 'pipeline_submitted' || eventType === 'pipeline_resubmitted') {
        const pmUserId = project.leadPmId;
        if (pmUserId) {
          const roundLabel = revisionNumber > 1 ? ` (Round ${revisionNumber})` : '';
          notify({
            slug: 'content_submitted_for_review',
            recipientIds: [pmUserId],
            variables: { ...commonVars, roundLabel },
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      } else if (eventType === 'pipeline_pm_approved') {
        // Notify submitter that PM approved
        if (submittedById) {
          notify({
            slug: 'content_pm_approved',
            recipientIds: [submittedById],
            variables: commonVars,
            actionUrl: null,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
        // Notify client users that content is ready for their review
        const clientUserIds = await getClientUserIds();
        if (clientUserIds.length > 0) {
          notify({
            slug: 'content_ready_for_client_review',
            recipientIds: clientUserIds,
            variables: commonVars,
            actionUrl: clientPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      } else if (eventType === 'pipeline_pm_changes_requested') {
        // Notify submitter/worker that PM requested changes
        if (submittedById) {
          notify({
            slug: 'content_pm_changes_requested',
            recipientIds: [submittedById],
            variables: commonVars,
            actionUrl: pmPreviewUrl,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      } else if (eventType === 'pipeline_client_approved') {
        // Notify PM and submitter/worker
        const recipients = [];
        if (project.leadPmId) recipients.push(project.leadPmId);
        if (submittedById) recipients.push(submittedById);
        if (recipients.length > 0) {
          notify({
            slug: 'content_client_approved',
            recipientIds: recipients,
            variables: commonVars,
            actionUrl: null,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      } else if (eventType === 'pipeline_client_changes_requested') {
        // Notify PM and submitter/worker
        const recipients = [];
        if (project.leadPmId) recipients.push(project.leadPmId);
        if (submittedById) recipients.push(submittedById);
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
        // Notify PM and submitter/worker
        const recipients = [];
        if (project.leadPmId) recipients.push(project.leadPmId);
        if (submittedById) recipients.push(submittedById);
        if (recipients.length > 0) {
          notify({
            slug: 'content_published',
            recipientIds: recipients,
            variables: commonVars,
            actionUrl: null,
            metadata: { contentReviewId: review.id },
          }).catch(() => {});
        }
      }
    } catch {
      // Don't fail the webhook if notification fails
    }

    return reply.send({ success: true, projectId: project.id, wpPipelineId });
  });
}
