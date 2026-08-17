/**
 * Content Map ↔ WordPress sync.
 *
 * Turns the WpPage rows kept fresh by wpSync.js into content map nodes, derives
 * the tree from URL path depth (the plugin payload has no post_parent), and
 * enriches each node with details computed from the stored post content.
 *
 * Reconciliation never mutates the map behind the PM's back: differences land in
 * ContentMapDrift for review. The single exception is a planned node whose slug
 * or URL exactly matches newly published content — that flips to LIVE on its own.
 */
import { prisma } from './prisma.js';
import { logEvent, publishContentMapUpdate, notifyContentMap, resolveContentMapRecipients } from './contentMapService.js';

/** WP statuses that mean the content is publicly live. */
const LIVE_STATUSES = new Set(['publish', 'published']);
/** WP statuses that mean the content exists but is not public yet. */
const PENDING_STATUSES = new Set(['draft', 'pending', 'future', 'private']);

const KIND_BY_DEPTH = ['ROOT', 'PILLAR', 'CLUSTER', 'PAGE'];

export const THIN_CONTENT_WORDS = 300;
export const STALE_CONTENT_DAYS = 365;
export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 160;

/* ────────────────────────── URL helpers ────────────────────────── */

/**
 * Reduce a URL or slug to a comparable path: leading slash, trailing slash,
 * lowercase, no host, no query or hash.
 */
export function normalizePath(input) {
  let value = String(input || '').trim();
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
  } catch {
    /* fall through and treat as a raw path */
  }
  value = value.split('?')[0].split('#')[0].toLowerCase();
  if (!value.startsWith('/')) value = `/${value}`;
  if (!value.endsWith('/')) value = `${value}/`;
  return value.replace(/\/{2,}/g, '/');
}

export function pathSegments(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return [];
  return normalized.split('/').filter(Boolean);
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function titleCase(segment) {
  return String(segment || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/* ────────────────────────── Content enrichment ────────────────────────── */

function stripToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Gutenberg comment markers and shortcodes carry no prose.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[[^\]]{0,200}\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(html) {
  const text = stripToText(html);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function extractHeadings(html) {
  const out = [];
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const text = stripToText(match[2]);
    if (text) out.push({ level: Number(match[1]), text: text.slice(0, 200) });
    if (out.length >= 60) break;
  }
  return out;
}

export function extractHrefs(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    out.push(match[1]);
    if (out.length >= 500) break;
  }
  return out;
}

function countImages(html) {
  const matches = String(html || '').match(/<img\b/gi);
  return matches ? matches.length : 0;
}

/**
 * Per-page detail computed from what we already store. No network calls.
 * `siteHost` scopes the link extraction so outbound links are excluded.
 */
export function enrichPage(page, { siteHost = null } = {}) {
  const wordCount = countWords(page.content);
  const headings = extractHeadings(page.content);
  const host = siteHost || hostOf(page.url);

  const internalPaths = new Set();
  let externalLinks = 0;
  for (const href of extractHrefs(page.content)) {
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      const linkHost = hostOf(href);
      if (host && linkHost && linkHost !== host) {
        externalLinks++;
        continue;
      }
    }
    const path = normalizePath(href);
    if (path) internalPaths.add(path);
  }

  const selfPath = normalizePath(page.url);
  internalPaths.delete(selfPath);

  const seoTitleLength = page.seoTitle ? String(page.seoTitle).length : 0;
  const seoDescriptionLength = page.seoDescription ? String(page.seoDescription).length : 0;
  const daysSinceModified = page.modifiedAt
    ? Math.floor((Date.now() - new Date(page.modifiedAt).getTime()) / 86_400_000)
    : null;

  return {
    wordCount,
    readingMinutes: Math.max(1, Math.round(wordCount / 220)),
    headings: headings.slice(0, 30),
    h1: headings.find((h) => h.level === 1)?.text || null,
    outboundInternalPaths: [...internalPaths],
    internalLinksOut: internalPaths.size,
    externalLinks,
    imageCount: countImages(page.content),
    hasFeaturedImage: !!page.featuredImageUrl,
    seoTitleLength,
    seoDescriptionLength,
    hasSeoTitle: seoTitleLength > 0,
    hasSeoDescription: seoDescriptionLength > 0,
    seoTitleTooLong: seoTitleLength > SEO_TITLE_MAX,
    seoDescriptionTooLong: seoDescriptionLength > SEO_DESCRIPTION_MAX,
    isThin: wordCount > 0 && wordCount < THIN_CONTENT_WORDS,
    daysSinceModified,
    isStale: daysSinceModified != null && daysSinceModified > STALE_CONTENT_DAYS,
  };
}

/**
 * Invert the outbound link map so each path knows who links to it.
 * A live page with zero inbound internal links is an orphan.
 */
export function computeInboundLinks(enrichedPages) {
  const inbound = new Map();
  for (const item of enrichedPages) {
    for (const target of item.enrichment.outboundInternalPaths) {
      if (!inbound.has(target)) inbound.set(target, new Set());
      inbound.get(target).add(item.path);
    }
  }
  for (const item of enrichedPages) {
    const sources = inbound.get(item.path);
    item.enrichment.internalLinksIn = sources ? sources.size : 0;
    item.enrichment.inboundPaths = sources ? [...sources].slice(0, 50) : [];
    item.enrichment.isOrphan = item.isLive && item.enrichment.internalLinksIn === 0;
  }
  return enrichedPages;
}

/* ────────────────────────── Inventory ────────────────────────── */

export function lifecycleForStatus(status) {
  const value = String(status || '').toLowerCase();
  if (LIVE_STATUSES.has(value)) return 'LIVE';
  if (PENDING_STATUSES.has(value)) return 'IN_PIPELINE';
  if (value === 'deleted') return 'ARCHIVED';
  return 'IN_PIPELINE';
}

/**
 * Read WpPage rows for a project and enrich them into a comparable inventory.
 * @param {string} projectId
 * @param {{ includePostTypes?: string[]|null, includeDeleted?: boolean }} opts
 */
export async function buildSiteInventory(projectId, opts = {}) {
  const where = { projectId };
  if (!opts.includeDeleted) where.status = { not: 'deleted' };
  if (Array.isArray(opts.includePostTypes) && opts.includePostTypes.length) {
    where.postType = { in: opts.includePostTypes };
  }

  const pages = await prisma.wpPage.findMany({
    where,
    orderBy: { url: 'asc' },
    select: {
      id: true,
      wpPostId: true,
      title: true,
      slug: true,
      status: true,
      postType: true,
      url: true,
      content: true,
      excerpt: true,
      featuredImageUrl: true,
      template: true,
      seoTitle: true,
      seoDescription: true,
      modifiedAt: true,
      syncedAt: true,
      taskId: true,
    },
  });

  const siteHost = pages.map((p) => hostOf(p.url)).find(Boolean) || null;

  const items = pages.map((page) => {
    const path = normalizePath(page.url) || normalizePath(page.slug) || `/${page.wpPostId}/`;
    const segments = pathSegments(path);
    return {
      page,
      path,
      segments,
      depth: segments.length,
      lifecycle: lifecycleForStatus(page.status),
      isLive: lifecycleForStatus(page.status) === 'LIVE',
      enrichment: enrichPage(page, { siteHost }),
    };
  });

  computeInboundLinks(items);
  return { items, siteHost, byPath: new Map(items.map((i) => [i.path, i])) };
}

/* ────────────────────────── Hierarchy ────────────────────────── */

/**
 * Build a tree from URL path depth. Intermediate segments with no page of their
 * own become synthetic GAP nodes so children still hang off something real.
 *
 * Returns a flat, parent-before-child ordered list of plain node descriptors.
 */
export function deriveHierarchy(inventory, { rootName = 'Home' } = {}) {
  const { items } = inventory;
  const nodes = [];
  const byPath = new Map();

  const homeItem = items.find((i) => i.path === '/');
  const root = {
    key: '/',
    parentKey: null,
    kind: 'ROOT',
    name: homeItem?.page.title || rootName,
    slug: '/',
    path: '/',
    depth: 0,
    item: homeItem || null,
    synthetic: !homeItem,
  };
  nodes.push(root);
  byPath.set('/', root);

  // Shallow paths first so parents always exist before their children.
  const sorted = [...items]
    .filter((i) => i.path !== '/')
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  const ensureAncestors = (segments) => {
    let parentKey = '/';
    for (let i = 0; i < segments.length - 1; i++) {
      const key = `/${segments.slice(0, i + 1).join('/')}/`;
      if (!byPath.has(key)) {
        const node = {
          key,
          parentKey,
          kind: KIND_BY_DEPTH[Math.min(i + 1, KIND_BY_DEPTH.length - 1)],
          name: titleCase(segments[i]),
          slug: key,
          path: key,
          depth: i + 1,
          item: null,
          synthetic: true,
        };
        nodes.push(node);
        byPath.set(key, node);
      }
      parentKey = key;
    }
    return parentKey;
  };

  for (const item of sorted) {
    if (byPath.has(item.path)) continue;
    const parentKey = ensureAncestors(item.segments);
    const depth = item.segments.length;
    const node = {
      key: item.path,
      parentKey,
      kind: KIND_BY_DEPTH[Math.min(depth, KIND_BY_DEPTH.length - 1)],
      name: item.page.title || titleCase(item.segments[item.segments.length - 1]),
      slug: item.path,
      path: item.path,
      depth,
      item,
      synthetic: false,
    };
    nodes.push(node);
    byPath.set(item.path, node);
  }

  // A synthetic ancestor created before its own page was processed should adopt
  // that page rather than stay a gap node.
  for (const item of items) {
    const node = byPath.get(item.path);
    if (node && node.synthetic && item.path !== '/') {
      node.synthetic = false;
      node.item = item;
      node.name = item.page.title || node.name;
    }
  }
  if (homeItem) {
    root.synthetic = false;
    root.item = homeItem;
  }

  return nodes;
}

/* ────────────────────────── Node payloads ────────────────────────── */

function contentTypeForNode(descriptor) {
  const postType = descriptor.item?.page.postType;
  if (postType === 'post') return 'Blog post';
  if (postType && postType !== 'page') return titleCase(postType);
  if (descriptor.kind === 'PILLAR') return 'Pillar hub';
  if (descriptor.kind === 'CLUSTER') return 'Cluster hub';
  return 'Supporting page';
}

function nodeDataFromDescriptor(descriptor, mapId, parentId, sortOrder) {
  const item = descriptor.item;
  const base = {
    mapId,
    parentId,
    kind: descriptor.kind,
    name: String(descriptor.name || 'Untitled').slice(0, 500),
    slug: descriptor.slug ? String(descriptor.slug).slice(0, 500) : null,
    contentType: contentTypeForNode(descriptor),
    sortOrder,
    pathDepth: descriptor.depth,
    collapsed: descriptor.kind === 'CLUSTER',
  };

  if (!item) {
    return {
      ...base,
      source: 'SITEMAP',
      lifecycle: 'GAP',
      isSupport: true,
      note: 'Structural node inferred from the URL path — no page exists at this address.',
    };
  }

  return {
    ...base,
    source: 'WORDPRESS',
    lifecycle: item.lifecycle,
    isLive: item.lifecycle === 'LIVE',
    url: String(item.page.url || '').slice(0, 500),
    wpPageId: item.page.id,
    publishedAt: item.lifecycle === 'LIVE' ? item.page.modifiedAt : null,
    metrics: item.enrichment,
    metricsAt: new Date(),
  };
}

/* ────────────────────────── Import ────────────────────────── */

async function getOrCreateSyncState(mapId) {
  const existing = await prisma.contentMapSync.findUnique({ where: { mapId } });
  if (existing) return existing;
  return prisma.contentMapSync.create({ data: { mapId } });
}

/**
 * First-run import: materialize the whole live site as map nodes.
 * `replace` wipes WordPress-sourced nodes first; planned nodes are always kept.
 */
export async function importSiteIntoMap(mapId, { userId = null, mode = 'merge' } = {}) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    select: { id: true, projectId: true, name: true },
  });
  if (!map) return { ok: false, error: 'Content map not found' };

  const syncState = await getOrCreateSyncState(mapId);
  const inventory = await buildSiteInventory(map.projectId, {
    includePostTypes: Array.isArray(syncState.includePostTypes) ? syncState.includePostTypes : null,
  });
  if (!inventory.items.length) {
    return { ok: false, error: 'No WordPress content synced for this project yet' };
  }

  if (mode === 'replace') {
    await prisma.contentMapNode.deleteMany({
      where: { mapId, source: { in: ['WORDPRESS', 'SITEMAP'] } },
    });
  }

  const descriptors = deriveHierarchy(inventory);
  const existing = await prisma.contentMapNode.findMany({
    where: { mapId },
    select: { id: true, slug: true, url: true, kind: true, source: true, parentId: true },
  });

  // Reuse an existing node when its slug or URL already points at the same path,
  // so re-importing does not duplicate the tree or orphan comments.
  const existingByPath = new Map();
  for (const node of existing) {
    const key = normalizePath(node.url || node.slug);
    if (key && !existingByPath.has(key)) existingByPath.set(key, node);
  }
  const rootNode = existing.find((n) => n.kind === 'ROOT');
  if (rootNode && !existingByPath.has('/')) existingByPath.set('/', rootNode);

  const idByKey = new Map();
  let created = 0;
  let updated = 0;
  const perParentSort = new Map();

  for (const descriptor of descriptors) {
    const parentId = descriptor.parentKey ? idByKey.get(descriptor.parentKey) ?? null : null;
    const sortKey = parentId || '__root__';
    const sortOrder = perParentSort.get(sortKey) ?? 0;
    perParentSort.set(sortKey, sortOrder + 1);

    const data = nodeDataFromDescriptor(descriptor, mapId, parentId, sortOrder);
    const match = existingByPath.get(descriptor.key);

    if (match) {
      const { mapId: _mapId, ...updatable } = data;
      // Keep a manually planned node's own parent placement.
      if (match.source === 'PLANNED') delete updatable.parentId;
      const saved = await prisma.contentMapNode.update({ where: { id: match.id }, data: updatable });
      idByKey.set(descriptor.key, saved.id);
      updated++;
    } else {
      const saved = await prisma.contentMapNode.create({ data });
      idByKey.set(descriptor.key, saved.id);
      created++;
    }
  }

  const stats = { created, updated, total: descriptors.length, pages: inventory.items.length };
  await prisma.contentMapSync.update({
    where: { mapId },
    data: {
      lastSyncAt: new Date(),
      lastSyncStats: stats,
      firstImportAt: syncState.firstImportAt || new Date(),
    },
  });

  await logEvent({
    mapId,
    userId,
    eventType: 'site_imported',
    message: `Imported ${created} and refreshed ${updated} node(s) from the live site`,
    metadata: stats,
  });
  await publishContentMapUpdate(map.projectId, { mapId, action: 'site_imported' });

  return { ok: true, stats };
}

/* ────────────────────────── Matching ────────────────────────── */

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token-overlap similarity, enough to surface "this planned node is probably
 * that new page" without pulling in a fuzzy-match dependency.
 */
export function titleSimilarity(a, b) {
  const left = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const right = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.max(left.size, right.size);
}

/* ────────────────────────── Reconcile ────────────────────────── */

/** Nearest mapped ancestor for a URL path, falling back to the root node. */
async function findParentNodeId(mapId, segments, nodesByPath) {
  for (let i = segments.length - 1; i > 0; i--) {
    const key = `/${segments.slice(0, i).join('/')}/`;
    const match = nodesByPath.get(key);
    if (match) return match.id;
  }
  const root = nodesByPath.get('/');
  if (root) return root.id;
  const dbRoot = await prisma.contentMapNode.findFirst({
    where: { mapId, kind: 'ROOT' },
    select: { id: true },
  });
  return dbRoot?.id || null;
}

async function queueDrift(mapId, drift) {
  const existing = await prisma.contentMapDrift.findFirst({
    where: {
      mapId,
      status: 'PENDING',
      driftType: drift.driftType,
      nodeId: drift.nodeId ?? null,
      wpPageId: drift.wpPageId ?? null,
    },
    select: { id: true },
  });
  if (existing) {
    return prisma.contentMapDrift.update({
      where: { id: existing.id },
      data: { payload: drift.payload ?? undefined, confidence: drift.confidence ?? null },
    });
  }
  return prisma.contentMapDrift.create({ data: { mapId, ...drift } });
}

/**
 * Compare the live site against a map and record what changed.
 *
 * Only auto-action: a PLANNED node that now matches live content is linked and
 * flipped to LIVE. Everything else becomes a PENDING ContentMapDrift row.
 */
export async function reconcileMap(mapId, { userId = null, notify = true } = {}) {
  const map = await prisma.contentMap.findUnique({
    where: { id: mapId },
    select: { id: true, projectId: true, name: true },
  });
  if (!map) return { ok: false, error: 'Content map not found' };

  const syncState = await getOrCreateSyncState(mapId);
  const inventory = await buildSiteInventory(map.projectId, {
    includePostTypes: Array.isArray(syncState.includePostTypes) ? syncState.includePostTypes : null,
  });

  const nodes = await prisma.contentMapNode.findMany({ where: { mapId } });

  // Nothing mapped yet: treat the first reconcile as the initial import.
  if (!syncState.firstImportAt && nodes.filter((n) => n.source === 'WORDPRESS').length === 0) {
    return importSiteIntoMap(mapId, { userId, mode: 'merge' });
  }

  const nodesByWpPageId = new Map(nodes.filter((n) => n.wpPageId).map((n) => [n.wpPageId, n]));
  const nodesByPath = new Map();
  for (const node of nodes) {
    const key = normalizePath(node.url || node.slug);
    if (key && !nodesByPath.has(key)) nodesByPath.set(key, node);
  }

  const stats = { published: 0, newContent: 0, removed: 0, urlChanged: 0, titleChanged: 0, statusChanged: 0, likelyMatch: 0 };
  const publishedNodes = [];

  for (const item of inventory.items) {
    const linked = nodesByWpPageId.get(item.page.id);

    if (linked) {
      const wasLive = linked.lifecycle === 'LIVE';
      const nowLive = item.lifecycle === 'LIVE';
      const linkedPath = normalizePath(linked.url || linked.slug);

      // Always keep cached detail current — this is display data, not structure.
      await prisma.contentMapNode.update({
        where: { id: linked.id },
        data: {
          metrics: item.enrichment,
          metricsAt: new Date(),
          lifecycle: nowLive ? 'LIVE' : linked.lifecycle === 'LIVE' ? 'LIVE' : item.lifecycle,
          isLive: nowLive || linked.isLive,
          ...(nowLive && !wasLive ? { publishedAt: item.page.modifiedAt || new Date() } : {}),
        },
      });

      if (nowLive && !wasLive) {
        stats.published++;
        publishedNodes.push({ node: linked, item });
      }
      if (!nowLive && wasLive) {
        stats.statusChanged++;
        await queueDrift(mapId, {
          nodeId: linked.id,
          wpPageId: item.page.id,
          driftType: 'STATUS_CHANGED',
          payload: { from: 'LIVE', to: item.lifecycle, wpStatus: item.page.status, title: item.page.title },
        });
      }
      if (linkedPath && linkedPath !== item.path) {
        stats.urlChanged++;
        await queueDrift(mapId, {
          nodeId: linked.id,
          wpPageId: item.page.id,
          driftType: 'URL_CHANGED',
          payload: { from: linkedPath, to: item.path, title: item.page.title },
        });
      }
      if (linked.name !== item.page.title && item.page.title) {
        stats.titleChanged++;
        await queueDrift(mapId, {
          nodeId: linked.id,
          wpPageId: item.page.id,
          driftType: 'TITLE_CHANGED',
          payload: { from: linked.name, to: item.page.title },
        });
      }
      continue;
    }

    // Unlinked live content: does a planned node already describe it?
    const exactPlanned = nodesByPath.get(item.path);
    if (exactPlanned && !exactPlanned.wpPageId) {
      await prisma.contentMapNode.update({
        where: { id: exactPlanned.id },
        data: {
          wpPageId: item.page.id,
          source: exactPlanned.source === 'PLANNED' ? 'PLANNED' : 'WORDPRESS',
          lifecycle: item.lifecycle,
          isLive: item.lifecycle === 'LIVE',
          url: String(item.page.url || '').slice(0, 500),
          publishedAt: item.lifecycle === 'LIVE' ? item.page.modifiedAt || new Date() : null,
          metrics: item.enrichment,
          metricsAt: new Date(),
        },
      });
      if (item.lifecycle === 'LIVE') {
        stats.published++;
        publishedNodes.push({ node: exactPlanned, item });
      }
      continue;
    }

    const candidate = nodes
      .filter((n) => !n.wpPageId && n.lifecycle === 'PLANNED')
      .map((n) => ({ node: n, score: titleSimilarity(n.name, item.page.title) }))
      .sort((a, b) => b.score - a.score)[0];

    if (candidate && candidate.score >= 0.6) {
      stats.likelyMatch++;
      await queueDrift(mapId, {
        nodeId: candidate.node.id,
        wpPageId: item.page.id,
        driftType: 'LIKELY_MATCH',
        confidence: Number(candidate.score.toFixed(2)),
        payload: {
          nodeName: candidate.node.name,
          title: item.page.title,
          url: item.page.url,
          path: item.path,
          status: item.page.status,
          postType: item.page.postType,
        },
      });
      continue;
    }

    // Teams that trust the site as the source of truth can skip the queue.
    if (syncState.autoAdopt) {
      const parentId = await findParentNodeId(mapId, item.segments, nodesByPath);
      const maxSort = await prisma.contentMapNode.aggregate({
        where: { mapId, parentId },
        _max: { sortOrder: true },
      });
      const adopted = await prisma.contentMapNode.create({
        data: {
          mapId,
          parentId,
          kind: KIND_BY_DEPTH[Math.min(item.depth, KIND_BY_DEPTH.length - 1)],
          name: String(item.page.title || 'Untitled').slice(0, 500),
          slug: item.path.slice(0, 500),
          url: String(item.page.url || '').slice(0, 500),
          source: 'WORDPRESS',
          lifecycle: item.lifecycle,
          isLive: item.lifecycle === 'LIVE',
          wpPageId: item.page.id,
          pathDepth: item.depth,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          publishedAt: item.lifecycle === 'LIVE' ? item.page.modifiedAt : null,
          metrics: item.enrichment,
          metricsAt: new Date(),
        },
      });
      nodesByPath.set(item.path, adopted);
      stats.autoAdopted = (stats.autoAdopted || 0) + 1;
      continue;
    }

    stats.newContent++;
    await queueDrift(mapId, {
      wpPageId: item.page.id,
      driftType: 'NEW_CONTENT',
      payload: {
        title: item.page.title,
        url: item.page.url,
        path: item.path,
        status: item.page.status,
        postType: item.page.postType,
        wordCount: item.enrichment.wordCount,
        modifiedAt: item.page.modifiedAt,
      },
    });
  }

  // Mapped WordPress nodes whose page has vanished from the inventory.
  const liveWpPageIds = new Set(inventory.items.map((i) => i.page.id));
  for (const node of nodes) {
    if (!node.wpPageId || liveWpPageIds.has(node.wpPageId)) continue;
    stats.removed++;
    await queueDrift(mapId, {
      nodeId: node.id,
      driftType: 'REMOVED',
      payload: { nodeName: node.name, url: node.url, slug: node.slug },
    });
  }

  await prisma.contentMapSync.update({
    where: { mapId },
    data: { lastSyncAt: new Date(), lastSyncStats: stats },
  });

  for (const { node, item } of publishedNodes) {
    await logEvent({
      mapId,
      nodeId: node.id,
      userId,
      eventType: 'node_published',
      message: `"${node.name}" went live on the site`,
      metadata: { url: item.page.url },
    });
  }

  const pendingCount =
    stats.newContent + stats.removed + stats.urlChanged + stats.titleChanged + stats.statusChanged + stats.likelyMatch;

  if (notify && (publishedNodes.length || pendingCount)) {
    try {
      const { project, recipientIds } = await resolveContentMapRecipients(map.projectId);
      for (const { node, item } of publishedNodes) {
        await notifyContentMap({
          slug: 'content_map_node_published',
          recipientIds,
          variables: {
            mapName: map.name,
            projectName: project?.name || '',
            nodeName: node.name,
            pageUrl: item.page.url || '',
          },
          actionUrl: `/portal/pm/content-profile/${map.projectId}`,
          metadata: { mapId, projectId: map.projectId, nodeId: node.id },
        });
      }
      if (pendingCount) {
        await notifyContentMap({
          slug: 'content_map_site_drift',
          recipientIds,
          variables: {
            mapName: map.name,
            projectName: project?.name || '',
            driftCount: String(pendingCount),
          },
          actionUrl: `/portal/pm/content-profile/${map.projectId}`,
          metadata: { mapId, projectId: map.projectId },
        });
      }
    } catch {
      /* notifications must never fail a sync */
    }
  }

  if (publishedNodes.length || pendingCount) {
    await publishContentMapUpdate(map.projectId, { mapId, action: 'site_synced', stats });
  }

  return { ok: true, stats };
}

/** Reconcile every map on a project. Safe to call fire-and-forget. */
export async function reconcileProjectMaps(projectId, options = {}) {
  const maps = await prisma.contentMap.findMany({
    where: { projectId, status: { not: 'ARCHIVED' } },
    select: { id: true },
  });
  const results = [];
  for (const map of maps) {
    try {
      results.push({ mapId: map.id, ...(await reconcileMap(map.id, options)) });
    } catch (err) {
      results.push({ mapId: map.id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Fire-and-forget wrapper for call sites that must never be affected by a
 * content map failure (WP page sync, webhooks, pipeline sync).
 */
export function reconcileProjectMapsSafe(projectId, logger = null) {
  Promise.resolve()
    .then(() => reconcileProjectMaps(projectId))
    .catch((err) => {
      logger?.warn?.({ err, projectId }, 'Content map reconcile failed (non-fatal)');
    });
}

/* ────────────────────────── Pipeline mirroring ────────────────────────── */

/**
 * Link a WpContentReview to its map node so in-progress agency content shows as
 * IN_PIPELINE on the map. Matches on wpPostId first, then on planned node title.
 */
export async function mirrorPipelineToMaps(projectId, review, logger = null) {
  try {
    if (!review?.id) return;
    const maps = await prisma.contentMap.findMany({
      where: { projectId, status: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    if (!maps.length) return;

    const isPublished = review.isPublished || String(review.status || '').startsWith('publish');

    for (const map of maps) {
      const nodes = await prisma.contentMapNode.findMany({
        where: { mapId: map.id },
        select: { id: true, name: true, wpContentReviewId: true, wpPageId: true, lifecycle: true },
      });

      let target = nodes.find((n) => n.wpContentReviewId === review.id);

      if (!target && review.wpPostId) {
        const wpPage = await prisma.wpPage.findFirst({
          where: { projectId, wpPostId: review.wpPostId },
          select: { id: true },
        });
        if (wpPage) target = nodes.find((n) => n.wpPageId === wpPage.id);
      }

      if (!target) {
        const candidate = nodes
          .filter((n) => !n.wpContentReviewId && n.lifecycle === 'PLANNED')
          .map((n) => ({ node: n, score: titleSimilarity(n.name, review.postTitle) }))
          .sort((a, b) => b.score - a.score)[0];
        if (candidate && candidate.score >= 0.7) target = candidate.node;
      }

      if (!target) continue;

      await prisma.contentMapNode.update({
        where: { id: target.id },
        data: {
          wpContentReviewId: review.id,
          nodeStatus: String(review.status || '').slice(0, 50) || null,
          ...(isPublished
            ? {}
            : { lifecycle: target.lifecycle === 'LIVE' ? 'NEEDS_UPDATE' : 'IN_PIPELINE' }),
        },
      });
    }
  } catch (err) {
    logger?.warn?.({ err, projectId }, 'Content map pipeline mirror failed (non-fatal)');
  }
}
