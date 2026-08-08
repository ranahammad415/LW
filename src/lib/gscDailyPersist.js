/**
 * Shared GSC daily-series fetch + persist helpers used by cron sync and
 * analytics read-path gap healing.
 */
import { prisma } from './prisma.js';
import { fetchDailySearchAnalytics } from './gscClient.js';

export const MS_DAY = 86400000;
/** Chunk size when pulling long history (keeps each API call small/reliable). */
export const FETCH_CHUNK_DAYS = 90;

/** Format a Date as YYYY-MM-DD (UTC). */
export function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** UTC calendar day (midnight). */
export function utcDay(d = new Date()) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  if (typeof d === 'string' && d.length >= 10) {
    return new Date(`${d.slice(0, 10)}T00:00:00.000Z`);
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addUtcDays(d, days) {
  return new Date(utcDay(d).getTime() + days * MS_DAY);
}

/**
 * Upsert daily GSC API rows for one project.
 * @returns {Promise<number>} number of days written
 */
export async function upsertDailyRows(projectId, rows) {
  let upserts = 0;
  for (const row of rows || []) {
    const dateStr = row.keys?.[0];
    if (!dateStr) continue;
    const date = new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) continue;
    await prisma.gscDailyMetric.upsert({
      where: { projectId_date: { projectId, date } },
      create: {
        projectId,
        date,
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
      update: {
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
    });
    upserts++;
  }
  return upserts;
}

/**
 * Fetch daily GSC metrics in chunks for [start, end] (inclusive UTC days).
 */
export async function fetchDailyInChunks(siteUrl, start, end) {
  const all = [];
  const s = utcDay(start);
  const e = utcDay(end);
  for (let chunkStart = s; chunkStart.getTime() <= e.getTime(); ) {
    const chunkEnd = addUtcDays(chunkStart, FETCH_CHUNK_DAYS - 1);
    const cappedEnd = chunkEnd.getTime() > e.getTime() ? e : chunkEnd;
    const rows = await fetchDailySearchAnalytics(siteUrl, fmt(chunkStart), fmt(cappedEnd));
    if (rows?.length) all.push(...rows);
    chunkStart = addUtcDays(cappedEnd, 1);
  }
  return all;
}

/**
 * Live-fetch + upsert daily metrics for one project over [start, end].
 * @returns {Promise<number>} days upserted
 */
export async function persistDailyRange(project, start, end) {
  if (!project?.id || !project?.gscSiteUrl) return 0;
  const rows = await fetchDailyInChunks(project.gscSiteUrl, start, end);
  return upsertDailyRows(project.id, rows);
}
