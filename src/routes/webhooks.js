import { prisma } from '../lib/prisma.js';
import { maybeGenerateSummary, autoSyncSitemap } from '../lib/wpSync.js';
import { notify } from '../lib/notificationService.js';
import { publish as publishRealtime } from '../lib/realtimeBus.js';
import { reconcileProjectMapsSafe } from '../lib/contentMapSync.js';
import { isPipelineTombstoned } from '../lib/pipelineReviewGuard.js';
import { applyReviewEvent } from '../lib/reviewEvents.js';
import { normalizePipelineWebhook } from '../lib/siteAdapters/wordpress.js';

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
  // Auth (apiKey), tombstones and the stale client-rewind guard stay WP-specific;
  // the upsert, event row, notifications, realtime and content-map mirror live in
  // lib/reviewEvents.js (shared with the EmDash bridge, routes/webhooks/emdash.js).
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

    if (await isPipelineTombstoned(project.id, wpPipelineId)) {
      return reply.send({ success: true, skipped: 'tombstoned' });
    }

    const event = normalizePipelineWebhook(body);
    const result = await applyReviewEvent({ project, event, log: request.log });
    if (result.skipped) {
      return reply.send({ success: true, skipped: result.skipped });
    }
    if (result.testResponse) {
      return reply.send(result.testResponse);
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
