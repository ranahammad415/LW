/**
 * EmDash v1.5.0 §26.1 (D11): leads from EmDash sites.
 * - `lead.created` → CmsLead (PII, access-controlled) + a PII-free SiteLeadEvent / SiteLeadDailyMetric bump so the
 *   lead dashboards stay comparable with WordPress (form_submit). Receipts keep only ids (as for every event).
 * - Photos come as 7-day signed URLs: copied into private storage (CMS_LEADS_DIR, never under the public /uploads),
 *   the URL is dropped once copied or expired. Bounded: ≤ 5 photos, ≤ 10 MiB each, images only.
 * - `lead.erased` / OS `lead-erase` → PII and photo files deleted; the row stays as a tombstone (ids only) so a
 *   replayed `lead.created` never resurrects the lead.
 * - Retention: leads older than Project.cmsLeadRetentionMonths (default 24) are erased by the leader-only hourly job.
 * Nothing here logs lead data.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { prisma } from './prisma.js';
import { probeImage } from './imageProbe.js';
import { guardedFetch } from './siteAdapters/netGuard.js';
import { leadToRow, leadAnalyticsMeta, leadPhotoUrlAllowed, LEAD_PHOTO_MAX_BYTES, LEAD_ERASE_REASONS } from './siteAdapters/leads.js';
import { CmsBridgeError, emdashRoutes, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';
import { loadEmdashConnection } from './cmsStore.js';

export function leadsDir() {
  return process.env.CMS_LEADS_DIR ? path.resolve(process.env.CMS_LEADS_DIR) : path.resolve(process.cwd(), 'private-uploads', 'cms-leads');
}

/** Errors leaving this module never carry lead data (Prisma messages can echo values). */
function scrub(err) {
  const e = new Error('Lead store failed');
  e.code = err?.code || 'INTERNAL';
  return e;
}

function utcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function bumpLeadMetrics(projectId, row) {
  const occurredAt = row.siteCreatedAt || new Date();
  const ruleId = `emdash:${row.formId || 'form'}`.slice(0, 80);
  await prisma.siteLeadEvent.create({
    data: { projectId, eventType: 'form_submit', ruleId, ruleLabel: row.formName, pagePath: row.sourcePath, occurredAt, meta: leadAnalyticsMeta(row) },
  });
  const day = utcDay(occurredAt);
  const existing = await prisma.siteLeadDailyMetric.findUnique({ where: { projectId_date: { projectId, date: day } } });
  const b = existing?.breakdowns && typeof existing.breakdowns === 'object' ? existing.breakdowns : {};
  const rules = Array.isArray(b.rules) ? [...b.rules] : [];
  const paths = Array.isArray(b.paths) ? [...b.paths] : [];
  const r = rules.find((x) => x.eventType === 'form_submit' && (x.ruleId || x.ruleLabel) === ruleId);
  if (r) r.count += 1;
  else rules.push({ ruleId, ruleLabel: row.formName || null, eventType: 'form_submit', count: 1 });
  if (row.sourcePath) {
    const p = paths.find((x) => x.path === row.sourcePath);
    if (p) p.count += 1;
    else paths.push({ path: row.sourcePath, count: 1 });
  }
  if (existing) {
    await prisma.siteLeadDailyMetric.update({
      where: { id: existing.id },
      data: { formSubmits: { increment: 1 }, leads: { increment: 1 }, breakdowns: { rules, paths } },
    });
  } else {
    await prisma.siteLeadDailyMetric.create({ data: { projectId, date: day, formSubmits: 1, leads: 1, breakdowns: { rules, paths } } });
  }
}

/** Apply a lead event. Returns 'applied' | 'stale' (tombstoned / already known). */
export async function applyLeadEvent(project, ev) {
  try {
    if (ev.type === 'lead.created') {
      const { row, photos } = leadToRow(ev.lead, project.cmsSiteId, { siteUrl: project.wpUrl });
      const existing = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId: project.id, leadId: row.leadId } }, select: { id: true } });
      if (existing) return 'stale'; // known or erased (tombstone): never resurrect
      const created = await prisma.cmsLead.create({ data: { projectId: project.id, ...row } });
      for (const p of photos) await prisma.cmsLeadPhoto.create({ data: { leadRowId: created.id, ...p } });
      await bumpLeadMetrics(project.id, row).catch(() => {});
      if (photos.some((p) => p.sourceUrl)) copyLeadPhotos(created.id).catch(() => {});
      return 'applied';
    }
    if (ev.type === 'lead.erased') {
      const done = await eraseLocalLead(project.id, ev.leadId, 'site');
      return done ? 'applied' : 'stale';
    }
    return 'stored';
  } catch (err) {
    throw scrub(err);
  }
}

/** A copy claim (stored in `error`) older than this is abandoned (the process died mid-copy) and can be taken over. */
export const LEAD_PHOTO_CLAIM_STALE_MS = 5 * 60_000;
const CLAIM_PREFIX = 'COPYING@';
/** Errors after which the link is dropped: retrying cannot succeed (review MEDIUM-LOW-6). */
const PERMANENT_PHOTO_ERRORS = new Set(['NOT_IMAGE', 'TOO_LARGE', 'HTTP_404', 'HTTP_410', 'REDIRECT', 'URL_NOT_ALLOWED']);

/** The photo link rule lives in siteAdapters/leads.js (one rule for storing and copying; e2e O16). */
export { leadPhotoUrlAllowed };

function claimIsLive(error, now) {
  if (typeof error !== 'string' || !error.startsWith(CLAIM_PREFIX)) return false;
  const at = Number(error.slice(CLAIM_PREFIX.length));
  return Number.isFinite(at) && now.getTime() - at < LEAD_PHOTO_CLAIM_STALE_MS;
}

/**
 * Copy pending photos of one lead (or of all leads with `leadRowId` null), within the 7-day window, oldest first.
 * Each row is claimed with a compare-and-set before the fetch (two instances never copy the same photo), and the
 * result is written only while the row is still uncopied: when the lead was erased meanwhile (row gone), the file just
 * written is deleted again, so an erase during a copy never leaves PII on disk.
 */
export async function copyLeadPhotos(leadRowId = null, { fetchImpl = guardedFetch, now = new Date(), limit = 25, env = process.env } = {}) {
  const rows = await prisma.cmsLeadPhoto.findMany({
    where: { ...(leadRowId ? { leadRowId } : {}), copiedAt: null, sourceUrl: { not: null } },
    include: { lead: { select: { erasedAt: true, project: { select: { wpUrl: true } } } } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let copied = 0;
  for (const ph of rows) {
    if (claimIsLive(ph.error, now) || ph.lead?.erasedAt) continue;
    if (ph.sourceExpiresAt && ph.sourceExpiresAt <= now) {
      await prisma.cmsLeadPhoto.updateMany({ where: { id: ph.id, copiedAt: null }, data: { sourceUrl: null, error: 'EXPIRED' } });
      continue;
    }
    const claimValue = `${CLAIM_PREFIX}${now.getTime()}`;
    const claim = await prisma.cmsLeadPhoto.updateMany({ where: { id: ph.id, copiedAt: null, error: ph.error ?? null }, data: { error: claimValue } });
    if (claim.count !== 1) continue;
    let file = null;
    try {
      if (!leadPhotoUrlAllowed(ph.sourceUrl, ph.lead?.project?.wpUrl, env)) throw Object.assign(new Error('url'), { code: 'URL_NOT_ALLOWED' });
      let res;
      try {
        // Review MEDIUM-5: the transport cap is the photo limit (+1 byte so an oversize photo is detected).
        res = await fetchImpl(ph.sourceUrl, { signal: AbortSignal.timeout(20_000), maxBytes: LEAD_PHOTO_MAX_BYTES + 1, headers: { 'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; leads)' } });
      } catch (err) {
        if (err?.code === 'RESPONSE_TOO_LARGE') throw Object.assign(new Error('size'), { code: 'TOO_LARGE' });
        throw Object.assign(new Error('fetch'), { code: 'FETCH_FAILED' });
      }
      if (!res.ok) throw Object.assign(new Error('fetch'), { code: res.status >= 300 && res.status < 400 ? 'REDIRECT' : `HTTP_${res.status}` });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > LEAD_PHOTO_MAX_BYTES) throw Object.assign(new Error('size'), { code: 'TOO_LARGE' });
      const probe = probeImage(buf);
      if (!probe) throw Object.assign(new Error('type'), { code: 'NOT_IMAGE' });
      const name = `${crypto.randomBytes(16).toString('hex')}.${probe.contentType.split('/')[1]}`;
      await fsp.mkdir(leadsDir(), { recursive: true });
      file = path.join(leadsDir(), name);
      await fsp.writeFile(file, buf, { mode: 0o600 });
      const done = await prisma.cmsLeadPhoto.updateMany({
        where: { id: ph.id, copiedAt: null, error: claimValue },
        data: { storageName: name, contentType: probe.contentType, bytes: buf.length, copiedAt: new Date(), sourceUrl: null, error: null },
      });
      if (done.count !== 1) {
        // Erased (row deleted) or taken over meanwhile: never keep an unreferenced copy.
        await fsp.unlink(file).catch(() => {});
        continue;
      }
      copied += 1;
    } catch (err) {
      const code = String(err?.code || 'FAILED').slice(0, 64);
      await prisma.cmsLeadPhoto
        .updateMany({ where: { id: ph.id, copiedAt: null, error: claimValue }, data: { error: code, ...(PERMANENT_PHOTO_ERRORS.has(code) ? { sourceUrl: null } : {}) } })
        .catch(() => {});
    }
  }
  return copied;
}

/**
 * Delete photo files no CmsLeadPhoto row references (e.g. rows removed with their project by the database cascade,
 * or a crash between write and record). Only files older than an hour (a copy in progress is never touched); bounded.
 */
export async function sweepOrphanLeadPhotos({ now = new Date(), limit = 500 } = {}) {
  let names;
  try {
    names = (await fsp.readdir(leadsDir())).filter((n) => /^[0-9a-f]{32}\.[a-z0-9]+$/.test(n));
  } catch {
    return 0;
  }
  const old = [];
  for (const n of names) {
    if (old.length >= limit) break;
    const st = await fsp.stat(path.join(leadsDir(), n)).catch(() => null);
    if (st && now.getTime() - st.mtimeMs > 3600_000) old.push(n);
  }
  if (!old.length) return 0;
  const kept = new Set((await prisma.cmsLeadPhoto.findMany({ where: { storageName: { in: old } }, select: { storageName: true } })).map((r) => r.storageName));
  let removed = 0;
  for (const n of old) {
    if (kept.has(n)) continue;
    await fsp.unlink(path.join(leadsDir(), n)).then(() => (removed += 1)).catch(() => {});
  }
  return removed;
}

async function deletePhotoFiles(photos) {
  for (const p of photos) {
    if (!p.storageName || !/^[0-9a-f]{32}\.[a-z0-9]+$/.test(p.storageName)) continue;
    await fsp.unlink(path.join(leadsDir(), p.storageName)).catch(() => {});
  }
}

/** Delete our copy: PII cleared, photos deleted; the row stays as an id-only tombstone. */
export async function eraseLocalLead(projectId, leadId, reason) {
  const lead = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId, leadId: String(leadId).slice(0, 64) } }, include: { photos: true } });
  if (!lead) {
    // Unknown lead: record a tombstone so a late lead.created cannot create it.
    await prisma.cmsLead.create({ data: { projectId, leadId: String(leadId).slice(0, 64), erasedAt: new Date(), erasedReason: reason } }).catch(() => {});
    return true;
  }
  if (lead.erasedAt) return false;
  await deletePhotoFiles(lead.photos);
  await prisma.cmsLeadPhoto.deleteMany({ where: { leadRowId: lead.id } });
  await prisma.cmsLead.update({
    where: { id: lead.id },
    data: { fields: null, consent: null, utm: null, formName: null, sourcePath: null, erasedAt: new Date(), erasedReason: reason },
  });
  return true;
}

/** OS → site lead-erase (OWNER), then our own erasure path. */
export async function eraseLead({ projectId, leadId, reason, user, log }) {
  if (!LEAD_ERASE_REASONS.includes(reason)) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Choose a reason.' });
  const { conn } = await loadEmdashConnection(projectId);
  const res = await emdashRoutes.leadErase(
    conn,
    { leadId: String(leadId), reason, actor: { kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), role: user.role } },
    { retryDelays: INTERACTIVE_RETRY_DELAYS_MS }
  );
  await eraseLocalLead(projectId, leadId, reason);
  log?.info?.({ projectId, reason }, 'EmDash lead erased');
  return { erased: !!res?.erased, alreadyGone: !!res?.alreadyGone };
}

/** Leader-only: erase leads past the project's retention and copy pending photos. Bounded per run. */
export async function leadHousekeeping({ now = new Date(), log } = {}) {
  let erased = 0;
  const projects = await prisma.project.findMany({ where: { cmsType: 'EMDASH' }, select: { id: true, cmsLeadRetentionMonths: true }, take: 500 });
  for (const p of projects) {
    const months = Number.isInteger(p.cmsLeadRetentionMonths) && p.cmsLeadRetentionMonths > 0 ? p.cmsLeadRetentionMonths : 24;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const old = await prisma.cmsLead.findMany({ where: { projectId: p.id, erasedAt: null, receivedAt: { lt: cutoff } }, select: { leadId: true }, take: 200 });
    for (const l of old) if (await eraseLocalLead(p.id, l.leadId, 'retention')) erased += 1;
  }
  const copied = await copyLeadPhotos(null, { now }).catch(() => 0);
  const orphansRemoved = await sweepOrphanLeadPhotos({ now }).catch(() => 0);
  if (erased || copied || orphansRemoved) log?.info?.({ erased, copied, orphansRemoved }, 'EmDash lead housekeeping');
  return { erased, copied, orphansRemoved };
}

/** Absolute path of a copied photo (validated name) for the authenticated download route. */
export function photoPath(storageName) {
  if (!/^[0-9a-f]{32}\.[a-z0-9]+$/.test(String(storageName || ''))) return null;
  return path.join(leadsDir(), storageName);
}
