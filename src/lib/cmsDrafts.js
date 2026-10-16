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
  hasDraftPushFromOs,
  hasMediaImport,
  INTERACTIVE_RETRY_DELAYS_MS,
} from './siteAdapters/emdash.js';
import { prepareDraftPush, checkMediaItems, checkLayout, MEDIA_LIMITS, MEDIA_TYPES, DRAFT_LIMITS } from './siteAdapters/push.js';
import { probeImage } from './imageProbe.js';
import { guardedFetch } from './siteAdapters/netGuard.js';

export const DRAFT_STAFF_ROLES = Object.freeze(['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR']);
const INTERACTIVE = { retryDelays: INTERACTIVE_RETRY_DELAYS_MS, timeoutMs: 20_000 };
const SITE_INFO_TTL_MS = 60_000;
/** AI writer caps (AiUsageLog rules): per user and per client per day; one generation per click; never in crons. */
export const AI_DRAFT_LIMITS = Object.freeze({ perUserPerDay: 10, perClientPerDay: 30, maxTokens: 4000, feature: 'cms_draft_writer' });

const bad = (message, code = 'VALIDATION', status = 400, details) => new CmsBridgeError({ status, code, message, retryable: false, details });

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
  return {
    capabilities: {
      draftPushFromOs: caps.draftPushFromOs === true || hasDraftPushFromOs(project),
      mediaImport: caps.mediaImport === true || hasMediaImport(project),
      seoGateOnPush: caps.seoGateOnPush === true,
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
  const content = draft.contentKind === 'markdown' ? { body: { markdown: String(draft.markdown || '') } } : { layout: Array.isArray(draft.layout) ? draft.layout : [] };
  let bylines = Array.isArray(draft.bylines) && draft.bylines.length ? draft.bylines : null;
  if (collectionInfo?.hasBylines) {
    if (!bylines || actor.kind !== 'human') bylines = defaultBylines(ctx, actor);
  } else bylines = null;
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
  if (typeof body.body?.markdown === 'string' && /<\/?[a-z][\s\S]*?>/i.test(body.body.markdown)) {
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
      return `That URL slug is already used on the site.${d.suggestedSlug ? ` Suggested: ${d.suggestedSlug}.` : ''}`;
    case 'PARENT_NOT_FOUND':
      return 'That parent section does not exist on the site.';
    case 'CONTRACT_LOCKED':
      return 'The page has a locked SEO contract; the push would change locked elements. Nothing was written.';
    case 'SLUG_CHANGE_FORBIDDEN':
      return 'The page is live: its URL can only be changed in the site admin (Change URL).';
    case 'SERVICE_TOKEN_UNAVAILABLE':
      return 'The site cannot set the exact URL right now (its service token is missing). Ask the site admin, or push with best-effort URL.';
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

function errorRecord(err) {
  const d = err?.details && typeof err.details === 'object' ? err.details : {};
  const details = {};
  if (err.code === 'CONFLICT_REV') {
    Object.assign(details, { rev: d.rev ?? null, draftRevisionId: d.draftRevisionId ?? null, updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null });
    if (d.entry && typeof d.entry === 'object') details.entry = { title: d.entry.title ?? null, path: d.entry.path ?? null, updatedAt: d.entry.updatedAt ?? null, wordCount: d.entry.wordCount ?? null, rev: d.entry.rev ?? null };
  }
  if (err.code === 'ENTRY_LOCKED') Object.assign(details, { lockedUntil: d.lockedUntil ?? null, lockedBy: d.lockedBy ?? null });
  if (err.code === 'SLUG_TAKEN') Object.assign(details, { suggestedSlug: d.suggestedSlug ?? null });
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
  const draft = await prisma.cmsDraft.findUnique({ where: { id: String(draftId) } });
  if (!draft) throw bad('Draft not found', 'NOT_FOUND', 404);
  const project = await loadDraftProject(draft.projectId);
  if (!(await canWriteDraft(user, project, draft))) throw bad('You cannot push this draft.', 'FORBIDDEN', 403);
  if (project.cmsRepairNeededAt) throw bad('The website connection needs to be renewed (re-pair) first.', 'NOT_PAIRED', 503);
  if (draft.cmsEntryId && !(opts.baseRev || draft.cmsRev)) throw bad('The current version of the page is unknown. Reload the page data, then push again.');

  const siteInfo = await loadSiteInfo(project.id);
  const ctx = pushContextFrom(siteInfo, user, project);
  const collectionInfo = ctx.collections.find((c) => c.name === draft.collection) || null;
  const slugPolicy = opts.slugPolicy === 'best-effort' || !ctx.capabilities.draftPushFromOs ? 'best-effort' : 'exact';

  let reviewAfter = null;
  if (opts.reviewAfter) {
    const pm = await reviewAfterPm(project);
    if (pm) reviewAfter = { pm, ...(opts.reviewAfter.note ? { note: String(opts.reviewAfter.note).slice(0, 10_000) } : {}) };
  }
  const body = buildDraftUpsertBody(draft, { user, ctx, collectionInfo, slugPolicy, baseRev: opts.baseRev, changeUrl: !!opts.changeUrl, reviewAfter });
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

  const { conn } = await loadEmdashConnection(project.id);
  let res;
  try {
    res = await emdashRoutes.draftUpsert(conn, body, { ...INTERACTIVE, idempotencyKey });
  } catch (err) {
    if (!(err instanceof CmsBridgeError)) throw err;
    const unknownOutcome = err.retryable === true || err.code === 'UPSTREAM_UNAVAILABLE';
    const rec = errorRecord(err);
    const status = err.code === 'CONFLICT_REV' ? 'conflict' : err.code === 'ENTRY_LOCKED' ? 'locked' : 'failed';
    await prisma.cmsDraftPush.update({ where: { id: pushRow.id }, data: { status: unknownOutcome ? 'unknown' : 'failed', errorCode: err.code, summary: { bodySha } } });
    const updated = await prisma.cmsDraft.update({
      where: { id: draft.id },
      data: { lastPushStatus: status, lastPushAt: new Date(), lastPushError: rec, lastPushWarnings: check.warnings.length ? check.warnings : null },
    });
    log?.info?.({ projectId: project.id, draftId: draft.id, code: err.code, actor: body.actor.kind }, 'EmDash draft push refused');
    return { draft: updated, result: { ok: false, error: rec, retryable: unknownOutcome } };
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
    data: { status: 'ok', errorCode: null, summary: { bodySha, created: !!res.created, entryId: res.entryId || null, rev: res.rev || null, replay: !!res.idempotentReplay, warnings: warnings.length } },
  });
  // reviewAfter: the site answers with the Review; mirror it now (the pipeline_submitted event notifies once).
  if (res.review) await mirrorEmdashReview(project.id, res.review, { log }).catch(() => {});
  if (draft.contentMapNodeId && res.path) {
    await prisma.contentMapNode
      .updateMany({ where: { id: draft.contentMapNodeId, lifecycle: 'PLANNED' }, data: { lifecycle: 'IN_PIPELINE' } })
      .catch(() => {});
  }
  log?.info?.({ projectId: project.id, draftId: draft.id, created: !!res.created, actor: body.actor.kind, replay: !!res.idempotentReplay }, 'EmDash draft pushed');
  return { draft: updated, result: { ok: true, created: !!res.created, warnings, seoCheck: res.seoCheck ?? null, review: !!res.review } };
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
  const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; media)' } });
  if (res.status >= 300 && res.status < 400) throw bad('The image URL redirects; use the final URL.');
  if (!res.ok) throw bad(`The image URL answered HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw bad(`The image is larger than ${Math.round(maxBytes / 1024)} KiB. Use a web-ready file (WebP or JPEG).`, 'MEDIA_TOO_LARGE');
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
