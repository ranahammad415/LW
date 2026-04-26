import bcrypt from 'bcrypt';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../lib/prisma.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TOOL_MODEL = 'claude-sonnet-4-20250514';

// ─── Password helpers ────────────────────────────────────────────────────────
const DEFAULT_PASSWORD = 'agency2026';

async function getPasswordHash() {
  if (process.env.TOOL_PASSWORD_HASH) return process.env.TOOL_PASSWORD_HASH;
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TOOL_PASSWORD_HASH not set in .env                        ║');
  console.log('║  Generated hash for default password "agency2026":         ║');
  console.log(`║  ${hash}`);
  console.log('║  Add this to your .env as TOOL_PASSWORD_HASH               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  return hash;
}

// Simple in-memory token store (tool is internal, low traffic)
const toolTokens = new Set();

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

// ─── Auth guard (preHandler) ─────────────────────────────────────────────────
async function requireToolAuth(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
  const token = authHeader.slice(7);
  if (!toolTokens.has(token)) {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

// ─── Rate limiter (simple in-memory) ─────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX = 10;

function rateLimit(request, reply, done) {
  const ip = request.ip;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    reply.code(429).send({ error: 'Rate limit exceeded. Try again in 15 minutes.' });
    return;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  done();
}

// ─── Crawl prompt ────────────────────────────────────────────────────────────
function buildCrawlPrompt(url) {
  return `You are a senior content strategist and SEO expert. Crawl and analyze this website thoroughly using your web search capability.

WEBSITE: ${url}

Produce a structured intelligence report with these sections:

1. BUSINESS PROFILE
   - Business name and what they do
   - Industry / niche
   - Core services or products (list each)
   - Unique selling proposition
   - Geographic market (local / national / global)
   - Any credentials or awards mentioned

2. TARGET AUDIENCE
   - Who are their ideal customers?
   - What problems do they solve?
   - What language/tone does the audience use?
   - What emotions drive purchase decisions?

3. BRAND VOICE & TONE
   - Overall tone (professional / casual / expert / friendly / etc.)
   - Writing style patterns
   - Recurring phrases or taglines
   - What feeling should content leave with readers?

4. EXISTING CONTENT AUDIT
   - Blog present? List up to 5 existing topics
   - Content formats used
   - Content gaps — what is missing?

5. SEO SIGNALS
   - Main keywords visible across the site
   - Service page topics
   - Technical SEO health (brief)

6. TOP 5 BLOG ARTICLE OPPORTUNITIES
   For each: title, target keyword, search intent, why it fits, word count

7. CONTENT STRATEGY SUMMARY (3 sentences)
   Who they are, who they serve, what content builds trust and traffic.

Return clean structured text. Be thorough and specific.`;
}

// ─── Article prompt ──────────────────────────────────────────────────────────
function buildArticlePrompt(crawlReport, topic) {
  return `You are a world-class human content writer with deep expertise in SEO and content marketing. You have personally worked in this industry for years.

WEBSITE INTELLIGENCE REPORT:
${crawlReport}

ARTICLE TOPIC: ${topic}

Write a complete, publish-ready blog article following ALL of these rules:

═══════════════════════════════════════════
GOOGLE 2026 CONTENT STANDARDS
═══════════════════════════════════════════

✦ PEOPLE-FIRST: Write for the human reader, not search engines
✦ EXPERIENCE: Write as if you have personally used this service or solved this problem. Reference real scenarios, challenges, and results.
✦ EXPERTISE: Include specific details and insider insights a generalist would not know. No surface-level advice.
✦ AUTHORITATIVENESS: Reference industry norms and credible practices.
✦ TRUSTWORTHINESS: Be honest. Acknowledge trade-offs where they exist.
✦ ORIGINAL INSIGHT: Include one angle no competitor article would have.
✦ FULLY SATISFYING: Reader must not need to go elsewhere after reading.

═══════════════════════════════════════════
HUMANIZATION — NON-NEGOTIABLE RULES
═══════════════════════════════════════════

1. VARY SENTENCE LENGTH — Mix short punchy sentences with longer ones. Monotone sentence length is the top giveaway of AI writing.
2. USE REAL EXAMPLES — Ground every tip in a specific realistic scenario.
3. WRITE WITH OPINION — State a clear point of view. Be direct.
4. TALK TO ONE PERSON — Use "you" naturally throughout.
5. NATURAL TRANSITIONS — Use phrases like: "Here's the thing...", "That's where it gets interesting.", "But there's a catch.", "Let me explain." — not "Furthermore," or "Moreover,"
6. IMPERFECT RHYTHM — Paragraphs can be one sentence. Or five. Vary it naturally.
7. SHOW INSIDER KNOWLEDGE — One specific detail per section that only someone with real experience in this field would know.
8. NO THROAT-CLEARING — Start with the most interesting sentence you can write. Not background. Not definitions.

BANNED PHRASES — never use these:
- "In today's world" / "In today's digital landscape"
- "It is worth noting" / "It is important to note"
- "Furthermore," / "Moreover," / "Additionally,"
- "In conclusion" / "To summarize"
- "Crucial" / "Essential" / "Leverage" (overused)
- Any opener that delays the real content

═══════════════════════════════════════════
ARTICLE STRUCTURE — DELIVER IN THIS ORDER
═══════════════════════════════════════════

[SEO TITLE]
Write a compelling title with the primary keyword. Under 60 characters if possible.

[META DESCRIPTION]
150-160 characters. Include primary keyword. Make it earn the click.

[INTRODUCTION — 150-200 words]
Open with a hook (surprising stat, relatable scenario, or bold statement).
State the problem. Promise what this article delivers.
Include primary keyword in first 100 words.

[MAIN BODY — 1,400-2,000 words]

H2: What you need to know about [topic] (foundation section)
→ Real context, not a textbook definition

H2: What most people get wrong about [topic]
→ Insider observation — the common mistake

H2: How to [solve the problem / achieve the goal]
  H3: Step or tip 1 — with real example
  H3: Step or tip 2 — with specific detail
  H3: Step or tip 3 — with insider insight
  H3: Step or tip 4 — if needed

H2: What to avoid
→ Common pitfalls, written with authority

H2: [Unique angle — the one thing competitors don't say]
→ This section makes readers save and share the article

[FAQ — 4 questions]
Real questions from this niche. Answers: 50-100 words each.
This targets People Also Ask and featured snippets.

[CONCLUSION — 100-150 words]
Summarize the core insight. Reinforce reader confidence.
End with a clear, natural CTA (no hard sell).
Note where [INTERNAL LINK: service name] should appear.

Match the brand voice from the crawl report exactly.
Write as a human expert who genuinely cares about helping the reader.
Do not add commentary. Just deliver the complete article.`;
}

// ─── Fastify plugin ──────────────────────────────────────────────────────────
export async function toolRoutes(app) {
  // POST /login
  app.post('/login', async (request, reply) => {
    const { password } = request.body || {};
    if (!password) return reply.code(400).send({ error: 'Password required' });
    const hash = await getPasswordHash();
    const match = await bcrypt.compare(password, hash);
    if (!match) return reply.code(401).send({ error: 'Incorrect password' });
    const token = generateToken();
    toolTokens.add(token);
    return { success: true, token };
  });

  // POST /logout
  app.post('/logout', { preHandler: requireToolAuth }, async (request) => {
    const token = request.headers.authorization.slice(7);
    toolTokens.delete(token);
    return { success: true };
  });

  // GET /auth-check
  app.get('/auth-check', async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authenticated: false };
    }
    return { authenticated: toolTokens.has(authHeader.slice(7)) };
  });

  // POST /crawl — crawl a website via Claude
  app.post('/crawl', {
    preHandler: [requireToolAuth, (req, rep, done) => rateLimit(req, rep, done)],
  }, async (request, reply) => {
    const { url } = request.body || {};
    if (!url) return reply.code(400).send({ error: 'URL required' });
    // Validate URL
    try { new URL(url); } catch { return reply.code(400).send({ error: 'Invalid URL' }); }

    try {
      const message = await anthropic.messages.create({
        model: TOOL_MODEL,
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildCrawlPrompt(url) }],
      });
      const report = message.content[0]?.text || '';
      const domain = new URL(url).hostname;

      const crawl = await prisma.toolCrawlSession.create({
        data: { url, domain, report },
      });
      return { id: crawl.id, domain, report };
    } catch (err) {
      request.log.error({ err }, 'Crawl failed');
      return reply.code(500).send({ error: 'Crawl failed: ' + (err.message || 'Unknown error') });
    }
  });

  // GET /crawls — list all crawls
  app.get('/crawls', { preHandler: requireToolAuth }, async () => {
    return prisma.toolCrawlSession.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, url: true, domain: true, createdAt: true },
    });
  });

  // GET /crawls/:id
  app.get('/crawls/:id', { preHandler: requireToolAuth }, async (request, reply) => {
    const crawl = await prisma.toolCrawlSession.findUnique({
      where: { id: Number(request.params.id) },
    });
    if (!crawl) return reply.code(404).send({ error: 'Crawl not found' });
    return crawl;
  });

  // PATCH /crawls/:id — update crawl report text
  app.patch('/crawls/:id', { preHandler: requireToolAuth }, async (request, reply) => {
    const { report } = request.body || {};
    if (typeof report !== 'string') return reply.code(400).send({ error: 'report text required' });
    const crawl = await prisma.toolCrawlSession.findUnique({ where: { id: Number(request.params.id) } });
    if (!crawl) return reply.code(404).send({ error: 'Crawl not found' });
    const updated = await prisma.toolCrawlSession.update({
      where: { id: crawl.id },
      data: { report },
    });
    return updated;
  });

  // POST /article/stream — stream article via SSE
  app.post('/article/stream', {
    preHandler: [requireToolAuth, (req, rep, done) => rateLimit(req, rep, done)],
  }, async (request, reply) => {
    const { crawlId, topic } = request.body || {};
    if (!crawlId || !topic) return reply.code(400).send({ error: 'crawlId and topic required' });

    const crawl = await prisma.toolCrawlSession.findUnique({ where: { id: Number(crawlId) } });
    if (!crawl) return reply.code(404).send({ error: 'Crawl session not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let fullContent = '';
    try {
      const stream = anthropic.messages.stream({
        model: TOOL_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: buildArticlePrompt(crawl.report, topic) }],
      });

      stream.on('text', (text) => {
        fullContent += text;
        reply.raw.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
      });

      await stream.finalMessage();

      // Extract title from first line
      const lines = fullContent.split('\n').filter(l => l.trim());
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

      const article = await prisma.toolArticle.create({
        data: {
          crawlId: crawl.id,
          topic,
          title,
          content: fullContent,
          metaDescription,
          wordCount,
        },
      });

      reply.raw.write(`data: ${JSON.stringify({ type: 'done', articleId: article.id, wordCount })}\n\n`);
    } catch (err) {
      request.log.error({ err }, 'Article stream failed');
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Stream failed' })}\n\n`);
    }
    reply.raw.end();
  });

  // GET /articles
  app.get('/articles', { preHandler: requireToolAuth }, async () => {
    return prisma.toolArticle.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        topic: true,
        title: true,
        wordCount: true,
        createdAt: true,
        crawl: { select: { url: true, domain: true } },
      },
    });
  });

  // GET /articles/:id
  app.get('/articles/:id', { preHandler: requireToolAuth }, async (request, reply) => {
    const article = await prisma.toolArticle.findUnique({
      where: { id: Number(request.params.id) },
      include: { crawl: { select: { url: true, domain: true } } },
    });
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    return article;
  });
}
