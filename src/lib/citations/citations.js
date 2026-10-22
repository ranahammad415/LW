/**
 * EmDash contract 1.8.0 §39 on the OS side: the site's citation list (business listings with their NAP status),
 * mirrored in SeoCitationMirror / SeoCitationState, and the OS writes through `seo-citations-upsert`.
 * docs/ledger/emdash-bridge.md §v1.8.0, docs/ledger/features/local-seo.md §Citations.
 *
 * - The site owns the list. Mirror sources: `seo-citations-list` (pairing / first sync, the daily 03:00 EmDash pull, a
 *   rev gap, a 409 CONFLICT_REV body) and `seo.citation_changed` events (applied in rev order: several events can share
 *   one rev; a skipped rev → pull and replace). Our own upserts come back as events too (source "os").
 * - OS writes: only SEO_CITATION_OS_FIELDS (listed, nap_status, *_seen, checks, last_checked); name / url / kind only
 *   when creating a listing. The site ignores site-owned fields with FIELD_OWNED_BY_SITE (shown to staff).
 * - Who: a person OWNER / PM (actor kind human; agents and API tokens are refused with 403 HUMAN_ONLY by the routes
 *   before any site call), or the scheduled monitor as kind "system" (SYSTEM_ACTOR).
 * - 409 CONFLICT_REV {currentRev, items}: the mirror is replaced with details.items; a system write retries once with
 *   the new baseRev; a human write is answered 409 so the person reviews the fresh list and redoes the edit.
 * - Client views never carry vendor names, costs, ids or the agency note (allow-lists below).
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { CmsBridgeError, emdashRoutes, osActor } from '../siteAdapters/emdash.js';
import { safeText } from '../siteAdapters/security.js';
import {
  SEO_CITATION_KINDS,
  SEO_NAP_STATUSES,
  SEO_CITATION_OS_FIELDS,
  SEO_CITATION_LIMITS,
  CITATION_ID_RE,
  isObj,
  dateOrNull,
  httpsUrl,
  sanitizeChecks,
  sanitizeCitationList,
  sanitizeCitationChanged,
} from './validate.js';

export * from './validate.js';
import { normalizePhone, normalizeZip, zipFromAddress } from './nap.js';

const NO_RETRY = Object.freeze({ retryDelays: [] });
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,80}$/;

export const hasSeoCitations = (project) => project?.cmsType === 'EMDASH' && project?.cmsCapabilities?.seoCitations === true;
export const hasSeoAiPrompts = (project) => project?.cmsType === 'EMDASH' && project?.cmsCapabilities?.seoAiPrompts === true;

export function actionKey(raw) {
  return typeof raw === 'string' && IDEMPOTENCY_RE.test(raw) ? raw : crypto.randomUUID();
}

// ── storage ──

/** Contract citation → SeoCitationMirror data (rev = the list rev it belongs to). */
export function citationToRow(c, rev) {
  return {
    name: c.name,
    url: c.url,
    kind: c.kind,
    listed: c.listed,
    napStatus: c.nap_status,
    nameSeen: c.name_seen,
    phoneSeen: c.phone_seen,
    zipSeen: c.zip_seen,
    hoursSeen: c.hours_seen,
    checks: c.checks ?? Prisma.DbNull,
    lastChecked: c.last_checked ? new Date(c.last_checked) : null,
    checkedBy: c.checked_by,
    note: c.note,
    utm: c.utm,
    rank: c.rank,
    siteUpdatedAt: c.updated_at ? new Date(c.updated_at) : null,
    rev,
  };
}

export async function loadCitationState(projectId) {
  return prisma.seoCitationState.findUnique({ where: { projectId } });
}

async function upsertRow(projectId, c, rev) {
  const data = citationToRow(c, rev);
  await prisma.seoCitationMirror.upsert({
    where: { projectId_siteCitationId: { projectId, siteCitationId: c.id } },
    create: { projectId, siteCitationId: c.id, ...data },
    update: data,
  });
}

/** Replace the mirror with a full list (rows the site no longer has are deleted) and record its rev. */
export async function replaceMirror(projectId, { rev, items }, { now = new Date() } = {}) {
  for (const c of items) await upsertRow(projectId, c, rev);
  await prisma.seoCitationMirror.deleteMany({ where: { projectId, siteCitationId: { notIn: items.map((c) => c.id) } } });
  await prisma.seoCitationState.upsert({
    where: { projectId },
    create: { projectId, rev, stale: false, fetchedAt: now },
    update: { rev, stale: false, fetchedAt: now },
  });
  return { rev, count: items.length };
}

/** seo-citations-list → replace the mirror. No retries (background callers decide). */
export async function pullCitations(projectId, { conn = null, opts = NO_RETRY } = {}) {
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  const res = await emdashRoutes.seoCitationsList(c, opts);
  const list = sanitizeCitationList(res);
  if (!list) throw new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'The site returned an unreadable citation list.' });
  return replaceMirror(projectId, list);
}

/** Pull only when the site has the capability (daily EmDash pull, pairing). Errors are swallowed by the caller. */
export async function pullCitationsIfCapable(projectId) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsType: true, cmsCapabilities: true } });
  if (!hasSeoCitations(p)) return { skipped: 'NO_CAPABILITY' };
  return pullCitations(projectId);
}

let pullTimers = new Map();
export function scheduleCitationsPull(projectId, log, delayMs = 2000) {
  if (pullTimers.has(projectId)) return;
  const t = setTimeout(() => {
    pullTimers.delete(projectId);
    pullCitations(projectId).catch((err) => log?.warn?.({ projectId, code: err?.code }, 'seo-citations-list after a rev gap failed'));
  }, delayMs);
  t.unref?.();
  pullTimers.set(projectId, t);
}
export function _resetCitationPullTimers() {
  for (const t of pullTimers.values()) clearTimeout(t);
  pullTimers = new Map();
}

/**
 * seo.citation_changed → mirror (§39.4). rev < ours: stale. rev = ours (another listing of the same request, or our
 * own write already applied): the listing is written. rev = ours + 1: written and the list rev advances. rev > ours + 1
 * (an edit we have not seen) or no state yet: the listing is written, the state is marked stale and the list is pulled
 * and replaced. A listing row is never rolled back to an older rev.
 */
export async function applyCitationChanged(project, ev, { log, schedulePull = scheduleCitationsPull } = {}) {
  const { data, error } = sanitizeCitationChanged(ev.data);
  if (error) throw Object.assign(new Error(error), { code: 'VALIDATION' });
  const state = await loadCitationState(project.id);
  const ours = Number.isInteger(state?.rev) ? state.rev : null;
  if (ours != null && data.rev < ours) return 'stale';
  const row = await prisma.seoCitationMirror.findUnique({
    where: { projectId_siteCitationId: { projectId: project.id, siteCitationId: data.citation.id } },
    select: { rev: true },
  });
  if (!row || row.rev <= data.rev) await upsertRow(project.id, data.citation, data.rev);
  if (ours == null || data.rev > ours + 1) {
    await prisma.seoCitationState.upsert({ where: { projectId: project.id }, create: { projectId: project.id, stale: true }, update: { stale: true } });
    schedulePull(project.id, log);
    return 'applied';
  }
  if (data.rev === ours + 1) {
    const upd = await prisma.seoCitationState.updateMany({ where: { projectId: project.id, rev: ours }, data: { rev: data.rev } });
    if (!upd?.count) schedulePull(project.id, log);
  }
  return 'applied';
}

// ── writes (seo-citations-upsert) ──

function bad(message) {
  return new CmsBridgeError({ status: 400, code: 'VALIDATION', message });
}

/**
 * One upsert item from staff input or the monitor. Only OS fields are kept; name / url / kind only with `create`.
 * Throws VALIDATION on a bad value.
 */
export function buildUpsertItem(input, { create = false } = {}) {
  if (!isObj(input)) throw bad('Invalid listing');
  const item = {};
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !CITATION_ID_RE.test(input.id)) throw bad('Invalid listing id');
    item.id = input.id;
  }
  if (input.listed !== undefined) {
    if (typeof input.listed !== 'boolean') throw bad('listed must be true or false');
    item.listed = input.listed;
  }
  if (input.nap_status !== undefined) {
    if (!SEO_NAP_STATUSES.includes(input.nap_status)) throw bad('Invalid NAP status');
    item.nap_status = input.nap_status;
  }
  for (const k of ['name_seen', 'phone_seen', 'zip_seen', 'hours_seen']) {
    if (input[k] === undefined) continue;
    if (input[k] !== null && typeof input[k] !== 'string') throw bad(`${k} must be text`);
    item[k] = input[k] == null || input[k] === '' ? null : String(input[k]).slice(0, SEO_CITATION_LIMITS.seen);
  }
  if (input.checks !== undefined) item.checks = input.checks === null ? null : sanitizeChecks(input.checks);
  if (input.last_checked !== undefined) {
    const d = dateOrNull(input.last_checked);
    if (!d) throw bad('last_checked must be a date-time');
    item.last_checked = d;
  }
  if (create) {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, SEO_CITATION_LIMITS.name) : '';
    if (!name) throw bad('A new listing needs a name');
    item.name = name;
    if (input.url != null && input.url !== '') {
      const url = httpsUrl(input.url);
      if (!url) throw bad('Invalid listing URL');
      item.url = url;
    }
    if (input.kind !== undefined) {
      if (!SEO_CITATION_KINDS.includes(input.kind)) throw bad('Invalid listing kind');
      item.kind = input.kind;
    }
  } else if (!item.id) {
    throw bad('Listing id is required');
  }
  const osKeys = Object.keys(item).filter((k) => SEO_CITATION_OS_FIELDS.includes(k));
  if (!osKeys.length && !create) throw bad('Nothing to save');
  return item;
}

function sanitizeUpsertResponse(res) {
  const applied = (Array.isArray(res?.applied) ? res.applied : []).slice(0, SEO_CITATION_LIMITS.upsertItems).map((a) => ({
    id: typeof a?.id === 'string' ? a.id.slice(0, 100) : null,
    created: a?.created === true,
    fields: (Array.isArray(a?.fields) ? a.fields : []).filter((f) => typeof f === 'string').map((f) => f.slice(0, 32)).slice(0, 20),
  }));
  const rejected = (Array.isArray(res?.rejected) ? res.rejected : []).slice(0, SEO_CITATION_LIMITS.upsertItems).map((r) => ({
    id: typeof r?.id === 'string' ? r.id.slice(0, 100) : null,
    reason: ['invalid', 'duplicate', 'too_many'].includes(r?.reason) ? r.reason : 'invalid',
    message: safeText(r?.message, 300),
  }));
  const warnings = (Array.isArray(res?.warnings) ? res.warnings : []).slice(0, 20).map((w) => ({
    code: typeof w?.code === 'string' ? w.code.slice(0, 40) : 'WARNING',
    message: safeText(w?.message, 300),
  }));
  return { rev: Number.isInteger(res?.rev) ? res.rev : null, applied, rejected, warnings };
}

/** Patch mirror rows with what we sent, for the listings the site applied (rev = baseRev + 1 only). */
async function applyOwnWrite(projectId, items, out, baseRev) {
  if (out.rev == null) return;
  if (out.rev === baseRev) return; // nothing changed on the site
  if (out.rev !== baseRev + 1) return scheduleCitationsPull(projectId);
  const sent = new Map(items.filter((i) => i.id).map((i) => [i.id, i]));
  const now = new Date();
  let createdUnknown = false;
  for (const a of out.applied) {
    if (!a.id || !a.fields.length) continue;
    const it = sent.get(a.id);
    if (!it) {
      createdUnknown = true; // created from url / name: the site chose the id
      continue;
    }
    const data = { rev: out.rev, checkedBy: 'os', lastOsCheckAt: now };
    if (it.listed !== undefined) data.listed = it.listed;
    if (it.nap_status !== undefined) data.napStatus = it.nap_status;
    if (it.name_seen !== undefined) data.nameSeen = it.name_seen;
    if (it.phone_seen !== undefined) data.phoneSeen = it.phone_seen;
    if (it.zip_seen !== undefined) data.zipSeen = it.zip_seen;
    if (it.hours_seen !== undefined) data.hoursSeen = it.hours_seen;
    if (it.checks !== undefined) data.checks = it.checks ?? Prisma.DbNull;
    if (it.last_checked !== undefined) data.lastChecked = new Date(it.last_checked);
    if (a.created) {
      await prisma.seoCitationMirror.upsert({
        where: { projectId_siteCitationId: { projectId, siteCitationId: a.id } },
        create: { projectId, siteCitationId: a.id, name: String(it.name || a.id).slice(0, 120), url: it.url || null, kind: it.kind || 'directory', ...data },
        update: data,
      });
    } else {
      await prisma.seoCitationMirror.updateMany({ where: { projectId, siteCitationId: a.id }, data });
    }
  }
  await prisma.seoCitationState.updateMany({ where: { projectId, rev: baseRev }, data: { rev: out.rev } });
  if (createdUnknown) scheduleCitationsPull(projectId);
}

/**
 * seo-citations-upsert with compare-and-set. `actor` = osActor(user) for a person, SYSTEM_ACTOR for the monitor.
 * System writes: on 409 the mirror is replaced and the call is retried ONCE with the new rev (same items, new
 * idempotency key). Human writes: on 409 the mirror is replaced and the error is rethrown (details: currentRev).
 * → { rev, applied, rejected, warnings, replayed, retried }
 */
export async function upsertCitations(projectId, items, actor, { idempotencyKey, conn = null, system = actor?.kind === 'system' } = {}) {
  if (!Array.isArray(items) || items.length < 1) throw bad('Nothing to save');
  if (items.length > SEO_CITATION_LIMITS.upsertItems) throw bad(`At most ${SEO_CITATION_LIMITS.upsertItems} listings per write`);
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  let state = await loadCitationState(projectId);
  if (!Number.isInteger(state?.rev)) {
    await pullCitations(projectId, { conn: c });
    state = await loadCitationState(projectId);
  }
  let baseRev = state?.rev ?? 0;
  let key = actionKey(idempotencyKey);
  let retried = false;
  for (;;) {
    try {
      const res = await emdashRoutes.seoCitationsUpsert(c, { baseRev, items, actor }, { ...NO_RETRY, idempotencyKey: key });
      const out = sanitizeUpsertResponse(res);
      await applyOwnWrite(projectId, items, out, baseRev);
      return { ...out, replayed: res?.idempotentReplay === true, retried };
    } catch (err) {
      if (!(err instanceof CmsBridgeError) || err.code !== 'CONFLICT_REV') throw err;
      const list = sanitizeCitationList({ rev: err.details?.currentRev, items: err.details?.items });
      if (list) await replaceMirror(projectId, list);
      const currentRev = list?.rev ?? (Number.isInteger(err.details?.currentRev) ? err.details.currentRev : null);
      if (system && !retried && currentRev != null) {
        retried = true;
        baseRev = currentRev;
        key = crypto.randomUUID();
        continue;
      }
      err.details = { currentRev };
      throw err;
    }
  }
}

/** A person's edit / new listing from the staff UI (one item; human actor; 409 goes back to the UI). */
export async function staffUpsertCitation(projectId, user, body, { idempotencyKey } = {}) {
  const create = body?.create === true;
  const item = buildUpsertItem(body?.item, { create });
  if (!create && !item.last_checked && Object.keys(item).some((k) => k !== 'id')) item.last_checked = new Date().toISOString();
  const state = await loadCitationState(projectId);
  if (Number.isInteger(body?.baseRev) && Number.isInteger(state?.rev) && body.baseRev !== state.rev) {
    throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: 'The listings changed since you opened them. Review the current list and redo the edit.', details: { currentRev: state.rev } });
  }
  return upsertCitations(projectId, [item], osActor(user), { idempotencyKey, system: false });
}

// ── canonical NAP ──

const CANON_FIELDS = Object.freeze(['name', 'phone', 'address', 'zip', 'city', 'hours', 'website']);
const CANON_MAX = Object.freeze({ name: 200, phone: 50, address: 500, zip: 20, city: 120, hours: 200, website: 500 });

/** Staff override input → stored object (every key present, null = not set). Throws VALIDATION. */
export function sanitizeCanonicalNap(input) {
  if (!isObj(input)) throw bad('Invalid business details');
  const out = {};
  for (const k of CANON_FIELDS) {
    const v = input[k];
    if (v == null || v === '') {
      out[k] = null;
      continue;
    }
    if (typeof v !== 'string') throw bad(`${k} must be text`);
    out[k] = v.trim().slice(0, CANON_MAX[k]) || null;
  }
  if (!out.name) throw bad('The business name is required');
  if (out.phone && !normalizePhone(out.phone)) throw bad('Enter the phone with its area code (or +country code)');
  if (out.zip && !normalizeZip(out.zip)) throw bad('Invalid ZIP / postal code');
  if (out.website) {
    try {
      const u = new URL(out.website);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('x');
    } catch {
      throw bad('Invalid website URL');
    }
  }
  return out;
}

/**
 * Canonical NAP of a project: the staff override when set (source "override"), else the Business Profile identity
 * stored by Local SEO (gmbLocationName / project name, gmbPhone, gmbAddress → ZIP, gmbWebsite; source "gbp"). The
 * contract 1.8.0 site-info carries no business facts (checked against site-info.response--seo-citations), so the site's
 * Business info is not read; the PM confirms the record here (§39.2).
 */
export function canonicalNapFor(project, state) {
  const o = isObj(state?.canonicalNap) ? state.canonicalNap : null;
  if (o?.name) {
    return { ...Object.fromEntries(CANON_FIELDS.map((k) => [k, o[k] ?? null])), zip: o.zip || zipFromAddress(o.address), source: 'override', confirmedAt: state.canonicalNapAt || null };
  }
  const name = project?.gmbLocationName || project?.name || null;
  if (!project?.gmbPhone && !project?.gmbAddress) {
    return { name, phone: null, address: null, zip: null, city: null, hours: null, website: project?.gmbWebsite || null, source: name ? 'project' : 'none', confirmedAt: null };
  }
  return {
    name,
    phone: project.gmbPhone || null,
    address: project.gmbAddress || null,
    zip: zipFromAddress(project.gmbAddress),
    city: null,
    hours: null,
    website: project.gmbWebsite || null,
    source: 'gbp',
    confirmedAt: null,
  };
}

export async function setCanonicalNap(projectId, input, user) {
  const nap = input === null ? null : sanitizeCanonicalNap(input);
  const data = nap
    ? { canonicalNap: nap, canonicalNapById: String(user?.id || '').slice(0, 191) || null, canonicalNapAt: new Date() }
    : { canonicalNap: Prisma.DbNull, canonicalNapById: null, canonicalNapAt: null };
  await prisma.seoCitationState.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
  return nap;
}

// ── summaries and views ──

/**
 * Counts over the mirror. consistencyPct = correct / (correct + wrong) × 100 (rounded) of the listings whose NAP was
 * compared; null when none. `missing` (not listed) and `unknown` (not checked) are reported, not scored.
 */
export function summarizeCitations(rows) {
  const out = { total: 0, correct: 0, wrong: 0, missing: 0, unknown: 0, consistencyPct: null };
  for (const r of rows || []) {
    out.total += 1;
    const s = r.napStatus ?? r.nap_status;
    if (s === 'correct' || s === 'wrong' || s === 'missing') out[s] += 1;
    else out.unknown += 1;
  }
  const checked = out.correct + out.wrong;
  out.consistencyPct = checked ? Math.round((out.correct / checked) * 100) : null;
  return out;
}

/** Health v2 R5 input and the client tile counts. → { total, correct, wrong, missing, unknown, consistencyPct } */
export async function citationSummary(projectId) {
  const rows = await prisma.seoCitationMirror.findMany({ where: { projectId }, select: { napStatus: true } });
  return summarizeCitations(rows);
}

function rowView(r) {
  return {
    id: r.siteCitationId,
    name: r.name,
    url: r.url,
    kind: r.kind,
    listed: r.listed,
    napStatus: r.napStatus,
    nameSeen: r.nameSeen,
    phoneSeen: r.phoneSeen,
    zipSeen: r.zipSeen,
    hoursSeen: r.hoursSeen,
    checks: r.checks ?? null,
    lastChecked: r.lastChecked,
    checkedBy: r.checkedBy,
    checkedByLabel: r.checkedBy === 'os' ? 'Checked by Agency OS' : 'Checked by a person',
    note: r.note,
    utm: r.utm,
    rank: r.rank,
    rev: r.rev,
    lastOsCheckAt: r.lastOsCheckAt,
  };
}

/** Staff Local SEO → Business listings section. */
export async function staffCitationsView(project, { monitorEnabled = false } = {}) {
  const [state, rows, lastRun] = await Promise.all([
    loadCitationState(project.id),
    prisma.seoCitationMirror.findMany({ where: { projectId: project.id }, orderBy: [{ rank: 'asc' }, { name: 'asc' }] }),
    prisma.seoCitationCheckRun.findFirst({ where: { projectId: project.id }, orderBy: { startedAt: 'desc' } }),
  ]);
  return {
    capability: hasSeoCitations(project),
    rev: state?.rev ?? null,
    stale: state?.stale === true,
    fetchedAt: state?.fetchedAt ?? null,
    canonical: canonicalNapFor(project, state),
    summary: summarizeCitations(rows),
    items: rows.map(rowView),
    monitorEnabled,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          trigger: lastRun.trigger,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          checked: lastRun.checked,
          written: lastRun.written,
          dfsCalls: lastRun.dfsCalls,
          pageFetches: lastRun.pageFetches,
          costUsd: lastRun.costUsd != null ? Number(lastRun.costUsd) : null,
          warnings: Array.isArray(lastRun.warnings) ? lastRun.warnings : [],
          errorCode: lastRun.errorCode,
        }
      : null,
  };
}

const PROBLEM_TEXT = Object.freeze({
  phone: 'an old or different phone number',
  name: 'a different business name',
  zip: 'a different ZIP code',
  hours: 'different opening hours',
});

/** Plain-language items for one listing (client tile). Pure. */
export function listingSentences(r) {
  const name = r.name;
  const status = r.napStatus;
  if (status === 'missing') return [`You are not listed on ${name} yet`];
  if (status !== 'wrong') return [];
  const checks = isObj(r.checks) ? r.checks : {};
  const bad = ['phone', 'name', 'zip', 'hours'].filter((k) => checks[k] === false);
  if (!bad.length) return [`${name} shows details that do not match your business`];
  return bad.map((k) => `${name} shows ${PROBLEM_TEXT[k]}`);
}

/**
 * Client "Business listings" tile: allow-list only. "X of Y correct" (Y = listings whose details were compared) plus
 * plain sentences. No vendor, cost, ids, URLs, notes, check sources or who checked.
 */
export async function clientListingsView(project) {
  const rows = await prisma.seoCitationMirror.findMany({
    where: { projectId: project.id },
    select: { name: true, napStatus: true, checks: true, lastChecked: true, rank: true },
    orderBy: [{ rank: 'asc' }, { name: 'asc' }],
  });
  if (!rows.length) return { available: false };
  const s = summarizeCitations(rows);
  const items = [];
  for (const r of rows) for (const text of listingSentences(r)) items.push({ text, kind: r.napStatus === 'missing' ? 'missing' : 'wrong' });
  const last = rows.map((r) => r.lastChecked).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  return {
    available: true,
    correct: s.correct,
    checked: s.correct + s.wrong,
    total: s.total,
    missing: s.missing,
    label: s.correct + s.wrong ? `${s.correct} of ${s.correct + s.wrong} listings show your correct details` : 'Your listings have not been checked yet',
    items: items.slice(0, 8),
    updatedAt: last ? new Date(last).toISOString().slice(0, 10) : null,
  };
}

