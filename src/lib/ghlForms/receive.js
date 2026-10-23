/**
 * One delivery of the GoHighLevel forms webhook → one CmsLead (provider ghl), after the route checked the token, the
 * optional header secret, the body size and the rate limit (routes/webhooks/ghlForms.js). Architecture §4.3:
 *   1. normalise (pinned v:1 body or GHL's default payload); unknown / empty → rejected receipt, 422;
 *   2. replay cache: dedupeKey = sha256(project | GHL form | contact | payloadHash | 10-minute bucket) claimed with the
 *      receipt's unique index (PM2-safe), plus a look-back over the previous bucket → `{ duplicate: true }`, no lead;
 *      same contact + form within 10 minutes with a DIFFERENT payload → a new lead (`duplicateOf` on the receipt);
 *   3. CmsLead (leadId "xg_<ULID>", formId = the site's external form id, fields = the PII block) + LeadAttribution
 *      (ghlForms/attribution.js) + the same side effects as a site lead (lib/leadSideEffects.js);
 *   4. the lead-import mirror job is queued (mirrorState pending) when the site has capabilities.leadImport.
 * Receipts and logs hold ids, hashes and counts only: never a field value.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { normalizeGhlForm, ghlContactUrl, sha256, GHL_PROVIDER, DEFAULT_GHL_SITE_FORM_ID } from './normalize.js';
import { createGhlAttribution } from './attribution.js';
import { afterNewLead } from '../leadSideEffects.js';

export const DEDUPE_WINDOW_MS = 10 * 60_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (time-ordered, Crockford base32, 26 chars). */
export function ulid(now = Date.now(), rand = crypto.randomBytes(16)) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = '';
  for (let i = 0; i < 16; i += 1) r += CROCKFORD[rand[i] % 32];
  return time + r;
}
export const newGhlLeadId = (now = Date.now()) => `xg_${ulid(now)}`;

/** HMAC of the sender IP (16 hex): lets staff spot one sender, never reversible to the IP. */
export function ipHash(ip, env = process.env) {
  if (!ip) return null;
  const key = crypto.createHash('sha256').update(`ghl-receipt-ip:${env.JWT_ACCESS_SECRET || ''}`).digest();
  return crypto.createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 16);
}

/** The site's form id for GHL leads: the external ghl form in site-info.leads.forms, else "ghl-contact". */
export function siteFormIdFor(project) {
  const forms = project?.cmsHealth?.leads?.forms;
  if (Array.isArray(forms)) {
    const ext = forms.filter((f) => f && f.provider === 'ghl' && f.external === true && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(f.id || '')));
    if (ext.length) return { id: ext[0].id, name: ext[0].name || null };
  }
  return { id: DEFAULT_GHL_SITE_FORM_ID, name: null };
}

export function dedupeKeyFor(projectId, norm, at) {
  const bucket = Math.floor(new Date(at).getTime() / DEDUPE_WINDOW_MS);
  return sha256(['ghl', projectId, norm.form.id || '', norm.contactId || '', norm.payloadHash, bucket].join('|'));
}

async function receipt(db, data) {
  try {
    return await db.externalFormReceipt.create({ data: { provider: GHL_PROVIDER, ...data } });
  } catch (err) {
    if (err?.code === 'P2002') throw err;
    return null; // a receipt is bookkeeping: never fail the delivery for it
  }
}

/** Rejected delivery bookkeeping (no PII). */
export async function recordRejected(projectId, { reason, bytes = 0, ip = null, shape = null } = {}, db = prisma) {
  return receipt(db, { projectId, status: 'rejected', reason: String(reason).slice(0, 40), shape, bytes, ipHash: ipHash(ip) });
}

/**
 * Process one delivery. Returns { status: 200 | 422, body } — the route sends it as is.
 * `project` = { id, cmsType, cmsCapabilities, cmsHealth, cmsPairedAt }.
 */
export async function receiveGhlForm({ project, endpoint, body, bytes = 0, ip = null, now = new Date(), log, db = prisma, sideEffects = afterNewLead }) {
  const n = normalizeGhlForm(body);
  if (n.error) {
    await recordRejected(project.id, { reason: n.error, bytes, ip }, db);
    log?.info?.({ projectId: project.id, reason: n.error }, 'GHL form webhook rejected');
    return { status: 422, body: { ok: false, code: 'UNPROCESSABLE', reason: n.error } };
  }
  const norm = n.lead;
  const hashIp = ipHash(ip);

  // Replay cache: the same submission seen in this or the previous 10-minute bucket → duplicate.
  const lookback = await db.externalFormReceipt.findFirst({
    where: { projectId: project.id, status: 'accepted', payloadHash: norm.payloadHash, ...(norm.contactId ? { externalId: norm.contactId } : {}), receivedAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } },
    orderBy: { receivedAt: 'desc' },
    select: { leadId: true },
  });
  const duplicateOf = async (leadId) => {
    await receipt(db, { projectId: project.id, status: 'duplicate', reason: 'duplicate', shape: norm.shape, payloadHash: norm.payloadHash, externalId: norm.contactId, formId: norm.form.id, leadId, bytes, ipHash: hashIp });
    return { status: 200, body: { ok: true, duplicate: true, leadId } };
  };
  if (lookback) return duplicateOf(lookback.leadId);

  // Edited re-submit (same contact + GHL form within 10 minutes, different values): a new lead, linked for staff.
  const earlier = norm.contactId
    ? await db.externalFormReceipt.findFirst({
        where: { projectId: project.id, status: 'accepted', externalId: norm.contactId, formId: norm.form.id, receivedAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } },
        orderBy: { receivedAt: 'desc' },
        select: { leadId: true },
      })
    : null;

  const leadId = newGhlLeadId(now.getTime());
  let claim;
  try {
    claim = await db.externalFormReceipt.create({
      data: {
        provider: GHL_PROVIDER,
        projectId: project.id,
        status: 'accepted',
        reason: earlier ? 'resubmit' : 'ok',
        shape: norm.shape,
        payloadHash: norm.payloadHash,
        dedupeKey: dedupeKeyFor(project.id, norm, now),
        externalId: norm.contactId,
        formId: norm.form.id,
        leadId,
        duplicateOf: earlier?.leadId || null,
        bytes,
        ipHash: hashIp,
        receivedAt: now,
      },
    });
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
    // Another instance claimed the same submission a moment ago.
    const winner = await db.externalFormReceipt.findUnique({ where: { dedupeKey: dedupeKeyFor(project.id, norm, now) }, select: { leadId: true } });
    return duplicateOf(winner?.leadId || null);
  }

  const siteForm = siteFormIdFor(project);
  const canMirror = project.cmsType === 'EMDASH' && project.cmsCapabilities?.leadImport === true;
  let lead;
  try {
    lead = await db.cmsLead.create({
      data: {
        projectId: project.id,
        leadId,
        provider: GHL_PROVIDER,
        siteId: null,
        formId: siteForm.id,
        formName: (norm.form.name || siteForm.name || 'GoHighLevel form').slice(0, 200),
        sourcePath: norm.attribution.page,
        utm: norm.attribution.utm,
        fields: norm.fields,
        consentMarketing: false,
        consent: { text: 'Submitted through the GoHighLevel form on the website', version: 'ghl-1', at: (norm.createdAt || now).toISOString() },
        spamVerdict: 'ok',
        siteCreatedAt: norm.createdAt || now,
        siteRetentionDays: null,
        externalId: norm.contactId,
        externalUrl: ghlContactUrl(norm.locationId, norm.contactId),
        mirrorState: canMirror ? 'pending' : 'skipped',
        mirrorNextAt: canMirror ? now : null,
        mirrorError: canMirror ? null : 'NO_CAPABILITY',
        receivedAt: now,
      },
    });
  } catch (err) {
    // Release the claim so GHL's retry can deliver it again; never echo the error (it could hold values).
    await db.externalFormReceipt.delete({ where: { id: claim.id } }).catch(() => {});
    log?.error?.({ projectId: project.id, code: err?.code || 'INTERNAL' }, 'GHL form lead store failed');
    const e = new Error('Lead store failed');
    e.code = 'INTERNAL';
    throw e;
  }

  await createGhlAttribution(lead, norm, { formId: siteForm.id, db }).catch((err) => log?.warn?.({ projectId: project.id, code: err?.code || 'ATTRIBUTION_FAILED' }, 'GHL lead attribution failed'));
  await sideEffects(project.id, lead, { log });
  if (endpoint?.id) await db.externalFormEndpoint.update({ where: { id: endpoint.id }, data: { lastReceivedAt: now } }).catch(() => {});
  log?.info?.({ projectId: project.id, shape: norm.shape, resubmit: !!earlier, mirror: canMirror }, 'GHL form lead stored');
  return { status: 200, body: { ok: true, leadId, duplicate: false } };
}
