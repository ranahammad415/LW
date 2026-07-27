/**
 * Admin-triggered AI Visibility job:
 * GSC → Anthropic local rewrite → OpenRouter probes → DataForSEO → PromptLog + snapshot.
 */

import { prisma } from '../prisma.js';
import { domainFromUrl } from './providers.js';
import { getOpenRouterModelMap, isOpenRouterConfigured, probeVisibilityQuery } from '../openrouter/client.js';
import { detectCitation, extractCompetitorDomains } from '../openrouter/citation.js';
import { buildDfsVisibilitySnapshot } from '../dataforseo/llmMentions.js';
import {
  AI_VIS_AUTO_NOTES_PREFIX,
  brandTokensForProject,
  buildIntelligentProbeQueries,
} from './aiVisibilityQueryIntel.js';

const CONCURRENCY = 3;
const RESPONSE_MAX = 4000;

const PLATFORM_LABELS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
};

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function truncate(text, max = RESPONSE_MAX) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function syncPromptLogsFromProbes({ projectId, runId, domain, probeResults }) {
  await prisma.promptLog.deleteMany({
    where: {
      projectId,
      notes: { startsWith: AI_VIS_AUTO_NOTES_PREFIX },
    },
  });

  if (!probeResults.length) return;

  const notes = `${AI_VIS_AUTO_NOTES_PREFIX} · run ${runId}`.slice(0, 1000);
  const targetUrl = domain ? `https://${domain}` : null;

  const rows = probeResults.map((r) => ({
    projectId,
    platform: (PLATFORM_LABELS[r.platform] || r.platform || 'unknown').slice(0, 100),
    promptQuery: String(r.query || ''),
    llmResponse: String(r.responseText || ''),
    notes,
    keyword: r.sourceQuery ? String(r.sourceQuery).slice(0, 500) : null,
    targetUrl: targetUrl ? targetUrl.slice(0, 500) : null,
    cited: !!r.cited,
    competitorsCited: Array.isArray(r.competitorsJson) ? r.competitorsJson : [],
  }));

  // Batch create to avoid huge single payloads
  const chunk = 50;
  for (let i = 0; i < rows.length; i += chunk) {
    await prisma.promptLog.createMany({ data: rows.slice(i, i + chunk) });
  }
}

/**
 * Execute a full AI Visibility run (must already exist as pending/running).
 */
export async function executeAiVisibilityRun(runId) {
  const run = await prisma.aiVisibilityRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('AI Visibility run not found');

  await prisma.aiVisibilityRun.update({
    where: { id: runId },
    data: { status: 'running', startedAt: new Date(), error: null },
  });

  try {
    if (!isOpenRouterConfigured()) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    const project = await prisma.project.findUnique({
      where: { id: run.projectId },
      select: {
        id: true,
        clientId: true,
        name: true,
        gscSiteUrl: true,
        dataforseoDomain: true,
        targetMarket: true,
        client: { select: { agencyName: true, websiteUrl: true } },
      },
    });
    if (!project) throw new Error('Project not found');

    const domain =
      domainFromUrl(project.dataforseoDomain || '') ||
      domainFromUrl(project.client?.websiteUrl || '') ||
      domainFromUrl(String(project.gscSiteUrl || '').replace(/^sc-domain:/, ''));

    const brands = brandTokensForProject(project);
    if (project.client?.agencyName) brands.unshift(project.client.agencyName);

    const intel = await buildIntelligentProbeQueries(project, brands);
    if (intel.probes.length === 0) {
      throw new Error(intel.warning || 'No GSC queries available — sync Search Console data first');
    }

    const modelMap = getOpenRouterModelMap();
    const platforms = Object.keys(modelMap);
    const jobs = [];
    for (const probe of intel.probes) {
      for (const platform of platforms) {
        jobs.push({
          query: probe.probeQuery,
          sourceQuery: probe.sourceQuery,
          platform,
          model: modelMap[platform],
        });
      }
    }

    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        queryCount: intel.probes.length,
        modelCount: platforms.length,
        gscRangeStart: intel.rangeStart,
        gscRangeEnd: intel.rangeEnd,
      },
    });

    const probeResults = await mapPool(jobs, CONCURRENCY, async (job) => {
      try {
        const { text, model } = await probeVisibilityQuery({
          platform: job.platform,
          model: job.model,
          query: job.query,
        });
        const { cited, citationType } = detectCitation(text, {
          domain,
          brandNames: brands,
        });
        const competitors = extractCompetitorDomains(text, domain);
        return {
          runId,
          query: job.query.slice(0, 500),
          sourceQuery: job.sourceQuery ? String(job.sourceQuery).slice(0, 500) : null,
          platform: job.platform,
          openrouterModel: model || job.model,
          cited,
          citationType: cited ? citationType : 'none',
          responseText: truncate(text),
          competitorsJson: competitors,
        };
      } catch (err) {
        return {
          runId,
          query: job.query.slice(0, 500),
          sourceQuery: job.sourceQuery ? String(job.sourceQuery).slice(0, 500) : null,
          platform: job.platform,
          openrouterModel: job.model,
          cited: false,
          citationType: 'error',
          responseText: truncate(`Error: ${err.message || 'probe failed'}`),
          competitorsJson: [],
        };
      }
    });

    await prisma.aiVisibilityResult.deleteMany({ where: { runId } });
    if (probeResults.length) {
      await prisma.aiVisibilityResult.createMany({ data: probeResults });
    }

    await syncPromptLogsFromProbes({
      projectId: project.id,
      runId,
      domain,
      probeResults,
    });

    const dfsPayload = await buildDfsVisibilitySnapshot(domain);
    await prisma.aiVisibilityDfsSnapshot.upsert({
      where: { runId },
      create: {
        runId,
        domain: dfsPayload.domain || domain || null,
        payload: dfsPayload,
      },
      update: {
        domain: dfsPayload.domain || domain || null,
        payload: dfsPayload,
      },
    });

    const warnings = [intel.warning, dfsPayload.skipped ? `DFS skipped: ${dfsPayload.error || 'unavailable'}` : null]
      .filter(Boolean)
      .join(' · ');

    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        error: warnings ? warnings.slice(0, 1000) : null,
      },
    });

    return { ok: true, runId, queryCount: intel.probes.length, modelCount: platforms.length };
  } catch (err) {
    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: String(err.message || 'AI Visibility run failed').slice(0, 1000),
      },
    });
    throw err;
  }
}

/**
 * Create a run row and kick off background execution.
 * @returns {{ run, started: boolean, conflict?: boolean }}
 */
export async function startAiVisibilityRun({ projectId, clientId, triggeredById }) {
  const active = await prisma.aiVisibilityRun.findFirst({
    where: { projectId, status: { in: ['pending', 'running'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (active) {
    return { run: active, started: false, conflict: true };
  }

  const run = await prisma.aiVisibilityRun.create({
    data: {
      projectId,
      clientId,
      status: 'pending',
      triggeredById: triggeredById || null,
    },
  });

  setImmediate(() => {
    executeAiVisibilityRun(run.id).catch((err) => {
      console.error('[aiVisibility] run failed', run.id, err.message);
    });
  });

  return { run, started: true, conflict: false };
}

export async function getLatestAiVisibilityRun(projectId) {
  return prisma.aiVisibilityRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: {
      dfs: true,
      _count: { select: { results: true } },
    },
  });
}

export async function getLatestCompletedAiVisibilityRun(clientId, projectIds = []) {
  const where =
    projectIds.length > 0
      ? { clientId, projectId: { in: projectIds }, status: 'completed' }
      : { clientId, status: 'completed' };
  return prisma.aiVisibilityRun.findFirst({
    where,
    orderBy: { finishedAt: 'desc' },
    include: {
      results: true,
      dfs: true,
      project: {
        select: { id: true, name: true, dataforseoDomain: true, gscSiteUrl: true, targetMarket: true },
      },
    },
  });
}
