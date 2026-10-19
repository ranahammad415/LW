/**
 * Idempotency-Key support for write routes (SEO Engine OS-05).
 *
 * Usage on a route: `{ onRequest: [app.verifyJwt], ...idempotency('POST /api/tasks') }`.
 * - No header → the route runs normally.
 * - Keys are scoped per (user, route). The request fingerprint is sha256 of the canonical JSON of
 *   { params, body } (object keys sorted, array order kept).
 * - First use claims the key with a unique insert (concurrent first use: exactly one insert wins; the other gets
 *   409 IDEMPOTENCY_IN_PROGRESS with Retry-After).
 * - Same key + same fingerprint after completion → the stored status code and body are replayed
 *   (header `Idempotent-Replayed: true`). Same key + different fingerprint → 409 IDEMPOTENCY_KEY_REUSED.
 * - 5xx responses release the key so the caller can retry; 2xx/4xx are stored. A route may also release it by setting
 *   `request.idempotency.release = true` (OS-19: a draft push whose site outcome is unknown must run again). Keys live 7 days; a pending claim
 *   older than 2 minutes (crashed request) can be reclaimed.
 * The stored body is the response after the global redaction hook, and it is only ever replayed to the same user.
 */
import { createHash } from 'crypto';
import { prisma } from './prisma.js';

export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_STALE_MS = 2 * 60 * 1000;
const KEY_RE = /^[\x21-\x7E]{1,255}$/;

/** Stable JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value) {
  return JSON.stringify(value === undefined ? null : value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export function idempotencyFingerprint(request) {
  const material = canonicalJson({ params: request.params || {}, body: request.body ?? null });
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function inProgress(reply) {
  reply.header('Retry-After', '5');
  return reply.status(409).send({
    message: 'A request with this Idempotency-Key is still in progress. Retry shortly.',
    code: 'IDEMPOTENCY_IN_PROGRESS',
  });
}

export function idempotency(route) {
  async function preHandler(request, reply) {
    const raw = request.headers['idempotency-key'];
    if (raw === undefined) return;
    if (typeof raw !== 'string' || !KEY_RE.test(raw)) {
      return reply.status(400).send({ message: 'Invalid Idempotency-Key header (1-255 visible ASCII characters)' });
    }
    const userId = request.user?.id;
    if (!userId) return;
    const requestHash = idempotencyFingerprint(request);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);

    try {
      const row = await prisma.idempotencyKey.create({
        data: { userId, route, key: raw, requestHash, state: 'pending', expiresAt },
        select: { id: true },
      });
      request.idempotency = { id: row.id };
      return;
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
    }

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_route_key: { userId, route, key: raw } },
    });
    if (!existing) return inProgress(reply);

    if (new Date(existing.expiresAt).getTime() <= now.getTime()) {
      const claimed = await prisma.idempotencyKey.updateMany({
        where: { id: existing.id, expiresAt: { lte: now } },
        data: { requestHash, state: 'pending', statusCode: null, responseBody: null, createdAt: now, expiresAt },
      });
      if (claimed.count === 1) {
        request.idempotency = { id: existing.id };
        return;
      }
      return inProgress(reply);
    }

    if (existing.requestHash !== requestHash) {
      return reply.status(409).send({
        message: 'This Idempotency-Key was already used with a different request body',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }

    if (existing.state === 'done') {
      request.idempotency = { replayed: true };
      reply.header('Idempotent-Replayed', 'true');
      reply.type('application/json; charset=utf-8');
      return reply.status(existing.statusCode || 200).send(existing.responseBody ?? '');
    }

    if (now.getTime() - new Date(existing.createdAt).getTime() > PENDING_STALE_MS) {
      const claimed = await prisma.idempotencyKey.updateMany({
        where: { id: existing.id, state: 'pending', createdAt: existing.createdAt },
        data: { createdAt: now },
      });
      if (claimed.count === 1) {
        request.idempotency = { id: existing.id };
        return;
      }
    }
    return inProgress(reply);
  }

  async function onSend(request, reply, payload) {
    const id = request.idempotency?.id;
    if (!id) return payload;
    const statusCode = reply.statusCode;
    try {
      if (statusCode >= 500 || request.idempotency?.release === true) {
        await prisma.idempotencyKey.deleteMany({ where: { id, state: 'pending' } });
      } else {
        const body = typeof payload === 'string' ? payload : payload == null ? '' : Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
        await prisma.idempotencyKey.updateMany({
          where: { id, state: 'pending' },
          data: { state: 'done', statusCode, responseBody: body },
        });
      }
    } catch (err) {
      request.log?.warn?.({ err: err?.message, route }, 'idempotency record update failed');
    }
    return payload;
  }

  return { preHandler, onSend };
}

/** Deletes expired keys. Safe to run on several instances at once (plain conditional delete). */
export async function purgeExpiredIdempotencyKeys(now = new Date()) {
  const res = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return res.count;
}
