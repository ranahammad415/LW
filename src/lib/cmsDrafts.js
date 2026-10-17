/**
 * EmDash v1.2 (§22 + §23 errata): drafts written in Agency OS and pushed to the site (`draft-upsert`), plus image
 * import (`media-import`). The site always stores a draft; nothing here publishes.
 *
 * Who: OWNER, the project's lead PM, and the TEAM_MEMBER / CONTRACTOR assigned to the linked content-map node or
 * task. Never clients. Every push is one user action with one idempotency key (retries of the same body reuse it).
 * Actor: `human`, or `agent` (with the triggering user's osUserId) while the content is AI-written and unedited.
 */
import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { loadEmdashConnection, mirrorEmdashReview, listPms } from './cmsStore.js';
import {
  CmsBridgeError,
  emdashRoutes,
  hasLayoutRead,
  INTERACTIVE_RETRY_DELAYS_MS,
} from './siteAdapters/emdash.js';
import { prepareDraftPush, checkMediaItems, checkLayout, draftFromEntryGet, MEDIA_LIMITS, MEDIA_TYPES, DRAFT_LIMITS } from './siteAdapters/push.js';
import { probeImage } from './imageProbe.js';
import { guardedFetch } from './siteAdapters/netGuard.js';
import { ensureProjectAccess } from './ensureProjectAccess.js';

export const DRAFT_STAFF_ROLES = Object.freeze(['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR']);
const INTERACTIVE = { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, timeoutMs: 20_000 };
const SITE_INFO_TTL_MS = 60_000;
/** AI writer caps (AiUsageLog rules): per user and per client per day; one generation per click; never in crons. */
export const AI_DRAFT_LIMITS = Object.freeze({ perUserPerDay: 10, perClientPerDay: 30, maxTokens: 4000, feature: 'cms_draft_writer' });

const bad = (message, code = 'VALIDATION', status = 400, details) => new CmsBridgeError({ status, code, message, retryable: false, details });
/** A push claim older than this is treated as abandoned (the process died mid-push). */
export const PUSH_CLAIM_STALE_MS = 3 * 60_000;

/**
 * Raw HTML in markdown (review LOW-10): only real tags count — a known HTML element name followed by `>`, `/>` or
 * name=value attributes, a closing tag, or a comment. `a <b and c> d` and autolinks (`<https://…>`) are text.
 */
const HTML_ELEMENTS =
  'a|abbr|address|article|aside|audio|b|bdi|bdo|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|meta|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|q|s|samp|script|section|select|small|source|span|strike|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr';
const HTML_TAG_RE = new RegExp(
  String.raw`<!--|<\/(?:${HTML_ELEMENTS})\s*>|<(?:${HTML_ELEMENTS})(?:\s*\/?>|\s+[a-z_:][-a-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)[^<>]*>)`,
  'i'
);
export function hasHtmlTag(markdown) {
  return HTML_TAG_RE.test(String(markdown || ''));
}

/**
 * Edit markers for an OS edit (review MEDIUM-4 / LOW-10): only fields whose value really changed count.
 * `bylinesEdited` makes the next update send bylines; `cmsEditedAt` marks unpushed edits (cleared by a push or reload).
 */
export function draftEditMarkers(prev, data, now = new Date()) {
  const changed = Object.keys(data).filter((k) => JSON.stringify(data[k] ?? null) !== JSON.stringify(prev?.[k] ?? null));
  return {
    ...(changed.includes('bylines') ? { bylinesEdited: true } : {}),
    ...(changed.length ? { cmsEditedAt: now } : {}),
  };
}

// ─────────────────────────────── access ───────────────────────────────

export async function loadDraftProject(projectId) {
  const project = await prisma.project.findUnique({
    where: { id: String(projectId) },
    select: { id: true, name: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true, cmsSiteId: true },
  });
  if (!project) throw bad('Project not found', 'NOT_FOUND', 404);
  if (project.cmsType !== 'EMDASH') throw bad('Site drafts are available for EmDash sites only.');
  return project;
}

/**
 * OWNER; the project's lead PM; a TEAM_MEMBER/CONTRACTOR assigned to the linked node or task. Clients never.
 * `link` = { contentMapNodeId?, taskId? } (validated against the project).
 */
export async function canWriteDraft(user, project, link = {}) {
  if (!user || !DRAFT_STAFF_ROLES.includes(user.role)) return false;
  if (user.role === 'OWNER') return true;
  if (user.role === 'PM') return project.leadPmId === user.id;
  if (link.contentMapNodeId) {
    const node = await prisma.contentMapNode.findFirst({
      where: { id: link.contentMapNodeId, map: { projectId: project.id } },
      select: { assigneeId: true, taskId: true },
    });
    if (node?.assigneeId === user.id) return true;
    if (node?.taskId && !link.taskId) link = { ...link, taskId: node.taskId };
  }
  if (link.taskId) {
    const n = await prisma.task.count({ where: { id: link.taskId, projectId: project.id, assignees: { some: { id: user.id } } } });
    if (n > 0) return true;
  }
  return false;
}

/**
 * Draft access (e2e O1), the ONE helper for every draft route. Whoever may write a draft may also read it:
 * - `draft`  (a draft row or a link { contentMapNodeId, taskId }): project access (ensureProjectAccess) or canWriteDraft;
 * - `list`   (drafts of one node / task): project access, or a writer of that node / task (only its drafts);
 * - `tools`  (push context, media upload; project-level): project access, or a TEAM_MEMBER / CONTRACTOR assigned to a
 *   content-map node of the project (canWriteDraft accepts them for that node's drafts).
 * ensureProjectAccess itself is unchanged (it still needs a task assignment for team members and contractors).
 * Returns { read, write }.
 */
export async function draftAccess(user, project, scope, target = {}) {
  if (!user || !DRAFT_STAFF_ROLES.includes(user.role) || !project) return { read: false, write: false };
  const projectAccess = await ensureProjectAccess(project, user);
  if (scope === 'tools') {
    if (projectAccess) return { read: true, write: true };
    if (user.role !== 'TEAM_MEMBER' && user.role !== 'CONTRACTOR') return { read: false, write: false };
    const n = await prisma.contentMapNode.count({ where: { assigneeId: user.id, map: { projectId: project.id } } });
    return { read: n > 0, write: n > 0 };
  }
  const link = { contentMapNodeId: target.contentMapNodeId || null, taskId: target.taskId || null };
  if (scope === 'list' && !projectAccess && !link.contentMapNodeId && !link.taskId) return { read: false, write: false };
  const write = await canWriteDraft(user, project, link);
  return { read: projectAccess || write, write };
}

/**
 * e2e O19: entry-get has no parent field. The parent section is the first path segment when it is one of the
 * collection's parentOptions (e.g. /spa-services/hot-tub-repair/ → spa-services); otherwise none is set.
 */
export function parentFromPath(path, parentOptions) {
  const segs = String(path || '').split('/').filter(Boolean);
  if (segs.length < 2 || !Array.isArray(parentOptions)) return null;
  return parentOptions.includes(segs[0]) && segs[0] !== 'None' ? segs[0].slice(0, 100) : null;
}

function siteParentOptions(siteInfo, collection) {
  const c = Array.isArray(siteInfo?.collections) ? siteInfo.collections.find((x) => x?.name === collection) : null;
  return Array.isArray(c?.parentOptions) ? c.parentOptions : null;
}

/** e2e O18: what the push writes, without the per-push parts (baseRev, actor, reviewAfter). */
export function contentSha(body) {
  const { baseRev: _b, actor: _a, reviewAfter: _r, ...content } = body || {};
  return sha(JSON.stringify(content));
}

/** The entry's open review in our mirror (not published, not cancelled), or null. */
export async function openReviewForEntry(projectId, cmsEntryId) {
  if (!cmsEntryId) return null;
  return prisma.wpContentReview.findFirst({
    where: { projectId, cmsEntryId: String(cmsEntryId), isPublished: false, status: { notIn: ['published', 'cancelled'] } },
    orderBy: { updatedAt: 'desc' },
    select: { wpPipelineId: true, status: true },
  });
}

/** Validate that the node / task belongs to the project. */
export async function validateLink(projectId, { contentMapNodeId = null, taskId = null }) {
  if (!contentMapNodeId && !taskId) throw bad('Link the draft to a content-map node or a task.');
  if (contentMapNodeId) {
    const n = await prisma.contentMapNode.findFirst({ where: { id: contentMapNodeId, map: { projectId } }, select: { id: true } });
    if (!n) throw bad('Content-map node not found in this project', 'NOT_FOUND', 404);
  }
  if (taskId) {
    const t = await prisma.task.findFirst({ where: { id: taskId, projectId }, select: { id: true } });
    if (!t) throw bad('Task not found in this project', 'NOT_FOUND', 404);
  }
}

// ─────────────────────────────── site-info ───────────────────────────────

const siteInfoCache = new Map();

/** Live site-info (cached 60 s per project and instance). */
export async function loadSiteInfo(projectId, { fresh = false } = {}) {
  const hit = siteInfoCache.get(projectId);
  if (!fresh && hit && Date.now() - hit.at < SITE_INFO_TTL_MS) return hit.info;
  const { conn } = await loadEmdashConnection(projectId);
  const info = await emdashRoutes.siteInfo(conn, INTERACTIVE);
  siteInfoCache.set(projectId, { at: Date.now(), info });
  if (siteInfoCache.size > 500) siteInfoCache.delete(siteInfoCache.keys().next().value);
  return info;
}
export function clearSiteInfoCache() {
  siteInfoCache.clear();
}

/** What the draft editor needs: collections, parents, block schemas, bylines (mine + team), terms, media limits. */
export function pushContextFrom(siteInfo, user, project) {
  const caps = siteInfo?.capabilities || {};
  const bylines = Array.isArray(siteInfo?.bylines) ? siteInfo.bylines : [];
  // e2e O26: the site-info here may be cached (60 s, longer until ?fresh=1), while every heartbeat stores the site's
  // current flags in Project.cmsCapabilities. The stored flag wins whenever the heartbeat reported it; the cached
  // site-info is only the fallback (e.g. right after pairing).
  const stored = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  const flag = (name) => (typeof stored[name] === 'boolean' ? stored[name] : caps[name] === true);
  return {
    capabilities: {
      draftPushFromOs: flag('draftPushFromOs'),
      mediaImport: flag('mediaImport'),
      layoutRead: flag('layoutRead'),
      seoGateOnPush: flag('seoGateOnPush'),
      // e2e O10: the editor copy says where publishing happens.
      publishFromOs: flag('publishFromOs'),
    },
    collections: (siteInfo?.collections || []).map((c) => ({
      name: c.name,
      parentOptions: Array.isArray(c.parentOptions) ? c.parentOptions : [],
      hasBylines: c.hasBylines === true,
      taxonomies: Array.isArray(c.taxonomies) ? c.taxonomies : [],
      hasSeo: c.hasSeo !== false,
    })),
    blockSchemas: siteInfo?.framework?.blockSchemas || {},
    // The OS mirrors the site's byline mapping read-only (v1.2.1 §23(2)); it never edits it.
    bylines: bylines.map((b) => ({ slug: b.slug, name: b.name, team: b.team === true, mine: !!user && b.osUserId === user.id })),
    taxonomies: siteInfo?.taxonomies || {},
    media: { ...MEDIA_LIMITS, types: MEDIA_TYPES, ...(siteInfo?.media || {}) },
  };
}

// ─────────────────────────────── body building ───────────────────────────────

export function actorFor(user, draft) {
  const name = String(user?.name || 'Agency OS user').slice(0, 160);
  // v1.2.1 §23(8): AI-written, unedited content is pushed by an agent on behalf of the triggering human.
  if (draft?.aiGenerated) return { kind: 'agent', osUserId: String(user.id), name: `Nova writer (for ${name})`.slice(0, 200), role: user.role };
  return { kind: 'human', osUserId: String(user.id), name, role: user.role };
}

/** Byline rule (decision 5): the requester's own mapped byline or the team byline; agents always the team byline. */
export function defaultBylines(ctx, actor) {
  const team = ctx.bylines.find((b) => b.team);
  if (actor.kind !== 'human') return team ? [team.slug] : [];
  const mine = ctx.bylines.find((b) => b.mine);
  return mine ? [mine.slug] : team ? [team.slug] : [];
}

/**
 * OS draft → draft-upsert body (§22.2). Create: target { collection, slug, parent? } with slugPolicy; update:
 * target { entryId } + baseRev, and slug/parent only when the user asked to change them (`changeUrl`, never-published
 * entries only; the site answers SLUG_CHANGE_FORBIDDEN otherwise).
 */
export function buildDraftUpsertBody(draft, { user, ctx, collectionInfo, slugPolicy, baseRev, changeUrl = false, reviewAfter = null }) {
  const actor = actorFor(user, draft);
  const creating = !draft.cmsEntryId;
  // contentKind portableText (v1.5.1 posts read with includeLayout) keeps its Portable Text in the `layout` column.
  const content =
    draft.contentKind === 'markdown'
      ? { body: { markdown: String(draft.markdown || '') } }
      : draft.contentKind === 'portableText'
        ? { portableText: Array.isArray(draft.layout) ? draft.layout : [] }
        : { layout: Array.isArray(draft.layout) ? draft.layout : [] };
  // Review MEDIUM-4: an update sends bylines only when a person changed them in the OS (bylinesEdited); otherwise the
  // site keeps the entry's bylines, so an unedited round trip is a no-op. A create always sends them (byline rule).
  let bylines = Array.isArray(draft.bylines) && draft.bylines.length ? draft.bylines : null;
  if (!collectionInfo?.hasBylines || (!creating && !draft.bylinesEdited)) bylines = null;
  else if (!bylines || actor.kind !== 'human') bylines = defaultBylines(ctx, actor);
  const seo = {};
  if (draft.seoTitle) seo.title = String(draft.seoTitle).slice(0, 200);
  if (draft.seoDescription) seo.description = String(draft.seoDescription).slice(0, 500);
  const taxonomies = draft.taxonomies && typeof draft.taxonomies === 'object' && Object.keys(draft.taxonomies).length ? draft.taxonomies : null;
  return {
    target: creating
      ? { collection: draft.collection, slug: draft.slug || '', ...(draft.parent && draft.parent !== 'None' ? { parent: draft.parent } : {}) }
      : { entryId: draft.cmsEntryId },
    title: String(draft.title || '').slice(0, 500),
    ...content,
    ...(draft.excerpt ? { excerpt: String(draft.excerpt).slice(0, 1000) } : {}),
    ...(Object.keys(seo).length ? { seo } : {}),
    ...(creating ? { slugPolicy } : { baseRev: baseRev || draft.cmsRev || null }),
    ...(!creating && changeUrl && draft.slug ? { slug: draft.slug } : {}),
    ...(!creating && changeUrl && draft.parent ? { parent: draft.parent === 'None' ? null : draft.parent } : {}),
    ...(bylines && bylines.length ? { bylines } : {}),
    ...(taxonomies ? { taxonomies } : {}),
    actor,
    ...(reviewAfter ? { reviewAfter } : {}),
  };
}

/** Local pre-check: the contract's prepareDraftPush + size limits. */
export function checkDraftBody(siteInfo, body, collection) {
  const r = prepareDraftPush(siteInfo, body, { collection });
  const errors = [...r.errors];
  if (Array.isArray(body.layout) && body.layout.length > DRAFT_LIMITS.maxBlocks) errors.push({ code: 'VALIDATION', path: '$.layout', message: `at most ${DRAFT_LIMITS.maxBlocks} blocks` });
  if (body.body?.markdown && body.body.markdown.length > DRAFT_LIMITS.markdownChars) errors.push({ code: 'VALIDATION', path: '$.body.markdown', message: `longer than ${DRAFT_LIMITS.markdownChars} characters` });
  // Never HTML: markdown with raw tags is refused here (the site converts markdown to Portable Text).
  if (typeof body.body?.markdown === 'string' && hasHtmlTag(body.body.markdown)) {
    errors.push({ code: 'VALIDATION', path: '$.body.markdown', message: 'HTML is not allowed; use markdown only' });
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > DRAFT_LIMITS.bodyBytes) errors.push({ code: 'PAYLOAD_TOO_LARGE', path: '$', message: 'the draft is larger than 2 MiB' });
  return { ok: errors.length === 0, errors, warnings: r.warnings };
}

// ─────────────────────────────── push ───────────────────────────────

/**
 * Which OS member a pushed draft is submitted to (reviewAfter.pm). The site accepts any OS member; this is OS policy
 * and the owner has not decided it yet, so it lives here alone: today the project's lead PM (else the client's PMs,
 * else an active OWNER — the order listPms returns).
 */
export async function reviewAfterPm(project) {
  const pms = await listPms(project);
  return pms[0] || null;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** User-facing message for a refused push. */
export function pushErrorMessage(err) {
  const d = err?.details || {};
  switch (err?.code) {
    case 'CONFLICT_REV':
      return 'Someone changed this page on the site since your last push. Review the current version, then push again on it.';
    case 'ENTRY_LOCKED':
      return `The page is being edited${d.lockedBy ? ` by ${d.lockedBy}` : ''}${d.lockedUntil ? ` until ${new Date(d.lockedUntil).toLocaleString()}` : ''}. Try again later.`;
    case 'SLUG_TAKEN':
      // v1.5.4 §30.4: the holder is always named (existingEntryId), also when it is in the site's trash.
      if (d.existingEntryTrashed === true) {
        return `That URL slug belongs to a page in the site's trash. Restore it from the trash in the site admin and edit it, or use another slug.${d.suggestedSlug ? ` Suggested: ${d.suggestedSlug}.` : ''}`;
      }
      return `That URL slug is already used by another page on the site.${d.existingEntryId ? ' Open that page instead, or use another slug.' : ''}${d.suggestedSlug ? ` Suggested: ${d.suggestedSlug}.` : ''}`;
    case 'PARENT_NOT_FOUND':
      return 'That parent section does not exist on the site.';
    case 'CONTRACT_LOCKED':
      return 'The page has a locked SEO contract; the push would change locked elements. Nothing was written.';
    case 'SLUG_CHANGE_FORBIDDEN':
      return 'The page is live: its URL can only be changed in the site admin (Change URL).';
    case 'SERVICE_TOKEN_UNAVAILABLE':
      // v1.5.4 §30.1: reason "scope" = a scope is missing (token not refused); otherwise missing or refused (401).
      if (d.reason === 'scope') {
        // e2e O24: name the scope the site reports; the full list only when it does not say.
        if (typeof d.scope === 'string' && /^[a-z0-9:_-]{1,64}$/i.test(d.scope)) {
          return `The site's service token is missing the ${d.scope} permission. Ask the site admin to add it to the token. Nothing was written.`;
        }
        return 'The site\'s service token is missing a permission. Ask the site admin to give it content:read, content:write, media:write and mcp:tools:emdash-seo. Nothing was written.';
      }
      return 'The site cannot set the exact URL right now (its service token is missing or refused). Ask the site admin, or push with best-effort URL.';
    case 'SERVICE_ROLE_INSUFFICIENT': {
      // v1.5.4 §30.1: not retryable, and best-effort fails the same way; the token stays usable for other pushes.
      const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : null);
      const role = cap(d.role) || 'too low a role';
      const need = cap(d.requiredRole) || 'Editor';
      const what = d.operation === 'create' ? 'create pages here' : 'edit pages made by someone else';
      const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
      return `The site's service user is ${d.role ? `${an(role)} ${role}` : role}; EmDash needs ${an(need)} ${need} to ${what}. Ask the site admin to raise its role (admin → Users). Nothing was written.`;
    }
    case 'BYLINE_NOT_ALLOWED':
      return 'That byline is not allowed: use your own mapped byline or the team byline.';
    case 'UNKNOWN_BLOCK':
    case 'SCHEMA_INVALID':
      return 'The site rejected some blocks. Fix the highlighted fields.';
    case 'PAYLOAD_TOO_LARGE':
      return 'The draft is too large (2 MiB). Split it or remove content.';
    case 'NOT_IMPLEMENTED':
      return 'This site does not accept drafts from Agency OS yet.';
    default:
      return err?.message || 'The push failed.';
  }
}

/**
 * v1.5.4 §30.3: CONFLICT_REV.updatedBy is the last saver (a person in the admin, or an OS push), null only when nobody
 * can be named. Names only, never site ids or e-mails; `viaOs` = the save came from an Agency OS push.
 */
export function changedBy(u) {
  if (!u || typeof u !== 'object') return null;
  const name = typeof u.name === 'string' && u.name.trim() ? u.name.trim().slice(0, 200) : null;
  const kind = ['human', 'agent', 'plugin', 'system'].includes(u.kind) ? u.kind : null;
  const viaOs = !!u.osUserId || u.source === 'os';
  if (!name && !kind) return null;
  return { name, kind, viaOs };
}

function errorRecord(err) {
  const d = err?.details && typeof err.details === 'object' ? err.details : {};
  const details = {};
  if (err.code === 'CONFLICT_REV') {
    Object.assign(details, { rev: d.rev ?? null, draftRevisionId: d.draftRevisionId ?? null, updatedAt: d.updatedAt ?? null, updatedBy: changedBy(d.updatedBy) });
    if (d.entry && typeof d.entry === 'object') details.entry = { title: d.entry.title ?? null, path: d.entry.path ?? null, updatedAt: d.entry.updatedAt ?? null, wordCount: d.entry.wordCount ?? null, rev: d.entry.rev ?? null };
  }
  if (err.code === 'ENTRY_LOCKED') Object.assign(details, { lockedUntil: d.lockedUntil ?? null, lockedBy: d.lockedBy ?? null });
  if (err.code === 'SLUG_TAKEN') {
    Object.assign(details, { suggestedSlug: d.suggestedSlug ?? null, existingEntryId: typeof d.existingEntryId === 'string' ? d.existingEntryId.slice(0, 64) : null, existingEntryTrashed: d.existingEntryTrashed === true });
  }
  if (err.code === 'SERVICE_ROLE_INSUFFICIENT') {
    Object.assign(details, { requiredRole: d.requiredRole ?? null, role: d.role ?? null, operation: d.operation ?? null, collection: d.collection ?? null, entryId: d.entryId ?? null });
  }
  if (err.code === 'SERVICE_TOKEN_UNAVAILABLE') Object.assign(details, { reason: d.reason ?? null, scope: typeof d.scope === 'string' ? d.scope.slice(0, 64) : null });
  if (err.code === 'PARENT_NOT_FOUND') Object.assign(details, { allowed: Array.isArray(d.allowed) ? d.allowed : null });
  if (err.code === 'CONTRACT_LOCKED') Object.assign(details, { contractVersion: d.contractVersion ?? null, violations: Array.isArray(d.violations) ? d.violations.slice(0, 50) : [] });
  if (Array.isArray(d.errors)) details.errors = d.errors.slice(0, 100);
  return { code: err.code, message: pushErrorMessage(err), details };
}

/**
 * Push one OS draft. `opts`: { reviewAfter?: { note? }, baseRev? (user-chosen after a conflict), changeUrl?, slugPolicy? }.
 * Returns { draft, result } or throws CmsBridgeError (local validation) / records the site's refusal on the draft.
 */
export async function pushDraft({ draftId, user, opts = {}, log }) {
  const first = await prisma.cmsDraft.findUnique({ where: { id: String(draftId) } });
  if (!first) throw bad('Draft not found', 'NOT_FOUND', 404);
  const project = await loadDraftProject(first.projectId);
  if (!(await canWriteDraft(user, project, first))) throw bad('You cannot push this draft.', 'FORBIDDEN', 403);
  if (project.cmsRepairNeededAt) throw bad('The website connection needs to be renewed (re-pair) first.', 'NOT_PAIRED', 503);

  // Review LOW-9: one push at a time per draft (two clicks / two tabs on a new draft would create two entries).
  // The claim is a compare-and-set; a claim older than PUSH_CLAIM_STALE_MS is abandoned and can be taken over.
  // e2e O18b: the CAS is on the exact status we read, so `previous` is the true status before the claim (a push that
  // finished in between changed it and this claim fails). An abandoned 'pushing' claim can be taken over when stale.
  const stale = new Date(Date.now() - PUSH_CLAIM_STALE_MS);
  const claim = await prisma.cmsDraft.updateMany({
    where:
      first.lastPushStatus === 'pushing'
        ? { id: first.id, lastPushStatus: 'pushing', updatedAt: { lt: stale } }
        : { id: first.id, lastPushStatus: first.lastPushStatus },
    data: { lastPushStatus: 'pushing' },
  });
  if (claim.count !== 1) throw bad('This draft is being pushed right now. Wait for that push to finish.', 'PUSH_IN_PROGRESS', 409);
  // A taken-over (abandoned) claim: its outcome is unknown, so never treat it as "never pushed".
  const previous = first.lastPushStatus === 'pushing' ? 'failed' : first.lastPushStatus || 'never';
  try {
    // Re-read under the claim: a push that just finished may have created the entry (then this one updates it).
    const draft = (await prisma.cmsDraft.findUnique({ where: { id: first.id } })) || first;
    return await pushClaimedDraft({ draft, project, user, opts, log, previous });
  } catch (err) {
    await prisma.cmsDraft.updateMany({ where: { id: first.id, lastPushStatus: 'pushing' }, data: { lastPushStatus: previous } }).catch(() => {});
    throw err;
  }
}

async function pushClaimedDraft({ draft, project, user, opts, log, previous = 'never' }) {
  if (draft.cmsEntryId && !(opts.baseRev || draft.cmsRev)) throw bad('The current version of the page is unknown. Reload the page data, then push again.');

  const siteInfo = await loadSiteInfo(project.id);
  const ctx = pushContextFrom(siteInfo, user, project);
  const collectionInfo = ctx.collections.find((c) => c.name === draft.collection) || null;
  const slugPolicy = opts.slugPolicy === 'best-effort' || !ctx.capabilities.draftPushFromOs ? 'best-effort' : 'exact';

  // e2e O3: a review request never costs the user their changes. With an open review on the entry (our mirror) the
  // push goes without reviewAfter; if the site still refuses the transition, the same changes are pushed once more
  // without it. Either way a REVIEW_ALREADY_OPEN warning says so.
  const extraWarnings = [];
  const reviewSkipped = (status) => ({
    code: 'REVIEW_ALREADY_OPEN',
    path: '$.reviewAfter',
    message: `This page already has an open review${status ? ` (${status})` : ''}: your changes were saved without a new review request.`,
  });
  let reviewAfter = null;
  if (opts.reviewAfter) {
    const open = draft.cmsEntryId ? await openReviewForEntry(project.id, draft.cmsEntryId) : null;
    if (open) extraWarnings.push(reviewSkipped(open.status));
    else {
      const pm = await reviewAfterPm(project);
      if (pm) reviewAfter = { pm, ...(opts.reviewAfter.note ? { note: String(opts.reviewAfter.note).slice(0, 10_000) } : {}) };
    }
  }

  const attemptOnce = async (withReview) => {
    const body = buildDraftUpsertBody(draft, { user, ctx, collectionInfo, slugPolicy, baseRev: opts.baseRev, changeUrl: !!opts.changeUrl, reviewAfter: withReview });
    const check = checkDraftBody(siteInfo, body, draft.collection);
    if (!check.ok) {
      throw bad('Fix the problems before pushing.', 'VALIDATION', 422, { errors: check.errors, warnings: check.warnings });
    }
    // One key per user action. A retry of the SAME body after an unknown outcome (timeout) reuses the key, so the
    // site replays its stored response and never creates a second entry (§7).
    const bodySha = sha(JSON.stringify(body));
    const last = await prisma.cmsDraftPush.findFirst({ where: { draftId: draft.id, route: 'draft-upsert' }, orderBy: { createdAt: 'desc' } });
    const reuse = last && last.status === 'unknown' && last.summary?.bodySha === bodySha && Date.now() - new Date(last.createdAt).getTime() < 23 * 3600_000;
    const idempotencyKey = reuse ? last.idempotencyKey : crypto.randomUUID();
    const pushRow = reuse
      ? last
      : await prisma.cmsDraftPush.create({
          data: { projectId: project.id, draftId: draft.id, route: 'draft-upsert', idempotencyKey, actorKind: body.actor.kind, actorUserId: user.id, status: 'pending', summary: { bodySha } },
        });
    try {
      const { conn } = await loadEmdashConnection(project.id);
      return { body, check, bodySha, pushRow, res: await emdashRoutes.draftUpsert(conn, body, { ...INTERACTIVE, idempotencyKey }) };
    } catch (err) {
      if (!(err instanceof CmsBridgeError)) throw err;
      return { body, check, bodySha, pushRow, err };
    }
  };

  // e2e O18: an unchanged update is not sent (the site would still write a new draft revision and a content.saved).
  // Unchanged = same content as the last successful push of this draft (contentSha: the body without baseRev, actor and
  // reviewAfter), or a draft read from the site and never edited. A review request, a URL change, an explicit baseRev
  // or a "replace the pending draft" read always go to the site.
  if (draft.cmsEntryId && !reviewAfter && !opts.changeUrl && !opts.baseRev) {
    const probe = buildDraftUpsertBody(draft, { user, ctx, collectionInfo, slugPolicy, changeUrl: false, reviewAfter: null });
    const csha = contentSha(probe);
    const replacesPending = Array.isArray(draft.lastPushWarnings) && draft.lastPushWarnings.some((w) => w?.code === 'REPLACES_PENDING_DRAFT');
    // e2e O18b: the claim already set lastPushStatus to 'pushing'; the status before the claim is `previous`.
    const readUnedited = previous === 'never' && !draft.cmsEditedAt && !replacesPending && !draft.lastPushError;
    let sameAsLast = false;
    if (!readUnedited && !draft.cmsEditedAt) {
      const lastOk = await prisma.cmsDraftPush.findFirst({ where: { draftId: draft.id, route: 'draft-upsert', status: 'ok' }, orderBy: { createdAt: 'desc' }, select: { summary: true } });
      sameAsLast = !!lastOk?.summary?.contentSha && lastOk.summary.contentSha === csha;
    }
    if (readUnedited || sameAsLast) {
      const unchangedWarning = { code: 'UNCHANGED', path: '$', message: 'Nothing changed since the page was last read or pushed: the site was not called.' };
      const updated = await prisma.cmsDraft.update({ where: { id: draft.id }, data: { lastPushStatus: previous === 'never' ? 'never' : previous } });
      log?.info?.({ projectId: project.id, draftId: draft.id }, 'EmDash draft push skipped (unchanged)');
      return { draft: updated, result: { ok: true, unchanged: true, created: false, warnings: [...extraWarnings, unchangedWarning], seoCheck: null, review: false } };
    }
  }

  let attempt = await attemptOnce(reviewAfter);
  if (attempt.err && reviewAfter && attempt.err.code === 'INVALID_TRANSITION') {
    await prisma.cmsDraftPush.update({ where: { id: attempt.pushRow.id }, data: { status: 'failed', errorCode: attempt.err.code, summary: { bodySha: attempt.bodySha } } });
    extraWarnings.push(reviewSkipped(null));
    attempt = await attemptOnce(null);
  }
  const { body, bodySha, pushRow, res } = attempt;
  const check = { ...attempt.check, warnings: [...attempt.check.warnings, ...extraWarnings] };
  if (attempt.err) {
    const err = attempt.err;
    const unknownOutcome = err.retryable === true || err.code === 'UPSTREAM_UNAVAILABLE';
    const rec = errorRecord(err);
    // v1.5.4 §30.4: "open existing page" (site admin edit link / OS page) when we mirror the holder and it is not trashed.
    if (err.code === 'SLUG_TAKEN' && rec.details.existingEntryId && !rec.details.existingEntryTrashed) {
      const holder = await prisma.wpPage.findFirst({ where: { projectId: project.id, cmsEntryId: rec.details.existingEntryId }, select: { id: true, url: true, cmsEditUrl: true } }).catch(() => null);
      if (holder) Object.assign(rec.details, { existingWpPageId: holder.id, existingEditUrl: holder.cmsEditUrl || null, existingPageUrl: holder.url || null });
    }
    const status = err.code === 'CONFLICT_REV' ? 'conflict' : err.code === 'ENTRY_LOCKED' ? 'locked' : 'failed';
    await prisma.cmsDraftPush.update({ where: { id: pushRow.id }, data: { status: unknownOutcome ? 'unknown' : 'failed', errorCode: err.code, summary: { bodySha } } });
    const updated = await prisma.cmsDraft.update({
      where: { id: draft.id },
      data: { lastPushStatus: status, lastPushAt: new Date(), lastPushError: rec, lastPushWarnings: check.warnings.length ? check.warnings : null },
    });
    log?.info?.({ projectId: project.id, draftId: draft.id, code: err.code, actor: body.actor.kind }, 'EmDash draft push refused');
    return { draft: updated, result: { ok: false, error: rec, retryable: unknownOutcome, warnings: check.warnings } };
  }

  const warnings = [...check.warnings, ...(Array.isArray(res.warnings) ? res.warnings.slice(0, 50) : [])];
  const updated = await prisma.cmsDraft.update({
    where: { id: draft.id },
    data: {
      cmsEntryId: res.entryId ? String(res.entryId).slice(0, 64) : draft.cmsEntryId,
      cmsEntryNo: Number.isInteger(res.entryNo) ? res.entryNo : draft.cmsEntryNo,
      cmsRev: res.rev ? String(res.rev).slice(0, 64) : draft.cmsRev,
      cmsEditUrl: res.editUrl ? String(res.editUrl).slice(0, 1000) : draft.cmsEditUrl,
      cmsPath: res.path ? String(res.path).slice(0, 500) : draft.cmsPath,
      ...(res.slug ? { slug: String(res.slug).slice(0, 200) } : {}),
      ...(res.parent !== undefined ? { parent: res.parent == null ? draft.parent : String(res.parent).slice(0, 100) } : {}),
      ...(Array.isArray(res.bylines) ? { bylines: res.bylines } : {}),
      bylinesEdited: false,
      cmsEditedAt: null,
      ...(res.taxonomies && typeof res.taxonomies === 'object' ? { taxonomies: res.taxonomies } : {}),
      lastPushStatus: 'ok',
      lastPushAt: new Date(),
      lastPushError: null,
      lastPushWarnings: warnings.length ? warnings : null,
      lastSeoCheck: res.seoCheck ?? null,
    },
  });
  await prisma.cmsDraftPush.update({
    where: { id: pushRow.id },
    data: { status: 'ok', errorCode: null, summary: { bodySha, contentSha: contentSha(body), created: !!res.created, entryId: res.entryId || null, rev: res.rev || null, replay: !!res.idempotentReplay, warnings: warnings.length } },
  });
  // reviewAfter: the site answers with the Review; mirror it now (the pipeline_submitted event notifies once).
  if (res.review) await mirrorEmdashReview(project.id, res.review, { log }).catch(() => {});
  if (draft.contentMapNodeId && res.path) {
    await prisma.contentMapNode
      .updateMany({ where: { id: draft.contentMapNodeId, lifecycle: 'PLANNED' }, data: { lifecycle: 'IN_PIPELINE' } })
      .catch(() => {});
  }
  // e2e O20: the node this draft was pushed from IS the entry's node. Link it now when the page row already exists;
  // otherwise the next reconcile links it by cmsEntryId (contentMapSync), never a second node.
  if (draft.contentMapNodeId && res.entryId) {
    const page = await prisma.wpPage.findFirst({ where: { projectId: project.id, cmsEntryId: String(res.entryId) }, select: { id: true } }).catch(() => null);
    if (page) await prisma.contentMapNode.updateMany({ where: { id: draft.contentMapNodeId, wpPageId: null }, data: { wpPageId: page.id } }).catch(() => {});
  }
  log?.info?.({ projectId: project.id, draftId: draft.id, created: !!res.created, actor: body.actor.kind, replay: !!res.idempotentReplay }, 'EmDash draft pushed');
  return { draft: updated, result: { ok: true, created: !!res.created, warnings, seoCheck: res.seoCheck ?? null, review: !!res.review } };
}

// ─────────────────────────────── v1.5.1: edit an existing site entry ───────────────────────────────

/**
 * Open a site entry the OS did not create (capability layoutRead): entry-get { includeLayout } → draftFromEntryGet →
 * an OS draft holding the stored content as read, with baseRev = editable.rev. Pushing it unchanged changes nothing.
 * Same people as other drafts. Re-opening an entry that already has an OS draft reloads that draft from the site.
 * `variant: "live"` writes back over a pending draft: a warning is stored for the editor.
 */
export async function createDraftFromEntry({ projectId, wpPageId, variant = 'draft', overwrite = false, keep = false, user, log }) {
  const project = await loadDraftProject(projectId);
  if (project.cmsRepairNeededAt) throw bad('The website connection needs to be renewed (re-pair) first.', 'NOT_PAIRED', 503);
  if (!hasLayoutRead(project)) throw bad('This site cannot hand its pages to Agency OS for editing yet. Edit it in the site admin.', 'NOT_IMPLEMENTED', 409);
  const page = await prisma.wpPage.findFirst({ where: { id: String(wpPageId), projectId: project.id }, select: { id: true, cmsEntryId: true } });
  if (!page?.cmsEntryId) throw bad('Page not found', 'NOT_FOUND', 404);
  const node = await prisma.contentMapNode.findFirst({ where: { wpPageId: page.id, map: { projectId: project.id } }, select: { id: true, taskId: true } });
  const link = { contentMapNodeId: node?.id || null, taskId: node?.taskId || null };
  if (!(await canWriteDraft(user, project, link))) throw bad('You cannot edit this page from Agency OS.', 'FORBIDDEN', 403);

  // Review LOW-10: reloading from the site replaces the OS draft; never drop unpushed OS edits silently.
  const prior = await prisma.cmsDraft.findFirst({ where: { projectId: project.id, cmsEntryId: page.cmsEntryId }, orderBy: { updatedAt: 'desc' }, select: { id: true, cmsEditedAt: true, updatedById: true } });
  if (prior?.cmsEditedAt && keep) return prisma.cmsDraft.findUnique({ where: { id: prior.id } });
  if (prior?.cmsEditedAt && !overwrite) {
    const editor = prior.updatedById && prior.updatedById !== user.id ? await prisma.user.findUnique({ where: { id: prior.updatedById }, select: { name: true } }).catch(() => null) : null;
    const who = prior.updatedById === user.id ? 'You have' : `${editor?.name || 'Another editor'} has`;
    throw bad(`${who} unpushed edits on this page in Agency OS. Open that draft, or reload from the site to discard them.`, 'UNPUSHED_EDITS', 409, {
      draftId: prior.id,
      editedAt: prior.cmsEditedAt,
      mine: prior.updatedById === user.id,
    });
  }

  const { conn } = await loadEmdashConnection(project.id);
  const v = variant === 'live' ? 'live' : 'draft';
  const siteInfoForParent = await loadSiteInfo(project.id).catch(() => null);
  const res = await emdashRoutes.entryGetLayout(conn, page.cmsEntryId, v, INTERACTIVE);
  const built = draftFromEntryGet(res, { actor: { kind: 'human', osUserId: String(user.id), name: String(user.name || ''), role: user.role } });
  if (!built.ok) throw bad(built.errors[0].code === 'PAYLOAD_TOO_LARGE' ? 'This page is too large to edit in Agency OS. Edit it in the site admin.' : built.errors[0].message, built.errors[0].code, 422);
  const e = res.editable;
  const entry = res.entry || {};
  const contentKind = e.format === 'layout' ? 'layout' : e.format === 'portableText' ? 'portableText' : 'markdown';
  const warnings = [];
  if (v === 'live' && entry.hasPendingDraft) {
    warnings.push({ code: 'REPLACES_PENDING_DRAFT', path: '$', message: 'This is the live version: pushing it replaces the pending draft on the site.' });
  }
  const parent = parentFromPath(entry.path, siteParentOptions(siteInfoForParent, entry.collection));
  const data = {
    collection: String(entry.collection || 'pages').slice(0, 64),
    ...(parent ? { parent } : {}),
    title: String(built.draft.title || entry.title || 'Untitled').slice(0, 500),
    slug: entry.slug ? String(entry.slug).slice(0, 200) : null,
    contentKind,
    layout: contentKind === 'markdown' ? null : contentKind === 'portableText' ? built.draft.portableText : built.draft.layout,
    markdown: contentKind === 'markdown' ? String(built.draft.body?.markdown || '') : null,
    excerpt: built.draft.excerpt ?? null,
    seoTitle: entry.seo?.title ? String(entry.seo.title).slice(0, 200) : null,
    seoDescription: entry.seo?.description ? String(entry.seo.description).slice(0, 500) : null,
    aiGenerated: false,
    cmsEntryId: page.cmsEntryId,
    cmsEntryNo: Number.isInteger(entry.entryNo) ? entry.entryNo : null,
    cmsRev: String(e.rev).slice(0, 64),
    cmsEditUrl: entry.editUrl ? String(entry.editUrl).slice(0, 1000) : null,
    cmsPath: entry.path ? String(entry.path).slice(0, 500) : null,
    lastPushWarnings: warnings.length ? warnings : null,
    // valid:false: the stored content fails the site's current schemas; draft-upsert would 422 until these are fixed.
    lastPushError: e.valid === false ? { code: 'SCHEMA_INVALID', message: 'The page on the site no longer matches the current blocks. Fix the highlighted fields before pushing.', details: { errors: (e.errors || []).slice(0, 50) } } : null,
    // e2e O19: nothing was pushed yet: the badge says "Not pushed"; the read errors are shown from lastPushError.
    lastPushStatus: 'never',
    bylinesEdited: false,
    cmsEditedAt: null,
    updatedById: user.id,
  };
  const existing = await prisma.cmsDraft.findFirst({ where: { projectId: project.id, cmsEntryId: page.cmsEntryId }, orderBy: { updatedAt: 'desc' } });
  const draft = existing
    ? await prisma.cmsDraft.update({ where: { id: existing.id }, data })
    : await prisma.cmsDraft.create({ data: { projectId: project.id, ...link, ...data, createdById: user.id } });
  log?.info?.({ projectId: project.id, draftId: draft.id, variant: v, format: e.format, valid: e.valid !== false }, 'EmDash entry opened for editing');
  return draft;
}

// ─────────────────────────────── media ───────────────────────────────

/** Read a remote image through the SSRF guard (no redirects, https only), capped at `maxBytes`. */
export async function fetchImageFromUrl(url, { maxBytes, fetchImpl = guardedFetch } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw bad('Invalid image URL');
  }
  if (u.protocol !== 'https:') throw bad('Image URLs must use https.');
  if (u.username || u.password) throw bad('Image URLs must not contain credentials.');
  const cap = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : MEDIA_LIMITS.maxBytes;
  const tooLarge = () => bad(`The image is larger than ${Math.round(cap / 1024)} KiB. Use a web-ready file (WebP or JPEG).`, 'MEDIA_TOO_LARGE');
  let res;
  try {
    // Review MEDIUM-5: the transport cap follows the site's media.maxBytes (+1 byte so an oversize file is detected).
    res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(15_000), maxBytes: cap + 1, headers: { 'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; media)' } });
  } catch (err) {
    if (err?.code === 'RESPONSE_TOO_LARGE') throw tooLarge();
    throw err;
  }
  if (res.status >= 300 && res.status < 400) throw bad('The image URL redirects; use the final URL.');
  if (!res.ok) throw bad(`The image URL answered HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cap) throw tooLarge();
  const name = decodeURIComponent(u.pathname.split('/').pop() || 'image');
  return { buffer: buf, filename: name.slice(0, 200) };
}

/**
 * Upload one web-ready image to the site (direct upload, one per call). Validates the real type and size, no
 * re-encoding; dedupes by sha256 per site (CmsMediaRef). Returns { ref: { id, src, alt }, status, sha256 }.
 * OS `/uploads` paths are never sent to the site (no staged-URL host yet: see OS_MEDIA_HOSTS in the ledger).
 */
export async function importImage({ projectId, user, buffer, filename, alt, log }) {
  const project = await loadDraftProject(projectId);
  if (!DRAFT_STAFF_ROLES.includes(user?.role)) throw bad('Clients cannot upload site media.', 'FORBIDDEN', 403);
  if (project.cmsRepairNeededAt) throw bad('The website connection needs to be renewed (re-pair) first.', 'NOT_PAIRED', 503);
  const siteInfo = await loadSiteInfo(project.id);
  const ctx = pushContextFrom(siteInfo, user, project);
  if (!ctx.capabilities.mediaImport) throw bad('This site does not accept images from Agency OS yet.', 'NOT_IMPLEMENTED', 409);
  const altText = String(alt || '').trim();
  const probe = probeImage(buffer);
  if (!probe) throw bad('This file is not a supported image.', 'MEDIA_TYPE_UNSUPPORTED');
  if (!ctx.media.types.includes(probe.contentType)) throw bad(`${probe.contentType} is not accepted by the site (${ctx.media.types.join(', ')}).`, 'MEDIA_TYPE_UNSUPPORTED');
  if (buffer.length > ctx.media.maxBytes) throw bad(`The image is larger than ${Math.round(ctx.media.maxBytes / 1024)} KiB. Use a web-ready file (WebP or JPEG, long edge ≤ 2560 px).`, 'MEDIA_TOO_LARGE');
  if ((probe.width && probe.width > ctx.media.maxDimension) || (probe.height && probe.height > ctx.media.maxDimension)) {
    throw bad(`The image is larger than ${ctx.media.maxDimension} px. Resize it before uploading.`, 'MEDIA_TOO_LARGE');
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const item = { upload: { filename: String(filename || `image.${probe.contentType.split('/')[1]}`).slice(0, 200), contentType: probe.contentType, dataBase64: buffer.toString('base64') }, alt: altText, sha256 };
  const pre = checkMediaItems(ctx.media, [item]);
  if (!pre.ok) throw bad(pre.errors.map((e) => e.message).join('; '), pre.errors[0].code);

  const known = await prisma.cmsMediaRef.findUnique({ where: { projectId_siteId_sha256: { projectId: project.id, siteId: project.cmsSiteId, sha256 } } });
  if (known) return { status: 'reused', sha256, ref: { ...known.ref, alt: altText } };

  const { conn } = await loadEmdashConnection(project.id);
  const idempotencyKey = crypto.randomUUID();
  const actor = { kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), role: user.role };
  await prisma.cmsDraftPush.create({ data: { projectId: project.id, route: 'media-import', idempotencyKey, actorKind: 'human', actorUserId: user.id, status: 'pending', summary: { sha256, bytes: buffer.length } } });
  let res;
  try {
    res = await emdashRoutes.mediaImport(conn, { items: [item], dedupe: true, actor }, { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, idempotencyKey });
  } catch (err) {
    await prisma.cmsDraftPush.update({ where: { idempotencyKey }, data: { status: 'failed', errorCode: err?.code || 'INTERNAL' } }).catch(() => {});
    throw err;
  }
  const r = Array.isArray(res?.items) ? res.items[0] : null;
  if (!r || r.status === 'failed' || !r.ref) {
    const code = r?.error?.code || 'MEDIA_INVALID';
    await prisma.cmsDraftPush.update({ where: { idempotencyKey }, data: { status: 'failed', errorCode: code } }).catch(() => {});
    throw bad(r?.error?.message || 'The site could not import the image.', code, 422);
  }
  const ref = { id: String(r.ref.id), src: String(r.ref.src), alt: String(r.ref.alt ?? altText) };
  await prisma.cmsMediaRef
    .upsert({
      where: { projectId_siteId_sha256: { projectId: project.id, siteId: project.cmsSiteId, sha256 } },
      update: { mediaId: String(r.mediaId || r.ref.id), ref },
      create: {
        projectId: project.id,
        siteId: project.cmsSiteId,
        sha256,
        mediaId: String(r.mediaId || r.ref.id),
        ref,
        contentType: r.contentType || probe.contentType,
        bytes: Number.isInteger(r.bytes) ? r.bytes : buffer.length,
        width: Number.isInteger(r.width) ? r.width : probe.width,
        height: Number.isInteger(r.height) ? r.height : probe.height,
        createdById: user.id,
      },
    })
    .catch(() => {});
  await prisma.cmsDraftPush.update({ where: { idempotencyKey }, data: { status: 'ok', summary: { sha256, status: r.status, mediaId: r.mediaId || null } } }).catch(() => {});
  log?.info?.({ projectId: project.id, status: r.status }, 'EmDash media imported');
  return { status: r.status, sha256, ref };
}

// ─────────────────────────────── AI writer ───────────────────────────────

/** AiUsageLog caps for the draft writer (per user and per client per UTC day). */
export async function aiDraftBudget(user, project) {
  const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const [mine, client] = await Promise.all([
    prisma.aiUsageLog.count({ where: { feature: AI_DRAFT_LIMITS.feature, userId: user.id, createdAt: { gte: since } } }),
    project.clientId ? prisma.aiUsageLog.count({ where: { feature: AI_DRAFT_LIMITS.feature, clientId: project.clientId, createdAt: { gte: since } } }) : 0,
  ]);
  return { ok: mine < AI_DRAFT_LIMITS.perUserPerDay && client < AI_DRAFT_LIMITS.perClientPerDay, mine, client };
}

/** Prompt for the AI writer: markdown for posts, approved blocks (JSON) for pages. Plain text only, never HTML. */
export function aiDraftPrompt(draft, { blockSchemas, instructions, node }) {
  const brief = [
    `Title: ${draft.title}`,
    node?.keywords ? `Target keywords: ${(Array.isArray(node.keywords) ? node.keywords : []).map((k) => k.keyword || k).join(', ')}` : '',
    node?.intent ? `Search intent: ${node.intent}` : '',
    node?.note ? `Planner notes: ${String(node.note).slice(0, 2000)}` : '',
    instructions ? `Instructions: ${String(instructions).slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (draft.contentKind === 'markdown') {
    return {
      json: false,
      system: 'You write web page drafts for a local service business. Output markdown only: headings, paragraphs, lists. Never HTML, never invented facts, prices, phone numbers or claims; mark unknown facts as [[REVIEW: …]].',
      user: brief,
    };
  }
  const schemas = Object.fromEntries(
    Object.entries(blockSchemas || {}).slice(0, 40).map(([k, v]) => [k, { version: v.version, fields: (v.fields || []).map((f) => ({ slug: f.slug, type: f.type, required: !!f.required, maxLength: f.maxLength, options: f.options, subFields: f.subFields?.map((s) => ({ slug: s.slug, type: s.type })) })) }])
  );
  return {
    json: true,
    system:
      'You write web page drafts for a local service business as a JSON array of approved blocks. Each block is an object with "_type" (one of the given block types) and only that type\'s fields. Plain text in string fields, never HTML. Do not invent facts, prices, phone numbers or claims; mark unknown facts as [[REVIEW: …]]. Do not use image fields. At most 12 blocks. Respond with {"layout": [...]}.',
    user: `${brief}\n\nBlock types:\n${JSON.stringify(schemas)}`,
  };
}

/** Parse the AI answer into draft content; layout blocks are checked with checkLayout (errors returned, not hidden). */
export function parseAiDraft(draft, text, blockSchemas) {
  if (draft.contentKind === 'markdown') {
    const md = String(text || '').replace(/<\/?[a-z][^>]*>/gi, '').trim();
    return { markdown: md.slice(0, DRAFT_LIMITS.markdownChars), errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { layout: null, errors: [{ code: 'VALIDATION', path: '$', message: 'The AI answer was not valid JSON. Try again.' }] };
  }
  const layout = (Array.isArray(parsed) ? parsed : parsed?.layout || []).slice(0, DRAFT_LIMITS.maxBlocks).map((b) => ({ ...b, ...(blockSchemas?.[b?._type]?.version !== undefined ? { _version: blockSchemas[b._type].version } : {}) }));
  return { layout, errors: checkLayout(layout, blockSchemas || {}).errors };
}
