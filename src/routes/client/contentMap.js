/**
 * Client Content Map routes — read visible maps, comments, node/map decisions.
 * Registered at /api/client
 */
import { prisma } from '../../lib/prisma.js';
import {
  getMapWithTree,
  logEvent,
  publishContentMapUpdate,
  notifyContentMap,
  resolveContentMapRecipients,
} from '../../lib/contentMapService.js';

async function assertClientProjectAccess(request, reply, projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, clientId: true },
  });
  if (!project) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }

  // OWNER scoped as client uses clientAccountIds from requireClient
  const clientIds = request.clientAccountIds || [];
  if (!clientIds.includes(project.clientId)) {
    // Fallback: direct ClientUser link check
    const link = await prisma.clientUser.findFirst({
      where: { userId: request.user.id, clientId: project.clientId },
      select: { id: true },
    });
    if (!link && request.user.role !== 'OWNER') {
      reply.status(403).send({ message: 'No access to this project' });
      return null;
    }
  }
  return project;
}

function formatComment(c) {
  return {
    id: c.id,
    mapId: c.mapId,
    nodeId: c.nodeId,
    content: c.content,
    parentId: c.parentId,
    resolvedAt: c.resolvedAt,
    resolvedById: c.resolvedById,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    user: c.user
      ? { id: c.user.id, name: c.user.name, role: c.user.role }
      : null,
  };
}

export async function clientContentMapRoutes(app) {
  // GET /projects/:projectId/content-map — visible map(s) for client
  app.get(
    '/projects/:projectId/content-map',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const maps = await prisma.contentMap.findMany({
          where: { projectId: project.id, clientVisible: true },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            name: true,
            status: true,
            clientDecision: true,
            clientDecisionAt: true,
            updatedAt: true,
            createdAt: true,
          },
        });

        if (!maps.length) {
          return reply.send({ map: null, items: [] });
        }

        // Prefer IN_REVIEW, else most recently updated
        const preferred =
          maps.find((m) => m.status === 'IN_REVIEW') ||
          maps.find((m) => m.status === 'APPROVED') ||
          maps[0];

        const full = await getMapWithTree(preferred.id);
        return reply.send({ ...full, items: maps });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load content map' });
      }
    }
  );

  // GET /projects/:projectId/content-map/:mapId — specific visible map
  app.get(
    '/projects/:projectId/content-map/:mapId',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: {
            id: request.params.mapId,
            projectId: project.id,
            clientVisible: true,
          },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const full = await getMapWithTree(map.id);
        return reply.send(full);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load content map' });
      }
    }
  );

  // Comments
  app.get(
    '/projects/:projectId/content-map/:mapId/comments',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const nodeId = request.query?.nodeId;
        const where = { mapId: map.id };
        if (nodeId === 'null' || nodeId === '') where.nodeId = null;
        else if (nodeId) where.nodeId = String(nodeId);

        const comments = await prisma.contentMapComment.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, role: true } } },
        });
        return reply.send({ items: comments.map(formatComment) });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load comments' });
      }
    }
  );

  app.post(
    '/projects/:projectId/content-map/:mapId/comments',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const content = String(request.body?.content || '').trim();
        if (!content) return reply.status(400).send({ message: 'Comment content is required' });

        const nodeId = request.body?.nodeId || null;
        if (nodeId) {
          const node = await prisma.contentMapNode.findFirst({
            where: { id: nodeId, mapId: map.id },
          });
          if (!node) return reply.status(400).send({ message: 'Node not found' });
        }

        const created = await prisma.contentMapComment.create({
          data: {
            mapId: map.id,
            nodeId,
            userId: request.user.id,
            content: content.slice(0, 10000),
            parentId: request.body?.parentId || null,
          },
          include: { user: { select: { id: true, name: true, role: true } } },
        });

        await logEvent({
          mapId: map.id,
          nodeId,
          userId: request.user.id,
          eventType: 'comment_added',
          message: 'Client added a comment',
        });

        const { recipientIds } = await resolveContentMapRecipients(project.id, {
          includeClients: false,
        });
        await notifyContentMap({
          slug: 'content_map_comment_added',
          recipientIds: recipientIds.filter((id) => id !== request.user.id),
          variables: {
            mapName: map.name,
            projectName: project.name || '',
            authorName: request.user.name || 'Client',
            commentPreview: content.slice(0, 200),
          },
          actionUrl: `/portal/pm/content-profile/${project.id}`,
          metadata: { mapId: map.id, projectId: project.id, nodeId },
        });

        await publishContentMapUpdate(project.id, { mapId: map.id, action: 'comment' });
        return reply.status(201).send(formatComment(created));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to post comment' });
      }
    }
  );

  app.patch(
    '/projects/:projectId/content-map/:mapId/comments/:commentId',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const comment = await prisma.contentMapComment.findUnique({
          where: { id: request.params.commentId },
        });
        if (!comment || comment.mapId !== map.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        if (comment.userId !== request.user.id) {
          return reply.status(403).send({ message: 'You can only edit your own comments' });
        }

        const content = String(request.body?.content || '').trim();
        if (!content) return reply.status(400).send({ message: 'Comment content is required' });

        const updated = await prisma.contentMapComment.update({
          where: { id: comment.id },
          data: { content: content.slice(0, 10000) },
          include: { user: { select: { id: true, name: true, role: true } } },
        });
        return reply.send(formatComment(updated));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to edit comment' });
      }
    }
  );

  app.delete(
    '/projects/:projectId/content-map/:mapId/comments/:commentId',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const comment = await prisma.contentMapComment.findUnique({
          where: { id: request.params.commentId },
        });
        if (!comment || comment.mapId !== map.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        if (comment.userId !== request.user.id) {
          return reply.status(403).send({ message: 'You can only delete your own comments' });
        }

        await prisma.contentMapComment.delete({ where: { id: comment.id } });
        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to delete comment' });
      }
    }
  );

  // Per-node decision
  app.post(
    '/projects/:projectId/content-map/:mapId/nodes/:nodeId/decision',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const decision = String(request.body?.decision || '').toUpperCase();
        if (!['APPROVED', 'CHANGES_REQUESTED'].includes(decision)) {
          return reply.status(400).send({ message: 'decision must be APPROVED or CHANGES_REQUESTED' });
        }
        const commentText = String(request.body?.comment || '').trim();
        if (decision === 'CHANGES_REQUESTED' && !commentText) {
          return reply.status(400).send({ message: 'A comment is required when requesting changes' });
        }

        const node = await prisma.contentMapNode.findFirst({
          where: { id: request.params.nodeId, mapId: map.id },
        });
        if (!node) return reply.status(404).send({ message: 'Node not found' });

        const updated = await prisma.contentMapNode.update({
          where: { id: node.id },
          data: { clientDecision: decision },
        });

        if (commentText) {
          await prisma.contentMapComment.create({
            data: {
              mapId: map.id,
              nodeId: node.id,
              userId: request.user.id,
              content: commentText.slice(0, 10000),
            },
          });
        }

        await logEvent({
          mapId: map.id,
          nodeId: node.id,
          userId: request.user.id,
          eventType: decision === 'APPROVED' ? 'node_approved' : 'node_changes_requested',
          message: `Client ${decision === 'APPROVED' ? 'approved' : 'requested changes on'} "${node.name}"`,
        });

        const { recipientIds } = await resolveContentMapRecipients(project.id);
        await notifyContentMap({
          slug: decision === 'APPROVED' ? 'content_map_client_approved' : 'content_map_changes_requested',
          recipientIds,
          variables: {
            mapName: map.name,
            projectName: project.name || '',
            nodeName: node.name,
            commentPreview: commentText.slice(0, 200),
          },
          actionUrl: `/portal/pm/content-profile/${project.id}`,
          metadata: { mapId: map.id, projectId: project.id, nodeId: node.id },
        });

        await publishContentMapUpdate(project.id, {
          mapId: map.id,
          action: 'node_decision',
          nodeId: node.id,
          decision,
        });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to record node decision' });
      }
    }
  );

  // Whole-plan decision
  app.post(
    '/projects/:projectId/content-map/:mapId/decision',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const decision = String(request.body?.decision || '').toUpperCase();
        if (!['APPROVED', 'CHANGES_REQUESTED'].includes(decision)) {
          return reply.status(400).send({ message: 'decision must be APPROVED or CHANGES_REQUESTED' });
        }
        const commentText = String(request.body?.comment || '').trim();
        if (decision === 'CHANGES_REQUESTED' && !commentText) {
          return reply.status(400).send({ message: 'A comment is required when requesting changes' });
        }

        const updated = await prisma.contentMap.update({
          where: { id: map.id },
          data: {
            clientDecision: decision,
            clientDecisionAt: new Date(),
            clientDecisionById: request.user.id,
            status: decision === 'APPROVED' ? 'APPROVED' : 'IN_REVIEW',
          },
        });

        if (commentText) {
          await prisma.contentMapComment.create({
            data: {
              mapId: map.id,
              nodeId: null,
              userId: request.user.id,
              content: commentText.slice(0, 10000),
            },
          });
        }

        await logEvent({
          mapId: map.id,
          userId: request.user.id,
          eventType: decision === 'APPROVED' ? 'map_approved' : 'map_changes_requested',
          message: `Client ${decision === 'APPROVED' ? 'approved' : 'requested changes on'} the content map`,
        });

        const { recipientIds } = await resolveContentMapRecipients(project.id);
        await notifyContentMap({
          slug: decision === 'APPROVED' ? 'content_map_client_approved' : 'content_map_changes_requested',
          recipientIds,
          variables: {
            mapName: map.name,
            projectName: project.name || '',
            commentPreview: commentText.slice(0, 200),
          },
          actionUrl: `/portal/pm/content-profile/${project.id}`,
          metadata: { mapId: map.id, projectId: project.id },
        });

        await publishContentMapUpdate(project.id, {
          mapId: map.id,
          action: 'map_decision',
          decision,
        });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to record plan decision' });
      }
    }
  );

  // GET /projects/:projectId/content-map/:mapId/schedule — read-only forecast
  app.get(
    '/projects/:projectId/content-map/:mapId/schedule',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      try {
        const project = await assertClientProjectAccess(request, reply, request.params.projectId);
        if (!project) return;

        const map = await prisma.contentMap.findFirst({
          where: { id: request.params.mapId, projectId: project.id, clientVisible: true },
          select: { id: true, settings: true },
        });
        if (!map) return reply.status(404).send({ message: 'Content map not found' });

        const { from, to } = request.query || {};
        const where = { mapId: map.id };
        if (from || to) {
          where.plannedPublishDate = {};
          if (from) where.plannedPublishDate.gte = new Date(String(from));
          if (to) where.plannedPublishDate.lte = new Date(String(to));
        }

        const nodes = await prisma.contentMapNode.findMany({
          where,
          orderBy: [{ plannedPublishDate: 'asc' }, { sortOrder: 'asc' }],
          select: {
            id: true,
            name: true,
            slug: true,
            url: true,
            kind: true,
            priority: true,
            contentType: true,
            lifecycle: true,
            source: true,
            plannedPublishDate: true,
            publishedAt: true,
            parent: { select: { id: true, name: true } },
          },
        });

        return reply.send({
          items: nodes.filter((n) => n.plannedPublishDate),
          unscheduled: nodes.filter((n) => !n.plannedPublishDate && n.lifecycle === 'PLANNED'),
          targetPerMonth: Number(map.settings?.targetPerMonth) || null,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load the schedule' });
      }
    }
  );
}
