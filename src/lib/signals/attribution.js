/**
 * Contract v1.7.0 §38.5 / plan §5.2–§5.3, §6.3: lead attribution.
 * - Site snapshot: `lead.created.lead.attribution` (with the lead) and `lead.attributed` (right after) upsert
 *   LeadAttribution.siteSnapshot keyed on our CmsLead; first write wins per field (a later event only fills gaps; a
 *   cookie-only model may be upgraded to site-snapshot). An attribution for a lead we do not hold yet is NOT inserted
 *   orphaned: the event is refused as retryable so the site's outbox parks it and re-sends it (after lead.created).
 * - OS derivation (`signals.attribute`, leader-only, every 5 min after the sessionizer): first touch = the visitor's
 *   earliest session touch within 13 months; last touch = the lead session's touch, except that direct / internal /
 *   unknown never overwrite a known non-direct touch of the visitor within 30 days ("last non-direct click");
 *   pathSummary (≤ 20 pages of the lead session), sessions / pageviews before the lead, time to lead; `mismatch` when
 *   the derived last-touch source differs from the site snapshot's.
 * - The record sentence: "Came from ChatGPT → landed on /spa-services/ → 2 pages in 4 min → quote form (contact panel)".
 */
import { prisma } from '../prisma.js';
import { sanitizeLeadAttribution, sanitizeLeadPath, isLeadId } from './validate.js';
import { addMonths, addDays, markDirty, isNonDirect, sourceLabel, DAY_MS } from './common.js';

const RANK = { 'cookie-only': 1, 'site-snapshot': 2, 'os-derived': 3 };

/** First write wins per field (null / missing = gap); the model may only move up (cookie-only → site-snapshot). */
export function mergeSnapshot(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (k === 'model') continue;
    if (out[k] === null || out[k] === undefined) out[k] = v;
  }
  out.model = (RANK[next.model] || 0) > (RANK[prev.model] || 0) && next.model !== 'os-derived' ? next.model : prev.model;
  // a cookie-only snapshot upgraded from the site buffer: its touches are better than the cookie's
  if (prev.model === 'cookie-only' && next.model === 'site-snapshot') {
    if (next.lastTouch) out.lastTouch = next.lastTouch;
    if (next.firstTouch) out.firstTouch = next.firstTouch;
  }
  return out;
}

/** Effective scalars from the snapshot when nothing is derived yet. */
function snapshotScalars(snap) {
  const lt = snap?.lastTouch;
  return {
    lastClass: lt?.class || 'unknown',
    lastSource: (lt?.source || '').slice(0, 64),
    landingPath: snap?.landing || lt?.landing || null,
  };
}

/**
 * Upsert the site's snapshot for one stored CmsLead (row `{ id, projectId, leadId, siteCreatedAt, receivedAt }`).
 * `attribution` and `path` are RAW contract values (sanitized here). Returns 'applied' | 'stale'.
 */
export async function upsertSiteAttribution(lead, { attribution, path = null, heardFrom = null }, db = prisma) {
  const snap = sanitizeLeadAttribution(attribution);
  const pth = path ? sanitizeLeadPath(path) : null;
  if (!snap && !pth && !heardFrom) return 'stale';
  const existing = await db.leadAttribution.findUnique({ where: { leadRowId: lead.id } });
  const leadAt = lead.siteCreatedAt || lead.receivedAt || new Date();
  const merged = mergeSnapshot(existing?.siteSnapshot || null, snap);
  const derived = existing?.model === 'os-derived';
  const data = {
    siteSnapshot: merged,
    ...(pth && !existing?.sitePath ? { sitePath: pth } : {}),
    visitorId: existing?.visitorId ?? merged?.visitorId ?? null,
    sessionId: existing?.sessionId ?? merged?.sessionId ?? null,
    formId: existing?.formId ?? merged?.formId ?? null,
    placement: existing?.placement ?? merged?.placement ?? null,
    ...(heardFrom && !existing?.heardFrom ? { heardFrom: String(heardFrom).slice(0, 100) } : {}),
    // the effective model / touch follow the snapshot until the OS derived its own
    ...(derived ? {} : { model: merged?.model || 'cookie-only', ...snapshotScalars(merged) }),
    needsDerive: true,
  };
  if (existing) {
    await db.leadAttribution.update({ where: { id: existing.id }, data });
  } else {
    await db.leadAttribution.create({
      data: { projectId: lead.projectId, leadRowId: lead.id, siteLeadId: lead.leadId, leadAt, model: merged?.model || 'cookie-only', ...snapshotScalars(merged), ...data },
    });
  }
  await markDirty(lead.projectId, [leadAt], db);
  return 'applied';
}

/**
 * lead.attributed (§38.5). Throws a retryable error when the CmsLead is not stored yet (the site's outbox parks it);
 * an erased lead (tombstone) never gets an attribution again ('stale').
 */
export async function applyLeadAttributed(project, ev) {
  const d = ev.data;
  if (!d || !isLeadId(d.leadId)) throw Object.assign(new Error('data.leadId is invalid'), { code: 'VALIDATION' });
  const lead = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId: project.id, leadId: d.leadId } }, select: { id: true, projectId: true, leadId: true, siteCreatedAt: true, receivedAt: true, erasedAt: true } });
  if (!lead) throw Object.assign(new Error('lead not stored yet'), { code: 'LEAD_NOT_STORED' });
  if (lead.erasedAt) return 'stale';
  if (!sanitizeLeadAttribution(d.attribution)) throw Object.assign(new Error('data.attribution is invalid'), { code: 'VALIDATION' });
  return upsertSiteAttribution(lead, { attribution: d.attribution, path: d.path });
}

/** heard_from from lead.fields.extra (one of the form's options; plain text). */
export function heardFromOf(lead) {
  const v = lead?.fields?.extra?.heard_from;
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null;
}

const sessionTouch = (s) => (s?.touch && typeof s.touch === 'object' ? s.touch : null);

/**
 * Derive one LeadAttribution from the sessions (pure given the loaded rows; exported for tests).
 * @param {object} row LeadAttribution  @param {object|null} leadSession  @param {object[]} visitorSessions (asc by startedAt)
 * @param {object[]} leadPageviews SignalEvent rows (pageview) of the lead session, asc by at
 */
export function deriveAttribution(row, leadSession, visitorSessions, leadPageviews) {
  const leadAt = new Date(row.leadAt).getTime();
  const before = visitorSessions.filter((s) => new Date(s.startedAt).getTime() <= new Date(leadSession.startedAt).getTime());
  const earliest = before.filter((s) => new Date(s.startedAt).getTime() >= addMonths(row.leadAt, -13).getTime());
  const firstTouch = sessionTouch(earliest[0]) || sessionTouch(leadSession);
  let lastTouch = sessionTouch(leadSession);
  if (!isNonDirect(lastTouch)) {
    // last non-direct click within 30 days
    const cutoff = leadAt - 30 * DAY_MS;
    for (let i = before.length - 1; i >= 0; i -= 1) {
      const s = before[i];
      const t = sessionTouch(s);
      if (new Date(s.startedAt).getTime() < cutoff) break;
      if (isNonDirect(t)) {
        lastTouch = t;
        break;
      }
    }
  }
  const pages = leadPageviews.filter((e) => new Date(e.at).getTime() <= leadAt).slice(0, 20).map((e) => ({ path: e.pagePath, at: new Date(e.at).toISOString() }));
  const snapSource = row.siteSnapshot?.lastTouch?.source || null;
  return {
    model: 'os-derived',
    firstTouch,
    lastTouch,
    lastClass: lastTouch?.class || 'unknown',
    lastSource: (lastTouch?.source || '').slice(0, 64),
    landingPath: (lastTouch === sessionTouch(leadSession) ? leadSession.landingPath : lastTouch?.landing) || leadSession.landingPath || null,
    sessionId: leadSession.sessionId,
    visitorId: leadSession.visitorId ?? null,
    country: leadSession.country ?? null,
    region: leadSession.region ?? null,
    formFactor: leadSession.formFactor ?? null,
    pathSummary: pages,
    pageviewsBeforeLead: pages.length,
    sessionsBeforeLead: Math.max(0, before.length - 1),
    timeToLeadSec: firstTouch?.at ? Math.max(0, Math.round((leadAt - Date.parse(firstTouch.at)) / 1000)) : null,
    sessionToLeadSec: Math.max(0, Math.round((leadAt - new Date(leadSession.startedAt).getTime()) / 1000)),
    mismatch: !!(snapSource && lastTouch?.source && snapSource !== lastTouch.source),
  };
}

/** Leader-only `signals.attribute` (every 5 min after the sessionizer). Bounded per run. */
export async function attributeLeads({ limit = 500, now = new Date(), log } = {}) {
  const rows = await prisma.leadAttribution.findMany({ where: { needsDerive: true }, orderBy: { createdAt: 'asc' }, take: limit });
  let derived = 0;
  for (const row of rows) {
    let leadSession = null;
    if (row.sessionId) leadSession = await prisma.signalSession.findUnique({ where: { projectId_sessionId: { projectId: row.projectId, sessionId: row.sessionId } } });
    if (!leadSession) {
      // O-R3B-3: SignalSession.leadId names the session's FIRST lead only; the lead's own event names its session.
      const ev =
        (await prisma.signalEvent.findFirst({ where: { projectId: row.projectId, leadId: row.siteLeadId, type: 'lead_submitted' }, orderBy: { at: 'asc' }, select: { sessionId: true } })) ||
        (await prisma.signalEvent.findFirst({ where: { projectId: row.projectId, leadId: row.siteLeadId }, orderBy: { at: 'asc' }, select: { sessionId: true } }));
      if (ev) leadSession = await prisma.signalSession.findUnique({ where: { projectId_sessionId: { projectId: row.projectId, sessionId: ev.sessionId } } });
    }
    if (!leadSession) leadSession = await prisma.signalSession.findFirst({ where: { projectId: row.projectId, leadId: row.siteLeadId }, orderBy: { startedAt: 'desc' } });
    if (!leadSession) {
      // Nothing to derive from yet (cookie-only, or the session is not sessionized yet): the sessionizer flags the row
      // again when the session arrives. The snapshot stays the effective attribution.
      await prisma.leadAttribution.update({ where: { id: row.id }, data: { needsDerive: false } });
      continue;
    }
    const visitorId = leadSession.visitorId;
    const visitorSessions = visitorId
      ? await prisma.signalSession.findMany({
          where: { projectId: row.projectId, visitorId, startedAt: { gte: addMonths(row.leadAt, -13), lte: addDays(row.leadAt, 1) } },
          orderBy: { startedAt: 'asc' },
          take: 500,
        })
      : [leadSession];
    if (!visitorSessions.some((s) => s.sessionId === leadSession.sessionId)) visitorSessions.push(leadSession);
    visitorSessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    const pageviews = await prisma.signalEvent.findMany({
      where: { projectId: row.projectId, sessionId: leadSession.sessionId, type: 'pageview' },
      orderBy: { at: 'asc' },
      take: 200,
      select: { pagePath: true, at: true },
    });
    const d = deriveAttribution(row, leadSession, visitorSessions, pageviews);
    await prisma.leadAttribution.update({ where: { id: row.id }, data: { ...d, needsDerive: false, derivedAt: now } });
    await markDirty(row.projectId, [row.leadAt]);
    derived += 1;
  }
  if (derived) log?.info?.({ derived }, 'signals.attribute');
  return { derived, scanned: rows.length };
}

const fmtMinutes = (sec) => {
  if (!Number.isFinite(sec)) return null;
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

function formWords(a) {
  const form = a.formId === 'quote' || !a.formId ? 'quote form' : `${a.formId} form`;
  return a.placement ? `${form} (${String(a.placement).replace(/_/g, ' ')})` : form;
}

/**
 * The lead record lines (plan §6.3), plain text. Client view: `lines` only. Agency view adds `model`, `mismatch`,
 * `sessionId` (link to the session timeline), `heardFrom`.
 */
export function attributionSentence(a) {
  if (!a) return null;
  const lt = a.lastTouch || a.siteSnapshot?.lastTouch || null;
  const ft = a.firstTouch || a.siteSnapshot?.firstTouch || null;
  const lines = [];
  if (a.model === 'cookie-only' && !a.pathSummary?.length) {
    lines.push(lt ? `Source recorded on the website: ${sourceLabel(lt.class, lt.source)}` : 'Source recorded on the website: unknown');
  } else if (lt) {
    const parts = [`Came from ${sourceLabel(lt.class, lt.source)}`];
    const landing = a.landingPath || lt.landing;
    if (landing) parts.push(`landed on ${landing}`);
    const pages = Array.isArray(a.pathSummary) && a.pathSummary.length ? a.pathSummary.length : Array.isArray(a.sitePath?.pagesBefore) ? a.sitePath.pagesBefore.length : null;
    const dur = fmtMinutes(a.sessionToLeadSec ?? a.sitePath?.sessionToLeadSec);
    if (pages) parts.push(`${pages} page${pages === 1 ? '' : 's'}${dur ? ` in ${dur}` : ''}`);
    parts.push(formWords(a));
    lines.push(parts.join(' → '));
  } else {
    lines.push('Source not recorded');
  }
  if (ft && lt && (ft.at !== lt.at || ft.source !== lt.source)) {
    const days = Math.round((Date.parse(lt.at) - Date.parse(ft.at)) / DAY_MS);
    const when = days >= 1 ? `${days} day${days === 1 ? '' : 's'} earlier` : 'earlier the same day';
    lines.push(`First visit ${when} from ${sourceLabel(ft.class, ft.source)}${ft.landing ? ` (${ft.landing})` : ''}`);
  }
  return lines;
}

/** Client-safe attribution of one lead: the sentences and the "heard from" answer only (no ids, no paths beyond landing). */
export function clientAttribution(a) {
  if (!a) return null;
  return { lines: attributionSentence(a), heardFrom: a.heardFrom || null, channel: a.lastClass };
}

/** Agency view. */
export function staffAttribution(a) {
  if (!a) return null;
  return {
    lines: attributionSentence(a),
    heardFrom: a.heardFrom || null,
    model: a.model,
    mismatch: a.mismatch === true,
    sessionId: a.sessionId || null,
    lastClass: a.lastClass,
    lastSource: a.lastSource || null,
    siteLastSource: a.siteSnapshot?.lastTouch?.source || null,
    derivedAt: a.derivedAt || null,
  };
}
