/**
 * Crawl client website + Anthropic extraction of 10–15 local focus keywords
 * for AI Visibility preview (admin-editable before OpenRouter probes).
 */

import { prisma } from '../prisma.js';
import { crawlPage } from '../omniSearch/omniSearchCrawler.js';
import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../ai.js';
import { domainFromUrl } from './providers.js';
import { brandTokensForProject, resolveTargetMarket } from './aiVisibilityQueryIntel.js';

const MAX_PAGES = 12;
const MIN_KEYWORDS = 8;
const MAX_KEYWORDS = 15;

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

function scoreUrl(url, baseOrigin) {
  try {
    const u = new URL(url);
    if (u.origin !== baseOrigin) return -1;
    let score = 0;
    const path = u.pathname.toLowerCase();
    if (path === '/' || path === '') score += 50;
    if (SERVICE_PATH_RE.test(path)) score += 40;
    if (/commercial|contractor|service|plumber|electric|drain/i.test(path)) score += 20;
    if (/blog|news|wp-content|tag|category|cart|login|privacy|terms/i.test(path)) score -= 30;
    // Prefer shorter paths (landing/service)
    score += Math.max(0, 15 - path.split('/').filter(Boolean).length * 3);
    return score;
  } catch {
    return -1;
  }
}

async function collectPageUrls(project, siteUrl) {
  const origin = new URL(siteUrl).origin;
  const candidates = new Set([origin + '/', siteUrl.replace(/\/$/, '') + '/']);

  const sitemapNodes = await prisma.sitemapNode.findMany({
    where: { projectId: project.id },
    select: { url: true },
    take: 80,
  });
  for (const n of sitemapNodes) {
    if (n.url) candidates.add(n.url);
  }

  // Seed crawl homepage for internal links
  const home = await crawlPage(origin + '/');
  if (home.statusCode >= 200 && home.statusCode < 400) {
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
    const key = url.split('#')[0].split('?')[0].replace(/\/$/, '') || url;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(url);
    if (picked.length >= MAX_PAGES) break;
  }

  if (picked.length === 0) picked.push(origin + '/');
  return picked;
}

async function crawlSelectedPages(urls) {
  const pages = [];
  for (const url of urls) {
    const page = await crawlPage(url);
    if (page.error || !page.statusCode || page.statusCode >= 400) continue;
    pages.push({
      url: page.url,
      title: page.title || '',
      metaDescription: page.metaDescription || '',
      h1: page.h1 || '',
      h2s: (page.h2s || []).slice(0, 12),
      wordCount: page.wordCount || 0,
    });
  }
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
  const pageUrls = await collectPageUrls(project, siteUrl);
  const pages = await crawlSelectedPages(pageUrls);
  if (pages.length === 0) {
    const err = new Error(
      `Could not crawl any pages from ${siteUrl}. Check the site is publicly reachable.`
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
- Do NOT include brand navigational queries (company name alone).
- Do NOT invent unrelated services not supported by the page content.
- Lowercase queries; natural phrasing; no quotes.`;

  const userPayload = {
    targetMarket: market || null,
    brandNamesToAvoid: brands.slice(0, 20),
    businessName: project.client?.agencyName || project.name,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title,
      metaDescription: p.metaDescription,
      h1: p.h1,
      h2s: p.h2s,
    })),
  };

  const { parsed, text } = await generateChat({
    system,
    user: sanitizeUserInputForPrompt(JSON.stringify(userPayload), 14000),
    json: true,
    maxTokens: 2000,
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
    const err = new Error('Claude returned no keywords from the site crawl');
    err.status = 502;
    throw err;
  }

  const marketLower = (market || '').toLowerCase();
  const brandLower = brands.map((b) => String(b).toLowerCase()).filter((b) => b.length >= 3);
  const queries = [];
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
    pagesCrawled: pages.length,
    pageUrls: pages.map((p) => p.url),
    queries,
    keywords: queries.map((query, i) => ({
      query,
      sourcePage: keywords[i]?.sourcePage || null,
      reason: keywords[i]?.reason || null,
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
