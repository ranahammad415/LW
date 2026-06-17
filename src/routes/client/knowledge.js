import path from 'path';
import { prisma } from '../../lib/prisma.js';
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

export async function clientKnowledgeRoutes(app) {
  // ── 0. Get client profile (from company/profile.md falling back to DB) ──
  app.get(
    '/knowledge/profile',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];

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
    '/knowledge/profile',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/files',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];

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
    '/knowledge/files/:folder/:filename',
    {
      onRequest: [app.verifyJwt, app.requireClient],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/files',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/files/:folder/:filename',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/upload',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];

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
    '/knowledge/interview/followup',
    {
      onRequest: [app.verifyJwt, app.requireClient],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
      const { question, answer } = request.body;

      try {
        const followup = await generateAiFollowup(question, answer, { clientId });
        return reply.send({ followup });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 6. Guided interview save ──
  app.post(
    '/knowledge/interview/save',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
      const { theme, qaPairs, expertName } = request.body;

      try {
        const metadata = {
          type: 'voice-interview',
          title: `Expert Interview: ${theme}`,
          author: expertName,
          tags: ['expert-interview', 'voice', 'knowledge-capture']
        };

        let body = `# Expert Interview: ${theme}\n\n`;
        body += `**Interviewer**: Local Waves AI Knowledge Engine\n`;
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

        const filename = `interview-${slugify(theme)}`;
        const filePath = writeOkfFile(clientId, 'voice', filename, metadata, body);
        return reply.status(201).send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  // ── 7. Audit knowledge gaps ──
  app.get(
    '/knowledge/gap-analysis',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];

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
    '/knowledge/gap-analysis/save',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/opportunities',
    {
      onRequest: [app.verifyJwt, app.requireClient],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/opportunities/save',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/article',
    {
      onRequest: [app.verifyJwt, app.requireClient],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
    '/knowledge/article/save',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(403).send({ message: 'No client account linked' });
      }
      const clientId = clientIds[0];
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
}
export default clientKnowledgeRoutes;
