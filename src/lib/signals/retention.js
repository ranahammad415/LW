/**
 * Plan §5.3 / §5.6 `signals.retention` (leader-only, nightly 04:00), ≤ 5 000 rows per statement, a short pause
 * between batches, bounded per run (the next night continues):
 *   1. compact SignalEvent older than 90 days: payload → NULL, payloadCompactedAt = now (the scalars stay);
 *   2. delete compacted pageview / engagement / vitals rows (their session holds the facts) and every SignalEvent
 *      older than 13 months (visit / cta_click / form_start / lead_* rows are kept until then);
 *   3. SignalSession older than 25 months;
 *   4. the three daily tables older than 3 years;
 *   5. SignalIngestStat older than 400 days;
 *   6. rows of projects that no longer exist (the signal tables have no foreign key to project).
 * LeadAttribution lives as long as its lead (deleted with it). SignalErasure is kept (no identifiers).
 * Returns { compacted, deleted: {…}, oldestUncompactedAt } for the data-quality panel.
 */
import { prisma } from '../prisma.js';
import { DB_NULL, addDays, addMonths, sleep, utcDay } from './common.js';

export const RETENTION = Object.freeze({ payloadDays: 90, eventMonths: 13, sessionMonths: 25, aggregateYears: 3, ingestStatDays: 400 });
export const RETENTION_BATCH = 5000;
const SHORT_TYPES = ['pageview', 'engagement', 'vitals'];

/** Repeat `step` (one ≤ batch statement, returns rows affected) until it affects < batch rows or the budget is used. */
async function drain(step, { batch, maxBatches, pause }) {
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const n = await step();
    total += n;
    if (n < batch) break;
    await pause();
  }
  return total;
}

async function deleteByIds(model, where, batch) {
  const rows = await model.findMany({ where, select: { id: true }, take: batch });
  if (!rows.length) return 0;
  const r = await model.deleteMany({ where: { id: { in: rows.map((x) => x.id) } } });
  return Number(r?.count) || 0;
}

export async function runRetention({ now = new Date(), batch = RETENTION_BATCH, maxBatches = 40, pauseMs = 200, log } = {}) {
  const pause = () => (pauseMs ? sleep(pauseMs) : Promise.resolve());
  const opts = { batch, maxBatches, pause };
  const payloadCutoff = addDays(now, -RETENTION.payloadDays);
  const eventCutoff = addMonths(now, -RETENTION.eventMonths);
  const sessionCutoff = addMonths(now, -RETENTION.sessionMonths);
  const aggCutoff = utcDay(addMonths(now, -12 * RETENTION.aggregateYears));
  const statCutoff = utcDay(addDays(now, -RETENTION.ingestStatDays));

  const compacted = await drain(async () => {
    const rows = await prisma.signalEvent.findMany({ where: { payloadCompactedAt: null, at: { lt: payloadCutoff } }, select: { id: true }, take: batch });
    if (!rows.length) return 0;
    const r = await prisma.signalEvent.updateMany({ where: { id: { in: rows.map((x) => x.id) } }, data: { payload: DB_NULL, payloadCompactedAt: now } });
    return Number(r?.count) || 0;
  }, opts);
  const deleted = {
    compactedShortEvents: await drain(() => deleteByIds(prisma.signalEvent, { payloadCompactedAt: { not: null }, type: { in: SHORT_TYPES } }, batch), opts),
    events: await drain(() => deleteByIds(prisma.signalEvent, { at: { lt: eventCutoff } }, batch), opts),
    sessions: await drain(() => deleteByIds(prisma.signalSession, { startedAt: { lt: sessionCutoff } }, batch), opts),
    bySource: await drain(() => deleteByIds(prisma.signalDailyBySource, { date: { lt: aggCutoff } }, batch), opts),
    byLanding: await drain(() => deleteByIds(prisma.signalDailyByLanding, { date: { lt: aggCutoff } }, batch), opts),
    byGeoDevice: await drain(() => deleteByIds(prisma.signalDailyByGeoDevice, { date: { lt: aggCutoff } }, batch), opts),
    ingestStats: await drain(() => deleteByIds(prisma.signalIngestStat, { date: { lt: statCutoff } }, batch), opts),
    orphans: await sweepOrphans(opts),
  };
  const oldest = await prisma.signalEvent.findFirst({ where: { payloadCompactedAt: null }, orderBy: { at: 'asc' }, select: { at: true } });
  const out = { compacted, deleted, oldestUncompactedAt: oldest?.at ? new Date(oldest.at).toISOString() : null };
  if (compacted || Object.values(deleted).some(Boolean)) log?.info?.(out, 'signals.retention');
  return out;
}

/** Signal rows whose project was deleted (no FK cascade on these tables). */
export async function sweepOrphans({ batch = RETENTION_BATCH, maxBatches = 40, pause = () => Promise.resolve() } = {}) {
  const tables = ['signalEvent', 'signalSession', 'signalDailyBySource', 'signalDailyByLanding', 'signalDailyByGeoDevice', 'signalIngestStat', 'signalRollupDirty', 'signalConfigMirror', 'signalErasure'];
  const ids = new Set();
  for (const t of tables) {
    const rows = await prisma[t].findMany({ distinct: ['projectId'], select: { projectId: true }, take: 10_000 });
    for (const r of rows) ids.add(r.projectId);
  }
  if (!ids.size) return 0;
  const live = new Set((await prisma.project.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })).map((p) => p.id));
  const gone = [...ids].filter((id) => !live.has(id));
  let n = 0;
  for (const projectId of gone) {
    for (const t of tables) n += await drain(() => deleteByIds(prisma[t], { projectId }, batch), { batch, maxBatches, pause });
  }
  return n;
}
