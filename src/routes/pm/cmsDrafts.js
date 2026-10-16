/**
 * EmDash v1.2 draft push + media import (contract §22, §23). Staff only (OWNER, lead PM, assigned TEAM_MEMBER /
 * CONTRACTOR); clients never reach these routes. See lib/cmsDrafts.js for the rules.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { generateChat, isAiConfigured } from '../../lib/ai.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import {
  DRAFT_STAFF_ROLES,
  AI_DRAFT_LIMITS,
  loadDraftProject,
  canWriteDraft,
  validateLink,
  loadSiteInfo,
  pushContextFrom,
  buildDraftUpsertBody,
  checkDraftBody,
  pushDraft,
  importImage,
  fetchImageFromUrl,
  aiDraftBudget,
  aiDraftPrompt,
  parseAiDraft,
  pushErrorMessage,
  createDraftFromEntry,
} from '../../lib/cmsDrafts.js';

async function requireStaff(request, reply) {
  if (!DRAFT_STAFF_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'Staff access required' });
  }
}

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    const auth = ['BAD_SIGNATURE', 'UNKNOWN_KEY', 'UNKNOWN_SITE', 'STALE_TIMESTAMP', 'REPLAY'].includes(err.code);
    let status = err.status || 502;
    if (auth || status === 401 || (status >= 500 && status !== 503)) status = 502;
    return reply.status(status).send({
      code: err.code,
      message: auth ? `The EmDash site rejected Agency OS's signature (${err.code}). Re-pair the site if this persists.` : err.message || pushErrorMessage(err),
      ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}),
    });
  }
  if (err?.name === 'CmsKeyConfigError') return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: err.message });
  log?.error?.({ err }, 'CMS draft route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

const EDITABLE = ['collection', 'title', 'slug', 'parent', 'contentKind', 'layout', 'markdown', 'excerpt', 'seoTitle', 'seoDescription', 'bylines', 'taxonomies'];
const CONTENT_FIELDS = new Set(['title', 'layout', 'markdown', 'excerpt', 'seoTitle', 'seoDescription']);

function sanitizeEdit(body) {
  const data = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    const v = body[k];
    switch (k) {
      case 'collection':
        data.collection = String(v || '').slice(0, 64);
        break;
      case 'title':
        data.title = String(v || '').slice(0, 500);
        break;
      case 'slug':
        data.slug = v ? String(v).toLowerCase().slice(0, 200) : null;
        break;
      case 'parent':
        data.parent = v ? String(v).slice(0, 100) : null;
        break;
      case 'contentKind':
        data.contentKind = v === 'markdown' ? 'markdown' : v === 'portableText' ? 'portableText' : 'layout';
        break;
      case 'layout':
        // Blocks (≤ 24) or, for contentKind portableText, the Portable Text array (not block-capped).
        data.layout = Array.isArray(v) ? (body.contentKind === 'portableText' ? v.slice(0, 5000) : v.slice(0, 24)) : null;
        break;
      case 'markdown':
        data.markdown = v == null ? null : String(v).slice(0, 200_000);
        break;
      case 'excerpt':
        data.excerpt = v == null ? null : String(v).slice(0, 1000);
        break;
      case 'seoTitle':
        data.seoTitle = v ? String(v).slice(0, 200) : null;
        break;
      case 'seoDescription':
        data.seoDescription = v ? String(v).slice(0, 500) : null;
        break;
      case 'bylines':
        data.bylines = Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 10) : null;
        break;
      case 'taxonomies':
        data.taxonomies = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
        break;
      default:
        break;
    }
  }
  return data;
}

function formatDraft(d, { canWrite = false } = {}) {
  return {
    id: d.id,
    projectId: d.projectId,
    contentMapNodeId: d.contentMapNodeId,
    taskId: d.taskId,
    collection: d.collection,
    title: d.title,
    slug: d.slug,
    parent: d.parent,
    contentKind: d.contentKind,
    layout: d.layout || [],
    markdown: d.markdown || '',
    excerpt: d.excerpt || '',
    seoTitle: d.seoTitle || '',
    seoDescription: d.seoDescription || '',
    bylines: d.bylines || [],
    taxonomies: d.taxonomies || {},
    aiGenerated: !!d.aiGenerated,
    cmsEntryId: d.cmsEntryId,
    cmsEditUrl: d.cmsEditUrl,
    cmsPath: d.cmsPath,
    hasRev: !!d.cmsRev,
    lastPushStatus: d.lastPushStatus,
    lastPushAt: d.lastPushAt,
    lastPushError: d.lastPushError,
    lastPushWarnings: d.lastPushWarnings || [],
    lastSeoCheck: d.lastSeoCheck,
    canWrite,
    updatedAt: d.updatedAt,
  };
}

async function loadDraftFor(request, reply, draftId) {
  const draft = await prisma.cmsDraft.findUnique({ where: { id: String(draftId) } });
  if (!draft) {
    reply.status(404).send({ message: 'Draft not found' });
    return null;
  }
  const project = await loadDraftProject(draft.projectId);
  if (!(await ensureProjectAccess(project, request.user))) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  return { draft, project, canWrite: await canWriteDraft(request.user, project, draft) };
}

export async function pmCmsDraftRoutes(app) {
  const staff = { onRequest: [app.verifyJwt, requireStaff] };

  // Editor context: collections, parents, block schemas, bylines (mine/team), terms, media limits (live site-info).
  app.get('/projects/:projectId/cms-push-context', staff, async (request, reply) => {
    try {
      const project = await loadDraftProject(request.params.projectId);
      if (!(await ensureProjectAccess(project, request.user))) return reply.status(403).send({ message: 'Access denied' });
      const info = await loadSiteInfo(project.id, { fresh: request.query?.fresh === '1' });
      return reply.send(pushContextFrom(info, request.user, project));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/projects/:projectId/cms-drafts', staff, async (request, reply) => {
    try {
      const project = await loadDraftProject(request.params.projectId);
      if (!(await ensureProjectAccess(project, request.user))) return reply.status(403).send({ message: 'Access denied' });
      const { nodeId, taskId } = request.query || {};
      const rows = await prisma.cmsDraft.findMany({
        where: { projectId: project.id, ...(nodeId ? { contentMapNodeId: String(nodeId) } : {}), ...(taskId ? { taskId: String(taskId) } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      });
      const out = [];
      for (const d of rows) out.push(formatDraft(d, { canWrite: await canWriteDraft(request.user, project, d) }));
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post('/projects/:projectId/cms-drafts', staff, async (request, reply) => {
    try {
      const project = await loadDraftProject(request.params.projectId);
      const b = request.body || {};
      const link = { contentMapNodeId: b.contentMapNodeId ? String(b.contentMapNodeId) : null, taskId: b.taskId ? String(b.taskId) : null };
      await validateLink(project.id, link);
      if (!(await canWriteDraft(request.user, project, link))) return reply.status(403).send({ message: 'You cannot create a site draft here.' });
      const data = sanitizeEdit(b);
      if (!data.collection || !data.title) return reply.status(400).send({ message: 'Collection and title are required.' });
      if (!data.contentKind) data.contentKind = data.collection === 'posts' ? 'markdown' : 'layout';
      const d = await prisma.cmsDraft.create({
        data: { projectId: project.id, ...link, ...data, createdById: request.user.id, updatedById: request.user.id },
      });
      return reply.status(201).send(formatDraft(d, { canWrite: true }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // v1.5.1: open an existing site page for editing (layoutRead); returns the OS draft.
  app.post('/projects/:projectId/cms-drafts/from-entry', staff, async (request, reply) => {
    try {
      const d = await createDraftFromEntry({
        projectId: request.params.projectId,
        wpPageId: request.body?.wpPageId,
        variant: request.body?.variant === 'live' ? 'live' : 'draft',
        user: request.user,
        log: request.log,
      });
      return reply.send(formatDraft(d, { canWrite: true }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/cms-drafts/:id', staff, async (request, reply) => {
    try {
      const ctx = await loadDraftFor(request, reply, request.params.id);
      if (!ctx) return;
      return reply.send(formatDraft(ctx.draft, { canWrite: ctx.canWrite }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.patch('/cms-drafts/:id', staff, async (request, reply) => {
    try {
      const ctx = await loadDraftFor(request, reply, request.params.id);
      if (!ctx) return;
      if (!ctx.canWrite) return reply.status(403).send({ message: 'You cannot edit this draft.' });
      const data = sanitizeEdit(request.body || {});
      // A person editing the content makes it human-written again (actor kind "human" on the next push).
      if (Object.keys(data).some((k) => CONTENT_FIELDS.has(k))) data.aiGenerated = false;
      if (ctx.draft.cmsEntryId && data.collection && data.collection !== ctx.draft.collection) {
        return reply.status(400).send({ message: 'The collection cannot change after the first push.' });
      }
      const d = await prisma.cmsDraft.update({ where: { id: ctx.draft.id }, data: { ...data, updatedById: request.user.id } });
      return reply.send(formatDraft(d, { canWrite: true }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Deletes the OS draft only; the site entry (if any) stays and is handled in the site admin.
  app.delete('/cms-drafts/:id', staff, async (request, reply) => {
    try {
      const ctx = await loadDraftFor(request, reply, request.params.id);
      if (!ctx) return;
      if (!ctx.canWrite) return reply.status(403).send({ message: 'You cannot delete this draft.' });
      await prisma.cmsDraft.delete({ where: { id: ctx.draft.id } });
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Pre-check only (no write): the contract's prepareDraftPush + size rules against the live site-info.
  app.post('/cms-drafts/:id/check', staff, async (request, reply) => {
    try {
      const ctx = await loadDraftFor(request, reply, request.params.id);
      if (!ctx) return;
      const info = await loadSiteInfo(ctx.project.id);
      const pctx = pushContextFrom(info, request.user, ctx.project);
      const collectionInfo = pctx.collections.find((c) => c.name === ctx.draft.collection) || null;
      const body = buildDraftUpsertBody(ctx.draft, {
        user: request.user,
        ctx: pctx,
        collectionInfo,
        slugPolicy: pctx.capabilities.draftPushFromOs ? 'exact' : 'best-effort',
        changeUrl: !!request.body?.changeUrl,
      });
      return reply.send(checkDraftBody(info, body, ctx.draft.collection));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Push: one user action = one idempotency key. Never auto-retried on CONFLICT_REV / ENTRY_LOCKED.
  app.post('/cms-drafts/:id/push', staff, async (request, reply) => {
    try {
      const b = request.body || {};
      const out = await pushDraft({
        draftId: request.params.id,
        user: request.user,
        opts: {
          reviewAfter: b.reviewAfter ? { note: b.reviewAfter.note || null } : null,
          baseRev: b.baseRev ? String(b.baseRev).slice(0, 64) : undefined,
          changeUrl: !!b.changeUrl,
          slugPolicy: b.slugPolicy === 'best-effort' ? 'best-effort' : undefined,
        },
        log: request.log,
      });
      return reply.status(out.result.ok ? 200 : 409).send({ draft: formatDraft(out.draft, { canWrite: true }), result: out.result });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Media: direct upload (multipart file + alt) or a URL the OS fetches through the SSRF guard, then uploads.
  app.post('/projects/:projectId/cms-media', staff, async (request, reply) => {
    try {
      const project = await loadDraftProject(request.params.projectId);
      if (!(await ensureProjectAccess(project, request.user))) return reply.status(403).send({ message: 'Access denied' });
      let buffer;
      let filename;
      let alt;
      if (request.isMultipart?.()) {
        const file = await request.file();
        if (!file) return reply.status(400).send({ message: 'No file uploaded' });
        buffer = await file.toBuffer();
        filename = file.filename;
        alt = file.fields?.alt?.value;
      } else {
        const b = request.body || {};
        alt = b.alt;
        const info = await loadSiteInfo(project.id);
        const media = pushContextFrom(info, request.user, project).media;
        ({ buffer, filename } = await fetchImageFromUrl(b.url, { maxBytes: media.maxBytes }));
      }
      if (!String(alt || '').trim()) return reply.status(400).send({ message: 'Alt text is required.' });
      if (String(alt).trim().length > 300) return reply.status(400).send({ message: 'Alt text must be at most 300 characters.' });
      const out = await importImage({ projectId: project.id, user: request.user, buffer, filename, alt, log: request.log });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // AI writer: one generation per click, capped per user and client per day (AiUsageLog), never scheduled.
  app.post('/cms-drafts/:id/ai-write', staff, async (request, reply) => {
    try {
      const ctx = await loadDraftFor(request, reply, request.params.id);
      if (!ctx) return;
      if (!ctx.canWrite) return reply.status(403).send({ message: 'You cannot edit this draft.' });
      if (!isAiConfigured()) return reply.status(503).send({ message: 'AI is not configured.' });
      const budget = await aiDraftBudget(request.user, ctx.project);
      if (!budget.ok) return reply.status(429).send({ code: 'AI_LIMIT', message: 'The daily AI draft limit is reached. Try again tomorrow.' });
      const info = ctx.draft.contentKind === 'layout' ? await loadSiteInfo(ctx.project.id) : null;
      const blockSchemas = info?.framework?.blockSchemas || {};
      const node = ctx.draft.contentMapNodeId
        ? await prisma.contentMapNode.findUnique({ where: { id: ctx.draft.contentMapNodeId }, select: { keywords: true, intent: true, note: true } })
        : null;
      const prompt = aiDraftPrompt(ctx.draft, { blockSchemas, instructions: request.body?.instructions, node });
      const { text } = await generateChat({
        system: prompt.system,
        user: prompt.user,
        json: prompt.json,
        maxTokens: AI_DRAFT_LIMITS.maxTokens,
        feature: AI_DRAFT_LIMITS.feature,
        userId: request.user.id,
        clientId: ctx.project.clientId || null,
      });
      const parsed = parseAiDraft(ctx.draft, text, blockSchemas);
      if (ctx.draft.contentKind === 'layout' && !parsed.layout) return reply.status(502).send({ message: parsed.errors[0].message });
      const d = await prisma.cmsDraft.update({
        where: { id: ctx.draft.id },
        data: {
          ...(ctx.draft.contentKind === 'markdown' ? { markdown: parsed.markdown } : { layout: parsed.layout }),
          aiGenerated: true,
          updatedById: request.user.id,
        },
      });
      return reply.send({ draft: formatDraft(d, { canWrite: true }), errors: parsed.errors });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
