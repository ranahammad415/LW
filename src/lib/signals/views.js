/**
 * Read models of the signals feature (plan §6). Two audiences:
 * - Staff (OWNER / PM, admin portal): sessions explorer + session timeline (visitor-local time, CTA clicks; visitorId
 *   shown as a short hash and copyable for erasure; city here only), attribution paths (first × last matrix,
 *   time-to-lead, sessions-before-lead), geo / device / hour, data quality (SignalIngestStat + signals-summary +
 *   mismatches + retention lag), CSV (sessions or days) and a per-lead JSON event export.
 * - Client (`clientSignalsView`, `clientDailyCsv`): an ALLOW-LIST built here: channel counts (AI assistants as one
 *   channel with per-source counts), the 13-month trend, top landing pages, the funnel, country / region / device, the
 *   data note and the recent enquiries' sentences. Never ids, visitor ids, city, payload, or paths beyond landing pages.
 * Visitor counts for a range come from SignalSession (distinct visitorId + session-only sessions), never by summing
 * the daily rows. Sessions with botScore ≥ 70 are excluded everywhere except the bot counts.
 * SignalEvent.id (BIGINT) is never selected here.
 */
import { prisma } from '../prisma.js';
import { BOT_THRESHOLD, isSessionId, isVisitorId, rowToSignal } from './validate.js';
import { CHANNELS, channelOf, sourceLabel, utcDay, addMonths, addDays, DAY_MS } from './common.js';
import { sha256 } from './ingest.js';
import { clientAttribution, staffAttribution } from './attribution.js';
import { hasSignals, loadSignalsMirror } from './config.js';
import { RETENTION } from './retention.js';

export const shortHash = (id) => (id ? sha256(id).slice(0, 8) : null);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

export function parseRange(q = {}, { defaultDays = 30, maxDays = 800 } = {}) {
  const now = new Date();
  let to = q.to ? new Date(q.to) : addDays(utcDay(now), 1);
  if (Number.isNaN(to.getTime())) to = addDays(utcDay(now), 1);
  let from = q.from ? new Date(q.from) : addDays(to, -defaultDays);
  if (Number.isNaN(from.getTime())) from = addDays(to, -defaultDays);
  if (to - from > maxDays * DAY_MS) from = addDays(to, -maxDays);
  if (from > to) from = addDays(to, -1);
  return { from, to };
}

/* ───────────────────────────── staff ───────────────────────────── */

const SESSION_LIST_SELECT = {
  sessionId: true,
  visitorId: true,
  startedAt: true,
  endedAt: true,
  landingPath: true,
  exitPath: true,
  pageviews: true,
  engagedSec: true,
  engaged: true,
  ctaClicks: true,
  formStarts: true,
  refClass: true,
  refSource: true,
  utmCampaign: true,
  formFactor: true,
  uaFamily: true,
  country: true,
  region: true,
  city: true,
  tz: true,
  localHour: true,
  botScore: true,
  isNewVisitor: true,
  sessionOnly: true,
  leadId: true,
};

export function staffSession(s) {
  return {
    sessionId: s.sessionId,
    visitorId: s.visitorId ?? null,
    visitorHash: shortHash(s.visitorId),
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    durationSec: Math.max(0, Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 1000)),
    landingPath: s.landingPath,
    exitPath: s.exitPath ?? null,
    pageviews: s.pageviews,
    engagedSec: s.engagedSec,
    engaged: s.engaged,
    ctaClicks: s.ctaClicks,
    formStarts: s.formStarts,
    refClass: s.refClass,
    refSource: s.refSource ?? null,
    sourceLabel: sourceLabel(s.refClass, s.refSource),
    utmCampaign: s.utmCampaign ?? null,
    formFactor: s.formFactor ?? null,
    uaFamily: s.uaFamily ?? null,
    country: s.country ?? null,
    region: s.region ?? null,
    city: s.city ?? null,
    tz: s.tz ?? null,
    localHour: s.localHour ?? null,
    botScore: s.botScore,
    bot: s.botScore >= BOT_THRESHOLD,
    isNewVisitor: s.isNewVisitor,
    sessionOnly: s.sessionOnly,
    hasLead: !!s.leadId,
    leadId: s.leadId ?? null,
  };
}

/** Sessions explorer (filters: class, source, landing, country, device, hasLead, bot). */
export async function listSessions(projectId, q = {}) {
  const { from, to } = parseRange(q);
  const where = { projectId, startedAt: { gte: from, lt: to } };
  if (q.class) where.refClass = String(q.class).slice(0, 10);
  if (q.source) where.refSource = String(q.source).slice(0, 64);
  if (q.landing) where.landingPath = String(q.landing).slice(0, 2048);
  if (q.country) where.country = String(q.country).slice(0, 2).toUpperCase();
  if (q.device) where.formFactor = String(q.device).slice(0, 10);
  if (q.hasLead === 'true') where.leadId = { not: null };
  if (q.hasLead === 'false') where.leadId = null;
  if (q.bot === 'only') where.botScore = { gte: BOT_THRESHOLD };
  else if (q.bot !== 'include') where.botScore = { lt: BOT_THRESHOLD };
  if (q.visitorId && isVisitorId(q.visitorId)) where.visitorId = q.visitorId;
  const take = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const skip = Math.min(10_000, Math.max(0, Number(q.offset) || 0));
  const rows = await prisma.signalSession.findMany({ where, orderBy: { startedAt: 'desc' }, take, skip, select: SESSION_LIST_SELECT });
  return { from: iso(from), to: iso(to), items: rows.map(staffSession), offset: skip, limit: take };
}

/** One session's timeline (events in order; visitor-local time from tsLocal). */
export async function sessionTimeline(projectId, sessionId) {
  if (!isSessionId(sessionId)) return null;
  const s = await prisma.signalSession.findUnique({ where: { projectId_sessionId: { projectId, sessionId } }, select: { ...SESSION_LIST_SELECT, touch: true, botReasons: true } });
  const events = await prisma.signalEvent.findMany({
    where: { projectId, sessionId },
    orderBy: { at: 'asc' },
    take: 500,
    select: { eventId: true, type: true, at: true, sessionId: true, visitorId: true, refClass: true, refSource: true, country: true, pagePath: true, leadId: true, botScore: true, payload: true, payloadCompactedAt: true },
  });
  if (!s && !events.length) return null;
  const attribution = s?.leadId ? await prisma.leadAttribution.findFirst({ where: { projectId, siteLeadId: s.leadId } }) : null;
  return {
    session: s ? { ...staffSession(s), touch: s.touch || null, botReasons: Array.isArray(s.botReasons) ? s.botReasons : [] } : null,
    attribution: attribution ? staffAttribution(attribution) : null,
    events: events.map((e) => {
      const sig = rowToSignal(e);
      return {
        eventId: e.eventId,
        type: e.type,
        at: iso(e.at),
        localTime: sig.tsLocal || null,
        path: e.pagePath,
        title: sig.page?.title ?? null,
        referrer: e.type === 'visit' ? { class: e.refClass, source: e.refSource ?? null, host: sig.referrer?.host ?? null } : null,
        cta: sig.cta || null,
        engagement: sig.engagement || null,
        vitals: sig.vitals || null,
        lead: sig.lead ? { formId: sig.lead.formId ?? null, placement: sig.lead.placement ?? null, hasLead: !!e.leadId } : null,
        botScore: e.botScore,
        compacted: !e.payload,
      };
    }),
  };
}

const TTL_BUCKETS = [
  ['< 10 min', 600],
  ['10 min – 1 h', 3600],
  ['1 h – 1 day', 86400],
  ['1 – 7 days', 7 * 86400],
  ['7 – 30 days', 30 * 86400],
  ['> 30 days', Infinity],
];

/** Attribution paths for leads in a range: first × last class matrix, time to lead, sessions before lead, mismatches. */
export async function attributionPaths(projectId, q = {}) {
  const { from, to } = parseRange(q, { defaultDays: 90 });
  const rows = await prisma.leadAttribution.findMany({ where: { projectId, leadAt: { gte: from, lt: to } }, orderBy: { leadAt: 'desc' }, take: 5000 });
  const matrix = {};
  const ttl = Object.fromEntries(TTL_BUCKETS.map(([k]) => [k, 0]));
  let ttlUnknown = 0;
  const sessionsBefore = {};
  const mismatches = [];
  const models = {};
  for (const a of rows) {
    const ft = a.firstTouch?.class || a.siteSnapshot?.firstTouch?.class || 'unknown';
    const lt = a.lastClass || 'unknown';
    matrix[ft] = matrix[ft] || {};
    matrix[ft][lt] = (matrix[ft][lt] || 0) + 1;
    models[a.model] = (models[a.model] || 0) + 1;
    const sec = a.timeToLeadSec ?? a.sitePath?.timeToLeadSec ?? null;
    if (sec == null) ttlUnknown += 1;
    else ttl[TTL_BUCKETS.find(([, max]) => sec < max)[0]] += 1;
    const sb = a.sessionsBeforeLead ?? a.sitePath?.sessionsBefore ?? null;
    const key = sb == null ? 'unknown' : sb >= 5 ? '5+' : String(sb);
    sessionsBefore[key] = (sessionsBefore[key] || 0) + 1;
    if (a.mismatch && mismatches.length < 100) {
      mismatches.push({ leadId: a.siteLeadId, leadAt: iso(a.leadAt), derived: { class: a.lastClass, source: a.lastSource || null }, snapshot: { class: a.siteSnapshot?.lastTouch?.class || null, source: a.siteSnapshot?.lastTouch?.source || null }, sessionId: a.sessionId || null });
    }
  }
  return {
    from: iso(from),
    to: iso(to),
    leads: rows.length,
    models,
    matrix,
    timeToLead: { ...ttl, unknown: ttlUnknown },
    sessionsBeforeLead: sessionsBefore,
    mismatchRate: rows.length ? Math.round((rows.filter((a) => a.mismatch).length / rows.length) * 1000) / 1000 : null,
    mismatches,
  };
}

/** Country / region / city / device / local hour (admin only: city lives here). */
export async function geoDeviceHour(projectId, q = {}) {
  const { from, to } = parseRange(q);
  const rows = await prisma.signalSession.findMany({ where: { projectId, startedAt: { gte: from, lt: to }, botScore: { lt: BOT_THRESHOLD } }, select: { country: true, region: true, city: true, formFactor: true, localHour: true, leadId: true }, take: 100_000 });
  const count = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      const x = m.get(k) || { key: k, sessions: 0, leads: 0 };
      x.sessions += 1;
      if (r.leadId) x.leads += 1;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 50);
  };
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sessions: 0 }));
  for (const r of rows) if (Number.isInteger(r.localHour) && r.localHour >= 0 && r.localHour < 24) hours[r.localHour].sessions += 1;
  return {
    from: iso(from),
    to: iso(to),
    countries: count((r) => r.country || 'unknown'),
    regions: count((r) => `${r.country || '?'}-${r.region || '?'}`),
    cities: count((r) => `${r.city || 'unknown'}, ${r.region || '?'}`),
    devices: count((r) => r.formFactor || 'other'),
    hours,
  };
}

/** Data-quality panel: OS ingest counters, the site's signals-summary, retention lag, bot / consent share. */
export async function dataQuality(projectId, { now = new Date() } = {}) {
  const since = addDays(utcDay(now), -13);
  const stats = await prisma.signalIngestStat.findMany({ where: { projectId, date: { gte: since } }, orderBy: { date: 'asc' } });
  const totals = { batches: 0, events: 0, innerDuplicates: 0, rejectedInvalid: 0, clamped: 0, botEvents: 0 };
  for (const s of stats) for (const k of Object.keys(totals)) totals[k] += Number(s[k]) || 0;
  const withSummary = [...stats].reverse().find((s) => s.siteSummary);
  const weekAgo = addDays(now, -7);
  const sessions7 = await prisma.signalSession.findMany({ where: { projectId, startedAt: { gte: weekAgo } }, select: { botScore: true, sessionOnly: true } });
  const bots = sessions7.filter((s) => s.botScore >= BOT_THRESHOLD).length;
  const human = sessions7.length - bots;
  const sessionOnly = sessions7.filter((s) => s.botScore < BOT_THRESHOLD && s.sessionOnly).length;
  const [unsessionized, oldestPayload, lastEvent, leads30, mismatched30] = await Promise.all([
    prisma.signalEvent.count({ where: { projectId, sessionizedAt: null } }),
    prisma.signalEvent.findFirst({ where: { projectId, payloadCompactedAt: null }, orderBy: { at: 'asc' }, select: { at: true } }),
    prisma.signalEvent.findFirst({ where: { projectId }, orderBy: { at: 'desc' }, select: { at: true } }),
    prisma.leadAttribution.count({ where: { projectId, leadAt: { gte: addDays(now, -30) } } }),
    prisma.leadAttribution.count({ where: { projectId, leadAt: { gte: addDays(now, -30) }, mismatch: true } }),
  ]);
  const mirror = await loadSignalsMirror(projectId);
  const lagDays = oldestPayload?.at ? (now - new Date(oldestPayload.at)) / DAY_MS : null;
  return {
    days: stats.map((s) => ({ date: iso(s.date).slice(0, 10), batches: s.batches, events: s.events, innerDuplicates: s.innerDuplicates, rejectedInvalid: s.rejectedInvalid, clamped: s.clamped, botEvents: s.botEvents })),
    totals,
    siteSummary: withSummary?.siteSummary || null,
    siteSummaryAt: iso(withSummary?.siteSummaryAt),
    buffer: mirror?.buffer || null,
    sessions7d: sessions7.length,
    botShare7d: sessions7.length ? Math.round((bots / sessions7.length) * 1000) / 1000 : null,
    consentShare7d: human ? Math.round(((human - sessionOnly) / human) * 1000) / 1000 : null,
    unsessionized,
    lastEventAt: iso(lastEvent?.at),
    oldestUncompactedAt: iso(oldestPayload?.at),
    // §6.5 app.signals_retention: payload older than 90 days + 2 days grace = compaction lagging
    retentionLagging: lagDays != null && lagDays > RETENTION.payloadDays + 2,
    leads30d: leads30,
    mismatchRate30d: leads30 ? Math.round((mismatched30 / leads30) * 1000) / 1000 : null,
  };
}

/** Per-project overview for the staff tab header. */
export async function staffOverview(project, q = {}) {
  const { from, to } = parseRange(q);
  const daily = await prisma.signalDailyBySource.findMany({ where: { projectId: project.id, date: { gte: utcDay(from), lt: utcDay(to) } } });
  const byClass = {};
  let sessions = 0;
  let leads = 0;
  let botSessions = 0;
  for (const r of daily) {
    byClass[r.refClass] = byClass[r.refClass] || { sessions: 0, leads: 0 };
    byClass[r.refClass].sessions += r.sessions;
    byClass[r.refClass].leads += r.leads;
    sessions += r.sessions;
    leads += r.leads;
    botSessions += r.botSessions;
  }
  return {
    available: hasSignals(project),
    from: iso(from),
    to: iso(to),
    sessions,
    leads,
    botSessions,
    visitors: await rangeVisitors(project.id, from, to),
    byClass,
    aiShare: sessions ? Math.round(((byClass.ai?.sessions || 0) / sessions) * 1000) / 1000 : null,
  };
}

/** Distinct visitors in a range from SignalSession (never summed daily rows). null beyond the 25-month session window. */
export async function rangeVisitors(projectId, from, to) {
  if (from < addMonths(new Date(), -RETENTION.sessionMonths)) return null;
  const rows = await prisma.signalSession.findMany({ where: { projectId, startedAt: { gte: from, lt: to }, botScore: { lt: BOT_THRESHOLD } }, select: { visitorId: true }, take: 500_000 });
  const ids = new Set();
  let sessionOnly = 0;
  for (const r of rows) {
    if (r.visitorId) ids.add(r.visitorId);
    else sessionOnly += 1;
  }
  return ids.size + sessionOnly;
}

/* ───────────────────────────── CSV ───────────────────────────── */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';

/** Staff export: grain session (one row per session) or day (daily rows). Never payload. */
export async function staffCsv(projectId, q = {}) {
  const { from, to } = parseRange(q, { defaultDays: 30, maxDays: 400 });
  if (q.grain === 'day') return dailyCsv(projectId, from, to);
  const where = { projectId, startedAt: { gte: from, lt: to }, ...(q.bots === 'include' ? {} : { botScore: { lt: BOT_THRESHOLD } }) };
  const rows = await prisma.signalSession.findMany({ where, orderBy: { startedAt: 'asc' }, take: 100_000, select: SESSION_LIST_SELECT });
  const header = ['startedAt', 'endedAt', 'sessionId', 'visitorId', 'landingPath', 'exitPath', 'pageviews', 'engagedSec', 'ctaClicks', 'formStarts', 'refClass', 'refSource', 'utmCampaign', 'formFactor', 'uaFamily', 'country', 'region', 'city', 'localHour', 'botScore', 'isNewVisitor', 'sessionOnly', 'hasLead'];
  return toCsv(header, rows.map(staffSession));
}

async function dailyCsv(projectId, from, to) {
  const rows = await prisma.signalDailyBySource.findMany({ where: { projectId, date: { gte: utcDay(from), lt: utcDay(to) } }, orderBy: [{ date: 'asc' }, { refClass: 'asc' }] });
  const header = ['date', 'channel', 'refClass', 'refSource', 'sessions', 'visitorsThatDay', 'pageviews', 'engagedSessions', 'ctaClicks', 'formStarts', 'leads'];
  return toCsv(
    header,
    rows.map((r) => ({
      date: iso(r.date).slice(0, 10),
      channel: CHANNELS.find((c) => c.id === channelOf(r.refClass, r.refSource))?.label,
      refClass: r.refClass,
      refSource: r.refSource || '',
      sessions: r.sessions,
      visitorsThatDay: r.visitors,
      pageviews: r.pageviews,
      engagedSessions: r.engagedSessions,
      ctaClicks: r.ctaClicks,
      formStarts: r.formStarts,
      leads: r.leads,
    }))
  );
}

/** Client export: daily aggregates only (no ids, no visitor ids, no payload, no city). */
export async function clientDailyCsv(projectId, q = {}) {
  const { from, to } = parseRange(q, { defaultDays: 90, maxDays: 1100 });
  return dailyCsv(projectId, from, to);
}

/** Admin-only JSON of one lead's signals (the path the admin sees), no internal ids. */
export async function leadEventsJson(projectId, siteLeadId) {
  const a = await prisma.leadAttribution.findFirst({ where: { projectId, siteLeadId } });
  if (!a) return null;
  const sessionIds = [a.sessionId].filter(Boolean);
  const events = sessionIds.length
    ? await prisma.signalEvent.findMany({
        where: { projectId, sessionId: { in: sessionIds } },
        orderBy: { at: 'asc' },
        take: 500,
        select: { eventId: true, type: true, at: true, sessionId: true, visitorId: true, refClass: true, refSource: true, country: true, pagePath: true, leadId: true, botScore: true, payload: true },
      })
    : [];
  return { leadId: siteLeadId, attribution: { ...staffAttribution(a), siteSnapshot: a.siteSnapshot || null, sitePath: a.sitePath || null, firstTouch: a.firstTouch || null, lastTouch: a.lastTouch || null, pathSummary: a.pathSummary || [] }, events: events.map(rowToSignal) };
}

/* ───────────────────────────── client ───────────────────────────── */

const SMALL_NUMBERS = 20;

/**
 * "Where your leads come from" (plan §6.1). Only with capabilities.signals (EmDash); otherwise { available: false }
 * (the UI then renders nothing: never a section of empty zeros).
 */
export async function clientSignalsView(project, { now = new Date() } = {}) {
  if (!hasSignals(project)) return { available: false };
  const projectId = project.id;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  const daily = await prisma.signalDailyBySource.findMany({ where: { projectId, date: { gte: trendStart } }, select: { date: true, refClass: true, refSource: true, sessions: true, engagedSessions: true, formStarts: true, leads: true, botSessions: true } });

  const leadsBy = (start, end) => {
    const ch = Object.fromEntries(CHANNELS.map((c) => [c.id, { id: c.id, label: c.label, leads: 0, sessions: 0, sources: {} }]));
    for (const r of daily) {
      const t = new Date(r.date);
      if (t < start || t >= end) continue;
      const id = channelOf(r.refClass, r.refSource);
      ch[id].leads += r.leads;
      ch[id].sessions += r.sessions;
      if (id === 'ai' && (r.leads || r.sessions)) {
        const label = sourceLabel('ai', r.refSource);
        const s = (ch.ai.sources[label] = ch.ai.sources[label] || { leads: 0, sessions: 0 });
        s.leads += r.leads;
        s.sessions += r.sessions;
      }
    }
    return Object.values(ch).map((c) => ({ ...c, sources: Object.entries(c.sources).map(([label, v]) => ({ label, ...v })).sort((a, b) => b.leads - a.leads || b.sessions - a.sessions) }));
  };

  const months = [];
  for (let i = 12; i >= 0; i -= 1) months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  const trend = months.map((m) => ({ month: m, ai: { sessions: 0, leads: 0 }, search: { sessions: 0, leads: 0 }, direct: { sessions: 0, leads: 0 }, other: { sessions: 0, leads: 0 } }));
  const tIndex = new Map(trend.map((t, i) => [t.month, i]));
  let bots = 0;
  let humans = 0;
  for (const r of daily) {
    const t = trend[tIndex.get(monthKey(r.date))];
    if (!t) continue;
    const g = r.refClass === 'ai' ? 'ai' : r.refClass === 'search' ? 'search' : r.refClass === 'direct' ? 'direct' : 'other';
    t[g].sessions += r.sessions;
    t[g].leads += r.leads;
    if (new Date(r.date) >= addDays(now, -30)) {
      bots += r.botSessions;
      humans += r.sessions;
    }
  }

  const thisMonth = leadsBy(monthStart, addDays(now, 1));
  const lastMonth = leadsBy(lastMonthStart, monthStart);
  const total = (list) => list.reduce((n, c) => n + c.leads, 0);

  // Landing pages that led to a quote (last 90 days)
  const landingRows = await prisma.signalDailyByLanding.findMany({ where: { projectId, date: { gte: addDays(utcDay(now), -90) }, leads: { gt: 0 } }, select: { landingPath: true, leads: true } });
  const landing = new Map();
  for (const r of landingRows) landing.set(r.landingPath, (landing.get(r.landingPath) || 0) + r.leads);
  const topLandingPages = [...landing.entries()].map(([path, leads]) => ({ path, leads })).sort((a, b) => b.leads - a.leads).slice(0, 5);

  // Funnel (this month): visits, engaged visits, quote-form starts, leads
  const funnelRows = daily.filter((r) => new Date(r.date) >= monthStart);
  const funnel = {
    visits: funnelRows.reduce((n, r) => n + r.sessions, 0),
    engagedVisits: funnelRows.reduce((n, r) => n + r.engagedSessions, 0),
    formStarts: funnelRows.reduce((n, r) => n + r.formStarts, 0),
    leads: funnelRows.reduce((n, r) => n + r.leads, 0),
  };

  // Where visitors are (country / region only) and devices, last 90 days
  const geoRows = await prisma.signalDailyByGeoDevice.findMany({ where: { projectId, date: { gte: addDays(utcDay(now), -90) } }, select: { country: true, region: true, formFactor: true, sessions: true, leads: true } });
  const regions = new Map();
  const devices = new Map();
  for (const r of geoRows) {
    const rk = r.country ? `${r.country}${r.region ? `-${r.region}` : ''}` : 'Unknown';
    const x = regions.get(rk) || { area: rk, sessions: 0, leads: 0 };
    x.sessions += r.sessions;
    x.leads += r.leads;
    regions.set(rk, x);
    const d = devices.get(r.formFactor) || { device: r.formFactor, sessions: 0, leads: 0 };
    d.sessions += r.sessions;
    d.leads += r.leads;
    devices.set(r.formFactor, d);
  }

  // Recent enquiries: the sentences only (no ids, no names)
  const recent = await prisma.leadAttribution.findMany({ where: { projectId }, orderBy: { leadAt: 'desc' }, take: 10 });
  const totalLeads = total(thisMonth) + total(lastMonth);
  const botShare = bots + humans ? bots / (bots + humans) : null;
  return {
    available: true,
    thisMonth,
    lastMonth,
    thisMonthLeads: total(thisMonth),
    lastMonthLeads: total(lastMonth),
    smallNumbers: totalLeads < SMALL_NUMBERS,
    trend,
    topLandingPages,
    funnel,
    visitorsThisMonth: await rangeVisitors(projectId, monthStart, addDays(now, 1)),
    areas: [...regions.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    devices: [...devices.values()].sort((a, b) => b.sessions - a.sessions),
    recentLeads: recent.map((a) => ({ at: iso(a.leadAt), ...clientAttribution(a) })),
    notes: {
      aiMode: "Google's AI Mode and AI Overviews cannot be separated from Google Search; they are counted as Google Search.",
      bots: botShare == null ? null : `About ${Math.round(botShare * 100)} % of visits in the last 30 days came from bots and are not counted.`,
      consent: 'Visitors who opt out are still counted as visits, but not recognised when they come back.',
      smallNumbers: totalLeads < SMALL_NUMBERS ? 'With fewer than 20 enquiries, small changes can move these numbers a lot.' : null,
    },
  };
}

