/**
 * Bing organic + local-pack ranks via DataForSEO (features/bing-webmaster.md §Bing ranks). Paid, OFF by default
 * (BING_RANK_ENABLED=true turns it on). Same standard-queue pattern as the Maps ranks (lib/localRank.js):
 *
 * - `POST /v3/serp/bing/organic/task_post` (normal priority 1, depth BING_RANK_DEPTH = 10 → one billed SERP) for every
 *   approved keyword with trackLocal, once per keyword per UTC day. The keyword-day is claimed with a BingSerpRankDaily
 *   row in status `pending` BEFORE the task is posted (unique keywordId+date), so it is never paid twice per day.
 * - The task is stored as a LocalRankTask of kind `bing`; the existing collector (collectLocalRankTasks, leader, every
 *   10 min, free task_get) reads `/v3/serp/bing/organic/task_get/advanced/{id}` and fills the row.
 * - organicRank = rank_group of the first organic item on the client's registrable domain; localPackRank = 1-based
 *   position among Bing's local-pack items, matched by business name + website domain (no CID on Bing):
 *   matchedBy 'name_domain' (both) or 'weak' (domain only, or name only when the item has no website).
 * - Caps: BING_RANK_MAX_PER_RUN tasks per run, BING_RANK_MAX_PER_PROJECT keywords per project, stop at an account-level
 *   DataForSEO error, no retries. The DataForSEO `cost` of every post is stored (costUsd, staff only).
 */
import { prisma } from '../prisma.js';
import { dfsPostTask, dfsGetTask, hasDataForSeoCreds } from '../dataforseo/client.js';
import { locationCode as dfsLocationCode, languageCode as dfsLanguageCode } from '../omniSearch/businessDataProvider.js';
import { projectSiteDomain } from '../analytics/gbpIdentity.js';
import { sameSite } from '../analytics/domainMatch.js';
import { TRACKED_KEYWORD_STATUSES } from '../analytics/keywordStatus.js';

export const DFS_BING_TASK_POST_PATH = '/v3/serp/bing/organic/task_post';
export const DFS_BING_TASK_GET_PATH = '/v3/serp/bing/organic/task_get/advanced';
/** Standard queue, normal priority: $0.0006 per SERP of 10 results (DataForSEO Bing SERP pricing; verify `cost`). */
export const BING_RANK_EST_COST_USD = 0.0006;
const MS_DAY = 86_400_000;

const bool = (v, def) => String(v ?? def).toLowerCase() === 'true';
function intEnv(env, name, def, min, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const isBingRankEnabled = (env = process.env) => bool(env.BING_RANK_ENABLED, 'false');
export const bingRankMaxPerRun = (env = process.env) => intEnv(env, 'BING_RANK_MAX_PER_RUN', 100, 1, 5000);
export const bingRankMaxPerProject = (env = process.env) => intEnv(env, 'BING_RANK_MAX_PER_PROJECT', 20, 1, 200);
export const bingRankDepth = (env = process.env) => intEnv(env, 'BING_RANK_DEPTH', 10, 10, 100);

export function utcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Project fields this module reads. */
export const BING_RANK_PROJECT_SELECT = Object.freeze({
  id: true,
  name: true,
  clientId: true,
  wpUrl: true,
  dataforseoDomain: true,
  gmbLocationName: true,
  localLocationCode: true,
  localLanguageCode: true,
  client: { select: { websiteUrl: true, agencyName: true } },
});

/** Approved keywords with trackLocal (the same set as the Maps ranks). */
export function bingKeywordWhere(projectId) {
  return { projectId, trackLocal: true, status: { in: [...TRACKED_KEYWORD_STATUSES] } };
}

/** → null | 'NO_DOMAIN'. A Bing rank needs the client's website domain to match organic results. */
export function bingRankBlocker(project) {
  return projectSiteDomain(project) ? null : 'NO_DOMAIN';
}

/** Task body for one Bing organic check. Pure. */
export function bingTaskBody(project, keyword, env = process.env) {
  return {
    keyword: String(keyword).slice(0, 700),
    location_code: dfsLocationCode(project, env),
    language_code: dfsLanguageCode(project),
    depth: bingRankDepth(env),
  };
}

const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Bing organic advanced items → { status, organicRank, organicUrl, localPackRank, localPackPresent, matchedBy }. Pure.
 */
export function bingRankResultFromItems(project, items) {
  const siteDomain = projectSiteDomain(project);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const organic = list.find((i) => i.type === 'organic' && siteDomain && sameSite(i.url || i.domain || '', siteDomain));
  const pack = list.filter((i) => i.type === 'local_pack' && !i.is_paid);
  const name = normTitle(project?.gmbLocationName || project?.client?.agencyName || '');
  let localPackRank = null;
  let matchedBy = null;
  for (let i = 0; i < pack.length; i += 1) {
    const it = pack[i];
    const site = it.url || it.domain || '';
    const domainOk = !!siteDomain && !!site && sameSite(site, siteDomain);
    const t = normTitle(it.title);
    const nameOk = !!name && !!t && (t === name || t.includes(name) || name.includes(t));
    if (domainOk && nameOk) {
      localPackRank = i + 1;
      matchedBy = 'name_domain';
      break;
    }
    if (localPackRank == null && (domainOk || (nameOk && !site))) {
      localPackRank = i + 1;
      matchedBy = 'weak';
    }
  }
  const organicRank = organic ? organic.rank_group ?? organic.rank_absolute ?? null : null;
  return {
    status: organicRank != null || localPackRank != null ? 'ok' : 'not_found',
    organicRank,
    organicUrl: organic?.url ? String(organic.url).slice(0, 1000) : null,
    localPackRank,
    localPackPresent: pack.length > 0,
    matchedBy,
  };
}

/** Post one standard-queue task. Never throws for DataForSEO errors. */
export async function postBingTask(project, keyword, { post, env = process.env } = {}) {
  const body = bingTaskBody(project, keyword, env);
  try {
    const parsed = await dfsPostTask(DFS_BING_TASK_POST_PATH, { ...body, priority: 1 }, { post });
    const taskId = parsed.task?.id ? String(parsed.task.id) : null;
    if (!taskId || !/^[\w-]{8,64}$/.test(taskId)) return { status: 'error', errorCode: 'NO_TASK_ID', accountLevel: false, costUsd: parsed.costUsd ?? null, depth: body.depth };
    return { status: 'posted', taskId, costUsd: parsed.costUsd ?? null, depth: body.depth };
  } catch (err) {
    return { status: 'error', errorCode: String(err?.code || 'FAILED').slice(0, 40), accountLevel: !!err?.accountLevel, costUsd: err?.costUsd ?? null, depth: body.depth };
  }
}

/** One free task_get. → { state: 'pending' } | { state: 'done', items } | { state: 'failed', errorCode, accountLevel } */
export async function getBingTask(taskId, { get } = {}) {
  if (!/^[\w-]{8,64}$/.test(String(taskId || ''))) return { state: 'failed', errorCode: 'BAD_TASK_ID', accountLevel: false };
  try {
    const parsed = await dfsGetTask(`${DFS_BING_TASK_GET_PATH}/${taskId}`, { get });
    if (parsed.state === 'pending') return { state: 'pending' };
    if (parsed.state === 'no_results') return { state: 'done', items: [] };
    if (!parsed.result) return { state: 'pending' };
    return { state: 'done', items: parsed.result.items || [] };
  } catch (err) {
    return { state: 'failed', errorCode: String(err?.code || 'FAILED').slice(0, 40), accountLevel: !!err?.accountLevel };
  }
}

/** Claim a keyword-day (an `error` row is taken over; else a new `pending` row). → true when this caller owns it. */
export async function claimBingRow(projectId, keywordId, date, now = new Date()) {
  const upd = await prisma.bingSerpRankDaily.updateMany({ where: { keywordId, date, status: 'error' }, data: { status: 'pending', errorCode: null, fetchedAt: now } });
  if (upd?.count) return true;
  try {
    await prisma.bingSerpRankDaily.create({ data: { projectId, keywordId, date, status: 'pending', fetchedAt: now } });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

/** Store a collected result on its pending row (never overwrites an ok / not_found row). Used by the collector. */
export async function storeCollectedBing(task, r, now = new Date()) {
  await prisma.bingSerpRankDaily.updateMany({
    where: { keywordId: task.keywordId, date: task.date, status: 'pending' },
    data: {
      organicRank: r.status === 'ok' ? r.organicRank ?? null : null,
      organicUrl: r.status === 'ok' ? r.organicUrl ?? null : null,
      localPackRank: r.status === 'ok' ? r.localPackRank ?? null : null,
      localPackPresent: !!r.localPackPresent,
      matchedBy: r.matchedBy || null,
      status: r.status,
      errorCode: r.status === 'error' ? r.errorCode || 'FAILED' : null,
      fetchedAt: now,
    },
  });
}

/**
 * Post a task for every due keyword of one project within `budget` (≤ BING_RANK_MAX_PER_PROJECT keywords). A keyword
 * already done or pending today is skipped. → { projectId, checked, posted, errors, costUsd, stopped, skipped? }
 */
export async function runBingRankForProject(project, { now = new Date(), budget = bingRankMaxPerRun(), post, env = process.env } = {}) {
  const out = { projectId: project.id, checked: 0, posted: 0, errors: 0, costUsd: 0, stopped: null };
  const blocker = bingRankBlocker(project);
  if (blocker) return { ...out, skipped: blocker };
  const keywords = await prisma.keywordTrack.findMany({
    where: bingKeywordWhere(project.id),
    select: { id: true, keyword: true },
    orderBy: { keyword: 'asc' },
    take: bingRankMaxPerProject(env),
  });
  if (!keywords.length) return { ...out, skipped: 'NO_KEYWORDS' };
  const date = utcDay(now);
  const rows = await prisma.bingSerpRankDaily.findMany({
    where: { projectId: project.id, date, status: { in: ['ok', 'not_found', 'pending'] } },
    select: { keywordId: true },
  });
  const done = new Set((rows || []).map((r) => r.keywordId));
  for (const k of keywords) {
    if (done.has(k.id)) continue;
    if (out.checked >= budget) {
      out.stopped = 'CAP';
      break;
    }
    if (!(await claimBingRow(project.id, k.id, date, now))) continue;
    const r = await postBingTask(project, k.keyword, { post, env });
    out.checked += 1;
    if (typeof r.costUsd === 'number') out.costUsd += r.costUsd;
    if (r.status === 'posted') {
      await prisma.localRankTask.create({
        data: { projectId: project.id, keywordId: k.id, kind: 'bing', date, taskId: r.taskId, locationMode: 'location_code', depth: r.depth, status: 'pending', postedAt: now, costUsd: r.costUsd ?? null },
      });
      await prisma.bingSerpRankDaily.updateMany({ where: { keywordId: k.id, date, status: 'pending' }, data: { costUsd: r.costUsd ?? null, depth: r.depth } });
      out.posted += 1;
    } else {
      await prisma.bingSerpRankDaily.updateMany({
        where: { keywordId: k.id, date, status: 'pending' },
        data: { status: 'error', errorCode: r.errorCode || 'FAILED', costUsd: r.costUsd ?? null },
      });
      out.errors += 1;
      if (r.accountLevel) {
        out.stopped = r.errorCode;
        break;
      }
    }
  }
  out.costUsd = Number(out.costUsd.toFixed(5));
  return out;
}

/** Daily job (leader only; the caller checks isLeader()). Off unless BING_RANK_ENABLED=true. */
export async function runBingRankJob({ now = new Date(), log = console, env = process.env, post } = {}) {
  if (!isBingRankEnabled(env)) return { skipped: 'DISABLED' };
  if (!post && !hasDataForSeoCreds(env)) return { skipped: 'NO_CREDS' };
  const projects = await prisma.project.findMany({
    where: { status: { in: ['ACTIVE', 'SETUP'] }, client: { isActive: true }, trackedKeywords: { some: { trackLocal: true } } },
    select: BING_RANK_PROJECT_SELECT,
  });
  let budget = bingRankMaxPerRun(env);
  const summary = { projects: projects.length, checked: 0, posted: 0, errors: 0, costUsd: 0, stopped: null, skipped: 0 };
  for (const p of projects) {
    if (budget <= 0) {
      summary.stopped = 'CAP';
      break;
    }
    const r = await runBingRankForProject(p, { now, budget, post, env });
    if (r.skipped) summary.skipped += 1;
    summary.checked += r.checked;
    summary.posted += r.posted;
    summary.errors += r.errors;
    summary.costUsd += r.costUsd;
    budget -= r.checked;
    if (r.stopped === 'CAP') summary.stopped = 'CAP';
    if (r.stopped && r.stopped !== 'CAP') {
      summary.stopped = r.stopped;
      log?.warn?.({ projectId: p.id, code: r.stopped }, 'Bing rank run stopped on an account-level DataForSEO error');
      break;
    }
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

/** Staff view of the Bing ranks of one project (latest per keyword, 30-day spend). costUsd is staff only. */
export async function staffBingRankView(project, { now = new Date() } = {}) {
  const from = utcDay(new Date(now.getTime() - 90 * MS_DAY));
  const [keywords, rows] = await Promise.all([
    prisma.keywordTrack.findMany({ where: bingKeywordWhere(project.id), select: { id: true, keyword: true }, orderBy: { keyword: 'asc' }, take: 200 }),
    prisma.bingSerpRankDaily.findMany({
      where: { projectId: project.id, date: { gte: from } },
      select: { keywordId: true, date: true, organicRank: true, localPackRank: true, localPackPresent: true, matchedBy: true, status: true, errorCode: true, costUsd: true, fetchedAt: true },
      orderBy: { date: 'asc' },
    }),
  ]);
  const byKw = new Map();
  for (const r of rows || []) {
    if (!byKw.has(r.keywordId)) byKw.set(r.keywordId, []);
    byKw.get(r.keywordId).push(r);
  }
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const spent30dUsd = (rows || [])
    .filter((r) => new Date(r.fetchedAt).getTime() >= now.getTime() - 30 * MS_DAY)
    .reduce((s, r) => s + (r.costUsd != null ? Number(r.costUsd) : 0), 0);
  return {
    enabled: isBingRankEnabled(),
    blocker: bingRankBlocker(project),
    keywords: (keywords || []).map((k) => {
      const hist = byKw.get(k.id) || [];
      const latest = [...hist].reverse().find((h) => h.status === 'ok' || h.status === 'not_found') || null;
      const last = hist[hist.length - 1] || null;
      return {
        id: k.id,
        keyword: k.keyword,
        latest: latest
          ? { date: iso(latest.date), organicRank: latest.organicRank, localPackRank: latest.localPackRank, localPackPresent: latest.localPackPresent, matchedBy: latest.matchedBy }
          : null,
        pending: last?.status === 'pending',
        lastError: last?.status === 'error' ? last.errorCode : null,
      };
    }),
    cost: {
      perCallUsd: BING_RANK_EST_COST_USD,
      dailyChecks: Math.min((keywords || []).length, bingRankMaxPerProject()),
      monthlyUsd: Number((Math.min((keywords || []).length, bingRankMaxPerProject()) * 30 * BING_RANK_EST_COST_USD).toFixed(4)),
      spent30dUsd: Number(spent30dUsd.toFixed(4)),
    },
  };
}
