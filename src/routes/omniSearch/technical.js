import { prisma } from '../../lib/prisma.js';
import { crawlSite } from '../../lib/omniSearch/omniSearchCrawler.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL as OMNISEARCH_AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AI_MODEL = OMNISEARCH_AI_MODEL;

export default async function technicalRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── POST /audits ─────────────────────────────────────────────────────────
  app.post('/audits', async (request, reply) => {
    try {
      const { projectId, url, maxPages = 50, maxDepth = 3 } = request.body || {};
      if (!projectId || !url) {
        return reply.code(400).send({ success: false, error: 'projectId and url are required' });
      }

      // Create audit record
      let audit = await prisma.omniSearchAudit.create({
        data: {
          projectId: parseInt(projectId),
          url,
          status: 'crawling',
          settings: JSON.stringify({ maxPages, maxDepth }),
        },
      });

      // Crawl the site
      const pages = await crawlSite(url, parseInt(maxPages), parseInt(maxDepth));

      // Update status to analyzing
      await prisma.omniSearchAudit.update({
        where: { id: audit.id },
        data: { status: 'analyzing', pagesScanned: pages.length },
      });

      // Create crawled page records and detect issues
      const issues = [];

      for (const page of pages) {
        await prisma.omniSearchCrawledPage.create({
          data: {
            auditId: audit.id,
            url: page.url,
            statusCode: page.statusCode || null,
            title: page.title ? page.title.slice(0, 500) : null,
            metaDesc: page.metaDescription ? page.metaDescription.slice(0, 500) : null,
            h1: page.h1 ? page.h1.slice(0, 500) : null,
            canonical: page.canonical ? page.canonical.slice(0, 500) : null,
            wordCount: page.wordCount || null,
            loadTime: page.loadTime ? page.loadTime / 1000 : null,
            internalLinks: page.internalLinks?.length || 0,
            externalLinks: page.externalLinks?.length || 0,
            images: page.images?.length || 0,
          },
        });

        // Detect issues
        // CRITICAL issues
        if (!page.title) {
          issues.push({ type: 'missing_title', severity: 'critical', url: page.url, description: 'Page is missing a title tag', suggestion: 'Add a unique, descriptive title tag (50-60 characters)' });
        }
        if (!page.h1) {
          issues.push({ type: 'missing_h1', severity: 'critical', url: page.url, description: 'Page is missing an H1 heading', suggestion: 'Add a single H1 heading that describes the page content' });
        }
        if (page.statusCode >= 400 && page.statusCode < 600) {
          issues.push({ type: 'http_error', severity: 'critical', url: page.url, description: `Page returns HTTP ${page.statusCode} status code`, suggestion: 'Fix or redirect this URL to return a 200 status' });
        }
        if (!page.canonical && page.statusCode === 200) {
          issues.push({ type: 'missing_canonical', severity: 'critical', url: page.url, description: 'Important page is missing a canonical tag', suggestion: 'Add a self-referencing canonical URL to avoid duplicate content issues' });
        }

        // WARNING issues
        if (page.title && page.title.length > 60) {
          issues.push({ type: 'title_too_long', severity: 'warning', url: page.url, description: `Title tag is too long (${page.title.length} chars, max 60)`, suggestion: 'Shorten the title to 50-60 characters for optimal SERP display' });
        }
        if (page.title && page.title.length < 30 && page.title.length > 0) {
          issues.push({ type: 'title_too_short', severity: 'warning', url: page.url, description: `Title tag is too short (${page.title.length} chars, min 30)`, suggestion: 'Expand the title to 50-60 characters with relevant keywords' });
        }
        if (!page.metaDescription && page.statusCode === 200) {
          issues.push({ type: 'missing_meta_description', severity: 'warning', url: page.url, description: 'Page is missing a meta description', suggestion: 'Add a compelling meta description (120-160 characters)' });
        }
        if (page.metaDescription && page.metaDescription.length > 160) {
          issues.push({ type: 'meta_desc_too_long', severity: 'warning', url: page.url, description: `Meta description is too long (${page.metaDescription.length} chars, max 160)`, suggestion: 'Shorten the meta description to 120-160 characters' });
        }
        if (page.loadTime && page.loadTime > 3000) {
          issues.push({ type: 'slow_load_time', severity: 'warning', url: page.url, description: `Page load time is ${(page.loadTime / 1000).toFixed(1)}s (threshold: 3s)`, suggestion: 'Optimize images, minimize CSS/JS, enable caching' });
        }
        if (page.wordCount && page.wordCount < 300 && page.statusCode === 200) {
          issues.push({ type: 'low_word_count', severity: 'warning', url: page.url, description: `Page has only ${page.wordCount} words (minimum 300 recommended)`, suggestion: 'Add more valuable content to improve ranking potential' });
        }

        // INFO issues
        if (page.images && page.images.some(img => !img.alt)) {
          const missingAlt = page.images.filter(img => !img.alt).length;
          issues.push({ type: 'missing_alt_text', severity: 'info', url: page.url, description: `${missingAlt} image(s) missing alt text`, suggestion: 'Add descriptive alt text to all images for accessibility and SEO' });
        }
        if (page.externalLinks && page.externalLinks.length > 50) {
          issues.push({ type: 'too_many_external_links', severity: 'info', url: page.url, description: `Page has ${page.externalLinks.length} external links`, suggestion: 'Review external links to ensure they are necessary and relevant' });
        }
        if (page.structuredData && page.structuredData.length === 0 && page.statusCode === 200) {
          issues.push({ type: 'no_structured_data', severity: 'info', url: page.url, description: 'Page has no structured data (JSON-LD)', suggestion: 'Add relevant schema markup to enhance SERP appearance' });
        }
      }

      // Check for duplicate titles
      const titles = pages.filter(p => p.title).map(p => ({ url: p.url, title: p.title }));
      const titleCounts = {};
      for (const t of titles) {
        titleCounts[t.title] = (titleCounts[t.title] || []);
        titleCounts[t.title].push(t.url);
      }
      for (const [title, urls] of Object.entries(titleCounts)) {
        if (urls.length > 1) {
          for (const u of urls) {
            issues.push({ type: 'duplicate_title', severity: 'warning', url: u, description: `Duplicate title "${title.slice(0, 80)}" found on ${urls.length} pages`, suggestion: 'Create unique titles for each page' });
          }
        }
      }

      // Save issues
      for (const issue of issues) {
        await prisma.omniSearchAuditIssue.create({
          data: { auditId: audit.id, ...issue },
        });
      }

      // Calculate health score
      const criticalCount = issues.filter(i => i.severity === 'critical').length;
      const warningCount = issues.filter(i => i.severity === 'warning').length;
      const infoCount = issues.filter(i => i.severity === 'info').length;
      const healthScore = Math.max(0, Math.round(100 - (criticalCount * 10) - (warningCount * 3) - (infoCount * 0.5)));

      // Update audit as completed
      audit = await prisma.omniSearchAudit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          issueCount: issues.length,
          healthScore,
          completedAt: new Date(),
          summary: JSON.stringify({ critical: criticalCount, warning: warningCount, info: infoCount, pagesScanned: pages.length }),
        },
      });

      return { success: true, data: { audit } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /audits ──────────────────────────────────────────────────────────
  app.get('/audits', async (request, reply) => {
    try {
      const { projectId, page = 1, limit = 20 } = request.query;
      const where = projectId ? { projectId: parseInt(projectId) } : {};
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const [audits, total] = await Promise.all([
        prisma.omniSearchAudit.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
        prisma.omniSearchAudit.count({ where }),
      ]);

      return { success: true, data: { audits, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /audits/:id ──────────────────────────────────────────────────────
  app.get('/audits/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id);
      const audit = await prisma.omniSearchAudit.findUnique({ where: { id } });
      if (!audit) return reply.code(404).send({ success: false, error: 'Audit not found' });

      const issueCounts = await prisma.omniSearchAuditIssue.groupBy({
        by: ['severity'],
        where: { auditId: id },
        _count: { id: true },
      });

      const topIssues = await prisma.omniSearchAuditIssue.groupBy({
        by: ['type', 'severity'],
        where: { auditId: id },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      });

      return {
        success: true,
        data: {
          audit,
          issueCounts: issueCounts.reduce((acc, i) => { acc[i.severity] = i._count.id; return acc; }, {}),
          topIssues: topIssues.map(i => ({ type: i.type, severity: i.severity, count: i._count.id })),
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /audits/:id/pages ────────────────────────────────────────────────
  app.get('/audits/:id/pages', async (request, reply) => {
    try {
      const auditId = parseInt(request.params.id);
      const { page = 1, limit = 50, statusCode } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { auditId };
      if (statusCode) where.statusCode = parseInt(statusCode);

      const [pages, total] = await Promise.all([
        prisma.omniSearchCrawledPage.findMany({ where, skip, take, orderBy: { crawledAt: 'desc' } }),
        prisma.omniSearchCrawledPage.count({ where }),
      ]);

      return { success: true, data: { pages, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /audits/:id/issues ───────────────────────────────────────────────
  app.get('/audits/:id/issues', async (request, reply) => {
    try {
      const auditId = parseInt(request.params.id);
      const { severity, type, page = 1, limit = 50, grouped } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { auditId };
      if (severity) where.severity = severity;
      if (type) where.type = type;

      if (grouped === 'true') {
        const groupedIssues = await prisma.omniSearchAuditIssue.groupBy({
          by: ['type', 'severity'],
          where,
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        });
        return { success: true, data: { grouped: groupedIssues.map(g => ({ type: g.type, severity: g.severity, count: g._count.id })) } };
      }

      const [issues, total] = await Promise.all([
        prisma.omniSearchAuditIssue.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
        prisma.omniSearchAuditIssue.count({ where }),
      ]);

      return { success: true, data: { issues, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /audits/:id/compare/:prevId ──────────────────────────────────────
  app.get('/audits/:id/compare/:prevId', async (request, reply) => {
    try {
      const currentId = parseInt(request.params.id);
      const prevId = parseInt(request.params.prevId);

      const [current, previous] = await Promise.all([
        prisma.omniSearchAudit.findUnique({ where: { id: currentId } }),
        prisma.omniSearchAudit.findUnique({ where: { id: prevId } }),
      ]);

      if (!current || !previous) {
        return reply.code(404).send({ success: false, error: 'One or both audits not found' });
      }

      const [currentIssues, previousIssues] = await Promise.all([
        prisma.omniSearchAuditIssue.findMany({ where: { auditId: currentId } }),
        prisma.omniSearchAuditIssue.findMany({ where: { auditId: prevId } }),
      ]);

      const currentKeys = new Set(currentIssues.map(i => `${i.type}:${i.url}`));
      const previousKeys = new Set(previousIssues.map(i => `${i.type}:${i.url}`));

      const newIssues = currentIssues.filter(i => !previousKeys.has(`${i.type}:${i.url}`));
      const resolvedIssues = previousIssues.filter(i => !currentKeys.has(`${i.type}:${i.url}`));
      const unchangedCount = currentIssues.filter(i => previousKeys.has(`${i.type}:${i.url}`)).length;

      return {
        success: true,
        data: {
          current: { id: current.id, healthScore: current.healthScore, issueCount: current.issueCount, pagesScanned: current.pagesScanned },
          previous: { id: previous.id, healthScore: previous.healthScore, issueCount: previous.issueCount, pagesScanned: previous.pagesScanned },
          diff: {
            healthScoreChange: (current.healthScore || 0) - (previous.healthScore || 0),
            newIssues: newIssues.slice(0, 50),
            resolvedIssues: resolvedIssues.slice(0, 50),
            unchangedIssues: unchangedCount,
          },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /performance/:projectId/cwv ──────────────────────────────────────
  app.get('/performance/:projectId/cwv', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);

      // Get latest audit crawl data for context
      const latestAudit = await prisma.omniSearchAudit.findFirst({
        where: { projectId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        include: { pages: { take: 20 } },
      });

      const crawlContext = latestAudit
        ? `Latest audit: ${latestAudit.pagesScanned} pages scanned. Average load times and page sizes from crawl data:\n${latestAudit.pages.map(p => `${p.url} - ${p.loadTime}s, ${p.wordCount} words`).join('\n')}`
        : 'No previous crawl data available.';

      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system: `You are a web performance expert. Estimate Core Web Vitals metrics based on the provided crawl data. Return ONLY valid JSON.

Output format:
{
  "lcp": <number in ms>,
  "fid": <number in ms>,
  "cls": <number>,
  "ttfb": <number in ms>,
  "recommendations": ["recommendation 1", "recommendation 2"]
}`,
        messages: [{ role: 'user', content: `Estimate Core Web Vitals for project based on crawl data:\n${crawlContext}` }],
      });

      const text = response.content[0]?.text || '{}';
      let data;
      try { data = JSON.parse(text); } catch { data = { lcp: null, fid: null, cls: null, ttfb: null, recommendations: [] }; }

      return { success: true, data };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── DELETE /audits/:id ───────────────────────────────────────────────────
  app.delete('/audits/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id);
      await prisma.omniSearchAudit.delete({ where: { id } });
      return { success: true, data: { deleted: id } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
