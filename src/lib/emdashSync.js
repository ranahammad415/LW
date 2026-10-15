/**
 * EmDash pull side (plan O6, contract §3.8 reconciliation):
 * - syncEmdashPipelines: `pipeline-list` → WpContentReview mirror (no notifications).
 * - syncEmdashInventory: `inventory` (+ `site-info`) → WpPage + snapshots (no AI summaries).
 * - replayEmdashEvents: `events-replay {sinceCursor}` after an OS outage → the normal event path.
 * - healReviews: `pipeline-get` for reviews whose per-review seq had a gap.
 * - checkCmsConnections: cms_connection_lost after 24 h of silence (OWNERs, once per outage).
 * - cleanupCmsTables: 90-day receipts, expired nonces, expired pairing signing keys.
 *
 * Interval work runs on the PM2 leader only (backend.md §6 leader pattern) and every write
 * is idempotent, so a double tick is still safe.
 */
import { prisma } from './prisma.js';
import { notify } from './notificationService.js';
import { reconcileProjectMapsSafe } from './contentMapSync.js';
import {
  emdashRoutes,
  entryToPageData,
  INTERACTIVE_RETRY_DELAYS_MS,
  READ_RETRY_DELAYS_MS,
  CmsBridgeError,
} from './siteAdapters/emdash.js';
import { SUPPORTED_CONTRACTS, negotiateContract } from './siteAdapters/signing.js';
import {
  loadEmdashConnection,
  mirrorEmdashReview,
  backfillEmdashHistory,
  prismaCmsStore,
} from './cmsStore.js';
import { isCmsKeyCryptoConfigured } from './cmsKeyCrypto.js';

/** PM2 cluster leader (same rule as lib/interviewScheduler.isLeader; backend.md §6). */
export function isLeader(env = process.env) {
  return env.NODE_APP_INSTANCE === undefined || env.NODE_APP_INSTANCE === '' || env.NODE_APP_INSTANCE === '0';
}

const MAX_LIST_PAGES = 20;
const MAX_INVENTORY_PAGES = 50;
const RECEIPT_RETENTION_DAYS = 90;
const CONNECTION_LOST_MS = 24 * 60 * 60 * 1000;

function retryOpts(interactive, noRetry = false) {
  if (noRetry) return { retryDelays: [], timeoutMs: 5000 };
  return { retryDelays: interactive ? INTERACTIVE_RETRY_DELAYS_MS : READ_RETRY_DELAYS_MS };
}

async function pairedEmdashProjectIds(projectId) {
  const rows = await prisma.project.findMany({
    where: {
      cmsType: 'EMDASH',
      cmsPairedAt: { not: null },
      wpUrl: { not: null },
      ...(projectId ? { id: projectId } : {}),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Pull reviews for one or all paired EmDash projects. Returns { synced, errors }. */
export async function syncEmdashPipelines({ projectId, interactive = false, noRetry = false, log } = {}) {
  if (!isCmsKeyCryptoConfigured()) return { synced: 0, errors: 0, skipped: 'CMS_KEY_ENCRYPTION_KEY missing' };
  const ids = await pairedEmdashProjectIds(projectId);
  let synced = 0;
  let errors = 0;
  for (const id of ids) {
    try {
      const { conn } = await loadEmdashConnection(id);
      let cursor = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const res = await emdashRoutes.pipelineList(conn, { status: 'any', limit: 100, cursor }, retryOpts(interactive, noRetry));
        const items = Array.isArray(res?.items) ? res.items : [];
        for (const review of items) {
          try {
            const row = await mirrorEmdashReview(id, review, { log });
            if (row?.id) {
              const count = await prisma.wpContentReviewEvent.count({ where: { contentReviewId: row.id } });
              if (count === 0) await backfillEmdashHistory(id, review);
            }
            synced += 1;
          } catch (err) {
            errors += 1;
            log?.warn?.({ err, projectId: id }, 'EmDash review mirror failed');
          }
        }
        cursor = res?.next || null;
        if (!cursor || items.length === 0) break;
      }
    } catch (err) {
      errors += 1;
      log?.warn?.({ err: { code: err?.code, message: err?.message }, projectId: id }, 'EmDash pipeline sync failed');
    }
  }
  return { synced, errors };
}

/** Refresh site-info (versions, capabilities, health) and enforce the contract gate. */
export async function refreshEmdashSiteInfo(projectId, { interactive = false } = {}) {
  const { project, conn } = await loadEmdashConnection(projectId);
  const info = await emdashRoutes.siteInfo(conn, retryOpts(interactive));
  const contract = negotiateContract(info?.supportedContracts) ?? (Number.isInteger(info?.contract) ? info.contract : null);
  await prismaCmsStore.recordHeartbeat({ projectId: project.id, siteInfo: info, contract, now: new Date() });
  if (!contract || !SUPPORTED_CONTRACTS.includes(contract)) {
    throw new CmsBridgeError({
      status: 426,
      code: 'CONTRACT_UNSUPPORTED',
      message: `This site speaks bridge contract v${info?.contract ?? '?'}; this Agency OS supports v${SUPPORTED_CONTRACTS.join(', v')}. Update the agency-os-bridge plugin on the site (or Agency OS) so both speak the same contract version.`,
    });
  }
  return info;
}

/** Pull the entry inventory into WpPage. Mirrors syncProjectPages' return shape. */
export async function syncEmdashInventory(projectId, { interactive = false } = {}) {
  if (!isCmsKeyCryptoConfigured()) {
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: 'CMS_KEY_ENCRYPTION_KEY is not set on Agency OS' };
  }
  let project;
  let conn;
  try {
    ({ project, conn } = await loadEmdashConnection(projectId));
  } catch (err) {
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: err.message };
  }
  try {
    await refreshEmdashSiteInfo(projectId, { interactive });
  } catch (err) {
    if (err?.code === 'CONTRACT_UNSUPPORTED') return { synced: 0, created: 0, updated: 0, deleted: 0, error: err.message };
    // Non-fatal for the inventory itself.
  }

  const items = [];
  let complete = false;
  try {
    let cursor = null;
    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      const res = await emdashRoutes.inventory(conn, { status: 'any', limit: 100, cursor }, retryOpts(interactive));
      const batch = Array.isArray(res?.items) ? res.items : [];
      items.push(...batch);
      cursor = res?.next || null;
      if (!cursor || batch.length === 0) {
        complete = true;
        break;
      }
    }
  } catch (err) {
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: err.message };
  }

  const existing = await prisma.wpPage.findMany({
    where: { projectId },
    select: { id: true, wpPostId: true, contentHash: true, content: true, status: true },
  });
  const byNo = new Map(existing.map((p) => [Number(p.wpPostId), p]));
  const now = new Date();
  let created = 0;
  let updated = 0;
  const seen = new Set();

  for (const entry of items) {
    const { wpPostId, data } = entryToPageData(entry, project.wpUrl);
    if (!wpPostId) continue;
    seen.add(wpPostId);
    const prev = byNo.get(wpPostId);
    const revisionId = data.cmsDraftRevisionId || data.cmsLiveRevisionId || null;
    if (!prev) {
      const page = await prisma.wpPage.create({ data: { projectId, wpPostId, ...data, content: '', syncedAt: now } });
      await prisma.wpPageSnapshot.create({
        data: {
          wpPageId: page.id,
          title: data.title,
          content: '',
          status: data.status,
          seoTitle: data.seoTitle,
          seoDescription: data.seoDescription,
          contentHash: data.contentHash,
          eventType: 'created',
          contentExcerpt: data.excerpt,
          cmsRevisionId: revisionId,
          syncedAt: now,
        },
      });
      created += 1;
    } else if (prev.contentHash !== data.contentHash || prev.status === 'deleted') {
      await prisma.wpPage.update({ where: { id: prev.id }, data: { ...data, syncedAt: now } });
      await prisma.wpPageSnapshot.create({
        data: {
          wpPageId: prev.id,
          title: data.title,
          content: prev.content || '',
          status: data.status,
          seoTitle: data.seoTitle,
          seoDescription: data.seoDescription,
          contentHash: data.contentHash,
          eventType: 'updated',
          contentExcerpt: data.excerpt,
          cmsRevisionId: revisionId,
          syncedAt: now,
        },
      });
      updated += 1;
    } else {
      await prisma.wpPage.update({ where: { id: prev.id }, data: { ...data, syncedAt: now } });
    }
  }

  let deleted = 0;
  if (complete) {
    for (const [no, prev] of byNo) {
      if (!seen.has(no) && prev.status !== 'deleted') {
        await prisma.wpPage.update({ where: { id: prev.id }, data: { status: 'deleted', syncedAt: now } });
        deleted += 1;
      }
    }
  }

  if (created || updated || deleted) reconcileProjectMapsSafe(projectId);
  return { synced: items.length, created, updated, deleted };
}

/** Daily inventory for every paired EmDash project (leader only; called from the 03:00 cron). */
export async function syncAllEmdashProjects() {
  const ids = await pairedEmdashProjectIds();
  const results = [];
  for (const id of ids) {
    try {
      results.push({ projectId: id, ...(await syncEmdashInventory(id)) });
    } catch (err) {
      results.push({ projectId: id, error: err.message });
    }
  }
  return results;
}

/** Heal per-review seq gaps: pipeline-get → mirror + history backfill (contract §6.3). */
export async function healReviews(projectId, reviewIds, log) {
  if (!reviewIds?.length) return 0;
  const { conn } = await loadEmdashConnection(projectId);
  let healed = 0;
  for (const reviewId of reviewIds.slice(0, 20)) {
    try {
      const res = await emdashRoutes.pipelineGet(conn, { reviewId }, { retryDelays: INTERACTIVE_RETRY_DELAYS_MS });
      if (res?.review) {
        await mirrorEmdashReview(projectId, res.review, { log });
        healed += await backfillEmdashHistory(projectId, res.review);
      }
    } catch (err) {
      log?.warn?.({ err: { code: err?.code, message: err?.message }, projectId, reviewId }, 'EmDash heal failed');
    }
  }
  return healed;
}

/** Pull events the OS missed (cursor > cmsLastCursor) and run them through the normal batch path. */
export async function replayEmdashEvents(projectId, { log, maxPages = 1 } = {}) {
  const { processEventBatch } = await import('../routes/webhooks/emdash.js');
  const { project, conn } = await loadEmdashConnection(projectId);
  let since = project.cmsLastCursor || 0;
  let applied = 0;
  for (let i = 0; i < maxPages; i += 1) {
    const res = await emdashRoutes.eventsReplay(conn, { sinceCursor: since, limit: 500 });
    const events = Array.isArray(res?.events) ? res.events : [];
    if (events.length === 0) break;
    // Replay respects the batch rules (≤ 50 events, ≤ 1 snapshot per batch).
    for (let j = 0; j < events.length; j += 50) {
      const chunk = [];
      let snap = 0;
      for (const ev of events.slice(j, j + 50)) {
        if (typeof ev?.snapshotText === 'string') {
          snap += 1;
          if (snap > 1) {
            const { snapshotText, ...rest } = ev;
            chunk.push(rest);
            continue;
          }
        }
        chunk.push(ev);
      }
      // Same v1.0.2 C1 check as /events: replayed events with known eventIds are duplicates, never
      // regressions; a new eventId reusing a stored counter stops the replay and flags re-pair.
      const regression = await prismaCmsStore.findCounterRegression(project.id, chunk);
      if (regression) {
        await prismaCmsStore.flagRepairNeeded(project.id, regression, log);
        return { applied, regression };
      }
      const r = await processEventBatch({ store: prismaCmsStore, project, events: chunk, log });
      applied += r.accepted.length;
      if (r.storedCursor > 0) await prismaCmsStore.setLastCursor(project.id, r.storedCursor);
      if (r.heal.length) await healReviews(project.id, r.heal, log).catch(() => {});
    }
    since = Math.max(since, Number(res.lastCursor) || 0);
    if (!res.more) break;
  }
  return { applied };
}

/** OWNER alert once per outage when a paired site has been silent for 24 h. */
export async function checkCmsConnections(log) {
  const cutoff = new Date(Date.now() - CONNECTION_LOST_MS);
  const stale = await prisma.project.findMany({
    where: { cmsType: 'EMDASH', cmsPairedAt: { not: null }, cmsLastSeenAt: { lt: cutoff }, cmsLostNotifiedAt: null },
    select: { id: true, name: true, cmsLastSeenAt: true },
  });
  if (!stale.length) return 0;
  const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
  let sent = 0;
  for (const p of stale) {
    const claim = await prisma.project.updateMany({
      where: { id: p.id, cmsLostNotifiedAt: null },
      data: { cmsLostNotifiedAt: new Date() },
    });
    if (claim.count !== 1 || owners.length === 0) continue;
    notify({
      slug: 'cms_connection_lost',
      recipientIds: owners.map((o) => o.id),
      variables: {
        projectName: p.name || '',
        lastSeenAt: p.cmsLastSeenAt ? p.cmsLastSeenAt.toISOString() : 'never',
      },
      actionUrl: `/portal/admin/projects/${p.id}?tab=wp`,
      metadata: { projectId: p.id },
    }).catch((err) => log?.warn?.({ err, projectId: p.id }, 'cms_connection_lost notify failed'));
    sent += 1;
  }
  return sent;
}

export async function cleanupCmsTables() {
  const now = new Date();
  const [receipts, nonces, codes] = await Promise.all([
    prisma.cmsEventReceipt.deleteMany({
      where: { receivedAt: { lt: new Date(now.getTime() - RECEIPT_RETENTION_DAYS * 864e5) } },
    }),
    prisma.cmsNonce.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.cmsPairingCode.updateMany({
      where: { expiresAt: { lt: now }, signingKeyEnc: { not: null } },
      data: { signingKeyEnc: null },
    }),
  ]);
  return { receipts: receipts.count, nonces: nonces.count, expiredCodes: codes.count };
}

let intervalId = null;
let hourlyId = null;

/**
 * Leader-only EmDash reconciliation: every PIPELINE_SYNC_INTERVAL_MS (default 5 min, 0 disables)
 * pull pipeline-list + events-replay; hourly connection-lost check and table cleanup.
 * No-op unless at least one EmDash project is paired (each tick is one cheap query).
 */
export function startEmdashSyncInterval(logger) {
  if (!isLeader()) {
    logger.info('EmDash sync interval: not the PM2 leader, skipping');
    return;
  }
  const raw = process.env.PIPELINE_SYNC_INTERVAL_MS;
  const ms = raw === undefined || raw === '' ? 5 * 60 * 1000 : Number(raw) || 0;
  if (ms > 0) {
    let running = false;
    intervalId = setInterval(async () => {
      if (running || !isCmsKeyCryptoConfigured()) return;
      running = true;
      try {
        const ids = await pairedEmdashProjectIds();
        if (ids.length === 0) return;
        const result = await syncEmdashPipelines({ log: logger });
        for (const id of ids) {
          await replayEmdashEvents(id, { log: logger }).catch((err) =>
            logger.warn({ err: { code: err?.code, message: err?.message }, projectId: id }, 'EmDash events-replay failed')
          );
        }
        if (result.synced || result.errors) logger.info({ result }, 'EmDash pipeline sync complete');
      } catch (err) {
        logger.error({ err }, 'EmDash pipeline sync failed');
      } finally {
        running = false;
      }
    }, ms);
  }
  hourlyId = setInterval(async () => {
    try {
      await checkCmsConnections(logger);
      await cleanupCmsTables();
    } catch (err) {
      logger.error({ err }, 'EmDash hourly maintenance failed');
    }
  }, 60 * 60 * 1000);
}

export function stopEmdashSyncInterval() {
  if (intervalId) clearInterval(intervalId);
  if (hourlyId) clearInterval(hourlyId);
  intervalId = null;
  hourlyId = null;
}
