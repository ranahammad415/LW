import { prisma } from '../lib/prisma.js';
import { createProjectBodySchema } from '../schemas/projects.js';
import { generateChat, isAiConfigured } from '../lib/ai.js';
import { syncProjectPages } from '../lib/wpSync.js';
import { ensureProjectAccess } from '../lib/ensureProjectAccess.js';
import { notify } from '../lib/notificationService.js';

const SUGGEST_TASKS_SYSTEM = `You are a Senior Digital Strategist at a premium agency. Your job is to suggest the next high-impact tasks to keep a client campaign moving forward.

You will be given:
1. Project type (e.g. SEO_CAMPAIGN, AEO_GEO_CAMPAIGN)
2. Client/agency name
3. A list of recently completed tasks for this project

Respond with a JSON object only, no markdown or explanation. The JSON must have exactly this structure:
{
  "suggestions": [
    {
      "title": "string (concise task title)",
      "description": "string (brief context or instructions)",
      "taskType": "string (e.g. content-writing, technical-seo, meta-optimisation)",
      "priority": "MEDIUM"
    }
  ]
}

Provide exactly 3 suggestions. Use priority "MEDIUM" for all unless one is clearly urgent. taskType should be a short slug like the examples.`;

export async function projectRoutes(app) {
  app.get(
    '/',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                clientId: { type: 'string' },
                name: { type: 'string' },
                projectType: { type: 'string' },
                status: { type: 'string' },
                leadPmId: { type: 'string', nullable: true },
                client: { type: 'object' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;

      const where = {};
      if (user.role === 'OWNER') {
        // return all projects
      } else if (user.role === 'PM') {
        where.OR = [
          { leadPmId: user.id },
          { client: { leadPmId: user.id } },
          { client: { secondaryPmId: user.id } },
        ];
      } else {
        return reply.status(403).send({ message: 'Only Owner or PM can list projects' });
      }

      const projects = await prisma.project.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          client: {
            select: { id: true, agencyName: true },
          },
          leadPm: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return reply.send(projects);
    }
  );

  // Sitemap routes (must be before GET /:id so /:id/sitemap is matched correctly)
  app.get(
    '/:id/sitemap',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        response: { 200: { type: 'array', items: { type: 'object' } } },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'You do not have access to this project' });

      const nodes = await prisma.sitemapNode.findMany({
        where: { projectId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          keywords: { select: { id: true, keyword: true, status: true } },
        },
      });
      return reply.send(
        nodes.map((n) => ({
          id: n.id,
          url: n.url,
          title: n.title,
          pageType: n.pageType,
          createdAt: n.createdAt,
          keywords: n.keywords,
        }))
      );
    }
  );

  app.post(
    '/:id/sitemap/parse',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: { sitemapUrl: { type: 'string' } },
          required: ['sitemapUrl'],
        },
        response: { 200: { type: 'object', properties: { imported: { type: 'integer' } } } },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId } = request.params;
      const { sitemapUrl } = request.body || {};
      const url = typeof sitemapUrl === 'string' ? sitemapUrl.trim() : '';
      if (!url) return reply.status(400).send({ message: 'sitemapUrl is required' });

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'You do not have access to this project' });

      let xmlText;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        xmlText = await res.text();
      } catch (err) {
        request.log.error({ err }, 'Sitemap fetch failed');
        return reply.status(400).send({ message: 'Failed to fetch sitemap URL: ' + (err.message || 'Network error') });
      }

      // Extract all <loc>...</loc> URLs (standard and namespaced e.g. <sitemap:loc>)
      const locRe = /<[\w]*:?loc[^>]*>([^<]+)<\/[\w]*:?loc>/gi;
      const matches = [...xmlText.matchAll(locRe)];
      const urls = [...new Set(matches.map((m) => m[1].trim()).filter((u) => u.length > 0 && u.length <= 500))];
      if (urls.length === 0) {
        return reply.send({ imported: 0 });
      }

      const existing = await prisma.sitemapNode.findMany({
        where: { projectId },
        select: { url: true },
      });
      const existingSet = new Set(existing.map((e) => e.url));
      const toInsert = urls.filter((u) => !existingSet.has(u));
      if (toInsert.length > 0) {
        await prisma.sitemapNode.createMany({
          data: toInsert.map((u) => ({
            projectId,
            url: u,
            pageType: 'PAGE',
          })),
        });
      }

      return reply.send({ imported: toInsert.length });
    }
  );

  // ── Assets Library: all client-submitted assets, keywords, updates for a project ──
  app.get(
    '/:id/assets-library',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              assets: { type: 'array', items: { type: 'object' } },
              keywords: { type: 'array', items: { type: 'object' } },
              updates: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'You do not have access to this project' });

      const [assets, keywords, updates] = await Promise.all([
        prisma.clientAsset.findMany({
          where: { projectId: id },
          orderBy: { uploadedAt: 'desc' },
        }),
        prisma.keywordSuggestion.findMany({
          where: { projectId: id },
          orderBy: { submittedAt: 'desc' },
        }),
        prisma.businessUpdate.findMany({
          where: { projectId: id },
          orderBy: { submittedAt: 'desc' },
        }),
      ]);

      return reply.send({
        assets: assets.map((a) => ({
          id: a.id,
          folder: a.folder,
          filename: a.filename,
          fileUrl: a.fileUrl,
          uploadNote: a.uploadNote,
          uploadedAt: a.uploadedAt,
          project: { id: project.id, name: project.name },
        })),
        keywords: keywords.map((k) => ({
          id: k.id,
          keyword: k.keyword,
          targetPage: k.targetPage,
          priority: k.priority,
          status: k.status,
          notes: k.notes,
          submittedAt: k.submittedAt,
          project: { id: project.id, name: project.name },
        })),
        updates: updates.map((u) => ({
          id: u.id,
          updateType: u.updateType,
          details: u.details,
          submittedAt: u.submittedAt,
          project: { id: project.id, name: project.name },
        })),
      });
    }
  );

  app.get(
    '/:id',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              clientId: { type: 'string' },
              name: { type: 'string' },
              projectType: { type: 'string' },
              status: { type: 'string' },
              leadPmId: { type: 'string', nullable: true },
              client: { type: 'object' },
              leadPm: { type: 'object', nullable: true },
              clientAssets: { type: 'array' },
              keywordSuggestions: { type: 'array' },
              businessUpdates: { type: 'array' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: { select: { id: true, agencyName: true } },
          leadPm: { select: { id: true, name: true, email: true } },
          clientAssets: true,
          keywordSuggestions: true,
          businessUpdates: true,
          tasks: {
            where: { parentTaskId: null },
            orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
            include: {
              assignees: { select: { id: true, name: true, email: true, avatarUrl: true } },
              dependsOnTasks: { select: { id: true, status: true, title: true } },
              wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
              deliverables: {
                orderBy: { version: 'desc' },
                include: {
                  uploadedBy: { select: { id: true, name: true } },
                },
              },
              subTasks: {
                orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
                include: {
                  assignees: { select: { id: true, name: true, email: true, avatarUrl: true } },
                  dependsOnTasks: { select: { id: true, status: true, title: true } },
                  wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
                  deliverables: {
                    orderBy: { version: 'desc' },
                    include: {
                      uploadedBy: { select: { id: true, name: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const sanitizeProject = (p) => ({
        ...p,
        wpApiKey: p.wpApiKey != null ? '[REDACTED]' : null,
      });

      if (user.role === 'OWNER') {
        return reply.send(sanitizeProject(project));
      }
      if (user.role === 'PM') {
        if (project.leadPmId !== user.id) {
          const client = await prisma.clientAccount.findUnique({
            where: { id: project.clientId },
            select: { leadPmId: true, secondaryPmId: true },
          });
          if (client?.leadPmId !== user.id && client?.secondaryPmId !== user.id) {
            return reply.status(403).send({ message: 'You do not have access to this project' });
          }
        }
        return reply.send(sanitizeProject(project));
      }
      if (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') {
        const hasTask = project.tasks.some((t) => t.assignees?.some((a) => a.id === user.id));
        if (!hasTask) {
          return reply.status(403).send({ message: 'You do not have access to this project' });
        }
        return reply.send(sanitizeProject(project));
      }

      return reply.status(403).send({ message: 'Forbidden' });
    }
  );

  app.post(
    '/',
    {
      onRequest: [app.verifyJwt],
      schema: {
        body: {
          type: 'object',
          properties: {
            clientId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            projectType: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['clientId', 'name', 'projectType'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              clientId: { type: 'string' },
              name: { type: 'string' },
              projectType: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      if (user.role !== 'OWNER' && user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can create projects' });
      }

      const parsed = createProjectBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const { clientId, name, projectType, status } = parsed.data;

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
      });
      if (!client) {
        return reply.status(400).send({ message: 'Client not found' });
      }

      if (user.role === 'PM') {
        const isAssigned =
          client.leadPmId === user.id || client.secondaryPmId === user.id;
        if (!isAssigned) {
          return reply.status(403).send({ message: 'You are not assigned to this client' });
        }
      }

      const leadPmId = user.role === 'PM' ? user.id : undefined;
      const project = await prisma.project.create({
        data: {
          clientId,
          name,
          projectType,
          status: status ?? 'SETUP',
          leadPmId,
        },
      });

      // Notify assigned PM about new project
      const projectRecipients = [project.leadPmId].filter((id) => id && id !== user.id);
      if (projectRecipients.length > 0) {
        notify({
          slug: 'project_created',
          recipientIds: projectRecipients,
          variables: { projectName: name, clientName: client.agencyName || '', assignedBy: user.name || '' },
          actionUrl: `/portal/pm/projects/${project.id}`,
          metadata: { projectId: project.id },
        }).catch(() => {});
      }

      return reply.status(201).send(project);
    }
  );

  app.patch(
    '/:id',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            wpUrl: { type: 'string', nullable: true },
            wpApiKey: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              wpUrl: { type: 'string', nullable: true },
              wpApiKey: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      if (user.role !== 'OWNER' && user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can update project WordPress settings' });
      }

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const body = request.body || {};
      const data = {};
      if (body.wpUrl !== undefined) {
        data.wpUrl = body.wpUrl === null || body.wpUrl === '' ? null : String(body.wpUrl).trim().slice(0, 500);
      }
      if (body.wpApiKey !== undefined) {
        data.wpApiKey = body.wpApiKey === null || body.wpApiKey === '' ? null : String(body.wpApiKey).trim().slice(0, 255);
      }
      if (Object.keys(data).length === 0) {
        return reply.send({
          id: project.id,
          wpUrl: project.wpUrl,
          wpApiKey: project.wpApiKey != null ? '[REDACTED]' : null,
        });
      }

      const updated = await prisma.project.update({
        where: { id },
        data,
      });

      if (updated.wpUrl && updated.wpApiKey) {
        syncProjectPages(id).catch((err) => {
          app.log.error({ err, projectId: id }, 'Background WP page sync failed');
        });
      }

      const sentWpApiKey =
        data.wpApiKey !== undefined && updated.wpApiKey != null ? updated.wpApiKey : undefined;
      return reply.send({
        id: updated.id,
        wpUrl: updated.wpUrl,
        wpApiKey: sentWpApiKey !== undefined ? sentWpApiKey : (updated.wpApiKey != null ? '[REDACTED]' : null),
      });
    }
  );

  // ── WP Pages: manual sync ──
  app.post(
    '/:id/wp-pages/sync',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      if (user.role !== 'OWNER' && user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can trigger sync' });
      }
      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });
      if (!project.wpUrl || !project.wpApiKey) {
        return reply.status(400).send({ message: 'WP connection not configured' });
      }
      const stats = await syncProjectPages(id);
      return reply.send(stats);
    }
  );

  // ── WP Pages: list stored pages ──
  app.get(
    '/:id/wp-pages',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const pages = await prisma.wpPage.findMany({
        where: { projectId: id },
        include: {
          task: { select: { id: true, title: true } },
          _count: { select: { snapshots: true } },
          snapshots: {
            orderBy: { syncedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              syncedAt: true,
              title: true,
              status: true,
              contentHash: true,
            },
          },
        },
        orderBy: { modifiedAt: 'desc' },
      });



      return reply.send(
        pages.map((p) => ({
          id: p.id,
          wpPostId: p.wpPostId,
          title: p.title,
          slug: p.slug,
          status: p.status,
          postType: p.postType,
          url: p.url,
          template: p.template,
          seoTitle: p.seoTitle,
          seoDescription: p.seoDescription,
          contentHash: p.contentHash,
          taskId: p.taskId,
          taskTitle: p.task?.title ?? null,
          modifiedAt: p.modifiedAt,
          syncedAt: p.syncedAt,
          createdAt: p.createdAt,
          snapshotsCount: p._count.snapshots,
          latestHistory: (() => {
            const s = p.snapshots?.[0];
            if (!s) return null;
            return {
              id: s.id,
              syncedAt: s.syncedAt.toISOString(),
              eventType: 'updated',
              aiSummary: null,
              wpUserName: null,
              ipAddress: null,
            };
          })(),
        }))
      );
    }
  );

  // ── WP Pages: per-page timeline ──
  app.get(
    '/:id/wp-pages/:wpPostId/timeline',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id, wpPostId } = request.params;
      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const page = await prisma.wpPage.findFirst({
        where: { projectId: id, wpPostId: Number(wpPostId) },
      });
      if (!page) return reply.status(404).send({ message: 'Page not found' });

      let wpTimeline = [];
      if (project.wpUrl && project.wpApiKey) {
        try {
          const url = `${project.wpUrl.replace(/\/$/, '')}/wp-json/lwa/v1/pages/${wpPostId}/timeline`;
          const res = await fetch(url, {
            headers: { 'X-LWA-API-Key': project.wpApiKey },
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) { wpTimeline = await res.json(); }
        } catch { /* WP might be unreachable */ }
      }

      const snapshots = await prisma.wpPageSnapshot.findMany({
        where: { wpPageId: page.id },
        orderBy: { syncedAt: 'desc' },
      });
      const snapshotEntries = snapshots.map((s) => ({
        type: 'snapshot',
        actionType: s.eventType ?? 'updated',
        snapshotId: s.id,
        title: s.title,
        contentHash: s.contentHash,
        status: s.status,
        aiSummary: s.aiSummary ?? null,
        contentExcerpt: s.contentExcerpt ?? null,
        memberId: s.wpUserId ?? null,
        memberName: s.wpUserName ?? null,
        ipAddress: s.ipAddress ?? null,
        userAgent: s.userAgent ?? null,
        isElementor: s.isElementor ?? null,
        createdAt: s.syncedAt.toISOString(),
      }));

      const combined = [...wpTimeline, ...snapshotEntries];
      combined.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      return reply.send(combined);
    }
  );

  // ── WP Pages: list snapshots for a page ──
  app.get(
    '/:id/wp-pages/:wpPostId/snapshots',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id, wpPostId } = request.params;
      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const page = await prisma.wpPage.findFirst({
        where: { projectId: id, wpPostId: Number(wpPostId) },
      });
      if (!page) return reply.status(404).send({ message: 'Page not found' });

      const snapshots = await prisma.wpPageSnapshot.findMany({
        where: { wpPageId: page.id },
        orderBy: { syncedAt: 'desc' },
      });
      return reply.send(snapshots);
    }
  );

  // ── WP Pages: snapshot diff ──
  app.get(
    '/:id/wp-pages/snapshots/diff',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const { a: idA, b: idB } = request.query;
      if (!idA || !idB) return reply.status(400).send({ message: 'Provide ?a=snapshotId&b=snapshotId' });

      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const [snapA, snapB] = await Promise.all([
        prisma.wpPageSnapshot.findUnique({ where: { id: idA }, include: { wpPage: { select: { projectId: true } } } }),
        prisma.wpPageSnapshot.findUnique({ where: { id: idB }, include: { wpPage: { select: { projectId: true } } } }),
      ]);

      if (!snapA || !snapB || snapA.wpPage.projectId !== id || snapB.wpPage.projectId !== id) {
        return reply.status(404).send({ message: 'Snapshot not found or access denied' });
      }

      return reply.send({ before: snapA, after: snapB });
    }
  );

  app.patch(
    '/:id/wp-pages/:wpPageId/link',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id, wpPageId } = request.params;
      const { taskId } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const page = await prisma.wpPage.findFirst({ where: { id: wpPageId, projectId: id } });
      if (!page) return reply.status(404).send({ message: 'WP page not found' });

      let linkedTaskId = null;
      if (taskId) {
        const task = await prisma.task.findFirst({
          where: { id: String(taskId), projectId: id },
          select: { id: true },
        });
        if (!task) return reply.status(400).send({ message: 'Task not found in this project' });
        linkedTaskId = task.id;
      }

      const updated = await prisma.wpPage.update({
        where: { id: page.id },
        data: { taskId: linkedTaskId },
        select: { id: true, taskId: true },
      });
      let taskTitle = null;
      if (updated.taskId) {
        const t = await prisma.task.findUnique({
          where: { id: updated.taskId },
          select: { title: true },
        });
        taskTitle = t?.title ?? null;
      }
      return reply.send({ id: updated.id, taskId: updated.taskId, taskTitle });
    }
  );
  app.post(
    '/:id/suggest-tasks',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            context: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              suggestions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    taskType: { type: 'string' },
                    priority: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const pmContext = request.body?.context ? String(request.body.context).trim().slice(0, 2000) : '';

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: { select: { id: true, agencyName: true } },
          tasks: {
            where: { status: 'COMPLETED' },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { title: true, taskType: true, description: true },
          },
        },
      });

      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'AI suggestions are not configured. Set ANTHROPIC_API_KEY in your .env file.' });
      }

      const completedSummary = project.tasks.length
        ? project.tasks.map((t) => `- ${t.title} (${t.taskType})`).join('\n')
        : 'No completed tasks yet.';

      const contextBlock = pmContext ? `\n\nPM's brief / requirements:\n${pmContext}` : '';
      const userMessage = `Project type: ${project.projectType}\nClient: ${project.client.agencyName}\n\nRecently completed tasks:\n${completedSummary}${contextBlock}\n\nSuggest 3 high-impact next steps that align with the PM's brief above.`;

      try {
        const { text, parsed } = await generateChat({
          system: SUGGEST_TASKS_SYSTEM,
          user: userMessage,
          json: true,
          maxTokens: 1024,
        });

        if (!text) {
          return reply.status(502).send({ message: 'Empty AI response' });
        }

        const parsedJson = parsed || (() => { try { return JSON.parse(text); } catch { return null; } })();
        const suggestions = Array.isArray(parsedJson?.suggestions) ? parsedJson.suggestions : [];
        const normalized = suggestions.slice(0, 3).map((s) => ({
          title: String(s?.title ?? '').slice(0, 500),
          description: String(s?.description ?? '').slice(0, 10000),
          taskType: String(s?.taskType ?? 'content-writing').slice(0, 100),
          priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(s?.priority) ? s.priority : 'MEDIUM',
        }));

        return reply.send({ suggestions: normalized });
      } catch (err) {
        request.log.error({ err }, 'AI suggest-tasks failed');
        return reply.status(502).send({
          message: err.message || 'AI suggestions temporarily unavailable',
        });
      }
    }
  );

  app.post(
    '/:id/tasks/bulk',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  taskType: { type: 'string' },
                  priority: { type: 'string' },
                },
                required: ['title', 'taskType'],
              },
            },
          },
          required: ['tasks'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              created: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId } = request.params;
      const { tasks } = request.body || {};

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return reply.status(400).send({ message: 'tasks must be a non-empty array' });
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });

      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const validPriority = (p) =>
        ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(p) ? p : 'MEDIUM';

      const created = await prisma.$transaction(
        tasks.slice(0, 20).map((t) =>
          prisma.task.create({
            data: {
              projectId,
              title: String(t.title ?? '').slice(0, 500),
              description: t.description ? String(t.description).slice(0, 10000) : null,
              taskType: String(t.taskType ?? 'content-writing').slice(0, 100),
              priority: validPriority(t.priority),
              status: 'TO_DO',
              createdById: user.id,
            },
          })
        )
      );

      return reply.status(201).send({ created: created.length });
    }
  );

  // --- Client Keyword Suggestions (project-scoped) ---
  app.get(
    '/:id/keyword-suggestions',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const statusFilter = (request.query?.status || 'ALL').toUpperCase();

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, request.user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const where = { projectId: id };
      if (statusFilter !== 'ALL') where.status = statusFilter;

      const suggestions = await prisma.keywordSuggestion.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        include: {
          client: { select: { id: true, agencyName: true } },
          reviewer: { select: { id: true, name: true } },
        },
      });

      return reply.send(
        suggestions.map((s) => ({
          id: s.id,
          keyword: s.keyword,
          targetPage: s.targetPage,
          priority: s.priority,
          notes: s.notes,
          status: s.status,
          submittedAt: s.submittedAt,
          reviewedAt: s.reviewedAt,
          reviewNote: s.reviewNote,
          client: s.client ? { id: s.client.id, name: s.client.agencyName } : null,
          reviewer: s.reviewer ? { id: s.reviewer.id, name: s.reviewer.name } : null,
        }))
      );
    }
  );

  // --- SEO Keywords (project access: OWNER, PM lead/secondary, or assignee) ---
  app.get(
    '/:id/keywords',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                projectId: { type: 'string' },
                keyword: { type: 'string' },
                volume: { type: 'integer', nullable: true },
                currentRank: { type: 'integer', nullable: true },
                targetUrl: { type: 'string', nullable: true },
                status: { type: 'string', nullable: true },
                sitemapNodeId: { type: 'string', nullable: true },
                clientNote: { type: 'string', nullable: true },
                suggestedKeyword: { type: 'string', nullable: true },
                suggestedTargetUrl: { type: 'string', nullable: true },
                suggestedNotes: { type: 'string', nullable: true },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const keywords = await prisma.keywordTrack.findMany({
        where: { projectId: id },
        orderBy: { updatedAt: 'desc' },
      });
      return reply.send(keywords);
    }
  );

  app.post(
    '/:id/keywords',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            volume: { type: 'integer', nullable: true },
            currentRank: { type: 'integer', nullable: true },
            targetUrl: { type: 'string', nullable: true },
          },
          required: ['keyword'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              keyword: { type: 'string' },
              volume: { type: 'integer', nullable: true },
              currentRank: { type: 'integer', nullable: true },
              targetUrl: { type: 'string', nullable: true },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId } = request.params;
      const { keyword, volume, currentRank, targetUrl } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const created = await prisma.keywordTrack.create({
        data: {
          projectId,
          keyword: String(keyword ?? '').slice(0, 500),
          volume: typeof volume === 'number' ? volume : null,
          currentRank: typeof currentRank === 'number' ? currentRank : null,
          targetUrl: targetUrl ? String(targetUrl).slice(0, 500) : null,
        },
      });
      return reply.status(201).send(created);
    }
  );

  // --- PM Keyword Inline Update (volume, currentRank, targetUrl) ---
  app.patch(
    '/:id/keywords/:keywordId',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const { id, keywordId } = request.params;
      const { volume, currentRank, targetUrl } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, request.user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id },
      });
      if (!keyword) return reply.status(404).send({ message: 'Keyword not found' });

      const data = {};
      if (volume !== undefined) data.volume = volume ? parseInt(volume) : null;
      if (currentRank !== undefined) data.currentRank = currentRank ? parseInt(currentRank) : null;
      if (targetUrl !== undefined) data.targetUrl = targetUrl || null;

      const updated = await prisma.keywordTrack.update({
        where: { id: keywordId },
        data,
      });

      return updated;
    }
  );

  // --- PM Keyword Edit Accept/Reject & Comments ---

  app.patch(
    '/:id/keywords/:keywordId/accept-edit',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const { id, keywordId } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, request.user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id, status: 'EDIT_SUGGESTED' },
      });
      if (!keyword) return reply.status(404).send({ message: 'No pending edit suggestion found' });

      const updated = await prisma.keywordTrack.update({
        where: { id: keywordId },
        data: {
          keyword: keyword.suggestedKeyword || keyword.keyword,
          targetUrl: keyword.suggestedTargetUrl || keyword.targetUrl,
          status: 'PROPOSED',
          suggestedKeyword: null,
          suggestedTargetUrl: null,
          suggestedNotes: null,
        },
      });

      return updated;
    }
  );

  app.patch(
    '/:id/keywords/:keywordId/reject-edit',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const { id, keywordId } = request.params;
      const { comment } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, request.user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id, status: 'EDIT_SUGGESTED' },
      });
      if (!keyword) return reply.status(404).send({ message: 'No pending edit suggestion found' });

      const updated = await prisma.keywordTrack.update({
        where: { id: keywordId },
        data: {
          status: 'PROPOSED',
          suggestedKeyword: null,
          suggestedTargetUrl: null,
          suggestedNotes: null,
        },
      });

      if (comment && comment.trim()) {
        await prisma.keywordComment.create({
          data: {
            keywordTrackId: keywordId,
            userId: request.user.id,
            message: comment.trim(),
          },
        });
      }

      return updated;
    }
  );

  app.get(
    '/:id/keywords/:keywordId/comments',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const { id, keywordId } = request.params;

      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id },
      });
      if (!keyword) return reply.status(404).send({ message: 'Keyword not found' });

      const comments = await prisma.keywordComment.findMany({
        where: { keywordTrackId: keywordId },
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      });

      return comments;
    }
  );

  app.post(
    '/:id/keywords/:keywordId/comments',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const { id, keywordId } = request.params;
      const { message } = request.body || {};

      if (!message || !message.trim()) {
        return reply.status(400).send({ message: 'Message is required' });
      }

      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id },
      });
      if (!keyword) return reply.status(404).send({ message: 'Keyword not found' });

      const comment = await prisma.keywordComment.create({
        data: {
          keywordTrackId: keywordId,
          userId: request.user.id,
          message: message.trim(),
        },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      });

      return reply.status(201).send(comment);
    }
  );

  // --- AEO Prompt Logs (project member: OWNER, PM, TEAM_MEMBER, CONTRACTOR) ---
  app.get(
    '/:id/prompts',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                projectId: { type: 'string' },
                platform: { type: 'string' },
                promptQuery: { type: 'string' },
                llmResponse: { type: 'string' },
                notes: { type: 'string', nullable: true },
                keyword: { type: 'string', nullable: true },
                targetUrl: { type: 'string', nullable: true },
                cited: { type: 'boolean', nullable: true },
                competitorsCited: { nullable: true },
                sentimentScore: { type: 'string', nullable: true },
                linkedWpPageId: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const prompts = await prisma.promptLog.findMany({
        where: { projectId: id },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send(prompts);
    }
  );

  // Prompt log usage for plan limit (used across client's projects)
  app.get(
    '/:id/prompts/usage',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              used: { type: 'integer' },
              limit: { type: 'integer', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { secondaryPmId: true, packageId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const used = await prisma.promptLog.count({
        where: { project: { clientId: project.clientId } },
      });
      let limit = null;
      if (project.client?.packageId) {
        const pkg = await prisma.package.findUnique({
          where: { id: project.client.packageId },
          select: { llmTestsLimit: true },
        });
        limit = pkg?.llmTestsLimit ?? null;
      }
      return reply.send({ used, limit });
    }
  );

  app.post(
    '/:id/prompts',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            promptQuery: { type: 'string' },
            llmResponse: { type: 'string' },
            notes: { type: 'string', nullable: true },
            keyword: { type: 'string', nullable: true },
            targetUrl: { type: 'string', nullable: true },
            cited: { type: 'boolean', nullable: true },
            competitorsCited: { nullable: true },
            sentimentScore: { type: 'string', nullable: true },
            linkedWpPageId: { type: 'string', nullable: true },
          },
          required: ['platform', 'promptQuery', 'llmResponse'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              platform: { type: 'string' },
              promptQuery: { type: 'string' },
              llmResponse: { type: 'string' },
              notes: { type: 'string', nullable: true },
              keyword: { type: 'string', nullable: true },
              targetUrl: { type: 'string', nullable: true },
              cited: { type: 'boolean', nullable: true },
              competitorsCited: { nullable: true },
              sentimentScore: { type: 'string', nullable: true },
              linkedWpPageId: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId } = request.params;
      const { platform, promptQuery, llmResponse, notes, keyword, targetUrl, cited, competitorsCited, sentimentScore, linkedWpPageId } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { secondaryPmId: true, packageId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      if (project.client?.packageId) {
        const pkg = await prisma.package.findUnique({
          where: { id: project.client.packageId },
          select: { llmTestsLimit: true },
        });
        const limit = pkg?.llmTestsLimit;
        if (limit != null && limit > 0) {
          const used = await prisma.promptLog.count({
            where: { project: { clientId: project.clientId } },
          });
          if (used >= limit) {
            return reply.status(403).send({
              message: 'Prompt log limit reached for this plan. Upgrade or contact support.',
            });
          }
        }
      }

      const created = await prisma.promptLog.create({
        data: {
          projectId,
          platform: String(platform ?? '').slice(0, 100),
          promptQuery: String(promptQuery ?? ''),
          llmResponse: String(llmResponse ?? ''),
          notes: notes ? String(notes) : null,
          keyword: keyword != null && keyword !== '' ? String(keyword).slice(0, 500) : null,
          targetUrl: targetUrl != null && targetUrl !== '' ? String(targetUrl).slice(0, 500) : null,
          cited: cited === true || cited === false ? cited : null,
          competitorsCited: competitorsCited ?? undefined,
          sentimentScore: sentimentScore ? String(sentimentScore).slice(0, 20) : null,
          linkedWpPageId: linkedWpPageId || null,
        },
      });
      return reply.status(201).send(created);
    }
  );

  app.patch(
    '/:id/prompts/:logId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            logId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'logId'],
        },
        body: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            promptQuery: { type: 'string' },
            llmResponse: { type: 'string' },
            notes: { type: 'string', nullable: true },
            keyword: { type: 'string', nullable: true },
            targetUrl: { type: 'string', nullable: true },
            cited: { type: 'boolean', nullable: true },
            competitorsCited: { nullable: true },
            sentimentScore: { type: 'string', nullable: true },
            linkedWpPageId: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              platform: { type: 'string' },
              promptQuery: { type: 'string' },
              llmResponse: { type: 'string' },
              notes: { type: 'string', nullable: true },
              keyword: { type: 'string', nullable: true },
              targetUrl: { type: 'string', nullable: true },
              cited: { type: 'boolean', nullable: true },
              competitorsCited: { nullable: true },
              sentimentScore: { type: 'string', nullable: true },
              linkedWpPageId: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId, logId } = request.params;
      const body = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const existing = await prisma.promptLog.findFirst({
        where: { id: logId, projectId },
      });
      if (!existing) {
        return reply.status(404).send({ message: 'Prompt log not found' });
      }

      const data = {};
      if (body.platform !== undefined) data.platform = String(body.platform).slice(0, 100);
      if (body.promptQuery !== undefined) data.promptQuery = String(body.promptQuery);
      if (body.llmResponse !== undefined) data.llmResponse = String(body.llmResponse);
      if (body.notes !== undefined) data.notes = body.notes == null || body.notes === '' ? null : String(body.notes);
      if (body.keyword !== undefined) data.keyword = body.keyword == null || body.keyword === '' ? null : String(body.keyword).slice(0, 500);
      if (body.targetUrl !== undefined) data.targetUrl = body.targetUrl == null || body.targetUrl === '' ? null : String(body.targetUrl).slice(0, 500);
      if (body.cited !== undefined) data.cited = body.cited === true || body.cited === false ? body.cited : null;
      if (body.competitorsCited !== undefined) data.competitorsCited = body.competitorsCited ?? undefined;
      if (body.sentimentScore !== undefined) data.sentimentScore = body.sentimentScore ? String(body.sentimentScore).slice(0, 20) : null;
      if (body.linkedWpPageId !== undefined) data.linkedWpPageId = body.linkedWpPageId || null;

      const updated = await prisma.promptLog.update({
        where: { id: logId },
        data,
      });
      return reply.send(updated);
    }
  );

  app.delete(
    '/:id/prompts/:logId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            logId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'logId'],
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId, logId } = request.params;

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const existing = await prisma.promptLog.findFirst({
        where: { id: logId, projectId },
      });
      if (!existing) {
        return reply.status(404).send({ message: 'Prompt log not found' });
      }

      await prisma.promptLog.delete({ where: { id: logId } });
      return reply.status(204).send();
    }
  );

  // --- AEO Automated Runs for a prompt log ---
  app.get(
    '/:id/prompts/:logId/runs',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            logId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'logId'],
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                promptLogId: { type: 'string' },
                runDate: { type: 'string' },
                wasCited: { type: 'boolean', nullable: true },
                responseSnippet: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: projectId, logId } = request.params;

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { tasks: { select: { assignees: { select: { id: true } } } }, client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });

      const log = await prisma.promptLog.findFirst({ where: { id: logId, projectId } });
      if (!log) return reply.status(404).send({ message: 'Prompt log not found' });

      const runs = await prisma.aeoAutomatedRun.findMany({
        where: { promptLogId: logId },
        orderBy: { runDate: 'desc' },
      });
      return reply.send(runs);
    }
  );

  // ── Onboarding / Intake data for a project's client ──
  app.get(
    '/:id/intake',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStatus: { type: 'string', nullable: true },
              onboardingStep: { type: 'integer' },
              intakeSubmissions: { type: 'array', items: { type: 'object' } },
              contractRecords: { type: 'array', items: { type: 'object' } },
              onboardingChecklist: { type: 'object', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: { select: { id: true, secondaryPmId: true } },
          tasks: { select: { assignees: { select: { id: true } } } },
        },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const clientId = project.clientId;

      const clientAccount = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { onboardingStatus: true, onboardingStep: true },
      });

      const intakeSubmissions = await prisma.intakeSubmission.findMany({
        where: { clientId },
        orderBy: { submittedAt: 'desc' },
        include: { client: false },
      });

      const contractRecords = await prisma.contractRecord.findMany({
        where: { clientId },
        orderBy: { signedAt: 'desc' },
      });

      const onboardingChecklist = await prisma.onboardingChecklist.findFirst({
        where: { clientId, projectId: null },
      });

      return reply.send({
        onboardingStatus: clientAccount?.onboardingStatus ?? null,
        onboardingStep: clientAccount?.onboardingStep ?? 1,
        intakeSubmissions: intakeSubmissions.map((s) => ({
          id: s.id,
          data: s.data,
          submittedAt: s.submittedAt.toISOString(),
        })),
        contractRecords: contractRecords.map((c) => ({
          id: c.id,
          signerName: c.signerName,
          signerEmail: c.signerEmail,
          signedAt: c.signedAt.toISOString(),
        })),
        onboardingChecklist: onboardingChecklist
          ? {
              logoUploaded: onboardingChecklist.logoUploaded,
              brandGuidelinesUploaded: onboardingChecklist.brandGuidelinesUploaded,
              brandColorsAdded: onboardingChecklist.brandColorsAdded,
              brandColors: onboardingChecklist.brandColors ?? null,
              contentAssetsUploaded: onboardingChecklist.contentAssetsUploaded,
              notificationPrefsConfirmed: onboardingChecklist.notificationPrefsConfirmed,
              notifEmail: onboardingChecklist.notifEmail,
              notifWhatsapp: onboardingChecklist.notifWhatsapp,
              notifInApp: onboardingChecklist.notifInApp,
              profilePhotoAdded: onboardingChecklist.profilePhotoAdded,
              profilePhotoUrl: onboardingChecklist.profilePhotoUrl ?? null,
              completedAt: onboardingChecklist.completedAt?.toISOString() ?? null,
            }
          : null,
      });
    }
  );

  // ── Update intake data + checklist (Owner only) ──
  app.patch(
    '/:id/intake',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            intakeData: { type: 'object', additionalProperties: true },
            checklist: {
              type: 'object',
              properties: {
                logoUploaded: { type: 'boolean' },
                brandGuidelinesUploaded: { type: 'boolean' },
                brandColorsAdded: { type: 'boolean' },
                brandColors: { type: 'string', nullable: true },
                contentAssetsUploaded: { type: 'boolean' },
                notificationPrefsConfirmed: { type: 'boolean' },
                notifEmail: { type: 'boolean' },
                notifWhatsapp: { type: 'boolean' },
                notifInApp: { type: 'boolean' },
                profilePhotoAdded: { type: 'boolean' },
                profilePhotoUrl: { type: 'string', nullable: true },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { intakeData, checklist } = request.body || {};

      const project = await prisma.project.findUnique({
        where: { id },
        select: { clientId: true },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const clientId = project.clientId;
      const ops = [];

      if (intakeData && typeof intakeData === 'object') {
        // Find latest submission and update its data, or create a new one
        const latest = await prisma.intakeSubmission.findFirst({
          where: { clientId },
          orderBy: { submittedAt: 'desc' },
        });
        if (latest) {
          ops.push(
            prisma.intakeSubmission.update({
              where: { id: latest.id },
              data: { data: intakeData },
            })
          );
        } else {
          ops.push(
            prisma.intakeSubmission.create({
              data: {
                clientId,
                submittedById: request.user.id,
                data: intakeData,
              },
            })
          );
        }
      }

      if (checklist && typeof checklist === 'object') {
        const checklistData = {
          logoUploaded: Boolean(checklist.logoUploaded),
          brandGuidelinesUploaded: Boolean(checklist.brandGuidelinesUploaded),
          brandColorsAdded: Boolean(checklist.brandColorsAdded),
          ...(checklist.brandColors !== undefined ? { brandColors: checklist.brandColors ? String(checklist.brandColors).slice(0, 1000) : null } : {}),
          contentAssetsUploaded: Boolean(checklist.contentAssetsUploaded),
          notificationPrefsConfirmed: Boolean(checklist.notificationPrefsConfirmed),
          ...(checklist.notifEmail !== undefined ? { notifEmail: Boolean(checklist.notifEmail) } : {}),
          ...(checklist.notifWhatsapp !== undefined ? { notifWhatsapp: Boolean(checklist.notifWhatsapp) } : {}),
          ...(checklist.notifInApp !== undefined ? { notifInApp: Boolean(checklist.notifInApp) } : {}),
          profilePhotoAdded: Boolean(checklist.profilePhotoAdded),
          ...(checklist.profilePhotoUrl !== undefined ? { profilePhotoUrl: checklist.profilePhotoUrl ? String(checklist.profilePhotoUrl).slice(0, 500) : null } : {}),
        };
        ops.push(
          prisma.onboardingChecklist.upsert({
            where: { clientId },
            create: { clientId, ...checklistData },
            update: checklistData,
          })
        );
      }

      if (ops.length > 0) {
        await prisma.$transaction(ops);
      }

      return reply.send({ success: true });
    }
  );
}



