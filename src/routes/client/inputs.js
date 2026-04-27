import { prisma } from '../../lib/prisma.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { notify } from '../../lib/notificationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_ROOT = join(__dirname, '..', '..', '..', 'uploads');

async function getClientIdsForUser(userId) {
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId },
    select: { clientId: true },
  });
  return clientUsers.map((cu) => cu.clientId);
}

export async function clientInputRoutes(app) {
  app.get(
    '/inputs/projects',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const projects = await prisma.project.findMany({
        where: { clientId: { in: clientIds } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });

      return reply.send(projects);
    }
  );

  app.post(
    '/inputs/assets',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }

      const buffer = await data.toBuffer();
      const fileName = data.filename || 'attachment';

      // Extract multipart form fields
      const folder = data.fields.folder?.value || 'general';
      const uploadNote = data.fields.uploadNote?.value || null;
      const projectId = data.fields.projectId?.value && data.fields.projectId.value.trim() !== ''
        ? data.fields.projectId.value
        : null;
      const rawClientId = data.fields.clientId?.value || null;
      const clientId = rawClientId && clientIds.includes(rawClientId)
        ? rawClientId
        : clientIds[0];

      // Create directory structure: uploads/YYYY/MM-DD/
      const now = new Date();
      const year = String(now.getFullYear());
      const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dir = join(UPLOADS_ROOT, year, monthDay);
      mkdirSync(dir, { recursive: true });

      // Save file with UUID prefix
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedName = `${randomUUID()}-${safeName}`;
      writeFileSync(join(dir, storedName), buffer);

      // Construct the accessible URL
      const baseUrl = `${request.protocol}://${request.host}`;
      const fileUrl = `${baseUrl}/uploads/${year}/${monthDay}/${storedName}`;

      const asset = await prisma.clientAsset.create({
        data: {
          clientId,
          projectId,
          folder,
          filename: fileName,
          fileUrl,
          uploadNote,
        },
      });

      // Notify PM about the uploaded asset
      try {
        const assetProject = projectId
          ? await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true } })
          : null;
        const assetClient = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { leadPmId: true, agencyName: true } });
        const assetRecipients = [assetProject?.leadPmId, assetClient?.leadPmId].filter((id) => id && id !== request.user.id);
        if (assetRecipients.length > 0) {
          notify({
            slug: 'client_asset_uploaded',
            recipientIds: assetRecipients,
            variables: { filename: fileName, clientName: assetClient?.agencyName || '' },
            actionUrl: projectId ? `/portal/pm/projects/${projectId}` : `/portal/pm`,
            metadata: { assetId: asset.id },
          }).catch(() => {});
        }
      } catch (_) {}

      // Notify other client users about the asset upload
      try {
        const otherUsers = await prisma.clientUser.findMany({
          where: { clientId, userId: { not: request.user.id } },
          select: { userId: true },
        });
        if (otherUsers.length > 0) {
          const assetClientName = (await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } }))?.agencyName || '';
          notify({
            slug: 'client_asset_uploaded_team',
            recipientIds: otherUsers.map((cu) => cu.userId),
            variables: { uploaderName: request.user.name || 'A team member', filename: fileName, clientName: assetClientName },
            actionUrl: '/portal/client/inputs',
            metadata: { assetId: asset.id },
          }).catch(() => {});
        }
        await prisma.clientActivityLog.create({
          data: { clientId, userId: request.user.id, action: 'asset_uploaded', detail: `Uploaded ${fileName}`, metadata: { assetId: asset.id, folder } },
        });
      } catch (_) {}

      return reply.status(201).send(asset);
    }
  );

  app.post(
    '/inputs/keywords',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            targetPage: { type: 'string', nullable: true },
            priority: { type: 'string' },
            notes: { type: 'string', nullable: true },
            projectId: { type: 'string', format: 'uuid', nullable: true },
            clientId: { type: 'string', format: 'uuid', nullable: true },
          },
          required: ['keyword', 'priority'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const body = request.body || {};
      const clientId = body.clientId && clientIds.includes(body.clientId)
        ? body.clientId
        : clientIds[0];

      const projectId = body.projectId && body.projectId.trim() !== ''
        ? body.projectId
        : null;

      const keyword = await prisma.keywordSuggestion.create({
        data: {
          clientId,
          projectId,
          keyword: body.keyword,
          targetPage: body.targetPage || null,
          priority: body.priority,
          notes: body.notes || null,
        },
      });

      // Notify PM about the keyword suggestion
      try {
        const kwProject = projectId
          ? await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true } })
          : null;
        const kwClient = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { leadPmId: true, agencyName: true } });
        const kwRecipients = [kwProject?.leadPmId, kwClient?.leadPmId].filter((id) => id && id !== request.user.id);
        if (kwRecipients.length > 0) {
          notify({
            slug: 'client_keyword_submitted',
            recipientIds: kwRecipients,
            variables: { keyword: body.keyword, clientName: kwClient?.agencyName || '' },
            actionUrl: `/portal/pm/keyword-suggestions`,
            metadata: { keywordSuggestionId: keyword.id },
          }).catch(() => {});
        }
      } catch (_) {}

      // Notify other client users about the keyword suggestion
      try {
        const otherUsers = await prisma.clientUser.findMany({
          where: { clientId, userId: { not: request.user.id } },
          select: { userId: true },
        });
        if (otherUsers.length > 0) {
          const kwClientName = (await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } }))?.agencyName || '';
          notify({
            slug: 'client_keyword_submitted_team',
            recipientIds: otherUsers.map((cu) => cu.userId),
            variables: { submitterName: request.user.name || 'A team member', keyword: body.keyword, clientName: kwClientName },
            actionUrl: '/portal/client/inputs',
            metadata: { keywordSuggestionId: keyword.id },
          }).catch(() => {});
        }
        await prisma.clientActivityLog.create({
          data: { clientId, userId: request.user.id, action: 'keyword_submitted', detail: `Suggested keyword "${body.keyword}"`, metadata: { keywordSuggestionId: keyword.id } },
        });
      } catch (_) {}

      return reply.status(201).send(keyword);
    }
  );

  // DELETE a keyword suggestion (only if it belongs to the client)
  app.delete(
    '/inputs/keywords/:id',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const { id } = request.params;

      const suggestion = await prisma.keywordSuggestion.findUnique({
        where: { id },
        select: { id: true, clientId: true },
      });

      if (!suggestion || !clientIds.includes(suggestion.clientId)) {
        return reply.status(404).send({ message: 'Keyword suggestion not found' });
      }

      await prisma.keywordSuggestion.delete({ where: { id } });

      return reply.send({ deleted: true });
    }
  );

  app.post(
    '/inputs/updates',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            updateType: { type: 'string' },
            details: { type: 'string' },
            projectId: { type: 'string', format: 'uuid', nullable: true },
            clientId: { type: 'string', format: 'uuid', nullable: true },
          },
          required: ['updateType', 'details'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const body = request.body || {};
      const clientId = body.clientId && clientIds.includes(body.clientId)
        ? body.clientId
        : clientIds[0];

      const projectId = body.projectId && body.projectId.trim() !== ''
        ? body.projectId
        : null;

      const update = await prisma.businessUpdate.create({
        data: {
          clientId,
          projectId,
          updateType: body.updateType,
          details: body.details,
        },
      });

      // Notify PM about the business update
      try {
        const buProject = projectId
          ? await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true } })
          : null;
        const buClient = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { leadPmId: true, agencyName: true } });
        const buRecipients = [buProject?.leadPmId, buClient?.leadPmId].filter((id) => id && id !== request.user.id);
        if (buRecipients.length > 0) {
          notify({
            slug: 'client_business_update',
            recipientIds: buRecipients,
            variables: { clientName: buClient?.agencyName || '', updateType: body.updateType },
            actionUrl: projectId ? `/portal/pm/projects/${projectId}` : `/portal/pm`,
            metadata: { businessUpdateId: update.id },
          }).catch(() => {});
        }
      } catch (_) {}

      // Notify other client users about the business update
      try {
        const otherUsers = await prisma.clientUser.findMany({
          where: { clientId, userId: { not: request.user.id } },
          select: { userId: true },
        });
        if (otherUsers.length > 0) {
          const buClientName = (await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } }))?.agencyName || '';
          notify({
            slug: 'client_update_posted_team',
            recipientIds: otherUsers.map((cu) => cu.userId),
            variables: { posterName: request.user.name || 'A team member', updateType: body.updateType, clientName: buClientName },
            actionUrl: '/portal/client/inputs',
            metadata: { businessUpdateId: update.id },
          }).catch(() => {});
        }
        await prisma.clientActivityLog.create({
          data: { clientId, userId: request.user.id, action: 'update_posted', detail: `Posted business update: ${body.updateType}`, metadata: { businessUpdateId: update.id } },
        });
      } catch (_) {}

      return reply.status(201).send(update);
    }
  );

  app.get(
    '/inputs/history',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      const [assets, keywords, updates] = await Promise.all([
        prisma.clientAsset.findMany({
          where: { clientId: { in: clientIds } },
          orderBy: { uploadedAt: 'desc' },
          take: 30,
          include: { project: { select: { id: true, name: true } } },
        }),
        prisma.keywordSuggestion.findMany({
          where: { clientId: { in: clientIds } },
          orderBy: { submittedAt: 'desc' },
          take: 30,
          include: {
            project: { select: { id: true, name: true } },
            reviewer: { select: { id: true, name: true } },
          },
        }),
        prisma.businessUpdate.findMany({
          where: { clientId: { in: clientIds } },
          orderBy: { submittedAt: 'desc' },
          take: 30,
          include: { project: { select: { id: true, name: true } } },
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
          project: a.project ? { id: a.project.id, name: a.project.name } : null,
        })),
        keywords: keywords.map((k) => ({
          id: k.id,
          keyword: k.keyword,
          targetPage: k.targetPage,
          priority: k.priority,
          status: k.status,
          submittedAt: k.submittedAt,
          reviewedAt: k.reviewedAt,
          reviewNote: k.reviewNote,
          reviewer: k.reviewer ? { id: k.reviewer.id, name: k.reviewer.name } : null,
          project: k.project ? { id: k.project.id, name: k.project.name } : null,
        })),
        updates: updates.map((u) => ({
          id: u.id,
          updateType: u.updateType,
          details: u.details,
          submittedAt: u.submittedAt,
          project: u.project ? { id: u.project.id, name: u.project.name } : null,
        })),
      });
    }
  );
}
