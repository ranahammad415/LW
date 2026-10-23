/**
 * GoHighLevel (LeadConnector) forms webhook: POST /api/webhooks/ghl/forms/:projectToken (features/ghl-forms.md,
 * oasis-astro architecture §4.3 / contract §40.6). GHL workflow "Form Submitted" → Custom Webhook with the body the OS
 * Integrations page shows (or GHL's default Webhook payload). No JWT and no HMAC (GHL signs nothing): the controls are
 *   - the per-project URL token (32 random bytes, sha256 at rest, constant-time compare, rotation with 24 h overlap);
 *     unknown / revoked / expired → 404 (never 401: tokens cannot be enumerated);
 *   - the optional shared header `X-OS-Webhook-Secret` (mismatch → 404, as the architecture says);
 *   - body ≤ 64 KiB on this route only (413), JSON or form-urlencoded (anything else 415);
 *   - 60 requests / minute per token (GHL_FORMS_RATE_PER_MIN; per PM2 instance) → 429 + Retry-After;
 *   - the replay cache in lib/ghlForms/receive.js (duplicate → 200 { duplicate: true }, no second lead).
 * Token check, header secret and rate limit run in onRequest, BEFORE the body is read. Responses and logs never
 * contain a field value or the token (the URL is redacted in request logs, lib/logRedaction.js).
 */
import { prisma } from '../../lib/prisma.js';
import { findEndpointByToken, headerSecretOk } from '../../lib/ghlForms/endpoints.js';
import { receiveGhlForm, recordRejected } from '../../lib/ghlForms/receive.js';

export const GHL_BODY_LIMIT = 64 * 1024;

/** Fixed-window counter per key (per instance). `hit(key)` → { ok, retryAfterSec }. */
export function createTokenLimiter({ max = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      let w = hits.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        hits.set(key, w);
      }
      w.count += 1;
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return w.count <= max ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    },
  };
}

const notFound = (reply) => reply.status(404).type('application/json').send({ ok: false, code: 'NOT_FOUND' });

export async function ghlFormsWebhookRoutes(app, opts = {}) {
  const db = opts.db || prisma;
  const limiter = opts.limiter || createTokenLimiter({ max: Number(process.env.GHL_FORMS_RATE_PER_MIN) > 0 ? Number(process.env.GHL_FORMS_RATE_PER_MIN) : 60 });
  const receive = opts.receive || receiveGhlForm;
  const findEndpoint = opts.findEndpoint || findEndpointByToken;

  // Scoped parsers (this plugin only): JSON and form-urlencoded as text, parsed here so a bad body is a clean 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, raw, done) => {
    request.ghlBytes = Buffer.byteLength(raw || '', 'utf8');
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch {
      const e = new Error('invalid json');
      e.statusCode = 400;
      e.code = 'GHL_INVALID_BODY';
      done(e, undefined);
    }
  });
  // text/plain only when it is a JSON body sent without its content type (a GHL raw body whose header was not set);
  // anything else is 415.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (request, raw, done) => {
    request.ghlBytes = Buffer.byteLength(raw || '', 'utf8');
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return done(null, v);
    } catch {
      /* not JSON */
    }
    const e = new Error('unsupported');
    e.statusCode = 415;
    e.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    return done(e, undefined);
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, raw, done) => {
    request.ghlBytes = Buffer.byteLength(raw || '', 'utf8');
    const out = {};
    for (const [k, v] of new URLSearchParams(raw || '')) if (!(k in out)) out[k] = v;
    done(null, out);
  });

  app.setErrorHandler(async (err, request, reply) => {
    const pid = request.ghl?.project?.id;
    const bytes = Number(request.headers['content-length']) || 0;
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      if (pid) await recordRejected(pid, { reason: 'too_large', bytes, ip: request.ip }, db).catch(() => {});
      return reply.status(413).send({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    }
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
      if (pid) await recordRejected(pid, { reason: 'unsupported_type', bytes, ip: request.ip }, db).catch(() => {});
      return reply.status(415).send({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    if (err.code === 'GHL_INVALID_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err.statusCode === 400) {
      if (pid) await recordRejected(pid, { reason: 'invalid_body', bytes, ip: request.ip }, db).catch(() => {});
      return reply.status(400).send({ ok: false, code: 'INVALID_BODY' });
    }
    request.log.error({ code: err?.code || 'INTERNAL', projectId: pid }, 'GHL form webhook failed');
    return reply.status(500).send({ ok: false, code: 'INTERNAL' });
  });

  /** onRequest: token → endpoint → project, header secret, rate limit (the body is not read yet). */
  async function authorize(request, reply) {
    const found = await findEndpoint(String(request.params?.projectToken || ''), { db });
    if (!found) return notFound(reply);
    const { endpoint } = found;
    const project = await db.project.findUnique({ where: { id: endpoint.projectId }, select: { id: true, cmsType: true, cmsCapabilities: true, cmsHealth: true, status: true } });
    if (!project || project.status === 'ARCHIVED') return notFound(reply);
    request.ghl = { endpoint, project, matched: found.matched };
    if (!headerSecretOk(endpoint, request.headers['x-os-webhook-secret'])) {
      await recordRejected(project.id, { reason: 'header_secret', bytes: Number(request.headers['content-length']) || 0, ip: request.ip }, db).catch(() => {});
      return notFound(reply);
    }
    const rl = limiter.hit(endpoint.id);
    if (!rl.ok) {
      reply.header('retry-after', String(rl.retryAfterSec));
      return reply.status(429).send({ ok: false, code: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec });
    }
  }

  app.post('/forms/:projectToken', { bodyLimit: GHL_BODY_LIMIT, onRequest: [authorize] }, async (request, reply) => {
    const { endpoint, project } = request.ghl;
    const out = await receive({ project, endpoint, body: request.body, bytes: request.ghlBytes || Number(request.headers['content-length']) || 0, ip: request.ip, log: request.log, db });
    reply.header('cache-control', 'no-store');
    return reply.status(out.status).send(out.body);
  });
}
