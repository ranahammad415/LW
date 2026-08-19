/**
 * DataForSEO ranking refresh for projects with a bound domain + tracked keywords.
 */
import { prisma } from '../prisma.js';
import { getKeywordRankings, hasRealSerpProvider, domainFromUrl } from './providers.js';

export async function syncDataForSeoProject(project) {
  const domain = domainFromUrl(project.dataforseoDomain || '');
  if (!domain) return { projectId: project.id, status: 'skipped', reason: 'no domain' };
  if (!hasRealSerpProvider()) {
    return { projectId: project.id, status: 'skipped', reason: 'no serp provider' };
  }

  const keywords = await prisma.keywordTrack.findMany({
    where: { projectId: project.id, status: { in: ['ACCEPTED', 'TRACKING', 'PROPOSED'] } },
    select: { id: true, keyword: true },
    take: 50,
  });
  if (keywords.length === 0) {
    return { projectId: project.id, status: 'skipped', reason: 'no keywords' };
  }

  const results = await getKeywordRankings({
    domain,
    keywords: keywords.map((k) => k.keyword),
  });

  let updated = 0;
  for (const r of results) {
    const match = keywords.find((k) => k.keyword === r.keyword);
    if (!match) continue;
    if (r.position == null) continue;
    await prisma.keywordTrack.update({
      where: { id: match.id },
      data: { currentRank: Math.round(r.position) },
    });
    updated++;
  }

  return { projectId: project.id, status: 'ok', updated, checked: keywords.length };
}

export async function runDataForSeoSync() {
  const projects = await prisma.project.findMany({
    where: { dataforseoDomain: { not: null } },
    select: { id: true, dataforseoDomain: true },
  });
  const details = [];
  for (const p of projects) {
    try {
      details.push(await syncDataForSeoProject(p));
    } catch (err) {
      details.push({ projectId: p.id, status: 'error', error: err.message });
    }
  }
  return {
    total: projects.length,
    success: details.filter((d) => d.status === 'ok').length,
    errors: details.filter((d) => d.status === 'error').length,
    details,
  };
}
