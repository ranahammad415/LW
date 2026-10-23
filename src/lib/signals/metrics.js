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

/**
 * v1.9.0: leads per provider (the "Leads by source" provider dimension): `emdash` = the site's own form ("Website
 * form"), `ghl` = the embedded GoHighLevel form. From CmsLead (erased leads excluded), by the lead's own date.
 */
export const LEAD_PROVIDER_LABELS = Object.freeze({ emdash: 'Website form', ghl: 'GoHighLevel form' });
export async function leadsByProvider(projectId, from, to) {
  const rows = await prisma.cmsLead.findMany({
    where: { projectId, erasedAt: null, receivedAt: { gte: d(from), lt: d(to) } },
    select: { provider: true },
    take: 100_000,
  });
  const counts = { emdash: 0, ghl: 0 };
  for (const r of rows) counts[r.provider === 'ghl' ? 'ghl' : 'emdash'] += 1;
  return Object.entries(counts).map(([provider, leads]) => ({ provider, label: LEAD_PROVIDER_LABELS[provider], leads }));
}

/**
 * v1.9.0 §40.3 / §40.6 data-quality counter `leads.unmatched_form_submit` (last `days`, bots excluded):
 *   unmatched           form_submit signals older than `graceMin` whose session holds no lead (the thank-you page
 *                       fired but no webhook lead arrived: GHL workflow off, wrong token, GHL dropped it as spam);
 *   heuristicUnmatched  of those, inline-mode guesses (lead.heuristic set; discount them);
 *   leadsWithoutSession leads of the period with no visit session (normal for ad blockers / no JS; high = hand-off broken).
 */
export async function unmatchedFormSubmits(projectId, { now = new Date(), days = 14, graceMin = 30 } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const until = new Date(now.getTime() - graceMin * 60_000);
  const evs = await prisma.signalEvent.findMany({
    where: { projectId, type: 'form_submit', at: { gte: since, lte: until }, botScore: { lt: BOT_THRESHOLD } },
    select: { sessionId: true, payload: true },
    take: 5000,
  });
  const sessionIds = [...new Set(evs.map((e) => e.sessionId))];
  const withLead = new Set();
  if (sessionIds.length) {
    const attrs = await prisma.leadAttribution.findMany({ where: { projectId, sessionId: { in: sessionIds } }, select: { sessionId: true } });
    for (const a of attrs) withLead.add(a.sessionId);
    const sess = await prisma.signalSession.findMany({ where: { projectId, sessionId: { in: sessionIds }, leadId: { not: null } }, select: { sessionId: true } });
    for (const s of sess) withLead.add(s.sessionId);
  }
  const missing = evs.filter((e) => !withLead.has(e.sessionId));
  const [leads, leadsWithoutSession] = await Promise.all([
    prisma.leadAttribution.count({ where: { projectId, leadAt: { gte: since } } }),
    prisma.leadAttribution.count({ where: { projectId, leadAt: { gte: since }, sessionId: null } }),
  ]);
  return {
    key: 'leads.unmatched_form_submit',
    days,
    graceMin,
    formSubmits: evs.length,
    unmatched: missing.length,
    heuristicUnmatched: missing.filter((e) => e.payload?.lead?.heuristic).length,
    leads,
    leadsWithoutSession,
  };
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
