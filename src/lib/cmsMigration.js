/**
 * EmDash v1.5.0 §26.3 (plan §7.3): move a WordPress project's OS history onto its migrated EmDash site.
 *
 * Flow (OWNER only, explicit):
 *   1. Pairing code with mode "migrate" on the WordPress project. The EmDash site pairs; the project stays WORDPRESS
 *      (WP sync, webhooks and keys unchanged). The site may heartbeat; its events are refused as retryable until
 *      cut-over so its outbox keeps them (they arrive after cut-over, from the stored cursor).
 *   2. Preview (dry run): the whole `migration-map` is fetched and planned (planWpHistoryMove + renumbering); nothing is
 *      written except the preview summary + map hash on Project.cmsMigration.
 *   3. Apply: the map is fetched again and must hash to the previewed one; then ONE transaction (project row locked)
 *      moves the history and cuts over. Applying twice returns the stored result (idempotent).
 * Never deleted: WpPage / WpPageSnapshot / WpContentReview(+events, comments) rows, content-map nodes, drifts, tasks.
 */
import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { credentialToRings, emdashRoutes, CmsBridgeError, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';
import { planWpHistoryMove, buildRekeyPlan, sanitizeMapItems, sanitizeMigratedFrom } from './siteAdapters/migration.js';

export const MIGRATION_ACTIVE_STATES = Object.freeze(['paired', 'previewed']);
const MAX_MAP_PAGES = 100; // × 500 = 50 000 entries
const TEMP_BASE = -1_000_000_000;

const bad = (message, code = 'VALIDATION', status = 400, details) => new CmsBridgeError({ status, code, message, retryable: false, details });

export function migrationState(project) {
  const m = project?.cmsMigration && typeof project.cmsMigration === 'object' ? project.cmsMigration : null;
  return m?.state || null;
}

/** The WordPress project has an EmDash site paired for migration and not cut over yet. */
export function isMigrationActive(project) {
  return project?.cmsType === 'WORDPRESS' && MIGRATION_ACTIVE_STATES.includes(migrationState(project));
}

async function loadMigrationProject(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: String(projectId) },
    select: { id: true, cmsType: true, wpUrl: true, wpApiKey: true, cmsSiteId: true, cmsContractVersion: true, cmsMigration: true, cmsHealth: true },
  });
  if (!project) throw bad('Project not found', 'NOT_FOUND', 404);
  return project;
}

/** Connection to the migrating EmDash site (its URL lives in cmsMigration.siteUrl until cut-over). */
async function migrationConnection(project) {
  const m = project.cmsMigration || {};
  if (!MIGRATION_ACTIVE_STATES.includes(m.state) || !m.siteUrl || !project.cmsSiteId) {
    throw bad('Pair the EmDash site with a migration pairing code first.', 'NOT_PAIRED', 409);
  }
  const cred = await prisma.cmsCredential.findUnique({ where: { projectId: project.id } });
  if (!cred) throw bad('Pair the EmDash site with a migration pairing code first.', 'NOT_PAIRED', 409);
  const rings = credentialToRings(cred, Date.now());
  return { siteUrl: String(m.siteUrl).replace(/\/$/, ''), siteId: project.cmsSiteId, inbound: rings.inbound };
}

/** Fetch the whole migration map (paged, ≤ 100 pages). */
export async function fetchWholeMap(conn, { fetchPage = (c, q) => emdashRoutes.migrationMap(c, q, { retryDelays: INTERACTIVE_RETRY_DELAYS_MS }) } = {}) {
  let cursor = null;
  let migratedFrom = null;
  const items = [];
  for (let i = 0; i < MAX_MAP_PAGES; i += 1) {
    const res = await fetchPage(conn, { ...(cursor ? { cursor } : {}), limit: 500 });
    migratedFrom = migratedFrom || sanitizeMigratedFrom(res?.migratedFrom);
    items.push(...sanitizeMapItems(res?.items));
    cursor = res?.next || null;
    if (!cursor) return { migratedFrom, items, complete: true };
  }
  return { migratedFrom, items, complete: false };
}

export function mapHash(items) {
  const sorted = [...items].sort((a, b) => a.wp_post_id - b.wp_post_id);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Identity check: the site says it replaces this project's WordPress site (URL host; last 4 of the old key). */
export function identityCheck(project, migratedFrom) {
  const siteUrlMatches = !!migratedFrom && hostOf(migratedFrom.siteUrl) === hostOf(project.wpUrl);
  const hint = migratedFrom?.wpPluginKeyHint || null;
  const keyHintMatches = hint && project.wpApiKey ? String(project.wpApiKey).slice(-4) === hint : null;
  return { siteUrlMatches, keyHintMatches, oldSiteUrl: migratedFrom?.siteUrl || null };
}

async function osRows(db, projectId) {
  const [wpPages, wpReviews] = await Promise.all([
    db.wpPage.findMany({ where: { projectId }, select: { id: true, wpPostId: true, url: true, title: true, cmsEntryId: true } }),
    db.wpContentReview.findMany({ where: { projectId }, select: { id: true, wpPipelineId: true, wpPostId: true, parentWpPostId: true, status: true, isPublished: true, postTitle: true, cmsReviewId: true } }),
  ]);
  return { wpPages, wpReviews };
}

function summarize(plan, rekey, map, project, rows) {
  const titleOf = new Map(rows.wpReviews.map((r) => [r.wpPipelineId, r.postTitle]));
  return {
    mapEntries: map.items.length,
    mapComplete: map.complete,
    pagesMigrated: plan.pages.length,
    reviewsMoved: plan.reviews.length,
    redirected: plan.redirected.length,
    dropped: plan.dropped.length,
    unmatched: plan.unmatched.length,
    renumbered: rekey.moves.length,
    parked: rekey.parks.length,
    reviewsParked: rekey.reviewParks.length,
    blockers: plan.blockers.map((id) => ({ wpPipelineId: id, title: titleOf.get(id) || null })),
    conflicts: rekey.conflicts,
    unmatchedPostIds: plan.unmatched.slice(0, 200),
    identity: identityCheck(project, map.migratedFrom),
  };
}

/** Dry run: fetch + plan, no history write. Stores { mapHash, summary } as the preview the apply must match. */
export async function previewMigration(projectId, { user, fetchPage, log } = {}) {
  const project = await loadMigrationProject(projectId);
  if (project.cmsType !== 'WORDPRESS') throw bad('Only a WordPress project can be migrated.');
  if (!isMigrationActive(project)) throw bad('Pair the EmDash site with a migration pairing code first.', 'NOT_PAIRED', 409);
  const conn = await migrationConnection(project);
  const map = await fetchWholeMap(conn, fetchPage ? { fetchPage } : undefined);
  const rows = await osRows(prisma, project.id);
  const plan = planWpHistoryMove({ wpPages: rows.wpPages, wpReviews: rows.wpReviews }, map.items);
  const rekey = buildRekeyPlan(plan, rows.wpPages, rows.wpReviews);
  const summary = summarize(plan, rekey, map, project, rows);
  const hash = mapHash(map.items);
  // Review LOW-7: a preview never overwrites an applied (or reset) migration — checked under the project row lock.
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${project.id} FOR UPDATE`;
      const fresh = await tx.project.findUnique({ where: { id: project.id }, select: { cmsType: true, cmsMigration: true } });
      if (fresh?.cmsType !== 'WORDPRESS' || !MIGRATION_ACTIVE_STATES.includes(fresh?.cmsMigration?.state) || fresh.cmsMigration.siteUrl !== project.cmsMigration.siteUrl) {
        throw bad('The migration was applied or re-paired meanwhile. Reload.', 'INVALID_TRANSITION', 409);
      }
      await tx.project.update({
        where: { id: project.id },
        data: { cmsMigration: { ...fresh.cmsMigration, state: 'previewed', migratedFrom: map.migratedFrom, preview: { mapHash: hash, summary, siteUrl: fresh.cmsMigration.siteUrl, at: new Date().toISOString(), byId: user?.id || null } } },
      });
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  log?.info?.({ projectId: project.id, pages: summary.pagesMigrated, blockers: summary.blockers.length }, 'WP → EmDash migration previewed');
  return { mapHash: hash, summary, canApply: plan.ok && rekey.conflicts.length === 0 && map.complete };
}

/**
 * Apply the previewed move in one transaction and cut over. `opts`: { mapHash (from the preview), confirmIdentity }.
 * Returns the stored result; a second call after success returns the same result without writing.
 */
export async function applyMigration(projectId, { user, mapHash: expectedHash, confirmIdentity = false, confirmEmpty = false, fetchPage, log } = {}) {
  const project = await loadMigrationProject(projectId);
  if (migrationState(project) === 'applied') return { ...(project.cmsMigration.result || {}), alreadyApplied: true };
  if (project.cmsType !== 'WORDPRESS' || migrationState(project) !== 'previewed') throw bad('Run the preview first.', 'INVALID_TRANSITION', 409);
  if (!expectedHash || project.cmsMigration?.preview?.mapHash !== expectedHash) throw bad('The preview is out of date. Preview again.', 'CONFLICT_REV', 409);
  const conn = await migrationConnection(project);
  const map = await fetchWholeMap(conn, fetchPage ? { fetchPage } : undefined);
  if (!map.complete) throw bad('The migration map is larger than Agency OS can move in one step.', 'VALIDATION', 422);
  if (mapHash(map.items) !== expectedHash) throw bad('The site’s migration map changed since the preview. Preview again.', 'CONFLICT_REV', 409);
  const identity = identityCheck(project, map.migratedFrom);
  if ((!identity.siteUrlMatches || identity.keyHintMatches === false) && !confirmIdentity) {
    throw bad('The site’s former address or key hint does not match this project. Confirm the match to continue.', 'IDENTITY_UNCONFIRMED', 409, { identity });
  }
  const siteUrlAtStart = project.cmsMigration.siteUrl;
  const newOrigin = String(siteUrlAtStart).replace(/\/$/, '');
  const byPost = new Map(map.items.map((m) => [m.wp_post_id, m]));

  const result = await prisma.$transaction(
    async (tx) => {
      // Lock the project row: a second apply (another PM2 instance) waits here and then sees `applied`.
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${project.id} FOR UPDATE`;
      const fresh = await tx.project.findUnique({ where: { id: project.id }, select: { cmsType: true, cmsMigration: true } });
      if (fresh?.cmsMigration?.state === 'applied') return { ...(fresh.cmsMigration.result || {}), alreadyApplied: true };
      if (fresh?.cmsType !== 'WORDPRESS') throw bad('The project is no longer a WordPress project.', 'INVALID_TRANSITION', 409);
      // Review LOW-8: re-check under the lock what the preview promised.
      if (fresh.cmsMigration?.state !== 'previewed' || fresh.cmsMigration?.preview?.mapHash !== expectedHash) {
        throw bad('The preview changed meanwhile. Preview again.', 'CONFLICT_REV', 409);
      }
      if (fresh.cmsMigration?.siteUrl !== siteUrlAtStart) throw bad('The paired site changed meanwhile. Preview again.', 'CONFLICT_REV', 409);

      const rows = await osRows(tx, project.id);
      const plan = planWpHistoryMove({ wpPages: rows.wpPages, wpReviews: rows.wpReviews }, map.items);
      if (!plan.ok) throw bad('Open WordPress reviews must be completed or cancelled first.', 'MIGRATION_BLOCKED', 409, { blockers: plan.blockers });
      if (plan.pages.length === 0 && !confirmEmpty) {
        throw bad('The map moves no page onto the EmDash site. Confirm to cut over anyway.', 'MIGRATION_EMPTY', 409);
      }
      const rekey = buildRekeyPlan(plan, rows.wpPages, rows.wpReviews);
      if (rekey.conflicts.length) throw bad('The map cannot be applied safely (number conflicts).', 'MIGRATION_CONFLICT', 409, { conflicts: rekey.conflicts });
      const pageByPost = new Map(rows.wpPages.map((p) => [p.wpPostId, p]));
      // Review MEDIUM-HIGH-2: the counter floor covers every number WordPress issued, including during the window;
      // it is sent in the next handshake responses (the site raises its counters, compare-and-set).
      const maxOf = (list) => list.reduce((a, b) => (Number.isInteger(b) && b > a ? b : a), 0);
      const counterFloor = {
        entryNo: Math.max(maxOf(rows.wpPages.map((p) => p.wpPostId)), maxOf(plan.pages.map((p) => p.cmsEntryNo))),
        reviewNo: maxOf(rows.wpReviews.map((r) => r.wpPipelineId)),
      };
      const tombMax = await tx.wpContentReviewTombstone.aggregate({ where: { projectId: project.id }, _max: { wpPipelineId: true } });
      counterFloor.reviewNo = Math.max(counterFloor.reviewNo, tombMax?._max?.wpPipelineId || 0);

      // 1) migrated rows that change number go to unique temporary numbers
      const temp = new Map();
      let i = 0;
      for (const mv of rekey.moves) {
        const t = TEMP_BASE - i;
        i += 1;
        temp.set(mv.from, t);
        await tx.wpPage.update({ where: { id: pageByPost.get(mv.from).id }, data: { wpPostId: t } });
      }
      // 2) EVERY other WordPress page is parked at -wpPostId (kept, recorded): no EmDash entry number can land on it
      for (const pk of rekey.parks) {
        const m = byPost.get(pk.from);
        const status = !m || m.status === 'migrated' ? 'unmatched' : m.status;
        await tx.wpPage.update({
          where: { id: pageByPost.get(pk.from).id },
          data: { wpPostId: pk.to, cmsMigration: { status, oldWpPostId: pk.from, oldUrl: m?.old_url || pageByPost.get(pk.from).url || null, parked: true, ...(m?.redirect_type ? { redirectType: m.redirect_type } : {}) } },
        });
      }
      // 3) migrated rows: final number = entry_no, EmDash ids and the new URL; snapshots stay attached (same row id)
      for (const p of plan.pages) {
        await tx.wpPage.update({
          where: { id: pageByPost.get(p.wpPostId).id },
          data: {
            ...(temp.has(p.wpPostId) ? { wpPostId: p.cmsEntryNo } : {}),
            cmsEntryId: p.cmsEntryId,
            cmsCollection: p.cmsCollection,
            ...(p.newPath ? { url: `${newOrigin}${p.newPath}`.slice(0, 1000) } : {}),
            cmsMigration: { status: 'migrated', oldWpPostId: p.wpPostId, oldUrl: p.oldUrl || null, newPath: p.newPath || null },
          },
        });
      }
      // 4) WordPress reviews (review MEDIUM-HIGH-2 / MEDIUM-3): parked at -wpPipelineId so no EmDash review number
      //    can land on them; wpPostId / parentWpPostId follow their page (entry_no or the parked -id), so history stays
      //    with the right page; reviews of migrated posts also get the entry id (events, comments, isPublished untouched).
      const reviewTo = new Map(rekey.reviewParks.map((x) => [x.from, x.to]));
      let reviewsMoved = 0;
      for (const rv of rows.wpReviews) {
        if (rv.cmsReviewId) continue;
        const data = {};
        if (reviewTo.has(rv.wpPipelineId)) data.wpPipelineId = reviewTo.get(rv.wpPipelineId);
        if (rekey.postIdMap.has(rv.wpPostId)) data.wpPostId = rekey.postIdMap.get(rv.wpPostId);
        if (rv.parentWpPostId != null && rekey.postIdMap.has(rv.parentWpPostId)) data.parentWpPostId = rekey.postIdMap.get(rv.parentWpPostId);
        const m = byPost.get(rv.wpPostId);
        if (m?.status === 'migrated' && m.entry_id && rekey.postIdMap.get(rv.wpPostId) === m.entry_no) {
          data.cmsEntryId = m.entry_id;
          reviewsMoved += 1;
        }
        if (Object.keys(data).length) await tx.wpContentReview.update({ where: { id: rv.id }, data });
      }
      // Owner-deleted WordPress review numbers are parked too: they never block (or hide) a new EmDash review number.
      const tombs = await tx.wpContentReviewTombstone.findMany({ where: { projectId: project.id }, select: { id: true, wpPipelineId: true } });
      const tombNos = new Set(tombs.map((t) => t.wpPipelineId));
      for (const t of tombs) {
        if (t.wpPipelineId <= 0) continue;
        if (tombNos.has(-t.wpPipelineId)) await tx.wpContentReviewTombstone.delete({ where: { id: t.id } });
        else await tx.wpContentReviewTombstone.update({ where: { id: t.id }, data: { wpPipelineId: -t.wpPipelineId } });
      }
      // 5) content-map URLs: old_url → new address (migrated items only)
      let nodesRewritten = 0;
      for (const p of plan.pages) {
        if (!p.oldUrl || !p.newPath) continue;
        const variants = [...new Set([p.oldUrl, p.oldUrl.replace(/\/$/, ''), `${p.oldUrl.replace(/\/$/, '')}/`])];
        const r = await tx.contentMapNode.updateMany({ where: { map: { projectId: project.id }, url: { in: variants } }, data: { url: `${newOrigin}${p.newPath}`.slice(0, 500) } });
        nodesRewritten += r.count || 0;
      }
      // 6) cut-over: EmDash from now on; the WordPress key is revoked (cleared) so WP webhooks stop resolving
      const out = {
        pagesMigrated: plan.pages.length,
        reviewsMoved,
        reviewsParked: rekey.reviewParks.length,
        renumbered: rekey.moves.length,
        parked: rekey.parks.length,
        redirected: plan.redirected.length,
        dropped: plan.dropped.length,
        unmatched: plan.unmatched.length,
        nodesRewritten,
        appliedAt: new Date().toISOString(),
      };
      await tx.project.update({
        where: { id: project.id },
        data: {
          cmsType: 'EMDASH',
          wpUrl: newOrigin,
          wpApiKey: null,
          cmsMigration: {
            ...(fresh.cmsMigration || {}),
            state: 'applied',
            appliedById: user?.id || null,
            oldWpUrl: project.wpUrl || null,
            oldWpKeyHint: project.wpApiKey ? String(project.wpApiKey).slice(-4) : null,
            identityConfirmed: !!confirmIdentity,
            counterFloor,
            result: out,
          },
        },
      });
      return out;
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
  log?.info?.({ projectId: project.id, ...result }, 'WP → EmDash migration applied');
  return result;
}
