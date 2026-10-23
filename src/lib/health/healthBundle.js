/**
 * Health score v2: data loading. One query per source per project (`loadHealthBundle`), then any number of
 * point-in-time slices (`sliceBundle`) without further I/O, so a 90-day backfill costs the same queries as one day.
 * docs/ledger/features/health-score.md §Data.
 */
import { prisma } from '../prisma.js';
import { hasSecurity, hasBackups } from '../security/securitySync.js';
import { addDays, dayDiff, sumRange, toDateStr, windowsFor, MS_DAY } from './healthMath.js';
import { hasGbpIdentity } from '../analytics/gmbIdentifier.js';

/** Project fields the health service needs (all verified against schema.prisma). */
export const HEALTH_PROJECT_SELECT = Object.freeze({
  id: true,
  name: true,
  clientId: true,
  leadPmId: true,
  projectType: true,
  status: true,
  cmsType: true,
  cmsCapabilities: true,
  cmsLastSeenAt: true,
  cmsRepairNeededAt: true,
  cmsDisconnectedAt: true,
  cmsPairedAt: true,
  wpUrl: true,
  wpSiteInfoSyncedAt: true,
  gscSiteUrl: true,
  ga4PropertyId: true,
  gmbLocationId: true,
  gmbCid: true,
  gmbPlaceId: true,
  gmbRating: true,
  gmbReviewsCount: true,
  bingSiteUrl: true,
});

/** How far back one load reaches before `from`: two windows + a year (YoY) + the GSC lag. */
export function bundleLookbackDays(cfg) {
  const days = cfg?.window?.days ?? 28;
  return 2 * days + 364 + (cfg?.window?.gscLagDays ?? 2) + 7;
}

const S2_MAX_DAYS = 60;
const REVIEW_TAKE = 500;

const asDate = (s) => new Date(`${toDateStr(s)}T00:00:00.000Z`);
const day = (d) => (d ? toDateStr(d instanceof Date ? d.toISOString() : d) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Load every source for one project over [from − lookback, to]. `from`/`to` are the first/last score dates
 * (YYYY-MM-DD); for a single day they are equal. Unlinked sources are not queried.
 */
export async function loadHealthBundle(project, { from, to, cfg } = {}) {
  const start = addDays(from, -bundleLookbackDays(cfg));
  const range = { gte: asDate(start), lte: asDate(to) };
  const pid = project.id;
  const sec = hasSecurity(project);
  const bak = hasBackups(project);
  const s2Days = Math.min(S2_MAX_DAYS, cfg?.factors?.S2?.days ?? 14);
  const runsFrom = new Date(asDate(from).getTime() - (s2Days + 1) * MS_DAY);
  const none = Promise.resolve(null);
  // Reviews feed R1–R3 from either source (native or DataForSEO): gated on a GBP identity, not the native location.
  const gbp = hasGbpIdentity(project);

  // Config v2 factors (contract 1.8.0): only queried when the active config has them.
  const wantR5 = !!cfg?.factors?.R5;
  const wantA1 = !!cfg?.factors?.A1;
  const a1From = new Date(asDate(start).getTime() - (cfg?.factors?.A1?.maxAgeDays ?? 45) * MS_DAY);
  // Config v3 proposal (Bing Webmaster): V5 clicks / S4 crawl rows, only with a bound Bing site and the factor active.
  const wantBing = !!project.bingSiteUrl && !!cfg?.factors?.V5;
  const wantBingCrawl = !!project.bingSiteUrl && !!cfg?.factors?.S4;

  const [gsc, ga4, gmb, reviews, leads, status, points, failChecks, runs, citations, aiRuns, bing, bingCrawl] = await Promise.all([
    project.gscSiteUrl
      ? prisma.gscDailyMetric.findMany({ where: { projectId: pid, date: range }, select: { date: true, clicks: true, impressions: true, ctr: true, position: true } })
      : none,
    project.ga4PropertyId
      ? prisma.ga4DailyMetric.findMany({ where: { projectId: pid, date: range }, select: { date: true, sessions: true, totalUsers: true, bounceRate: true, avgEngagementSec: true, conversions: true } })
      : none,
    project.gmbLocationId
      ? prisma.gmbDailyMetric.findMany({ where: { projectId: pid, date: range }, select: { date: true, impressions: true, websiteClicks: true, directions: true, calls: true } })
      : none,
    gbp
      ? prisma.gmbReview.findMany({
          where: { projectId: pid, removedAt: null, createTime: { gte: asDate(start), lte: new Date(asDate(to).getTime() + MS_DAY - 1) } },
          select: { starRating: true, replyComment: true, createTime: true },
          orderBy: { createTime: 'desc' },
          take: REVIEW_TAKE,
        })
      : none,
    prisma.siteLeadDailyMetric.findMany({ where: { projectId: pid, date: range }, select: { date: true, leads: true, phoneClicks: true, emailClicks: true } }),
    sec || bak
      ? prisma.securitySiteStatus.findUnique({ where: { projectId: pid }, select: { overallState: true, disabled: true, statusAt: true } })
      : none,
    sec ? prisma.securityDailyPoint.findMany({ where: { projectId: pid, date: { gte: from } }, select: { date: true, overallState: true } }) : none,
    sec ? prisma.securityCheckState.findMany({ where: { projectId: pid, state: 'fail' }, select: { checkId: true, severity: true } }) : none,
    bak
      ? prisma.securityBackupRun.findMany({
          where: { projectId: pid, createdAt: { gte: runsFrom }, result: { in: ['ok', 'failed', 'missed'] } },
          select: { destinationId: true, result: true, verified: true, createdAt: true, finishedAt: true },
          orderBy: { createdAt: 'asc' },
          take: 5000,
        })
      : none,
    // R5: the citation mirror (current state only: there is no history, so backfilled dates get no R5).
    wantR5 ? prisma.seoCitationMirror.findMany({ where: { projectId: pid }, select: { napStatus: true } }) : none,
    // A1: completed, non-demo AI-visibility runs (admin or scheduled) with their cells.
    wantA1
      ? prisma.aiVisibilityRun.findMany({
          where: { projectId: pid, status: 'completed', isDemo: false, finishedAt: { gte: a1From, lte: new Date(asDate(to).getTime() + MS_DAY - 1) } },
          select: { id: true, finishedAt: true, results: { select: { cited: true, citationType: true } } },
          orderBy: { finishedAt: 'asc' },
          take: 60,
        })
      : none,
    wantBing ? prisma.bingDailyMetric.findMany({ where: { projectId: pid, date: range }, select: { date: true, clicks: true, impressions: true } }) : none,
    wantBingCrawl
      ? prisma.bingCrawlDaily.findMany({ where: { projectId: pid, date: range }, select: { date: true, crawledPages: true, code4xx: true, code5xx: true, crawlErrors: true } })
      : none,
  ]);

  const rows = (list, map) => (Array.isArray(list) ? list.map((r) => ({ ...map(r), date: day(r.date) })) : null);
  return {
    project: { ...project },
    from,
    to,
    loadedFrom: start,
    gsc: rows(gsc, (r) => ({ clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    ga4: rows(ga4, (r) => ({ sessions: r.sessions, totalUsers: r.totalUsers, bounceRate: r.bounceRate, avgEngagementSec: r.avgEngagementSec, conversions: r.conversions })),
    gmb: rows(gmb, (r) => ({ impressions: r.impressions, websiteClicks: r.websiteClicks, directions: r.directions, calls: r.calls })),
    reviews: Array.isArray(reviews) ? reviews.map((r) => ({ starRating: r.starRating, replied: !!(r.replyComment && String(r.replyComment).trim()), createTime: iso(r.createTime) })) : null,
    leads: rows(leads, (r) => ({ leads: r.leads, phoneClicks: r.phoneClicks, emailClicks: r.emailClicks })) || [],
    security: {
      security: sec,
      backups: bak,
      status: status ? { overallState: status.overallState || null, disabled: Array.isArray(status.disabled) ? status.disabled : [] } : null,
      points: Array.isArray(points) ? points.map((p) => ({ date: p.date, overallState: p.overallState })) : [],
      failChecks: Array.isArray(failChecks) ? failChecks : [],
      runs: Array.isArray(runs) ? runs.map((r) => ({ destinationId: r.destinationId || 'default', result: r.result, verified: r.verified === true, at: iso(r.finishedAt || r.createdAt) })) : [],
    },
    citations: Array.isArray(citations) ? citations.map((c) => c.napStatus) : null,
    aiRuns: Array.isArray(aiRuns)
      ? aiRuns.map((r) => {
          const cells = (r.results || []).filter((x) => x.citationType !== 'error');
          return { at: iso(r.finishedAt), cells: cells.length, cited: cells.filter((x) => x.cited).length };
        })
      : null,
    bing: rows(bing, (r) => ({ clicks: r.clicks, impressions: r.impressions })),
    bingCrawl: rows(bingCrawl, (r) => ({ crawledPages: r.crawledPages || 0, errors: (r.code4xx || 0) + (r.code5xx || 0) + (r.crawlErrors || 0) })),
  };
}

// ── slicing ──

function indexByDate(list) {
  const m = new Map();
  for (const r of list || []) if (r.date) m.set(r.date, r);
  return m;
}

function maps(bundle) {
  if (!bundle._maps) {
    // Built once per bundle. Rows after a slice date are never summed: every window ends at or before its anchor.
    bundle._maps = {
      gsc: indexByDate(bundle.gsc),
      ga4: indexByDate(bundle.ga4),
      gmb: indexByDate(bundle.gmb),
      leads: indexByDate(bundle.leads),
      bing: indexByDate(bundle.bing),
      bingCrawl: indexByDate(bundle.bingCrawl),
    };
  }
  return bundle._maps;
}

function newestOnOrBefore(list, date) {
  let best = null;
  for (const r of list || []) if (r.date <= date && (!best || r.date > best)) best = r.date;
  return best;
}

function oldestDate(list) {
  let best = null;
  for (const r of list || []) if (!best || r.date < best) best = r.date;
  return best;
}

const GSC_FIELDS = ['clicks', 'impressions', 'posW'];
const GA4_FIELDS = ['sessions', 'conversions', 'engW', 'bounceW'];
const GMB_FIELDS = ['impressions', 'websiteClicks', 'directions', 'calls'];
const LEAD_FIELDS = ['leads', 'phoneClicks', 'emailClicks'];

/** GA4 bounceRate arrives as 0–1; older rows may be 0–100 (same rule as aggregateFacts normalizeBouncePct). */
export function bouncePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

function derived(bundle) {
  if (!bundle._derived) {
    const gsc = new Map();
    for (const [d, r] of maps(bundle).gsc) gsc.set(d, { clicks: r.clicks, impressions: r.impressions, posW: (Number(r.position) || 0) * (Number(r.impressions) || 0) });
    const ga4 = new Map();
    for (const [d, r] of maps(bundle).ga4) {
      const s = Number(r.sessions) || 0;
      ga4.set(d, { sessions: s, conversions: r.conversions, engW: (Number(r.avgEngagementSec) || 0) * s, bounceW: bouncePct(r.bounceRate) * s });
    }
    bundle._derived = { gsc, ga4 };
  }
  return bundle._derived;
}

function sums(byDate, w, fields, { yoy = true, short = false } = {}) {
  return {
    cur: sumRange(byDate, w.cur, fields),
    prev: sumRange(byDate, w.prev, fields),
    yoy: yoy ? sumRange(byDate, w.yoy, fields) : null,
    shortCur: short ? sumRange(byDate, w.shortCur, fields) : null,
    shortPrev: short ? sumRange(byDate, w.shortPrev, fields) : null,
  };
}

export const GSC_STALE_DAYS = 5;

/**
 * Point-in-time view of the bundle for one score date. Pure. `now` is used only for live (non-backfilled) ages.
 * Sources keep `linked: false` when the project has no binding (factor reason 'unlinked').
 */
export function sliceBundle(bundle, date, cfg, { backfilled = false, now = Date.now() } = {}) {
  const p = bundle.project || {};
  const w = windowsFor(date, cfg);
  const d = derived(bundle);
  const m = maps(bundle);

  // GSC: if the newest row is older than GSC_STALE_DAYS, re-anchor on it and flag the source as stale.
  let gscW = w;
  let gscStale = false;
  const gscNewest = newestOnOrBefore(bundle.gsc, w.date);
  if (gscNewest && dayDiff(gscNewest, w.date) > GSC_STALE_DAYS) {
    gscW = windowsFor(addDays(gscNewest, cfg?.window?.gscLagDays ?? 2), cfg); // anchor = newest GSC day
    gscStale = true;
  }

  const ga4Oldest = oldestDate(bundle.ga4);
  const leadsEver = (bundle.leads || []).some((r) => r.date <= w.date);
  const reviews = (bundle.reviews || []).filter((r) => r.createTime && r.createTime.slice(0, 10) <= w.date);

  // Security, point in time.
  const sec = bundle.security || {};
  let securityState = null;
  let criticalFail = false;
  if (sec.security) {
    if (backfilled) {
      securityState = (sec.points || []).find((pt) => pt.date === w.date)?.overallState || null;
    } else if (sec.status) {
      securityState = sec.status.overallState || null;
      const disabled = new Set(sec.status.disabled || []);
      criticalFail = (sec.failChecks || []).some((c) => (c.severity === 'critical' || c.severity === 'high') && !disabled.has(c.checkId));
    }
  }
  const s2Days = cfg?.factors?.S2?.days ?? 14;
  const runFrom = addDays(w.date, -s2Days);
  const runs = (sec.runs || []).filter((r) => r.at && r.at.slice(0, 10) > runFrom && r.at.slice(0, 10) <= w.date);

  // Connection freshness (S3): EmDash heartbeat or WordPress site-info sync age. Not known for past dates.
  let connection = { linked: false };
  if (!backfilled) {
    if (p.cmsType === 'EMDASH') {
      if (p.cmsRepairNeededAt || p.cmsDisconnectedAt) connection = { linked: true, broken: true, ageDays: null };
      else if (p.cmsLastSeenAt) connection = { linked: true, broken: false, ageDays: (now - new Date(p.cmsLastSeenAt).getTime()) / MS_DAY };
    } else if (p.wpUrl && p.wpSiteInfoSyncedAt) {
      connection = { linked: true, broken: false, ageDays: (now - new Date(p.wpSiteInfoSyncedAt).getTime()) / MS_DAY };
    } else if (p.wpUrl) {
      connection = { linked: true, broken: false, ageDays: null };
    }
  }

  return {
    date: w.date,
    windows: w,
    backfilled,
    gsc: { linked: !!p.gscSiteUrl && Array.isArray(bundle.gsc), stale: gscStale, newest: gscNewest, ...sums(d.gsc, gscW, GSC_FIELDS) },
    ga4: {
      linked: !!p.ga4PropertyId && Array.isArray(bundle.ga4),
      young: !ga4Oldest || dayDiff(ga4Oldest, w.anchor) < (cfg?.factors?.E1?.shortWindowUntilDays ?? 56),
      oldest: ga4Oldest,
      ...sums(d.ga4, w, GA4_FIELDS, { short: true }),
    },
    gmb: { linked: !!p.gmbLocationId && Array.isArray(bundle.gmb), ...sums(m.gmb, w, GMB_FIELDS) },
    leads: { linked: leadsEver, ...sums(m.leads, w, LEAD_FIELDS) },
    // R1 uses the stored profile rating when present (live scores only: the profile is today's, not a past date's).
    // R4 (GBP actions) stays native-only through `gmb.linked` above.
    reviews: {
      linked: hasGbpIdentity(p) && Array.isArray(bundle.reviews),
      list: reviews,
      profileRating: !backfilled && typeof p.gmbRating === 'number' ? p.gmbRating : null,
      profileCount: !backfilled && typeof p.gmbReviewsCount === 'number' ? p.gmbReviewsCount : null,
    },
    security: { linked: !!sec.security && (backfilled ? (sec.points || []).length > 0 : !!sec.status), state: securityState, criticalFail },
    backups: { linked: !!sec.backups, runs },
    connection,
    // R5 (live only) and A1 (point in time: runs finished on or before the score date).
    citations: { linked: Array.isArray(bundle.citations) && bundle.citations.length > 0, statuses: bundle.citations || [] },
    ai: {
      linked: Array.isArray(bundle.aiRuns),
      runs: (bundle.aiRuns || []).filter((r) => r.at && r.at.slice(0, 10) <= w.date),
    },
    // Config v3 proposal: V5 uses the same windows as GSC clicks (lag-anchored); S4 the last `days` crawl days ending
    // at the score date.
    bing: { linked: !!p.bingSiteUrl && Array.isArray(bundle.bing), ...sums(m.bing, w, BING_FIELDS) },
    bingCrawl: bingCrawlWindow(bundle, m.bingCrawl, w.date, cfg),
  };
}

const BING_FIELDS = ['clicks', 'impressions'];

/** S4 window: sums over (date − days, date]. Pure. */
function bingCrawlWindow(bundle, byDate, date, cfg) {
  const linked = !!bundle.project?.bingSiteUrl && Array.isArray(bundle.bingCrawl);
  if (!linked) return { linked: false, rows: 0, crawledPages: 0, errors: 0 };
  const days = cfg?.factors?.S4?.days ?? 7;
  const s = sumRange(byDate, { from: addDays(date, -(days - 1)), to: date }, ['crawledPages', 'errors']);
  return { linked: true, rows: s.rows, crawledPages: s.crawledPages, errors: s.errors };
}
