/**
 * Content Map performance enrichment and health analysis.
 *
 * Performance is joined at read time: GA4 stores landing-page rows inside the
 * latest Ga4DailyMetric.breakdowns, and Bridge lead events carry pagePath, so
 * both can be matched to a node by normalized path without a new sync.
 */
import { prisma } from './prisma.js';
import {
  buildSiteInventory,
  normalizePath,
  enrichPage,
  THIN_CONTENT_WORDS,
  STALE_CONTENT_DAYS,
  SEO_TITLE_MAX,
  SEO_DESCRIPTION_MAX,
} from './contentMapSync.js';

const LEAD_LOOKBACK_DAYS = 90;

/* ────────────────────────── Performance joins ────────────────────────── */

/** Latest GA4 landing-page rows for a project, keyed by normalized path. */
export async function loadLandingPageMetrics(projectId) {
  const row = await prisma.ga4DailyMetric.findFirst({
    where: { projectId, breakdowns: { not: null } },
    orderBy: { date: 'desc' },
    select: { date: true, breakdowns: true },
  });
  const landingPages = Array.isArray(row?.breakdowns?.landingPages) ? row.breakdowns.landingPages : [];

  const byPath = new Map();
  for (const item of landingPages) {
    const raw = item.landingPage || item.page || item.path || item.name;
    const path = normalizePath(raw);
    if (!path) continue;
    const existing = byPath.get(path);
    const next = {
      sessions: Math.round(item.sessions || 0),
      conversions: Math.round(item.conversions || 0),
      bounceRate: item.bounceRate ?? null,
      avgSessionSec: item.averageSessionDuration ?? null,
    };
    // GA4 can emit the same landing page more than once across parameter variants.
    byPath.set(
      path,
      existing
        ? {
            sessions: existing.sessions + next.sessions,
            conversions: existing.conversions + next.conversions,
            bounceRate: existing.bounceRate ?? next.bounceRate,
            avgSessionSec: existing.avgSessionSec ?? next.avgSessionSec,
          }
        : next
    );
  }
  return { byPath, range: row?.breakdowns?.range || null, asOf: row?.date || null };
}

/** Lead events per page path over the recent window. */
export async function loadLeadMetrics(projectId) {
  const since = new Date(Date.now() - LEAD_LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.siteLeadEvent.groupBy({
    by: ['pagePath'],
    where: { projectId, occurredAt: { gte: since } },
    _count: { _all: true },
  });
  const byPath = new Map();
  for (const row of rows) {
    const path = normalizePath(row.pagePath);
    if (!path) continue;
    byPath.set(path, (byPath.get(path) || 0) + row._count._all);
  }
  return { byPath, days: LEAD_LOOKBACK_DAYS };
}

/** Approved/tracked keywords per target path, so a node can show its terms. */
export async function loadKeywordsByPath(projectId) {
  const rows = await prisma.keywordTrack.findMany({
    where: { projectId },
    select: {
      id: true,
      keyword: true,
      status: true,
      currentRank: true,
      volume: true,
      targetUrl: true,
      sitemapNode: { select: { url: true } },
    },
  });
  const byPath = new Map();
  for (const row of rows) {
    const path = normalizePath(row.sitemapNode?.url || row.targetUrl);
    if (!path) continue;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push({
      keywordTrackId: row.id,
      keyword: row.keyword,
      status: row.status,
      currentRank: row.currentRank,
      volume: row.volume,
    });
  }
  return byPath;
}

/**
 * Recompute cached metrics for every node in a map, merging freshly parsed
 * content detail with GA4 sessions, lead counts, and target keywords.
 */
export async function refreshNodeMetrics(mapId) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    select: { id: true, projectId: true },
  });
  if (!map) return { ok: false, error: 'Content map not found' };

  const [inventory, landing, leads, keywordsByPath] = await Promise.all([
    buildSiteInventory(map.projectId),
    loadLandingPageMetrics(map.projectId),
    loadLeadMetrics(map.projectId),
    loadKeywordsByPath(map.projectId),
  ]);

  const inventoryByPageId = new Map(inventory.items.map((i) => [i.page.id, i]));
  const nodes = await prisma.contentMapNode.findMany({
    where: { mapId },
    select: { id: true, slug: true, url: true, wpPageId: true, metrics: true },
  });

  let updated = 0;
  const now = new Date();

  for (const node of nodes) {
    const path = normalizePath(node.url || node.slug);
    const item = node.wpPageId ? inventoryByPageId.get(node.wpPageId) : path ? inventory.byPath.get(path) : null;

    const base = item ? item.enrichment : node.metrics && typeof node.metrics === 'object' ? node.metrics : {};
    const traffic = path ? landing.byPath.get(path) : null;
    const leadCount = path ? leads.byPath.get(path) : null;
    const keywords = path ? keywordsByPath.get(path) : null;

    const metrics = {
      ...base,
      sessions: traffic?.sessions ?? null,
      conversions: traffic?.conversions ?? null,
      bounceRate: traffic?.bounceRate ?? null,
      avgSessionSec: traffic?.avgSessionSec ?? null,
      leads: leadCount ?? null,
      leadWindowDays: leads.days,
      trafficAsOf: landing.asOf,
    };

    await prisma.contentMapNode.update({
      where: { id: node.id },
      data: {
        metrics,
        metricsAt: now,
        ...(keywords?.length ? { keywords } : {}),
      },
    });
    updated++;
  }

  return { ok: true, updated, pages: inventory.items.length };
}

/* ────────────────────────── Health ────────────────────────── */

function nodeMetrics(node) {
  return node.metrics && typeof node.metrics === 'object' ? node.metrics : {};
}

function summarize(node) {
  return { id: node.id, name: node.name, slug: node.slug, url: node.url, lifecycle: node.lifecycle };
}

/**
 * Issue counts plus the offending nodes, so the UI can filter the canvas by
 * clicking a number. Every check is derived from data already on the node.
 */
export async function computeMapHealth(mapId) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    select: { id: true, projectId: true },
  });
  if (!map) return null;

  const nodes = await prisma.contentMapNode.findMany({
    where: { mapId },
    select: {
      id: true,
      name: true,
      slug: true,
      url: true,
      kind: true,
      source: true,
      lifecycle: true,
      wpPageId: true,
      plannedPublishDate: true,
      keywords: true,
      metrics: true,
    },
  });

  const inventory = await buildSiteInventory(map.projectId);
  const mappedWpPageIds = new Set(nodes.filter((n) => n.wpPageId).map((n) => n.wpPageId));
  const unmapped = inventory.items.filter((i) => !mappedWpPageIds.has(i.page.id));

  const live = nodes.filter((n) => n.lifecycle === 'LIVE');
  const planned = nodes.filter((n) => n.lifecycle === 'PLANNED');
  const inPipeline = nodes.filter((n) => n.lifecycle === 'IN_PIPELINE');
  const gaps = nodes.filter((n) => n.lifecycle === 'GAP');

  // The home page is linked from the theme header, which never appears in post
  // content, so it would always read as an orphan. Exclude it.
  const orphans = live.filter(
    (n) => nodeMetrics(n).isOrphan && n.kind !== 'ROOT' && normalizePath(n.url || n.slug) !== '/'
  );
  const thin = live.filter((n) => nodeMetrics(n).isThin);
  const stale = live.filter((n) => nodeMetrics(n).isStale);
  const missingSeoTitle = live.filter((n) => nodeMetrics(n).hasSeoTitle === false);
  const missingSeoDescription = live.filter((n) => nodeMetrics(n).hasSeoDescription === false);
  const seoTooLong = live.filter(
    (n) => nodeMetrics(n).seoTitleTooLong || nodeMetrics(n).seoDescriptionTooLong
  );

  const today = new Date();
  const overdue = nodes.filter(
    (n) =>
      n.plannedPublishDate &&
      new Date(n.plannedPublishDate) < today &&
      n.lifecycle !== 'LIVE' &&
      n.lifecycle !== 'ARCHIVED'
  );
  const unscheduled = planned.filter((n) => !n.plannedPublishDate);

  // Two nodes chasing the same keyword will fight each other in the SERP.
  const byKeyword = new Map();
  for (const node of nodes) {
    const list = Array.isArray(node.keywords) ? node.keywords : [];
    for (const entry of list) {
      const keyword = String(entry?.keyword || '').toLowerCase().trim();
      if (!keyword) continue;
      if (!byKeyword.has(keyword)) byKeyword.set(keyword, []);
      byKeyword.get(keyword).push(node);
    }
  }
  const cannibalization = [...byKeyword.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([keyword, list]) => ({ keyword, nodes: list.map(summarize) }))
    .slice(0, 50);

  const pendingDrift = await prisma.contentMapDrift.count({ where: { mapId, status: 'PENDING' } });

  const coveragePct = inventory.items.length
    ? Math.round(((inventory.items.length - unmapped.length) / inventory.items.length) * 100)
    : 100;

  const issue = (nodes_, extra = {}) => ({ count: nodes_.length, nodes: nodes_.slice(0, 100).map(summarize), ...extra });

  return {
    generatedAt: new Date().toISOString(),
    thresholds: {
      thinWords: THIN_CONTENT_WORDS,
      staleDays: STALE_CONTENT_DAYS,
      seoTitleMax: SEO_TITLE_MAX,
      seoDescriptionMax: SEO_DESCRIPTION_MAX,
    },
    coverage: {
      sitePages: inventory.items.length,
      mappedPages: inventory.items.length - unmapped.length,
      unmappedPages: unmapped.length,
      coveragePct,
      unmapped: unmapped.slice(0, 100).map((i) => ({
        wpPageId: i.page.id,
        title: i.page.title,
        url: i.page.url,
        path: i.path,
        status: i.page.status,
        postType: i.page.postType,
      })),
    },
    counts: {
      total: nodes.length,
      live: live.length,
      planned: planned.length,
      inPipeline: inPipeline.length,
      gaps: gaps.length,
      pendingDrift,
    },
    issues: {
      orphans: issue(orphans),
      thin: issue(thin),
      stale: issue(stale),
      missingSeoTitle: issue(missingSeoTitle),
      missingSeoDescription: issue(missingSeoDescription),
      seoTooLong: issue(seoTooLong),
      overdue: issue(overdue),
      unscheduled: issue(unscheduled),
      structuralGaps: issue(gaps),
      cannibalization: { count: cannibalization.length, items: cannibalization },
    },
  };
}

/** Per-page detail for a single node, recomputed live from the stored content. */
export async function loadNodeDetail(nodeId) {
  const node = await prisma.contentMapNode.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      mapId: true,
      name: true,
      slug: true,
      url: true,
      wpPageId: true,
      metrics: true,
      map: { select: { projectId: true } },
    },
  });
  if (!node) return null;

  const projectId = node.map.projectId;
  const path = normalizePath(node.url || node.slug);

  let page = null;
  if (node.wpPageId) {
    page = await prisma.wpPage.findUnique({
      where: { id: node.wpPageId },
      select: {
        id: true,
        wpPostId: true,
        title: true,
        url: true,
        status: true,
        postType: true,
        template: true,
        seoTitle: true,
        seoDescription: true,
        featuredImageUrl: true,
        excerpt: true,
        content: true,
        modifiedAt: true,
        syncedAt: true,
      },
    });
  }

  const enrichment = page ? enrichPage(page) : nodeMetrics(node);

  // Resolve link paths back to sibling nodes so the panel can offer jumps.
  const siblings = await prisma.contentMapNode.findMany({
    where: { mapId: node.mapId },
    select: { id: true, name: true, slug: true, url: true, lifecycle: true },
  });
  const siblingByPath = new Map();
  for (const sibling of siblings) {
    const key = normalizePath(sibling.url || sibling.slug);
    if (key && !siblingByPath.has(key)) siblingByPath.set(key, sibling);
  }
  const resolveLinks = (paths) =>
    (paths || []).slice(0, 100).map((p) => ({ path: p, node: siblingByPath.get(p) || null }));

  const storedMetrics = nodeMetrics(node);
  const snapshots = page
    ? await prisma.wpPageSnapshot.findMany({
        where: { wpPageId: page.id },
        orderBy: { syncedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          eventType: true,
          title: true,
          status: true,
          aiSummary: true,
          wpUserName: true,
          syncedAt: true,
        },
      })
    : [];

  const events = await prisma.contentMapEvent.findMany({
    where: { nodeId: node.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { user: { select: { id: true, name: true } } },
  });

  const [landing, leads] = await Promise.all([
    loadLandingPageMetrics(projectId),
    loadLeadMetrics(projectId),
  ]);

  return {
    nodeId: node.id,
    page: page
      ? {
          wpPostId: page.wpPostId,
          title: page.title,
          url: page.url,
          status: page.status,
          postType: page.postType,
          template: page.template,
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          featuredImageUrl: page.featuredImageUrl,
          excerpt: page.excerpt,
          modifiedAt: page.modifiedAt,
          syncedAt: page.syncedAt,
        }
      : null,
    enrichment: {
      ...enrichment,
      internalLinksIn: storedMetrics.internalLinksIn ?? enrichment.internalLinksIn ?? null,
      inboundPaths: storedMetrics.inboundPaths ?? [],
      isOrphan: storedMetrics.isOrphan ?? null,
    },
    links: {
      outbound: resolveLinks(enrichment.outboundInternalPaths),
      inbound: resolveLinks(storedMetrics.inboundPaths),
    },
    performance: {
      ...(path ? landing.byPath.get(path) || {} : {}),
      leads: path ? leads.byPath.get(path) ?? null : null,
      leadWindowDays: leads.days,
      asOf: landing.asOf,
    },
    snapshots,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      message: e.message,
      metadata: e.metadata,
      createdAt: e.createdAt,
      user: e.user ? { id: e.user.id, name: e.user.name } : null,
    })),
  };
}
