/**
 * Health score v2 service: per-project daily score, client rollup, the 07:00 daily run, recomputes and backfill.
 * docs/ledger/features/health-score.md.
 *
 * - One HealthScoreDaily row per project per UTC day (upsert on projectId_date: idempotent, safe to re-run).
 * - The client rollup (ClientHealthDaily + ClientAccount.healthScore/healthCoverage/healthTrend28/healthComputedAt)
 *   weights each ACTIVE/PAUSED project by w_p = 1 + log10(1 + clicks28 + sessions28).
 * - Missing data is never 50 and never a penalty: null factors/pillars are left out and lower the coverage.
 * - CPU and DB only: no AI or paid API call anywhere in here.
 */
import { prisma } from '../prisma.js';
import { getActiveConfig, PILLARS } from './healthConfig.js';
import { loadHealthBundle, sliceBundle, HEALTH_PROJECT_SELECT } from './healthBundle.js';
import { computeFactors } from './healthFactors.js';
import { pillarScore, renormalize, addDays, todayUtc, isNum } from './healthMath.js';
import { hasGbpIdentity } from '../analytics/gmbIdentifier.js';

export const ROLLUP_STATUSES = ['ACTIVE', 'PAUSED'];
export const SCORED_STATUSES = ['ACTIVE', 'PAUSED', 'SETUP'];
export const DEFAULT_BACKFILL_MAX_DAYS = 90;

export function isHealthEnabled(env = process.env) {
  return String(env.HEALTH_SCORE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function backfillMaxDays(env = process.env) {
  const n = Number(env.HEALTH_BACKFILL_MAX_DAYS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 400) : DEFAULT_BACKFILL_MAX_DAYS;
}

/** Scoring profile from the project type; null = not scored (social media, one-off). */
export function profileFor(project) {
  switch (project?.projectType) {
    case 'AEO_GEO_CAMPAIGN':
      return 'AEO';
    case 'SEO_CAMPAIGN':
      // LOCAL when the project has a GBP identity: native location, CID or place_id (features/local-seo.md).
      return hasGbpIdentity(project) ? 'LOCAL' : 'SEO';
    case 'WEBSITE_DESIGN':
    case 'WEBSITE_DEVELOPMENT':
      return 'WEBSITE';
    default:
      return null;
  }
}

/**
 * Pillar scores from factor results and the project score from pillars (pure).
 * pillars = { <pillar>: { score, weight, scored, total } } for all seven pillars.
 */
export function scoreFromFactors(factors, profile, cfg) {
  const weights = cfg.profiles[profile];
  const pillars = {};
  const pillarScores = {};
  for (const p of PILLARS) {
    const fs = factors.filter((f) => f.pillar === p);
    const s = fs.length ? pillarScore(fs, cfg.pillarFloor) : null;
    pillars[p] = { score: s, weight: weights[p] ?? 0, scored: fs.filter((f) => f.score != null).length, total: fs.length };
    pillarScores[p] = s;
  }
  const r = renormalize(pillarScores, weights, cfg);
  return { pillars, score: r.score, rawScore: r.rawScore, coverage: r.coverage, scoredPillars: r.scoredPillars };
}

/** Pillar-level scoring (the worked example in the ledger uses this directly). */
export function scoreFromPillars(pillarScores, profile, cfg) {
  return renormalize(pillarScores, cfg.profiles[profile], cfg);
}

/**
 * Compute one project's HealthScoreDaily payload for `dateStr` (pure once the bundle is loaded).
 * `base28` is the stored score 28 days earlier (for trend28), if any.
 */
export function computeProjectHealth(project, dateStr, { bundle, config, backfilled = false, now = Date.now(), base28 = null }) {
  const profile = profileFor(project);
  if (!profile) return null;
  const slice = sliceBundle(bundle, dateStr, config, { backfilled, now });
  const factors = computeFactors(slice, config);
  const { pillars, score, coverage } = scoreFromFactors(factors, profile, config);
  return {
    projectId: project.id,
    date: dateStr,
    score,
    coverage,
    profile,
    configVersion: config.version,
    pillars,
    factors,
    trend28: isNum(score) && isNum(base28) ? score - base28 : null,
    backfilled,
  };
}

async function upsertProjectRow(payload) {
  const data = {
    score: payload.score,
    coverage: payload.coverage,
    profile: payload.profile,
    configVersion: payload.configVersion,
    pillars: payload.pillars,
    factors: payload.factors,
    trend28: payload.trend28,
    backfilled: payload.backfilled,
    computedAt: new Date(),
  };
  return prisma.healthScoreDaily.upsert({
    where: { projectId_date: { projectId: payload.projectId, date: payload.date } },
    update: data,
    create: { projectId: payload.projectId, date: payload.date, ...data },
  });
}

async function storedScore(projectId, date) {
  const row = await prisma.healthScoreDaily.findUnique({ where: { projectId_date: { projectId, date } }, select: { score: true } });
  return row?.score ?? null;
}

/** Compute and store today's (or `date`'s) row for one project. */
export async function computeAndStoreProject(project, date, { config, now = Date.now() } = {}) {
  const cfg = config || (await getActiveConfig());
  if (!profileFor(project)) return null;
  const bundle = await loadHealthBundle(project, { from: date, to: date, cfg });
  const base28 = await storedScore(project.id, addDays(date, -28));
  const payload = computeProjectHealth(project, date, { bundle, config: cfg, now, base28 });
  await upsertProjectRow(payload);
  return payload;
}

// ── client rollup ──

/** Project weight in the client rollup: 1 + log10(1 + clicks28 + sessions28) from the row's V1 / E1 raw values. */
export function projectWeight(row) {
  const f = Array.isArray(row?.factors) ? row.factors : [];
  const clicks = Number(f.find((x) => x.key === 'V1')?.raw?.cur) || 0;
  const sessions = Number(f.find((x) => x.key === 'E1')?.raw?.cur) || 0;
  return 1 + Math.log10(1 + Math.max(0, clicks) + Math.max(0, sessions));
}

/** Pure rollup of project rows → { score, coverage, pillars, projectWeights }. */
export function rollupRows(rows) {
  const projectWeights = rows.map((r) => ({ projectId: r.projectId, weight: Math.round(projectWeight(r) * 1000) / 1000, score: r.score ?? null, coverage: r.coverage ?? 0 }));
  const sumW = projectWeights.reduce((t, p) => t + p.weight, 0);
  const scored = projectWeights.filter((p) => isNum(p.score));
  const sumScoredW = scored.reduce((t, p) => t + p.weight, 0);
  const score = sumScoredW > 0 ? Math.round(scored.reduce((t, p) => t + p.weight * p.score, 0) / sumScoredW) : null;
  const coverage = sumW > 0 ? Math.round(projectWeights.reduce((t, p) => t + p.weight * p.coverage, 0) / sumW) : 0;
  const pillars = {};
  for (const pillar of PILLARS) {
    let num = 0;
    let den = 0;
    let covNum = 0;
    let covDen = 0;
    rows.forEach((r, i) => {
      const p = r.pillars?.[pillar];
      const w = projectWeights[i].weight;
      if (p && p.total > 0 && p.weight > 0) {
        covNum += w * (100 * (p.scored || 0)) / p.total;
        covDen += w;
      }
      if (!isNum(p?.score)) return;
      num += w * p.score;
      den += w;
    });
    pillars[pillar] = { score: den > 0 ? Math.round(num / den) : null, coverage: covDen > 0 ? Math.round(covNum / covDen) : 0 };
  }
  return { score, coverage, pillars, projectWeights };
}

/**
 * Roll the client's ACTIVE/PAUSED project rows for `dateStr` up into ClientHealthDaily. With `updateAccount`
 * (today's run) ClientAccount.healthScore/healthCoverage/healthTrend28/healthComputedAt are set too.
 */
export async function rollupClient(clientId, dateStr, config, { updateAccount = true } = {}) {
  const cfg = config || (await getActiveConfig());
  const rows = await prisma.healthScoreDaily.findMany({
    where: { date: dateStr, project: { clientId, status: { in: ROLLUP_STATUSES } } },
    select: { projectId: true, score: true, coverage: true, pillars: true, factors: true },
  });
  const r = rollupRows(rows);
  const base = await prisma.clientHealthDaily.findUnique({ where: { clientId_date: { clientId, date: addDays(dateStr, -28) } }, select: { score: true } });
  const trend28 = isNum(r.score) && isNum(base?.score) ? r.score - base.score : null;
  if (rows.length) {
    const data = { score: r.score, coverage: r.coverage, pillars: r.pillars, projectWeights: r.projectWeights, configVersion: cfg.version, trend28, computedAt: new Date() };
    await prisma.clientHealthDaily.upsert({
      where: { clientId_date: { clientId, date: dateStr } },
      update: data,
      create: { clientId, date: dateStr, ...data },
    });
  }
  if (updateAccount) {
    await prisma.clientAccount.update({
      where: { id: clientId },
      data: { healthScore: r.score, healthCoverage: rows.length ? r.coverage : null, healthTrend28: trend28, healthComputedAt: new Date() },
    });
  }
  return { clientId, date: dateStr, score: r.score, coverage: r.coverage, trend28, projects: rows.length };
}

// ── daily run ──

/**
 * The 07:00 job (leader only, see index.js). Scores every ACTIVE/PAUSED/SETUP project with a profile, one project
 * at a time (a failing project is logged and skipped), then rolls up every affected client and runs the alerts.
 * @returns {{ date, projects, clients, errors, skipped }}
 */
export async function runHealthScoreDaily({ log, date = todayUtc(), env = process.env, now = Date.now(), alerts = true } = {}) {
  if (!isHealthEnabled(env)) return { date, disabled: true, projects: 0, clients: 0, errors: [], skipped: 0 };
  const config = await getActiveConfig();
  const projects = await prisma.project.findMany({ where: { status: { in: SCORED_STATUSES } }, select: HEALTH_PROJECT_SELECT });
  let done = 0;
  let skipped = 0;
  const errors = [];
  const clientIds = new Set();
  for (const project of projects) {
    if (!profileFor(project)) {
      skipped += 1;
      continue;
    }
    try {
      await computeAndStoreProject(project, date, { config, now });
      done += 1;
      clientIds.add(project.clientId);
    } catch (err) {
      errors.push({ projectId: project.id, message: String(err?.message || err).slice(0, 200) });
      log?.warn?.({ projectId: project.id, err: err?.message }, 'Health score: project failed');
    }
  }
  let clients = 0;
  for (const clientId of clientIds) {
    try {
      await rollupClient(clientId, date, config);
      clients += 1;
    } catch (err) {
      errors.push({ clientId, message: String(err?.message || err).slice(0, 200) });
      log?.warn?.({ clientId, err: err?.message }, 'Health score: client rollup failed');
    }
  }
  // Values left by the retired task-based score (never computed by v2) must not read as a v2 score.
  await prisma.clientAccount.updateMany({ where: { healthComputedAt: null, healthScore: { not: null } }, data: { healthScore: null } }).catch(() => null);
  let alertResult = null;
  if (alerts) {
    try {
      const { evaluateHealthAlerts } = await import('./healthAlerts.js');
      alertResult = await evaluateHealthAlerts(date, config, { log, clientIds: [...clientIds] });
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') log?.warn?.({ err: err?.message }, 'Health score: alerts failed');
    }
  }
  return { date, configVersion: config.version, projects: done, clients, errors, skipped, alerts: alertResult };
}

/** Recompute today's row for one project and its client rollup. Returns the stored payload (or null). */
export async function recomputeProject(projectId, { now = Date.now() } = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: HEALTH_PROJECT_SELECT });
  if (!project) return null;
  const config = await getActiveConfig();
  const date = todayUtc(new Date(now));
  const payload = await computeAndStoreProject(project, date, { config, now });
  await rollupClient(project.clientId, date, config);
  return payload;
}

/** Recompute today's rows for every scored project of a client, then its rollup. */
export async function recomputeClient(clientId, { now = Date.now() } = {}) {
  const config = await getActiveConfig();
  const date = todayUtc(new Date(now));
  const projects = await prisma.project.findMany({ where: { clientId, status: { in: SCORED_STATUSES } }, select: HEALTH_PROJECT_SELECT });
  let recomputed = 0;
  for (const p of projects) {
    if (await computeAndStoreProject(p, date, { config, now })) recomputed += 1;
  }
  const rollup = await rollupClient(clientId, date, config);
  return { recomputed, rollup };
}

/** Recompute today for every scored project (after a config change). */
export async function recomputeAll({ log, now = Date.now() } = {}) {
  return runHealthScoreDaily({ log, date: todayUtc(new Date(now)), now, alerts: false });
}

/**
 * Backfill up to `days` past days (yesterday back) for one project from one bundle load. Dates that already
 * have a live (non-backfilled) row are kept. Security uses that day's SecurityDailyPoint; S3 is not scored.
 * Then the client rollup for each date (ClientAccount is not touched: the live row stays the current one).
 */
export async function backfillProject(projectId, { days = DEFAULT_BACKFILL_MAX_DAYS, env = process.env, now = Date.now(), config } = {}) {
  const cap = backfillMaxDays(env);
  const n = Math.max(1, Math.min(Number(days) || cap, cap));
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: HEALTH_PROJECT_SELECT });
  if (!project || !profileFor(project)) return { projectId, rows: 0, kept: 0, skipped: true };
  const cfg = config || (await getActiveConfig());
  const today = todayUtc(new Date(now));
  const from = addDays(today, -n);
  const to = addDays(today, -1);
  const bundle = await loadHealthBundle(project, { from, to, cfg });
  const existing = await prisma.healthScoreDaily.findMany({
    where: { projectId, date: { gte: addDays(from, -28), lte: today } },
    select: { date: true, score: true, backfilled: true },
  });
  const scores = new Map(existing.map((r) => [r.date, r.score]));
  const live = new Set(existing.filter((r) => !r.backfilled).map((r) => r.date));
  let rows = 0;
  let kept = 0;
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (live.has(d)) {
      kept += 1;
      continue;
    }
    const payload = computeProjectHealth(project, d, { bundle, config: cfg, backfilled: true, now, base28: scores.get(addDays(d, -28)) ?? null });
    await upsertProjectRow(payload);
    scores.set(d, payload.score);
    dates.push(d);
    rows += 1;
  }
  for (const d of dates) await rollupClient(project.clientId, d, cfg, { updateAccount: false });
  return { projectId, rows, kept, days: n };
}
