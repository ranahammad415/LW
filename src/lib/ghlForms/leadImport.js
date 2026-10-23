/**
 * Contract 1.9.0 §40: `lead-import` (OS → site mutation, capability leadImport): a read-only mirror of an OS
 * GoHighLevel lead in the site's leads collection, so the site admin sees it with its page path / attribution.
 *
 * Queue = CmsLead.mirrorState (pending | sending | done | failed | skipped | cancelled) + mirrorNextAt + mirrorAttempts.
 * Leader-only job every minute (ghlForms/jobs.js), ≤ 20 leads per run; claim = compare-and-set pending → sending;
 * a "sending" claim older than 10 minutes (process died) is released.
 * Retries: 1 min, 5 min, 30 min, 2 h, 12 h after the first try, then `failed` (6 calls in about 15 h, inside the site's
 * 24 h idempotency retention). Staff "Retry" (OWNER / PM, people only) re-queues failed / skipped / pending leads and
 * sends at once as the person (actor kind human).
 *
 * Idempotency key: a UUID derived from (provider, contact id, site form id, OS lead id), the same on every retry of
 * the same lead (the site also de-duplicates on (provider, contact id, formId) itself).
 * Actor of the job: kind "system" (contract §40.1 example; an ordinary osActor), name "Agency OS lead import",
 * osUserId = the project's lead PM, else the first human OWNER (an accountable person, as the erasure job does), else
 * a fixed automation UUID.
 *
 * Errors: 403 HUMAN_ONLY / 400 / 422 VALIDATION / 409 IDEMPOTENCY_MISMATCH → failed (no retry); 501 NOT_IMPLEMENTED →
 * skipped (no capability) or, with details.reason "schema", retried (the site admin must apply the leads schema);
 * 409 IDEMPOTENCY_IN_PROGRESS, 429, 5xx, network → retried. The site's attribution in the response only fills gaps.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { CmsBridgeError, emdashRoutes } from '../siteAdapters/emdash.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { upsertSiteAttribution } from '../signals/attribution.js';
import { isSessionId, isVisitorId } from '../signals/validate.js';
import { SITE_ERASE_PENDING } from '../cmsLeads.js';

export const LEAD_IMPORT_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000]);
export const LEAD_IMPORT_MAX_ATTEMPTS = LEAD_IMPORT_RETRY_DELAYS_MS.length + 1;
export const SENDING_STALE_MS = 10 * 60_000;
export const LEAD_IMPORT_SYSTEM_USER_ID = '3b6f0c52-9d1e-4a7b-8c2f-1e5d6a7b8c90';
const LEAD_IMPORT_NAME = 'Agency OS lead import';

const s = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : undefined);
const sitePathOrNull = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v.slice(0, 2048) : null);

/** Deterministic UUID-shaped idempotency key (contract §7: a UUID, the same on every retry). */
export function leadImportIdempotencyKey(lead) {
  const h = crypto.createHash('sha256').update(['lead-import', lead.provider || 'ghl', lead.externalId || '', lead.formId || '', lead.leadId].join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The request body (lead-import.request schema). `lead` = CmsLead row with its attribution. */
export function buildLeadImportBody(lead, actor) {
  const f = lead.fields && typeof lead.fields === 'object' ? lead.fields : {};
  const extra = {};
  if (f.extra && typeof f.extra === 'object') {
    for (const [k, v] of Object.entries(f.extra).slice(0, 20)) if (typeof v === 'string' && v) extra[String(k).slice(0, 64)] = v.slice(0, 500);
  }
  const fields = {};
  for (const [k, max] of [['name', 200], ['phone', 40], ['email', 254], ['town', 100], ['postalCode', 20], ['message', 2000]]) {
    const v = s(f[k], max);
    if (v !== undefined) fields[k] = v;
  }
  if (Object.keys(extra).length) fields.extra = extra;
  const a = lead.attribution || null;
  const snap = a?.siteSnapshot && typeof a.siteSnapshot === 'object' ? a.siteSnapshot : null;
  // only the visit ids the form itself carried (oa_sid / oa_vid), never a ±10 min guess
  const sid = snap?.sessionId && isSessionId(snap.sessionId) ? snap.sessionId : null;
  const vid = snap?.visitorId && isVisitorId(snap.visitorId) ? snap.visitorId : null;
  const utm = lead.utm && typeof lead.utm === 'object' ? lead.utm : null;
  const extUrl = typeof lead.externalUrl === 'string' && lead.externalUrl.startsWith('https://') ? lead.externalUrl.slice(0, 500) : null;
  return {
    lead: {
      externalRef: { provider: 'ghl', id: String(lead.externalId || lead.leadId).slice(0, 64), url: extUrl },
      osLeadId: lead.leadId,
      formId: lead.formId,
      ...(lead.formName ? { formName: String(lead.formName).slice(0, 200) } : {}),
      createdAt: new Date(lead.siteCreatedAt || lead.receivedAt).toISOString(),
      fields,
      signals: sid ? { sid, vid } : null,
      utm: utm ? Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, typeof utm[k] === 'string' ? utm[k].slice(0, 200) : null])) : null,
      pagePath: sitePathOrNull(lead.sourcePath),
      landing: sitePathOrNull(snap?.landing),
    },
    actor,
  };
}

/** The job's actor: kind system on behalf of the project's lead PM / an OWNER (see header). */
export async function systemActor(projectId, db = prisma) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { leadPmId: true } }).catch(() => null);
  let userId = p?.leadPmId || null;
  if (!userId) {
    const owner = await db.user.findFirst({ where: { role: 'OWNER', isAgent: false }, orderBy: { createdAt: 'asc' }, select: { id: true } }).catch(() => null);
    userId = owner?.id || null;
  }
  return { kind: 'system', osUserId: userId || LEAD_IMPORT_SYSTEM_USER_ID, name: LEAD_IMPORT_NAME };
}

export const humanActor = (user) => ({ kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), ...(user.role ? { role: user.role } : {}) });

/** How an error ends this attempt: 'retry' | 'failed' | 'skipped'. */
export function classifyLeadImportError(err) {
  if (!(err instanceof CmsBridgeError)) return 'retry';
  if (err.code === 'NOT_IMPLEMENTED') return err.details?.reason === 'schema' ? 'retry' : 'skipped';
  if (err.code === 'IDEMPOTENCY_IN_PROGRESS' || err.code === 'RATE_LIMITED') return 'retry';
  if (['HUMAN_ONLY', 'VALIDATION', 'IDEMPOTENCY_MISMATCH', 'FORBIDDEN', 'NOT_FOUND'].includes(err.code)) return 'failed';
  if (err.retryable || (err.status || 500) >= 500 || err.status === 401) return 'retry';
  return 'failed';
}

const LEAD_SELECT = {
  id: true, projectId: true, leadId: true, provider: true, formId: true, formName: true, sourcePath: true, utm: true, fields: true,
  siteCreatedAt: true, receivedAt: true, externalId: true, externalUrl: true, erasedAt: true, erasedReason: true,
  mirrorState: true, mirrorAttempts: true, mirrorNextAt: true, cmsMirrorLeadId: true,
  attribution: { select: { id: true, siteSnapshot: true } },
};

/**
 * Send one claimed lead (mirrorState already "sending"). Updates the row; returns the outcome
 * ('done' | 'retry' | 'failed' | 'skipped' | 'cancelled').
 */
export async function sendLeadImport(leadRowId, { actor = null, now = new Date(), siteRoutes = emdashRoutes, loadConn = loadEmdashConnection, log, db = prisma } = {}) {
  const lead = await db.cmsLead.findUnique({ where: { id: leadRowId }, select: LEAD_SELECT });
  if (!lead || lead.provider !== 'ghl') return 'cancelled';
  if (lead.erasedAt) {
    await db.cmsLead.updateMany({ where: { id: lead.id, mirrorState: 'sending' }, data: { mirrorState: 'cancelled', mirrorNextAt: null } });
    return 'cancelled';
  }
  const attempts = (lead.mirrorAttempts || 0) + 1;
  const project = await db.project.findUnique({ where: { id: lead.projectId }, select: { id: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true } });
  const finish = async (state, code = null, extra = {}) => {
    const retry = state === 'retry' && attempts < LEAD_IMPORT_MAX_ATTEMPTS;
    const next = state === 'retry' ? (retry ? 'pending' : 'failed') : state;
    const r = await db.cmsLead.updateMany({
      where: { id: lead.id, mirrorState: 'sending' },
      data: {
        mirrorState: next,
        mirrorAttempts: attempts,
        mirrorNextAt: next === 'pending' ? new Date(now.getTime() + LEAD_IMPORT_RETRY_DELAYS_MS[Math.min(attempts - 1, LEAD_IMPORT_RETRY_DELAYS_MS.length - 1)]) : null,
        mirrorError: code ? String(code).slice(0, 40) : null,
        ...extra,
      },
    });
    return { outcome: next === 'pending' ? 'retry' : next, updated: Number(r?.count) || 0 };
  };
  if (!project || project.cmsType !== 'EMDASH' || project.cmsCapabilities?.leadImport !== true) return (await finish('skipped', 'NO_CAPABILITY')).outcome;
  if (project.cmsRepairNeededAt) return (await finish('retry', 'REPAIR_NEEDED')).outcome;
  let conn;
  try {
    conn = (await loadConn(lead.projectId)).conn;
  } catch {
    return (await finish('retry', 'NOT_PAIRED')).outcome;
  }
  const body = buildLeadImportBody(lead, actor || (await systemActor(lead.projectId, db)));
  let res;
  try {
    res = await siteRoutes.leadImport(conn, body, { idempotencyKey: leadImportIdempotencyKey(lead), retryDelays: [] });
  } catch (err) {
    const how = classifyLeadImportError(err);
    const code = err instanceof CmsBridgeError ? (err.code === 'NOT_IMPLEMENTED' && err.details?.reason === 'schema' ? 'SITE_SCHEMA' : err.code) : 'NETWORK';
    log?.warn?.({ projectId: lead.projectId, code, attempts }, 'lead-import failed');
    return (await finish(how, code)).outcome;
  }
  const mirrorId = typeof res?.leadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(res.leadId) ? res.leadId : null;
  const done = await finish('done', null, mirrorId ? { cmsMirrorLeadId: mirrorId } : {});
  if (!done.updated) {
    // Erased (or cancelled) while the call ran: the mirror just created must go too (the leader housekeeping erases it).
    const now2 = await db.cmsLead.findUnique({ where: { id: lead.id }, select: { erasedAt: true, erasedReason: true } });
    if (now2?.erasedAt && mirrorId) {
      const reason = String(now2.erasedReason || 'other').replace(/^site_(pending|failed):/, '');
      await db.cmsLead.update({ where: { id: lead.id }, data: { cmsMirrorLeadId: mirrorId, erasedReason: `${SITE_ERASE_PENDING}${reason}`.slice(0, 32), utm: { siteErase: { attempts: 0, nextAt: now.toISOString(), lastError: 'ERASED_DURING_IMPORT', actor: body.actor } } } });
    }
    return 'cancelled';
  }
  // The site's attribution fills gaps only (first write wins per field; cookie-only may move up to site-snapshot).
  if (res?.attribution && lead.attribution) {
    await upsertSiteAttribution({ id: lead.id, projectId: lead.projectId, leadId: lead.leadId, siteCreatedAt: lead.siteCreatedAt, receivedAt: lead.receivedAt }, { attribution: res.attribution }, db).catch(() => {});
  }
  log?.info?.({ projectId: lead.projectId, created: res?.created === true, attempts }, 'lead-import done');
  return 'done';
}

/** Claim due leads (pending + due, or a stale sending claim) with compare-and-set and send them. Leader only. */
export async function runLeadImportQueue({ now = new Date(), limit = 20, log, db = prisma, ...opts } = {}) {
  // release claims of a process that died mid-call (read first: no write at all on an idle minute)
  const staleWhere = { mirrorState: 'sending', mirrorNextAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } };
  const stale = await db.cmsLead.findMany({ where: staleWhere, select: { id: true }, take: 50 });
  if (stale.length) await db.cmsLead.updateMany({ where: { ...staleWhere, id: { in: stale.map((r) => r.id) } }, data: { mirrorState: 'pending' } });
  const due = await db.cmsLead.findMany({ where: { mirrorState: 'pending', mirrorNextAt: { lte: now } }, orderBy: { mirrorNextAt: 'asc' }, take: limit, select: { id: true, mirrorNextAt: true } });
  const out = { claimed: 0, done: 0, retry: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const row of due) {
    const c = await db.cmsLead.updateMany({ where: { id: row.id, mirrorState: 'pending', mirrorNextAt: row.mirrorNextAt }, data: { mirrorState: 'sending', mirrorNextAt: now } });
    if (Number(c?.count) !== 1) continue;
    out.claimed += 1;
    const outcome = await sendLeadImport(row.id, { now, log, db, ...opts }).catch(async (err) => {
      log?.error?.({ code: err?.code || 'INTERNAL' }, 'lead-import job error');
      await db.cmsLead.updateMany({ where: { id: row.id, mirrorState: 'sending' }, data: { mirrorState: 'pending', mirrorNextAt: new Date(now.getTime() + LEAD_IMPORT_RETRY_DELAYS_MS[0]) } }).catch(() => {});
      return 'retry';
    });
    out[outcome] = (out[outcome] || 0) + 1;
  }
  if (out.claimed) log?.info?.(out, 'lead-import queue');
  return out;
}

/**
 * Staff "Retry" (OWNER / PM, people only; the route checks): re-queue and send now as the person. A done or
 * cancelled lead is not sent again. Returns { state, error }.
 */
export async function retryLeadImport(projectId, leadId, user, { now = new Date(), db = prisma, ...opts } = {}) {
  const lead = await db.cmsLead.findUnique({ where: { projectId_leadId: { projectId, leadId: String(leadId).slice(0, 64) } }, select: { id: true, provider: true, erasedAt: true, mirrorState: true } });
  if (!lead || lead.provider !== 'ghl') {
    const e = new Error('Unknown GoHighLevel lead.');
    e.status = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (lead.erasedAt || lead.mirrorState === 'done' || lead.mirrorState === 'cancelled') {
    const e = new Error(lead.erasedAt ? 'The lead was erased.' : lead.mirrorState === 'done' ? 'The site already has this lead.' : 'The mirror was cancelled.');
    e.status = 409;
    e.code = 'NOT_RETRYABLE';
    throw e;
  }
  const c = await db.cmsLead.updateMany({ where: { id: lead.id, mirrorState: { in: ['pending', 'failed', 'skipped'] } }, data: { mirrorState: 'sending', mirrorNextAt: now, mirrorAttempts: 0, mirrorError: null } });
  if (Number(c?.count) !== 1) {
    const e = new Error('The lead is being sent right now. Try again in a minute.');
    e.status = 409;
    e.code = 'IN_PROGRESS';
    throw e;
  }
  await sendLeadImport(lead.id, { actor: humanActor(user), now, db, ...opts });
  const after = await db.cmsLead.findUnique({ where: { id: lead.id }, select: { mirrorState: true, mirrorError: true, cmsMirrorLeadId: true } });
  return { state: after?.mirrorState || null, error: after?.mirrorError || null, mirrored: !!after?.cmsMirrorLeadId };
}

/** Staff view of the mirror (no PII). */
export function mirrorView(l) {
  if (l.provider !== 'ghl') return null;
  return { state: l.mirrorState || null, attempts: l.mirrorAttempts || 0, nextAt: l.mirrorState === 'pending' ? l.mirrorNextAt || null : null, error: l.mirrorError || null, mirrored: !!l.cmsMirrorLeadId };
}
