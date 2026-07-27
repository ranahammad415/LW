/**
 * Admin-triggered AI Visibility job:
 * Confirmed probes → OpenRouter → DataForSEO → PromptLog + snapshot.
 * 7-day cache when probe fingerprint matches a prior live run.
 * Partial re-probe when only some queries changed.
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
import { fingerprintProbeList, normalizeProbeList } from './aiVisibilitySiteKeywords.js';

const CONCURRENCY = 3;
const RESPONSE_MAX = 4000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  const chunk = 50;
  for (let i = 0; i < rows.length; i += chunk) {
    await prisma.promptLog.createMany({ data: rows.slice(i, i + chunk) });
  }
}

async function findReusableLiveRun(projectId, fingerprint) {
  const since = new Date(Date.now() - CACHE_TTL_MS);
  const candidate = await prisma.aiVisibilityRun.findFirst({
    where: {
      projectId,
      status: 'completed',
      isDemo: false,
      probeFingerprint: fingerprint,
      finishedAt: { gte: since },
    },
    orderBy: { finishedAt: 'desc' },
    include: {
      results: { select: { citationType: true }, take: 200 },
    },
  });
  if (!candidate) return null;
  // Do not reuse runs where every platform cell failed (e.g. bad OpenRouter model ids)
  const cells = candidate.results || [];
  if (cells.length > 0 && cells.every((r) => r.citationType === 'error')) return null;
  const { results: _r, ...run } = candidate;
  return run;
}

async function findLatestLiveCompletedRun(projectId) {
  return prisma.aiVisibilityRun.findFirst({
    where: { projectId, status: 'completed', isDemo: false },
    orderBy: { finishedAt: 'desc' },
    include: { results: true, dfs: true },
  });
}

/**
 * Execute a full AI Visibility run (must already exist as pending/running).
 * @param {string} runId
 * @param {{ probes?: string[], priorRunId?: string|null }} [opts]
 */
export async function executeAiVisibilityRun(runId, opts = {}) {
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

    const confirmed = normalizeProbeList(opts.probes || [], { min: 1, max: 20 });
    const fingerprint = confirmed.length ? fingerprintProbeList(confirmed) : null;
    let probeRows;
    let warning = null;
    let rangeStart = null;
    let rangeEnd = null;

    if (confirmed.length > 0) {
      probeRows = confirmed.map((q) => ({
        probeQuery: q,
        sourceQuery: 'site-crawl',
      }));
    } else {
      const intel = await buildIntelligentProbeQueries(project, brands);
      if (intel.probes.length === 0) {
        throw new Error(intel.warning || 'No probe queries available');
      }
      probeRows = intel.probes;
      warning = intel.warning;
      rangeStart = intel.rangeStart;
      rangeEnd = intel.rangeEnd;
    }

    const modelMap = getOpenRouterModelMap();
    const platforms = Object.keys(modelMap);

    // Prior live results for partial re-probe
    let priorByQuery = new Map();
    if (opts.priorRunId) {
      const priorResults = await prisma.aiVisibilityResult.findMany({
        where: { runId: opts.priorRunId },
      });
      for (const r of priorResults) {
        const key = String(r.query || '').toLowerCase();
        if (!priorByQuery.has(key)) priorByQuery.set(key, []);
        priorByQuery.get(key).push(r);
      }
    }

    const jobs = [];
    const reusedResults = [];
    for (const probe of probeRows) {
      const key = probe.probeQuery.toLowerCase();
      const prior = priorByQuery.get(key);
      if (prior && prior.length > 0) {
        for (const r of prior) {
          reusedResults.push({
            runId,
            query: r.query.slice(0, 500),
            sourceQuery: r.sourceQuery || probe.sourceQuery || null,
            platform: r.platform,
            openrouterModel: r.openrouterModel,
            cited: !!r.cited,
            citationType: r.citationType || (r.cited ? 'brand' : 'none'),
            responseText: r.responseText,
            competitorsJson: Array.isArray(r.competitorsJson) ? r.competitorsJson : [],
          });
        }
      } else {
        for (const platform of platforms) {
          jobs.push({
            query: probe.probeQuery,
            sourceQuery: probe.sourceQuery,
            platform,
            model: modelMap[platform],
          });
        }
      }
    }

    await prisma.aiVisibilityRun.update({
      where: { id: runId },
      data: {
        queryCount: probeRows.length,
        modelCount: platforms.length,
        gscRangeStart: rangeStart,
        gscRangeEnd: rangeEnd,
        probeFingerprint: fingerprint,
        isDemo: false,
      },
    });

    const freshResults = await mapPool(jobs, CONCURRENCY, async (job) => {
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

    const probeResults = [...reusedResults, ...freshResults];

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

    let dfsPayload;
    if (jobs.length === 0 && opts.priorRunId) {
      const priorDfs = await prisma.aiVisibilityDfsSnapshot.findUnique({
        where: { runId: opts.priorRunId },
      });
      dfsPayload = priorDfs?.payload || (await buildDfsVisibilitySnapshot(domain));
      if (priorDfs?.payload) {
        dfsPayload = {
          ...priorDfs.payload,
          reusedFromRunId: opts.priorRunId,
        };
      }
    } else {
      dfsPayload = await buildDfsVisibilitySnapshot(domain);
    }

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

    const reuseNote =
      reusedResults.length && jobs.length
        ? `Partial re-probe: reused ${reusedResults.length} cells, probed ${jobs.length}`
        : reusedResults.length && !jobs.length
          ? 'Reused prior probe cells (no OpenRouter calls)'
          : null;

    const warnings = [
      warning,
      reuseNote,
      dfsPayload.skipped ? `DFS skipped: ${dfsPayload.error || 'unavailable'}` : null,
    ]
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

    return {
      ok: true,
      runId,
      queryCount: probeRows.length,
      modelCount: platforms.length,
      probedCells: jobs.length,
      reusedCells: reusedResults.length,
    };
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
 * Create a run row and kick off background execution (or reuse 7-day cache).
 * @param {{ projectId: string, clientId: string, triggeredById?: string|null, probes?: string[] }} args
 */
export async function startAiVisibilityRun({ projectId, clientId, triggeredById, probes }) {
  const active = await prisma.aiVisibilityRun.findFirst({
    where: { projectId, status: { in: ['pending', 'running'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (active) {
    return { run: active, started: false, conflict: true };
  }

  const confirmed = normalizeProbeList(probes || [], { min: 1, max: 20 });
  if (confirmed.length === 0) {
    const err = new Error('At least one probe query is required. Preview and confirm keywords first.');
    err.status = 400;
    throw err;
  }

  const fingerprint = fingerprintProbeList(confirmed);
  const cached = await findReusableLiveRun(projectId, fingerprint);
  if (cached) {
    // Bump finishedAt so this live snapshot is the current one again (e.g. after a demo).
    const touched = await prisma.aiVisibilityRun.update({
      where: { id: cached.id },
      data: { finishedAt: new Date() },
    });
    return {
      run: touched,
      started: false,
      conflict: false,
      reused: true,
      probeCount: confirmed.length,
    };
  }

  const prior = await findLatestLiveCompletedRun(projectId);
  const priorQueries = new Set(
    (prior?.results || []).map((r) => String(r.query || '').toLowerCase())
  );
  const hasOverlap = confirmed.some((q) => priorQueries.has(q.toLowerCase()));
  const priorRunId = hasOverlap && prior ? prior.id : null;

  const run = await prisma.aiVisibilityRun.create({
    data: {
      projectId,
      clientId,
      status: 'pending',
      triggeredById: triggeredById || null,
      probeFingerprint: fingerprint,
      isDemo: false,
    },
  });

  setImmediate(() => {
    executeAiVisibilityRun(run.id, { probes: confirmed, priorRunId }).catch((err) => {
      console.error('[aiVisibility] run failed', run.id, err.message);
    });
  });

  return {
    run,
    started: true,
    conflict: false,
    reused: false,
    probeCount: confirmed.length,
    partialReuse: !!priorRunId,
  };
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
