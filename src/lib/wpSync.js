import { prisma } from './prisma.js';
import { generateChat, isAiConfigured } from './ai.js';

/** Headers many WordPress hosts expect (bare fetch() can be blocked as a bot). */
function wpAgentHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; WP page sync)',
  };
}

/**
 * Normalize REST payload: supports top-level array or { data: [...] } (and accidental nesting).
 */
function extractWpPagesArray(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
  const d = json.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object' && Array.isArray(d.data)) return d.data;
  return [];
}

export async function maybeGenerateSummary({ excerpt, isElementor = false }) {
  const text = String(excerpt || '').trim();
  if (!text || text.length < 50) {
    return isElementor ? 'Elementor content updated.' : null;
  }
  if (!isAiConfigured()) return null;

  try {
    const { text: summary } = await generateChat({
      system: 'Summarize this content change for a PM in 1-2 short sentences.',
      user: text.slice(0, 2000),
      maxTokens: 120,
    });
    return summary?.trim()?.slice(0, 1000) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch all pages from a WP site's Localwave Agent REST API, paginating until exhausted.
 */
async function fetchAllWpPages(wpUrl, wpApiKey) {
  const baseUrl = String(wpUrl || '').trim().replace(/\/$/, '');
  const allPages = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const url = `${baseUrl}/wp-json/lwa/v1/pages?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: wpAgentHeaders(wpApiKey),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`WP API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(
        'WP site did not return JSON for /wp-json/lwa/v1/pages. Check the site URL (include https) and that the Localwave Agent plugin is active.'
      );
    }
    const json = await res.json();
    const items = extractWpPagesArray(json);
    allPages.push(...items);

    if (items.length === 0) break;

    const reportedTotalPages = parseInt(json.total_pages, 10);
    const moreByMeta = Number.isFinite(reportedTotalPages) && page < reportedTotalPages;
    const moreByFullPage = items.length >= perPage && !Number.isFinite(reportedTotalPages);
    if (!moreByMeta && !moreByFullPage) break;
    page++;
  }

  return allPages;
}

async function fetchWpSiteInfo(wpUrl, wpApiKey) {
  const baseUrl = String(wpUrl || '').trim().replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/wp-json/lwa/v1/site-info`, {
    headers: wpAgentHeaders(wpApiKey),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return {
    theme: json?.theme || null,
    plugins: Array.isArray(json?.plugins)
      ? json.plugins.filter((p) => p && p.active).map((p) => ({ name: String(p.name || ''), version: String(p.version || '') }))
      : [],
  };
}

/**
 * Sync WordPress pages for a single project.
 * Compares content hashes to detect changes and creates snapshots for changed pages.
 */
export async function syncProjectPages(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, wpUrl: true, wpApiKey: true },
  });

  const wpUrl = String(project?.wpUrl || '').trim();
  const wpApiKey = String(project?.wpApiKey || '').trim();

  if (!wpUrl || !wpApiKey) {
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: 'Missing WP URL or API key' };
  }

  let remotePages;
  try {
    remotePages = await fetchAllWpPages(wpUrl, wpApiKey);
  } catch (err) {
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: err.message };
  }

  const existingPages = await prisma.wpPage.findMany({
    where: { projectId },
    select: { id: true, wpPostId: true, contentHash: true },
  });
  const existingMap = new Map(existingPages.map((p) => [Number(p.wpPostId), p]));

  const now = new Date();
  let created = 0;
  let updated = 0;
  const seenWpPostIds = new Set();

  for (const rp of remotePages) {
    const wpPostId = Number(rp.wpPostId);
    if (!Number.isFinite(wpPostId) || wpPostId <= 0) continue;
    seenWpPostIds.add(wpPostId);
    const existing = existingMap.get(wpPostId);

    const pageData = {
      title: rp.title || '',
      slug: rp.slug || '',
      status: rp.status || 'publish',
      postType: rp.postType || 'page',
      url: rp.url || '',
      content: rp.content || '',
      excerpt: rp.excerpt || null,
      featuredImageUrl: rp.featuredImageUrl || null,
      template: rp.template || null,
      seoTitle: rp.seoTitle || null,
      seoDescription: rp.seoDescription || null,
      contentHash: rp.contentHash || '',
      modifiedAt: rp.modifiedAt ? new Date(rp.modifiedAt) : null,
      syncedAt: now,
    };

    const contentExcerpt = String(rp.excerpt || rp.content || '').slice(0, 1000) || null;
    const aiSummary = await maybeGenerateSummary({
      excerpt: contentExcerpt,
      isElementor: Boolean(rp.isElementor),
    });

    if (!existing) {
      const newPage = await prisma.wpPage.create({
        data: { projectId, wpPostId, ...pageData },
      });
      await prisma.wpPageSnapshot.create({
        data: {
          wpPageId: newPage.id,
          title: pageData.title,
          content: pageData.content,
          status: pageData.status,
          template: pageData.template,
          seoTitle: pageData.seoTitle,
          seoDescription: pageData.seoDescription,
          featuredImageUrl: pageData.featuredImageUrl,
          contentHash: pageData.contentHash,
          eventType: 'created',
          contentExcerpt,
          aiSummary,
          syncedAt: now,
        },
      });
      created++;
    } else if (existing.contentHash !== rp.contentHash) {
      await prisma.wpPage.update({
        where: { id: existing.id },
        data: pageData,
      });
      await prisma.wpPageSnapshot.create({
        data: {
          wpPageId: existing.id,
          title: pageData.title,
          content: pageData.content,
          status: pageData.status,
          template: pageData.template,
          seoTitle: pageData.seoTitle,
          seoDescription: pageData.seoDescription,
          featuredImageUrl: pageData.featuredImageUrl,
          contentHash: pageData.contentHash,
          eventType: 'updated',
          contentExcerpt,
          aiSummary,
          syncedAt: now,
        },
      });
      updated++;
    } else {
      await prisma.wpPage.update({
        where: { id: existing.id },
        data: { syncedAt: now },
      });
    }
  }

  let deleted = 0;
  for (const [wid, existing] of existingMap) {
    if (!seenWpPostIds.has(wid)) {
      await prisma.wpPage.update({
        where: { id: existing.id },
        data: { status: 'deleted', syncedAt: now },
      });
      deleted++;
    }
  }

  // site info sync (theme + plugins)
  try {
    const siteInfo = await fetchWpSiteInfo(wpUrl, wpApiKey);
    if (siteInfo) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          wpThemeName: siteInfo.theme?.name || null,
          wpThemeVersion: siteInfo.theme?.version || null,
          wpPlugins: siteInfo.plugins,
          wpSiteInfoSyncedAt: now,
        },
      });
    }
  } catch {
    // Non-fatal for page sync
  }

  return { synced: remotePages.length, created, updated, deleted };
}

/**
 * Sync all projects that have a WP connection configured.
 */
export async function syncAllProjects() {
  const projects = await prisma.project.findMany({
    where: {
      wpUrl: { not: null },
      wpApiKey: { not: null },
    },
    select: { id: true, name: true },
  });

  const results = [];
  for (const project of projects) {
    try {
      const stats = await syncProjectPages(project.id);
      results.push({ projectId: project.id, name: project.name, ...stats });
    } catch (err) {
      results.push({ projectId: project.id, name: project.name, error: err.message });
    }
  }
  return results;
}

/**
 * Common WordPress sitemap paths to try (in order).
 */
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];

/**
 * Auto-sync sitemap for a project by trying common WP sitemap URLs.
 * Fetches the sitemap XML, extracts <loc> URLs, and inserts any new ones
 * as SitemapNode records. Returns { imported, total, error? }.
 */
export async function autoSyncSitemap(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, wpUrl: true },
  });
  if (!project?.wpUrl) {
    return { imported: 0, total: 0, error: 'No wpUrl configured' };
  }

  const baseUrl = String(project.wpUrl).trim().replace(/\/$/, '');
  let xmlText = null;

  for (const path of SITEMAP_PATHS) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; sitemap sync)' },
      });
      if (res.ok) {
        const text = await res.text();
        // Basic check that it looks like XML with <loc> entries
        if (text.includes('<loc>') || text.includes(':loc>')) {
          xmlText = text;
          break;
        }
      }
    } catch {
      // Try next path
    }
  }

  if (!xmlText) {
    return { imported: 0, total: 0, error: 'No sitemap found at common paths' };
  }

  // Extract all <loc>...</loc> URLs (standard and namespaced e.g. <sitemap:loc>)
  const locRe = /<[\w]*:?loc[^>]*>([^<]+)<\/[\w]*:?loc>/gi;
  const matches = [...xmlText.matchAll(locRe)];
  const urls = [
    ...new Set(
      matches.map((m) => m[1].trim()).filter((u) => u.length > 0 && u.length <= 500)
    ),
  ];
  if (urls.length === 0) {
    return { imported: 0, total: 0 };
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

  // Also remove sitemap nodes whose URLs are no longer in the sitemap
  const remoteSet = new Set(urls);
  const toRemoveUrls = existing.map((e) => e.url).filter((u) => !remoteSet.has(u));
  if (toRemoveUrls.length > 0) {
    await prisma.sitemapNode.deleteMany({
      where: { projectId, url: { in: toRemoveUrls } },
    });
  }

  return { imported: toInsert.length, removed: toRemoveUrls.length, total: urls.length };
}
