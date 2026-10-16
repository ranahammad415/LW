/**
 * Contract v1.5.0 §26.3 (plan §7.3): moving a WordPress project's OS history onto its migrated EmDash site.
 * `planWpHistoryMove` is ported exactly from oasis-astro packages/os-bridge-contract/src/migration.mjs (2c59003).
 * `buildRekeyPlan` is OS-side: it decides the WpPage.wpPostId renumbering so EmDash events (keyed by entryNo) land on
 * the migrated rows instead of creating duplicates. Pure: no DB.
 */

/**
 * @param {{ wpPages: Array<{ wpPostId: number, url?: string }>, wpReviews: Array<{ wpPipelineId: number, wpPostId: number, status: string, isPublished?: boolean }> }} os
 * @param {Array<object>} mapItems  all migration-map items (every page fetched)
 * @returns {{ pages, reviews, redirected, dropped, unmatched, blockers, ok }}
 */
export function planWpHistoryMove({ wpPages = [], wpReviews = [] } = {}, mapItems = []) {
  const byPost = new Map(mapItems.map((m) => [m.wp_post_id, m]));
  const pages = [];
  const redirected = [];
  const dropped = [];
  const unmatched = [];
  for (const p of wpPages) {
    const m = byPost.get(p.wpPostId);
    if (!m) unmatched.push(p.wpPostId);
    else if (m.status === 'migrated') pages.push({ wpPostId: p.wpPostId, cmsEntryId: m.entry_id, cmsEntryNo: m.entry_no, cmsCollection: m.collection, newPath: m.new_path, oldUrl: m.old_url });
    else if (m.status === 'redirected') redirected.push({ wpPostId: p.wpPostId, oldUrl: m.old_url, redirectType: m.redirect_type ?? 301 });
    else dropped.push({ wpPostId: p.wpPostId, oldUrl: m.old_url });
  }
  const terminal = new Set(['published', 'cancelled', 'publish']);
  const blockers = wpReviews.filter((r) => !r.isPublished && !terminal.has(r.status)).map((r) => r.wpPipelineId);
  const reviews = wpReviews
    .filter((r) => byPost.get(r.wpPostId)?.status === 'migrated')
    .map((r) => ({ wpPipelineId: r.wpPipelineId, cmsEntryId: byPost.get(r.wpPostId).entry_id }));
  return { pages, reviews, redirected, dropped, unmatched, blockers, ok: blockers.length === 0 };
}

/**
 * Renumbering for the move (OS rule, not in the contract; review HIGH-1 / MEDIUM-HIGH-2):
 * - migrated rows take `wpPostId = entry_no` (the site's surrogate, as EmDash events use it);
 * - EVERY other WordPress page row with a positive number is parked at `-wpPostId` (kept, marked, never deleted), so
 *   no EmDash entry number — migrated or native, before or after cut-over — can ever land on a WordPress row;
 * - every WordPress review row (no cmsReviewId) with a positive number is parked at `-wpPipelineId` for the same reason.
 * Returns { moves, parks, reviewParks, postIdMap, conflicts }. `postIdMap` maps an old WP post id to its new number
 * (entry_no or -id), for review.wpPostId / parentWpPostId. `conflicts` lists impossible cases.
 */
export function buildRekeyPlan(plan, wpPages, wpReviews = []) {
  const targets = new Map(); // entry_no → wpPostId
  const conflicts = [];
  for (const p of plan.pages) {
    if (!Number.isInteger(p.cmsEntryNo) || p.cmsEntryNo < 1) {
      conflicts.push({ wpPostId: p.wpPostId, reason: 'entry_no missing' });
      continue;
    }
    if (targets.has(p.cmsEntryNo) && targets.get(p.cmsEntryNo) !== p.wpPostId) {
      conflicts.push({ wpPostId: p.wpPostId, reason: `entry_no ${p.cmsEntryNo} is mapped twice` });
      continue;
    }
    targets.set(p.cmsEntryNo, p.wpPostId);
  }
  const migrated = new Set(plan.pages.filter((p) => targets.get(p.cmsEntryNo) === p.wpPostId).map((p) => p.wpPostId));
  const existing = new Set(wpPages.map((p) => p.wpPostId));
  const parks = [];
  for (const p of wpPages) {
    if (migrated.has(p.wpPostId) || p.wpPostId <= 0 || p.cmsEntryId) continue;
    const to = -p.wpPostId;
    if (existing.has(to)) conflicts.push({ wpPostId: p.wpPostId, reason: `parking number ${to} is taken` });
    else parks.push({ from: p.wpPostId, to });
  }
  for (const p of wpPages) {
    if (p.cmsEntryId && p.wpPostId > 0 && targets.has(p.wpPostId) && targets.get(p.wpPostId) !== p.wpPostId) {
      conflicts.push({ wpPostId: p.wpPostId, reason: `entry_no ${p.wpPostId} is held by an EmDash row` });
    }
  }
  const moves = plan.pages.filter((p) => migrated.has(p.wpPostId) && p.wpPostId !== p.cmsEntryNo).map((p) => ({ from: p.wpPostId, to: p.cmsEntryNo }));
  const existingReviews = new Set(wpReviews.map((r) => r.wpPipelineId));
  const reviewParks = [];
  for (const r of wpReviews) {
    if (r.wpPipelineId <= 0 || r.cmsReviewId) continue;
    const to = -r.wpPipelineId;
    if (existingReviews.has(to)) conflicts.push({ wpPipelineId: r.wpPipelineId, reason: `review parking number ${to} is taken` });
    else reviewParks.push({ from: r.wpPipelineId, to });
  }
  const postIdMap = new Map();
  for (const p of plan.pages) if (migrated.has(p.wpPostId)) postIdMap.set(p.wpPostId, p.cmsEntryNo);
  for (const pk of parks) postIdMap.set(pk.from, pk.to);
  return { moves, parks, reviewParks, postIdMap, conflicts };
}

/** Normalised items of one migration-map page (defensive: bad items are skipped). */
export function sanitizeMapItems(items) {
  const STATUSES = new Set(['migrated', 'redirected', 'dropped']);
  return (Array.isArray(items) ? items : [])
    .filter((m) => m && Number.isInteger(m.wp_post_id) && m.wp_post_id > 0 && STATUSES.has(m.status))
    .map((m) => ({
      wp_post_id: m.wp_post_id,
      wp_post_type: typeof m.wp_post_type === 'string' ? m.wp_post_type.slice(0, 40) : null,
      old_url: typeof m.old_url === 'string' ? m.old_url.slice(0, 1000) : null,
      status: m.status,
      entry_id: typeof m.entry_id === 'string' ? m.entry_id.slice(0, 64) : null,
      entry_no: Number.isInteger(m.entry_no) ? m.entry_no : null,
      collection: typeof m.collection === 'string' ? m.collection.slice(0, 64) : null,
      new_path: typeof m.new_path === 'string' && m.new_path.startsWith('/') ? m.new_path.slice(0, 500) : null,
      redirect_type: [301, 302, 410].includes(m.redirect_type) ? m.redirect_type : null,
    }));
}

/** v1.5.0 site-info/handshake `migratedFrom` (never a key: only the last 4 characters as a hint). */
export function sanitizeMigratedFrom(v) {
  if (!v || typeof v !== 'object' || v.cms !== 'wordpress' || typeof v.siteUrl !== 'string') return null;
  return {
    cms: 'wordpress',
    siteUrl: v.siteUrl.slice(0, 500),
    migratedAt: typeof v.migratedAt === 'string' ? v.migratedAt.slice(0, 40) : null,
    mapEntries: Number.isInteger(v.mapEntries) && v.mapEntries >= 0 ? v.mapEntries : 0,
    wpPluginKeyHint: typeof v.wpPluginKeyHint === 'string' ? v.wpPluginKeyHint.slice(-4) : null,
  };
}
