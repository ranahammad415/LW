/**
 * What the AI reads about a client before it asks them anything.
 *
 * The interview is only useful if it is grounded in the business as it already
 * exists, so this assembles a briefing from data we already hold: the client
 * record and company profile, whatever we can see of their website, what the
 * knowledge base already covers, and the gaps that remain.
 *
 * Everything here degrades rather than throws — a missing website or an
 * unreachable model should still leave enough of a briefing to interview from.
 */
import { prisma } from './prisma.js';
import { crawlPage } from './omniSearch/omniSearchCrawler.js';
import { assessOkfIntakeCompleteness } from './businessIntakeService.js';
import { listClientFiles, readOkfFile, analyzeKnowledgeGaps } from './knowledgeEngine.js';
import { isAiConfigured } from './ai.js';

/** Pages sent to the model. Enough to characterise a site, not enough to flood it. */
const MAX_SITE_PAGES = 30;
const MAX_PAGE_EXCERPT_CHARS = 400;
/** A saved gap report older than this is stale enough to be worth recomputing. */
const SAVED_GAP_REPORT_MAX_AGE_DAYS = 14;
/** Site data older than this is worth re-reading before an interview. */
const STALE_SITE_DAYS = 30;
const NON_CONTENT_POST_TYPES = [
  'nav_menu_item',
  'elementskit_content',
  'elementor_library',
  'attachment',
  'revision',
  'wp_block',
  'wp_template',
  'wp_template_part',
  'wp_global_styles',
  'wp_navigation',
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(text, max = MAX_PAGE_EXCERPT_CHARS) {
  const clean = stripHtml(text);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function daysSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / 86_400_000;
}

function safeReadOkf(clientId, folder, filename) {
  try {
    return readOkfFile(clientId, folder, filename);
  } catch {
    return null;
  }
}

function safeListFiles(clientId) {
  try {
    return listClientFiles(clientId);
  } catch {
    return [];
  }
}

// ── Website ──────────────────────────────────────────────────────────────────

/**
 * Synced WordPress pages, when the client's project is connected. This is the
 * richest source because it is structured and already kept fresh by wpSync.
 */
async function siteFromWordPress(clientId, projectId) {
  const pages = await prisma.wpPage.findMany({
    where: {
      ...(projectId ? { projectId } : { project: { clientId } }),
      status: 'publish',
      // Menu entries and page-builder fragments are not content the client can
      // usefully be interviewed about.
      postType: { notIn: NON_CONTENT_POST_TYPES },
    },
    orderBy: { modifiedAt: 'desc' },
    take: MAX_SITE_PAGES,
    select: {
      title: true,
      url: true,
      postType: true,
      excerpt: true,
      content: true,
      syncedAt: true,
    },
  });

  if (pages.length === 0) return null;

  return {
    source: 'WORDPRESS_SYNC',
    capturedAt: pages.reduce(
      (latest, p) => (p.syncedAt > latest ? p.syncedAt : latest),
      pages[0].syncedAt
    ),
    pageCount: pages.length,
    pages: pages.map((p) => ({
      title: p.title,
      url: p.url,
      postType: p.postType,
      excerpt: excerptOf(p.excerpt || p.content),
    })),
  };
}

/**
 * The last successful crawl. Its output lives in drafts (still awaiting review)
 * and in approved OKF files, so both are read back as a view of the site.
 */
async function siteFromCrawl(clientId) {
  const run = await prisma.knowledgeCrawlRun.findFirst({
    where: { clientId, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
  });
  if (!run) return null;

  const drafts = await prisma.okfDraftChange.findMany({
    where: { clientId, sourceType: 'WEBSITE_CRAWL', createdAt: { gte: run.startedAt || run.createdAt } },
    orderBy: { createdAt: 'desc' },
    take: MAX_SITE_PAGES,
    select: { title: true, folder: true, filename: true, proposedBody: true, proposedMetadata: true },
  });

  const approved = safeListFiles(clientId)
    .filter((f) => f.metadata?.source === 'WEBSITE_CRAWL')
    .slice(0, MAX_SITE_PAGES);

  const pages = [
    ...drafts.map((d) => ({
      title: d.title,
      url: d.proposedMetadata?.source_url || run.rootUrl,
      postType: `${d.folder} (awaiting review)`,
      excerpt: excerptOf(d.proposedBody),
    })),
    ...approved.map((f) => ({
      title: f.title,
      url: f.metadata?.source_url || run.rootUrl,
      postType: f.folder,
      excerpt: excerptOf(f.excerpt),
    })),
  ].slice(0, MAX_SITE_PAGES);

  if (pages.length === 0) return null;

  return {
    source: 'WEBSITE_CRAWL',
    capturedAt: run.finishedAt || run.createdAt,
    pageCount: run.pagesCrawled || pages.length,
    rootUrl: run.rootUrl,
    pages,
  };
}

/** Last resort: a single live read of the homepage, so the AI is never blind. */
async function siteFromHomepage(websiteUrl) {
  if (!websiteUrl) return null;
  const url = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;

  const page = await crawlPage(url, { includeBody: true });
  if (!page || page.statusCode < 200 || page.statusCode >= 400) return null;

  const body = String(page.bodyText || '').trim();
  if (body.length < 200) return null;

  return {
    source: 'HOMEPAGE_FETCH',
    capturedAt: new Date(),
    pageCount: 1,
    rootUrl: url,
    pages: [
      {
        title: page.title || 'Homepage',
        url: page.url,
        postType: 'homepage',
        excerpt: excerptOf(body, 1500),
        headings: [page.h1, ...(page.h2s || []).slice(0, 10)].filter(Boolean),
      },
    ],
  };
}

async function resolveSiteSnapshot(clientId, { projectId = null, websiteUrl = null, allowFetch = true } = {}) {
  const fromWp = await siteFromWordPress(clientId, projectId).catch(() => null);
  if (fromWp) return fromWp;

  const fromCrawl = await siteFromCrawl(clientId).catch(() => null);
  if (fromCrawl) return fromCrawl;

  if (allowFetch) {
    const fromHome = await siteFromHomepage(websiteUrl).catch(() => null);
    if (fromHome) return fromHome;
  }

  return { source: 'NONE', capturedAt: null, pageCount: 0, pages: [] };
}

/**
 * What the UI shows above the chat: whether the AI has anything to go on, and
 * whether it is old enough to be worth re-reading before starting.
 */
export async function siteReviewStatus(clientId, { projectId = null } = {}) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { websiteUrl: true },
  });

  // No live fetch here: this runs on page load and must stay fast.
  const site = await resolveSiteSnapshot(clientId, {
    projectId,
    websiteUrl: client?.websiteUrl || null,
    allowFetch: false,
  });

  return {
    hasSiteData: site.source !== 'NONE',
    source: site.source,
    capturedAt: site.capturedAt,
    pageCount: site.pageCount,
    websiteUrl: client?.websiteUrl || null,
    isStale: site.source !== 'NONE' && daysSince(site.capturedAt) > STALE_SITE_DAYS,
  };
}

// ── Gaps ─────────────────────────────────────────────────────────────────────

/**
 * Reads back the most recent report saved by the gap-analysis route. The format
 * is one we write ourselves, so parsing it is stable enough to avoid paying for
 * a fresh analysis on every interview start.
 */
function latestSavedGapReport(clientId) {
  const reports = safeListFiles(clientId)
    .filter((f) => f.folder === 'knowledge-gaps' && f.type === 'gap-analysis')
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  const newest = reports[0];
  if (!newest) return null;

  const doc = safeReadOkf(clientId, newest.folder, newest.filename);
  if (!doc) return null;

  const items = [];
  const gapPattern = /^####\s*\d+\.\s*\[([^\]]+)\]\s*-\s*(\S+)\s+Severity\s*$\n-\s*\*\*Description\*\*:\s*(.+)$/gm;
  let match;
  while ((match = gapPattern.exec(doc.body)) !== null) {
    items.push({
      category: match[1].toLowerCase(),
      severity: match[2],
      description: match[3].trim(),
    });
  }

  const questions = [];
  const questionPattern = /^-\s*\*\*Category\*\*:\s*(.+)$\n\s*-\s*\*\*Question\*\*:\s*\*(.+?)\*$/gm;
  while ((match = questionPattern.exec(doc.body)) !== null) {
    questions.push({ category: match[1].trim().toLowerCase(), question: match[2].trim() });
  }

  const summaryMatch = doc.body.match(/###\s*Summary Evaluation\s*\n([\s\S]*?)(?=\n###|\n$)/);

  return {
    source: 'SAVED_REPORT',
    capturedAt: newest.updated_at,
    readinessScore: doc.metadata?.readiness_score ?? null,
    summary: summaryMatch ? summaryMatch[1].trim() : '',
    items,
    recommendedQuestions: questions,
  };
}

async function resolveGaps(clientId, profileData, assetCatalog) {
  const saved = latestSavedGapReport(clientId);
  if (saved && daysSince(saved.capturedAt) <= SAVED_GAP_REPORT_MAX_AGE_DAYS && saved.items.length > 0) {
    return saved;
  }

  if (isAiConfigured()) {
    try {
      const analysis = await analyzeKnowledgeGaps(profileData, assetCatalog, { clientId });
      return {
        source: 'COMPUTED',
        capturedAt: new Date(),
        readinessScore: analysis?.readiness_score ?? null,
        summary: analysis?.findings_summary || '',
        items: Array.isArray(analysis?.gaps) ? analysis.gaps : [],
        recommendedQuestions: Array.isArray(analysis?.recommended_questions)
          ? analysis.recommended_questions
          : [],
      };
    } catch {
      // A gap analysis failure must not block the interview.
    }
  }

  return saved || { source: 'NONE', capturedAt: null, readinessScore: null, summary: '', items: [], recommendedQuestions: [] };
}

// ── Briefing ─────────────────────────────────────────────────────────────────

/**
 * Everything the interviewer should know before its first question.
 *
 * @param {string} clientId
 * @param {{ projectId?: string|null, allowFetch?: boolean }} [options]
 */
export async function buildClientBriefing(clientId, { projectId = null, allowFetch = true } = {}) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true, agencyName: true, websiteUrl: true, industry: true, internalNotes: true },
  });
  if (!client) throw new Error('Client not found');

  const profileDoc = safeReadOkf(clientId, 'company', 'profile');
  const meta = profileDoc?.metadata || {};

  const business = {
    name: meta.agency_name || client.agencyName,
    websiteUrl: meta.website_url || client.websiteUrl || null,
    industry: meta.industry || client.industry || null,
    targetMarket: meta.target_market || null,
    brandVoice: meta.brand_voice || null,
    competitors: meta.competitors || null,
    differentiators: meta.differentiators || null,
    profileBody: profileDoc?.body ? String(profileDoc.body).trim().slice(0, 2000) : '',
  };

  const files = safeListFiles(clientId).filter((f) => f.folder !== 'knowledge-gaps');
  const byFolder = new Map();
  for (const file of files) {
    if (!byFolder.has(file.folder)) byFolder.set(file.folder, []);
    byFolder.get(file.folder).push(file.title);
  }

  const coverage = {
    fileCount: files.length,
    assessment: assessOkfIntakeCompleteness(clientId),
    folders: [...byFolder.entries()].map(([folder, titles]) => ({
      folder,
      count: titles.length,
      titles: titles.slice(0, 12),
    })),
  };

  const [site, gaps] = await Promise.all([
    resolveSiteSnapshot(clientId, { projectId, websiteUrl: business.websiteUrl, allowFetch }),
    resolveGaps(
      clientId,
      {
        company_name: business.name,
        website: business.websiteUrl,
        industry: business.industry,
        services: client.internalNotes || 'Not defined',
        target_market: business.targetMarket || '',
        description: business.profileBody,
      },
      files.map((f) => ({ title: f.title, folder: f.folder, type: f.type, excerpt: f.excerpt }))
    ),
  ]);

  return { clientId, business, site, coverage, gaps, generatedAt: new Date().toISOString() };
}

/**
 * Flattens a briefing into the prose block that goes into the system prompt.
 * Kept here so the briefing shape and its rendering stay in one place.
 */
export function renderBriefingForPrompt(briefing) {
  const { business, site, coverage, gaps } = briefing;
  const sections = [];

  sections.push(
    [
      'THE BUSINESS',
      `- Name: ${business.name}`,
      business.websiteUrl ? `- Website: ${business.websiteUrl}` : '',
      business.industry ? `- Industry: ${business.industry}` : '',
      business.targetMarket ? `- Target market: ${business.targetMarket}` : '',
      business.differentiators ? `- Claimed differentiators: ${business.differentiators}` : '',
      business.profileBody ? `\nCompany profile on file:\n${business.profileBody}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );

  if (site.source === 'NONE') {
    sections.push(
      'THEIR WEBSITE\nWe could not read their website. Do not guess at what it says — ask them directly what they publish and sell.'
    );
  } else {
    const label =
      {
        WORDPRESS_SYNC: 'their connected WordPress site',
        WEBSITE_CRAWL: 'a crawl of their live website',
        HOMEPAGE_FETCH: 'a single read of their homepage',
      }[site.source] || 'their website';
    const on = site.capturedAt ? ` on ${new Date(site.capturedAt).toISOString().slice(0, 10)}` : '';

    sections.push(
      [
        'THEIR WEBSITE',
        `Read from ${label}${on}. ${site.pageCount} page(s) seen.`,
        ...site.pages.map(
          (p) =>
            `- ${p.title}${p.url ? ` (${p.url})` : ''}${p.postType ? ` [${p.postType}]` : ''}\n  ${p.excerpt}`
        ),
      ].join('\n')
    );
  }

  sections.push(
    [
      'WHAT THE KNOWLEDGE BASE ALREADY COVERS',
      coverage.fileCount === 0
        ? 'Nothing yet — start from the basics.'
        : coverage.folders.map((f) => `- ${f.folder} (${f.count}): ${f.titles.join(', ')}`).join('\n'),
      coverage.assessment.missing.length
        ? `Still missing: ${coverage.assessment.missing.join(', ')}.`
        : 'All required files are present.',
    ].join('\n')
  );

  if (gaps.items.length) {
    sections.push(
      [
        'KNOWN GAPS TO CLOSE',
        ...gaps.items
          .slice(0, 12)
          .map(
            (g) =>
              `- [${String(g.category || '').toUpperCase()}] ${g.description}${g.severity ? ` (${g.severity})` : ''}`
          ),
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}
