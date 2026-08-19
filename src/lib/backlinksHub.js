import { prisma } from './prisma.js';
import { notify } from './notificationService.js';
import { calcValueScore, normalizeDomain, normalizeSiteUrl } from './dataImport/backlinkNormalize.js';

/** Columns safe to expose in the client-facing catalog. */
const CLIENT_SITE_FIELDS = {
  id: true,
  domain: true,
  url: true,
  da: true,
  dr: true,
  monthlyTraffic: true,
  priceUsd: true,
  valueScore: true,
  dofollowLinks: true,
  placementType: true,
  category: true,
  country: true,
  language: true,
  turnaroundDays: true,
  sampleUrl: true,
  isFeatured: true,
  tags: true,
};

export const ORDER_STATUS_FLOW = {
  DRAFT: ['PENDING_REVIEW', 'CANCELLED'],
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (ORDER_STATUS_FLOW[from] || []).includes(to);
}

/**
 * Whitelists catalog fields for client responses. `internalNotes`, `isActive`
 * and timestamps never leave the admin surface.
 */
export function serializeSiteForClient(site) {
  if (!site) return null;
  return {
    id: site.id,
    domain: site.domain,
    url: site.url,
    da: site.da,
    dr: site.dr,
    monthlyTraffic: site.monthlyTraffic,
    priceUsd: Number(site.priceUsd),
    valueScore: Number(site.valueScore),
    dofollowLinks: site.dofollowLinks,
    placementType: site.placementType,
    category: site.category ?? null,
    country: site.country ?? null,
    language: site.language ?? null,
    turnaroundDays: site.turnaroundDays ?? null,
    sampleUrl: site.sampleUrl ?? null,
    isFeatured: site.isFeatured,
    tags: site.tags ?? null,
  };
}

export function serializeSiteForAdmin(site) {
  if (!site) return null;
  return {
    ...serializeSiteForClient(site),
    isActive: site.isActive,
    internalNotes: site.internalNotes ?? null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    orderCount: site._count?.orderItems ?? undefined,
  };
}

export const clientCatalogSelect = CLIENT_SITE_FIELDS;

/** Translates validated catalog query params into a Prisma where clause. */
export function buildCatalogWhere(query, { forceActive = false } = {}) {
  const where = {};

  if (forceActive) where.isActive = true;
  else if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [{ domain: { contains: query.search } }, { url: { contains: query.search } }];
  }

  const range = (field, min, max) => {
    if (min === undefined && max === undefined) return;
    where[field] = {};
    if (min !== undefined) where[field].gte = min;
    if (max !== undefined) where[field].lte = max;
  };
  range('da', query.minDa, query.maxDa);
  range('dr', query.minDr, query.maxDr);
  range('monthlyTraffic', query.minTraffic, query.maxTraffic);
  range('priceUsd', query.minPrice, query.maxPrice);

  if (query.dofollowLinks !== undefined) where.dofollowLinks = query.dofollowLinks;
  if (query.placementType) where.placementType = query.placementType;
  if (query.category) where.category = query.category;
  if (query.country) where.country = query.country;
  if (query.language) where.language = query.language;
  if (query.isFeatured !== undefined) where.isFeatured = query.isFeatured;

  return where;
}

export function buildCatalogOrderBy(query) {
  const primary = { [query.sortBy]: query.sortDir };
  // Stable tiebreaker so pagination cannot repeat or skip rows.
  return query.sortBy === 'domain' ? [primary] : [primary, { domain: 'asc' }];
}

/**
 * Normalizes an admin-supplied site payload: derives the canonical domain/url and
 * recomputes valueScore whenever a metric or price changes.
 */
export function buildSiteWriteData(body, existing = null) {
  const data = { ...body };

  if (body.domain !== undefined) {
    const domain = normalizeDomain(body.domain);
    if (!domain) throw Object.assign(new Error('Invalid domain'), { statusCode: 400 });
    data.domain = domain;
    data.url = body.url?.trim() || normalizeSiteUrl(domain);
  } else if (body.url !== undefined) {
    data.url = body.url?.trim() || existing?.url;
  }

  const merged = {
    da: data.da ?? existing?.da ?? 0,
    dr: data.dr ?? existing?.dr ?? 0,
    monthlyTraffic: data.monthlyTraffic ?? existing?.monthlyTraffic ?? 0,
    priceUsd: data.priceUsd ?? Number(existing?.priceUsd ?? 0),
  };
  data.valueScore = calcValueScore(merged);

  return data;
}

/** Sequential, human-readable order reference, e.g. BL-2026-0042. */
export async function generateOrderNumber(tx = prisma) {
  const year = new Date().getFullYear();
  const prefix = `BL-${year}-`;
  const latest = await tx.backlinkOrder.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: 'desc' },
    select: { orderNumber: true },
  });
  const sequence = latest ? Number.parseInt(latest.orderNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

export function serializeOrderItem(item) {
  return {
    id: item.id,
    backlinkSiteId: item.backlinkSiteId,
    domain: item.domainSnapshot,
    da: item.daSnapshot,
    dr: item.drSnapshot,
    monthlyTraffic: item.trafficSnapshot,
    unitPriceUsd: Number(item.unitPriceUsd),
    dofollowLinks: item.dofollowLinks,
    placementType: item.placementType,
    projectId: item.projectId,
    projectName: item.project?.name ?? null,
    targetType: item.targetType,
    wpPageId: item.wpPageId,
    targetPageTitle: item.wpPage?.title ?? null,
    targetUrl: item.targetUrl,
    anchorText: item.anchorText,
    notes: item.notes,
    status: item.status,
    liveUrl: item.liveUrl,
    publishedAt: item.publishedAt,
  };
}

export function serializeOrder(order, { includeAdminNotes = false } = {}) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    clientId: order.clientId,
    clientName: order.client?.agencyName ?? null,
    status: order.status,
    subtotalUsd: Number(order.subtotalUsd),
    totalUsd: Number(order.totalUsd),
    itemCount: order.itemCount,
    paymentStatus: order.paymentStatus,
    requestedByName: order.requestedBy?.name ?? null,
    clientNotes: order.clientNotes,
    ...(includeAdminNotes ? { adminNotes: order.adminNotes } : {}),
    submittedAt: order.submittedAt,
    approvedAt: order.approvedAt,
    completedAt: order.completedAt,
    items: order.items ? order.items.map(serializeOrderItem) : undefined,
    events: order.events
      ? order.events.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          note: event.note,
          actorName: event.actor?.name ?? null,
          createdAt: event.createdAt,
        }))
      : undefined,
  };
}

export function serializeCartItem(item) {
  return {
    id: item.id,
    site: serializeSiteForClient(item.site),
    projectId: item.projectId,
    projectName: item.project?.name ?? null,
    targetType: item.targetType,
    wpPageId: item.wpPageId,
    targetPageTitle: item.wpPage?.title ?? null,
    targetPageUrl: item.wpPage?.url ?? null,
    targetUrl: item.targetUrl,
    anchorText: item.anchorText,
    notes: item.notes,
    unitPriceUsd: Number(item.unitPriceUsd),
    createdAt: item.createdAt,
  };
}

export async function recordOrderEvent(tx, { orderId, actorId, eventType, fromStatus, toStatus, note, metadata }) {
  return tx.backlinkOrderEvent.create({
    data: {
      orderId,
      actorId: actorId ?? null,
      eventType,
      fromStatus: fromStatus ?? null,
      toStatus: toStatus ?? null,
      note: note ?? null,
      metadata: metadata ?? undefined,
    },
  });
}

/**
 * Verifies a requested target belongs to the acting client, so a client can never
 * point a backlink at another tenant's project or page.
 */
export async function resolveTarget({ clientIds, projectId, targetType, wpPageId, targetUrl }) {
  if (targetType === 'PAGE') {
    if (!wpPageId) return { error: 'A target page is required' };
    const page = await prisma.wpPage.findFirst({
      where: { id: wpPageId, project: { clientId: { in: clientIds } } },
      select: { id: true, url: true, projectId: true, title: true },
    });
    if (!page) return { error: 'Target page not found for this client' };
    if (projectId && projectId !== page.projectId) {
      return { error: 'Target page does not belong to the selected project' };
    }
    return {
      target: {
        projectId: page.projectId,
        targetType: 'PAGE',
        wpPageId: page.id,
        targetUrl: page.url,
      },
    };
  }

  if (!projectId) return { error: 'A project is required when linking to the domain' };
  const project = await prisma.project.findFirst({
    where: { id: projectId, clientId: { in: clientIds } },
    select: { id: true, wpUrl: true, client: { select: { websiteUrl: true } } },
  });
  if (!project) return { error: 'Project not found for this client' };

  const domainUrl = targetUrl?.trim() || project.wpUrl || project.client?.websiteUrl || null;
  if (!domainUrl) {
    return { error: 'This project has no website URL yet. Add one or pick a specific page.' };
  }

  return {
    target: {
      projectId: project.id,
      targetType: 'DOMAIN',
      wpPageId: null,
      targetUrl: domainUrl,
    },
  };
}

/** Owner accounts receive new-request notifications. */
async function ownerRecipientIds() {
  const owners = await prisma.user.findMany({
    where: { role: 'OWNER', isActive: true },
    select: { id: true },
  });
  return owners.map((o) => o.id);
}

async function clientRecipientIds(clientId) {
  const users = await prisma.clientUser.findMany({
    where: { clientId },
    select: { userId: true },
  });
  return users.map((u) => u.userId);
}

const usd = (value) => `$${Number(value).toFixed(2)}`;

export async function notifyOrderSubmitted(order, clientName) {
  const recipientIds = await ownerRecipientIds();
  if (!recipientIds.length) return;
  await notify({
    slug: 'backlink_order_submitted',
    recipientIds,
    variables: {
      orderNumber: order.orderNumber,
      clientName: clientName || '',
      itemCount: String(order.itemCount),
      totalUsd: usd(order.totalUsd),
    },
    actionUrl: `/portal/admin/backlink-orders?order=${order.id}`,
    metadata: { backlinkOrderId: order.id },
  });
}

export async function notifyOrderStatus(order, { reason } = {}) {
  const slugByStatus = {
    APPROVED: 'backlink_order_approved',
    REJECTED: 'backlink_order_rejected',
    COMPLETED: 'backlink_order_completed',
  };
  const slug = slugByStatus[order.status];
  if (!slug) return;

  const recipientIds = await clientRecipientIds(order.clientId);
  if (!recipientIds.length) return;

  await notify({
    slug,
    recipientIds,
    variables: {
      orderNumber: order.orderNumber,
      itemCount: String(order.itemCount),
      totalUsd: usd(order.totalUsd),
      reason: reason || 'Please contact your account manager for details.',
    },
    actionUrl: `/portal/client/backlinks/orders/${order.id}`,
    metadata: { backlinkOrderId: order.id },
  });
}

export async function notifyItemLive(order, item) {
  const recipientIds = await clientRecipientIds(order.clientId);
  if (!recipientIds.length) return;
  await notify({
    slug: 'backlink_item_live',
    recipientIds,
    variables: {
      orderNumber: order.orderNumber,
      domain: item.domainSnapshot,
      liveUrl: item.liveUrl || '',
      targetLabel: item.targetUrl || item.domainSnapshot,
    },
    actionUrl: `/portal/client/backlinks/orders/${order.id}`,
    metadata: { backlinkOrderId: order.id, backlinkOrderItemId: item.id },
  });
}
