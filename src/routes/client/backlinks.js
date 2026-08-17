import { prisma } from '../../lib/prisma.js';
import {
  buildCatalogOrderBy,
  buildCatalogWhere,
  clientCatalogSelect,
  generateOrderNumber,
  notifyOrderSubmitted,
  recordOrderEvent,
  resolveTarget,
  serializeCartItem,
  serializeOrder,
  serializeSiteForClient,
} from '../../lib/backlinksHub.js';
import {
  addCartItemBodySchema,
  catalogQuerySchema,
  checkoutBodySchema,
  updateCartItemBodySchema,
} from '../../schemas/backlinks.js';

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

const cartInclude = {
  site: { select: clientCatalogSelect },
  project: { select: { name: true } },
  wpPage: { select: { title: true, url: true } },
};

const orderInclude = {
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

export async function clientBacklinkRoutes(app) {
  const read = { onRequest: [app.verifyJwt, app.requireClient] };
  const write = { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] };

  function requireScope(request, reply) {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) {
      reply.status(404).send({ message: 'No client account linked to this user' });
      return null;
    }
    return clientIds;
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  app.get('/backlinks', read, async (request, reply) => {
    if (!requireScope(request, reply)) return undefined;

    const query = parseOr400(catalogQuerySchema, request.query, reply);
    if (!query) return undefined;

    const where = buildCatalogWhere(query, { forceActive: true });
    const [total, sites] = await Promise.all([
      prisma.backlinkSite.count({ where }),
      prisma.backlinkSite.findMany({
        where,
        select: clientCatalogSelect,
        orderBy: buildCatalogOrderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return reply.send({
      sites: sites.map(serializeSiteForClient),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    });
  });

  /** Filter bounds and facet options, so the UI never hardcodes slider ranges. */
  app.get('/backlinks/facets', read, async (request, reply) => {
    if (!requireScope(request, reply)) return undefined;

    const where = { isActive: true };
    const [aggregate, categories, countries, languages, placements] = await Promise.all([
      prisma.backlinkSite.aggregate({
        where,
        _count: { _all: true },
        _min: { priceUsd: true, da: true, dr: true, monthlyTraffic: true },
        _max: { priceUsd: true, da: true, dr: true, monthlyTraffic: true },
      }),
      prisma.backlinkSite.groupBy({
        by: ['category'],
        where: { ...where, category: { not: null } },
        _count: { _all: true },
      }),
      prisma.backlinkSite.groupBy({
        by: ['country'],
        where: { ...where, country: { not: null } },
        _count: { _all: true },
      }),
      prisma.backlinkSite.groupBy({
        by: ['language'],
        where: { ...where, language: { not: null } },
        _count: { _all: true },
      }),
      prisma.backlinkSite.groupBy({ by: ['placementType'], where, _count: { _all: true } }),
    ]);

    const facet = (rows, key) =>
      rows
        .map((row) => ({ value: row[key], count: row._count._all }))
        .filter((row) => row.value)
        .sort((a, b) => b.count - a.count);

    return reply.send({
      total: aggregate._count._all,
      priceUsd: {
        min: Number(aggregate._min.priceUsd ?? 0),
        max: Number(aggregate._max.priceUsd ?? 0),
      },
      da: { min: aggregate._min.da ?? 0, max: aggregate._max.da ?? 100 },
      dr: { min: aggregate._min.dr ?? 0, max: aggregate._max.dr ?? 100 },
      monthlyTraffic: {
        min: aggregate._min.monthlyTraffic ?? 0,
        max: aggregate._max.monthlyTraffic ?? 0,
      },
      categories: facet(categories, 'category'),
      countries: facet(countries, 'country'),
      languages: facet(languages, 'language'),
      placementTypes: facet(placements, 'placementType'),
    });
  });

  /**
   * Projects and their synced WordPress pages, used by the target picker so a
   * client can point a link at a specific page or at the site's domain.
   */
  app.get('/backlinks/targets', read, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const projects = await prisma.project.findMany({
      where: { clientId: { in: clientIds } },
      select: {
        id: true,
        name: true,
        wpUrl: true,
        client: { select: { websiteUrl: true } },
        wpPages: {
          where: { status: 'publish' },
          select: { id: true, title: true, url: true, slug: true, postType: true },
          orderBy: { title: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    return reply.send({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        domainUrl: project.wpUrl || project.client?.websiteUrl || null,
        pages: project.wpPages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          slug: page.slug,
          postType: page.postType,
        })),
      })),
    });
  });

  /** Remaining monthly allowance from the client's package, when one is set. */
  app.get('/backlinks/allowance', read, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const clients = await prisma.clientAccount.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, package: { select: { backlinksLimit: true } } },
    });

    const limit = clients.reduce((acc, client) => {
      const value = client.package?.backlinksLimit;
      return value == null ? acc : (acc ?? 0) + value;
    }, null);

    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    const used = await prisma.backlinkOrderItem.count({
      where: {
        order: {
          clientId: { in: clientIds },
          status: { notIn: ['REJECTED', 'CANCELLED', 'DRAFT'] },
          submittedAt: { gte: periodStart },
        },
        status: { not: 'CANCELLED' },
      },
    });

    return reply.send({
      limit,
      used,
      remaining: limit == null ? null : Math.max(0, limit - used),
      periodStart,
    });
  });

  // ── Cart ──────────────────────────────────────────────────────────────────

  app.get('/backlink-cart', read, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const items = await prisma.backlinkCartItem.findMany({
      where: { clientId: { in: clientIds } },
      include: cartInclude,
      orderBy: { createdAt: 'desc' },
    });

    const subtotalUsd = items.reduce((sum, item) => sum + Number(item.unitPriceUsd), 0);
    return reply.send({
      items: items.map(serializeCartItem),
      itemCount: items.length,
      subtotalUsd: Math.round(subtotalUsd * 100) / 100,
    });
  });

  app.post('/backlink-cart', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const body = parseOr400(addCartItemBodySchema, request.body, reply);
    if (!body) return undefined;

    // Clients acting across several accounts add to the scoped one.
    const clientId = clientIds[0];

    const site = await prisma.backlinkSite.findFirst({
      where: { id: body.backlinkSiteId, isActive: true },
      select: { id: true, priceUsd: true },
    });
    if (!site) return reply.status(404).send({ message: 'Backlink site is not available' });

    const { target, error } = await resolveTarget({
      clientIds,
      projectId: body.projectId,
      targetType: body.targetType,
      wpPageId: body.wpPageId,
      targetUrl: body.targetUrl,
    });
    if (error) return reply.status(400).send({ message: error });

    const duplicate = await prisma.backlinkCartItem.findFirst({
      where: { clientId, backlinkSiteId: site.id, wpPageId: target.wpPageId },
      select: { id: true },
    });
    if (duplicate) {
      return reply.status(409).send({ message: 'This site is already in your cart for that target' });
    }

    const created = await prisma.backlinkCartItem.create({
      data: {
        clientId,
        backlinkSiteId: site.id,
        ...target,
        anchorText: body.anchorText ?? null,
        notes: body.notes ?? null,
        unitPriceUsd: site.priceUsd,
        addedById: request.user.id,
      },
      include: cartInclude,
    });

    return reply.status(201).send(serializeCartItem(created));
  });

  app.patch('/backlink-cart/:id', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const body = parseOr400(updateCartItemBodySchema, request.body, reply);
    if (!body) return undefined;

    const existing = await prisma.backlinkCartItem.findFirst({
      where: { id: request.params.id, clientId: { in: clientIds } },
    });
    if (!existing) return reply.status(404).send({ message: 'Cart item not found' });

    const data = {};
    if (body.anchorText !== undefined) data.anchorText = body.anchorText;
    if (body.notes !== undefined) data.notes = body.notes;

    const retargeting =
      body.targetType !== undefined || body.wpPageId !== undefined || body.projectId !== undefined;

    if (retargeting) {
      const { target, error } = await resolveTarget({
        clientIds,
        projectId: body.projectId ?? existing.projectId,
        targetType: body.targetType ?? existing.targetType,
        wpPageId: body.wpPageId ?? existing.wpPageId,
        targetUrl: body.targetUrl ?? existing.targetUrl,
      });
      if (error) return reply.status(400).send({ message: error });
      Object.assign(data, target);
    } else if (body.targetUrl !== undefined) {
      data.targetUrl = body.targetUrl;
    }

    const updated = await prisma.backlinkCartItem.update({
      where: { id: existing.id },
      data,
      include: cartInclude,
    });
    return reply.send(serializeCartItem(updated));
  });

  app.delete('/backlink-cart/:id', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const existing = await prisma.backlinkCartItem.findFirst({
      where: { id: request.params.id, clientId: { in: clientIds } },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ message: 'Cart item not found' });

    await prisma.backlinkCartItem.delete({ where: { id: existing.id } });
    return reply.send({ deleted: true });
  });

  app.delete('/backlink-cart', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const result = await prisma.backlinkCartItem.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    return reply.send({ deleted: result.count });
  });

  // ── Orders ────────────────────────────────────────────────────────────────

  app.post('/backlink-orders', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const body = parseOr400(checkoutBodySchema, request.body, reply);
    if (!body) return undefined;

    const cartItems = await prisma.backlinkCartItem.findMany({
      where: { clientId: { in: clientIds } },
      include: { site: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!cartItems.length) return reply.status(400).send({ message: 'Your cart is empty' });

    const unavailable = cartItems.filter((item) => !item.site?.isActive);
    if (unavailable.length) {
      return reply.status(409).send({
        message: 'Some sites in your cart are no longer available',
        domains: unavailable.map((item) => item.site?.domain).filter(Boolean),
      });
    }

    const clientId = cartItems[0].clientId;
    const subtotalUsd =
      Math.round(cartItems.reduce((sum, item) => sum + Number(item.unitPriceUsd), 0) * 100) / 100;

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.backlinkOrder.create({
        data: {
          orderNumber: await generateOrderNumber(tx),
          clientId,
          status: 'PENDING_REVIEW',
          subtotalUsd,
          totalUsd: subtotalUsd,
          itemCount: cartItems.length,
          requestedById: request.user.id,
          clientNotes: body.clientNotes ?? null,
          submittedAt: new Date(),
          items: {
            create: cartItems.map((item) => ({
              backlinkSiteId: item.backlinkSiteId,
              domainSnapshot: item.site.domain,
              daSnapshot: item.site.da,
              drSnapshot: item.site.dr,
              trafficSnapshot: item.site.monthlyTraffic,
              unitPriceUsd: item.unitPriceUsd,
              dofollowLinks: item.site.dofollowLinks,
              placementType: item.site.placementType,
              projectId: item.projectId,
              targetType: item.targetType,
              wpPageId: item.wpPageId,
              targetUrl: item.targetUrl,
              anchorText: item.anchorText,
              notes: item.notes,
            })),
          },
        },
      });

      await recordOrderEvent(tx, {
        orderId: created.id,
        actorId: request.user.id,
        eventType: 'SUBMITTED',
        toStatus: 'PENDING_REVIEW',
        note: `${cartItems.length} link(s) requested`,
      });

      await tx.backlinkCartItem.deleteMany({ where: { id: { in: cartItems.map((i) => i.id) } } });
      return created;
    });

    try {
      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { agencyName: true },
      });
      await notifyOrderSubmitted(order, client?.agencyName);
    } catch (err) {
      request.log.warn({ err }, 'Backlink order submitted notification failed');
    }

    const full = await prisma.backlinkOrder.findUnique({
      where: { id: order.id },
      include: orderInclude,
    });
    return reply.status(201).send(serializeOrder(full));
  });

  app.get('/backlink-orders', read, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const orders = await prisma.backlinkOrder.findMany({
      where: { clientId: { in: clientIds } },
      include: orderInclude,
      orderBy: { submittedAt: 'desc' },
      take: 100,
    });

    return reply.send({ orders: orders.map((order) => serializeOrder(order)) });
  });

  app.get('/backlink-orders/:id', read, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const order = await prisma.backlinkOrder.findFirst({
      where: { id: request.params.id, clientId: { in: clientIds } },
      include: orderInclude,
    });
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    return reply.send(serializeOrder(order));
  });

  app.post('/backlink-orders/:id/cancel', write, async (request, reply) => {
    const clientIds = requireScope(request, reply);
    if (!clientIds) return undefined;

    const existing = await prisma.backlinkOrder.findFirst({
      where: { id: request.params.id, clientId: { in: clientIds } },
    });
    if (!existing) return reply.status(404).send({ message: 'Order not found' });

    // Once the agency has approved an order, placement may already be under way.
    if (existing.status !== 'PENDING_REVIEW') {
      return reply.status(409).send({
        message: 'Only orders still awaiting review can be cancelled. Contact your account manager.',
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.backlinkOrder.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
      });
      await tx.backlinkOrderItem.updateMany({
        where: { orderId: existing.id },
        data: { status: 'CANCELLED' },
      });
      await recordOrderEvent(tx, {
        orderId: existing.id,
        actorId: request.user.id,
        eventType: 'STATUS_CHANGED',
        fromStatus: existing.status,
        toStatus: 'CANCELLED',
        note: 'Cancelled by client',
      });
    });

    const full = await prisma.backlinkOrder.findUnique({
      where: { id: existing.id },
      include: orderInclude,
    });
    return reply.send(serializeOrder(full));
  });
}
