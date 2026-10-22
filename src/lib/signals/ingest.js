/**
 * Contract v1.7.0 §38.4: `signals.batch` ingest (in the webhook request, any PM2 process). No session logic here.
 *   validate strictly + clamp + redact (validate.js) → dedupe inside the batch → ONE createMany({ skipDuplicates })
 *   (unique (projectId, eventId): a re-sent batch or an inner duplicate is ignored silently) → SignalIngestStat counters.
 * The outer eventId is the batch's idempotency key (CmsEventReceipt, handled by processEventBatch).
 * Also: `signals.erased` (site-side erasure: our copy follows) and `signals.config_changed` (config mirror).
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { sanitizeSignalsBatch, signalToRow, sanitizeSignalsErasedData, BOT_THRESHOLD } from './validate.js';
import { utcDay } from './common.js';

function validationError(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION' });
}

/** Add to today's SignalIngestStat counters (one upsert). */
export async function bumpIngestStat(projectId, counts, now = new Date(), db = prisma) {
  const date = utcDay(now);
  const inc = {};
  for (const [k, v] of Object.entries(counts)) if (Number.isInteger(v) && v > 0) inc[k] = { increment: v };
  await db.signalIngestStat.upsert({
    where: { projectId_date: { projectId, date } },
    create: { projectId, date, ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number.isInteger(v) ? v : 0])) },
    update: inc,
  });
}

/**
 * One `signals.batch` event → rows. Returns the receipt outcome ('applied'). Throws VALIDATION (final reject) when the
 * batch itself is unusable; a dropped inner signal never fails the batch (counted in rejectedInvalid).
 */
export async function ingestSignalsBatch(project, ev, { now = new Date(), log } = {}) {
  const res = sanitizeSignalsBatch(ev.data, { siteId: project.cmsSiteId || null });
  if (res.error) throw validationError(res.error);
  const seen = new Set();
  const rows = [];
  for (const s of res.signals) {
    if (seen.has(s.eventId)) continue; // inner duplicate inside the same batch
    seen.add(s.eventId);
    rows.push(signalToRow(project.id, s));
  }
  let inserted = 0;
  if (rows.length) {
    const out = await prisma.signalEvent.createMany({ data: rows, skipDuplicates: true });
    inserted = Number(out?.count) || 0;
  }
  const innerDuplicates = res.signals.length - inserted;
  await bumpIngestStat(
    project.id,
    {
      batches: 1,
      events: inserted,
      innerDuplicates,
      rejectedInvalid: res.invalid,
      clamped: res.clamped,
      botEvents: rows.filter((r) => r.botScore >= BOT_THRESHOLD).length,
    },
    now
  );
  if (res.invalid) log?.info?.({ projectId: project.id, invalid: res.invalid }, 'signals.batch: invalid signals dropped');
  return 'applied';
}

/** How long after an OS-initiated erasure the site's signals.erased is read as its confirmation (O-R3B-1). */
export const OS_ERASURE_CONFIRM_WINDOW_MS = 24 * 3600_000;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * The visitor id behind a subjectHash (sha256 of the id), for a site-side erasure (signals.erased, e.g. the privacy
 * page "Reset my id"). One indexed scan per table in MySQL; null when we hold nothing for it.
 */
export async function findVisitorByHash(projectId, subjectHash) {
  const rows = await prisma.$queryRaw`
    SELECT visitorId FROM signalsession WHERE projectId = ${projectId} AND visitorId IS NOT NULL AND SHA2(visitorId, 256) = ${subjectHash}
    UNION SELECT visitorId FROM signalevent WHERE projectId = ${projectId} AND visitorId IS NOT NULL AND SHA2(visitorId, 256) = ${subjectHash}
    LIMIT 1`;
  return Array.isArray(rows) && rows[0]?.visitorId ? String(rows[0].visitorId) : null;
}

/**
 * signals.erased (§38.7): the site erased a visitor (signals-erase or "Reset my id") or a lead's signals. Our copy
 * follows: visitor → every SignalEvent / SignalSession row deleted (eraseVisitorLocal); lead → its LeadAttribution
 * deleted and lead links nulled (the lead itself stays). A SignalErasure row (origin site, hash only) is written.
 */
export async function applySignalsErased(project, ev, { resolveVisitor = findVisitorByHash, now = new Date() } = {}) {
  const { data, error } = sanitizeSignalsErasedData(ev.data);
  if (error) throw validationError(error);
  const { eraseVisitorLocal, eraseLeadSignalsLocal } = await import('./erase.js');
  let local = { events: 0, sessions: 0, attributions: 0 };
  if (data.kind === 'visitorId') {
    const visitorId = await resolveVisitor(project.id, data.subjectHash).catch(() => null);
    if (visitorId) local = await eraseVisitorLocal(project.id, visitorId);
  } else {
    const leads = await prisma.cmsLead.findMany({ where: { projectId: project.id }, select: { leadId: true }, take: 50_000 });
    const match = leads.find((l) => sha256(l.leadId) === data.subjectHash);
    if (match) local = await eraseLeadSignalsLocal(project.id, match.leadId);
  }
  // An OS-initiated erasure is CONFIRMED by this event: its own SignalErasure row is updated, never a second row
  // (O-R3B-1). That row may still be owed (pending / failed, any age) or already acknowledged by the signals-erase
  // response (done) within the last OS_ERASURE_CONFIRM_WINDOW_MS; a row the site already confirmed is not matched.
  const acked = await prisma.signalErasure.updateMany({
    where: {
      projectId: project.id,
      kind: data.kind,
      subjectHash: data.subjectHash,
      siteConfirmedAt: null,
      OR: [{ siteState: { in: ['pending', 'failed'] } }, { origin: 'os', at: { gte: new Date(now.getTime() - OS_ERASURE_CONFIRM_WINDOW_MS) } }],
    },
    data: { siteState: 'done', siteRows: data.rows, siteConfirmedAt: now, pendingSubject: null, siteNextAt: null },
  });
  if (Number(acked?.count) > 0) return 'applied';
  await prisma.signalErasure.create({
    data: {
      projectId: project.id,
      kind: data.kind,
      subjectHash: data.subjectHash,
      reason: data.reason,
      origin: 'site',
      rowsEvents: local.events,
      rowsSessions: local.sessions,
      rowsAttributions: local.attributions,
      at: data.at ? new Date(data.at) : now,
      siteState: 'done',
      siteRows: data.rows,
      siteConfirmedAt: now,
    },
  });
  return 'applied';
}
