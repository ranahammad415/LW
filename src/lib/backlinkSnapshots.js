/**
 * Site metrics: monthly backlink / authority snapshot (docs/ledger/features/site-metrics.md).
 *
 * One DataForSEO Backlinks API `summary/live` call per project per month, through the shared client
 * (lib/dataforseo/client.js, DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD). The cost DataForSEO reports for each call is
 * stored on the snapshot (costUsd) and totalled in the job log: there is no other DataForSEO cost log in the repo.
 *
 * - The monthly job (index.js, leader only, 1st of the month 04:30 UTC) is off unless BACKLINKS_SNAPSHOT_ENABLED=true,
 *   is capped by BACKLINKS_MAX_PER_RUN, never retries, skips projects that already have an ok snapshot this month and
 *   stops at the first account-level error (credentials, balance, subscription, rate limit) or after 3 errors in a row.
 * - Target: Project.dataforseoDomain, else the host of Project.wpUrl (www. stripped).
 * - Client-facing views never name the vendor or show cost (costUsd is also in the client drop list of
 *   lib/redactSecrets.js).
 * - Health v2 reads the trend through the pure authorityTrend(rows).
 */
import { prisma } from './prisma.js';
import { postDataForSeo } from './dataforseo/client.js';

export const DFS_SUMMARY_PATH = '/v3/backlinks/summary/live';
export const BACKLINK_HISTORY_MONTHS = 12;
/** Manual refresh: one per project per hour (the DB row is the clock, so it holds across PM2 instances). */
export const BACKLINK_REFRESH_COOLDOWN_MS = 60 * 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

export function isBacklinkSnapshotEnabled(env = process.env) {
  return String(env.BACKLINKS_SNAPSHOT_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function backlinksMaxPerRun(env = process.env) {
  const n = Number.parseInt(env.BACKLINKS_MAX_PER_RUN ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 50;
}

export function hasDataForSeoCredentials(env = process.env) {
  return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
}

export function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** Normalize a domain or URL to a bare host (lowercase, no scheme/www/port/path). '' when it is not a public name. */
export function normalizeDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return HOST_RE.test(host) ? host : '';
}

export function backlinkTarget(project) {
  return normalizeDomain(project?.dataforseoDomain) || normalizeDomain(project?.wpUrl);
}

const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Account-level DataForSEO codes (auth, payment / balance, subscription, rate limit) and server errors stop the run. */
function isAccountLevel(code) {
  return (code >= 40100 && code < 40300) || code >= 50000;
}

/**
 * Parse a summary/live payload. Returns { ok: true, data, costUsd } | { ok: false, errorCode, accountLevel, costUsd }.
 */
export function parseDfsSummary(json) {
  const topCode = Number(json?.status_code);
  const task = json?.tasks?.[0];
  const costRaw = typeof task?.cost === 'number' ? task.cost : typeof json?.cost === 'number' ? json.cost : null;
  const costUsd = costRaw != null && Number.isFinite(costRaw) ? costRaw : null;
  if (topCode && topCode !== 20000) return { ok: false, errorCode: `DFS_${topCode}`, accountLevel: isAccountLevel(topCode), costUsd };
  if (!task) return { ok: false, errorCode: 'DFS_NO_TASK', accountLevel: false, costUsd };
  const taskCode = Number(task.status_code);
  if (taskCode && taskCode !== 20000) return { ok: false, errorCode: `DFS_${taskCode}`, accountLevel: isAccountLevel(taskCode), costUsd };
  const r = task.result?.[0];
  if (!r || typeof r !== 'object') return { ok: false, errorCode: 'DFS_NO_RESULT', accountLevel: false, costUsd };
  return {
    ok: true,
    costUsd,
    data: {
      rank: intOrNull(r.rank),
      backlinks: intOrNull(r.backlinks),
      referringDomains: intOrNull(r.referring_domains),
      referringMainDomains: intOrNull(r.referring_main_domains),
      // summary/live has no new/lost counts today; use them if DataForSEO ever adds them.
      newReferringDomains: intOrNull(r.new_referring_domains ?? r.referring_domains_new),
      lostReferringDomains: intOrNull(r.lost_referring_domains ?? r.referring_domains_lost),
      backlinksSpamScore: intOrNull(r.backlinks_spam_score),
      brokenBacklinks: intOrNull(r.broken_backlinks),
    },
  };
}

/** One summary/live call (no retry). HTTP / network failures are account-level (stop the run). */
export async function fetchBacklinkSummary(target, { post = postDataForSeo } = {}) {
  let json;
  try {
    json = await post(DFS_SUMMARY_PATH, [{ target, include_subdomains: true }]);
  } catch (err) {
    const m = String(err?.message || '').match(/DataForSEO (\d{3})/);
    return { ok: false, errorCode: m ? `HTTP_${m[1]}` : 'NETWORK', accountLevel: true, costUsd: null };
  }
  return parseDfsSummary(json);
}

/** new/lost from the net change against the previous ok snapshot when the summary does not carry them. */
export function fillNewLost(data, prev) {
  if (data.newReferringDomains != null || data.lostReferringDomains != null) return data;
  if (!prev || prev.referringDomains == null || data.referringDomains == null) return data;
  const delta = data.referringDomains - prev.referringDomains;
  return { ...data, newReferringDomains: Math.max(0, delta), lostReferringDomains: Math.max(0, -delta) };
}

/**
 * Snapshot one project for `month`. An error never overwrites an ok snapshot of the same month.
 * Returns { status: 'ok'|'error'|'skipped', errorCode?, accountLevel?, costUsd? }.
 */
export async function snapshotProject(project, { now = new Date(), post } = {}) {
  const target = backlinkTarget(project);
  if (!target) return { status: 'skipped', reason: 'NO_DOMAIN' };
  const month = monthKey(now);
  const r = await fetchBacklinkSummary(target, { post });
  const where = { projectId_month: { projectId: project.id, month } };
  if (r.ok) {
    const prev = await prisma.backlinkSnapshotMonthly.findFirst({
      where: { projectId: project.id, status: 'ok', month: { lt: month } },
      orderBy: { month: 'desc' },
      select: { referringDomains: true },
    });
    const data = { target, ...fillNewLost(r.data, prev), costUsd: r.costUsd, status: 'ok', errorCode: null, fetchedAt: now };
    await prisma.backlinkSnapshotMonthly.upsert({ where, create: { projectId: project.id, month, ...data }, update: data });
    return { status: 'ok', costUsd: r.costUsd };
  }
  const existing = await prisma.backlinkSnapshotMonthly.findUnique({ where, select: { status: true } });
  if (existing?.status !== 'ok') {
    const data = { target, status: 'error', errorCode: r.errorCode, costUsd: r.costUsd, fetchedAt: now };
    await prisma.backlinkSnapshotMonthly.upsert({ where, create: { projectId: project.id, month, ...data }, update: data });
  }
  return { status: 'error', errorCode: r.errorCode, accountLevel: r.accountLevel, costUsd: r.costUsd };
}

/** Monthly job. See the file header for the guards. */
export async function runBacklinkSnapshotJob({ log, now = new Date(), post, env = process.env } = {}) {
  if (!isBacklinkSnapshotEnabled(env)) return { skipped: 'disabled' };
  if (!hasDataForSeoCredentials(env)) return { skipped: 'no_credentials' };
  const cap = backlinksMaxPerRun(env);
  const month = monthKey(now);
  const projects = await prisma.project.findMany({
    where: {
      status: { in: ['ACTIVE', 'SETUP'] },
      client: { isActive: true },
      OR: [{ dataforseoDomain: { not: null } }, { wpUrl: { not: null } }],
    },
    select: { id: true, wpUrl: true, dataforseoDomain: true },
    orderBy: { id: 'asc' },
  });
  const ids = projects.map((p) => p.id);
  const doneRows = ids.length
    ? await prisma.backlinkSnapshotMonthly.findMany({ where: { projectId: { in: ids }, month, status: 'ok' }, select: { projectId: true } })
    : [];
  const done = new Set(doneRows.map((r) => r.projectId));
  const queue = projects.filter((p) => !done.has(p.id) && backlinkTarget(p)).slice(0, cap);

  const summary = { month, eligible: projects.length, alreadyDone: done.size, attempted: 0, ok: 0, errors: 0, stopped: null, costUsd: 0 };
  let inARow = 0;
  for (const p of queue) {
    summary.attempted += 1;
    let out;
    try {
      out = await snapshotProject(p, { now, post });
    } catch (err) {
      out = { status: 'error', errorCode: 'INTERNAL', accountLevel: false };
      log?.warn?.({ projectId: p.id, message: err?.message }, 'Backlink snapshot failed');
    }
    if (typeof out.costUsd === 'number') summary.costUsd += out.costUsd;
    if (out.status === 'ok') {
      summary.ok += 1;
      inARow = 0;
      continue;
    }
    if (out.status !== 'error') continue;
    summary.errors += 1;
    inARow += 1;
    if (out.accountLevel) {
      summary.stopped = out.errorCode;
      break;
    }
    if (inARow >= MAX_CONSECUTIVE_ERRORS) {
      summary.stopped = 'TOO_MANY_ERRORS';
      break;
    }
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

// ── Trend + views ───────────────────────────────────────────────────────────

/**
 * Pure trend of referring domains over snapshots (any order; error rows ignored). Compares the latest ok snapshot
 * with the previous ok one: flat when the change is within max(2, 2 %) of the previous value.
 * @returns {{ direction: 'up'|'down'|'flat'|'new'|'unknown', latest: number|null, previous: number|null, change: number|null, changePct: number|null }}
 */
export function authorityTrend(rows) {
  const ok = (rows || [])
    .filter((r) => r && (r.status == null || r.status === 'ok') && typeof r.referringDomains === 'number')
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
  if (!ok.length) return { direction: 'unknown', latest: null, previous: null, change: null, changePct: null };
  const latest = ok[ok.length - 1].referringDomains;
  if (ok.length === 1) return { direction: 'new', latest, previous: null, change: null, changePct: null };
  const previous = ok[ok.length - 2].referringDomains;
  const change = latest - previous;
  const changePct = previous > 0 ? Number(((change / previous) * 100).toFixed(1)) : null;
  const threshold = Math.max(2, previous * 0.02);
  const direction = Math.abs(change) <= threshold ? 'flat' : change > 0 ? 'up' : 'down';
  return { direction, latest, previous, change, changePct };
}

const STAFF_SELECT = {
  month: true, target: true, rank: true, backlinks: true, referringDomains: true, referringMainDomains: true,
  newReferringDomains: true, lostReferringDomains: true, backlinksSpamScore: true, brokenBacklinks: true, costUsd: true,
  status: true, errorCode: true, fetchedAt: true,
};

function sinceMonth(now, months) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  return monthKey(d);
}

const toNumber = (v) => (v == null ? null : Number(v));

/** Staff view: latest ok snapshot, the 12-month history (with cost) and the trend. */
export async function staffBacklinkView(project, { now = new Date(), env = process.env } = {}) {
  const rows = await prisma.backlinkSnapshotMonthly.findMany({
    where: { projectId: project.id, month: { gte: sinceMonth(now, BACKLINK_HISTORY_MONTHS) } },
    select: STAFF_SELECT,
    orderBy: { month: 'asc' },
  });
  const history = rows.map((r) => ({ ...r, costUsd: toNumber(r.costUsd) }));
  const ok = history.filter((r) => r.status === 'ok');
  return {
    enabled: isBacklinkSnapshotEnabled(env),
    configured: hasDataForSeoCredentials(env),
    target: backlinkTarget(project) || null,
    latest: ok[ok.length - 1] || null,
    lastError: history.length && history[history.length - 1].status !== 'ok' ? { month: history[history.length - 1].month, errorCode: history[history.length - 1].errorCode } : null,
    trend: authorityTrend(history),
    history,
  };
}

function clientSentence(trend) {
  const n = trend.latest;
  const sites = `${n.toLocaleString('en-US')} ${n === 1 ? 'website links' : 'websites link'} to you`;
  if (trend.direction === 'up') return `${sites}, up from ${trend.previous.toLocaleString('en-US')} last time we checked. More sites linking to you helps people find you on Google.`;
  if (trend.direction === 'down') return `${sites}, down from ${trend.previous.toLocaleString('en-US')} last time we checked. Some links come and go; we keep an eye on it.`;
  if (trend.direction === 'flat') return `${sites}, about the same as last time we checked.`;
  return `${sites}. We will show how this changes each month.`;
}

/**
 * Client view (allow-list): referring domains, a plain sentence and the monthly trend of referring domains.
 * No vendor name, cost, rank, spam score, target or error code.
 */
export async function clientAuthorityView(project, { now = new Date() } = {}) {
  const rows = await prisma.backlinkSnapshotMonthly.findMany({
    where: { projectId: project.id, status: 'ok', month: { gte: sinceMonth(now, BACKLINK_HISTORY_MONTHS) } },
    select: { month: true, referringDomains: true, status: true },
    orderBy: { month: 'asc' },
  });
  const trend = authorityTrend(rows);
  if (trend.latest == null) return { available: false };
  return {
    available: true,
    referringDomains: trend.latest,
    direction: trend.direction,
    sentence: clientSentence(trend),
    history: rows.filter((r) => typeof r.referringDomains === 'number').map((r) => ({ month: r.month, referringDomains: r.referringDomains })),
  };
}
