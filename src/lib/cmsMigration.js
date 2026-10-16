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
    db.wpContentReview.findMany({ where: { projectId }, select: { id: true, wpPipelineId: true, wpPostId: true, parentWpPostId: true, status: true, isPublished: true, postTitle: true } }),
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
  const rekey = buildRekeyPlan(plan, rows.wpPages);
  const summary = summarize(plan, rekey, map, project, rows);
  const hash = mapHash(map.items);
  await prisma.project.update({
    where: { id: project.id },
    data: { cmsMigration: { ...(project.cmsMigration || {}), state: 'previewed', migratedFrom: map.migratedFrom, preview: { mapHash: hash, summary, at: new Date().toISOString(), byId: user?.id || null } } },
  });
  log?.info?.({ projectId: project.id, pages: summary.pagesMigrated, blockers: summary.blockers.length }, 'WP → EmDash migration previewed');
  return { mapHash: hash, summary, canApply: plan.ok && rekey.conflicts.length === 0 && map.complete };
}

/**
 * Apply the previewed move in one transaction and cut over. `opts`: { mapHash (from the preview), confirmIdentity }.
 * Returns the stored result; a second call after success returns the same result without writing.
 */
export async function applyMigration(projectId, { user, mapHash: expectedHash, confirmIdentity = false, fetchPage, log } = {}) {
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
  const newOrigin = String(project.cmsMigration.siteUrl).replace(/\/$/, '');
  const byPost = new Map(map.items.map((m) => [m.wp_post_id, m]));

  const result = await prisma.$transaction(
    async (tx) => {
      // Lock the project row: a second apply (another PM2 instance) waits here and then sees `applied`.
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${project.id} FOR UPDATE`;
      const fresh = await tx.project.findUnique({ where: { id: project.id }, select: { cmsType: true, cmsMigration: true } });
      if (fresh?.cmsMigration?.state === 'applied') return { ...(fresh.cmsMigration.result || {}), alreadyApplied: true };
      if (fresh?.cmsType !== 'WORDPRESS') throw bad('The project is no longer a WordPress project.', 'INVALID_TRANSITION', 409);

      const rows = await osRows(tx, project.id);
      const plan = planWpHistoryMove({ wpPages: rows.wpPages, wpReviews: rows.wpReviews }, map.items);
      if (!plan.ok) throw bad('Open WordPress reviews must be completed or cancelled first.', 'MIGRATION_BLOCKED', 409, { blockers: plan.blockers });
      const rekey = buildRekeyPlan(plan, rows.wpPages);
      if (rekey.conflicts.length) throw bad('The map cannot be applied safely (number conflicts).', 'MIGRATION_CONFLICT', 409, { conflicts: rekey.conflicts });
      const pageByPost = new Map(rows.wpPages.map((p) => [p.wpPostId, p]));

      // 1) migrated rows that change number go to unique temporary numbers
      const temp = new Map();
      let i = 0;
      for (const mv of rekey.moves) {
        const t = TEMP_BASE - i;
        i += 1;
        temp.set(mv.from, t);
        await tx.wpPage.update({ where: { id: pageByPost.get(mv.from).id }, data: { wpPostId: t } });
      }
      // 2) rows in the way are parked at -wpPostId (kept, recorded)
      for (const pk of rekey.parks) {
        const m = byPost.get(pk.from);
        await tx.wpPage.update({
          where: { id: pageByPost.get(pk.from).id },
          data: { wpPostId: pk.to, cmsMigration: { status: m?.status || 'unmatched', oldWpPostId: pk.from, oldUrl: m?.old_url || pageByPost.get(pk.from).url || null, parked: true, ...(m?.redirect_type ? { redirectType: m.redirect_type } : {}) } },
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
      // 4) redirected / dropped / unmatched rows that were not parked: keep, record the status
      const parked = new Set(rekey.parks.map((x) => x.from));
      const record = async (wpPostId, data) => {
        if (parked.has(wpPostId)) return;
        await tx.wpPage.update({ where: { id: pageByPost.get(wpPostId).id }, data: { cmsMigration: data } });
      };
      for (const r of plan.redirected) await record(r.wpPostId, { status: 'redirected', oldWpPostId: r.wpPostId, oldUrl: r.oldUrl || null, redirectType: r.redirectType });
      for (const d of plan.dropped) await record(d.wpPostId, { status: 'dropped', oldWpPostId: d.wpPostId, oldUrl: d.oldUrl || null });
      for (const u of plan.unmatched) await record(u, { status: 'unmatched', oldWpPostId: u, oldUrl: pageByPost.get(u)?.url || null });
      // 5) reviews of migrated posts: entry id + entry number (history, events, comments untouched; isPublished untouched)
      const entryNoOf = new Map(plan.pages.map((p) => [p.wpPostId, p.cmsEntryNo]));
      for (const rv of rows.wpReviews) {
        const m = byPost.get(rv.wpPostId);
        const parentNo = rv.parentWpPostId != null ? entryNoOf.get(rv.parentWpPostId) : undefined;
        if (m?.status !== 'migrated' && parentNo === undefined) continue;
        await tx.wpContentReview.update({
          where: { id: rv.id },
          data: {
            ...(m?.status === 'migrated' ? { cmsEntryId: m.entry_id, wpPostId: m.entry_no } : {}),
            ...(parentNo !== undefined ? { parentWpPostId: parentNo } : {}),
          },
        });
      }
      // 6) content-map URLs: old_url → new address (migrated items only)
      let nodesRewritten = 0;
      for (const p of plan.pages) {
        if (!p.oldUrl || !p.newPath) continue;
        const variants = [...new Set([p.oldUrl, p.oldUrl.replace(/\/$/, ''), `${p.oldUrl.replace(/\/$/, '')}/`])];
        const r = await tx.contentMapNode.updateMany({ where: { map: { projectId: project.id }, url: { in: variants } }, data: { url: `${newOrigin}${p.newPath}`.slice(0, 500) } });
        nodesRewritten += r.count || 0;
      }
      // 7) cut-over: EmDash from now on; the WordPress key is revoked (cleared) so WP webhooks stop resolving
      const out = {
        pagesMigrated: plan.pages.length,
        reviewsMoved: plan.reviews.length,
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
