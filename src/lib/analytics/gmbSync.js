import { prisma } from '../prisma.js';
import { fetchGmbDailyMetrics, fetchGmbReviews } from './gmbClient.js';
import {
  fetchGmbInfo as fetchGmbInfoDfs,
  fetchGmbReviews as fetchGmbReviewsDfs,
} from '../omniSearch/businessDataProvider.js';
import {
  BUSINESS_DATA_PROVIDER,
  hasRealBusinessDataProvider,
} from '../omniSearch/omniSearchConfig.js';

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Persist a normalized review into GmbReview (used by both native + DataForSEO paths).
 */
async function upsertReview(projectId, r) {
  if (!r.reviewId || !r.starRating) return false;
  const reviewId = String(r.reviewId).slice(0, 200);
  await prisma.gmbReview.upsert({
    where: { projectId_reviewId: { projectId, reviewId } },
    create: {
      projectId,
      reviewId,
      reviewerName: r.reviewerName,
      starRating: r.starRating,
      comment: r.comment,
      replyComment: r.replyComment,
      createTime: r.createTime,
      updateTime: r.updateTime,
    },
    update: {
      reviewerName: r.reviewerName,
      starRating: r.starRating,
      comment: r.comment,
      replyComment: r.replyComment,
      createTime: r.createTime,
      updateTime: r.updateTime,
    },
  });
  return true;
}

/**
 * DataForSEO fallback: pull public info + reviews for a project bound via gmbCid.
 * Does not populate GmbDailyMetric (owner-only performance metrics are native-only).
 */
async function syncGmbProjectViaDataForSeo(project) {
  const identifier = project.gmbCid;
  let reviews = 0;
  const list = await fetchGmbReviewsDfs({ identifier });
  for (const r of list) {
    if (await upsertReview(project.id, r)) reviews++;
  }
  // Validate the identifier / warm the profile (rating is derived from reviews in buildGmbView).
  try {
    await fetchGmbInfoDfs({ identifier });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] dataforseo info failed for ${project.id}: ${err.message}`);
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { gmbLastSyncedAt: new Date() },
  });

  return { projectId: project.id, status: 'ok', source: 'dataforseo', days: 0, reviews };
}

export async function syncGmbProject(project) {
  // Decide the source. 'auto' prefers native when a location is bound, else
  // falls back to DataForSEO when a manual identifier (gmbCid) is present.
  const dfsAvailable =
    BUSINESS_DATA_PROVIDER !== 'google' &&
    !!project.gmbCid &&
    hasRealBusinessDataProvider();

  if (BUSINESS_DATA_PROVIDER === 'dataforseo') {
    if (!dfsAvailable) return { projectId: project.id, status: 'skipped' };
    return syncGmbProjectViaDataForSeo(project);
  }

  if (!project.gmbLocationId) {
    if (dfsAvailable) return syncGmbProjectViaDataForSeo(project);
    return { projectId: project.id, status: 'skipped' };
  }

  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);

  let days = 0;
  try {
    const series = await fetchGmbDailyMetrics(project.gmbLocationId, start, end);
    for (const row of series) {
      const date = new Date(`${row.date}T00:00:00.000Z`);
      await prisma.gmbDailyMetric.upsert({
        where: { projectId_date: { projectId: project.id, date } },
        create: {
          projectId: project.id,
          date,
          impressions: row.impressions,
          impressionsSearch: row.impressionsSearch,
          impressionsMaps: row.impressionsMaps,
          websiteClicks: row.websiteClicks,
          directions: row.directions,
          calls: row.calls,
        },
        update: {
          impressions: row.impressions,
          impressionsSearch: row.impressionsSearch,
          impressionsMaps: row.impressionsMaps,
          websiteClicks: row.websiteClicks,
          directions: row.directions,
          calls: row.calls,
        },
      });
      days++;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] metrics failed for ${project.id}: ${err.message}`);
  }

  let reviews = 0;
  try {
    const list = await fetchGmbReviews(project.gmbAccountId || '', project.gmbLocationId);
    for (const r of list) {
      if (await upsertReview(project.id, r)) reviews++;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] reviews failed for ${project.id}: ${err.message}`);
  }

  // Native path produced nothing (e.g. Business Profile API quota is 0) — fall
  // back to DataForSEO when a manual identifier is available.
  if (days === 0 && reviews === 0 && dfsAvailable) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] native GMB empty for ${project.id}, falling back to DataForSEO`);
    return syncGmbProjectViaDataForSeo(project);
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { gmbLastSyncedAt: new Date() },
  });

  return { projectId: project.id, status: 'ok', source: 'google', days, reviews, rangeEnd: fmt(end) };
}

export async function runGmbSync() {
  const projects = await prisma.project.findMany({
    where: {
      OR: [{ gmbLocationId: { not: null } }, { gmbCid: { not: null } }],
    },
    select: {
      id: true,
      gmbLocationId: true,
      gmbAccountId: true,
      gmbCid: true,
      clientId: true,
    },
  });
  const details = [];
  for (const p of projects) {
    try {
      details.push(await syncGmbProject(p));
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
