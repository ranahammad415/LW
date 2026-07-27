/**
 * Site context + Anthropic extraction of 10–15 local focus keywords
 * for AI Visibility preview (admin-editable before OpenRouter probes).
 * Prefers synced WordPress plugin pages (WpPage); HTML crawl is fallback.
 */

import { prisma } from '../prisma.js';
import { crawlPage } from '../omniSearch/omniSearchCrawler.js';
import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../ai.js';
import { brandTokensForProject, resolveTargetMarket } from './aiVisibilityQueryIntel.js';

const MAX_PAGES = 6;
const CRAWL_CONCURRENCY = 3;
const MIN_WP_PAGES = 2;
const MIN_KEYWORDS = 8;
const MAX_KEYWORDS = 15;
const WP_TEXT_MAX = 1000;

const SERVICE_PATH_RE =
  /\/(services?|solutions?|industries|commercial|residential|plumbing|electrical|hvac|about|locations?)(\/|$)/i;

function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    return u.origin;
  } catch {
    return null;
  }
}

export function resolveProjectSiteUrl(project) {
  return (
    normalizeBaseUrl(project.client?.websiteUrl) ||
    (project.dataforseoDomain ? normalizeBaseUrl(project.dataforseoDomain) : null) ||
    normalizeBaseUrl(project.wpUrl) ||
    null
  );
}

function scorePath(url) {
  try {
    const u = new URL(url, 'https://example.com');
    let score = 0;
    const path = u.pathname.toLowerCase();
    if (path === '/' || path === '') score += 50;
    if (SERVICE_PATH_RE.test(path)) score += 40;
    if (/commercial|contractor|service|plumber|electric|drain/i.test(path)) score += 20;
    if (/blog|news|wp-content|tag|category|cart|login|privacy|terms/i.test(path)) score -= 30;
    score += Math.max(0, 15 - path.split('/').filter(Boolean).length * 3);
    return score;
  } catch {
    return 0;
  }
}

function scoreUrl(url, baseOrigin) {
  try {
    const u = new URL(url);
    if (baseOrigin && u.origin !== baseOrigin) return -1;
    return scorePath(url);
  } catch {
    return -1;
  }
}

function urlKey(url) {
  return String(url || '')
    .split('#')[0]
    .split('?')[0]
    .replace(/\/$/, '');
}

/** Strip HTML tags + shortcodes for lightweight WP body context. */
export function stripWpContentNoise(raw, maxLen = WP_TEXT_MAX) {
  let s = String(raw || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/\[[^\]]+\]/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, maxLen);
}

function toPageSnippet(page) {
  return {
    url: page.url,
    title: page.title || '',
    metaDescription: (page.metaDescription || '').slice(0, 280),
    h1: page.h1 || '',
    h2s: (page.h2s || []).slice(0, 6),
    text: page.text || undefined,
  };
}

/**
 * Prefer published pages from Localwave Agent sync (WpPage).
 * @returns {Array|null} snippets or null if too few
 */
async function loadWpPageSnippets(projectId) {
  const rows = await prisma.wpPage.findMany({
    where: {
      projectId,
      status: { in: ['publish', 'published'] },
    },
    select: {
      url: true,
      title: true,
      slug: true,
      postType: true,
      content: true,
      excerpt: true,
      seoTitle: true,
      seoDescription: true,
    },
    take: 80,
  });
  if (rows.length === 0) return null;

  const scored = rows
    .map((row) => {
      const url = row.url || '';
      let score = scorePath(url || `/${row.slug || ''}`);
      if (String(row.postType || '').toLowerCase() === 'page') score += 15;
      else score -= 5;
      const text = stripWpContentNoise(row.content || row.excerpt || '');
      if (text.length < 40 && !(row.seoDescription || row.excerpt)) score -= 20;
      return { row, score, text };
    })
    .filter((x) => x.score >= 0 || x.text.length >= 40)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();
  for (const { row, text } of scored) {
    const url = row.url || '';
    const key = urlKey(url) || row.slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = (row.seoTitle || row.title || '').trim();
    const meta =
      (row.seoDescription || '').trim() ||
      stripWpContentNoise(row.excerpt || '', 280);
    picked.push(
      toPageSnippet({
        url: url || `/${row.slug || ''}`,
        title,
        metaDescription: meta,
        h1: (row.title || title).trim(),
        h2s: [],
        text,
      })
    );
    if (picked.length >= MAX_PAGES) break;
  }

  return picked.length >= MIN_WP_PAGES ? picked : null;
}

async function collectPageUrls(project, siteUrl) {
  const origin = new URL(siteUrl).origin;
  const homeUrl = origin + '/';
  const candidates = new Set([homeUrl, siteUrl.replace(/\/$/, '') + '/']);

  const sitemapNodes = await prisma.sitemapNode.findMany({
    where: { projectId: project.id },
    select: { url: true },
    take: 40,
  });
  for (const n of sitemapNodes) {
    if (n.url) candidates.add(n.url);
  }

  // Seed crawl homepage for internal links (reuse snippet later — avoid double fetch)
  let homeSnippet = null;
  const home = await crawlPage(homeUrl);
  if (home.statusCode >= 200 && home.statusCode < 400) {
    homeSnippet = toPageSnippet(home);
    for (const link of home.internalLinks || []) {
      candidates.add(link);
    }
  }

  const ranked = [...candidates]
    .map((url) => ({ url, score: scoreUrl(url, origin) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();
  for (const { url } of ranked) {
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(url);
    if (picked.length >= MAX_PAGES) break;
  }

  if (picked.length === 0) picked.push(homeUrl);
  return { urls: picked, homeSnippet };
}

/** Crawl URLs with a small concurrency pool (keeps preview under proxy timeouts). */
async function crawlSelectedPages(urls) {
  if (urls.length === 0) return [];
  const pages = [];
  let idx = 0;

  async function worker() {
    while (idx < urls.length) {
      const url = urls[idx++];
      const page = await crawlPage(url);
      if (page.error || !page.statusCode || page.statusCode >= 400) continue;
      pages.push(toPageSnippet(page));
    }
  }

  const workers = Array.from({ length: Math.min(CRAWL_CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
  const order = new Map(urls.map((u, i) => [urlKey(u), i]));
  pages.sort((a, b) => (order.get(urlKey(a.url)) ?? 99) - (order.get(urlKey(b.url)) ?? 99));
  return pages;
}

async function crawlSitePages(project, siteUrl) {
  const { urls: pageUrls, homeSnippet } = await collectPageUrls(project, siteUrl);
  const homeKey = homeSnippet ? urlKey(homeSnippet.url) : null;
  const toFetch = homeKey ? pageUrls.filter((u) => urlKey(u) !== homeKey) : pageUrls;
  const crawled = await crawlSelectedPages(toFetch);
  const pages = [];
  if (homeSnippet && pageUrls.some((u) => urlKey(u) === homeKey)) pages.push(homeSnippet);
  pages.push(...crawled);
  return pages;
}

/**
 * @param {object} project — must include client, dataforseoDomain, wpUrl, targetMarket, id
 */
export async function extractSiteFocusKeywords(project) {
  if (!isAiConfigured()) {
    const err = new Error('ANTHROPIC_API_KEY is not configured — cannot extract site keywords');
    err.status = 503;
    throw err;
  }

  const siteUrl = resolveProjectSiteUrl(project);
  if (!siteUrl) {
    const err = new Error(
      'No website URL on this project. Set client website, DataForSEO domain, or WP URL in Integrations.'
    );
    err.status = 400;
    throw err;
  }

  const { market, source: marketSource } = await resolveTargetMarket(project);

  let pages = await loadWpPageSnippets(project.id);
  let pagesSource = 'wordpress';
  if (!pages) {
    pages = await crawlSitePages(project, siteUrl);
    pagesSource = 'crawl';
  }

  if (!pages || pages.length === 0) {
    const err = new Error(
      `No page content available for ${siteUrl}. Sync WordPress pages in the project, or check the site is publicly reachable.`
    );
    err.status = 502;
    throw err;
  }

  const brands = brandTokensForProject(project);
  if (project.client?.agencyName) brands.unshift(project.client.agencyName);

  const system = `You extract local SEO / AI-visibility focus keywords from a business website.
Return JSON only: { "keywords": [ { "query": string, "sourcePage": string|null, "reason": string } ] }

Rules:
- Produce between ${MIN_KEYWORDS} and ${MAX_KEYWORDS} queries.
- Queries must be what a real customer would ask ChatGPT / Google for local services.
- Include the target market city/region in each query when provided (e.g. "commercial electrical contractors in milwaukee").
- Prefer commercial / B2B service intents from landing and service pages.
- When possible, map each query to a real page via sourcePage (use that page's url).
- Do NOT include brand navigational queries (company name alone).
- Do NOT invent unrelated services not supported by the page content.
- Lowercase queries; natural phrasing; no quotes.`;

  const userPayload = {
    targetMarket: market || null,
    brandNamesToAvoid: brands.slice(0, 12),
    businessName: project.client?.agencyName || project.name,
    pagesSource,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title,
      metaDescription: p.metaDescription,
      h1: p.h1,
      h2s: p.h2s || [],
      text: p.text || undefined,
    })),
  };

  const { parsed, text } = await generateChat({
    system,
    user: sanitizeUserInputForPrompt(JSON.stringify(userPayload), 6000),
    json: true,
    maxTokens: 1600,
    temperature: 0.25,
    feature: 'ai_visibility_site_keywords',
    clientId: project.clientId || null,
  });

  let keywords = parsed?.keywords;
  if (!Array.isArray(keywords)) {
    try {
      keywords = JSON.parse(text)?.keywords;
    } catch {
      keywords = null;
    }
  }
  if (!Array.isArray(keywords) || keywords.length === 0) {
    const err = new Error('Claude returned no keywords from the site context');
    err.status = 502;
    throw err;
  }

  const marketLower = (market || '').toLowerCase();
  const brandLower = brands.map((b) => String(b).toLowerCase()).filter((b) => b.length >= 3);
  const queries = [];
  const keptMeta = [];
  const seen = new Set();

  for (const k of keywords) {
    let q = String(k.query || k.keyword || '')
      .trim()
      .toLowerCase()
      .replace(/^["']|["']$/g, '');
    if (!q || q.length < 4) continue;
    // Drop pure brand queries
    if (brandLower.some((b) => q === b || q === `${b} ${marketLower}`.trim())) continue;
    if (marketLower && !q.includes(marketLower)) {
      q = `${q} in ${marketLower}`;
    }
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(q.slice(0, 500));
    keptMeta.push({
      sourcePage: k.sourcePage || null,
      reason: k.reason || null,
    });
    if (queries.length >= MAX_KEYWORDS) break;
  }

  if (queries.length < 3) {
    const err = new Error('Too few usable keywords after filtering — try a clearer service site or set Target market');
    err.status = 502;
    throw err;
  }

  return {
    siteUrl,
    targetMarket: market,
    marketSource,
    pagesSource,
    pagesCrawled: pages.length,
    pageUrls: pages.map((p) => p.url),
    queries,
    keywords: queries.map((query, i) => ({
      query,
      sourcePage: keptMeta[i]?.sourcePage || null,
      reason: keptMeta[i]?.reason || null,
    })),
  };
}

/** Normalize admin-submitted probe list for a run. */
export function normalizeProbeList(probes, { min = 1, max = 20 } = {}) {
  if (!Array.isArray(probes)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of probes) {
    const q = String(raw || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q.slice(0, 500));
    if (out.length >= max) break;
  }
  if (out.length < min) return [];
  return out;
}

export async function loadProjectForSiteKeywords(projectId, clientId) {
  return prisma.project.findFirst({
    where: { id: projectId, clientId },
    select: {
      id: true,
      clientId: true,
      name: true,
      wpUrl: true,
      gscSiteUrl: true,
      dataforseoDomain: true,
      targetMarket: true,
      client: { select: { agencyName: true, websiteUrl: true } },
    },
  });
}
