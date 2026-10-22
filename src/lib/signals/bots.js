/**
 * Plan §5.3 `signals.bots` (leader-only, nightly 03:10): re-score at SESSION level only. SignalEvent rows are never
 * rewritten (SignalEvent.botScore stays the capture-time score); rollups and explorers exclude bots by the session's
 * botScore. Nothing is deleted.
 *   +30  1 pageview, no engagement and an unknown UA family
 *   +40  ≥ 50 sessions per UTC day from one network prefix (ipPrefix) with no engagement
 *   +20  data-centre style anomalies: desktop without Accept-Language, or headless
 * rescore = min(100, capture score + additions); a rescore ≥ 70 raises SignalSession.botScore (max(capture, rescore)).
 */
import { prisma } from '../prisma.js';
import { BOT_THRESHOLD } from './validate.js';
import { addDays, utcDay, markDirty, dayKey } from './common.js';

/** Pure: additions for one session given the day's prefix counts (of sessions without engagement). */
export function botAdditions(s, prefixCounts) {
  let add = 0;
  const reasons = [];
  const unknownUa = !s.uaFamily || s.uaFamily === 'other' || s.uaFamily === 'bot';
  if ((Number(s.pageviews) || 0) <= 1 && !s.engaged && unknownUa) {
    add += 30;
    reasons.push('single_page_unknown_ua');
  }
  if (s.ipPrefix && !s.engaged && (prefixCounts.get(`${dayKey(s.startedAt)}\u0000${s.ipPrefix}`) || 0) >= 50) {
    add += 40;
    reasons.push('prefix_burst');
  }
  const r = Array.isArray(s.botReasons) ? s.botReasons : [];
  if (r.includes('headless') || (s.formFactor === 'desktop' && r.includes('no_accept_language'))) {
    add += 20;
    reasons.push('datacentre_anomaly');
  }
  return { add, reasons };
}

/** Re-score the sessions that started in the last `days` days (batches of ≤ 5 000). */
export async function runBotRescore({ now = new Date(), days = 3, batch = 5000, log } = {}) {
  const since = addDays(utcDay(now), -days);
  let cursor = null;
  let changed = 0;
  let scanned = 0;
  for (let i = 0; i < 100; i += 1) {
    const rows = await prisma.signalSession.findMany({
      where: { startedAt: { gte: since }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, projectId: true, startedAt: true, pageviews: true, engaged: true, uaFamily: true, ipPrefix: true, formFactor: true, botReasons: true, captureBotScore: true, rescoreBotScore: true, botScore: true },
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    const prefixCounts = new Map();
    for (const s of rows) {
      if (!s.ipPrefix || s.engaged) continue;
      const k = `${dayKey(s.startedAt)}\u0000${s.ipPrefix}`;
      prefixCounts.set(k, (prefixCounts.get(k) || 0) + 1);
    }
    const dirty = new Map();
    for (const s of rows) {
      const { add } = botAdditions(s, prefixCounts);
      const rescore = Math.min(100, (Number(s.captureBotScore) || 0) + add);
      const botScore = rescore >= BOT_THRESHOLD ? Math.max(Number(s.captureBotScore) || 0, rescore) : Number(s.captureBotScore) || 0;
      if (rescore === s.rescoreBotScore && botScore === s.botScore) continue;
      await prisma.signalSession.update({ where: { id: s.id }, data: { rescoreBotScore: rescore, botScore } });
      if (botScore !== s.botScore) {
        changed += 1;
        if (!dirty.has(s.projectId)) dirty.set(s.projectId, []);
        dirty.get(s.projectId).push(s.startedAt);
      }
    }
    for (const [projectId, dates] of dirty) await markDirty(projectId, dates);
    if (rows.length < batch) break;
  }
  if (changed) log?.info?.({ changed, scanned }, 'signals.bots');
  return { changed, scanned };
}
