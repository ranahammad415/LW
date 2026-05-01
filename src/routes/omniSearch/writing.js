import { prisma } from '../../lib/prisma.js';
import {
  generateArticleStream,
  rewriteContent,
} from '../../lib/omniSearch/omniSearchAi.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_MODEL = AI_MODEL;

export default async function writingRoutes(app) {
  // ── Auth guard on all routes ───────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── 1. POST /writing/generate-article — SSE streaming ──────────────────
  app.post('/writing/generate-article', async (request, reply) => {
    const { topic, outline, instructions, sessionId, projectId } = request.body || {};
    if (!topic) return reply.code(400).send({ success: false, error: 'topic is required' });

    // SSE headers — write directly to raw response (Fastify pattern from tool.js)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let fullContent = '';
    try {
      const stream = generateArticleStream(topic, outline || '', instructions || '');

      stream.on('text', (text) => {
        fullContent += text;
        reply.raw.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
      });

      await stream.finalMessage();

      // Extract title from first line
      const lines = fullContent.split('\n').filter((l) => l.trim());
      let title = topic;
      for (const line of lines) {
        const cleaned = line.replace(/^#+\s*/, '').replace(/^\[SEO TITLE\]\s*/i, '').replace(/^\*+/, '').trim();
        if (cleaned.length > 5 && cleaned.length < 200) { title = cleaned; break; }
      }

      // Extract meta description
      let metaDescription = null;
      const metaMatch = fullContent.match(/\[META DESCRIPTION\]\s*\n([^\n]+)/i);
      if (metaMatch) metaDescription = metaMatch[1].trim().slice(0, 500);

      const wordCount = fullContent.split(/\s+/).filter(Boolean).length;

      // Save article to DB
      const article = await prisma.omniSearchArticle.create({
        data: {
          sessionId: sessionId ? Number(sessionId) : null,
          projectId: projectId ? Number(projectId) : null,
          topic,
          title,
          content: fullContent,
          metaDescription,
          model: DEFAULT_MODEL,
          wordCount,
          type: 'article',
        },
      });

      reply.raw.write(`data: ${JSON.stringify({ done: true, article: { id: article.id, title, wordCount } })}\n\n`);
    } catch (err) {
      app.log.error(err, 'Article stream failed');
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Stream failed' })}\n\n`);
    }
    reply.raw.end();
  });

  // ─── 2. POST /writing/generate-outline ───────────────────────────────────
  app.post('/writing/generate-outline', async (request, reply) => {
    try {
      const { topic, targetKeyword, depth = 'detailed' } = request.body || {};
      if (!topic) return reply.status(400).send({ success: false, error: 'topic is required' });

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        system: `You are an expert content strategist. Generate a ${depth} article outline optimized for SEO. Return ONLY valid JSON.

Output format:
{
  "title": "...",
  "targetKeyword": "...",
  "estimatedWordCount": <number>,
  "sections": [
    {
      "heading": "H2: ...",
      "subheadings": [
        { "heading": "H3: ...", "keyPoints": ["..."], "estimatedWords": <number> }
      ],
      "keyPoints": ["..."],
      "estimatedWords": <number>
    }
  ],
  "faqQuestions": ["..."],
  "internalLinkOpportunities": ["..."]
}`,
        messages: [{ role: 'user', content: `Generate a ${depth} outline for an article about: "${topic}"${targetKeyword ? ` targeting the keyword "${targetKeyword}"` : ''}` }],
      });

      const text = response.content[0]?.text || '{}';
      let outline;
      try { outline = JSON.parse(text); } catch { outline = { raw: text }; }

      return { success: true, data: { outline } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 3. POST /writing/humanize ───────────────────────────────────────────
  app.post('/writing/humanize', async (request, reply) => {
    try {
      const { content, style = 'conversational' } = request.body || {};
      if (!content) return reply.status(400).send({ success: false, error: 'content is required' });

      const result = await rewriteContent(content, `Style: ${style}`, 'humanize');
      return { success: true, data: { content: result } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 4. POST /writing/rewrite ────────────────────────────────────────────
  app.post('/writing/rewrite', async (request, reply) => {
    try {
      const { content, instructions } = request.body || {};
      if (!content) return reply.status(400).send({ success: false, error: 'content is required' });

      const result = await rewriteContent(content, instructions || '', 'rewrite');
      return { success: true, data: { content: result } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 5. GET /writing/articles ────────────────────────────────────────────
  app.get('/writing/articles', async (request, reply) => {
    try {
      const { page = 1, limit = 20, type, sessionId } = request.query;
      const take = Math.min(Number(limit), 100);
      const skip = (Number(page) - 1) * take;

      const where = {};
      if (type) where.type = type;
      if (sessionId) where.sessionId = Number(sessionId);

      const [articles, total] = await Promise.all([
        prisma.omniSearchArticle.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            id: true,
            topic: true,
            title: true,
            metaDescription: true,
            model: true,
            wordCount: true,
            type: true,
            sessionId: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.omniSearchArticle.count({ where }),
      ]);

      return {
        success: true,
        data: {
          articles,
          total,
          page: Number(page),
          totalPages: Math.ceil(total / take),
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 6. GET /writing/articles/:id ───────────────────────────────────────
  app.get('/writing/articles/:id', async (request, reply) => {
    try {
      const article = await prisma.omniSearchArticle.findUnique({
        where: { id: Number(request.params.id) },
        include: {
          session: { select: { id: true, targetKeyword: true, title: true } },
        },
      });
      if (!article) return reply.status(404).send({ success: false, error: 'Article not found' });
      return { success: true, data: article };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 7. PATCH /writing/articles/:id ─────────────────────────────────────
  app.patch('/writing/articles/:id', async (request, reply) => {
    try {
      const id = Number(request.params.id);
      const { title, content, metaDescription } = request.body || {};

      const article = await prisma.omniSearchArticle.findUnique({ where: { id } });
      if (!article) return reply.status(404).send({ success: false, error: 'Article not found' });

      const updateData = {};
      if (title !== undefined) updateData.title = title;
      if (content !== undefined) {
        updateData.content = content;
        updateData.wordCount = content.split(/\s+/).filter(Boolean).length;
      }
      if (metaDescription !== undefined) updateData.metaDescription = metaDescription;

      const updated = await prisma.omniSearchArticle.update({
        where: { id },
        data: updateData,
      });

      return { success: true, data: updated };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 8. DELETE /writing/articles/:id ────────────────────────────────────
  app.delete('/writing/articles/:id', async (request, reply) => {
    try {
      const id = Number(request.params.id);
      const article = await prisma.omniSearchArticle.findUnique({ where: { id } });
      if (!article) return reply.status(404).send({ success: false, error: 'Article not found' });

      await prisma.omniSearchArticle.delete({ where: { id } });
      return { success: true, data: { deleted: true } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
