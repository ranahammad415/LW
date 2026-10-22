/**
 * Organic rank refresh (DataForSEO / SerpAPI) for projects with a bound domain + tracked keywords.
 *
 * Rules (docs/ledger/features/local-seo.md, features/analytics.md):
 * - Only real provider results are stored (dataSource in REAL_SERP_SOURCES). An estimate or a failure never reaches
 *   KeywordTrack.currentRank or KeywordRankDaily: the previous value stays and the keyword gets rankStatus 'error' +
 *   rankError; the run summary counts the failures.
 * - A real "not in the top 100" sets currentRank null and rankStatus 'not_found' (no KeywordRankDaily row).
 * - Only approved keywords are checked (TRACKED_KEYWORD_STATUSES); PROPOSED / REJECTED / EDIT_SUGGESTED are skipped.
 * - The project's local search location (Project.localLocationCode / localLocationName / localLanguageCode) is used
 *   when set; otherwise the provider default (US 2840, en).
 * - Max RANK_MAX_KEYWORDS_PER_PROJECT keywords per project per run.
 */
import { prisma } from '../prisma.js';
import { getKeywordRankings, hasRealSerpProvider, domainFromUrl } from './providers.js';
import { REAL_SERP_SOURCES } from '../omniSearch/serpProvider.js';

import { TRACKED_KEYWORD_STATUSES } from './keywordStatus.js';

export { TRACKED_KEYWORD_STATUSES };
export const RANK_MAX_KEYWORDS_PER_PROJECT = 50;

/** Today as a UTC midnight Date (KeywordRankDaily.date is @db.Date). */
export function utcToday(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Classify one provider result. Pure. → { kind: 'ok'|'not_found'|'error', rank?, error? } */
export function classifyRankResult(r) {
  if (!r || r.dataSource === 'error' || r.error) return { kind: 'error', error: r?.error || 'lookup failed' };
  if (!REAL_SERP_SOURCES.includes(r.dataSource)) return { kind: 'error', error: `not a real provider result (${r.dataSource})` };
  if (r.position == null) return { kind: 'not_found' };
  const rank = Math.round(Number(r.position));
  if (!Number.isFinite(rank) || rank < 1) return { kind: 'error', error: 'invalid position' };
  return { kind: 'ok', rank };
}

export async function syncDataForSeoProject(project, { now = new Date() } = {}) {
  const domain = domainFromUrl(project.dataforseoDomain || '');
  if (!domain) return { projectId: project.id, status: 'skipped', reason: 'no domain' };
  if (!hasRealSerpProvider()) {
    return { projectId: project.id, status: 'skipped', reason: 'no serp provider' };
  }

  const keywords = await prisma.keywordTrack.findMany({
    where: { projectId: project.id, status: { in: [...TRACKED_KEYWORD_STATUSES] } },
    select: { id: true, keyword: true },
    orderBy: { keyword: 'asc' },
    take: RANK_MAX_KEYWORDS_PER_PROJECT,
  });
  if (keywords.length === 0) {
    return { projectId: project.id, status: 'skipped', reason: 'no keywords' };
  }

  const results = await getKeywordRankings({
    domain,
    keywords: keywords.map((k) => k.keyword),
    locationCode: project.localLocationCode ?? null,
    locationName: project.localLocationName ?? null,
    languageCode: project.localLanguageCode || null,
  });

  let updated = 0;
  let notFound = 0;
  let failed = 0;
  let costUsd = 0;
  const errors = [];
  const day = utcToday(now);
  for (const r of results) {
    const match = keywords.find((k) => k.keyword === r.keyword);
    if (!match) continue;
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
    const c = classifyRankResult(r);
    if (c.kind === 'error') {
      failed++;
      if (errors.length < 5) errors.push({ keyword: r.keyword, error: c.error });
      // Keep the previous currentRank; record the failure on the keyword.
      await prisma.keywordTrack
        .update({
          where: { id: match.id },
          data: { rankStatus: 'error', rankCheckedAt: now, rankError: String(c.error).slice(0, 200) },
        })
        .catch(() => null);
      continue;
    }
    if (c.kind === 'not_found') {
      notFound++;
      await prisma.keywordTrack.update({
        where: { id: match.id },
        data: { currentRank: null, rankStatus: 'not_found', rankCheckedAt: now, rankError: null },
      });
      continue;
    }
    await prisma.keywordTrack.update({
      where: { id: match.id },
      data: { currentRank: c.rank, rankStatus: 'ok', rankCheckedAt: now, rankError: null },
    });
    // Health score v2 quick win: daily rank history (one row per keyword per UTC day; a re-run updates it).
    // Best effort: the paid rank lookup above is already stored on KeywordTrack even if this write fails.
    await prisma.keywordRankDaily
      .upsert({
        where: { keywordId_date: { keywordId: match.id, date: day } },
        create: { keywordId: match.id, projectId: project.id, date: day, rank: c.rank },
        update: { rank: c.rank },
      })
      .catch(() => null);
    updated++;
  }

  return {
    projectId: project.id,
    status: failed > 0 && updated + notFound === 0 ? 'error' : 'ok',
    updated,
    notFound,
    failed,
    checked: keywords.length,
    costUsd: Number(costUsd.toFixed(5)),
    errors,
  };
}

export async function runDataForSeoSync() {
  const projects = await prisma.project.findMany({
    where: { dataforseoDomain: { not: null } },
    select: { id: true, dataforseoDomain: true, localLocationCode: true, localLocationName: true, localLanguageCode: true },
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
    keywordFailures: details.reduce((s, d) => s + (d.failed || 0), 0),
    costUsd: Number(details.reduce((s, d) => s + (d.costUsd || 0), 0).toFixed(5)),
    details,
  };
}
