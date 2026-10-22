/**
 * Health score v2 response shapes. docs/ledger/features/health-score.md §API.
 *
 * CLIENT (`clientHealthView`): an allow-list built field by field, never a spread of a stored row. Score, band,
 * client label, coverage, arrow, one tile per pillar, the site pillar in WORDS only (state + backups; never a
 * number, a check id or a security score, owner decision O-4), fixed sentences and a 90-day history.
 * Never factors, raw values, weights, config or notes.
 *
 * STAFF (`staffHealthView`, `staffClientHealth`): everything, factors as `healthFactors` (that key is dropped from
 * every client-audience response by lib/redactSecrets.js as a second layer).
 */
import { prisma } from '../prisma.js';
import { getActiveConfig, PILLARS } from './healthConfig.js';
import { bandFor, trendArrow, addDays, todayUtc, isNum } from './healthMath.js';
import { PILLAR_LABELS, FACTOR_LABELS, clientSentences, contributions, explainChange } from './healthExplain.js';
import { ROLLUP_STATUSES } from './healthScoreService.js';

export const BAND_LABELS = Object.freeze({
  excellent: { label: 'Excellent', clientLabel: 'Thriving' },
  healthy: { label: 'Healthy', clientLabel: 'On track' },
  at_risk: { label: 'At risk', clientLabel: 'Needs attention' },
  critical: { label: 'Critical', clientLabel: 'Needs urgent attention' },
});

export const HISTORY_DAYS = 90;
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function bandInfo(score, cfg) {
  const band = bandFor(score, cfg?.bands);
  return { band, label: band ? BAND_LABELS[band].label : null, clientLabel: band ? BAND_LABELS[band].clientLabel : null };
}

const STATE_RANK = { fail: 3, warn: 2, ok: 1, unknown: 0 };

/** Site pillar in words, from S1/S2 results of one or more projects. */
export function siteWords(factors) {
  let state = null;
  let backups = 'unknown';
  for (const f of factors || []) {
    if (f?.key === 'S1' && f.reason !== 'unlinked') {
      const s = ['ok', 'warn', 'fail'].includes(f.raw?.cur) ? f.raw.cur : 'unknown';
      if (state == null || STATE_RANK[s] > STATE_RANK[state]) state = s;
    }
    if (f?.key === 'S2' && isNum(f.score)) {
      if (f.raw?.cur > 0) backups = 'missed';
      else if (backups !== 'missed') backups = 'ok';
    }
  }
  return { state: state || 'unknown', backups };
}

/**
 * Pure: the client view. `pillars` = { <pillar>: { score, coverage? } }; `factors` = factor results used only to
 * build sentences and the site words (never copied out).
 */
export function clientHealthView({ score, coverage, trend28, computedAt, pillars, factors, history }, cfg) {
  const b = bandInfo(score, cfg);
  const site = siteWords(factors);
  return {
    available: true,
    score: isNum(score) ? score : null,
    band: b.band,
    label: b.clientLabel,
    coverage: isNum(coverage) ? coverage : 0,
    trend28: isNum(trend28) ? trend28 : null,
    arrow: trendArrow(trend28, cfg?.trendArrowDelta ?? 3),
    computedAt: iso(computedAt),
    pillars: PILLARS.map((key) => {
      const label = PILLAR_LABELS[key].client;
      if (key === 'site') return { key, label, state: site.state, backups: site.backups };
      const p = pillars?.[key] || {};
      const s = isNum(p.score) ? p.score : null;
      return { key, label, score: s, band: bandFor(s, cfg?.bands), coverage: isNum(p.coverage) ? p.coverage : null };
    }),
    ...clientSentences(factors, { limit: 3 }),
    history: (history || []).map((h) => ({ date: String(h.date), score: isNum(h.score) ? h.score : null })),
  };
}

/** Project pillar coverage (% of the pillar's factors that scored) for the client tiles. */
function projectPillars(row) {
  const out = {};
  for (const [k, p] of Object.entries(row?.pillars || {})) {
    out[k] = { score: p?.score ?? null, coverage: p?.total > 0 ? Math.round((100 * (p.scored || 0)) / p.total) : 0 };
  }
  return out;
}

async function history(model, where, days = HISTORY_DAYS) {
  const from = addDays(todayUtc(), -days);
  return prisma[model].findMany({ where: { ...where, date: { gte: from } }, select: { date: true, score: true }, orderBy: { date: 'asc' } });
}

/** /api/client/health: the client rollup (latest day) + today's ACTIVE/PAUSED project factors for the sentences. */
export async function loadClientHealthView(clientId) {
  const cfg = await getActiveConfig();
  const latest = await prisma.clientHealthDaily.findFirst({ where: { clientId }, orderBy: { date: 'desc' } });
  if (!latest) return { available: false };
  const [rows, hist] = await Promise.all([
    prisma.healthScoreDaily.findMany({ where: { date: latest.date, project: { clientId, status: { in: ROLLUP_STATUSES } } }, select: { factors: true } }),
    history('clientHealthDaily', { clientId }),
  ]);
  const factors = rows.flatMap((r) => (Array.isArray(r.factors) ? r.factors : []));
  return clientHealthView({ ...latest, factors, history: hist }, cfg);
}

/** /api/client/projects/:id/health: one project's latest row. */
export async function loadProjectClientView(projectId) {
  const cfg = await getActiveConfig();
  const latest = await prisma.healthScoreDaily.findFirst({ where: { projectId }, orderBy: { date: 'desc' } });
  if (!latest) return { available: false };
  const hist = await history('healthScoreDaily', { projectId });
  return clientHealthView({ ...latest, pillars: projectPillars(latest), factors: latest.factors, history: hist }, cfg);
}

// ── staff ──

/** Pure: the staff view of one project row (factors as healthFactors, with labels and contributions). */
export function staffHealthView(row, { cfg, historyRows = [], explain = [], compare = 28 } = {}) {
  if (!row) return { row: null, profile: null, config: { version: cfg?.version ?? null }, history: historyRows, explain: [], compare };
  const contrib = contributions(row);
  const b = bandInfo(row.score, cfg);
  return {
    row: {
      date: row.date,
      score: row.score,
      band: b.band,
      label: b.label,
      coverage: row.coverage,
      profile: row.profile,
      configVersion: row.configVersion,
      trend28: row.trend28,
      arrow: trendArrow(row.trend28, cfg?.trendArrowDelta ?? 3),
      backfilled: !!row.backfilled,
      computedAt: iso(row.computedAt),
      pillars: PILLARS.map((key) => ({ key, label: PILLAR_LABELS[key].staff, ...(row.pillars?.[key] || { score: null, weight: 0, scored: 0, total: 0 }) })),
      healthFactors: (Array.isArray(row.factors) ? row.factors : []).map((f) => ({
        ...f,
        label: FACTOR_LABELS[f.key] || f.key,
        contribution: isNum(contrib[f.key]) ? Math.round(contrib[f.key] * 10) / 10 : null,
      })),
    },
    profile: row.profile,
    config: { version: cfg?.version ?? null, rowVersion: row.configVersion },
    history: historyRows.map((h) => ({ date: h.date, score: h.score })),
    explain,
    compare,
  };
}

/** GET /api/pm/projects/:id/health?compare=7|28 */
export async function loadProjectStaffView(projectId, { compare = 28 } = {}) {
  const cfg = await getActiveConfig();
  const row = await prisma.healthScoreDaily.findFirst({ where: { projectId }, orderBy: { date: 'desc' } });
  if (!row) return staffHealthView(null, { cfg, compare });
  const [base, hist] = await Promise.all([
    prisma.healthScoreDaily.findUnique({ where: { projectId_date: { projectId, date: addDays(row.date, -compare) } } }),
    history('healthScoreDaily', { projectId }),
  ]);
  return staffHealthView(row, { cfg, historyRows: hist, explain: base ? explainChange(row, base).slice(0, 20) : [], compare });
}

/** GET /api/pm/clients/:clientId/health (staff): rollup, projects with weights, weighted why-changed, note. */
export async function loadClientStaffView(clientId, { compare = 28 } = {}) {
  const cfg = await getActiveConfig();
  const [client, latest] = await Promise.all([
    prisma.clientAccount.findUnique({ where: { id: clientId }, select: { id: true, agencyName: true, healthNote: true, healthNoteById: true, healthNoteAt: true } }),
    prisma.clientHealthDaily.findFirst({ where: { clientId }, orderBy: { date: 'desc' } }),
  ]);
  if (!client) return null;
  const noteBy = client.healthNoteById
    ? await prisma.user.findUnique({ where: { id: client.healthNoteById }, select: { name: true } }).catch(() => null)
    : null;
  const note = client.healthNote ? { text: client.healthNote, by: noteBy?.name || null, at: iso(client.healthNoteAt) } : null;
  if (!latest) return { client: null, history: [], projects: [], explain: [], note, compare, config: { version: cfg.version } };

  const weights = Array.isArray(latest.projectWeights) ? latest.projectWeights : [];
  const ids = weights.map((w) => w.projectId);
  const [projects, todayRows, baseRows, hist] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.healthScoreDaily.findMany({ where: { projectId: { in: ids }, date: latest.date } }),
    prisma.healthScoreDaily.findMany({ where: { projectId: { in: ids }, date: addDays(latest.date, -compare) } }),
    history('clientHealthDaily', { clientId }),
  ]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const sumW = weights.reduce((t, w) => t + (w.weight || 0), 0) || 1;
  const explain = [];
  for (const w of weights) {
    const now = todayRows.find((r) => r.projectId === w.projectId);
    const base = baseRows.find((r) => r.projectId === w.projectId);
    if (!now || !base) continue;
    for (const e of explainChange(now, base)) {
      explain.push({ ...e, projectId: w.projectId, projectName: names.get(w.projectId) || null, delta: Math.round(((e.delta * (w.weight || 0)) / sumW) * 10) / 10 });
    }
  }
  explain.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const b = bandInfo(latest.score, cfg);
  return {
    client: {
      date: latest.date,
      score: latest.score,
      band: b.band,
      label: b.label,
      coverage: latest.coverage,
      trend28: latest.trend28,
      arrow: trendArrow(latest.trend28, cfg.trendArrowDelta ?? 3),
      pillars: PILLARS.map((key) => ({ key, label: PILLAR_LABELS[key].staff, ...(latest.pillars?.[key] || { score: null }) })),
      configVersion: latest.configVersion,
      computedAt: iso(latest.computedAt),
    },
    history: hist.map((h) => ({ date: h.date, score: h.score })),
    projects: weights.map((w) => ({ projectId: w.projectId, name: names.get(w.projectId) || null, score: w.score, coverage: w.coverage, weight: w.weight })),
    explain: explain.filter((e) => e.delta !== 0).slice(0, 15),
    note,
    compare,
    config: { version: cfg.version },
  };
}
