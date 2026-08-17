/**
 * Seeds a client's knowledge base from their live website.
 *
 * Crawls the site, asks the model to turn the page text into OKF sections, and
 * files each section as a PENDING OkfDraftChange. Nothing is written to the
 * knowledge base directly — the existing review queue stays the only way in.
 *
 * Runs are long, so callers start one and poll the KnowledgeCrawlRun row.
 */
import { prisma } from './prisma.js';
import { crawlPage } from './omniSearch/omniSearchCrawler.js';
import { generateChat } from './ai.js';
import { publish } from './realtimeBus.js';

const MAX_PAGES = 25;
const MAX_DEPTH = 2;
/** Rough per-batch character budget for page text sent to the model. */
const BATCH_CHAR_BUDGET = 24_000;
const MAX_CHARS_PER_PAGE = 6_000;

/** Folders the model may file a section under, mirroring the OKF spec. */
const ALLOWED_FOLDERS = [
  'company',
  'services',
  'content',
  'voice',
  'proof',
  'seo/strategy',
];

const EXTRACTION_SYSTEM = `You are an SEO knowledge analyst building an Organizational Knowledge File (OKF) for a business, using only the text of their own website.

You will receive several pages. Produce structured knowledge sections that a copywriter could rely on.

Rules:
- Only state things the pages actually support. Never invent services, claims, guarantees, prices, locations or credentials.
- Prefer a few well-evidenced sections over many thin ones.
- Write each section body as clean Markdown starting with an H1.
- "folder" must be one of: ${ALLOWED_FOLDERS.join(', ')}.
- "filename" must be lowercase kebab-case with no extension.
- "confidence" is 0 to 1, reflecting how directly the pages support the section.

Respond with JSON of the shape:
{"sections":[{"folder":"company","filename":"overview","title":"Company Overview","body":"# ...","confidence":0.8,"source_urls":["https://..."]}]}`;

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

function normalizeUrl(url) {
  return url.split('#')[0].split('?')[0].replace(/\/$/, '');
}

/**
 * Breadth-first crawl of a single host, returning pages that actually have text.
 */
async function collectPages(rootUrl, onProgress) {
  const baseHost = new URL(rootUrl).hostname;
  const visited = new Set();
  const pages = [];
  const queue = [{ url: rootUrl, depth: 0 }];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const { url, depth } = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const page = await crawlPage(url, { includeBody: true });
    if (page.statusCode >= 200 && page.statusCode < 400 && (page.bodyText || '').length > 200) {
      pages.push({
        url: page.url,
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1,
        h2s: page.h2s,
        text: page.bodyText.slice(0, MAX_CHARS_PER_PAGE),
      });
      await onProgress?.(pages.length);
    }

    if (depth < MAX_DEPTH) {
      for (const link of page.internalLinks || []) {
        try {
          if (new URL(link).hostname !== baseHost) continue;
          if (visited.has(normalizeUrl(link))) continue;
          if (pages.length + queue.length >= MAX_PAGES * 2) break;
          queue.push({ url: link, depth: depth + 1 });
        } catch {
          // Unparseable href, skip.
        }
      }
    }
  }

  return pages;
}

function batchPages(pages) {
  const batches = [];
  let current = [];
  let size = 0;

  for (const page of pages) {
    const cost = page.text.length + 200;
    if (current.length > 0 && size + cost > BATCH_CHAR_BUDGET) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function renderBatch(pages) {
  return pages
    .map((p) => {
      const headings = [p.h1, ...(p.h2s || []).slice(0, 10)].filter(Boolean).join(' | ');
      return [
        `URL: ${p.url}`,
        p.title ? `Title: ${p.title}` : '',
        p.metaDescription ? `Meta: ${p.metaDescription}` : '',
        headings ? `Headings: ${headings}` : '',
        '',
        p.text,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');
}

function coerceSections(parsed) {
  const raw = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const sections = [];

  for (const s of raw) {
    const folder = ALLOWED_FOLDERS.includes(s?.folder) ? s.folder : 'company';
    const title = String(s?.title || '').trim();
    const body = String(s?.body || '').trim();
    if (!title || body.length < 80) continue;

    sections.push({
      folder,
      filename: slugify(s?.filename || title),
      title: title.slice(0, 255),
      body,
      confidence: typeof s?.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : null,
      sourceUrls: Array.isArray(s?.source_urls) ? s.source_urls.filter(Boolean).slice(0, 10) : [],
    });
  }

  return sections;
}

/**
 * Later batches may revisit a topic. Keep the longer body and union the sources
 * rather than filing two drafts for the same destination file.
 */
function mergeSections(all) {
  const byPath = new Map();

  for (const section of all) {
    const key = `${section.folder}/${section.filename}`;
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, section);
      continue;
    }
    byPath.set(key, {
      ...existing,
      body: section.body.length > existing.body.length ? section.body : existing.body,
      confidence: Math.max(existing.confidence ?? 0, section.confidence ?? 0) || null,
      sourceUrls: [...new Set([...existing.sourceUrls, ...section.sourceUrls])].slice(0, 10),
    });
  }

  return [...byPath.values()];
}

async function updateRun(runId, data, projectId) {
  const run = await prisma.knowledgeCrawlRun.update({ where: { id: runId }, data });
  if (projectId) {
    publish(projectId, 'kb:crawl', {
      runId,
      status: run.status,
      pagesCrawled: run.pagesCrawled,
      draftsCreated: run.draftsCreated,
    });
  }
  return run;
}

/**
 * Creates the run row. The caller is expected to kick off execute() without
 * awaiting it and hand the run id back to the client for polling.
 */
export async function createKnowledgeCrawlRun({ clientId, projectId = null, rootUrl, triggeredById = null }) {
  const url = new URL(rootUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be crawled');
  }

  return prisma.knowledgeCrawlRun.create({
    data: {
      clientId,
      projectId,
      rootUrl: url.href.slice(0, 1000),
      triggeredById,
      status: 'PENDING',
    },
  });
}

export async function executeKnowledgeCrawlRun(runId) {
  const run = await prisma.knowledgeCrawlRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== 'PENDING') return;

  const { clientId, projectId, rootUrl } = run;

  try {
    await updateRun(runId, { status: 'CRAWLING', startedAt: new Date() }, projectId);

    const pages = await collectPages(rootUrl, (count) =>
      prisma.knowledgeCrawlRun.update({ where: { id: runId }, data: { pagesCrawled: count } })
    );

    if (pages.length === 0) {
      await updateRun(
        runId,
        {
          status: 'FAILED',
          finishedAt: new Date(),
          error: 'No readable pages were found at that URL',
        },
        projectId
      );
      return;
    }

    await updateRun(runId, { status: 'EXTRACTING', pagesCrawled: pages.length }, projectId);

    const collected = [];
    for (const batch of batchPages(pages)) {
      const { parsed } = await generateChat({
        system: EXTRACTION_SYSTEM,
        user: renderBatch(batch),
        json: true,
        maxTokens: 4096,
        feature: 'knowledge_crawl',
        clientId,
      });

      // A batch that comes back unparseable is dropped rather than failing the
      // whole run; the remaining pages still produce useful drafts.
      if (parsed) collected.push(...coerceSections(parsed));
    }

    const sections = mergeSections(collected);
    const crawledAt = new Date().toISOString();

    if (sections.length > 0) {
      await prisma.okfDraftChange.createMany({
        data: sections.map((s) => ({
          clientId,
          folder: s.folder,
          filename: s.filename,
          title: s.title,
          proposedMetadata: {
            type: 'website-extract',
            title: s.title,
            source: 'WEBSITE_CRAWL',
            source_url: s.sourceUrls[0] || rootUrl,
            source_urls: s.sourceUrls,
            crawled_at: crawledAt,
          },
          proposedBody: s.body,
          sourceType: 'WEBSITE_CRAWL',
          confidence: s.confidence,
          status: 'PENDING',
        })),
      });
    }

    await updateRun(
      runId,
      {
        status: 'COMPLETED',
        finishedAt: new Date(),
        draftsCreated: sections.length,
      },
      projectId
    );
  } catch (err) {
    await updateRun(
      runId,
      {
        status: 'FAILED',
        finishedAt: new Date(),
        error: String(err?.message || err).slice(0, 1000),
      },
      projectId
    ).catch(() => {});
  }
}
