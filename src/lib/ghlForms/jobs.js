/**
 * Leader-only jobs of the GoHighLevel forms feature (backend.md §6; PM2 cluster: isLeader() = NODE_APP_INSTANCE 0 /
 * unset). One call from src/index.js (startGhlFormsJobs). Each job keeps an in-process "running" flag, and the queue
 * claims rows with compare-and-set, so even two leaders could not send a lead twice. No AI or paid calls.
 *   every minute  ghl.leadImport   lead-import mirror queue (≤ 20 leads per run; no DB write when nothing is due)
 *   04:40 UTC     ghl.receipts     ExternalFormReceipt older than 90 days deleted (≤ 5 000 rows per statement)
 */
import cron from '../osBackup/cronGate.js'; // node-cron + maintenance gate (features/os-backups.md)
import { prisma } from '../prisma.js';
import { isLeader } from '../emdashSync.js';
import { runLeadImportQueue } from './leadImport.js';

export const RECEIPT_RETENTION_DAYS = 90;
const running = new Set();

export async function guarded(name, fn, log, { leader = isLeader } = {}) {
  if (!leader()) return { skipped: true };
  if (running.has(name)) return { skipped: 'running' };
  running.add(name);
  try {
    return await fn();
  } catch (err) {
    log?.error?.({ err: { message: err?.message, code: err?.code } }, `${name} failed`);
    return { error: err?.code || 'ERROR' };
  } finally {
    running.delete(name);
  }
}

/** Delete receipts past retention in bounded batches. */
export async function purgeExternalFormReceipts({ now = new Date(), batch = 5000, maxBatches = 20, db = prisma } = {}) {
  const cutoff = new Date(now.getTime() - RECEIPT_RETENTION_DAYS * 86_400_000);
  let removed = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const ids = await db.externalFormReceipt.findMany({ where: { receivedAt: { lt: cutoff } }, select: { id: true }, take: batch });
    if (!ids.length) break;
    const r = await db.externalFormReceipt.deleteMany({ where: { id: { in: ids.map((x) => x.id) } } });
    removed += Number(r?.count) || 0;
    if (ids.length < batch) break;
  }
  return { removed };
}

export function startGhlFormsJobs(log) {
  cron.schedule('* * * * *', () => guarded('ghl.leadImport', () => runLeadImportQueue({ log }), log));
  cron.schedule('40 4 * * *', () => guarded('ghl.receipts', () => purgeExternalFormReceipts(), log));
  log?.info?.({ leader: isLeader() }, 'GoHighLevel forms jobs scheduled');
}
