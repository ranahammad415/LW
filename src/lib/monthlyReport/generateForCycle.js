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

/** Map internal taskType strings → plain-language section titles for clients. */
const TASK_TYPE_PLAIN_TITLES = {
  'Technical SEO': 'Making your website easier for Google to understand',
  'TECHNICAL SEO': 'Making your website easier for Google to understand',
  'Technical SEO & Site Health': 'Making your website easier for Google to understand',
  'On-Page SEO': 'Improving the pages visitors and search engines see',
  'ON-PAGE SEO': 'Improving the pages visitors and search engines see',
  'On-Page SEO & Content Optimization': 'Improving the pages visitors and search engines see',
  'Local SEO': 'Helping nearby customers find you',
  'LOCAL SEO': 'Helping nearby customers find you',
  'Content': 'Publishing useful content that attracts the right visitors',
  'CONTENT': 'Publishing useful content that attracts the right visitors',
  'Content Development': 'Publishing useful content that attracts the right visitors',
  'Off-Page SEO': 'Building trust and mentions beyond your website',
  'OFF-PAGE SEO': 'Building trust and mentions beyond your website',
  'Citations': 'Listing your business accurately across the web',
  'CITATIONS': 'Listing your business accurately across the web',
  'Schema': 'Helping search engines understand your business details',
  'SCHEMA': 'Helping search engines understand your business details',
  'Schema & Structured Data': 'Helping search engines understand your business details',
  'AEO': 'Getting your business mentioned in AI answers',
  'AI Visibility': 'Getting your business mentioned in AI answers',
  'General SEO': 'Search visibility improvements',
};

/** Hints so the model can explain KPI names without inventing new metrics. */
const KPI_PLAIN_LABELS = {
  MASTER_VISIBILITY_SCORE: 'Overall how visible your business is in search (higher is better)',
  MasterVisibilityScore: 'Overall how visible your business is in search (higher is better)',
  GROWTH_INDEX: 'Whether your search visibility is trending up or down lately',
  GrowthIndex: 'Whether your search visibility is trending up or down lately',
  COMPETITOR_THREAT: 'How close competitors are to outranking you on important searches',
  CompetitorThreat: 'How close competitors are to outranking you on important searches',
  AI_SEARCH_READINESS: 'How prepared your site is to appear in AI-generated answers',
  AiSearchReadiness: 'How prepared your site is to appear in AI-generated answers',
  CONTENT_GAP: 'Topics customers search for that you do not cover well yet',
  ContentGap: 'Topics customers search for that you do not cover well yet',
};

export const CLIENT_SYSTEM_PROMPT = `You are a Local Waves account manager writing a monthly SEO & Performance Report PDF for a non-technical business owner / stakeholder.

Audience: customers who are NOT SEO experts. Write calmly, clearly, and with quiet authority.
Voice: short sentences, confident, helpful. Benefits first. No AI filler ("delve", "testament", "robust", "leverage", "landscape").

Hard rules:
- Never invent URLs, metrics, deliverables, comments, or issues not present in the facts.
- Paraphrase task comments and issue notes — never paste raw internal chat.
- Explain any technical term in plain English on first use, or avoid the term.
- Do NOT dump raw internal score names (e.g. "Master Visibility Score", "Growth Index", "Competitor Threat", "AI Search Readiness") unless you immediately add one plain-English line about what it means for the business. Prefer everyday wording.
- Prefer 2–6 denser sections over many thin ones. Merge related work when evidence is light.
- Section titles must be customer-friendly outcome titles (ALL CAPS is OK), NOT raw internal taskType codes when a clearer title exists.
- Every section needs VALUE DELIVERED: 1–2 sentences of business benefit.
- Bullets = concrete outcomes (what changed + why it helps). Not ticket IDs or jargon-only lines like "301 redirects" without explanation.
- Use facts.issues / facts.collaboration / facts.clientInputs when present for responsiveness / support narrative.
- preparedBy should be "Local Waves" unless facts.preparedBy is set.
- Only cite URLs that appear in facts (task descriptions or deliverable notes/fileUrl).

Return ONLY valid JSON with exactly this shape:
{
  "coverSummary": "3–5 sentences: what we finished this month, why it matters for getting found, focus for next month — everyday language.",
  "preparedBy": "author name string",
  "executive": {
    "strategicApproach": "paragraph: the plan for the month in plain English",
    "performanceGains": "paragraph: progress / visibility in everyday terms (use searchKpis.plainLabel when present)",
    "localVisibility": "paragraph or empty string: local/map/listing progress if any",
    "technicalHealth": "paragraph or empty string: site health in plain English if any",
    "nextSteps": "paragraph: clear next-month priorities"
  },
  "sections": [
    {
      "number": 2,
      "title": "CUSTOMER-FRIENDLY ALL CAPS TITLE",
      "intro": "short intro: why this workstream matters to the business",
      "blocks": [{ "heading": "Plain subheading", "bullets": ["Outcome with optional URL from facts"] }],
      "valueDelivered": "1–2 sentences of business value"
    }
  ],
  "conclusion": "1 closing paragraph: confident wrap + commitment to transparent progress"
}

Section numbers start at 2 (01 is reserved for Executive Summary).`;

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function snippet(text, max = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function plainTitleForTaskType(taskType) {
  const raw = String(taskType || 'General SEO').trim();
  if (TASK_TYPE_PLAIN_TITLES[raw]) return TASK_TYPE_PLAIN_TITLES[raw];
  const upper = raw.toUpperCase();
  for (const [key, title] of Object.entries(TASK_TYPE_PLAIN_TITLES)) {
    if (key.toUpperCase() === upper) return title;
  }
  // Soften raw enums: "Technical_SEO" → readable fallback
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Search visibility improvements';
}

export function plainLabelForKpi(metricType, label) {
  const key = String(metricType || '');
  if (KPI_PLAIN_LABELS[key]) return KPI_PLAIN_LABELS[key];
  const byLabel = String(label || '');
  for (const [k, v] of Object.entries(KPI_PLAIN_LABELS)) {
    if (byLabel.toLowerCase().includes(k.toLowerCase().replace(/_/g, ' '))) return v;
  }
  if (/visibility/i.test(byLabel) || /visibility/i.test(key)) {
    return 'Overall how visible your business is in search';
  }
  if (/growth/i.test(byLabel) || /growth/i.test(key)) {
    return 'Whether your search visibility is trending up or down';
  }
  if (/competitor/i.test(byLabel) || /competitor/i.test(key)) {
    return 'How competitive the search landscape is for your business';
  }
  if (/ai|aeo|answer/i.test(byLabel) || /ai|aeo/i.test(key)) {
    return 'How prepared your site is to appear in AI-generated answers';
  }
  return byLabel || key || 'Search performance indicator';
}

/**
 * Shape completed tasks + comments into the facts.tasks.recentCompleted list.
 * Exported for unit tests.
 */
export function shapeCompletedTasks(completedList, { from, to } = {}) {
  return (completedList || []).map((t) => {
    const comments = (t.comments || [])
      .filter((c) => {
        if (c.parentId) return false;
        if (!from || !to || !c.createdAt) return true;
        const ts = new Date(c.createdAt).getTime();
        return ts >= from.getTime() && ts < to.getTime();
      })
      .slice(0, 3)
      .map((c) => snippet(c.content, 180))
      .filter(Boolean);

    return {
      title: t.title,
      taskType: t.taskType,
      plainTitle: plainTitleForTaskType(t.taskType),
      description: snippet(t.description, 320),
      clientRequestNote: snippet(t.clientRequestNote, 200) || null,
      clientProvidedResponse: snippet(t.clientProvidedResponse, 200) || null,
      commentSnippets: comments,
      deliverables: (t.deliverables || []).map((d) => ({
        fileUrl: d.fileUrl,
        notes: snippet(d.notes, 160),
      })),
    };
  });
}

export function shapeIssues({ resolvedList, openedList }) {
  const resolved = (resolvedList || []).slice(0, 15).map((issue) => {
    const latest = (issue.comments || [])[0];
    return {
      title: issue.title,
      priority: issue.priority,
      description: snippet(issue.description, 220),
      resolutionNote: latest ? snippet(latest.body, 180) : null,
    };
  });
  const opened = (openedList || []).slice(0, 15).map((issue) => ({
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    description: snippet(issue.description, 180),
  }));
  return {
    resolvedCount: resolvedList?.length ?? resolved.length,
    openedCount: openedList?.length ?? opened.length,
    resolved,
    opened,
  };
}

/**
 * Gather client-wide facts for a reporting month (client-visible work only).
 */
export async function gatherClientFacts({ clientId, agencyName, websiteUrl, month, year, workCycleId = null }) {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const clientVisibleTask = { project: { clientId }, clientVisible: true };
  // Prefer work-cycle membership so reports match the task board after clone-based history.
  const taskCycleFilter = workCycleId
    ? { workCycleId }
    : {};
  const completedInPeriod = workCycleId
    ? { ...clientVisibleTask, ...taskCycleFilter, status: 'COMPLETED' }
    : {
        ...clientVisibleTask,
        status: 'COMPLETED',
        updatedAt: { gte: from, lt: to },
      };
  const createdInPeriod = workCycleId
    ? { ...clientVisibleTask, ...taskCycleFilter }
    : { ...clientVisibleTask, createdAt: { gte: from, lt: to } };
  const openTasksWhere = workCycleId
    ? { ...clientVisibleTask, ...taskCycleFilter, status: { in: ACTIVE_TASK_STATUSES } }
    : { ...clientVisibleTask, status: { in: ACTIVE_TASK_STATUSES } };

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
    commentActivityCount,
    issuesResolvedList,
    issuesOpenedList,
  ] = await Promise.all([
    prisma.task.count({
      where: completedInPeriod,
    }),
    prisma.task.count({
      where: createdInPeriod,
    }),
    prisma.task.count({
      where: openTasksWhere,
    }),
    prisma.task.findMany({
      where: completedInPeriod,
      select: {
        title: true,
        taskType: true,
        description: true,
        clientRequestNote: true,
        clientProvidedResponse: true,
        requiresClientInput: true,
        deliverables: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { fileUrl: true, notes: true },
        },
        comments: {
          where: {
            parentId: null,
            ...(workCycleId ? {} : { createdAt: { gte: from, lt: to } }),
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { content: true, createdAt: true, parentId: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 45,
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
    prisma.taskComment.count({
      where: {
        parentId: null,
        ...(workCycleId
          ? { task: { project: { clientId }, clientVisible: true, workCycleId } }
          : {
              createdAt: { gte: from, lt: to },
              task: { project: { clientId }, clientVisible: true },
            }),
      },
    }),
    prisma.clientIssue.findMany({
      where: { clientId, resolvedAt: { gte: from, lt: to } },
      select: {
        title: true,
        priority: true,
        description: true,
        resolvedAt: true,
        comments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { body: true },
        },
      },
      orderBy: { resolvedAt: 'desc' },
      take: 20,
    }),
    prisma.clientIssue.findMany({
      where: { clientId, createdAt: { gte: from, lt: to } },
      select: {
        title: true,
        status: true,
        priority: true,
        description: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
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
    plainLabel: plainLabelForKpi(s.metricType, s.label),
  }));

  const platforms = [...new Set(promptPlatforms.map((p) => p.platform).filter(Boolean))];
  const recentCompleted = shapeCompletedTasks(completedList, { from, to });
  const issues = shapeIssues({
    resolvedList: issuesResolvedList,
    openedList: issuesOpenedList,
  });

  const clientInputs = recentCompleted
    .filter((t) => t.clientRequestNote || t.clientProvidedResponse)
    .slice(0, 12)
    .map((t) => ({
      title: t.title,
      request: t.clientRequestNote,
      response: t.clientProvidedResponse,
    }));

  const tasksWithComments = recentCompleted.filter((t) => t.commentSnippets?.length).length;

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
      recentCompleted,
    },
    collaboration: {
      commentActivityCount,
      tasksWithComments,
    },
    issues,
    clientInputs,
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

export function groupTasksIntoSections(facts) {
  const byType = new Map();
  for (const t of facts.tasks.recentCompleted) {
    const key = t.taskType || 'General SEO';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(t);
  }

  let number = 2;
  const sections = [];
  for (const [taskType, items] of byType) {
    const plain = plainTitleForTaskType(taskType);
    const bullets = items.slice(0, 10).map((t) => {
      const urls = (t.deliverables || [])
        .map((d) => d.fileUrl)
        .filter(Boolean)
        .slice(0, 2);
      const urlSuffix = urls.length ? ` — ${urls.join(', ')}` : '';
      return `${t.title}${urlSuffix}`;
    });
    sections.push({
      number: number++,
      title: plain.toUpperCase(),
      intro: `This month we focused on ${plain.toLowerCase()} for ${facts.clientName}.`,
      blocks: [{ heading: 'What we completed', bullets }],
      valueDelivered: `We finished ${items.length} item(s) in this area to help ${facts.clientName} get found by the right customers.`,
    });
    if (sections.length >= 6) break;
  }

  if (facts.issues?.resolvedCount > 0) {
    sections.push({
      number: number++,
      title: 'ISSUES WE RESOLVED FOR YOU',
      intro: `We closed ${facts.issues.resolvedCount} support item(s) you raised or that blocked progress.`,
      blocks: [
        {
          heading: 'Resolved this month',
          bullets: (facts.issues.resolved || []).slice(0, 8).map((i) => i.title),
        },
      ],
      valueDelivered: `Clearing these items keeps your project moving and reduces friction for your team.`,
    });
  } else if (facts.collaboration?.commentActivityCount > 0 || (facts.clientInputs || []).length > 0) {
    sections.push({
      number: number++,
      title: 'HOW WE WORKED WITH YOU',
      intro: `We stayed in close communication while delivering this month's work.`,
      blocks: [
        {
          heading: 'Collaboration',
          bullets: [
            facts.collaboration?.commentActivityCount
              ? `${facts.collaboration.commentActivityCount} project update(s) logged on your tasks.`
              : null,
            (facts.clientInputs || []).length
              ? `${facts.clientInputs.length} client input item(s) captured and acted on.`
              : null,
          ].filter(Boolean),
        },
      ],
      valueDelivered: `Clear back-and-forth helps us finish the right work faster and with fewer surprises.`,
    });
  }

  return sections.slice(0, 6);
}

export function buildFallbackFormalContent(facts) {
  const sections = groupTasksIntoSections(facts);
  const kpiBits = (facts.searchKpis || [])
    .slice(0, 4)
    .map((k) => {
      const meaning = k.plainLabel || plainLabelForKpi(k.metric, k.label);
      return `${meaning}: ${k.value}${k.change ? ` (${k.change})` : ''}`;
    })
    .join('; ');

  const monthLabel = `${facts.month}/${facts.year}`;
  return normalizeAiContent({
    coverSummary: `This month we completed ${facts.tasks.completed} planned item(s) for ${facts.clientName}. We also published ${facts.content.published} content piece(s) and locked ${facts.keywords.accepted} keyword target(s). The goal was simple: make it easier for the right customers to find you online. Next month we will keep building on this progress.`,
    preparedBy: facts.preparedBy || 'Local Waves',
    executive: {
      strategicApproach: `For ${monthLabel}, we focused on practical search improvements for ${facts.clientName} across ${sections.length} area(s) of work — always aiming for clearer visibility and a stronger website foundation.`,
      performanceGains: kpiBits
        ? `Here is how visibility looked this period (in plain terms): ${kpiBits}.`
        : `We completed ${facts.tasks.completed} tasks and published ${facts.content.published} content piece(s).`,
      localVisibility:
        sections.some((s) => /local|listing|nearby/i.test(s.title))
          ? `We improved how local customers can find and trust your business online.`
          : '',
      technicalHealth:
        sections.some((s) => /google to understand|technical|site/i.test(s.title))
          ? `We strengthened the technical foundation of your website so search engines can read and show your pages more reliably.`
          : '',
      nextSteps: `Next month we will continue the highest-impact work and turn the foundation built this month into stronger visibility and more of the right visitors for ${facts.clientName}.`,
    },
    sections,
    conclusion: `${facts.clientName} finished a productive month with ${facts.tasks.completed} completed item(s) and ${facts.content.published} published content piece(s). Local Waves remains focused on clear progress you can see — and we look forward to reporting the next results.`,
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
      user: `Facts payload (use only this evidence; paraphrase comments/issues; write for a non-technical client):\n\n${JSON.stringify(facts, null, 2)}`,
      json: true,
      temperature: 0.45,
      maxTokens: 5500,
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
 *
 * By default, existing non-DELIVERED drafts are preserved (not overwritten).
 * Pass `force: true` to replace draft content (PM explicit regenerate).
 * DELIVERED reports are never overwritten.
 *
 * @returns {{ report: object, action: 'created'|'preserved'|'regenerated'|'delivered_unchanged' } | null}
 */
export async function generateClientReport({
  clientId,
  month,
  year,
  workCycleId = null,
  force = false,
  log = console,
}) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true, agencyName: true, websiteUrl: true },
  });
  if (!client) return null;

  const existing = await prisma.monthlyReport.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });

  if (existing?.status === 'DELIVERED') {
    return { report: existing, action: 'delivered_unchanged' };
  }

  // Preserve PM-edited / previously generated drafts unless force regenerate.
  if (existing && !force) {
    return { report: existing, action: 'preserved' };
  }

  const facts = await gatherClientFacts({
    clientId,
    agencyName: client.agencyName,
    websiteUrl: client.websiteUrl,
    month,
    year,
    workCycleId,
  });
  const aiContent = await buildNarrative({ ...facts, clientId });

  if (existing) {
    const report = await prisma.monthlyReport.update({
      where: { id: existing.id },
      data: { aiContent, status: 'DRAFT', workCycleId: workCycleId ?? existing.workCycleId },
    });
    return { report, action: 'regenerated' };
  }

  const report = await prisma.monthlyReport.create({
    data: { clientId, month, year, status: 'DRAFT', aiContent, workCycleId },
  });
  return { report, action: 'created' };
}

/**
 * Auto-generate DRAFT reports for every active client for a just-closed cycle.
 * Kept for manual/ops use; Start next month does NOT call this — reports are PM-owned.
 * Skips clients that already have a report for that month (preserves drafts).
 */
export async function generateReportsForCycle(cycle, { log = console } = {}) {
  const { id: workCycleId, month, year } = cycle;
  const clients = await prisma.clientAccount.findMany({
    where: { isActive: true },
    select: { id: true, agencyName: true, leadPmId: true, secondaryPmId: true },
  });

  const results = [];
  let created = 0;
  let preserved = 0;
  for (const client of clients) {
    try {
      const outcome = await generateClientReport({
        clientId: client.id,
        month,
        year,
        workCycleId,
        force: false,
        log,
      });
      if (!outcome?.report) continue;
      const { report, action } = outcome;
      results.push({ clientId: client.id, reportId: report.id, action });

      if (action === 'preserved' || action === 'delivered_unchanged') {
        preserved += 1;
        continue;
      }

      created += 1;
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

  log?.info?.({ generated: created, preserved, total: results.length }, 'Cycle report drafts generated');
  return { generated: created, preserved, results };
}
