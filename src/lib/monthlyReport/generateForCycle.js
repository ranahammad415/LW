import { prisma } from '../prisma.js';
import { generateChat, isAiConfigured } from '../ai.js';

const ACTIVE_TASK_STATUSES = ['TO_DO', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REVISION_NEEDED', 'BLOCKED', 'WAITING_DEPENDENCY'];

const CLIENT_SYSTEM_PROMPT = `You are a Senior SEO Account Manager at a premium digital growth agency writing the monthly performance report for a client.
Tone: consultative, professional, confidence-inspiring. Focus on value delivered, not a dry task list.
Avoid AI filler ("delve", "testament", "robust"). Use crisp, business-focused language. Never invent numbers not present in the facts.

You are given a JSON "facts" payload (tasks done, content published, keyword wins, AI-search visibility, and search KPIs).
Return ONLY valid JSON with exactly these keys:
{
  "executiveSummary": "2-3 paragraphs framing the month's work as strategic progress toward the client's growth goals.",
  "seoPerformance": "2-3 paragraphs translating the technical/content/SEO work into business value.",
  "highlights": ["3-5 short bullet wins"]
}`;

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * Gather client-wide facts for a reporting month, including AI-search
 * visibility (Brad's "AI chat results") and the latest search KPIs.
 */
async function gatherClientFacts({ clientId, agencyName, month, year }) {
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
    prisma.task.count({ where: { project: { clientId }, status: 'COMPLETED', updatedAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { project: { clientId }, createdAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { project: { clientId }, status: { in: ACTIVE_TASK_STATUSES } } }),
    prisma.task.findMany({
      where: { project: { clientId }, status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
      select: { title: true, taskType: true },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    }),
    prisma.wpContentReview.count({ where: { project: { clientId }, publishedAt: { gte: from, lt: to }, isPublished: true } }),
    prisma.keywordSuggestion.count({ where: { project: { clientId }, reviewedAt: { gte: from, lt: to }, status: 'ACCEPTED' } }),
    prisma.promptLog.count({ where: { project: { clientId }, createdAt: { gte: from, lt: to } } }),
    prisma.promptLog.count({ where: { project: { clientId }, createdAt: { gte: from, lt: to }, cited: true } }),
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

  // Latest snapshot per metric type → dashboard grid.
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
    month,
    year,
    tasks: {
      completed: tasksCompleted,
      created: tasksCreated,
      stillOpen: tasksOpen,
      recentCompleted: completedList.map((t) => ({ title: t.title, taskType: t.taskType })),
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
    return {
      executiveSummary: `This month we completed ${facts.tasks.completed} task(s) for ${facts.clientName}, published ${facts.content.published} piece(s) of content, and tracked AI-search visibility across ${facts.aiVisibility.platforms.length || 'several'} platform(s). Configure ANTHROPIC_API_KEY for a full AI-written narrative.`,
      seoPerformance: `Your brand was cited in ${facts.aiVisibility.cited} of ${facts.aiVisibility.promptsTested} tested AI answers (${facts.aiVisibility.citationRate}%). ${facts.keywords.accepted} keyword target(s) were accepted this month.`,
      highlights: [
        `${facts.tasks.completed} tasks completed`,
        `${facts.content.published} content pieces published`,
        `${facts.aiVisibility.cited}/${facts.aiVisibility.promptsTested} AI answers cited your brand`,
      ],
      metrics,
      aiVisibility: facts.aiVisibility,
      searchKpis: facts.searchKpis,
      generatedAt: new Date().toISOString(),
    };
  }

  let narrative = { executiveSummary: '', seoPerformance: '', highlights: [] };
  try {
    const { parsed, text } = await generateChat({
      system: CLIENT_SYSTEM_PROMPT,
      user: `Facts payload:\n\n${JSON.stringify(facts, null, 2)}`,
      json: true,
      temperature: 0.6,
      maxTokens: 1500,
      feature: 'monthly_report',
      clientId: facts.clientId ?? null,
    });
    const content = parsed || (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (content) {
      narrative = {
        executiveSummary: content.executiveSummary || '',
        seoPerformance: content.seoPerformance || '',
        highlights: Array.isArray(content.highlights) ? content.highlights : [],
      };
    }
  } catch {
    // fall through to metrics-only narrative below
  }

  if (!narrative.executiveSummary) {
    narrative.executiveSummary = `This month we completed ${facts.tasks.completed} task(s) for ${facts.clientName} and published ${facts.content.published} content piece(s).`;
    narrative.seoPerformance = `Your brand was cited in ${facts.aiVisibility.cited} of ${facts.aiVisibility.promptsTested} tested AI answers (${facts.aiVisibility.citationRate}%).`;
  }

  return {
    ...narrative,
    metrics,
    aiVisibility: facts.aiVisibility,
    searchKpis: facts.searchKpis,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate (or regenerate) one client's monthly report for a given month/year.
 * Produces a DRAFT keyed to the work cycle. Returns the saved report.
 */
export async function generateClientReport({ clientId, month, year, workCycleId = null, log = console }) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true, agencyName: true },
  });
  if (!client) return null;

  const facts = await gatherClientFacts({ clientId, agencyName: client.agencyName, month, year });
  const aiContent = await buildNarrative({ ...facts, clientId });

  const existing = await prisma.monthlyReport.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });

  if (existing) {
    // Don't clobber a report a PM already delivered — only refresh drafts.
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
 * Auto-generate DRAFT reports for every active client for a just-closed cycle,
 * then create an in-app alert for each client's PM(s) to review/approve.
 * Called on month-close (see openNextCycle).
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
      const report = await generateClientReport({ clientId: client.id, month, year, workCycleId, log });
      if (!report) continue;
      results.push({ clientId: client.id, reportId: report.id });

      const pmIds = [...new Set([client.leadPmId, client.secondaryPmId].filter(Boolean))];
      for (const pmId of pmIds) {
        await prisma.systemAlert.create({
          data: {
            userId: pmId,
            type: 'report_draft_ready',
            message: `Monthly report draft ready for ${client.agencyName} (${month}/${year}). Review & approve.`,
            actionUrl: `/portal/pm/reports/${report.id}`,
          },
        }).catch(() => {});
      }
    } catch (err) {
      log?.error?.({ err, clientId: client.id }, 'Cycle report generation failed for client');
    }
  }

  log?.info?.({ generated: results.length }, 'Cycle report drafts generated');
  return { generated: results.length, results };
}
