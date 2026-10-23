/**
 * Attribution of a GoHighLevel form lead (architecture §4.3 step 6, contract §40.3 / §40.6). One LeadAttribution per
 * lead, keyed on our CmsLead (siteLeadId = the OS id "xg_…"), created with the lead:
 *   1. `oa_sid` (the visit id the form carried) → sessionId; the 5-minute `signals.attribute` job derives the touch
 *      from that SignalSession once it is there (the sessionizer flags the row when the session arrives / changes).
 *   2. The form's own values (oa_ref_class / oa_ai_source / oa_source / utm / oa_landing) → the snapshot's lastTouch,
 *      stored as model "cookie-only" with siteSnapshot.origin = "ghl-fields" (the contract's model enum is unchanged).
 *   3. No oa_sid: the latest `form_submit` signal of the same form within ±10 minutes whose session has no lead yet →
 *      its session, flagged `mismatch` (siteSnapshot.match = "time-window", a guess). Tried when the lead arrives and
 *      again when such a signal arrives later (sessionizer → matchFormSubmitToLead).
 * The site's own snapshot (lead-import response / lead.attributed with externalRef) only fills gaps (mergeSnapshot).
 */
import { prisma } from '../prisma.js';
import { markDirty } from '../signals/common.js';
import { touchFromGhlFields, GHL_PLACEMENT } from './normalize.js';

export const FORM_SUBMIT_WINDOW_MS = 10 * 60_000;

const formIdOf = (e) => (e?.payload && typeof e.payload === 'object' ? e.payload.lead?.formId ?? null : null);

/** The session of the closest unattached form_submit of `formId` within ±10 min of `leadAt`, or null. */
export async function findWindowSession(projectId, formId, leadAt, db = prisma) {
  const t = new Date(leadAt).getTime();
  const evs = await db.signalEvent.findMany({
    where: { projectId, type: 'form_submit', at: { gte: new Date(t - FORM_SUBMIT_WINDOW_MS), lte: new Date(t + FORM_SUBMIT_WINDOW_MS) } },
    orderBy: { at: 'desc' },
    take: 50,
    select: { sessionId: true, at: true, payload: true },
  });
  const candidates = evs.filter((e) => formIdOf(e) === formId).sort((a, b) => Math.abs(new Date(a.at) - t) - Math.abs(new Date(b.at) - t));
  for (const c of candidates) {
    const taken = await db.leadAttribution.findFirst({ where: { projectId, sessionId: c.sessionId }, select: { id: true } });
    if (!taken) return c.sessionId;
  }
  return null;
}

/**
 * Create the LeadAttribution of a new GHL lead (row = the created CmsLead). `norm` = normalizeGhlForm(...).lead.
 * Returns the created row.
 */
export async function createGhlAttribution(row, norm, { formId, db = prisma } = {}) {
  const a = norm.attribution || {};
  const leadAt = row.siteCreatedAt || row.receivedAt || new Date();
  const touch = touchFromGhlFields(a, leadAt);
  let sessionId = a.sessionId || null;
  let match = sessionId ? 'session' : null;
  if (!sessionId) {
    sessionId = await findWindowSession(row.projectId, formId, leadAt, db).catch(() => null);
    if (sessionId) match = 'time-window';
  }
  const siteSnapshot = {
    model: 'cookie-only',
    firstTouch: null,
    lastTouch: touch,
    sessionId: a.sessionId || null,
    visitorId: a.visitorId || null,
    landing: a.landing || null,
    formId,
    placement: GHL_PLACEMENT,
    origin: touch ? 'ghl-fields' : 'ghl',
    ...(match === 'time-window' ? { match } : {}),
  };
  const created = await db.leadAttribution.create({
    data: {
      projectId: row.projectId,
      leadRowId: row.id,
      siteLeadId: row.leadId,
      leadAt,
      visitorId: a.visitorId || null,
      sessionId,
      model: 'cookie-only',
      siteSnapshot,
      lastClass: touch?.class || 'unknown',
      lastSource: (touch?.source || '').slice(0, 64),
      landingPath: a.landing || null,
      formId: String(formId || '').slice(0, 40) || null,
      placement: GHL_PLACEMENT,
      heardFrom: norm.heardFrom || null,
      mismatch: match === 'time-window',
      needsDerive: true,
    },
  });
  await markDirty(row.projectId, [leadAt], db);
  return created;
}

/**
 * Sessionizer hook: a session with `form_submit` of an embedded form and no lead yet → the GHL lead of the same form
 * within ±10 min that has no session (no oa_sid arrived with it) is attached to this session, flagged as a guess.
 * Returns the attached CmsLead id (siteLeadId) or null.
 */
export async function matchFormSubmitToLead(projectId, sessionId, formSubmitEvents, db = prisma) {
  for (const e of formSubmitEvents) {
    const formId = formIdOf(e);
    if (!formId) continue;
    const t = new Date(e.at).getTime();
    const cand = await db.leadAttribution.findFirst({
      where: { projectId, sessionId: null, placement: GHL_PLACEMENT, formId: String(formId).slice(0, 40), leadAt: { gte: new Date(t - FORM_SUBMIT_WINDOW_MS), lte: new Date(t + FORM_SUBMIT_WINDOW_MS) } },
      orderBy: { leadAt: 'desc' },
      select: { id: true, siteLeadId: true, siteSnapshot: true },
    });
    if (!cand) continue;
    const snap = cand.siteSnapshot && typeof cand.siteSnapshot === 'object' ? cand.siteSnapshot : {};
    await db.leadAttribution.update({ where: { id: cand.id }, data: { sessionId, mismatch: true, needsDerive: true, siteSnapshot: { ...snap, match: 'time-window' } } });
    return cand.siteLeadId;
  }
  return null;
}
