/**
 * Plan §5.3 `signals.rollup` (leader-only, nightly 03:30): recompute EXACTLY the days in each project's dirty-date set
 * (SignalRollupDirty, filled by the sessionizer and the attribution job; late arrivals can be up to 30 days old) plus
 * yesterday, then clear them. A day is recomputed from scratch (delete + insert of its rows in one transaction), so a
 * re-run gives the same rows (rollup equality).
 *   SignalDailyBySource    sessions / visitors / newVisitors / pageviews / engaged / CTA / form starts / bot sessions by
 *                          the session's class + source; leads by the lead's effective last touch (LeadAttribution).
 *   SignalDailyByLanding   sessions / engaged by landing page + class; leads by the lead's landing + class.
 *   SignalDailyByGeoDevice sessions by country / region / form factor; leads by the lead session's geo / device.
 * Sessions with botScore ≥ 70 are excluded (counted only as botSessions). `visitors` = distinct visitorId +
 * session-only sessions, per day: NOT summable across days (range visitors come from SignalSession, views.js).
 */
import { prisma } from '../prisma.js';
import { BOT_THRESHOLD } from './validate.js';
import { utcDay, addDays, dayKey } from './common.js';

const LANDING_MAX = 512;

/** Pure: the three tables' rows for one project-day from its sessions and leads. */
export function computeDay(projectId, date, sessions, leads) {
  const d = utcDay(date);
  const src = new Map();
  const land = new Map();
  const geo = new Map();
  const srcRow = (refClass, refSource) => {
    const k = `${refClass}\u0000${refSource || ''}`;
    if (!src.has(k)) src.set(k, { projectId, date: d, refClass, refSource: (refSource || '').slice(0, 64), sessions: 0, visitors: 0, newVisitors: 0, pageviews: 0, engagedSessions: 0, ctaClicks: 0, formStarts: 0, leads: 0, botSessions: 0, _v: new Set(), _nv: new Set() });
    return src.get(k);
  };
  const landRow = (path, refClass) => {
    const p = (path || '/').slice(0, LANDING_MAX);
    const k = `${p}\u0000${refClass}`;
    if (!land.has(k)) land.set(k, { projectId, date: d, landingPath: p, refClass, sessions: 0, leads: 0, engagedSessions: 0 });
    return land.get(k);
  };
  const geoRow = (country, region, formFactor) => {
    const k = `${country || ''}\u0000${region || ''}\u0000${formFactor || 'other'}`;
    if (!geo.has(k)) geo.set(k, { projectId, date: d, country: country || '', region: region || '', formFactor: formFactor || 'other', sessions: 0, leads: 0 });
    return geo.get(k);
  };
  for (const s of sessions) {
    const r = srcRow(s.refClass, s.refSource);
    if ((Number(s.botScore) || 0) >= BOT_THRESHOLD) {
      r.botSessions += 1;
      continue;
    }
    r.sessions += 1;
    if (s.visitorId) {
      r._v.add(s.visitorId);
      if (s.isNewVisitor) r._nv.add(s.visitorId);
    } else {
      r.visitors += 1; // session-only sessions count once each (upper bound)
    }
    r.pageviews += Number(s.pageviews) || 0;
    if (s.engaged) r.engagedSessions += 1;
    r.ctaClicks += Number(s.ctaClicks) || 0;
    r.formStarts += Number(s.formStarts) || 0;
    const l = landRow(s.landingPath, s.refClass);
    l.sessions += 1;
    if (s.engaged) l.engagedSessions += 1;
    geoRow(s.country, s.region, s.formFactor).sessions += 1;
  }
  for (const a of leads) {
    srcRow(a.lastClass || 'unknown', a.lastSource || '').leads += 1;
    landRow(a.landingPath || '/', a.lastClass || 'unknown').leads += 1;
    geoRow(a.country, a.region, a.formFactor).leads += 1;
  }
  const bySource = [...src.values()].map(({ _v, _nv, ...r }) => ({ ...r, visitors: r.visitors + _v.size, newVisitors: _nv.size }));
  return { bySource, byLanding: [...land.values()], byGeoDevice: [...geo.values()] };
}

/** Recompute one project-day (delete + insert in one transaction). */
export async function rollupDay(projectId, date) {
  const start = utcDay(date);
  const end = addDays(start, 1);
  const sessions = await prisma.signalSession.findMany({
    where: { projectId, startedAt: { gte: start, lt: end } },
    select: { visitorId: true, refClass: true, refSource: true, botScore: true, isNewVisitor: true, pageviews: true, engaged: true, ctaClicks: true, formStarts: true, landingPath: true, country: true, region: true, formFactor: true },
  });
  const leads = await prisma.leadAttribution.findMany({
    where: { projectId, leadAt: { gte: start, lt: end } },
    select: { lastClass: true, lastSource: true, landingPath: true, country: true, region: true, formFactor: true },
  });
  const rows = computeDay(projectId, start, sessions, leads);
  await prisma.$transaction([
    prisma.signalDailyBySource.deleteMany({ where: { projectId, date: start } }),
    prisma.signalDailyByLanding.deleteMany({ where: { projectId, date: start } }),
    prisma.signalDailyByGeoDevice.deleteMany({ where: { projectId, date: start } }),
    ...(rows.bySource.length ? [prisma.signalDailyBySource.createMany({ data: rows.bySource })] : []),
    ...(rows.byLanding.length ? [prisma.signalDailyByLanding.createMany({ data: rows.byLanding })] : []),
    ...(rows.byGeoDevice.length ? [prisma.signalDailyByGeoDevice.createMany({ data: rows.byGeoDevice })] : []),
  ]);
  return { sources: rows.bySource.length, landings: rows.byLanding.length, geo: rows.byGeoDevice.length };
}

/** The nightly job: dirty dates (+ yesterday for projects with sessions yesterday). Bounded per run. */
export async function runRollup({ now = new Date(), limit = 2000, log } = {}) {
  const dirty = await prisma.signalRollupDirty.findMany({ orderBy: { createdAt: 'asc' }, take: limit });
  const yStart = addDays(utcDay(now), -1);
  const yProjects = await prisma.signalSession.findMany({ where: { startedAt: { gte: yStart, lt: utcDay(now) } }, distinct: ['projectId'], select: { projectId: true } });
  const work = new Map();
  for (const r of dirty) work.set(`${r.projectId}\u0000${dayKey(r.date)}`, { projectId: r.projectId, date: utcDay(r.date), row: r });
  for (const p of yProjects) {
    const k = `${p.projectId}\u0000${dayKey(yStart)}`;
    if (!work.has(k)) work.set(k, { projectId: p.projectId, date: yStart, row: null });
  }
  let days = 0;
  for (const w of work.values()) {
    await rollupDay(w.projectId, w.date);
    // Clear the mark only if nobody re-marked the day meanwhile (createdAt is bumped by markDirty).
    if (w.row) await prisma.signalRollupDirty.deleteMany({ where: { id: w.row.id, createdAt: w.row.createdAt } });
    days += 1;
  }
  if (days) log?.info?.({ days }, 'signals.rollup');
  return { days };
}
