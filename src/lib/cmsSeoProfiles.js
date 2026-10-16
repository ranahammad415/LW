/**
 * EmDash v1.4.0 (§25): SEO profile views, proposals and seo.* events on the OS side.
 * - Reads (profiles-list, profile-get, keyword-registry, brief-get) are live, signed bridge calls; the list also
 *   refreshes the CmsSeoProfile mirror.
 * - Proposals are created from the OS (human OWNER / lead PM); deciding them stays in the EmDash admin (D13).
 * - seo.profile_changed with OS-owned fields → ContentMapDrift(PROFILE_CHANGED) rows for the PM; nothing is
 *   overwritten on either side (D14). Profile events are ordered by profile.updated_at (no per-review seq).
 * - A retryable 503 (emdash-seo warming up after a site restart) is shown as "try again shortly" and never flags
 *   re-pair (only 401 UNKNOWN_SITE / UNKNOWN_KEY does, in handleSiteRejection).
 */
import { prisma } from './prisma.js';
import { loadEmdashConnection } from './cmsStore.js';
import { CmsBridgeError, emdashRoutes, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';
import {
  PAGE_ID,
  PROFILE_LIMITS,
  profileSummaryToRow,
  proposalToRow,
  proposalStateAdvances,
  validateProposal,
  osOwnedChanges,
  clampProfile,
} from './siteAdapters/profiles.js';

const INTERACTIVE = { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, timeoutMs: 15_000 };
const bad = (message, code = 'VALIDATION', status = 400, details) => new CmsBridgeError({ status, code, message, retryable: false, details });

export function hasSeoProfiles(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.seoProfiles === true;
}

export async function loadProfileProject(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: String(projectId) },
    select: { id: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true },
  });
  if (!project) throw bad('Project not found', 'NOT_FOUND', 404);
  if (project.cmsType !== 'EMDASH') throw bad('SEO profiles are available for EmDash sites only.');
  if (!hasSeoProfiles(project)) throw bad('This site does not share SEO profiles with Agency OS yet.', 'NOT_IMPLEMENTED', 409);
  if (project.cmsRepairNeededAt) throw bad('The website connection needs to be renewed (re-pair) first.', 'NOT_PAIRED', 503);
  return project;
}

/** Friendly text for the transient 503 right after a site restart (§ inbox: up to 15 min). */
export function profileErrorMessage(err) {
  if (err?.code === 'UPSTREAM_UNAVAILABLE' || (err?.status === 503 && err?.retryable)) {
    return 'The site’s SEO data is not ready yet (the site may have just restarted). Try again in a few minutes.';
  }
  if (err?.code === 'NOT_IMPLEMENTED') return 'This site does not share SEO profiles with Agency OS yet.';
  return null;
}

async function upsertProfileRow(projectId, row, { force = false } = {}) {
  const existing = await prisma.cmsSeoProfile.findUnique({ where: { projectId_pageId: { projectId, pageId: row.pageId } }, select: { id: true, siteUpdatedAt: true } });
  if (existing && !force && existing.siteUpdatedAt && row.siteUpdatedAt && row.siteUpdatedAt < existing.siteUpdatedAt) return 'stale';
  if (existing) await prisma.cmsSeoProfile.update({ where: { id: existing.id }, data: row });
  else await prisma.cmsSeoProfile.create({ data: { projectId, ...row } }).catch(async (e) => {
    if (!/Unique constraint|P2002/.test(String(e?.code || e?.message))) throw e;
    await prisma.cmsSeoProfile.update({ where: { projectId_pageId: { projectId, pageId: row.pageId } }, data: row });
  });
  return 'applied';
}

/** Content-map nodes of the project that correspond to a profile: by entry id (WpPage), then by path. */
export async function nodesForProfile(projectId, row) {
  let nodes = [];
  if (row.entryId) {
    const pages = await prisma.wpPage.findMany({ where: { projectId, cmsEntryId: row.entryId }, select: { id: true } });
    if (pages.length) {
      nodes = await prisma.contentMapNode.findMany({ where: { map: { projectId }, wpPageId: { in: pages.map((p) => p.id) } }, select: { id: true, mapId: true, wpPageId: true } });
    }
  }
  if (!nodes.length && row.path) {
    nodes = await prisma.contentMapNode.findMany({
      where: { map: { projectId }, OR: [{ cmsPageId: row.pageId }, { url: { endsWith: row.path } }] },
      select: { id: true, mapId: true, wpPageId: true },
      take: 20,
    });
  }
  return nodes;
}

/** D14: one pending PROFILE_CHANGED drift per node/map; later changes merge their fields into it. */
async function recordProfileDrift(projectId, row, changes, actorName) {
  const nodes = await nodesForProfile(projectId, row);
  if (nodes.length) {
    await prisma.contentMapNode.updateMany({ where: { id: { in: nodes.map((n) => n.id) } }, data: { cmsPageId: row.pageId } }).catch(() => {});
  }
  const targets = nodes.length
    ? nodes.map((n) => ({ mapId: n.mapId, nodeId: n.id, wpPageId: n.wpPageId || null }))
    : (await prisma.contentMap.findMany({ where: { projectId, status: { not: 'ARCHIVED' } }, select: { id: true } })).map((m) => ({ mapId: m.id, nodeId: null, wpPageId: null }));
  let created = 0;
  for (const t of targets) {
    const pending = await prisma.contentMapDrift.findFirst({
      where: { mapId: t.mapId, driftType: 'PROFILE_CHANGED', status: 'PENDING', ...(t.nodeId ? { nodeId: t.nodeId } : {}) },
      select: { id: true, payload: true },
    });
    const fields = changes.map((c) => c.field);
    if (pending && (t.nodeId || pending.payload?.pageId === row.pageId)) {
      const prev = Array.isArray(pending.payload?.fields) ? pending.payload.fields : [];
      await prisma.contentMapDrift.update({
        where: { id: pending.id },
        data: { payload: { ...(pending.payload || {}), fields: [...new Set([...prev, ...fields])].slice(0, 50), profileHash: row.profileHash, changedBy: actorName, at: row.siteUpdatedAt } },
      });
      continue;
    }
    await prisma.contentMapDrift.create({
      data: {
        mapId: t.mapId,
        nodeId: t.nodeId,
        wpPageId: t.wpPageId,
        driftType: 'PROFILE_CHANGED',
        payload: { pageId: row.pageId, path: row.path, fields: fields.slice(0, 50), profileHash: row.profileHash, changedBy: actorName, at: row.siteUpdatedAt },
      },
    });
    created += 1;
  }
  return created;
}

/**
 * Apply one seo.* event (§25.4). Returns 'applied' | 'stale' | 'stored'. Reserved seo.* types are stored only.
 */
export async function applySeoEvent(projectId, ev) {
  const actorName = ev?.actor?.name ? String(ev.actor.name).slice(0, 200) : null;
  switch (ev?.type) {
    case 'seo.profile_changed':
    case 'seo.contract_locked': {
      const row = profileSummaryToRow(ev.profile);
      if (!row) return 'stored';
      const outcome = await upsertProfileRow(projectId, row);
      if (outcome === 'stale') return 'stale';
      if (ev.type === 'seo.profile_changed') {
        const changes = osOwnedChanges(ev.changed);
        if (changes.length) await recordProfileDrift(projectId, row, changes, actorName);
      }
      return 'applied';
    }
    case 'seo.proposal_opened':
    case 'seo.proposal_decided': {
      const row = proposalToRow(ev.proposal);
      if (!row) return 'stored';
      const existing = await prisma.cmsSeoProposal.findUnique({ where: { projectId_proposalId: { projectId, proposalId: row.proposalId } }, select: { id: true, state: true } });
      if (existing && !proposalStateAdvances(existing.state, row.state)) return 'stale';
      if (existing) await prisma.cmsSeoProposal.update({ where: { id: existing.id }, data: row });
      else await prisma.cmsSeoProposal.create({ data: { projectId, ...row } });
      return 'applied';
    }
    case 'seo.check_failed': {
      const c = ev.check;
      if (!c || !PAGE_ID.test(String(c.page_id || ''))) return 'stored';
      const lastCheck = {
        variant: c.variant === 'live' ? 'live' : 'draft',
        trigger: c.trigger ? String(c.trigger).slice(0, 32) : null,
        summary: c.summary && typeof c.summary === 'object' ? { block: Number(c.summary.block) || 0, warn: Number(c.summary.warn) || 0, info: Number(c.summary.info) || 0 } : null,
        failed: Array.isArray(c.failed) ? c.failed.slice(0, 50).map((f) => ({ id: String(f?.id || '').slice(0, 100), severity: f?.severity, message: f?.message ? String(f.message).slice(0, 500) : null, path: f?.path ? String(f.path).slice(0, 200) : null })) : [],
        at: ev.at || null,
      };
      await prisma.cmsSeoProfile.upsert({
        where: { projectId_pageId: { projectId, pageId: String(c.page_id) } },
        update: { lastCheck },
        create: { projectId, pageId: String(c.page_id), lastCheck },
      });
      return 'applied';
    }
    default:
      return 'stored';
  }
}

// ─────────────────────────────── reads ───────────────────────────────

/** profiles-list (one page) → mirror refresh + the page. */
export async function listProfiles(projectId, { cursor = null, status = null } = {}) {
  await loadProfileProject(projectId);
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.profilesList(conn, { ...(cursor ? { cursor: String(cursor).slice(0, 512) } : {}), ...(status ? { status: String(status).slice(0, 32) } : {}), limit: PROFILE_LIMITS.listLimit }, INTERACTIVE);
  const items = [];
  for (const p of Array.isArray(res?.items) ? res.items : []) {
    const row = profileSummaryToRow(p);
    if (!row) continue;
    await upsertProfileRow(projectId, row).catch(() => {});
    items.push(row);
  }
  return { items, next: res?.next || null };
}

export async function getProfile(projectId, pageId) {
  if (!PAGE_ID.test(String(pageId || ''))) throw bad('Unknown page');
  await loadProfileProject(projectId);
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.profileGet(conn, { page_id: String(pageId) }, INTERACTIVE);
  return clampProfile(res?.profile);
}

export async function getKeywordRegistry(projectId, { cursor = null, role = null } = {}) {
  await loadProfileProject(projectId);
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.keywordRegistry(conn, { ...(cursor ? { cursor: String(cursor).slice(0, 512) } : {}), ...(role ? { role } : {}), limit: PROFILE_LIMITS.listLimit }, INTERACTIVE);
  return { items: Array.isArray(res?.items) ? res.items.slice(0, PROFILE_LIMITS.listLimit) : [], next: res?.next || null };
}

export async function getBrief(projectId, pageId) {
  if (!PAGE_ID.test(String(pageId || ''))) throw bad('Unknown page');
  await loadProfileProject(projectId);
  const { conn } = await loadEmdashConnection(projectId);
  try {
    const res = await emdashRoutes.briefGet(conn, { page_id: String(pageId) }, INTERACTIVE);
    const b = res?.brief || null;
    return b ? { page_id: b.page_id, markdown: String(b.markdown || '').slice(0, PROFILE_LIMITS.briefBytes), hash: b.hash || null, imported_on: b.imported_on || null } : null;
  } catch (err) {
    if (err instanceof CmsBridgeError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

// ─────────────────────────────── proposals ───────────────────────────────

/** Human OWNER or the project's lead PM; deciding is never possible from the OS (D13). */
export function canPropose(user, project) {
  if (user?.role === 'OWNER') return true;
  return user?.role === 'PM' && project.leadPmId === user.id;
}

export async function createProposal({ projectId, pageId, patch, reason, user, log }) {
  const project = await loadProfileProject(projectId);
  if (!canPropose(user, project)) throw bad('Only an OWNER or the project lead PM can propose profile changes.', 'FORBIDDEN', 403);
  const v = validateProposal({ pageId, patch, reason });
  if (!v.ok) throw bad('Fix the proposal first.', 'VALIDATION', 400, { errors: v.errors });
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.proposalCreate(
    conn,
    {
      page_id: String(pageId),
      patch: patch.map((op) => (op.op === 'remove' ? { op: op.op, path: op.path } : { op: op.op, path: op.path, value: op.value })),
      reason: String(reason).trim(),
      actor: { kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), role: user.role },
    },
    INTERACTIVE
  );
  const row = proposalToRow(res?.proposal);
  if (row) {
    await prisma.cmsSeoProposal
      .upsert({ where: { projectId_proposalId: { projectId, proposalId: row.proposalId } }, update: row, create: { projectId, ...row } })
      .catch(() => {});
  }
  log?.info?.({ projectId, pageId, ops: patch.length }, 'EmDash SEO proposal created');
  return row;
}

export async function listProposals(projectId, pageId) {
  return prisma.cmsSeoProposal.findMany({
    where: { projectId, ...(pageId ? { pageId: String(pageId) } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
