/**
 * Read helpers for other features (no side effects). Health score v2 (a separate branch) will read `refClass` through
 * these; nothing here edits Health code.
 *   leadsBySource(projectId, from, to)        leads per class / source (SignalDailyBySource, summable)
 *   llmReferralSessions(projectId, from, to)  sessions referred by AI assistants (bots excluded), total and per source
 *   fieldVitals(projectId, from, to)          p75 of field LCP / INP / CLS from `vitals` signals (payload ≤ 90 days)
 * `from` inclusive, `to` exclusive (Date or ISO string); days are UTC.
 */
import { prisma } from '../prisma.js';
import { BOT_THRESHOLD } from './validate.js';
import { utcDay } from './common.js';

const d = (v) => new Date(v);

export async function leadsBySource(projectId, from, to) {
  const rows = await prisma.signalDailyBySource.findMany({
    where: { projectId, date: { gte: utcDay(from), lt: utcDay(to) } },
    select: { refClass: true, refSource: true, leads: true, sessions: true },
  });
  const map = new Map();
  for (const r of rows) {
    const k = `${r.refClass}\u0000${r.refSource}`;
    const x = map.get(k) || { refClass: r.refClass, refSource: r.refSource || null, leads: 0, sessions: 0 };
    x.leads += r.leads;
    x.sessions += r.sessions;
    map.set(k, x);
  }
  return [...map.values()].sort((a, b) => b.leads - a.leads || b.sessions - a.sessions);
}

export async function llmReferralSessions(projectId, from, to) {
  const rows = await prisma.signalSession.findMany({
    where: { projectId, refClass: 'ai', startedAt: { gte: d(from), lt: d(to) }, botScore: { lt: BOT_THRESHOLD } },
    select: { refSource: true },
  });
  const bySource = {};
  for (const r of rows) bySource[r.refSource || 'unknown'] = (bySource[r.refSource || 'unknown'] || 0) + 1;
  return { sessions: rows.length, bySource };
}

/** 75th percentile (nearest rank) of a list of numbers; null when empty. */
export function p75(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil(0.75 * v.length) - 1)];
}

export async function fieldVitals(projectId, from, to) {
  const rows = await prisma.signalEvent.findMany({
    where: { projectId, type: 'vitals', at: { gte: d(from), lt: d(to) }, payloadCompactedAt: null, botScore: { lt: BOT_THRESHOLD } },
    select: { payload: true },
    take: 50_000,
  });
  const vit = rows.map((r) => r.payload?.vitals).filter(Boolean);
  return {
    lcpMs: p75(vit.map((x) => x.lcpMs)),
    inpMs: p75(vit.map((x) => x.inpMs)),
    cls: p75(vit.map((x) => x.cls)),
    samples: vit.length,
  };
}
