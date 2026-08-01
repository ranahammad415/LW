import { prisma } from '../prisma.js';
import { generateChat, isAiConfigured } from '../ai.js';
import { normalizeAiContent } from './formalTemplate/renderFormalHtml.js';

const ACTIVE_TASK_STATUSES = [
  'TO_DO',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'REVISION_NEEDED',
  'BLOCKED',
  'WAITING_DEPENDENCY',
];

const CLIENT_SYSTEM_PROMPT = `You are a Senior SEO Account Manager at Local Waves writing a formal monthly SEO & Performance Report PDF for a client.
Tone: consultative, professional, confidence-inspiring. Focus on value delivered.
Avoid AI filler ("delve", "testament", "robust"). Never invent URLs, metrics, or deliverables not present in the facts.

Return ONLY valid JSON with exactly this shape:
{
  "coverSummary": "1 short paragraph (3-5 sentences) for the cover page summarizing the month.",
  "preparedBy": "author name string",
  "executive": {
    "strategicApproach": "paragraph",
    "performanceGains": "paragraph (use search KPIs from facts when present)",
    "localVisibility": "paragraph or empty string",
    "technicalHealth": "paragraph or empty string",
    "nextSteps": "paragraph for next month"
  },
  "sections": [
    {
      "number": 2,
      "title": "ALL CAPS SECTION TITLE",
      "intro": "short intro paragraph",
      "blocks": [{ "heading": "Subheading", "bullets": ["work item with URL only if in facts"] }],
      "valueDelivered": "1-2 sentences of business value"
    }
  ],
  "conclusion": "1 closing paragraph for the navy conclusion page"
}

Rules:
- Section numbers start at 2 (01 is reserved for Executive Summary).
- Group completed tasks by taskType into 2-8 workstream sections.
- Include VALUE DELIVERED on every section.
- Only cite URLs that appear in task descriptions or deliverable notes/fileUrl.
- preparedBy should be "Local Waves" unless facts.preparedBy is set.`;

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function snippet(text, max = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Gather client-wide facts for a reporting month.
 */
async function gatherClientFacts({ clientId, agencyName, websiteUrl, month, year }) {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const [
    tasksCompleted,
    tasksCreated,
    tasksOpen,
    completedList,
    contentPublished,
    keywordsAccepted,
    promptTotalThisMonth,
    promptCitedThisMonth,
    promptPlatforms,
    metricSnapshots,
  ] = await Promise.all([
    prisma.task.count({
      where: { project: { clientId }, status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
    }),
    prisma.task.count({ where: { project: { clientId }, createdAt: { gte: from, lt: to } } }),
    prisma.task.count({
      where: { project: { clientId }, status: { in: ACTIVE_TASK_STATUSES } },
    }),
    prisma.task.findMany({
      where: { project: { clientId }, status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
      select: {
        title: true,
        taskType: true,
        description: true,
        deliverables: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { fileUrl: true, notes: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.wpContentReview.count({
      where: { project: { clientId }, publishedAt: { gte: from, lt: to }, isPublished: true },
    }),
    prisma.keywordSuggestion.count({
      where: { project: { clientId }, reviewedAt: { gte: from, lt: to }, status: 'ACCEPTED' },
    }),
    prisma.promptLog.count({ where: { project: { clientId }, createdAt: { gte: from, lt: to } } }),
    prisma.promptLog.count({
      where: { project: { clientId }, createdAt: { gte: from, lt: to }, cited: true },
    }),
    prisma.promptLog.findMany({
      where: { project: { clientId }, createdAt: { gte: from, lt: to } },
      select: { platform: true },
      take: 500,
    }),
    prisma.clientMetricSnapshot.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);

  const latestByType = new Map();
  for (const snap of metricSnapshots) {
    if (!latestByType.has(snap.metricType)) latestByType.set(snap.metricType, snap);
  }
  const kpis = Array.from(latestByType.values()).map((s) => ({
    metric: s.metricType,
    value: s.value,
    label: s.label,
    change: s.change,
  }));

  const platforms = [...new Set(promptPlatforms.map((p) => p.platform).filter(Boolean))];

  return {
    clientName: agencyName,
    websiteUrl: websiteUrl || null,
    month,
    year,
    preparedBy: 'Local Waves',
    tasks: {
      completed: tasksCompleted,
      created: tasksCreated,
      stillOpen: tasksOpen,
      recentCompleted: completedList.map((t) => ({
        title: t.title,
        taskType: t.taskType,
        description: snippet(t.description, 320),
        deliverables: (t.deliverables || []).map((d) => ({
          fileUrl: d.fileUrl,
          notes: snippet(d.notes, 160),
        })),
      })),
    },
    content: { published: contentPublished },
    keywords: { accepted: keywordsAccepted },
    aiVisibility: {
      promptsTested: promptTotalThisMonth,
      cited: promptCitedThisMonth,
      citationRate: pct(promptCitedThisMonth, promptTotalThisMonth),
      platforms,
    },
    searchKpis: kpis,
  };
}

function groupTasksIntoSections(facts) {
  const byType = new Map();
  for (const t of facts.tasks.recentCompleted) {
    const key = t.taskType || 'General SEO';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(t);
  }

  let number = 2;
  const sections = [];
  for (const [taskType, items] of byType) {
    const bullets = items.slice(0, 12).map((t) => {
      const urls = (t.deliverables || [])
        .map((d) => d.fileUrl)
        .filter(Boolean)
        .slice(0, 2);
      const urlSuffix = urls.length ? ` — ${urls.join(', ')}` : '';
      return `${t.title}${urlSuffix}`;
    });
    sections.push({
      number: number++,
      title: String(taskType).toUpperCase(),
      intro: `Work completed this month under ${taskType}.`,
      blocks: [{ heading: 'Work completed', bullets }],
      valueDelivered: `Completed ${items.length} ${taskType} item(s) supporting ${facts.clientName}'s organic growth.`,
    });
    if (sections.length >= 8) break;
  }
  return sections;
}

function buildFallbackFormalContent(facts) {
  const sections = groupTasksIntoSections(facts);
  const kpiBits = (facts.searchKpis || [])
    .slice(0, 4)
    .map((k) => `${k.label || k.metric}: ${k.value}${k.change ? ` (${k.change})` : ''}`)
    .join('; ');

  return normalizeAiContent({
    coverSummary: `This month we completed ${facts.tasks.completed} task(s) for ${facts.clientName}, published ${facts.content.published} content piece(s), and accepted ${facts.keywords.accepted} keyword target(s). AI-search visibility was tracked across ${facts.aiVisibility.platforms.length || 'several'} platform(s) with a ${facts.aiVisibility.citationRate}% citation rate.`,
    preparedBy: facts.preparedBy || 'Local Waves',
    executive: {
      strategicApproach: `Work this month focused on measurable SEO execution for ${facts.clientName}, spanning ${sections.length} workstream(s) drawn from completed tasks.`,
      performanceGains: kpiBits
        ? `Key metrics this period: ${kpiBits}.`
        : `Completed ${facts.tasks.completed} tasks and published ${facts.content.published} content piece(s).`,
      localVisibility: '',
      technicalHealth: '',
      nextSteps: `Continue executing prioritized SEO workstreams and convert existing visibility into clicks and leads for ${facts.clientName}.`,
    },
    sections,
    conclusion: `June–style formal wrap: ${facts.clientName} completed ${facts.tasks.completed} SEO task(s) this month with ${facts.content.published} published content piece(s). The team enters next month with clear workstream continuity and a documented value trail for every deliverable.`,
  });
}

async function buildNarrative(facts) {
  const metrics = {
    'Tasks completed': facts.tasks.completed,
    'Content published': facts.content.published,
    'Keywords accepted': facts.keywords.accepted,
    'AI answers cited': `${facts.aiVisibility.cited} of ${facts.aiVisibility.promptsTested}`,
    'AI citation rate': `${facts.aiVisibility.citationRate}%`,
  };
  for (const kpi of facts.searchKpis) {
    metrics[kpi.label || kpi.metric] = kpi.change ? `${kpi.value} (${kpi.change})` : kpi.value;
  }

  if (!isAiConfigured()) {
    const formal = buildFallbackFormalContent(facts);
    return {
      ...formal,
      // Legacy keys for older portal cards
      executiveSummary: formal.coverSummary,
      seoPerformance: formal.executive.performanceGains,
      highlights: formal.sections.slice(0, 5).map((s) => s.title),
      metrics,
      aiVisibility: facts.aiVisibility,
      searchKpis: facts.searchKpis,
      generatedAt: new Date().toISOString(),
    };
  }

  let formal = null;
  try {
    const { parsed, text } = await generateChat({
      system: CLIENT_SYSTEM_PROMPT,
      user: `Facts payload:\n\n${JSON.stringify(facts, null, 2)}`,
      json: true,
      temperature: 0.55,
      maxTokens: 4500,
      feature: 'monthly_report',
      clientId: facts.clientId ?? null,
    });
    const content = parsed || (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    if (content && (content.coverSummary || content.executive || content.executiveSummary)) {
      formal = normalizeAiContent(content);
      if (!formal.sections?.length) {
        formal.sections = groupTasksIntoSections(facts);
      }
    }
  } catch {
    // fall through
  }

  if (!formal) formal = buildFallbackFormalContent(facts);

  return {
    ...formal,
    executiveSummary: formal.coverSummary,
    seoPerformance: formal.executive?.performanceGains || '',
    highlights: (formal.sections || []).slice(0, 5).map((s) => s.title),
    metrics,
    aiVisibility: facts.aiVisibility,
    searchKpis: facts.searchKpis,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate (or regenerate) one client's monthly report for a given month/year.
 */
export async function generateClientReport({
  clientId,
  month,
  year,
  workCycleId = null,
  log = console,
}) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true, agencyName: true, websiteUrl: true },
  });
  if (!client) return null;

  const facts = await gatherClientFacts({
    clientId,
    agencyName: client.agencyName,
    websiteUrl: client.websiteUrl,
    month,
    year,
  });
  const aiContent = await buildNarrative({ ...facts, clientId });

  const existing = await prisma.monthlyReport.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });

  if (existing) {
    if (existing.status === 'DELIVERED') return existing;
    return prisma.monthlyReport.update({
      where: { id: existing.id },
      data: { aiContent, status: 'DRAFT', workCycleId: workCycleId ?? existing.workCycleId },
    });
  }

  return prisma.monthlyReport.create({
    data: { clientId, month, year, status: 'DRAFT', aiContent, workCycleId },
  });
}

/**
 * Auto-generate DRAFT reports for every active client for a just-closed cycle.
 */
export async function generateReportsForCycle(cycle, { log = console } = {}) {
  const { id: workCycleId, month, year } = cycle;
  const clients = await prisma.clientAccount.findMany({
    where: { isActive: true },
    select: { id: true, agencyName: true, leadPmId: true, secondaryPmId: true },
  });

  const results = [];
  for (const client of clients) {
    try {
      const report = await generateClientReport({
        clientId: client.id,
        month,
        year,
        workCycleId,
        log,
      });
      if (!report) continue;
      results.push({ clientId: client.id, reportId: report.id });

      const pmIds = [...new Set([client.leadPmId, client.secondaryPmId].filter(Boolean))];
      for (const pmId of pmIds) {
        await prisma.systemAlert
          .create({
            data: {
              userId: pmId,
              type: 'report_draft_ready',
              message: `Monthly report draft ready for ${client.agencyName} (${month}/${year}). Review & approve.`,
              actionUrl: `/portal/pm/reports/${report.id}`,
            },
          })
          .catch(() => {});
      }
    } catch (err) {
      log?.error?.({ err, clientId: client.id }, 'Cycle report generation failed for client');
    }
  }

  log?.info?.({ generated: results.length }, 'Cycle report drafts generated');
  return { generated: results.length, results };
}
