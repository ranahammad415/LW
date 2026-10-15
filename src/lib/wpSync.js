import { prisma } from './prisma.js';
import { generateChat, isAiConfigured } from './ai.js';
import { reconcileProjectMapsSafe } from './contentMapSync.js';
import { fetchAllWpPages, fetchWpSiteInfo } from './siteAdapters/wordpress.js';

// WP REST helpers (wpAgentHeaders, extractWpPagesArray, fetchAllWpPages, fetchWpSiteInfo)
// moved verbatim to lib/siteAdapters/wordpress.js (EmDash bridge O2).

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
      feature: 'wp_change_summary',
    });
    return summary?.trim()?.slice(0, 1000) || null;
  } catch {
    return null;
  }
}

/**
 * Sync WordPress pages for a single project.
 * Compares content hashes to detect changes and creates snapshots for changed pages.
 */
export async function syncProjectPages(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, wpUrl: true, wpApiKey: true, cmsType: true },
  });

  // EmDash sites: inventory through the EmDash adapter (lib/emdashSync.js). Dynamic import
  // avoids a module cycle (emdashSync → cmsStore → reviewEvents → wpSync).
  if (project?.cmsType === 'EMDASH') {
    const { syncEmdashInventory } = await import('./emdashSync.js');
    return syncEmdashInventory(projectId, { interactive: true });
  }

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

  // Refresh any content maps against the new inventory. Detached on purpose so a
  // content map failure can never affect the page sync result.
  if (created || updated || deleted) {
    reconcileProjectMapsSafe(projectId);
  }

  return { synced: remotePages.length, created, updated, deleted };
}

/**
 * Sync all projects that have a WP connection configured.
 */
export async function syncAllProjects() {
  const projects = await prisma.project.findMany({
    where: {
      // WordPress only; EmDash inventories run leader-only via emdashSync.syncAllEmdashProjects.
      cmsType: 'WORDPRESS',
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
export async function autoSyncSitemap(projectId, { emdash = false } = {}) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, wpUrl: true, cmsType: true, cmsHealth: true },
  });
  if (!project?.wpUrl) {
    return { imported: 0, total: 0, error: 'No wpUrl configured' };
  }
  if (emdash || project.cmsType === 'EMDASH') return autoSyncEmdashSitemap(project);

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

/**
 * EmDash: site-advertised `sitemapUrl` (v1.0.7, same host) or the usual Astro paths; follows <sitemapindex> children
 * within bounds, all through guardedFetch (lib/siteAdapters/emdashSitemap.js). Sitemap files are never stored as
 * pages. Removals only after a complete walk.
 */
async function autoSyncEmdashSitemap(project) {
  const { collectSitemapUrls } = await import('./siteAdapters/emdashSitemap.js');
  const r = await collectSitemapUrls(project.wpUrl, { sitemapUrl: project.cmsHealth?.sitemapUrl || null });
  if (!r.found) return { imported: 0, total: 0, error: 'No sitemap found' };
  const projectId = project.id;
  const existing = await prisma.sitemapNode.findMany({ where: { projectId }, select: { url: true } });
  const existingSet = new Set(existing.map((e) => e.url));
  const toInsert = r.urls.filter((u) => !existingSet.has(u));
  if (toInsert.length > 0) {
    await prisma.sitemapNode.createMany({ data: toInsert.map((u) => ({ projectId, url: u, pageType: 'PAGE' })) });
  }
  let removed = 0;
  if (r.complete && r.urls.length > 0) {
    // Also drops sitemap-file URLs stored by the earlier single-file sync.
    const remoteSet = new Set(r.urls);
    const toRemoveUrls = existing.map((e) => e.url).filter((u) => !remoteSet.has(u));
    if (toRemoveUrls.length > 0) {
      await prisma.sitemapNode.deleteMany({ where: { projectId, url: { in: toRemoveUrls } } });
      removed = toRemoveUrls.length;
    }
  }
  return { imported: toInsert.length, removed, total: r.urls.length, sitemapsFetched: r.sitemapsFetched, complete: r.complete };
}
