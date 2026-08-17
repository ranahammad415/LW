/**
 * Knowledge base CRUD and AI helpers.
 *
 * Mounted twice with different client resolution:
 *   - /api/client/knowledge/...                    caller's own client
 *   - /api/staff/clients/:clientId/knowledge/...   Owner (rw) or PM (read-only)
 *
 * The handler bodies are shared; only the guards, the path prefix and how the
 * client id is resolved differ between the two mounts.
 */
import path from 'path';
import { prisma } from '../../lib/prisma.js';
import {
  requireStaffKnowledgeRead,
  requireStaffKnowledgeWrite,
} from '../../lib/knowledgeScope.js';
import { 
  listClientFiles, 
  readOkfFile, 
  writeOkfFile, 
  extractFileContent, 
  analyzeDocumentWithAi,
  generateAiFollowup, 
  analyzeKnowledgeGaps, 
  generateContentOpportunities,
  generateArticle,
  slugify,
  initializeClientDirs,
  getClientDir
} from '../../lib/knowledgeEngine.js';
import { isAiConfigured } from '../../lib/ai.js';
import { buildClientBriefing, siteReviewStatus } from '../../lib/interviewBriefing.js';
import {
  runInterviewTurn,
  upsertInterviewDrafts,
  buildOpeningQuestion,
  buildPlannedTopics,
  INTERVIEW_SOURCE_TYPE,
} from '../../lib/expertInterview.js';
import {
  createKnowledgeCrawlRun,
  executeKnowledgeCrawlRun,
} from '../../lib/knowledgeCrawler.js';

const CRAWL_ACTIVE_STATUSES = ['PENDING', 'CRAWLING', 'EXTRACTING'];

/** What the "captured so far" panel renders, grouped by destination file. */
async function loadSessionCaptures(clientId, sessionId) {
  const drafts = await prisma.okfDraftChange.findMany({
    where: { clientId, sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      folder: true,
      filename: true,
      title: true,
      confidence: true,
      status: true,
      proposedBody: true,
    },
  });

  return drafts.map((d) => ({
    id: d.id,
    folder: d.folder,
    filename: d.filename,
    title: d.title,
    confidence: d.confidence,
    status: d.status,
    path: `${d.folder}/${d.filename}.md`,
    excerpt: d.proposedBody.slice(0, 240),
  }));
}

function buildKnowledgeRoutes({ staff }) {
  return async function knowledgeRoutes(app) {
    const base = staff ? '/clients/:clientId' : '';
    const readGuards = staff
      ? [app.verifyJwt, requireStaffKnowledgeRead]
      : [app.verifyJwt, app.requireClient];
    const writeGuards = staff
      ? [app.verifyJwt, requireStaffKnowledgeWrite]
      : [app.verifyJwt, app.requireClient, app.requireClientWriter];

    // On the client mount this keeps the original "first linked client" rule.
    const clientIdOf = staff
      ? (request) => request.knowledgeClientId || null
      : (request) => request.clientAccountIds?.[0] ?? null;

  // ── 0. Get client profile (from company/profile.md falling back to DB) ──
  app.get(
    `${base}/knowledge/profile`,
    {
      onRequest: readGuards,
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      try {
        initializeClientDirs(clientId);
        let profile = null;
        try {
          profile = readOkfFile(clientId, 'company', 'profile');
        } catch (err) {
          // Doesn't exist, build from DB
          const clientAccount = await prisma.clientAccount.findUnique({
            where: { id: clientId }
          });
          profile = {
            metadata: {
              type: 'company-profile',
              title: 'Company Profile',
              agency_name: clientAccount.agencyName || '',
              website_url: clientAccount.websiteUrl || '',
              industry: clientAccount.industry || '',
              target_market: '',
              brand_voice: '',
              competitors: '',
              differentiators: ''
            },
            body: `# ${clientAccount.agencyName || 'Company'} Profile\n\nEdit this to describe your company.`
          };
        }
        return reply.send(profile);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 0b. Save client profile ──
  app.post(
    `${base}/knowledge/profile`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            metadata: { type: 'object' },
            body: { type: 'string' }
          },
          required: ['metadata', 'body']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { metadata, body } = request.body;

      try {
        const filePath = writeOkfFile(clientId, 'company', 'profile', metadata, body);
        
        // Also update Prisma clientAccount fields if they match
        const updateData = {};
        if (metadata.agency_name) updateData.agencyName = metadata.agency_name;
        if (metadata.website_url) updateData.websiteUrl = metadata.website_url;
        if (metadata.industry) updateData.industry = metadata.industry;
        
        if (Object.keys(updateData).length > 0) {
          await prisma.clientAccount.update({
            where: { id: clientId },
            data: updateData
          });
        }

        return reply.send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 1. List all client files ──
  app.get(
    `${base}/knowledge/files`,
    {
      onRequest: readGuards,
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      try {
        initializeClientDirs(clientId);
        const files = listClientFiles(clientId);
        return reply.send(files);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 2. Read single OKF file ──
  app.get(
    `${base}/knowledge/files/:folder/:filename`,
    {
      onRequest: readGuards,
      schema: {
        params: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            filename: { type: 'string' }
          },
          required: ['folder', 'filename']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { folder, filename } = request.params;

      try {
        const fileData = readOkfFile(clientId, folder, filename);
        return reply.send(fileData);
      } catch (err) {
        return reply.status(404).send({ message: err.message });
      }
    }
  );

  // ── 3. Save or edit file ──
  app.post(
    `${base}/knowledge/files`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            filename: { type: 'string' },
            metadata: { type: 'object' },
            body: { type: 'string' }
          },
          required: ['folder', 'filename', 'metadata', 'body']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { folder, filename, metadata, body } = request.body;

      try {
        const filePath = writeOkfFile(clientId, folder, filename, metadata, body);
        return reply.status(201).send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 3b. Delete file ──
  app.delete(
    `${base}/knowledge/files/:folder/:filename`,
    {
      onRequest: writeGuards,
      schema: {
        params: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            filename: { type: 'string' }
          },
          required: ['folder', 'filename']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { folder, filename } = request.params;

      try {
        const clientDir = getClientDir(clientId);
        const cleanFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
        const filePath = path.join(clientDir, folder, cleanFilename);
        const fs = await import('fs');
        if (fs.default.existsSync(filePath)) {
          fs.default.unlinkSync(filePath);
          return reply.send({ success: true });
        }
        return reply.status(404).send({ message: 'File not found' });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 4. Upload and analyze file ──
  app.post(
    `${base}/knowledge/upload`,
    {
      onRequest: writeGuards,
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }

      try {
        const buffer = await data.toBuffer();
        const ext = data.filename.split('.').pop();
        const text = await extractFileContent(buffer, ext);
        
        // Call Claude to analyze, summary and categorize
        const analysis = await analyzeDocumentWithAi(text, data.filename, { clientId });
        
        return reply.send({
          filename: data.filename,
          raw_text: text,
          analysis
        });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 5. Guided interview follow-up ──
  app.post(
    `${base}/knowledge/interview/followup`,
    {
      onRequest: readGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' }
          },
          required: ['question', 'answer']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { question, answer } = request.body;

      try {
        const followup = await generateAiFollowup(question, answer, { clientId });
        return reply.send({ followup });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 5a. AI-led expert interview ──────────────────────────────────────────
  //
  // The AI reviews the client's site and knowledge base first, then interviews
  // them one question at a time, filing what it learns as PENDING drafts as the
  // conversation runs. The transcript lives on the session row rather than in
  // the browser, so the model always sees the answer it is responding to and a
  // refresh does not lose the interview.

  app.get(
    `${base}/knowledge/interview/session`,
    { onRequest: readGuards },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      try {
        const session = await prisma.voiceInterviewSession.findFirst({
          where: { clientId, mode: 'TEXT', status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
        });

        const siteStatus = await siteReviewStatus(clientId);
        if (!session) {
          return reply.send({ session: null, siteStatus, aiConfigured: isAiConfigured() });
        }

        return reply.send({
          session: {
            id: session.id,
            startedAt: session.startedAt,
            transcript: session.transcript || [],
            briefing: session.briefing || null,
            plannedTopics: session.extractedData?.plannedTopics || [],
            topicsCovered: session.extractedData?.topicsCovered || [],
            isFinished: Boolean(session.extractedData?.isFinished),
          },
          captured: await loadSessionCaptures(clientId, session.id),
          siteStatus,
          aiConfigured: isAiConfigured(),
        });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  app.post(
    `${base}/knowledge/interview/start`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string', nullable: true },
            seedTopic: { type: 'string' },
            seedCategory: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      if (!isAiConfigured()) {
        return reply.status(503).send({
          message: 'The interview assistant is not configured. Set ANTHROPIC_API_KEY in your .env file.',
        });
      }

      const { projectId = null, seedTopic = null, seedCategory = null } = request.body || {};

      try {
        // Starting is an explicit action, so any interview left open in another
        // tab is retired rather than competing for the same drafts.
        await prisma.voiceInterviewSession.updateMany({
          where: { clientId, mode: 'TEXT', status: 'ACTIVE' },
          data: { status: 'ABANDONED', endedAt: new Date() },
        });

        const briefing = await buildClientBriefing(clientId, { projectId });
        const openingQuestion = buildOpeningQuestion(briefing, seedTopic);
        const plannedTopics = buildPlannedTopics(briefing);

        const session = await prisma.voiceInterviewSession.create({
          data: {
            clientId,
            projectId,
            userId: request.user.id,
            mode: 'TEXT',
            status: 'ACTIVE',
            briefing,
            transcript: [
              { role: 'assistant', content: openingQuestion, at: new Date().toISOString() },
            ],
            extractedData: {
              plannedTopics,
              topicsCovered: [],
              gaps: [],
              seedTopic,
              seedCategory,
              isFinished: false,
            },
          },
        });

        return reply.status(201).send({
          sessionId: session.id,
          briefing,
          openingQuestion,
          plannedTopics,
          captured: [],
        });
      } catch (err) {
        request.log.error({ err }, 'Could not start expert interview');
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  app.post(
    `${base}/knowledge/interview/turn`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            message: { type: 'string', minLength: 1 },
          },
          required: ['sessionId', 'message'],
        },
      },
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      const { sessionId, message } = request.body;

      const session = await prisma.voiceInterviewSession.findUnique({ where: { id: sessionId } });
      if (!session || session.clientId !== clientId || session.mode !== 'TEXT') {
        return reply.status(404).send({ message: 'Interview session not found' });
      }
      if (session.status !== 'ACTIVE') {
        return reply.status(409).send({ message: 'This interview has already been completed.' });
      }

      const transcript = Array.isArray(session.transcript) ? session.transcript : [];
      const state = session.extractedData || {};

      let turn;
      try {
        turn = await runInterviewTurn({
          briefing: session.briefing || (await buildClientBriefing(clientId, { projectId: session.projectId })),
          transcript,
          message,
          seedTopic: state.seedTopic || null,
          clientId,
          userId: request.user.id,
        });
      } catch (err) {
        request.log.error({ err, sessionId }, 'Expert interview turn failed');
        return reply.status(502).send({
          message: err.message || 'The interview assistant is temporarily unavailable. Please try again.',
        });
      }

      const captured = await upsertInterviewDrafts({
        clientId,
        sessionId: session.id,
        captures: turn.captures,
      });

      const now = new Date().toISOString();
      const topicsCovered = [
        ...new Set([...(state.topicsCovered || []), ...turn.topicsCovered]),
      ].slice(0, 40);
      const gaps = [...(state.gaps || []), ...turn.gaps].slice(0, 40);

      await prisma.voiceInterviewSession.update({
        where: { id: session.id },
        data: {
          transcript: [
            ...transcript,
            { role: 'user', content: message, at: now },
            { role: 'assistant', content: turn.nextQuestion, at: now },
          ],
          extractedData: { ...state, topicsCovered, gaps, isFinished: turn.isFinished },
        },
      });

      return reply.send({
        nextQuestion: turn.nextQuestion,
        captured: await loadSessionCaptures(clientId, session.id),
        newlyCaptured: captured,
        gaps: turn.gaps,
        topicsCovered,
        isFinished: turn.isFinished,
      });
    }
  );

  app.post(
    `${base}/knowledge/interview/finish`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['sessionId'],
        },
      },
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      const { sessionId, summary = null } = request.body;

      const session = await prisma.voiceInterviewSession.findUnique({ where: { id: sessionId } });
      if (!session || session.clientId !== clientId || session.mode !== 'TEXT') {
        return reply.status(404).send({ message: 'Interview session not found' });
      }

      const captured = await loadSessionCaptures(clientId, session.id);

      if (session.status === 'ACTIVE') {
        await prisma.voiceInterviewSession.update({
          where: { id: session.id },
          data: {
            status: 'COMPLETED',
            endedAt: new Date(),
            durationSeconds: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
            summary: summary ? String(summary).slice(0, 4000) : session.summary,
          },
        });

        // Gaps are advisory notes for the SEO team rather than proposed content,
        // so they go on the activity feed instead of the draft queue.
        const gaps = session.extractedData?.gaps || [];
        if (gaps.length) {
          await prisma.clientActivityLog.create({
            data: {
              clientId,
              userId: request.user.id,
              action: 'EXPERT_INTERVIEW_GAPS',
              detail: gaps.map((g) => `${g.category}: ${g.description}`).join(' | ').slice(0, 1000),
              metadata: { sessionId: session.id, gaps },
            },
          }).catch(() => {});
        }
      }

      return reply.send({
        success: true,
        sessionId: session.id,
        draftsQueued: captured.filter((c) => c.status === 'PENDING').length,
        captured,
      });
    }
  );

  // Kicks a crawl when the briefing has nothing to go on, so the AI can be
  // restarted against a site it has actually read.
  app.post(
    `${base}/knowledge/interview/review-site`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            rootUrl: { type: 'string' },
            projectId: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      const { projectId = null } = request.body || {};

      const existing = await prisma.knowledgeCrawlRun.findFirst({
        where: { clientId, status: { in: CRAWL_ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return reply.status(202).send({ run: existing });

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { websiteUrl: true },
      });
      const rootUrl = String(request.body?.rootUrl || client?.websiteUrl || '').trim();
      if (!rootUrl) {
        return reply.status(400).send({ message: 'No website URL on file. Add one to review the site.' });
      }

      let run;
      try {
        run = await createKnowledgeCrawlRun({
          clientId,
          projectId,
          rootUrl: /^https?:\/\//i.test(rootUrl) ? rootUrl : `https://${rootUrl}`,
          triggeredById: request.user.id,
        });
      } catch (err) {
        return reply.status(400).send({ message: err.message });
      }

      setImmediate(() => {
        executeKnowledgeCrawlRun(run.id).catch((err) =>
          app.log.error({ err, runId: run.id }, 'Interview site review crawl failed')
        );
      });

      return reply.status(202).send({ run });
    }
  );

  // ── 6. Guided interview save ──
  //
  // Superseded by the AI-led interview above, but kept for any client still on
  // an older bundle. It used to write straight to disk; it now queues a draft
  // so typed answers go through the same review as everything else.
  app.post(
    `${base}/knowledge/interview/save`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            theme: { type: 'string' },
            qaPairs: { type: 'array' },
            expertName: { type: 'string' }
          },
          required: ['theme', 'qaPairs', 'expertName']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { theme, qaPairs, expertName } = request.body;

      try {
        let body = `# Expert Interview: ${theme}\n\n`;
        body += `**Expert**: ${expertName}\n\n`;
        body += '---\n\n';

        qaPairs.forEach((qa, idx) => {
          body += `### ${idx + 1}. ${qa.question}\n\n`;
          body += `> **Answer**: ${qa.answer}\n\n`;
          if (qa.followups && qa.followups.length > 0) {
            qa.followups.forEach(([f_q, f_a]) => {
              body += `* **Follow-up**: ${f_q}\n`;
              body += `  > **Answer**: ${f_a}\n\n`;
            });
          }
          body += '\n';
        });

        const draft = await prisma.okfDraftChange.create({
          data: {
            clientId,
            folder: 'voice',
            filename: `interview-${slugify(theme)}`.slice(0, 255),
            title: `Expert Interview: ${theme}`.slice(0, 255),
            proposedMetadata: {
              type: 'expert-interview',
              title: `Expert Interview: ${theme}`,
              author: expertName,
              source: INTERVIEW_SOURCE_TYPE,
              captured_at: new Date().toISOString(),
              tags: ['expert-interview', 'knowledge-capture'],
            },
            proposedBody: body,
            sourceType: INTERVIEW_SOURCE_TYPE,
            status: 'PENDING',
          },
        });

        return reply.status(201).send({ success: true, draftId: draft.id, queuedForReview: true });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 7. Audit knowledge gaps ──
  app.get(
    `${base}/knowledge/gap-analysis`,
    {
      onRequest: readGuards,
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }

      try {
        // Load client details
        const clientAccount = await prisma.clientAccount.findUnique({
          where: { id: clientId }
        });

        let profileData = {
          company_name: clientAccount.agencyName,
          website: clientAccount.websiteUrl,
          industry: clientAccount.industry,
          services: clientAccount.internalNotes || 'Not defined'
        };

        try {
          const profileFile = readOkfFile(clientId, 'company', 'profile');
          if (profileFile && profileFile.metadata) {
            profileData = {
              ...profileData,
              company_name: profileFile.metadata.agency_name || profileData.company_name,
              website: profileFile.metadata.website_url || profileData.website,
              industry: profileFile.metadata.industry || profileData.industry,
              target_market: profileFile.metadata.target_market || '',
              brand_voice: profileFile.metadata.brand_voice || '',
              competitors: profileFile.metadata.competitors || '',
              differentiators: profileFile.metadata.differentiators || '',
              description: profileFile.body || ''
            };
          }
        } catch (_) {}

        // Load existing assets catalog
        const assets = listClientFiles(clientId).filter(a => a.folder !== 'knowledge-gaps');
        const assetCatalog = assets.map(a => ({
          title: a.title,
          folder: a.folder,
          type: a.type,
          excerpt: a.excerpt
        }));

        const analysis = await analyzeKnowledgeGaps(profileData, assetCatalog, { clientId });
        return reply.send(analysis);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 8. Save gap analysis ──
  app.post(
    `${base}/knowledge/gap-analysis/save`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            analysis: { type: 'object' }
          },
          required: ['analysis']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { analysis } = request.body;

      try {
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Wait, let's write the saveGapAnalysis function locally or import it.
        // Let's implement saveGapAnalysis format here for complete self-containment:
        const metadata = {
          type: 'gap-analysis',
          title: `Knowledge Gap Analysis - ${todayStr}`,
          readiness_score: analysis.readiness_score,
          tags: ['gap-analysis', 'knowledge-audit']
        };

        let body = `# Knowledge Gap Analysis: ${todayStr}\n\n`;
        body += `**Overall Readiness Score**: ${analysis.readiness_score}/100\n\n`;
        body += `### Summary Evaluation\n${analysis.findings_summary}\n\n`;
        
        body += '### Identified Gaps\n';
        if (analysis.gaps && analysis.gaps.length > 0) {
          analysis.gaps.forEach((gap, idx) => {
            body += `#### ${idx + 1}. [${gap.category.toUpperCase()}] - ${gap.severity} Severity\n`;
            body += `- **Description**: ${gap.description}\n`;
            body += `- **Impact**: ${gap.impact}\n\n`;
          });
        } else {
          body += 'No significant gaps identified.\n\n';
        }

        body += '### Recommended Interview Questions\n';
        if (analysis.recommended_questions && analysis.recommended_questions.length > 0) {
          analysis.recommended_questions.forEach(q => {
            body += `- **Category**: ${q.category.replace(/^\w/, c => c.toUpperCase())}\n`;
            body += `  - **Question**: *${q.question}*\n`;
            body += `  - **Goal**: ${q.reason}\n\n`;
          });
        } else {
          body += 'No recommended questions.\n';
        }

        const filename = `gap-analysis-${todayStr}`;
        const savePath = writeOkfFile(clientId, 'knowledge-gaps', filename, metadata, body);
        return reply.status(201).send({ success: true, path: savePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 9. Plan content opportunities ──
  app.post(
    `${base}/knowledge/opportunities`,
    {
      onRequest: readGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            service: { type: 'string' },
            topic: { type: 'string' }
          },
          required: ['keyword', 'service', 'topic']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { keyword, service, topic } = request.body;

      try {
        const searchContextText = ''; // Can search files text here if needed
        const opps = await generateContentOpportunities(keyword, service, topic, searchContextText, { clientId });
        return reply.send(opps);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 10. Save opportunities plan ──
  app.post(
    `${base}/knowledge/opportunities/save`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            opportunities: { type: 'object' }
          },
          required: ['topic', 'opportunities']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { topic, opportunities } = request.body;

      try {
        const metadata = {
          type: 'content-opportunities',
          title: `Content Opportunities: ${topic}`,
          tags: ['content-opportunity', 'seo-insights']
        };

        let body = `# Content Opportunities: ${topic}\n\n`;
        body += `### Search Intent Analysis\n${opportunities.search_intent}\n\n`;
        
        body += '### 10 Target Customer Questions\n';
        if (opportunities.questions) {
          opportunities.questions.forEach((q, idx) => {
            body += `${idx + 1}. ${q}\n`;
          });
        }
        body += '\n';

        body += '### FAQ Opportunities\n';
        if (opportunities.faq_opportunities) {
          opportunities.faq_opportunities.forEach(faq => {
            body += `- **Q**: ${faq.question}\n`;
            body += `  - **Concept**: ${faq.concept}\n\n`;
          });
        }

        body += `### AI Visibility & Search Engine Optimization Insights\n${opportunities.ai_visibility_insights}\n\n`;

        body += '### Recommended Article Concepts\n';
        if (opportunities.article_concepts) {
          opportunities.article_concepts.forEach(c => {
            body += `#### ${c.title}\n`;
            body += `- **Hook**: *${c.hook}*\n`;
            body += `- **Brief**: ${c.brief}\n\n`;
          });
        }

        const filename = `opportunities-${slugify(topic)}`;
        const filePath = writeOkfFile(clientId, 'content', filename, metadata, body);
        return reply.status(201).send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 11. Draft article ──
  app.post(
    `${base}/knowledge/article`,
    {
      onRequest: readGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            question: { type: 'string' },
            referencePaths: { type: 'array' }
          },
          required: ['topic', 'question', 'referencePaths']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { topic, question, referencePaths } = request.body;

      try {
        let contextText = '';
        for (const p of referencePaths) {
          try {
            const parts = p.split('/');
            const filename = parts.pop();
            const folder = parts.join('/');
            const { metadata, body } = readOkfFile(clientId, folder, filename);
            contextText += `Document: ${metadata.title || filename}\nContent:\n${body}\n\n---\n\n`;
          } catch (_) {}
        }

        const article = await generateArticle(topic, question, contextText, { clientId });
        return reply.send(article);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 12. Save article ──
  app.post(
    `${base}/knowledge/article/save`,
    {
      onRequest: writeGuards,
      schema: {
        body: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            article: { type: 'object' },
            references: { type: 'array' }
          },
          required: ['topic', 'article', 'references']
        }
      }
    },
    async (request, reply) => {
      const clientId = clientIdOf(request);
      if (!clientId) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const { topic, article, references } = request.body;

      try {
        const metadata = {
          type: 'article',
          title: article.article_title || topic,
          source_assets: references,
          tags: ['blog-article', 'content-marketing', 'knowledge-operationalized']
        };

        let body = `# ${article.article_title || topic}\n\n`;
        body += '### Article Outline\n';
        body += `${article.outline}\n\n`;
        body += '---\n\n';

        body += `### Article Draft\n\n${article.draft}\n\n`;
        body += '---\n\n';

        body += '### Frequently Asked Questions\n';
        if (article.faqs) {
          article.faqs.forEach(faq => {
            body += `#### Q: ${faq.q}\n`;
            body += `A: ${faq.a}\n\n`;
          });
        }

        body += '### Suggested Internal Links\n';
        if (article.suggested_internal_links) {
          article.suggested_internal_links.forEach(link => {
            body += `- ${link}\n`;
          });
        }
        body += '\n';

        body += '### Suggested SEO JSON-LD Schema Markup\n';
        body += `\`\`\`html\n<script type="application/ld+json">\n${article.schema_markup}\n</script>\n\`\`\`\n`;

        const filename = slugify(topic);
        const filePath = writeOkfFile(clientId, 'content/articles', filename, metadata, body);
        return reply.status(201).send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );
  };
}

export const clientKnowledgeRoutes = buildKnowledgeRoutes({ staff: false });
export const staffKnowledgeRoutes = buildKnowledgeRoutes({ staff: true });
export default clientKnowledgeRoutes;
