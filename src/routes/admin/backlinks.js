import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { prisma } from '../../lib/prisma.js';
import { importBacklinkSites } from '../../lib/dataImport/importBacklinkSites.js';
import {
  buildCatalogOrderBy,
  buildCatalogWhere,
  buildSiteWriteData,
  canTransition,
  notifyItemLive,
  notifyOrderStatus,
  recordOrderEvent,
  serializeOrder,
  serializeSiteForAdmin,
} from '../../lib/backlinksHub.js';
import {
  bulkSiteBodySchema,
  catalogQuerySchema,
  createSiteBodySchema,
  importBodySchema,
  orderQuerySchema,
  updateOrderBodySchema,
  updateOrderItemBodySchema,
  updateSiteBodySchema,
} from '../../schemas/backlinks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../../..');

function parseOr400(schema, payload, reply) {
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    reply.status(400).send({
      message: 'Validation failed',
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }
  return result.data;
}

const orderInclude = {
  client: { select: { agencyName: true } },
  requestedBy: { select: { name: true } },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      project: { select: { name: true } },
      wpPage: { select: { title: true, url: true } },
    },
  },
  events: {
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { name: true } } },
  },
};

export async function adminBacklinkRoutes(app) {
  const owner = { onRequest: [app.verifyJwt, app.requireOwner] };

  // ── Catalog ───────────────────────────────────────────────────────────────

  app.get('/backlinks', owner, async (request, reply) => {
    const query = parseOr400(catalogQuerySchema, request.query, reply);
    if (!query) return undefined;

    const where = buildCatalogWhere(query);
    const [total, sites] = await Promise.all([
      prisma.backlinkSite.count({ where }),
      prisma.backlinkSite.findMany({
        where,
        orderBy: buildCatalogOrderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return reply.send({
      sites: sites.map(serializeSiteForAdmin),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    });
  });

  app.get('/backlinks/stats', owner, async (_request, reply) => {
    const [total, active, featured, aggregate] = await Promise.all([
      prisma.backlinkSite.count(),
      prisma.backlinkSite.count({ where: { isActive: true } }),
      prisma.backlinkSite.count({ where: { isFeatured: true } }),
      prisma.backlinkSite.aggregate({
        where: { isActive: true },
        _min: { priceUsd: true, da: true },
        _max: { priceUsd: true, da: true },
        _avg: { priceUsd: true, da: true, dr: true },
      }),
    ]);

    return reply.send({
      total,
      active,
      inactive: total - active,
      featured,
      priceUsd: {
        min: Number(aggregate._min.priceUsd ?? 0),
        max: Number(aggregate._max.priceUsd ?? 0),
        avg: Number(aggregate._avg.priceUsd ?? 0),
      },
      da: {
        min: aggregate._min.da ?? 0,
        max: aggregate._max.da ?? 0,
        avg: Number(aggregate._avg.da ?? 0),
      },
      drAvg: Number(aggregate._avg.dr ?? 0),
    });
  });

  app.post('/backlinks', owner, async (request, reply) => {
    const body = parseOr400(createSiteBodySchema, request.body, reply);
    if (!body) return undefined;

    let data;
    try {
      data = buildSiteWriteData(body);
    } catch (err) {
      return reply.status(400).send({ message: err.message });
    }

    const clash = await prisma.backlinkSite.findUnique({ where: { domain: data.domain } });
    if (clash) {
      return reply.status(409).send({ message: `${data.domain} is already in the catalog` });
    }

    const site = await prisma.backlinkSite.create({ data });
    return reply.status(201).send(serializeSiteForAdmin(site));
  });

  app.patch('/backlinks/:id', owner, async (request, reply) => {
    const body = parseOr400(updateSiteBodySchema, request.body, reply);
    if (!body) return undefined;

    const existing = await prisma.backlinkSite.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ message: 'Backlink site not found' });

    let data;
    try {
      data = buildSiteWriteData(body, existing);
    } catch (err) {
      return reply.status(400).send({ message: err.message });
    }

    if (data.domain && data.domain !== existing.domain) {
      const clash = await prisma.backlinkSite.findUnique({ where: { domain: data.domain } });
      if (clash) return reply.status(409).send({ message: `${data.domain} is already in the catalog` });
    }

    const site = await prisma.backlinkSite.update({ where: { id: existing.id }, data });
    return reply.send(serializeSiteForAdmin(site));
  });

  app.delete('/backlinks/:id', owner, async (request, reply) => {
    const existing = await prisma.backlinkSite.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { orderItems: true } } },
    });
    if (!existing) return reply.status(404).send({ message: 'Backlink site not found' });

    // Ordered sites are retired rather than deleted so order history stays intact.
    if (existing._count.orderItems > 0) {
      const site = await prisma.backlinkSite.update({
        where: { id: existing.id },
        data: { isActive: false },
      });
      return reply.send({
        deleted: false,
        deactivated: true,
        message: 'Site has order history, so it was deactivated instead of deleted',
        site: serializeSiteForAdmin(site),
      });
    }

    await prisma.backlinkSite.delete({ where: { id: existing.id } });
    return reply.send({ deleted: true, deactivated: false });
  });

  app.post('/backlinks/bulk', owner, async (request, reply) => {
    const body = parseOr400(bulkSiteBodySchema, request.body, reply);
    if (!body) return undefined;

    const { ids, action } = body;

    if (action === 'delete') {
      const withOrders = await prisma.backlinkOrderItem.findMany({
        where: { backlinkSiteId: { in: ids } },
        select: { backlinkSiteId: true },
        distinct: ['backlinkSiteId'],
      });
      const protectedIds = new Set(withOrders.map((row) => row.backlinkSiteId));
      const deletable = ids.filter((id) => !protectedIds.has(id));

      const [deleted, deactivated] = await Promise.all([
        prisma.backlinkSite.deleteMany({ where: { id: { in: deletable } } }),
        protectedIds.size
          ? prisma.backlinkSite.updateMany({
              where: { id: { in: [...protectedIds] } },
              data: { isActive: false },
            })
          : Promise.resolve({ count: 0 }),
      ]);

      return reply.send({
        action,
        deleted: deleted.count,
        deactivatedInsteadOfDeleted: deactivated.count,
      });
    }

    if (action === 'adjustPrice') {
      const sites = await prisma.backlinkSite.findMany({
        where: { id: { in: ids } },
        select: { id: true, da: true, dr: true, monthlyTraffic: true, priceUsd: true },
      });

      let updated = 0;
      for (const site of sites) {
        const nextPrice =
          body.priceUsd != null
            ? body.priceUsd
            : Math.max(1, Math.ceil(Number(site.priceUsd) * (1 + body.percent / 100)));
        const data = buildSiteWriteData({ priceUsd: nextPrice }, site);
        await prisma.backlinkSite.update({ where: { id: site.id }, data });
        updated += 1;
      }
      return reply.send({ action, updated });
    }

    const dataByAction = {
      activate: { isActive: true },
      deactivate: { isActive: false },
      feature: { isFeatured: true },
      unfeature: { isFeatured: false },
    };
    const result = await prisma.backlinkSite.updateMany({
      where: { id: { in: ids } },
      data: dataByAction[action],
    });
    return reply.send({ action, updated: result.count });
  });

  app.post('/backlinks/import', owner, async (request, reply) => {
    const body = parseOr400(importBodySchema, request.body, reply);
    if (!body) return undefined;

    let data = body.data;
    if (!data && body.filePath) {
      const resolved = path.isAbsolute(body.filePath)
        ? body.filePath
        : path.join(BACKEND_ROOT, body.filePath);
      // Keep file reads inside the backend tree.
      if (!path.resolve(resolved).startsWith(BACKEND_ROOT)) {
        return reply.status(400).send({ message: 'filePath must resolve inside the backend directory' });
      }
      try {
        data = JSON.parse(await fs.readFile(resolved, 'utf8'));
      } catch (err) {
        return reply.status(400).send({ message: `Cannot read file: ${err.message}` });
      }
    }

    if (!data?.sites?.length) {
      return reply.status(400).send({ message: 'Provide a catalog document with a non-empty sites array' });
    }

    try {
      const summary = await importBacklinkSites(data, {
        dryRun: Boolean(body.dryRun),
        mode: body.mode,
      });
      return reply.send({ summary });
    } catch (err) {
      request.log.error({ err }, 'Backlink catalog import failed');
      return reply.status(500).send({ message: err.message || 'Import failed' });
    }
  });

  // ── Orders ────────────────────────────────────────────────────────────────

  app.get('/backlink-orders', owner, async (request, reply) => {
    const query = parseOr400(orderQuerySchema, request.query, reply);
    if (!query) return undefined;

    const where = {};
    if (query.status) where.status = query.status;
    if (query.clientId) where.clientId = query.clientId;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search } },
        { client: { agencyName: { contains: query.search } } },
      ];
    }

    const [total, orders, statusCounts] = await Promise.all([
      prisma.backlinkOrder.count({ where }),
      prisma.backlinkOrder.findMany({
        where,
        include: orderInclude,
        orderBy: { submittedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.backlinkOrder.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    return reply.send({
      orders: orders.map((order) => serializeOrder(order, { includeAdminNotes: true })),
      statusCounts: statusCounts.reduce(
        (acc, row) => ({ ...acc, [row.status]: row._count._all }),
        {},
      ),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    });
  });

  app.get('/backlink-orders/:id', owner, async (request, reply) => {
    const order = await prisma.backlinkOrder.findUnique({
      where: { id: request.params.id },
      include: orderInclude,
    });
    if (!order) return reply.status(404).send({ message: 'Order not found' });
    return reply.send(serializeOrder(order, { includeAdminNotes: true }));
  });

  app.patch('/backlink-orders/:id', owner, async (request, reply) => {
    const body = parseOr400(updateOrderBodySchema, request.body, reply);
    if (!body) return undefined;

    const existing = await prisma.backlinkOrder.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ message: 'Order not found' });

    if (body.status && !canTransition(existing.status, body.status)) {
      return reply.status(409).send({
        message: `Cannot move an order from ${existing.status} to ${body.status}`,
      });
    }

    const data = {};
    if (body.adminNotes !== undefined) data.adminNotes = body.adminNotes;
    if (body.status && body.status !== existing.status) {
      data.status = body.status;
      if (body.status === 'APPROVED') data.approvedAt = new Date();
      if (body.status === 'COMPLETED') data.completedAt = new Date();
    }

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.backlinkOrder.update({ where: { id: existing.id }, data });

      // Approval releases every pending item for placement.
      if (data.status === 'APPROVED') {
        await tx.backlinkOrderItem.updateMany({
          where: { orderId: existing.id, status: 'PENDING' },
          data: { status: 'IN_PROGRESS' },
        });
      }
      if (data.status === 'REJECTED' || data.status === 'CANCELLED') {
        await tx.backlinkOrderItem.updateMany({
          where: { orderId: existing.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
          data: { status: 'CANCELLED' },
        });
      }

      if (data.status) {
        await recordOrderEvent(tx, {
          orderId: existing.id,
          actorId: request.user.id,
          eventType: 'STATUS_CHANGED',
          fromStatus: existing.status,
          toStatus: data.status,
          note: body.reason ?? null,
        });
      } else {
        await recordOrderEvent(tx, {
          orderId: existing.id,
          actorId: request.user.id,
          eventType: 'NOTE_UPDATED',
        });
      }

      return updated;
    });

    if (data.status) {
      try {
        await notifyOrderStatus(order, { reason: body.reason });
      } catch (err) {
        request.log.warn({ err }, 'Backlink order status notification failed');
      }
    }

    const full = await prisma.backlinkOrder.findUnique({
      where: { id: order.id },
      include: orderInclude,
    });
    return reply.send(serializeOrder(full, { includeAdminNotes: true }));
  });

  app.patch('/backlink-order-items/:id', owner, async (request, reply) => {
    const body = parseOr400(updateOrderItemBodySchema, request.body, reply);
    if (!body) return undefined;

    const existing = await prisma.backlinkOrderItem.findUnique({
      where: { id: request.params.id },
      include: { order: true },
    });
    if (!existing) return reply.status(404).send({ message: 'Order item not found' });

    const data = {};
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.liveUrl !== undefined) data.liveUrl = body.liveUrl;
    if (body.status) data.status = body.status;

    // Pasting a live URL is the fulfilment action, so it implies LIVE.
    if (body.liveUrl && !body.status && existing.status !== 'LIVE') data.status = 'LIVE';
    if (data.status === 'LIVE' && !existing.publishedAt) data.publishedAt = new Date();

    const wentLive = data.status === 'LIVE' && existing.status !== 'LIVE';

    const { item, order } = await prisma.$transaction(async (tx) => {
      const updatedItem = await tx.backlinkOrderItem.update({
        where: { id: existing.id },
        data,
      });

      await recordOrderEvent(tx, {
        orderId: existing.orderId,
        actorId: request.user.id,
        eventType: 'ITEM_UPDATED',
        toStatus: data.status ?? null,
        note: data.liveUrl ? `${updatedItem.domainSnapshot} -> ${data.liveUrl}` : updatedItem.domainSnapshot,
      });

      // First placement moves the order into fulfilment.
      let updatedOrder = existing.order;
      if (wentLive && existing.order.status === 'APPROVED') {
        updatedOrder = await tx.backlinkOrder.update({
          where: { id: existing.orderId },
          data: { status: 'IN_PROGRESS' },
        });
      }

      // The order completes once nothing is left outstanding.
      const outstanding = await tx.backlinkOrderItem.count({
        where: { orderId: existing.orderId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      });
      if (outstanding === 0 && !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(updatedOrder.status)) {
        updatedOrder = await tx.backlinkOrder.update({
          where: { id: existing.orderId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        await recordOrderEvent(tx, {
          orderId: existing.orderId,
          actorId: request.user.id,
          eventType: 'STATUS_CHANGED',
          fromStatus: existing.order.status,
          toStatus: 'COMPLETED',
          note: 'All links live',
        });
      }

      return { item: updatedItem, order: updatedOrder };
    });

    try {
      if (wentLive) await notifyItemLive(order, item);
      if (order.status === 'COMPLETED') await notifyOrderStatus(order);
    } catch (err) {
      request.log.warn({ err }, 'Backlink item notification failed');
    }

    const full = await prisma.backlinkOrder.findUnique({
      where: { id: existing.orderId },
      include: orderInclude,
    });
    return reply.send(serializeOrder(full, { includeAdminNotes: true }));
  });
}
