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
 * Candidate GSC property URL forms (www / apex / sc-domain / trailing slash).
 * Search Console requires an exact property match.
 */
export function gscSiteUrlVariants(siteUrl) {
  const raw = String(siteUrl || '').trim();
  if (!raw) return [];
  const variants = new Set([raw]);
  const add = (u) => {
    if (u) variants.add(u);
  };

  if (raw.startsWith('sc-domain:')) {
    const domain = raw.slice('sc-domain:'.length).replace(/^www\./i, '').toLowerCase();
    add(`sc-domain:${domain}`);
    add(`https://${domain}/`);
    add(`https://www.${domain}/`);
    add(`http://${domain}/`);
    add(`http://www.${domain}/`);
    return [...variants];
  }

  try {
    const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
    const noSlash = raw.replace(/\/+$/, '');
    add(withSlash);
    add(noSlash);
    const u = new URL(withSlash);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    add(`https://${host}/`);
    add(`https://www.${host}/`);
    add(`http://${host}/`);
    add(`http://www.${host}/`);
    add(`sc-domain:${host}`);
  } catch {
    // keep raw only
  }
  return [...variants];
}

function scoreDailyRows(rows) {
  let clicks = 0;
  let impressions = 0;
  let active = 0;
  let newest = null;
  for (const row of rows || []) {
    const d = String(row.keys?.[0] || '').slice(0, 10);
    const c = row.clicks || 0;
    const impr = row.impressions || 0;
    clicks += c;
    impressions += impr;
    if (c > 0 || impr > 0) {
      active += 1;
      if (d && (!newest || d > newest)) newest = d;
    }
  }
  return { clicks, impressions, active, newest };
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

function coverageLooksComplete(score, start, end) {
  const expected = Math.round((utcDay(end).getTime() - utcDay(start).getTime()) / MS_DAY) + 1;
  if (expected <= 0) return true;
  if (!score.active) return false;
  if (score.active / expected < 0.9) return false;
  if (!score.newest) return false;
  const newest = utcDay(score.newest);
  return newest.getTime() >= utcDay(end).getTime() - MS_DAY;
}

/**
 * Live-fetch + replace daily metrics for one project over [start, end].
 * Tries property URL variants when the stored URL returns a sparse/empty series.
 *
 * @returns {Promise<{ dayRows: number, clicks: number, impressions: number, siteUrl: string, corrected: boolean }>}
 */
export async function persistDailyRange(project, start, end) {
  if (!project?.id || !project?.gscSiteUrl) {
    return { dayRows: 0, clicks: 0, impressions: 0, siteUrl: '', corrected: false };
  }

  const variants = gscSiteUrlVariants(project.gscSiteUrl);
  let best = {
    rows: [],
    siteUrl: project.gscSiteUrl,
    clicks: 0,
    impressions: 0,
    active: 0,
    newest: null,
  };
  let lastErr = null;

  for (const siteUrl of variants) {
    try {
      const rows = await fetchDailyInChunks(siteUrl, start, end);
      const score = scoreDailyRows(rows);
      const better =
        score.clicks > best.clicks ||
        (score.clicks === best.clicks && score.active > best.active) ||
        (score.clicks === best.clicks && score.active === best.active && score.impressions > best.impressions);
      if (better) {
        best = { rows, siteUrl, ...score };
      }
      if (coverageLooksComplete(score, start, end)) {
        best = { rows, siteUrl, ...score };
        break;
      }
    } catch (err) {
      lastErr = err;
      // eslint-disable-next-line no-console
      console.warn(
        `[gscDailyPersist] fetch failed for ${siteUrl}: ${err?.message || err}`
      );
    }
  }

  if (!best.rows.length) {
    if (lastErr) throw lastErr;
    // Do not wipe local history when every property variant returned empty.
    return {
      dayRows: 0,
      clicks: 0,
      impressions: 0,
      siteUrl: project.gscSiteUrl,
      corrected: false,
    };
  }

  const rangeStart = utcDay(start);
  const rangeEnd = utcDay(end);
  // Replace the window so stale zero rows cannot survive a sparse API response.
  await prisma.gscDailyMetric.deleteMany({
    where: {
      projectId: project.id,
      date: { gte: rangeStart, lte: rangeEnd },
    },
  });
  const dayRows = await upsertDailyRows(project.id, best.rows);

  let corrected = false;
  if (best.siteUrl && best.siteUrl !== project.gscSiteUrl && best.clicks > 0) {
    await prisma.project.update({
      where: { id: project.id },
      data: { gscSiteUrl: best.siteUrl },
    });
    corrected = true;
    // eslint-disable-next-line no-console
    console.info(
      `[gscDailyPersist] corrected gscSiteUrl for ${project.id}: ` +
        `${project.gscSiteUrl} → ${best.siteUrl}`
    );
  }

  // eslint-disable-next-line no-console
  console.info(
    `[gscDailyPersist] ${project.id}: ${fmt(rangeStart)} → ${fmt(rangeEnd)} ` +
      `site=${best.siteUrl} days=${dayRows} clicks=${Math.round(best.clicks)} ` +
      `impr=${Math.round(best.impressions)} newest=${best.newest || 'none'}`
  );

  return {
    dayRows,
    clicks: best.clicks,
    impressions: best.impressions,
    siteUrl: best.siteUrl,
    corrected,
  };
}
