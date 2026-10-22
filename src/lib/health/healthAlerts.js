/**
 * Health score v2 alerts (`health_score_drop`), run at the end of the daily job. docs/ledger/features/health-score.md.
 *
 *   Rule A: the client's band fell below yesterday's band, with coverage ≥ alerts.minCoverage.  key band:<band>
 *   Rule B: score(d) ≤ score(d − sustainedDays) − sustainedDropPoints held for consecutiveRuns runs (today and
 *           yesterday by default).                                                                  key drop7
 *   Dedupe: one alert per client and key per alerts.dedupeDays (compare-and-set on HealthAlertLog.sentAt, like the
 *           security claimAlert). Rising back into a higher band clears that client's band:* keys.
 *   Recipients: the client's lead/secondary PM, each rolled-up project's lead PM, every human OWNER, plus the
 *           security on-call users when the site pillar fell the most. Staff only: never a CLIENT user.
 * Sentences are fixed templates (no security numbers or ids), HTML-escaped because templates render into HTML.
 */
import { prisma } from '../prisma.js';
import { notify } from '../notificationService.js';
import { escapeHtml, ownerIds, onCallUserIds } from '../security/securityAlerts.js';
import { addDays, bandFor, bandRank, isNum } from './healthMath.js';
import { clientSentences } from './healthExplain.js';
import { BAND_LABELS } from './healthViews.js';
import { ROLLUP_STATUSES } from './healthScoreService.js';

const DAY_MS = 86_400_000;
const STAFF_ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/** True at most once per window per client and key, across PM2 instances. */
export async function claimHealthAlert(clientId, alertKey, { now = new Date(), windowMs = 7 * DAY_MS } = {}) {
  const key = String(alertKey).slice(0, 191);
  const res = await prisma.healthAlertLog.updateMany({
    where: { clientId, alertKey: key, sentAt: { lt: new Date(now.getTime() - windowMs) } },
    data: { sentAt: now, count: { increment: 1 } },
  });
  if (res.count > 0) return true;
  const existing = await prisma.healthAlertLog.findUnique({ where: { clientId_alertKey: { clientId, alertKey: key } } });
  if (existing) return false;
  try {
    await prisma.healthAlertLog.create({ data: { clientId, alertKey: key, sentAt: now } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Pure: which rule fires for one client given its scores by date. */
export function decideAlert(byDate, date, cfg) {
  const a = cfg.alerts;
  const today = byDate.get(date);
  const yday = byDate.get(addDays(date, -1));
  const out = { rule: null, rise: false, band: null, delta: null, base: null };
  if (!today || !isNum(today.score)) return out;
  const bandNow = bandFor(today.score, cfg.bands);
  out.band = bandNow;
  if (yday && isNum(yday.score)) {
    const bandBefore = bandFor(yday.score, cfg.bands);
    const rNow = bandRank(bandNow, cfg.bands);
    const rBefore = bandRank(bandBefore, cfg.bands);
    if (rNow > rBefore) out.rise = true;
    if (rNow < rBefore && (today.coverage ?? 0) >= a.minCoverage) {
      return { ...out, rule: 'band', delta: today.score - yday.score, base: yday };
    }
  }
  let sustained = true;
  for (let k = 0; k < a.consecutiveRuns; k += 1) {
    const d = byDate.get(addDays(date, -k));
    const b = byDate.get(addDays(date, -k - a.sustainedDays));
    if (!d || !b || !isNum(d.score) || !isNum(b.score) || d.score > b.score - a.sustainedDropPoints) {
      sustained = false;
      break;
    }
  }
  if (sustained) {
    const base = byDate.get(addDays(date, -a.sustainedDays));
    return { ...out, rule: 'drop', delta: today.score - base.score, base };
  }
  return out;
}

/** Pillar that fell the most between two client rows (null when none fell). */
export function largestDrop(today, base) {
  let worst = null;
  let worstDelta = 0;
  for (const [k, p] of Object.entries(today?.pillars || {})) {
    const b = base?.pillars?.[k]?.score;
    if (!isNum(p?.score) || !isNum(b)) continue;
    const d = p.score - b;
    if (d < worstDelta) {
      worstDelta = d;
      worst = k;
    }
  }
  return worst;
}

/** Staff recipients for a client alert; CLIENT accounts, agents and inactive users are filtered out. */
export async function healthAlertRecipients(clientId, { siteLed = false } = {}) {
  const [client, projects, owners, oncall] = await Promise.all([
    prisma.clientAccount.findUnique({ where: { id: clientId }, select: { leadPmId: true, secondaryPmId: true } }),
    prisma.project.findMany({ where: { clientId, status: { in: ROLLUP_STATUSES } }, select: { leadPmId: true } }),
    ownerIds(),
    siteLed ? onCallUserIds() : Promise.resolve([]),
  ]);
  const ids = [...new Set([client?.leadPmId, client?.secondaryPmId, ...projects.map((p) => p.leadPmId), ...owners, ...oncall].filter(Boolean))];
  if (!ids.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true, isAgent: false, role: { in: STAFF_ROLES } }, select: { id: true } });
  return users.map((u) => u.id);
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Evaluate both rules for every client that has a row on `date` (or the given clientIds), notify and dedupe.
 * @returns {{ evaluated, sent, deduped, resets }}
 */
export async function evaluateHealthAlerts(date, cfg, { log, clientIds = null, now = new Date() } = {}) {
  const a = cfg.alerts;
  const dates = new Set();
  for (let k = 0; k < a.consecutiveRuns; k += 1) {
    dates.add(addDays(date, -k));
    dates.add(addDays(date, -k - a.sustainedDays));
  }
  dates.add(addDays(date, -1));
  const where = { date: { in: [...dates] }, ...(clientIds ? { clientId: { in: clientIds } } : {}) };
  const rows = await prisma.clientHealthDaily.findMany({ where, select: { clientId: true, date: true, score: true, coverage: true, pillars: true } });
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.clientId)) byClient.set(r.clientId, new Map());
    byClient.get(r.clientId).set(r.date, r);
  }
  const out = { evaluated: 0, sent: 0, deduped: 0, resets: 0 };
  for (const [clientId, byDate] of byClient) {
    if (!byDate.has(date)) continue;
    out.evaluated += 1;
    try {
      const d = decideAlert(byDate, date, cfg);
      if (d.rise) {
        const del = await prisma.healthAlertLog.deleteMany({ where: { clientId, alertKey: { startsWith: 'band:' } } });
        out.resets += del?.count || 0;
      }
      if (!d.rule) continue;
      const key = d.rule === 'band' ? `band:${d.band}` : 'drop7';
      if (!(await claimHealthAlert(clientId, key, { now, windowMs: a.dedupeDays * DAY_MS }))) {
        out.deduped += 1;
        continue;
      }
      const today = byDate.get(date);
      const siteLed = largestDrop(today, d.base) === 'site';
      const [recipientIds, client, projectRows] = await Promise.all([
        healthAlertRecipients(clientId, { siteLed }),
        prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } }),
        prisma.healthScoreDaily.findMany({ where: { date, project: { clientId, status: { in: ROLLUP_STATUSES } } }, select: { factors: true } }),
      ]);
      if (!recipientIds.length) continue;
      const sentences = clientSentences(projectRows.flatMap((r) => (Array.isArray(r.factors) ? r.factors : [])), { limit: 2 }).attention;
      await notify({
        slug: 'health_score_drop',
        recipientIds,
        variables: {
          clientName: escapeHtml(client?.agencyName || 'Client'),
          score: String(today.score),
          band: BAND_LABELS[d.band]?.label || d.band,
          delta: signed(d.delta),
          reasons: escapeHtml(sentences.join('. ') + (sentences.length ? '.' : '')),
        },
        actionUrl: `/portal/admin/clients/${clientId}?tab=health`,
        metadata: { clientId, score: today.score, rule: d.rule },
      });
      out.sent += 1;
    } catch (err) {
      log?.warn?.({ clientId, err: err?.message }, 'Health alert failed');
    }
  }
  return out;
}
