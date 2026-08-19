/**
 * Labeled sample/demo AI Visibility snapshot for training and walkthroughs.
 * Deterministic cited rate in the 35–53% band. Does not call OpenRouter or DataForSEO.
 */

import { createHash } from 'crypto';
import { prisma } from '../prisma.js';
import { domainFromUrl } from './providers.js';
import { brandTokensForProject } from './aiVisibilityQueryIntel.js';
import { normalizeProbeList, fingerprintProbeList } from './aiVisibilitySiteKeywords.js';

const DEMO_PLATFORMS = ['chatgpt', 'claude', 'gemini', 'perplexity'];

function hashByte(seed) {
  return createHash('sha256').update(String(seed)).digest()[0];
}

/** Stable target rate 35–53 inclusive from fingerprint. */
export function demoCitationTargetRate(fingerprint) {
  return 35 + (hashByte(fingerprint) % 19);
}

function shouldCiteCell(fingerprint, query, platform, targetRate) {
  const n = createHash('sha256').update(`${fingerprint}|${query}|${platform}`).digest()[0] % 100;
  return n < targetRate;
}

function demoAnswer({ brand, domain, query, cited }) {
  const brandLabel = brand || 'this business';
  const site = domain ? `https://${domain}` : 'their website';
  if (cited) {
    return (
      `For “${query}”, several local providers are commonly mentioned. ` +
      `${brandLabel} is frequently recommended for reliability and local coverage` +
      (domain ? ` (${site})` : '') +
      `. Other regional firms may also appear depending on the model.`
    );
  }
  return (
    `For “${query}”, answers often list general tips and a few regional providers. ` +
    `This sample response does not highlight a single brand citation — useful for training how “not cited” looks.`
  );
}

/**
 * Create a completed demo run with synthetic results.
 * @returns {{ run, probeCount: number, citationRate: number, targetRate: number }}
 */
export async function createAiVisibilityDemoRun({ projectId, clientId, triggeredById, probes }) {
  const confirmed = normalizeProbeList(probes || [], { min: 1, max: 20 });
  if (confirmed.length === 0) {
    const err = new Error('At least one probe query is required for the sample demo');
    err.status = 400;
    throw err;
  }

  const active = await prisma.aiVisibilityRun.findFirst({
    where: { projectId, status: { in: ['pending', 'running'] } },
  });
  if (active) {
    const err = new Error('An AI Visibility run is already in progress for this project');
    err.status = 409;
    err.run = active;
    throw err;
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, clientId },
    select: {
      id: true,
      name: true,
      dataforseoDomain: true,
      gscSiteUrl: true,
      client: { select: { agencyName: true, websiteUrl: true } },
    },
  });
  if (!project) {
    const err = new Error('Project not found for this client');
    err.status = 404;
    throw err;
  }

  const domain =
    domainFromUrl(project.dataforseoDomain || '') ||
    domainFromUrl(project.client?.websiteUrl || '') ||
    domainFromUrl(String(project.gscSiteUrl || '').replace(/^sc-domain:/, ''));

  const brands = brandTokensForProject(project);
  if (project.client?.agencyName) brands.unshift(project.client.agencyName);
  const brand = brands[0] || project.name || 'Brand';

  const fingerprint = fingerprintProbeList(confirmed);
  const targetRate = demoCitationTargetRate(fingerprint);
  const platforms = DEMO_PLATFORMS;

  const now = new Date();
  const run = await prisma.aiVisibilityRun.create({
    data: {
      projectId,
      clientId,
      status: 'completed',
      triggeredById: triggeredById || null,
      startedAt: now,
      finishedAt: now,
      queryCount: confirmed.length,
      modelCount: platforms.length,
      isDemo: true,
      probeFingerprint: fingerprint,
      error: 'Sample demo data — not a live model run',
    },
  });

  const rows = [];
  let citedCount = 0;
  for (const query of confirmed) {
    for (const platform of platforms) {
      const cited = shouldCiteCell(fingerprint, query, platform, targetRate);
      if (cited) citedCount++;
      rows.push({
        runId: run.id,
        query: query.slice(0, 500),
        sourceQuery: 'demo-sample',
        platform,
        openrouterModel: `demo/${platform}`,
        cited,
        citationType: cited ? 'brand' : 'none',
        responseText: demoAnswer({ brand, domain, query, cited }),
        competitorsJson: cited ? [] : ['example-competitor.local'],
      });
    }
  }

  if (rows.length) {
    await prisma.aiVisibilityResult.createMany({ data: rows });
  }

  // Minimal DFS placeholder (skipped) so UI sections stay stable
  await prisma.aiVisibilityDfsSnapshot.create({
    data: {
      runId: run.id,
      domain: domain || null,
      payload: {
        ok: false,
        skipped: true,
        error: 'Sample demo — DataForSEO not called',
        domain: domain || null,
        totalMentions: 0,
        aiSearchVolume: 0,
        byPlatform: {},
        topDomains: [],
        fetchedAt: now.toISOString(),
      },
    },
  });

  const citationRate = rows.length ? Math.round((citedCount / rows.length) * 100) : 0;
  return { run, probeCount: confirmed.length, citationRate, targetRate };
}
