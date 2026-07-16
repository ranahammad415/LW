import { prisma } from '../prisma.js';
import { fetchGmbDailyMetrics, fetchGmbReviews } from './gmbClient.js';

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

export async function syncGmbProject(project) {
  if (!project.gmbLocationId) return { projectId: project.id, status: 'skipped' };

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
      if (!r.reviewId || !r.starRating) continue;
      await prisma.gmbReview.upsert({
        where: { projectId_reviewId: { projectId: project.id, reviewId: String(r.reviewId).slice(0, 200) } },
        create: {
          projectId: project.id,
          reviewId: String(r.reviewId).slice(0, 200),
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
      reviews++;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] reviews failed for ${project.id}: ${err.message}`);
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { gmbLastSyncedAt: new Date() },
  });

  return { projectId: project.id, status: 'ok', days, reviews, rangeEnd: fmt(end) };
}

export async function runGmbSync() {
  const projects = await prisma.project.findMany({
    where: { gmbLocationId: { not: null } },
    select: { id: true, gmbLocationId: true, gmbAccountId: true, clientId: true },
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
