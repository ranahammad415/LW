/**
 * Per-project webhook credential of the GoHighLevel forms webhook (ExternalFormEndpoint).
 * - Token: 32 random bytes, base64url (43 chars), shown ONCE; only sha256 is stored (plus a 6-char prefix to recognise it).
 * - Lookup by hash, then a constant-time compare. Unknown, revoked, or an expired previous token → null (the route
 *   answers 404, so tokens cannot be enumerated).
 * - Rotate: a new token; the old one keeps working for 24 h (prevTokenHash / prevValidUntil).
 * - Optional header secret (`X-OS-Webhook-Secret`): shown once, sha256 stored, compared in constant time.
 * - Revoke: the token (and the previous one) stop at once; "Generate" mints a fresh token afterwards.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { GHL_PROVIDER } from './normalize.js';

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const ROTATION_OVERLAP_MS = 24 * 3600_000;
export const HEADER_SECRET_NAME = 'X-OS-Webhook-Secret';
export const GHL_WEBHOOK_PATH = '/api/webhooks/ghl/forms/';

export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const mintToken = () => crypto.randomBytes(32).toString('base64url');
export const mintHeaderSecret = () => crypto.randomBytes(24).toString('base64url');

/** Constant-time equality of two hex digests (false on any length / shape difference). */
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * The live endpoint for a presented token, or null. `{ endpoint, matched: 'current' | 'previous' }`.
 */
export async function findEndpointByToken(token, { now = new Date(), db = prisma } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const h = hashToken(token);
  const rows = await db.externalFormEndpoint.findMany({
    where: { provider: GHL_PROVIDER, OR: [{ tokenHash: h }, { prevTokenHash: h }] },
    take: 2,
  });
  for (const ep of rows) {
    if (ep.revokedAt) continue;
    if (sameHash(ep.tokenHash, h)) return { endpoint: ep, matched: 'current' };
    if (ep.prevTokenHash && sameHash(ep.prevTokenHash, h) && ep.prevValidUntil && new Date(ep.prevValidUntil) > now) return { endpoint: ep, matched: 'previous' };
  }
  return null;
}

/** true when no header secret is configured, or the presented one matches (constant time). */
export function headerSecretOk(endpoint, presented) {
  if (!endpoint?.headerSecretHash) return true;
  if (typeof presented !== 'string' || !presented || presented.length > 200) return false;
  return sameHash(endpoint.headerSecretHash, hashToken(presented));
}

/** Staff view (never a hash or a token). */
export function endpointView(ep, now = new Date()) {
  if (!ep) return { configured: false };
  const prevActive = !!(ep.prevTokenHash && ep.prevValidUntil && new Date(ep.prevValidUntil) > now && !ep.revokedAt);
  return {
    configured: true,
    active: !ep.revokedAt,
    tokenPrefix: ep.tokenPrefix,
    createdAt: ep.createdAt,
    rotatedAt: ep.rotatedAt || null,
    previousTokenValidUntil: prevActive ? ep.prevValidUntil : null,
    revokedAt: ep.revokedAt || null,
    headerSecret: !!ep.headerSecretHash,
    lastReceivedAt: ep.lastReceivedAt || null,
  };
}

export async function loadEndpoint(projectId, db = prisma) {
  return db.externalFormEndpoint.findUnique({ where: { projectId_provider: { projectId, provider: GHL_PROVIDER } } });
}

/**
 * Generate (first time, or after a revoke): a new token, no overlap. Refused (409) while an active token exists: use
 * rotate. Returns `{ token, endpoint }`; the token is never stored.
 */
export async function generateEndpoint(projectId, user, { now = new Date(), db = prisma } = {}) {
  const existing = await loadEndpoint(projectId, db);
  if (existing && !existing.revokedAt) {
    const e = new Error('A webhook token already exists. Rotate it to get a new one.');
    e.status = 409;
    e.code = 'ALREADY_CONFIGURED';
    throw e;
  }
  const token = mintToken();
  const data = { tokenHash: hashToken(token), tokenPrefix: token.slice(0, 6), createdAt: now, createdById: user?.id ? String(user.id) : null, rotatedAt: null, prevTokenHash: null, prevValidUntil: null, revokedAt: null, headerSecretHash: existing?.headerSecretHash ?? null };
  const endpoint = existing
    ? await db.externalFormEndpoint.update({ where: { id: existing.id }, data })
    : await db.externalFormEndpoint.create({ data: { projectId, provider: GHL_PROVIDER, ...data } });
  return { token, endpoint };
}

/** Rotate: new token; the current one stays valid for 24 h. 404 when nothing active exists. */
export async function rotateEndpoint(projectId, { now = new Date(), db = prisma } = {}) {
  const existing = await loadEndpoint(projectId, db);
  if (!existing || existing.revokedAt) {
    const e = new Error('No active webhook token to rotate. Generate one first.');
    e.status = 404;
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const token = mintToken();
  const endpoint = await db.externalFormEndpoint.update({
    where: { id: existing.id },
    data: { tokenHash: hashToken(token), tokenPrefix: token.slice(0, 6), rotatedAt: now, prevTokenHash: existing.tokenHash, prevValidUntil: new Date(now.getTime() + ROTATION_OVERLAP_MS) },
  });
  return { token, endpoint };
}

/** Revoke: both tokens stop at once. */
export async function revokeEndpoint(projectId, { now = new Date(), db = prisma } = {}) {
  const existing = await loadEndpoint(projectId, db);
  if (!existing || existing.revokedAt) return existing ? { endpoint: existing } : { endpoint: null };
  const endpoint = await db.externalFormEndpoint.update({ where: { id: existing.id }, data: { revokedAt: now, prevTokenHash: null, prevValidUntil: null } });
  return { endpoint };
}

/** Set (new secret, shown once) or clear (`clear: true`) the optional header secret. */
export async function setHeaderSecret(projectId, { clear = false, db = prisma } = {}) {
  const existing = await loadEndpoint(projectId, db);
  if (!existing || existing.revokedAt) {
    const e = new Error('Generate a webhook token first.');
    e.status = 404;
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  if (clear) {
    const endpoint = await db.externalFormEndpoint.update({ where: { id: existing.id }, data: { headerSecretHash: null } });
    return { secret: null, endpoint };
  }
  const secret = mintHeaderSecret();
  const endpoint = await db.externalFormEndpoint.update({ where: { id: existing.id }, data: { headerSecretHash: hashToken(secret) } });
  return { secret, endpoint };
}

/**
 * The GHL workflow setup block (architecture §4.3 / contract §40.6): URL, headers, the raw JSON body with GHL merge
 * fields. `token` / `secret` are filled only right after they were minted (shown once); otherwise placeholders.
 * `messageKey`: the GHL unique key of the form's message field (the doc's `<message field key>`).
 */
export function webhookSetup({ baseUrl, token = null, secret = null, headerSecret = false, form = { id: '<GHL form id>', name: '<GHL form name>' }, messageKey = 'message' }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${base}${GHL_WEBHOOK_PATH}${token || '<projectToken>'}`;
  const body = {
    v: 1,
    provider: 'ghl',
    event: 'form_submitted',
    form: { id: form.id, name: form.name },
    contact: { id: '{{contact.id}}', createdAt: '{{contact.date_created}}' },
    location: { id: '{{location.id}}' },
    fields: {
      name: '{{contact.name}}',
      firstName: '{{contact.first_name}}',
      lastName: '{{contact.last_name}}',
      email: '{{contact.email}}',
      phone: '{{contact.phone}}',
      city: '{{contact.city}}',
      state: '{{contact.state}}',
      postalCode: '{{contact.postal_code}}',
      message: `{{contact.${messageKey}}}`,
      source: '{{contact.source}}',
      heardFrom: '{{contact.heard_from}}',
    },
    attribution: {
      oa_sid: '{{contact.oa_sid}}',
      oa_vid: '{{contact.oa_vid}}',
      ref_class: '{{contact.oa_ref_class}}',
      ai_source: '{{contact.oa_ai_source}}',
      source: '{{contact.oa_source}}',
      campaign: '{{contact.oa_campaign}}',
      landing: '{{contact.oa_landing}}',
      page: '{{contact.oa_page}}',
      utm: { source: '{{contact.utm_source}}', medium: '{{contact.utm_medium}}', campaign: '{{contact.utm_campaign}}', term: '{{contact.utm_term}}', content: '{{contact.utm_content}}' },
    },
    workflow: { id: '{{workflow.id}}', name: '{{workflow.name}}' },
  };
  const headers = [{ name: 'Content-Type', value: 'application/json' }];
  if (headerSecret || secret) headers.push({ name: HEADER_SECRET_NAME, value: secret || '<header secret>' });
  return {
    method: 'POST',
    url,
    headers,
    event: 'CUSTOM',
    body: JSON.stringify(body, null, 2),
    customFields: ['oa_sid', 'oa_vid', 'oa_ref_class', 'oa_ai_source', 'oa_source', 'oa_campaign', 'oa_landing', 'oa_page', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'heard_from'],
  };
}

/** Public base URL of this API for the webhook block: API_PUBLIC_URL (existing var), else the request's own origin. */
export function publicBaseUrl(request, env = process.env) {
  const fromEnv = String(env.API_PUBLIC_URL || '').trim();
  if (/^https?:\/\/[^\s/]+/.test(fromEnv)) return fromEnv.replace(/\/+$/, '').replace(/\/api$/, '');
  const proto = String(request?.headers?.['x-forwarded-proto'] || request?.protocol || 'https').split(',')[0].trim();
  const host = String(request?.headers?.['x-forwarded-host'] || request?.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}
