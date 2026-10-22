/**
 * Plan §5.3 `signals.sessionize` (leader-only, every 5 min, across projects, ≤ 5 000 events per claim, loop until
 * drained or the run budget is used).
 *
 * Claim with a compare-and-set on sessionizedAt (global index (sessionizedAt, at)):
 *   1. release stale claims (a claim value older than 15 min: the run died);
 *   2. pick ≤ n unsessionized ids ordered by `at`, `updateMany … WHERE id IN (…) AND sessionizedAt IS NULL` to a claim
 *      value unique to this run (now − 100 years + jitter: every claim is before 1990, every confirmation after);
 *   3. read back exactly the rows carrying our claim value, rebuild every touched (projectId, sessionId) FROM ALL ITS
 *      EVENTS (so a re-run, a duplicate or an out-of-order arrival yields the same session: events are ordered by `at`,
 *      not by arrival), flag the lead attributions to re-derive, record the dirty dates;
 *   4. confirm (sessionizedAt = now).
 * Bot scoring here is capture-time only (max over the session's events); the nightly job may raise SignalSession.botScore,
 * which a rebuild keeps (botScore = max(capture, rescore)). SignalEvent rows are never rewritten except sessionizedAt.
 */
import { prisma } from '../prisma.js';
import { markDirty, touchFromVisit, DAY_MS } from './common.js';

export const SESSIONIZE_BATCH = 5000;
const CLAIM_OFFSET_MS = 100 * 365.25 * DAY_MS;
const CLAIM_STALE_MS = 15 * 60_000;
const CLAIM_CEILING = new Date('1990-01-01T00:00:00.000Z');

export function claimValue(now = new Date(), jitter = Math.floor(Math.random() * 1000)) {
  return new Date(now.getTime() - CLAIM_OFFSET_MS + jitter);
}

/** Release claims whose run died (claim value older than 15 min after removing the offset). */
export async function releaseStaleClaims(now = new Date()) {
  const r = await prisma.signalEvent.updateMany({
    where: { sessionizedAt: { lt: new Date(now.getTime() - CLAIM_OFFSET_MS - CLAIM_STALE_MS) } },
    data: { sessionizedAt: null },
  });
  return Number(r?.count) || 0;
}

const SESSION_FIELDS = {
  type: true,
  at: true,
  sessionId: true,
  visitorId: true,
  refClass: true,
  refSource: true,
  country: true,
  pagePath: true,
  leadId: true,
  botScore: true,
  payload: true,
  payloadCompactedAt: true,
};

/**
 * The distinct site lead ids of a session's events (O-R3B-3: one visit can send several quotes), first lead first:
 * lead_submitted rows in time order, then any other row naming a lead. Pure.
 */
export function sessionLeadIds(events) {
  const evs = [...events].sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.type).localeCompare(String(b.type)));
  const out = [];
  for (const e of [...evs.filter((x) => x.type === 'lead_submitted'), ...evs]) if (e.leadId && !out.includes(e.leadId)) out.push(e.leadId);
  return out;
}

/** Build a SignalSession row from all events of one session (pure; events in any order). */
export function buildSession(projectId, sessionId, events, existing = null) {
  const evs = [...events].sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.type).localeCompare(String(b.type)));
  const visit = evs.find((e) => e.type === 'visit') || null;
  const pageviews = evs.filter((e) => e.type === 'pageview');
  const first = visit || pageviews[0] || evs[0];
  const pay = (e) => (e?.payload && typeof e.payload === 'object' ? e.payload : {});
  const withDevice = [visit, ...evs].find((e) => pay(e).device) || null;
  const withNet = [visit, ...evs].find((e) => pay(e).network) || null;
  const withTz = [visit, ...evs].find((e) => pay(e).tz || pay(e).tsLocal) || null;
  const visitorId = evs.find((e) => e.visitorId)?.visitorId ?? null;
  const engagements = evs.filter((e) => e.type === 'engagement');
  const engagedSec = engagements.reduce((n, e) => n + (Number(pay(e).engagement?.visibleSec) || 0), 0);
  const reasons = new Set();
  for (const e of evs) for (const r of pay(e).bot?.reason || []) reasons.add(r);
  const captureBotScore = Math.max(0, ...evs.map((e) => Number(e.botScore) || 0));
  const landing = first?.pagePath || '/';
  const touch = touchFromVisit({ at: first.at, refClass: first.refClass, refSource: first.refSource, utm: pay(visit).utm, landing });
  const tsLocal = pay(withTz).tsLocal;
  const leadIds = sessionLeadIds(evs);
  const compacted = evs.some((e) => e.payloadCompactedAt);
  const built = {
    projectId,
    sessionId,
    visitorId,
    startedAt: new Date(evs[0].at),
    endedAt: new Date(evs[evs.length - 1].at),
    landingPath: landing,
    exitPath: pageviews.length ? pageviews[pageviews.length - 1].pagePath : landing,
    pageviews: pageviews.length,
    engagedSec,
    engaged: engagements.length > 0 || pageviews.length >= 2,
    ctaClicks: evs.filter((e) => e.type === 'cta_click').length,
    formStarts: evs.filter((e) => e.type === 'form_start').length,
    refClass: touch.class,
    refSource: touch.source,
    utmCampaign: pay(visit).utm?.campaign ?? null,
    formFactor: pay(withDevice).device?.formFactor ?? null,
    uaFamily: pay(withDevice).device?.ua ?? null,
    country: first?.country ?? withNet?.country ?? null,
    region: pay(withNet).network?.region ?? null,
    city: pay(withNet).network?.city ?? null,
    tz: pay(withTz).tz ?? null,
    localHour: typeof tsLocal === 'string' ? Number(tsLocal.slice(11, 13)) : null,
    ipPrefix: pay(withNet).network?.ipPrefix ?? null,
    captureBotScore,
    botScore: Math.max(captureBotScore, Number(existing?.rescoreBotScore) || 0),
    botReasons: [...reasons],
    sessionOnly: !visitorId,
    // the first lead; leadCount = every distinct lead of the session (LeadAttribution holds one row per lead)
    leadId: leadIds[0] ?? null,
    leadCount: leadIds.length,
    touch,
  };
  if (existing && compacted) {
    // Some payloads are already compacted (or rows deleted after compaction): never lose what the session held.
    for (const k of ['pageviews', 'engagedSec', 'ctaClicks', 'formStarts']) built[k] = Math.max(built[k], Number(existing[k]) || 0);
    for (const k of ['formFactor', 'uaFamily', 'region', 'city', 'tz', 'localHour', 'ipPrefix', 'utmCampaign', 'country']) if (built[k] == null) built[k] = existing[k] ?? null;
    if (new Date(existing.startedAt) < built.startedAt) {
      built.startedAt = new Date(existing.startedAt);
      built.landingPath = existing.landingPath;
      built.touch = existing.touch;
      built.refClass = existing.refClass;
      built.refSource = existing.refSource;
    }
    if (new Date(existing.endedAt) > built.endedAt) built.endedAt = new Date(existing.endedAt);
    built.engaged = built.engaged || existing.engaged === true;
  }
  return built;
}

/** Rebuild one session from its events and upsert it. Returns the dates touched. */
export async function rebuildSession(projectId, sessionId) {
  const events = await prisma.signalEvent.findMany({ where: { projectId, sessionId }, orderBy: { at: 'asc' }, take: 5000, select: SESSION_FIELDS });
  if (!events.length) return [];
  const existing = await prisma.signalSession.findUnique({ where: { projectId_sessionId: { projectId, sessionId } } });
  const s = buildSession(projectId, sessionId, events, existing);
  let isNewVisitor = false;
  if (s.visitorId) {
    const earlier = await prisma.signalSession.findFirst({ where: { projectId, visitorId: s.visitorId, startedAt: { lt: s.startedAt }, NOT: { sessionId } }, select: { id: true } });
    isNewVisitor = !earlier;
  }
  const data = { ...s, isNewVisitor };
  const { projectId: _p, sessionId: _s, ...update } = data;
  await prisma.signalSession.upsert({ where: { projectId_sessionId: { projectId, sessionId } }, create: data, update });
  const dates = [s.startedAt];
  if (existing && new Date(existing.startedAt).getTime() !== s.startedAt.getTime()) dates.push(existing.startedAt);
  if (s.visitorId && isNewVisitor) {
    // An earlier session arrived late: later sessions of the visitor are not new any more.
    const later = await prisma.signalSession.findMany({ where: { projectId, visitorId: s.visitorId, startedAt: { gt: s.startedAt }, isNewVisitor: true }, select: { startedAt: true } });
    if (later.length) {
      await prisma.signalSession.updateMany({ where: { projectId, visitorId: s.visitorId, startedAt: { gt: s.startedAt }, isNewVisitor: true }, data: { isNewVisitor: false } });
      for (const l of later) dates.push(l.startedAt);
    }
  }
  // Lead attributions to (re-)derive: EVERY lead of this session, and the visitor's leads (first touch may change).
  const leadIds = sessionLeadIds(events);
  if (leadIds.length) await prisma.leadAttribution.updateMany({ where: { projectId, siteLeadId: { in: leadIds } }, data: { needsDerive: true } });
  if (s.visitorId) await prisma.leadAttribution.updateMany({ where: { projectId, visitorId: s.visitorId }, data: { needsDerive: true } });
  return dates;
}

/** One claim → rebuild → confirm cycle. Returns the number of events sessionized. */
export async function sessionizeOnce({ now = new Date(), limit = SESSIONIZE_BATCH, jitter } = {}) {
  const ids = await prisma.signalEvent.findMany({ where: { sessionizedAt: null }, orderBy: { at: 'asc' }, take: limit, select: { id: true } });
  if (!ids.length) return 0;
  const claim = claimValue(now, jitter);
  const claimed = await prisma.signalEvent.updateMany({ where: { id: { in: ids.map((r) => r.id) }, sessionizedAt: null }, data: { sessionizedAt: claim } });
  if (!Number(claimed?.count)) return 0;
  const rows = await prisma.signalEvent.findMany({ where: { sessionizedAt: claim }, select: { projectId: true, sessionId: true } });
  const keys = new Map();
  for (const r of rows) keys.set(`${r.projectId}\u0000${r.sessionId}`, r);
  const dirty = new Map();
  for (const { projectId, sessionId } of keys.values()) {
    const dates = await rebuildSession(projectId, sessionId);
    if (!dirty.has(projectId)) dirty.set(projectId, []);
    dirty.get(projectId).push(...dates);
  }
  for (const [projectId, dates] of dirty) await markDirty(projectId, dates);
  await prisma.signalEvent.updateMany({ where: { sessionizedAt: claim }, data: { sessionizedAt: now } });
  return rows.length;
}

/** The 5-minute job: release stale claims, then claim batches until drained (≤ maxBatches per run). */
export async function runSessionizer({ now = new Date(), maxBatches = 20, log } = {}) {
  await releaseStaleClaims(now);
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const n = await sessionizeOnce({ now });
    total += n;
    if (n < SESSIONIZE_BATCH) break;
  }
  if (total) log?.info?.({ events: total }, 'signals.sessionize');
  return total;
}

export { CLAIM_CEILING };
