/**
 * Contract v1.7.0 §38.7 / plan §5.5: erasure of visit signals.
 * - By visitorId (admin, OWNER / PM, human only): the OS erases ITS copy first (every SignalEvent and SignalSession of
 *   the visitor, LeadAttribution.visitorId nulled), writes a SignalErasure (hash only), then calls the site's
 *   `signals-erase { visitorId }`; when the site cannot be reached the call is retried by the leader-only job
 *   (backoff 15 min doubling to 24 h, 10 attempts) until acknowledged (`signals.erased` also acknowledges it). The
 *   erasure never waits for the site. Aggregates are untouched (they hold no identifiers).
 * - By leadId: the lead erasure path (lib/cmsLeads.js eraseLocalLead) deletes the LeadAttribution in the same
 *   transaction as the lead and nulls SignalEvent.leadId; a session that still holds ANOTHER lead keeps it (leadId =
 *   its next lead, leadCount − 1, O-R3B-3), a session with no lead left gets leadId null (`leadErasureOps`). The site's
 *   `lead-erase` clears the lead's attribution on the site (§38.5), so no extra site call is needed.
 */
import { prisma } from '../prisma.js';
import { CmsBridgeError, emdashRoutes, osActor } from '../siteAdapters/emdash.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { isVisitorId, SIGNALS_ERASE_REASONS } from './validate.js';
import { sha256 } from './ingest.js';
import { sessionLeadIds } from './sessionize.js';
import { markDirty } from './common.js';

export const SIGNAL_ERASE_MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 15 * 60_000;
const MAX_DELAY_MS = 24 * 3600_000;
export const signalEraseDelayMs = (attempts) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

/** Our copy of one visitor: rows deleted, attribution unlinked. Returns counts (no identifiers). */
export async function eraseVisitorLocal(projectId, visitorId, db = prisma) {
  const [events, sessions, attributions] = await Promise.all([
    db.signalEvent.deleteMany({ where: { projectId, visitorId } }),
    db.signalSession.deleteMany({ where: { projectId, visitorId } }),
    db.leadAttribution.updateMany({ where: { projectId, visitorId }, data: { visitorId: null } }),
  ]);
  return { events: Number(events?.count) || 0, sessions: Number(sessions?.count) || 0, attributions: Number(attributions?.count) || 0 };
}

/**
 * O-R3B-3: read BEFORE a lead erasure. Every session that names the lead (on the session or on one of its events) and
 * still holds another lead afterwards, or names the erased lead only as a later lead: its lead fields after the
 * erasure ({ sessionId, leadId: the next first lead, leadCount }). Sessions left without a lead are not listed (the
 * bulk update in leadErasureOps clears them).
 */
export async function leadSessionRelinks(projectId, siteLeadId, db = prisma) {
  const [onSessions, onEvents] = await Promise.all([
    db.signalSession.findMany({ where: { projectId, leadId: siteLeadId }, select: { sessionId: true }, take: 1000 }),
    db.signalEvent.findMany({ where: { projectId, leadId: siteLeadId }, select: { sessionId: true }, distinct: ['sessionId'], take: 1000 }),
  ]);
  const sessionIds = [...new Set([...onSessions, ...onEvents].map((r) => r.sessionId))];
  if (!sessionIds.length) return [];
  const others = await db.signalEvent.findMany({
    where: { projectId, sessionId: { in: sessionIds }, leadId: { not: null }, NOT: { leadId: siteLeadId } },
    select: { sessionId: true, type: true, at: true, leadId: true },
    take: 5000,
  });
  const out = [];
  for (const sessionId of sessionIds) {
    const ids = sessionLeadIds(others.filter((e) => e.sessionId === sessionId));
    if (ids.length) out.push({ sessionId, leadId: ids[0], leadCount: ids.length });
  }
  return out;
}

/**
 * The signal side of a lead erasure, as Prisma operations to run INSIDE the lead's transaction (array form):
 * LeadAttribution deleted, lead links on events nulled, sessions of that lead left with no lead cleared; sessions that
 * still hold another lead are re-pointed from `relinks` (leadSessionRelinks, read before the transaction), so a
 * session is never marked lead-less while another lead still references it. The visits stay.
 */
export function leadErasureOps(db, projectId, siteLeadId, relinks = []) {
  return [
    db.leadAttribution.deleteMany({ where: { projectId, siteLeadId } }),
    db.signalEvent.updateMany({ where: { projectId, leadId: siteLeadId }, data: { leadId: null } }),
    db.signalSession.updateMany({ where: { projectId, leadId: siteLeadId }, data: { leadId: null, leadCount: 0 } }),
    ...relinks.map((r) => db.signalSession.updateMany({ where: { projectId, sessionId: r.sessionId }, data: { leadId: r.leadId, leadCount: r.leadCount } })),
  ];
}

/**
 * Read before a lead erasure: the session relinks (leadSessionRelinks) and the lead's day, so the rollups that counted
 * the lead are recomputed after it is gone (afterLeadErasure → SignalRollupDirty).
 */
export async function prepareLeadErasure(projectId, siteLeadId, db = prisma) {
  const [relinks, attr] = await Promise.all([
    leadSessionRelinks(projectId, siteLeadId, db),
    db.leadAttribution.findFirst({ where: { projectId, siteLeadId }, select: { leadAt: true } }),
  ]);
  return { relinks, dates: attr?.leadAt ? [attr.leadAt] : [] };
}

/** After the lead-erasure transaction: mark the lead's day dirty (the nightly rollup drops its count). */
export async function afterLeadErasure(projectId, prep) {
  if (prep?.dates?.length) await markDirty(projectId, prep.dates).catch(() => {});
}

/** Lead signals only (site-side `signals.erased {kind: leadId}`): the lead row itself stays. */
export async function eraseLeadSignalsLocal(projectId, siteLeadId) {
  const prep = await prepareLeadErasure(projectId, siteLeadId);
  const [attr] = await prisma.$transaction(leadErasureOps(prisma, projectId, siteLeadId, prep.relinks));
  await afterLeadErasure(projectId, prep);
  return { events: 0, sessions: 0, attributions: Number(attr?.count) || 0 };
}

const actorOf = (user) => ({ kind: 'human', osUserId: String(user?.id || ''), name: String(user?.name || 'Agency OS user').slice(0, 200), ...(user?.role ? { role: user.role } : {}) });

async function callSiteErase(row, actor, opts) {
  const { conn } = await loadEmdashConnection(row.projectId);
  return emdashRoutes.signalsErase(conn, { visitorId: row.pendingSubject, reason: row.reason || 'other', actor }, { retryDelays: [], idempotencyKey: `sigerase-${row.id}`, ...opts });
}

/**
 * Admin erasure of one visitor (subject request). OS copy first; then the site (retried until acknowledged).
 * @returns {{ erased: true, rows: {events, sessions, attributions}, site: 'done'|'pending'|'none', siteRows: number|null }}
 */
export async function eraseVisitor({ projectId, visitorId, reason, user, log }) {
  if (!isVisitorId(visitorId)) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Enter a visitor id (v_ followed by 26 characters).' });
  if (!SIGNALS_ERASE_REASONS.includes(reason)) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Choose a reason.' });
  const rows = await eraseVisitorLocal(projectId, visitorId);
  const row = await prisma.signalErasure.create({
    data: {
      projectId,
      kind: 'visitorId',
      subjectHash: sha256(visitorId),
      reason,
      origin: 'os',
      rowsEvents: rows.events,
      rowsSessions: rows.sessions,
      rowsAttributions: rows.attributions,
      actor: actorOf(user),
      siteState: 'pending',
      siteNextAt: new Date(Date.now() + BASE_DELAY_MS),
      pendingSubject: visitorId,
    },
  });
  try {
    const res = await callSiteErase(row, osActor(user));
    await prisma.signalErasure.update({ where: { id: row.id }, data: { siteState: 'done', siteRows: Number.isInteger(res?.rows) ? res.rows : null, pendingSubject: null, siteNextAt: null } });
    log?.info?.({ projectId }, 'Signals visitor erased (OS and site)');
    return { erased: true, rows, site: 'done', siteRows: Number.isInteger(res?.rows) ? res.rows : null, alreadyGone: res?.alreadyGone === true };
  } catch (err) {
    const code = err instanceof CmsBridgeError ? err.code : 'NETWORK';
    if (code === 'NOT_IMPLEMENTED') {
      // The site has no signals module (nothing stored there): nothing is owed.
      await prisma.signalErasure.update({ where: { id: row.id }, data: { siteState: 'none', siteLastError: code, pendingSubject: null, siteNextAt: null } });
      return { erased: true, rows, site: 'none', siteRows: null };
    }
    await prisma.signalErasure.update({ where: { id: row.id }, data: { siteLastError: String(code).slice(0, 40) } });
    log?.warn?.({ projectId, code }, 'Signals visitor erased in the OS; the site erase is pending');
    return { erased: true, rows, site: 'pending', siteRows: null };
  }
}

/** Leader-only: retry owed site erasures (≤ limit per run). The OS erasure job calls as actor kind "system". */
export async function retryPendingSignalErasures({ now = new Date(), limit = 20, log } = {}) {
  const rows = await prisma.signalErasure.findMany({
    where: { siteState: 'pending', siteNextAt: { lte: now } },
    orderBy: { at: 'asc' },
    take: limit,
  });
  const out = { tried: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (!row.pendingSubject) continue;
    const p = await prisma.project.findUnique({ where: { id: row.projectId }, select: { cmsRepairNeededAt: true } }).catch(() => null);
    if (!p || p.cmsRepairNeededAt) continue; // no call with keys of a site that needs re-pairing; no attempt used
    out.tried += 1;
    const attempts = (row.siteAttempts || 0) + 1;
    const stored = row.actor && typeof row.actor === 'object' ? row.actor : {};
    const actor = { kind: 'system', osUserId: String(stored.osUserId || ''), name: 'Agency OS erasure job', ...(stored.role ? { role: stored.role } : {}) };
    try {
      const res = await callSiteErase(row, actor);
      await prisma.signalErasure.update({ where: { id: row.id }, data: { siteState: 'done', siteAttempts: attempts, siteRows: Number.isInteger(res?.rows) ? res.rows : null, pendingSubject: null, siteNextAt: null, siteLastError: null } });
      out.done += 1;
    } catch (err) {
      const code = err instanceof CmsBridgeError ? err.code : 'NETWORK';
      if (code === 'NOT_IMPLEMENTED') {
        await prisma.signalErasure.update({ where: { id: row.id }, data: { siteState: 'none', siteAttempts: attempts, siteLastError: code, pendingSubject: null, siteNextAt: null } });
        out.done += 1;
        continue;
      }
      const last = attempts >= SIGNAL_ERASE_MAX_ATTEMPTS;
      await prisma.signalErasure.update({
        where: { id: row.id },
        data: {
          siteAttempts: attempts,
          siteLastError: String(code).slice(0, 40),
          siteState: last ? 'failed' : 'pending',
          siteNextAt: last ? null : new Date(now.getTime() + signalEraseDelayMs(attempts)),
          ...(last ? { pendingSubject: null } : {}),
        },
      });
      if (last) out.failed += 1;
    }
  }
  if (out.tried) log?.info?.(out, 'Signals site-erase retries');
  return out;
}
