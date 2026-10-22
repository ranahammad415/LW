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
  sanitizeOutline,
  INTERACTIVE_RETRY_DELAYS_MS,
  READ_RETRY_DELAYS_MS,
  CmsBridgeError,
} from './siteAdapters/emdash.js';
import { SUPPORTED_CONTRACTS, negotiateContract } from './siteAdapters/signing.js';
import { OUTLINE_FETCH_CAP_PER_SYNC } from './siteAdapters/outline.js';
import {
  loadEmdashConnection,
  mirrorEmdashReview,
  backfillEmdashHistory,
  closeForeignReview,
  isForeignWpPage,
  prismaCmsStore,
  sanitizeKeyState,
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

const KEY_REJECTED = new Set(['UNKNOWN_SITE', 'UNKNOWN_KEY']);

/**
 * The site no longer knows us (Disconnect on the site, re-paired elsewhere): flag re-pair needed once
 * (CAS + OWNER notice) so polling stops until the project is paired again.
 */
export async function handleSiteRejection(projectId, err, log) {
  if (!KEY_REJECTED.has(err?.code)) return false;
  await prismaCmsStore.flagRepairNeeded(projectId, `the site rejected Agency OS's keys (${err.code}); it was disconnected or paired elsewhere`, log);
  return true;
}

async function pairedEmdashProjectIds(projectId) {
  const rows = await prisma.project.findMany({
    where: {
      cmsType: 'EMDASH',
      cmsPairedAt: { not: null },
      wpUrl: { not: null },
      // Archived projects and sites that rejected our keys are not polled (e2e OS issue 4).
      status: { not: 'ARCHIVED' },
      cmsRepairNeededAt: null,
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
              if (count === 0) await backfillEmdashHistory(id, review, { log });
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
      await handleSiteRejection(id, err, log).catch(() => {});
      log?.warn?.({ err: { code: err?.code, message: err?.message }, projectId: id }, 'EmDash pipeline sync failed');
    }
  }
  return { synced, errors };
}

/** Refresh site-info (versions, capabilities, health) and enforce the contract gate. */
export async function refreshEmdashSiteInfo(projectId, { interactive = false, noRetry = false } = {}) {
  const { project, conn } = await loadEmdashConnection(projectId);
  const info = await emdashRoutes.siteInfo(conn, retryOpts(interactive, noRetry));
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

/** At most one background site-info refresh per project per this interval (per PM2 instance). */
export const SITE_INFO_REFRESH_INTERVAL_MS = 15 * 60_000;

/**
 * Bounded background site-info refresh (e2e O-R3B-4: stored capabilities stayed stale for ~90 min because heartbeats
 * come every 6 h). `request(projectId)` refreshes at once when the project was not refreshed in the last interval,
 * otherwise schedules ONE trailing refresh at the end of the interval (so a change is never left for the next
 * heartbeat). `markFresh(projectId)` records a refresh that happened elsewhere (a heartbeat carrying capabilities).
 * State is per process: with PM2 cluster mode each instance refreshes a project at most once per interval.
 * `refresh(projectId)` is refreshEmdashSiteInfo through the O-R3-5 path (recordHeartbeat, same validation).
 */
export function createSiteInfoRefresher({ refresh, intervalMs = SITE_INFO_REFRESH_INTERVAL_MS, now = () => Date.now(), setTimer = setTimeout } = {}) {
  const last = new Map();
  const timers = new Map();
  const running = new Set();
  async function run(projectId, log) {
    timers.delete(projectId);
    if (running.has(projectId)) return;
    running.add(projectId);
    last.set(projectId, now());
    try {
      await refresh(projectId);
    } catch (err) {
      // The stored values stay; the next request or heartbeat tries again. Not an error for the logs.
      log?.info?.({ projectId, code: err instanceof CmsBridgeError ? err.code : 'INTERNAL' }, 'EmDash site-info refresh failed');
    } finally {
      running.delete(projectId);
    }
  }
  return {
    request(projectId, log) {
      if (!projectId) return 'skipped';
      const since = now() - (last.get(projectId) ?? -Infinity);
      if (since >= intervalMs && !running.has(projectId)) {
        run(projectId, log);
        return 'now';
      }
      if (timers.has(projectId)) return 'scheduled';
      const t = setTimer(() => run(projectId, log), Math.max(0, intervalMs - since));
      t?.unref?.();
      timers.set(projectId, t);
      return 'scheduled';
    },
    markFresh(projectId) {
      if (projectId) last.set(projectId, now());
    },
  };
}

/** The process-wide refresher used by the EmDash webhook (skips projects that are not paired and healthy). */
export const siteInfoRefresher = createSiteInfoRefresher({
  async refresh(projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsType: true, cmsRepairNeededAt: true, cmsDisconnectedAt: true } });
    if (!p || p.cmsType !== 'EMDASH' || p.cmsRepairNeededAt || p.cmsDisconnectedAt) return;
    await refreshEmdashSiteInfo(projectId, { noRetry: true });
  },
});

/** Pull the entry inventory into WpPage. Mirrors syncProjectPages' return shape. */
export async function syncEmdashInventory(projectId, { interactive = false, deadlineMs = null, flagRejection = true } = {}) {
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;
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
      // Time-boxed runs stop paging at the deadline; `complete` stays false, so no deletions are inferred.
      if (deadline && Date.now() > deadline) break;
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
    if (flagRejection) await handleSiteRejection(projectId, err).catch(() => {});
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: err.message };
  }

  const existing = await prisma.wpPage.findMany({
    where: { projectId },
    select: { id: true, wpPostId: true, contentHash: true, content: true, status: true, cmsOutlineHash: true, cmsEntryId: true, cmsMigration: true },
  });
  // Review HIGH-1: WordPress rows kept by a migration are never updated, re-created over or marked deleted here.
  const byNo = new Map(existing.filter((p) => !isForeignWpPage(p)).map((p) => [Number(p.wpPostId), p]));
  const foreignNos = new Set(existing.filter((p) => isForeignWpPage(p)).map((p) => Number(p.wpPostId)));
  const now = new Date();
  let created = 0;
  let updated = 0;
  const seen = new Set();

  const outlineQueue = [];
  for (const entry of items) {
    const { wpPostId, data, outlinePending, outlineHash, outlineVariant } = entryToPageData(entry, project.wpUrl);
    if (!wpPostId || foreignNos.has(wpPostId)) continue;
    seen.add(wpPostId);
    const prev = byNo.get(wpPostId);
    // v1.0.6 size guard: outline omitted from inventory; fetch it only when its hash changed.
    if (outlinePending && prev?.cmsOutlineHash !== outlineHash) {
      outlineQueue.push({ wpPostId, entryId: entry.entryId, variant: outlineVariant, outlineHash });
    }
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

  const outlinesFetched = await fetchOmittedOutlines(projectId, conn, outlineQueue, { interactive });
  if (created || updated || deleted || outlinesFetched) reconcileProjectMapsSafe(projectId);
  if (created || deleted) import('./wpSync.js').then((m) => m.autoSyncSitemap(projectId, { emdash: true })).catch(() => {});
  return { synced: items.length, created, updated, deleted, outlinesFetched, outlinesDeferred: Math.max(0, outlineQueue.length - outlinesFetched) };
}

/**
 * v1.0.6: fetch outlines the site left out of inventory (`outlineOmitted`), at most
 * OUTLINE_FETCH_CAP_PER_SYNC entry-get calls per run; the rest wait for the next run.
 */
export async function fetchOmittedOutlines(projectId, conn, queue, { interactive = false } = {}) {
  let fetched = 0;
  for (const item of queue.slice(0, OUTLINE_FETCH_CAP_PER_SYNC)) {
    try {
      const res = await emdashRoutes.entryGet(conn, item.entryId, item.variant, retryOpts(interactive));
      const outline = sanitizeOutline(res?.entry?.outline);
      if (!outline) continue;
      await prisma.wpPage.update({
        where: { projectId_wpPostId: { projectId, wpPostId: item.wpPostId } },
        data: { cmsOutline: outline, cmsOutlineHash: res.entry.outlineHash || item.outlineHash },
      });
      fetched += 1;
    } catch {
      // Next run retries (the stored hash did not change).
    }
  }
  return fetched;
}

/** Delay before the first inventory after pairing: the site installs its new keys only after our response. */
export const PAIRING_SYNC_DELAY_MS = 15_000;
export const PAIRING_SYNC_DEADLINE_MS = 120_000;

/**
 * First inventory right after pairing (WordPress syncs right after connecting). Fire-and-forget, never blocks the
 * handshake response, time-boxed, and runs only in the instance that completed the pairing (the single-use code CAS
 * makes that exactly one). A 401 here (site still installing keys) never flags re-pair; the daily run retries.
 */
export function scheduleInventoryAfterPairing(projectId, log, { delayMs = PAIRING_SYNC_DELAY_MS } = {}) {
  const t = setTimeout(() => {
    syncEmdashInventory(projectId, { interactive: true, deadlineMs: PAIRING_SYNC_DEADLINE_MS, flagRejection: false })
      .then(async (r) => {
        log?.info?.({ projectId, result: r }, 'EmDash inventory after pairing');
        // v1.8.0 §39: first citation list right after pairing (capability read from the site-info the inventory stored).
        const { pullCitationsIfCapable } = await import('./citations/citations.js');
        await pullCitationsIfCapable(projectId).catch((err) => log?.warn?.({ projectId, code: err?.code }, 'Citation list after pairing failed'));
      })
      .catch((err) => log?.warn?.({ projectId, err: { message: err?.message } }, 'EmDash inventory after pairing failed'));
  }, delayMs);
  t.unref?.();
  return t;
}

/**
 * v1.5.6 §32.1 / §3.3(a): confirm a revokePrev rotation with a `health` call signed with the NEW inbound key (the
 * connection has no previous key any more, so no fallback to the old one). Pure decision part, testable.
 * ok: keys.keyId = new id and prevRevokedAt at/after our rotation (minus clock skew).
 */
export function revokeConfirmOutcome(health, { keyId, rotatedAt, skewMs = 5 * 60 * 1000 }) {
  const keys = sanitizeKeyState(health?.keys);
  if (!keys) return { ok: false, code: 'NO_KEY_STATE' };
  if (keys.keyId !== keyId) return { ok: false, code: 'KEY_MISMATCH' };
  const since = rotatedAt ? new Date(rotatedAt).getTime() - skewMs : 0;
  if (!keys.prevRevokedAt || Date.parse(keys.prevRevokedAt) < since) return { ok: false, code: 'PREV_NOT_REVOKED' };
  return { ok: true, keys };
}

/**
 * Run the confirmation (attempts after delays; the site installs the pair after our response). Records
 * revokeConfirmedAt / revokeConfirmError on the credential. A 401 UNKNOWN_KEY on the last attempt means someone else
 * may have collected the rotation: flag re-pair needed (OWNERs notified; polling stops) so an OWNER disconnects and
 * re-pairs (contract §3.3 (b)).
 */
export async function confirmRevokeRotation(projectId, keyId, { log, delaysMs = [15_000, 60_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) } = {}) {
  let last = { ok: false, code: 'UNREACHABLE' };
  for (let i = 0; i < delaysMs.length; i += 1) {
    await sleep(delaysMs[i]);
    const cred = await prisma.cmsCredential.findUnique({ where: { projectId }, select: { keyId: true, rotatedAt: true, prevRevokedAt: true } });
    // Re-paired or rotated again meanwhile: this check is moot.
    if (!cred || cred.keyId !== keyId || !cred.prevRevokedAt) return { ok: false, code: 'SUPERSEDED' };
    try {
      const { conn } = await loadEmdashConnection(projectId);
      const health = await emdashRoutes.health(conn, { retryDelays: [], timeoutMs: 8000 });
      last = revokeConfirmOutcome(health, { keyId, rotatedAt: cred.prevRevokedAt });
      if (last.ok) break;
    } catch (err) {
      last = { ok: false, code: err?.code === 'UNKNOWN_KEY' || err?.code === 'UNKNOWN_SITE' ? 'UNKNOWN_KEY' : 'UNREACHABLE' };
    }
  }
  await prisma.cmsCredential.updateMany({
    where: { projectId, keyId },
    data: last.ok ? { revokeConfirmedAt: new Date(), revokeConfirmError: null } : { revokeConfirmError: last.code },
  });
  if (last.ok) log?.info?.({ projectId, keyId }, 'EmDash revokePrev rotation confirmed');
  else log?.warn?.({ projectId, keyId, code: last.code }, 'EmDash revokePrev rotation not confirmed');
  if (last.code === 'UNKNOWN_KEY') {
    await prismaCmsStore.flagRepairNeeded(projectId, 'the site did not accept the new keys after "Rotate keys now (revoke old)"; someone else may have collected the rotation. Disconnect and re-pair the site', log);
  }
  return last;
}

/** Fire-and-forget wrapper used by the heartbeat route (timer unref'd; failures only logged). */
export function scheduleRevokeConfirm(projectId, keyId, log) {
  confirmRevokeRotation(projectId, keyId, { log }).catch((err) => log?.warn?.({ projectId, err: { message: err?.message } }, 'EmDash revokePrev confirmation failed'));
}

/** Daily inventory for every paired EmDash project (leader only; called from the 03:00 cron). */
export async function syncAllEmdashProjects() {
  const ids = await pairedEmdashProjectIds();
  const results = [];
  for (const id of ids) {
    try {
      results.push({ projectId: id, ...(await syncEmdashInventory(id)) });
      // v1.5.0 §26.2: daily report pull (only sites with `reports`; bounded, read-only).
      const { pullSiteReports, hasReports } = await import('./cmsReports.js');
      const p = await prisma.project.findUnique({ where: { id }, select: { cmsCapabilities: true } });
      if (hasReports(p)) await pullSiteReports(id).catch(() => {});
      // v1.6.0 §36.1: daily security-status {detail: full} + security-history + backup-status (+ v1.6.1 settings).
      const { pullSecurityForProject } = await import('./security/securitySync.js');
      await pullSecurityForProject(id).catch(() => {});
      // v1.8.0 §39: the citation list (sites with seoCitations; read-only, no retries; events keep it current between
      // pulls). Skipped when fetched < 20 h ago with rev > 0; a rev-0 mirror (empty at pairing) is re-pulled (O-C180-5).
      const { pullCitationsIfCapable, DAILY_CITATIONS_FRESH_MS } = await import('./citations/citations.js');
      await pullCitationsIfCapable(id, { skipIfFreshMs: DAILY_CITATIONS_FRESH_MS }).catch(() => {});
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
        healed += await backfillEmdashHistory(projectId, res.review, { log });
      }
    } catch (err) {
      if (err?.code === 'SITE_MISMATCH') {
        // v1.0.5: the review belongs to a previous pairing; close the OS row (history kept), never retry.
        const row = await prisma.wpContentReview.findFirst({ where: { projectId, cmsReviewId: reviewId }, select: { wpPipelineId: true } }).catch(() => null);
        if (row) await closeForeignReview(projectId, row.wpPipelineId).catch(() => {});
      }
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
    let res;
    try {
      res = await emdashRoutes.eventsReplay(conn, { sinceCursor: since, limit: 500 });
    } catch (err) {
      await handleSiteRejection(project.id, err, log).catch(() => {});
      throw err;
    }
    // Never import events at or below the starting cursor (e.g. a new siteId's pairing point, which may
    // belong to the site's previous pairing; e2e OS issue 1), even if the site returns them.
    const floor = since;
    const events = (Array.isArray(res?.events) ? res.events : []).filter(
      (ev) =>
        Number.isInteger(ev?.cursor) &&
        ev.cursor > floor &&
        // v1.0.4 §17(a): only events stamped for the current siteId (none = older plugin = current).
        (ev.siteId === undefined || ev.siteId === project.cmsSiteId)
    );
    if (events.length === 0) {
      since = Math.max(since, Number(res?.lastCursor) || 0);
      if (!res?.more) break;
      continue;
    }
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
      const regression = await prismaCmsStore.findCounterRegression(project.id, chunk, project.cmsSiteId);
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
    where: { cmsType: 'EMDASH', cmsPairedAt: { not: null }, status: { not: 'ARCHIVED' }, cmsRepairNeededAt: null, cmsLastSeenAt: { lt: cutoff }, cmsLostNotifiedAt: null },
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
  // v1.5.6: previous-key ciphertext is useless once its overlap ended (revoked pairs are cleared at rotation).
  const prevKeys = await prisma.cmsCredential.updateMany({
    where: { prevExpiresAt: { lt: now }, OR: [{ inboundKeyPrevEnc: { not: null } }, { outboundKeyPrevEnc: { not: null } }] },
    data: { inboundKeyPrevEnc: null, outboundKeyPrevEnc: null },
  });
  return { receipts: receipts.count, nonces: nonces.count, expiredCodes: codes.count, expiredPrevKeys: prevKeys.count };
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
      // v1.5.0 §26.1: lead retention + pending photo copies (7-day window), leader only.
      const { leadHousekeeping } = await import('./cmsLeads.js');
      await leadHousekeeping({ log: logger });
      // Security platform retention (plan §5.4, admin setting, default 400 days): batched deletes, leader only.
      const { purgeSecurityHistory } = await import('./security/securityStore.js');
      await purgeSecurityHistory();
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
