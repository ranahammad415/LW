/**
 * PM / staff Content Map routes — CRUD, import/export, versions, comments, submit.
 * Registered at /api/pm
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import {
  DEFAULT_SECTIONS,
  getMapWithTree,
  importIntoMap,
  exportToShorthand,
  snapshotMap,
  logEvent,
  publishContentMapUpdate,
  notifyContentMap,
  resolveContentMapRecipients,
} from '../../lib/contentMapService.js';
import {
  importSiteIntoMap,
  reconcileMap,
  buildSiteInventory,
  normalizePath,
  lifecycleForStatus,
} from '../../lib/contentMapSync.js';
import { computeMapHealth, refreshNodeMetrics, loadNodeDetail } from '../../lib/contentMapHealth.js';
import { resolveCycle } from '../../lib/workCycle.js';
import { randomUUID } from 'crypto';

const STAFF_ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];
const KIND_BY_DEPTH_SAFE = ['ROOT', 'PILLAR', 'CLUSTER', 'PAGE'];

async function requireContentMapStaff(request, reply) {
  if (!request.user?.id) {
    return reply.status(401).send({ message: 'Authentication required' });
  }
  if (!STAFF_ROLES.includes(request.user.role)) {
    return reply.status(403).send({ message: 'Staff access required' });
  }
}

async function loadProjectForAccess(projectId) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: {
      tasks: { select: { id: true, assignees: { select: { id: true } } } },
    },
  });
}

async function assertMapAccess(request, reply, mapId) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    select: { id: true, projectId: true, name: true, status: true, clientVisible: true },
  });
  if (!map) {
    reply.status(404).send({ message: 'Content map not found' });
    return null;
  }
  const project = await loadProjectForAccess(map.projectId);
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    // OWNER always allowed via ensureProjectAccess; TEAM without task assignment blocked
    if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
      // Allow TEAM_MEMBER/CONTRACTOR read/write on content maps if they have project task access;
      // PMs and owners already covered. Re-check:
      if (!(await ensureProjectAccess(project, request.user))) {
        reply.status(403).send({ message: 'No access to this project' });
        return null;
      }
    }
  }
  // Relax: OWNER and PM always; others need ensureProjectAccess
  if (request.user.role === 'OWNER' || request.user.role === 'PM') {
    // PM must still be linked to project/client
    if (request.user.role === 'PM' && !(await ensureProjectAccess(project, request.user))) {
      reply.status(403).send({ message: 'No access to this project' });
      return null;
    }
  } else if (!(await ensureProjectAccess(project, request.user))) {
    reply.status(403).send({ message: 'No access to this project' });
    return null;
  }
  return { map, project };
}

/**
 * Work cycle that owns a planned publish date. Returns null when no cycle has
 * been opened for that month yet — scheduling should not create cycles.
 */
async function resolveCycleForDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return await resolveCycle({ month: d.getMonth() + 1, year: d.getFullYear() });
  } catch {
    return null;
  }
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

export async function pmContentMapRoutes(app) {
  // GET /projects/:projectId/content-maps
  app.get(
    '/projects/:projectId/content-maps',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const { projectId } = request.params;
        const project = await loadProjectForAccess(projectId);
        if (!project) return reply.status(404).send({ message: 'Project not found' });
        if (request.user.role === 'PM' || request.user.role === 'TEAM_MEMBER' || request.user.role === 'CONTRACTOR') {
          if (!(await ensureProjectAccess(project, request.user))) {
            return reply.status(403).send({ message: 'No access to this project' });
          }
        }

        const maps = await prisma.contentMap.findMany({
          where: { projectId },
          orderBy: { updatedAt: 'desc' },
          include: {
            createdBy: { select: { id: true, name: true } },
            _count: { select: { nodes: true, comments: true } },
          },
        });
        return reply.send({ items: maps });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to list content maps' });
      }
    }
  );

  // POST /projects/:projectId/content-maps
  app.post(
    '/projects/:projectId/content-maps',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const { projectId } = request.params;
        const project = await loadProjectForAccess(projectId);
        if (!project) return reply.status(404).send({ message: 'Project not found' });
        if (request.user.role !== 'OWNER' && !(await ensureProjectAccess(project, request.user))) {
          return reply.status(403).send({ message: 'No access to this project' });
        }

        const name = String(request.body?.name || 'Content Profile').slice(0, 255);
        const mode = request.body?.mode; // 'json' | undefined
        const payload = request.body?.payload;

        const map = await prisma.contentMap.create({
          data: {
            projectId,
            name,
            status: 'DRAFT',
            clientVisible: false,
            sections: DEFAULT_SECTIONS,
            createdById: request.user.id,
          },
        });

        if (mode === 'json' && payload) {
          const result = await importIntoMap(map.id, payload, {
            mode: 'replace',
            authorId: request.user.id,
          });
          if (!result.ok) {
            await prisma.contentMap.delete({ where: { id: map.id } });
            return reply.status(400).send({ message: 'Invalid import payload', errors: result.errors });
          }
        } else {
          // Seed a root node
          await prisma.contentMapNode.create({
            data: {
              mapId: map.id,
              kind: 'ROOT',
              name: project.name || 'Homepage',
              slug: '/',
              sortOrder: 0,
              collapsed: false,
            },
          });
        }

        await logEvent({
          mapId: map.id,
          userId: request.user.id,
          eventType: 'map_created',
          message: `Created content map "${name}"`,
        });
        await publishContentMapUpdate(projectId, { mapId: map.id, action: 'created' });

        const full = await getMapWithTree(map.id);
        return reply.status(201).send(full);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to create content map' });
      }
    }
  );

  // GET /content-maps/:mapId
  app.get(
    '/content-maps/:mapId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const full = await getMapWithTree(access.map.id);
        return reply.send(full);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load content map' });
      }
    }
  );

  // PATCH /content-maps/:mapId
  app.patch(
    '/content-maps/:mapId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;

        const data = {};
        if (request.body?.name != null) data.name = String(request.body.name).slice(0, 255);
        if (request.body?.status != null) data.status = String(request.body.status).slice(0, 30);
        if (request.body?.clientVisible != null) data.clientVisible = !!request.body.clientVisible;
        if (request.body?.sections != null) data.sections = request.body.sections;
        if (request.body?.settings != null) data.settings = request.body.settings;

        const updated = await prisma.contentMap.update({
          where: { id: access.map.id },
          data,
        });
        await logEvent({
          mapId: access.map.id,
          userId: request.user.id,
          eventType: 'map_updated',
          message: 'Updated content map settings',
          metadata: data,
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'updated' });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to update content map' });
      }
    }
  );

  // DELETE /content-maps/:mapId
  app.delete(
    '/content-maps/:mapId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
          return reply.status(403).send({ message: 'Only Owner or PM can delete a content profile' });
        }
        await prisma.contentMap.delete({ where: { id: access.map.id } });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'deleted' });
        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to delete content map' });
      }
    }
  );

  // POST /content-maps/:mapId/import
  app.post(
    '/content-maps/:mapId/import',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;

        const payload = request.body?.payload ?? request.body;
        const mode = request.body?.mode === 'merge' ? 'merge' : 'replace';
        const dryRun = !!request.body?.dryRun;

        const result = await importIntoMap(access.map.id, payload, {
          mode,
          dryRun,
          authorId: request.user.id,
        });
        if (!result.ok) {
          return reply.status(400).send({ message: 'Import validation failed', errors: result.errors });
        }

        if (!dryRun) {
          await logEvent({
            mapId: access.map.id,
            userId: request.user.id,
            eventType: 'map_imported',
            message: `Imported JSON (${mode})`,
            metadata: result.diff,
          });
          await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'imported' });
        }

        if (dryRun) return reply.send(result);
        const full = await getMapWithTree(access.map.id);
        return reply.send({ ...result, ...full });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to import content map' });
      }
    }
  );

  // GET /content-maps/:mapId/export
  app.get(
    '/content-maps/:mapId/export',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const map = await prisma.contentMap.findUnique({ where: { id: access.map.id } });
        const rows = await prisma.contentMapNode.findMany({ where: { mapId: access.map.id } });
        const tree = exportToShorthand(rows);
        return reply.send({
          name: map.name,
          sections: map.sections,
          tree,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to export content map' });
      }
    }
  );

  // POST /content-maps/:mapId/submit
  app.post(
    '/content-maps/:mapId/submit',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;

        const updated = await prisma.contentMap.update({
          where: { id: access.map.id },
          data: {
            status: 'IN_REVIEW',
            clientVisible: true,
            clientDecision: null,
            clientDecisionAt: null,
            clientDecisionById: null,
          },
        });

        await logEvent({
          mapId: access.map.id,
          userId: request.user.id,
          eventType: 'map_submitted',
          message: 'Submitted content map for client review',
        });

        const { project } = await resolveContentMapRecipients(access.map.projectId, {
          includeClients: true,
        });
        const clientUsers = project?.clientId
          ? await prisma.clientUser.findMany({
              where: { clientId: project.clientId },
              select: { userId: true },
            })
          : [];
        const clientIds = clientUsers.map((c) => c.userId);
        await notifyContentMap({
          slug: 'content_map_submitted',
          recipientIds: clientIds,
          variables: {
            mapName: updated.name,
            projectName: project?.name || '',
          },
          actionUrl: `/portal/client/content-profile/${access.map.projectId}`,
          metadata: { mapId: access.map.id, projectId: access.map.projectId },
        });

        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'submitted' });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to submit content map' });
      }
    }
  );

  // POST /content-maps/:mapId/nodes
  app.post(
    '/content-maps/:mapId/nodes',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;

        const body = request.body || {};
        const name = String(body.name || '').trim();
        if (!name) return reply.status(400).send({ message: 'Name is required' });

        let parentId = body.parentId || null;
        let kind = (body.kind || 'PAGE').toUpperCase();

        if (parentId) {
          const parent = await prisma.contentMapNode.findFirst({
            where: { id: parentId, mapId: access.map.id },
          });
          if (!parent) return reply.status(400).send({ message: 'Parent node not found' });
          // Enforce max depth: ROOT=0, PILLAR=1, CLUSTER=2, PAGE=3
          const depthOf = { ROOT: 0, PILLAR: 1, CLUSTER: 2, PAGE: 3 };
          const parentDepth = depthOf[parent.kind] ?? 0;
          if (parentDepth >= 3) {
            return reply.status(400).send({ message: 'Cannot add children under a supporting page (max 3 levels)' });
          }
          if (!body.kind) {
            kind = KIND_BY_DEPTH_SAFE[parentDepth + 1];
          }
        }

        const maxSort = await prisma.contentMapNode.aggregate({
          where: { mapId: access.map.id, parentId },
          _max: { sortOrder: true },
        });

        const node = await prisma.contentMapNode.create({
          data: {
            mapId: access.map.id,
            parentId,
            kind,
            name: name.slice(0, 500),
            slug: body.slug ? String(body.slug).slice(0, 500) : null,
            priority: body.priority || null,
            contentType: body.contentType || null,
            intent: body.intent || null,
            accent: body.accent || null,
            note: body.note || null,
            todo: body.todo || null,
            links: body.links || undefined,
            isLive: !!body.isLive,
            needsFix: !!body.needsFix,
            isSupport: !!body.isSupport,
            sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
            collapsed: kind === 'CLUSTER',
            source: 'PLANNED',
            lifecycle: body.isLive ? 'LIVE' : 'PLANNED',
            assigneeId: body.assigneeId || null,
            keywords: body.keywords || undefined,
            plannedPublishDate: body.plannedPublishDate ? new Date(body.plannedPublishDate) : null,
          },
        });

        await logEvent({
          mapId: access.map.id,
          nodeId: node.id,
          userId: request.user.id,
          eventType: 'node_created',
          message: `Added node "${node.name}"`,
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'node_created', nodeId: node.id });
        return reply.status(201).send(node);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to create node' });
      }
    }
  );

  // PATCH /content-maps/:mapId/nodes/:nodeId
  app.patch(
    '/content-maps/:mapId/nodes/:nodeId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const { nodeId } = request.params;
        const existing = await prisma.contentMapNode.findFirst({
          where: { id: nodeId, mapId: access.map.id },
        });
        if (!existing) return reply.status(404).send({ message: 'Node not found' });

        const body = request.body || {};
        const data = {};
        for (const key of [
          'name', 'slug', 'priority', 'contentType', 'intent', 'accent', 'note', 'todo',
          'isLive', 'needsFix', 'isSupport', 'collapsed', 'nodeStatus', 'pmDecision', 'clientDecision',
          'posX', 'posY', 'sortOrder', 'kind', 'lifecycle', 'assigneeId',
        ]) {
          if (body[key] !== undefined) data[key] = body[key];
        }
        if (body.links !== undefined) data.links = body.links;
        if (body.keywords !== undefined) data.keywords = body.keywords;
        if (body.url !== undefined) data.url = body.url ? String(body.url).slice(0, 500) : null;
        if (body.plannedPublishDate !== undefined) {
          data.plannedPublishDate = body.plannedPublishDate ? new Date(body.plannedPublishDate) : null;
        }
        if (data.name) data.name = String(data.name).slice(0, 500);
        if (data.slug != null) data.slug = String(data.slug).slice(0, 500);

        const updated = await prisma.contentMapNode.update({ where: { id: nodeId }, data });
        await logEvent({
          mapId: access.map.id,
          nodeId,
          userId: request.user.id,
          eventType: 'node_updated',
          message: `Updated node "${updated.name}"`,
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'node_updated', nodeId });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to update node' });
      }
    }
  );

  // DELETE /content-maps/:mapId/nodes/:nodeId
  app.delete(
    '/content-maps/:mapId/nodes/:nodeId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const { nodeId } = request.params;
        const existing = await prisma.contentMapNode.findFirst({
          where: { id: nodeId, mapId: access.map.id },
        });
        if (!existing) return reply.status(404).send({ message: 'Node not found' });
        if (existing.kind === 'ROOT') {
          return reply.status(400).send({ message: 'Cannot delete the root node' });
        }
        await prisma.contentMapNode.delete({ where: { id: nodeId } });
        await logEvent({
          mapId: access.map.id,
          userId: request.user.id,
          eventType: 'node_deleted',
          message: `Deleted node "${existing.name}"`,
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'node_deleted', nodeId });
        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to delete node' });
      }
    }
  );

  // POST /content-maps/:mapId/nodes/:nodeId/move
  app.post(
    '/content-maps/:mapId/nodes/:nodeId/move',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const { nodeId } = request.params;
        const { parentId = null, sortOrder = 0 } = request.body || {};

        const existing = await prisma.contentMapNode.findFirst({
          where: { id: nodeId, mapId: access.map.id },
        });
        if (!existing) return reply.status(404).send({ message: 'Node not found' });
        if (existing.kind === 'ROOT') {
          return reply.status(400).send({ message: 'Cannot reparent the root node' });
        }
        if (parentId) {
          const parent = await prisma.contentMapNode.findFirst({
            where: { id: parentId, mapId: access.map.id },
          });
          if (!parent) return reply.status(400).send({ message: 'Parent not found' });
          if (parentId === nodeId) {
            return reply.status(400).send({ message: 'Cannot parent a node to itself' });
          }
        }

        const updated = await prisma.contentMapNode.update({
          where: { id: nodeId },
          data: { parentId, sortOrder: Number(sortOrder) || 0 },
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'node_moved', nodeId });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to move node' });
      }
    }
  );

  // POST /content-maps/:mapId/nodes/positions
  app.post(
    '/content-maps/:mapId/nodes/positions',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const positions = Array.isArray(request.body?.positions) ? request.body.positions : [];
        if (!positions.length) return reply.status(400).send({ message: 'positions array required' });

        await prisma.$transaction(
          positions.slice(0, 500).map((p) =>
            prisma.contentMapNode.updateMany({
              where: { id: p.id, mapId: access.map.id },
              data: {
                posX: typeof p.posX === 'number' ? p.posX : null,
                posY: typeof p.posY === 'number' ? p.posY : null,
              },
            })
          )
        );
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'positions' });
        return reply.send({ success: true, count: positions.length });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to save positions' });
      }
    }
  );

  // Versions
  app.get(
    '/content-maps/:mapId/versions',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const versions = await prisma.contentMapVersion.findMany({
          where: { mapId: access.map.id },
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true,
            versionNumber: true,
            changeSummary: true,
            createdAt: true,
            authorId: true,
            author: { select: { id: true, name: true } },
          },
        });
        return reply.send({ items: versions });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to list versions' });
      }
    }
  );

  app.post(
    '/content-maps/:mapId/versions',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const summary = String(request.body?.changeSummary || 'Manual snapshot').slice(0, 500);
        const version = await snapshotMap(access.map.id, request.user.id, summary);
        return reply.status(201).send(version);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to create version' });
      }
    }
  );

  app.post(
    '/content-maps/:mapId/versions/:versionId/restore',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const version = await prisma.contentMapVersion.findFirst({
          where: { id: request.params.versionId, mapId: access.map.id },
        });
        if (!version) return reply.status(404).send({ message: 'Version not found' });

        await snapshotMap(access.map.id, request.user.id, `Before restore to v${version.versionNumber}`);

        const snap = version.snapshot;
        await prisma.contentMapNode.deleteMany({ where: { mapId: access.map.id } });

        const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
        // Insert preserving ids so comments still point correctly when possible
        const idSet = new Set(nodes.map((n) => n.id));
        for (const n of nodes) {
          await prisma.contentMapNode.create({
            data: {
              id: n.id && idSet.has(n.id) ? n.id : randomUUID(),
              mapId: access.map.id,
              parentId: n.parentId && idSet.has(n.parentId) ? n.parentId : null,
              kind: n.kind,
              name: n.name,
              slug: n.slug,
              priority: n.priority,
              contentType: n.contentType,
              intent: n.intent,
              accent: n.accent,
              note: n.note,
              todo: n.todo,
              links: n.links || undefined,
              isLive: !!n.isLive,
              needsFix: !!n.needsFix,
              isSupport: !!n.isSupport,
              sortOrder: n.sortOrder ?? 0,
              posX: n.posX ?? null,
              posY: n.posY ?? null,
              collapsed: !!n.collapsed,
              nodeStatus: n.nodeStatus || null,
              pmDecision: n.pmDecision || null,
              clientDecision: n.clientDecision || null,
            },
          });
        }

        if (snap?.sections || snap?.name) {
          await prisma.contentMap.update({
            where: { id: access.map.id },
            data: {
              ...(snap.name ? { name: snap.name } : {}),
              ...(snap.sections ? { sections: snap.sections } : {}),
              ...(snap.settings ? { settings: snap.settings } : {}),
            },
          });
        }

        await logEvent({
          mapId: access.map.id,
          userId: request.user.id,
          eventType: 'version_restored',
          message: `Restored version ${version.versionNumber}`,
        });
        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'restored' });
        const full = await getMapWithTree(access.map.id);
        return reply.send(full);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to restore version' });
      }
    }
  );

  // Comments
  app.get(
    '/content-maps/:mapId/comments',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const nodeId = request.query?.nodeId;
        const where = { mapId: access.map.id };
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
    '/content-maps/:mapId/comments',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const content = String(request.body?.content || '').trim();
        if (!content) return reply.status(400).send({ message: 'Comment content is required' });

        const nodeId = request.body?.nodeId || null;
        if (nodeId) {
          const node = await prisma.contentMapNode.findFirst({
            where: { id: nodeId, mapId: access.map.id },
          });
          if (!node) return reply.status(400).send({ message: 'Node not found' });
        }

        const created = await prisma.contentMapComment.create({
          data: {
            mapId: access.map.id,
            nodeId,
            userId: request.user.id,
            content: content.slice(0, 10000),
            parentId: request.body?.parentId || null,
          },
          include: { user: { select: { id: true, name: true, role: true } } },
        });

        await logEvent({
          mapId: access.map.id,
          nodeId,
          userId: request.user.id,
          eventType: 'comment_added',
          message: 'Added a comment',
        });

        const { project, recipientIds } = await resolveContentMapRecipients(access.map.projectId, {
          includeClients: true,
        });
        await notifyContentMap({
          slug: 'content_map_comment_added',
          recipientIds: recipientIds.filter((id) => id !== request.user.id),
          variables: {
            mapName: access.map.name,
            projectName: project?.name || '',
            authorName: request.user.name || 'Team',
            commentPreview: content.slice(0, 200),
          },
          actionUrl: `/portal/pm/content-profile/${access.map.projectId}`,
          metadata: { mapId: access.map.id, projectId: access.map.projectId, nodeId },
        });

        await publishContentMapUpdate(access.map.projectId, { mapId: access.map.id, action: 'comment' });
        return reply.status(201).send(formatComment(created));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to post comment' });
      }
    }
  );

  app.patch(
    '/content-maps/:mapId/comments/:commentId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const comment = await prisma.contentMapComment.findUnique({
          where: { id: request.params.commentId },
        });
        if (!comment || comment.mapId !== access.map.id) {
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
    '/content-maps/:mapId/comments/:commentId',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const comment = await prisma.contentMapComment.findUnique({
          where: { id: request.params.commentId },
        });
        if (!comment || comment.mapId !== access.map.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        if (comment.userId !== request.user.id && request.user.role !== 'OWNER' && request.user.role !== 'PM') {
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

  app.post(
    '/content-maps/:mapId/comments/:commentId/resolve',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const comment = await prisma.contentMapComment.findUnique({
          where: { id: request.params.commentId },
        });
        if (!comment || comment.mapId !== access.map.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        const updated = await prisma.contentMapComment.update({
          where: { id: comment.id },
          data: { resolvedAt: new Date(), resolvedById: request.user.id },
          include: { user: { select: { id: true, name: true, role: true } } },
        });
        return reply.send(formatComment(updated));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to resolve comment' });
      }
    }
  );

  // Create task from node
  app.post(
    '/content-maps/:mapId/nodes/:nodeId/create-task',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const node = await prisma.contentMapNode.findFirst({
          where: { id: request.params.nodeId, mapId: access.map.id },
        });
        if (!node) return reply.status(404).send({ message: 'Node not found' });
        if (node.taskId) {
          return reply.status(400).send({ message: 'Node already has a linked task', taskId: node.taskId });
        }

        // Content tasks used to be created without a cycle, which hid them from
        // every cycle-filtered view. Derive it from the node's planned date.
        const cycle = await resolveCycleForDate(node.plannedPublishDate);

        const task = await prisma.task.create({
          data: {
            projectId: access.map.projectId,
            title: `Write: ${node.name}`.slice(0, 500),
            description: [
              node.slug ? `URL: ${node.slug}` : null,
              node.contentType ? `Type: ${node.contentType}` : null,
              node.intent ? `Intent: ${node.intent}` : null,
              node.note || null,
              node.todo ? `Next step: ${node.todo}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            taskType: 'CONTENT',
            priority: node.priority === 'P1' ? 'HIGH' : node.priority === 'P3' ? 'LOW' : 'MEDIUM',
            createdById: request.user.id,
            clientVisible: true,
            dueDate: node.plannedPublishDate || null,
            workCycleId: cycle?.id || null,
            ...(node.assigneeId ? { assignees: { connect: [{ id: node.assigneeId }] } } : {}),
          },
        });

        const updated = await prisma.contentMapNode.update({
          where: { id: node.id },
          data: { taskId: task.id, workCycleId: cycle?.id || node.workCycleId || null },
        });

        await logEvent({
          mapId: access.map.id,
          nodeId: node.id,
          userId: request.user.id,
          eventType: 'task_created',
          message: `Created task from node "${node.name}"`,
          metadata: { taskId: task.id },
        });
        await publishContentMapUpdate(access.map.projectId, {
          mapId: access.map.id,
          action: 'task_created',
          nodeId: node.id,
          taskId: task.id,
        });
        return reply.status(201).send({ node: updated, task });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to create task from node' });
      }
    }
  );

  /* ────────────────── WordPress site sync ────────────────── */

  // GET /content-maps/:mapId/sync — current sync state
  app.get(
    '/content-maps/:mapId/sync',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const [state, project, pendingDrift] = await Promise.all([
          prisma.contentMapSync.findUnique({ where: { mapId: access.map.id } }),
          prisma.project.findUnique({
            where: { id: access.map.projectId },
            select: { wpUrl: true, wpApiKey: true },
          }),
          prisma.contentMapDrift.count({ where: { mapId: access.map.id, status: 'PENDING' } }),
        ]);
        return reply.send({
          state: state || null,
          pendingDrift,
          wpConnected: !!(project?.wpUrl && project?.wpApiKey),
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load sync state' });
      }
    }
  );

  // PATCH /content-maps/:mapId/sync — sync preferences
  app.patch(
    '/content-maps/:mapId/sync',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const data = {};
        if (request.body?.autoAdopt !== undefined) data.autoAdopt = !!request.body.autoAdopt;
        if (request.body?.includePostTypes !== undefined) {
          data.includePostTypes = Array.isArray(request.body.includePostTypes)
            ? request.body.includePostTypes.map(String).slice(0, 20)
            : null;
        }
        const state = await prisma.contentMapSync.upsert({
          where: { mapId: access.map.id },
          update: data,
          create: { mapId: access.map.id, ...data },
        });
        return reply.send(state);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to update sync settings' });
      }
    }
  );

  // POST /content-maps/:mapId/sync-site — import or reconcile against WordPress
  app.post(
    '/content-maps/:mapId/sync-site',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const mode = request.body?.mode; // 'import' | 'replace' | undefined (reconcile)

        const result =
          mode === 'import' || mode === 'replace'
            ? await importSiteIntoMap(access.map.id, {
                userId: request.user.id,
                mode: mode === 'replace' ? 'replace' : 'merge',
              })
            : await reconcileMap(access.map.id, { userId: request.user.id, notify: false });

        if (!result.ok) return reply.status(400).send({ message: result.error });

        const full = await getMapWithTree(access.map.id);
        const pendingDrift = await prisma.contentMapDrift.count({
          where: { mapId: access.map.id, status: 'PENDING' },
        });
        return reply.send({ ...result, pendingDrift, ...full });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to sync from the site' });
      }
    }
  );

  // GET /content-maps/:mapId/site-inventory — WP pages not represented in the map
  app.get(
    '/content-maps/:mapId/site-inventory',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const onlyUnmapped = request.query?.unmapped !== 'false';

        const inventory = await buildSiteInventory(access.map.projectId);
        const nodes = await prisma.contentMapNode.findMany({
          where: { mapId: access.map.id },
          select: { wpPageId: true, slug: true, url: true },
        });
        const mappedPageIds = new Set(nodes.filter((n) => n.wpPageId).map((n) => n.wpPageId));
        const mappedPaths = new Set(
          nodes.map((n) => normalizePath(n.url || n.slug)).filter(Boolean)
        );

        const items = inventory.items
          .filter((i) => !onlyUnmapped || (!mappedPageIds.has(i.page.id) && !mappedPaths.has(i.path)))
          .map((i) => ({
            wpPageId: i.page.id,
            wpPostId: i.page.wpPostId,
            title: i.page.title,
            url: i.page.url,
            path: i.path,
            status: i.page.status,
            postType: i.page.postType,
            lifecycle: i.lifecycle,
            modifiedAt: i.page.modifiedAt,
            wordCount: i.enrichment.wordCount,
            internalLinksIn: i.enrichment.internalLinksIn,
            mapped: mappedPageIds.has(i.page.id),
          }));

        return reply.send({ items, total: inventory.items.length });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load site inventory' });
      }
    }
  );

  /* ────────────────── Drift review queue ────────────────── */

  // GET /content-maps/:mapId/drift
  app.get(
    '/content-maps/:mapId/drift',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const status = String(request.query?.status || 'PENDING').toUpperCase();
        const where = { mapId: access.map.id };
        if (status !== 'ALL') where.status = status;

        const items = await prisma.contentMapDrift.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 300,
          include: {
            node: { select: { id: true, name: true, slug: true, url: true, lifecycle: true } },
            wpPage: { select: { id: true, title: true, url: true, status: true, postType: true } },
            resolvedBy: { select: { id: true, name: true } },
          },
        });
        return reply.send({ items });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load site changes' });
      }
    }
  );

  // POST /content-maps/:mapId/drift/:driftId/resolve
  app.post(
    '/content-maps/:mapId/drift/:driftId/resolve',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const drift = await prisma.contentMapDrift.findFirst({
          where: { id: request.params.driftId, mapId: access.map.id },
          include: { wpPage: true, node: true },
        });
        if (!drift) return reply.status(404).send({ message: 'Site change not found' });
        if (drift.status !== 'PENDING') {
          return reply.status(400).send({ message: 'This change was already resolved' });
        }

        const action = String(request.body?.action || '').toLowerCase();
        const result = await applyDriftResolution({
          drift,
          action,
          mapId: access.map.id,
          body: request.body || {},
          user: request.user,
        });
        if (result.error) return reply.status(400).send({ message: result.error });

        await prisma.contentMapDrift.update({
          where: { id: drift.id },
          data: { status: result.status, resolvedById: request.user.id, resolvedAt: new Date() },
        });

        await logEvent({
          mapId: access.map.id,
          nodeId: result.nodeId || drift.nodeId,
          userId: request.user.id,
          eventType: 'drift_resolved',
          message: `${action} — ${drift.driftType}`,
          metadata: { driftId: drift.id, driftType: drift.driftType },
        });
        await publishContentMapUpdate(access.map.projectId, {
          mapId: access.map.id,
          action: 'drift_resolved',
        });

        return reply.send({ success: true, status: result.status, nodeId: result.nodeId || null });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to resolve site change' });
      }
    }
  );

  // POST /content-maps/:mapId/drift/bulk — adopt or ignore many at once
  app.post(
    '/content-maps/:mapId/drift/bulk',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const action = String(request.body?.action || '').toLowerCase();
        if (action !== 'adopt' && action !== 'ignore') {
          return reply.status(400).send({ message: 'Bulk action must be adopt or ignore' });
        }
        const ids = Array.isArray(request.body?.driftIds) ? request.body.driftIds.slice(0, 500) : null;

        const drifts = await prisma.contentMapDrift.findMany({
          where: {
            mapId: access.map.id,
            status: 'PENDING',
            ...(ids ? { id: { in: ids } } : {}),
          },
          include: { wpPage: true, node: true },
          take: 500,
        });

        let resolved = 0;
        for (const drift of drifts) {
          const result = await applyDriftResolution({
            drift,
            action,
            mapId: access.map.id,
            body: {},
            user: request.user,
          });
          if (result.error) continue;
          await prisma.contentMapDrift.update({
            where: { id: drift.id },
            data: { status: result.status, resolvedById: request.user.id, resolvedAt: new Date() },
          });
          resolved++;
        }

        await publishContentMapUpdate(access.map.projectId, {
          mapId: access.map.id,
          action: 'drift_resolved',
        });
        return reply.send({ success: true, resolved });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to resolve site changes' });
      }
    }
  );

  /* ────────────────── Health + metrics ────────────────── */

  app.get(
    '/content-maps/:mapId/health',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const health = await computeMapHealth(access.map.id);
        if (!health) return reply.status(404).send({ message: 'Content map not found' });
        return reply.send(health);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to compute map health' });
      }
    }
  );

  app.post(
    '/content-maps/:mapId/refresh-metrics',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const result = await refreshNodeMetrics(access.map.id);
        if (!result.ok) return reply.status(400).send({ message: result.error });
        await publishContentMapUpdate(access.map.projectId, {
          mapId: access.map.id,
          action: 'metrics_refreshed',
        });
        return reply.send(result);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to refresh metrics' });
      }
    }
  );

  // GET /content-maps/:mapId/nodes/:nodeId/detail — expandable node detail
  app.get(
    '/content-maps/:mapId/nodes/:nodeId/detail',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const node = await prisma.contentMapNode.findFirst({
          where: { id: request.params.nodeId, mapId: access.map.id },
          select: { id: true },
        });
        if (!node) return reply.status(404).send({ message: 'Node not found' });
        const detail = await loadNodeDetail(node.id);
        return reply.send(detail);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load node detail' });
      }
    }
  );

  /* ────────────────── Scheduling / forecast ────────────────── */

  // GET /content-maps/:mapId/schedule
  app.get(
    '/content-maps/:mapId/schedule',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const { from, to } = request.query || {};
        const where = { mapId: access.map.id };
        if (from || to) {
          where.plannedPublishDate = {};
          if (from) where.plannedPublishDate.gte = new Date(String(from));
          if (to) where.plannedPublishDate.lte = new Date(String(to));
        }

        const items = await prisma.contentMapNode.findMany({
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
            workCycleId: true,
            nodeStatus: true,
            taskId: true,
            assignee: { select: { id: true, name: true } },
            parent: { select: { id: true, name: true } },
          },
        });

        const map = await prisma.contentMap.findUnique({
          where: { id: access.map.id },
          select: { settings: true },
        });
        const scheduled = items.filter((n) => n.plannedPublishDate);
        const unscheduled = items.filter((n) => !n.plannedPublishDate && n.lifecycle === 'PLANNED');

        return reply.send({
          items: scheduled,
          unscheduled,
          targetPerMonth: Number(map?.settings?.targetPerMonth) || null,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load the schedule' });
      }
    }
  );

  // PATCH /content-maps/:mapId/nodes/:nodeId/schedule
  app.patch(
    '/content-maps/:mapId/nodes/:nodeId/schedule',
    { onRequest: [app.verifyJwt, requireContentMapStaff] },
    async (request, reply) => {
      try {
        const access = await assertMapAccess(request, reply, request.params.mapId);
        if (!access) return;
        const node = await prisma.contentMapNode.findFirst({
          where: { id: request.params.nodeId, mapId: access.map.id },
        });
        if (!node) return reply.status(404).send({ message: 'Node not found' });

        const body = request.body || {};
        const data = {};

        if (body.plannedPublishDate !== undefined) {
          const date = body.plannedPublishDate ? new Date(body.plannedPublishDate) : null;
          if (date && Number.isNaN(date.getTime())) {
            return reply.status(400).send({ message: 'Invalid planned publish date' });
          }
          data.plannedPublishDate = date;
          const cycle = await resolveCycleForDate(date);
          data.workCycleId = cycle?.id || null;
        }
        if (body.workCycleId !== undefined) data.workCycleId = body.workCycleId || null;
        if (body.assigneeId !== undefined) data.assigneeId = body.assigneeId || null;

        const updated = await prisma.contentMapNode.update({
          where: { id: node.id },
          data,
        });

        // Keep the linked delivery task aligned with the plan.
        if (node.taskId && (data.plannedPublishDate !== undefined || data.workCycleId !== undefined)) {
          try {
            await prisma.task.update({
              where: { id: node.taskId },
              data: {
                ...(data.plannedPublishDate !== undefined ? { dueDate: data.plannedPublishDate } : {}),
                ...(data.workCycleId ? { workCycleId: data.workCycleId } : {}),
              },
            });
          } catch {
            /* task may have been deleted; scheduling still stands */
          }
        }

        await logEvent({
          mapId: access.map.id,
          nodeId: node.id,
          userId: request.user.id,
          eventType: 'node_scheduled',
          message: data.plannedPublishDate
            ? `Scheduled "${node.name}" for ${data.plannedPublishDate.toISOString().slice(0, 10)}`
            : `Cleared the publish date on "${node.name}"`,
        });
        await publishContentMapUpdate(access.map.projectId, {
          mapId: access.map.id,
          action: 'node_scheduled',
          nodeId: node.id,
        });
        return reply.send(updated);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to schedule node' });
      }
    }
  );
}

/**
 * Apply a drift decision. Returns the resulting drift status plus the node it
 * touched, or an error message when the action does not fit the drift type.
 */
async function applyDriftResolution({ drift, action, mapId, body, user }) {
  if (action === 'ignore') return { status: 'IGNORED' };

  if (action === 'adopt') {
    // A change on an already-mapped node: accept the site as the truth.
    if (drift.nodeId && drift.driftType !== 'LIKELY_MATCH') {
      const data = {};
      const payload = drift.payload || {};
      if (drift.driftType === 'TITLE_CHANGED' && payload.to) data.name = String(payload.to).slice(0, 500);
      if (drift.driftType === 'URL_CHANGED' && payload.to) {
        data.slug = String(payload.to).slice(0, 500);
        if (drift.wpPage?.url) data.url = String(drift.wpPage.url).slice(0, 500);
      }
      if (drift.driftType === 'STATUS_CHANGED' && payload.to) {
        data.lifecycle = String(payload.to).slice(0, 20);
        data.isLive = payload.to === 'LIVE';
      }
      if (drift.driftType === 'REMOVED') {
        data.lifecycle = 'ARCHIVED';
        data.isLive = false;
        data.wpPageId = null;
      }
      if (Object.keys(data).length) {
        await prisma.contentMapNode.update({ where: { id: drift.nodeId }, data });
      }
      return { status: 'ADOPTED', nodeId: drift.nodeId };
    }

    // New content: create a node for it under the requested (or inferred) parent.
    if (!drift.wpPage) return { error: 'This change has no site page to adopt' };
    const page = drift.wpPage;
    const path = normalizePath(page.url || page.slug);
    const segments = path ? path.split('/').filter(Boolean) : [];

    let parentId = body.parentId || null;
    if (!parentId && segments.length > 1) {
      const parentPath = `/${segments.slice(0, -1).join('/')}/`;
      const candidates = await prisma.contentMapNode.findMany({
        where: { mapId },
        select: { id: true, slug: true, url: true },
      });
      parentId =
        candidates.find((c) => normalizePath(c.url || c.slug) === parentPath)?.id || null;
    }
    if (!parentId) {
      const root = await prisma.contentMapNode.findFirst({
        where: { mapId, kind: 'ROOT' },
        select: { id: true },
      });
      parentId = root?.id || null;
    }

    const maxSort = await prisma.contentMapNode.aggregate({
      where: { mapId, parentId },
      _max: { sortOrder: true },
    });
    const depth = segments.length;
    const created = await prisma.contentMapNode.create({
      data: {
        mapId,
        parentId,
        kind: KIND_BY_DEPTH_SAFE[Math.min(depth, KIND_BY_DEPTH_SAFE.length - 1)],
        name: String(page.title || 'Untitled').slice(0, 500),
        slug: path ? path.slice(0, 500) : null,
        url: String(page.url || '').slice(0, 500),
        source: 'WORDPRESS',
        lifecycle: lifecycleForStatus(page.status),
        isLive: lifecycleForStatus(page.status) === 'LIVE',
        wpPageId: page.id,
        pathDepth: depth,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        publishedAt: lifecycleForStatus(page.status) === 'LIVE' ? page.modifiedAt : null,
      },
    });
    return { status: 'ADOPTED', nodeId: created.id };
  }

  if (action === 'merge') {
    const targetNodeId = body.nodeId || drift.nodeId;
    if (!targetNodeId) return { error: 'A target node is required to merge' };
    if (!drift.wpPage) return { error: 'This change has no site page to merge' };
    const page = drift.wpPage;
    const target = await prisma.contentMapNode.findFirst({
      where: { id: targetNodeId, mapId },
      select: { id: true },
    });
    if (!target) return { error: 'Target node not found' };

    const lifecycle = lifecycleForStatus(page.status);
    await prisma.contentMapNode.update({
      where: { id: target.id },
      data: {
        wpPageId: page.id,
        url: String(page.url || '').slice(0, 500),
        slug: normalizePath(page.url || page.slug)?.slice(0, 500) || undefined,
        lifecycle,
        isLive: lifecycle === 'LIVE',
        publishedAt: lifecycle === 'LIVE' ? page.modifiedAt || new Date() : null,
      },
    });
    await logEvent({
      mapId,
      nodeId: target.id,
      userId: user?.id || null,
      eventType: 'node_linked_to_page',
      message: `Linked "${page.title}" to an existing node`,
      metadata: { wpPageId: page.id },
    });
    return { status: 'MERGED', nodeId: target.id };
  }

  return { error: 'Action must be adopt, merge, or ignore' };
}
