/**
 * EmDash v1.5.0 §26.1 (D11): leads from EmDash sites.
 * - `lead.created` → CmsLead (PII, access-controlled) + a PII-free SiteLeadEvent / SiteLeadDailyMetric bump so the
 *   lead dashboards stay comparable with WordPress (form_submit). Receipts keep only ids (as for every event).
 * - Photos come as 7-day signed URLs: copied into private storage (CMS_LEADS_DIR, never under the public /uploads),
 *   the URL is dropped once copied or expired. Bounded: ≤ 5 photos, ≤ 10 MiB each, images only.
 * - `lead.erased` / OS `lead-erase` → PII and photo files deleted; the row stays as a tombstone (ids only) so a
 *   replayed `lead.created` never resurrects the lead. An OS erase while the site is disconnected / unreachable still
 *   erases our copy and marks the tombstone "site erase pending" (retried by the leader-only housekeeping, bounded).
 * - Retention: leads older than Project.cmsLeadRetentionMonths (default 24) are erased by the leader-only hourly job.
 * Nothing here logs lead data.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { prisma } from './prisma.js';
import { probeImage } from './imageProbe.js';
import { guardedFetch } from './siteAdapters/netGuard.js';
import { leadToRow, leadPhotoUrlAllowed, LEAD_PHOTO_MAX_BYTES, LEAD_ERASE_REASONS } from './siteAdapters/leads.js';
import { CmsBridgeError, emdashRoutes, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';
import { loadEmdashConnection } from './cmsStore.js';
import { upsertSiteAttribution, applyLeadAttributed, heardFromOf } from './signals/attribution.js';
import { leadErasureOps, prepareLeadErasure, afterLeadErasure } from './signals/erase.js';
import { afterNewLead } from './leadSideEffects.js';

export function leadsDir() {
  return process.env.CMS_LEADS_DIR ? path.resolve(process.env.CMS_LEADS_DIR) : path.resolve(process.cwd(), 'private-uploads', 'cms-leads');
}

/** Errors leaving this module never carry lead data (Prisma messages can echo values). */
function scrub(err) {
  const e = new Error('Lead store failed');
  e.code = err?.code || 'INTERNAL';
  return e;
}

/**
 * v1.9.0: is this site lead id the mirror of an OS provider lead (lead-import)? A mirror is never a second lead: the
 * site never sends lead.created for it (contract §40.2), and if one arrived anyway it is ignored (no double count in
 * the lead metrics / Health v2 L1). `origin` / `externalRef` on the event mark a mirror as well.
 */
async function mirrorOwner(projectId, siteLeadId) {
  if (!siteLeadId) return null;
  return prisma.cmsLead.findFirst({ where: { projectId, cmsMirrorLeadId: String(siteLeadId).slice(0, 64) }, select: { id: true, leadId: true, erasedAt: true } });
}

/** Apply a lead event. Returns 'applied' | 'stale' (tombstoned / already known). */
export async function applyLeadEvent(project, ev, { log } = {}) {
  try {
    if (ev.type === 'lead.created') {
      const { row, photos } = leadToRow(ev.lead, project.cmsSiteId, { siteUrl: project.wpUrl });
      const existing = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId: project.id, leadId: row.leadId } }, select: { id: true } });
      if (existing) return 'stale'; // known or erased (tombstone): never resurrect
      if ((ev.lead.origin && ev.lead.origin !== 'website') || ev.lead.externalRef || (await mirrorOwner(project.id, row.leadId))) return 'stale';
      const created = await prisma.cmsLead.create({ data: { projectId: project.id, provider: 'emdash', ...row } });
      for (const p of photos) await prisma.cmsLeadPhoto.create({ data: { leadRowId: created.id, ...p } });
      // v1.7.0 §38.5: the site's attribution snapshot (+ the "How did you hear about us?" answer). No PII.
      if (ev.lead.attribution || heardFromOf(row)) {
        await upsertSiteAttribution({ ...created, projectId: project.id, leadId: row.leadId }, { attribution: ev.lead.attribution, heardFrom: heardFromOf(row) });
      }
      // Metrics, staff notification, realtime: the same for every provider (lib/leadSideEffects.js).
      await afterNewLead(project.id, { ...row, provider: 'emdash', receivedAt: created.receivedAt }, { log });
      if (photos.some((p) => p.sourceUrl)) copyLeadPhotos(created.id, { busyRetries: LEAD_PHOTO_BUSY_RETRIES }).catch(() => {});
      return 'applied';
    }
    if (ev.type === 'lead.attributed') {
      // Retryable (LEAD_NOT_STORED) when the CmsLead is not stored yet: the site's outbox parks and re-sends it.
      // v1.9.0: with data.externalRef the lead is the site's mirror of our provider lead (joined on osLeadId).
      return await applyLeadAttributed(project, ev);
    }
    if (ev.type === 'lead.erased') {
      // v1.9.0 §40.2: the site deleted the MIRROR of a provider lead (its lead policy, or our lead-erase): our row
      // stays (the OS owns that lead); only the link to the mirror is cleared.
      const mirrored = await prisma.cmsLead.findMany({ where: { projectId: project.id, cmsMirrorLeadId: String(ev.leadId).slice(0, 64) }, select: { id: true, erasedAt: true, erasedReason: true } });
      if (mirrored.length) {
        const live = mirrored.filter((m) => !m.erasedAt).map((m) => m.id);
        if (live.length) await prisma.cmsLead.updateMany({ where: { id: { in: live } }, data: { cmsMirrorLeadId: null } });
        // Our erase of the mirror was still owed (site unreachable): the site deleted it itself, nothing is owed now.
        for (const m of mirrored.filter((x) => x.erasedAt && parseErasedReason(x.erasedReason).siteErase)) {
          await prisma.cmsLead.update({ where: { id: m.id }, data: { erasedReason: parseErasedReason(m.erasedReason).reason, utm: null } });
        }
        return live.length ? 'applied' : 'stale';
      }
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
/**
 * v1.5.4 §30.7: right after a site restart the photo route answers 503 + Retry-After (≈60 s) for a few minutes. That is
 * retryable: the link is kept (the 7-day expiry rule still applies) and a per-lead copy tries again after Retry-After,
 * at most LEAD_PHOTO_BUSY_RETRIES times (≈10 min); later the hourly housekeeping picks it up.
 */
export const LEAD_PHOTO_BUSY_RETRIES = 5;
const BUSY_DELAY_MAX_SEC = 180;
export function busyRetryDelayMs(retryAfter) {
  const n = Number(retryAfter);
  const sec = Number.isFinite(n) && n > 0 ? n : 60;
  return Math.min(sec, BUSY_DELAY_MAX_SEC) * 1000;
}

export async function copyLeadPhotos(leadRowId = null, { fetchImpl = guardedFetch, now = new Date(), limit = 25, env = process.env, busyRetries = 0, schedule = (fn, ms) => setTimeout(fn, ms).unref?.() } = {}) {
  let busyDelay = null;
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
      if (res.status === 503) {
        busyDelay = Math.max(busyDelay || 0, busyRetryDelayMs(res.headers?.get?.('retry-after')));
        throw Object.assign(new Error('busy'), { code: 'SITE_BUSY' });
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
  if (busyDelay && leadRowId && busyRetries > 0) {
    schedule(() => copyLeadPhotos(leadRowId, { fetchImpl, limit, env, busyRetries: busyRetries - 1, schedule }).catch(() => {}), busyDelay);
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

/**
 * Site-side erase still owed (the site was disconnected or unreachable when the OWNER erased). No schema change: the
 * tombstone's `erasedReason` carries the state as a prefix (`site_pending:<reason>`, after the last attempt
 * `site_failed:<reason>`; ≤ 32 chars) and its (otherwise cleared) `utm` column the retry bookkeeping
 * `{ siteErase: { attempts, nextAt, lastError, actor } }` (actor = the OWNER who erased; never lead data).
 */
export const SITE_ERASE_PENDING = 'site_pending:';
export const SITE_ERASE_FAILED = 'site_failed:';
export const SITE_ERASE_MAX_ATTEMPTS = 10;
const SITE_ERASE_BASE_DELAY_MS = 15 * 60_000;
const SITE_ERASE_MAX_DELAY_MS = 24 * 3600_000;

/** `{ reason, siteErase: 'pending' | 'failed' | null }` of a stored erasedReason. */
export function parseErasedReason(raw) {
  const s = String(raw || '');
  if (s.startsWith(SITE_ERASE_PENDING)) return { reason: s.slice(SITE_ERASE_PENDING.length) || null, siteErase: 'pending' };
  if (s.startsWith(SITE_ERASE_FAILED)) return { reason: s.slice(SITE_ERASE_FAILED.length) || null, siteErase: 'failed' };
  return { reason: raw ?? null, siteErase: null };
}

export function siteEraseDelayMs(attempts) {
  return Math.min(SITE_ERASE_MAX_DELAY_MS, SITE_ERASE_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Delete our copy: PII cleared, photos deleted; the row stays as an id-only tombstone. `sitePending` (OS erase while
 * the site could not be reached) marks the tombstone so the leader housekeeping retries the site erase.
 */
export async function eraseLocalLead(projectId, leadId, reason, { sitePending = null, now = new Date() } = {}) {
  const lead = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId, leadId: String(leadId).slice(0, 64) } }, include: { photos: true } });
  if (!lead) {
    // Unknown lead: record a tombstone so a late lead.created cannot create it.
    await prisma.cmsLead.create({ data: { projectId, leadId: String(leadId).slice(0, 64), erasedAt: new Date(), erasedReason: reason } }).catch(() => {});
    // v1.7.0: no attribution can exist without its lead, but unlink any visit rows that named it.
    const id = String(leadId).slice(0, 64);
    const prep = await prepareLeadErasure(projectId, id).catch(() => ({ relinks: [], dates: [] }));
    await prisma.$transaction(leadErasureOps(prisma, projectId, id, prep.relinks)).catch(() => {});
    return true;
  }
  if (lead.erasedAt) {
    // The site erased it itself (lead.erased) while we still owed the site erase: nothing is owed any more.
    const parsed = parseErasedReason(lead.erasedReason);
    if (reason === 'site' && parsed.siteErase) {
      await prisma.cmsLead.update({ where: { id: lead.id }, data: { erasedReason: parsed.reason, utm: null } });
      return true;
    }
    return false;
  }
  await deletePhotoFiles(lead.photos);
  // O-R3B-3: sessions that keep another lead after this one is gone, and the lead's rollup day (read before).
  const prep = await prepareLeadErasure(projectId, lead.leadId);
  // v1.9.0: a provider lead's mirror on the site has its own id (cmsMirrorLeadId): its visit-row links go as well.
  const mirrorId = lead.provider === 'ghl' && lead.cmsMirrorLeadId ? lead.cmsMirrorLeadId : null;
  const mirrorPrep = mirrorId ? await prepareLeadErasure(projectId, mirrorId) : { relinks: [], dates: [] };
  const ghl = lead.provider === 'ghl';
  // The "delete the contact in GoHighLevel too" checklist item: owed after a person's erase (not after retention).
  const externalOwed = ghl && !!lead.externalId && reason !== 'retention' && reason !== 'site';
  // One transaction: photo rows, the lead's attribution (v1.7.0 §38.5, plan §5.5: deleted in the SAME transaction as
  // the lead's erasure) and its links on visit rows, and the PII.
  await prisma.$transaction([
    prisma.cmsLeadPhoto.deleteMany({ where: { leadRowId: lead.id } }),
    ...leadErasureOps(prisma, projectId, lead.leadId, prep.relinks.filter((r) => r.leadId !== mirrorId)),
    ...(mirrorId ? leadErasureOps(prisma, projectId, mirrorId, mirrorPrep.relinks.filter((r) => r.leadId !== lead.leadId)) : []),
    // O-C190-2: the embedded form's thank-you signal (form_submit, leadId null) of the erased lead's visit goes too,
    // or the data-quality counter would report it as a submit whose lead never arrived.
    ...(ghl && prep.sessionId ? [prisma.signalEvent.deleteMany({ where: { projectId, sessionId: prep.sessionId, type: 'form_submit' } })] : []),
    prisma.cmsLead.update({
      where: { id: lead.id },
      data: {
        fields: null,
        consent: null,
        utm: sitePending ? { siteErase: { attempts: 0, nextAt: new Date(now.getTime() + SITE_ERASE_BASE_DELAY_MS).toISOString(), lastError: sitePending.code || 'ERROR', actor: sitePending.actor } } : null,
        formName: null,
        sourcePath: null,
        erasedAt: now,
        erasedReason: sitePending ? `${SITE_ERASE_PENDING}${reason}`.slice(0, 32) : reason,
        ...(ghl
          ? {
              // the mirror job never runs for an erased lead; the contact link stays only while the checklist is owed
              ...(['pending', 'sending', 'failed', 'skipped'].includes(lead.mirrorState) ? { mirrorState: 'cancelled', mirrorNextAt: null } : {}),
              externalErasePending: externalOwed,
              ...(externalOwed ? {} : { externalUrl: null, externalId: null }),
            }
          : {}),
      },
    }),
  ]);
  await afterLeadErasure(projectId, prep);
  if (mirrorId) await afterLeadErasure(projectId, mirrorPrep);
  return true;
}

/** The checklist item was done by a person: the contact is deleted in GoHighLevel. The contact link is dropped. */
export async function confirmExternalErase(projectId, leadId) {
  const lead = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId, leadId: String(leadId).slice(0, 64) } }, select: { id: true, erasedAt: true, externalErasePending: true } });
  if (!lead || !lead.erasedAt || !lead.externalErasePending) return false;
  await prisma.cmsLead.update({ where: { id: lead.id }, data: { externalErasePending: false, externalUrl: null, externalId: null } });
  return true;
}

const leadActor = (user) => ({ kind: 'human', osUserId: String(user.id), name: String(user.name || 'Agency OS user').slice(0, 200), role: user.role });

/**
 * OS → site lead-erase (OWNER), then our own erasure path. When the site is disconnected or unreachable (any site
 * error after our own checks), our copy is still erased (PII, photo rows and files) and the site erase is retried by
 * the leader-only housekeeping (bounded): `{ erased: true, sitePending: true }`.
 */
export async function eraseLead({ projectId, leadId, reason, user, log }) {
  if (!LEAD_ERASE_REASONS.includes(reason)) throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Choose a reason.' });
  // e2e O17: only a lead we know (by the site's leadId, not our row id) can be erased from the OS; an unknown id must
  // never reach the site or leave a tombstone for a lead that does not exist.
  const known = await prisma.cmsLead.findUnique({ where: { projectId_leadId: { projectId, leadId: String(leadId).slice(0, 64) } }, select: { id: true, erasedAt: true, provider: true, cmsMirrorLeadId: true, externalId: true, externalUrl: true } });
  if (!known) throw new CmsBridgeError({ status: 404, code: 'NOT_FOUND', message: 'Unknown lead.' });
  // v1.9.0: a GoHighLevel lead lives in GHL (the OS cannot delete it there: manual checklist item), in the OS, and as
  // a read-only mirror on the site once lead-import ran (erased with the existing lead-erase, by the mirror's id).
  const ghl = known.provider === 'ghl';
  const external = ghl && known.externalId && !known.erasedAt ? { provider: 'ghl', label: 'Delete the contact in GoHighLevel too', url: known.externalUrl || null } : null;
  if (ghl && !known.cmsMirrorLeadId) {
    const done = await eraseLocalLead(projectId, leadId, reason);
    log?.info?.({ projectId, reason }, 'GoHighLevel lead erased (no site mirror)');
    return { erased: done, alreadyGone: false, sitePending: false, ...(external ? { external } : {}) };
  }
  const siteLeadId = ghl ? known.cmsMirrorLeadId : String(leadId);
  const actor = leadActor(user);
  let res;
  let reached = false;
  try {
    const { conn } = await loadEmdashConnection(projectId);
    reached = true;
    res = await emdashRoutes.leadErase(conn, { leadId: siteLeadId, reason, actor }, { retryDelays: INTERACTIVE_RETRY_DELAYS_MS });
  } catch (err) {
    const code = err instanceof CmsBridgeError ? err.code : 'NETWORK';
    if (reached && code === 'NOT_FOUND') {
      // The site no longer has it: nothing is owed there.
      await eraseLocalLead(projectId, leadId, reason);
      return { erased: true, alreadyGone: true, sitePending: false, ...(external ? { external } : {}) };
    }
    await eraseLocalLead(projectId, leadId, reason, { sitePending: { code: String(code).slice(0, 40), actor } });
    log?.warn?.({ projectId, code }, 'EmDash lead erased in the OS; the site erase is pending');
    return { erased: true, alreadyGone: false, sitePending: true, ...(external ? { external } : {}) };
  }
  await eraseLocalLead(projectId, leadId, reason);
  log?.info?.({ projectId, reason }, 'EmDash lead erased');
  return { erased: ghl ? true : !!res?.erased, alreadyGone: !!res?.alreadyGone, sitePending: false, ...(external ? { external } : {}) };
}

/**
 * Leader-only: retry site erases still owed (≤ `limit` per run, exponential backoff 15 min → 24 h,
 * SITE_ERASE_MAX_ATTEMPTS calls, then `site_failed:`). A project that is not paired (or needs re-pairing) is skipped
 * without using an attempt; staff see "erase on site pending" until it is re-paired or erased in the site admin.
 */
export async function retryPendingSiteErases({ now = new Date(), limit = 20, log } = {}) {
  const rows = await prisma.cmsLead.findMany({
    where: { erasedAt: { not: null }, erasedReason: { startsWith: SITE_ERASE_PENDING } },
    select: { id: true, projectId: true, leadId: true, erasedReason: true, utm: true, provider: true, cmsMirrorLeadId: true },
    orderBy: { erasedAt: 'asc' },
    take: 200,
  });
  const out = { tried: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (out.tried >= limit) break;
    const st = row.utm && typeof row.utm === 'object' && row.utm.siteErase && typeof row.utm.siteErase === 'object' ? row.utm.siteErase : {};
    if (st.nextAt && Date.parse(st.nextAt) > now.getTime()) continue;
    const { reason } = parseErasedReason(row.erasedReason);
    // v1.9.0: a provider lead is erased on the site through its mirror's id; without a mirror nothing is owed there.
    const siteLeadId = row.provider === 'ghl' ? row.cmsMirrorLeadId : row.leadId;
    if (!siteLeadId) {
      await prisma.cmsLead.update({ where: { id: row.id }, data: { erasedReason: reason, utm: null } });
      out.done += 1;
      continue;
    }
    let conn;
    try {
      const p = await prisma.project.findUnique({ where: { id: row.projectId }, select: { cmsRepairNeededAt: true } });
      if (!p || p.cmsRepairNeededAt) continue; // re-pair needed: no call with the stored keys
      conn = (await loadEmdashConnection(row.projectId)).conn;
    } catch {
      continue; // not paired / not EmDash any more: no call, no attempt used
    }
    out.tried += 1;
    const attempts = (Number.isInteger(st.attempts) ? st.attempts : 0) + 1;
    try {
      await emdashRoutes.leadErase(conn, { leadId: String(siteLeadId), reason: LEAD_ERASE_REASONS.includes(reason) ? reason : 'other', actor: st.actor }, { retryDelays: [] });
      await prisma.cmsLead.update({ where: { id: row.id }, data: { erasedReason: reason, utm: null } });
      out.done += 1;
    } catch (err) {
      const code = err instanceof CmsBridgeError ? err.code : 'NETWORK';
      if (code === 'NOT_FOUND') {
        await prisma.cmsLead.update({ where: { id: row.id }, data: { erasedReason: reason, utm: null } });
        out.done += 1;
        continue;
      }
      const last = attempts >= SITE_ERASE_MAX_ATTEMPTS;
      await prisma.cmsLead.update({
        where: { id: row.id },
        data: {
          erasedReason: `${last ? SITE_ERASE_FAILED : SITE_ERASE_PENDING}${reason || 'other'}`.slice(0, 32),
          utm: { siteErase: { ...st, attempts, lastError: String(code).slice(0, 40), nextAt: last ? null : new Date(now.getTime() + siteEraseDelayMs(attempts)).toISOString() } },
        },
      });
      if (last) out.failed += 1;
    }
  }
  if (out.tried) log?.info?.(out, 'EmDash lead site-erase retries');
  return out;
}

/**
 * Leader-only: erase leads past their project's retention, retry owed site erases and copy pending photos. Bounded
 * per run. Retention covers every project that still holds un-erased leads, whatever its current cmsType or
 * connection (a project switched away from EmDash or disconnected keeps its leads until they age out).
 */
export async function leadHousekeeping({ now = new Date(), log } = {}) {
  let erased = 0;
  const withLeads = await prisma.cmsLead.findMany({ where: { erasedAt: null }, distinct: ['projectId'], select: { projectId: true }, take: 500 });
  const ids = withLeads.map((r) => r.projectId);
  const projects = ids.length ? await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, cmsLeadRetentionMonths: true } }) : [];
  const months = new Map(projects.map((p) => [p.id, p.cmsLeadRetentionMonths]));
  for (const projectId of ids) {
    const m = months.get(projectId);
    const keep = Number.isInteger(m) && m > 0 ? m : 24;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - keep);
    const old = await prisma.cmsLead.findMany({ where: { projectId, erasedAt: null, receivedAt: { lt: cutoff } }, select: { leadId: true }, take: 200 });
    for (const l of old) if (await eraseLocalLead(projectId, l.leadId, 'retention')) erased += 1;
  }
  const siteErases = await retryPendingSiteErases({ now, log }).catch(() => ({ tried: 0, done: 0, failed: 0 }));
  const copied = await copyLeadPhotos(null, { now }).catch(() => 0);
  const orphansRemoved = await sweepOrphanLeadPhotos({ now }).catch(() => 0);
  if (erased || copied || orphansRemoved) log?.info?.({ erased, copied, orphansRemoved }, 'EmDash lead housekeeping');
  return { erased, copied, orphansRemoved, siteErases };
}

/** Absolute path of a copied photo (validated name) for the authenticated download route. */
export function photoPath(storageName) {
  if (!/^[0-9a-f]{32}\.[a-z0-9]+$/.test(String(storageName || ''))) return null;
  return path.join(leadsDir(), storageName);
}
