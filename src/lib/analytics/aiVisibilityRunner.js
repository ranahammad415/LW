/**
 * Admin-triggered AI Visibility job:
 * GSC top queries → OpenRouter multi-model probes → DataForSEO LLM Mentions → persist snapshot.
 */

import { prisma } from '../prisma.js';
import { domainFromUrl } from './providers.js';
import { getOpenRouterModelMap, isOpenRouterConfigured, probeVisibilityQuery } from '../openrouter/client.js';
import { detectCitation, extractCompetitorDomains } from '../openrouter/citation.js';
import { buildDfsVisibilitySnapshot } from '../dataforseo/llmMentions.js';

const QUERY_LIMIT = 15;
const CONCURRENCY = 3;
const RESPONSE_MAX = 4000;
const GSC_SEED_DAYS = 28;

function brandTokensForProject(project) {
  const raw = [
    project.client?.agencyName,
    project.client?.websiteUrl,
    project.dataforseoDomain,
    project.gscSiteUrl,
  ].filter(Boolean);
  return [
    ...new Set(
      raw.flatMap((s) => {
        const cleaned = String(s)
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/^sc-domain:/, '');
        const parts = cleaned.split(/[./\s_-]+/).filter((t) => t && t.length > 2);
        const hostLabel = cleaned.split(/[./]/)[0];
        return [hostLabel, ...parts].filter(Boolean);
      })
    ),
  ].filter((t) => t && t.length >= 2);
}

function isBrandQuery(query, brandTokens) {
  const q = String(query || '').toLowerCase();
  return brandTokens.some((t) => t && q.includes(String(t).toLowerCase()));
}

async function seedGscQueries(projectId, brandTokens) {
  const end = new Date();
  const start = new Date(end.getTime() - GSC_SEED_DAYS * 86400000);
  const rows = await prisma.gscQueryMetric.findMany({
    where: { projectId, date: { gte: start, lte: end } },
    orderBy: { impressions: 'desc' },
    take: 400,
  });

  const byQuery = new Map();
  for (const r of rows) {
    const acc = byQuery.get(r.query) || { query: r.query, impressions: 0, clicks: 0 };
    acc.impressions += r.impressions || 0;
    acc.clicks += r.clicks || 0;
    byQuery.set(r.query, acc);
  }

  const all = [...byQuery.values()].sort((a, b) => b.impressions - a.impressions);
  const generic = all.filter((q) => !isBrandQuery(q.query, brandTokens));
  const preferred = generic.length >= Math.min(8, QUERY_LIMIT) ? generic : all;
  const selected = preferred.slice(0, QUERY_LIMIT).map((q) => q.query);

  return {
    queries: selected,
    rangeStart: start,
    rangeEnd: end,
  };
}

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
        name: true,
        gscSiteUrl: true,
        dataforseoDomain: true,
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

    const { queries, rangeStart, rangeEnd } = await seedGscQueries(project.id, brands);
    if (queries.length === 0) {
      throw new Error('No GSC queries available — sync Search Console data first');
    }

    const modelMap = getOpenRouterModelMap();
    const platforms = Object.keys(modelMap);
    const jobs = [];
    for (const query of queries) {
      for (const platform of platforms) {
        jobs.push({ query, platform, model: modelMap[platform] });
      }
    }

    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        queryCount: queries.length,
        modelCount: platforms.length,
        gscRangeStart: rangeStart,
        gscRangeEnd: rangeEnd,
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
          platform: job.platform,
          openrouterModel: job.model,
          cited: false,
          citationType: 'error',
          responseText: truncate(`Error: ${err.message || 'probe failed'}`),
          competitorsJson: [],
        };
      }
    });

    // Replace prior results for this run (idempotent if retried)
    await prisma.aiVisibilityResult.deleteMany({ where: { runId } });
    if (probeResults.length) {
      await prisma.aiVisibilityResult.createMany({ data: probeResults });
    }

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

    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        error: dfsPayload.skipped ? `DFS skipped: ${dfsPayload.error || 'unavailable'}` : null,
      },
    });

    return { ok: true, runId, queryCount: queries.length, modelCount: platforms.length };
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

  // Fire-and-forget; errors are persisted on the run row.
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
      project: { select: { id: true, name: true, dataforseoDomain: true, gscSiteUrl: true } },
    },
  });
}
