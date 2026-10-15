/**
 * Site → OS endpoints of the EmDash bridge (contract agency-os-bridge/v1 §4, §5.2, §6).
 * Mounted at /api/webhooks/emdash:
 *   POST /handshake  pairing (signed with the pairing signing key) and heartbeat (outbound key);
 *                    responses are signed (X-AOS-Response-*), rotation is delivered here.
 *   POST /events     signed event batches; idempotent on (projectId, eventId) via a DB unique
 *                    index (PM2-safe); per-review seq ordering with gap heal via pipeline-get.
 *
 * No JWT: authentication is the HMAC signature. The raw body is hashed BEFORE JSON parsing
 * (scoped content-type parser below, this plugin only). Bodies over 1 MiB → 413
 * PAYLOAD_TOO_LARGE (non-retryable) in the contract envelope.
 *
 * The persistence layer is injected (`opts.store`, default lib/cmsStore.js prismaCmsStore)
 * so tests can run against an in-memory store.
 */
import {
  CONTRACT_VERSION,
  CONTRACT_REVISION,
  SUPPORTED_CONTRACTS,
  HEADERS,
  MAX_EVENTS_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_SNAPSHOT_CHARS,
  NOT_PAIRED,
  PAIRING_KEY_ID,
  errorBody,
  generateKey,
  negotiateContract,
  resolveKey,
  signResponse,
  verifyRequest,
  sha256Hex,
} from '../../lib/siteAdapters/signing.js';
import { CmsKeyConfigError } from '../../lib/cmsKeyCrypto.js';
import { credentialToRings, normalizeReviewEvent } from '../../lib/siteAdapters/emdash.js';

export const OS_VERSION = '2026.10.16';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function sendError(reply, code, message, details) {
  const { status, body } = errorBody(code, message, details);
  return reply.status(status).type('application/json').send(JSON.stringify(body));
}

function rawPath(request) {
  return String(request.raw.url || request.url || '');
}

function parseJson(buf) {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
    return { ok: true, value: text.length ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
}

/** Per-event envelope check (contract common.json#/$defs/event). Returns an error message or null. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'event must be an object';
  if (typeof ev.eventId !== 'string' || !ID_RE.test(ev.eventId)) return 'eventId is required';
  if (typeof ev.type !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(ev.type)) return 'type is invalid';
  if (typeof ev.at !== 'string' || !DATE_RE.test(ev.at)) return 'at must be an RFC 3339 date-time';
  if (!Number.isInteger(ev.cursor) || ev.cursor < 1) return 'cursor must be an integer >= 1';
  if (!ev.actor || typeof ev.actor !== 'object' || typeof ev.actor.source !== 'string') return 'actor is required';
  if (ev.snapshotText !== undefined && (typeof ev.snapshotText !== 'string' || ev.snapshotText.length > MAX_SNAPSHOT_CHARS)) {
    return `snapshotText must be a string of at most ${MAX_SNAPSHOT_CHARS} chars`;
  }
  if (ev.type.startsWith('pipeline_')) {
    if (!Number.isInteger(ev.seq) || ev.seq < 1) return 'seq is required on pipeline_* events';
    const r = ev.review;
    if (!r || typeof r !== 'object') return 'review is required on pipeline_* events';
    if (typeof r.reviewId !== 'string' || !ID_RE.test(r.reviewId)) return 'review.reviewId is required';
    if (!Number.isInteger(r.reviewNo) || r.reviewNo < 1) return 'review.reviewNo is required';
    if (!Number.isInteger(r.entryNo) || r.entryNo < 1) return 'review.entryNo is required';
    if (typeof r.status !== 'string' || !r.status) return 'review.status is required';
  } else if (ev.type.startsWith('content.')) {
    if (ev.seq !== undefined) return 'seq must be absent on content.* events';
    const e = ev.entry;
    if (!e || typeof e !== 'object') return 'entry is required on content.* events';
    if (typeof e.entryId !== 'string' || !ID_RE.test(e.entryId)) return 'entry.entryId is required';
    if (!Number.isInteger(e.entryNo) || e.entryNo < 1) return 'entry.entryNo is required';
    if (typeof e.updatedAt !== 'string' || !DATE_RE.test(e.updatedAt)) return 'entry.updatedAt is required';
  }
  return null;
}

/** In-memory per-project /events rate limit (contract §10: 300/min/project; per PM2 instance). */
function createRateLimiter(perMin) {
  const buckets = new Map();
  return (key, now = Date.now()) => {
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return b.count <= perMin ? null : Math.ceil((b.resetAt - now) / 1000);
  };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ store?: object, now?: () => number, onHeal?: Function, eventsPerMin?: number }} opts
 */
export async function emdashWebhookRoutes(app, opts = {}) {
  const store = opts.store || (await import('../../lib/cmsStore.js')).prismaCmsStore;
  const nowFn = opts.now || (() => Date.now());
  const onHeal = opts.onHeal || (await import('../../lib/emdashSync.js')).healReviews;
  const rateLimit = createRateLimiter(
    Number(opts.eventsPerMin || process.env.CMS_EVENTS_RATE_PER_MIN) || 300
  );
  // Clamped to the contract's 300 s so the 600 s nonce TTL always covers 2 x skew (review S9).
  const maxSkewSec = Math.min(300, Math.max(30, Number(process.env.CMS_WEBHOOK_MAX_SKEW_SEC) || 300));

  // Raw body for hashing; scoped to this plugin (encapsulated), so no other route changes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_EVENTS_BODY_BYTES }, (req, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((err, request, reply) => {
    if (err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err?.statusCode === 413) {
      return sendError(reply, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_EVENTS_BODY_BYTES} bytes; split the batch`);
    }
    const status = err?.statusCode;
    if (status === 429) {
      // @fastify/rate-limit (per-IP flood guard): retryable, with Retry-After (contract v1.0.2 C3).
      const after = Number(reply.getHeader('retry-after')) || Math.ceil(Number(err?.ttl || 60000) / 1000) || 60;
      reply.header('retry-after', String(after));
      return sendError(reply, 'RATE_LIMITED', 'Too many requests', { retryAfterSec: after });
    }
    if (status === 400) {
      return sendError(reply, 'VALIDATION', err.message || 'Invalid request');
    }
    if (status && status < 500) {
      const { body } = errorBody('VALIDATION', err.message || 'Request refused');
      return reply.status(status).type('application/json').send(JSON.stringify(body));
    }
    request.log.error({ err }, 'EmDash webhook failed');
    return sendError(reply, 'INTERNAL', 'Internal error');
  });

  // Own per-IP flood limit instead of the global 300/min (many sites can share one host IP and
  // outboxes retry); the per-project /events limit below is the contract one (review S3).
  const routeOpts = {
    bodyLimit: MAX_EVENTS_BODY_BYTES,
    config: {
      rateLimit: opts.routeRateLimit || { max: Number(process.env.CMS_WEBHOOK_IP_RATE_PER_MIN) || 1200, timeWindow: '1 minute' },
    },
  };

  const resolveOutbound = async (siteId, keyId, now) => {
    const project = await store.findProjectBySiteId(siteId);
    if (!project || project.cmsType !== 'EMDASH') return undefined;
    const cred = await store.getCredential(project.id);
    // v1.0.4 §17(b): 503 NOT_PAIRED only while the first pairing never completed; a disconnected site
    // gets 401 UNKNOWN_KEY ("re-pair needed" on the site).
    if (!cred) return project.cmsDisconnectedAt ? null : NOT_PAIRED;
    const rings = credentialToRings(cred, now);
    return resolveKey(rings.outbound, keyId, now);
  };

  // ── POST /handshake ────────────────────────────────────────────────────────
  app.post('/handshake', routeOpts, async (request, reply) => {
    const now = nowFn();
    const path = rawPath(request);
    const body = request.body ?? Buffer.alloc(0);
    const keyIdHeader = String(request.headers[HEADERS.keyId] || '');
    try {
      if (keyIdHeader === PAIRING_KEY_ID) return await handlePairing({ request, reply, path, body, now });
      return await handleHeartbeat({ request, reply, path, body, now });
    } catch (err) {
      if (err instanceof CmsKeyConfigError) {
        request.log.error('CMS_KEY_ENCRYPTION_KEY is not set; EmDash handshake refused');
        return sendError(reply, 'INTERNAL', 'Agency OS is not configured for EmDash sites yet');
      }
      throw err;
    }
  });

  async function handlePairing({ request, reply, path, body, now }) {
    let code = null;
    const v = await verifyRequest({
      method: 'POST',
      path,
      body,
      headers: request.headers,
      now,
      maxSkewSec,
      nonceCache: store.nonceCache,
      resolveSecret: async (siteId) => {
        code = await store.getActivePairingCode(siteId, new Date(now));
        if (!code) return undefined;
        return store.decryptSigningKey(code);
      },
    });
    if (!v.ok) {
      if (v.status === 401) {
        let details;
        // Burn rule (contract errata v1.0.1): only a well-formed request with a fresh timestamp and
        // an unseen nonce whose signature is wrong counts toward the 5 attempts. Malformed, stale or
        // replayed requests get the same 401 but do not burn the code.
        if (code && v.signatureMismatch) {
          // Seen = used by an accepted request, or already counted as a failed pairing attempt
          // (kept under a separate 'pairfail:' key so real nonces are never burned by forgeries).
          const usedOk = store.nonceCache.peek ? await store.nonceCache.peek(v.nonceKey, now) : false;
          const failKey = `${v.siteId}:pf-${sha256Hex(v.nonceKey).slice(0, 40)}`;
          const firstFailure = usedOk ? false : await store.nonceCache.checkAndStore(failKey, now + 600_000);
          if (firstFailure) {
            const { attemptsLeft } = await store.recordPairingFailure(code.id);
            details = { attemptsLeft };
          }
        }
        return sendError(reply, 'PAIRING_CODE_INVALID', 'Pairing code is invalid, expired or already used', details);
      }
      // v1.0.1: on the pairing path every failure except 426 (413 is answered by the error handler)
      // is 401 PAIRING_CODE_INVALID, including replayed and malformed requests (review S8).
      if (v.code === 'CONTRACT_UNSUPPORTED') return sendError(reply, v.code, v.message, v.details);
      return sendError(reply, 'PAIRING_CODE_INVALID', 'Pairing code is invalid, expired or already used');
    }
    const invalid = (reason) => sendError(reply, 'PAIRING_CODE_INVALID', `Pairing request refused: ${reason}`);

    const parsed = parseJson(body);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return invalid('body must be JSON');
    const info = parsed.value;
    if (info.mode !== 'pair') return invalid('mode must be "pair" when signed with the pairing key');
    if (info.siteId !== v.siteId) return invalid('body siteId must equal X-AOS-Site');
    const contract = negotiateContract(info.supportedContracts);
    if (!contract) {
      return sendError(reply, 'CONTRACT_UNSUPPORTED', 'No common contract version', { supported: [...SUPPORTED_CONTRACTS] });
    }

    // The code (not Project.cmsSiteId) names the project: a re-pair as a NEW siteId switches
    // Project.cmsSiteId only when pairing completes, so the old credential keeps working until then.
    const project = await store.findProjectById(code.projectId);
    if (!project || project.cmsType !== 'EMDASH' || !(await store.consumePairingCode(code.id, new Date(now)))) {
      return sendError(reply, 'PAIRING_CODE_INVALID', 'Pairing code is invalid, expired or already used');
    }

    const inbound = generateKey();
    const outbound = generateKey();
    const paired = await store.completePairing({
      projectId: project.id,
      siteId: code.siteId,
      siteUrl: code.siteUrl || null,
      siteInfo: info,
      contract,
      inbound,
      outbound,
      now: new Date(now),
    });
    request.log.info({ projectId: project.id, siteId: v.siteId }, 'EmDash site paired');

    const responseBody = JSON.stringify({
      ok: true,
      contract,
      contractRevision: CONTRACT_REVISION,
      siteId: v.siteId,
      projectId: project.id,
      projectName: String(project.name || '').slice(0, 200),
      serverTime: Math.floor(now / 1000),
      os: { version: OS_VERSION, capabilities: { clientReviewFromOs: false, seoProfiles: false } },
      pms: await store.listPms(project),
      // v1.0.3 §16(b): key ids continue across re-pairs (current id + 1); first pairing = 1.
      keys: { keyId: paired?.keyId || 1, inbound, outbound },
      // v1.0.3 (additive): the plugin seeds its surrogate counters to max(local, floor) + 1.
      counterFloor: await store.getCounterFloor(project.id),
    });
    return sendSigned(reply, { secret: v.secret, keyId: PAIRING_KEY_ID, path, nonce: v.nonce, body: responseBody, now });
  }

  async function handleHeartbeat({ request, reply, path, body, now }) {
    const v = await verifyRequest({
      method: 'POST',
      path,
      body,
      headers: request.headers,
      now,
      maxSkewSec,
      nonceCache: store.nonceCache,
      resolveSecret: resolveOutbound,
    });
    if (!v.ok) return sendError(reply, v.code, v.message, v.details);

    const parsed = parseJson(body);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return sendError(reply, 'VALIDATION', 'Body must be JSON');
    const info = parsed.value;
    if (info.mode !== 'heartbeat' && info.mode !== 'disconnect') {
      return sendError(reply, 'VALIDATION', 'mode must be "heartbeat" or "disconnect" when signed with a site key');
    }
    if (info.siteId !== v.siteId) return sendError(reply, 'VALIDATION', 'Body siteId must equal X-AOS-Site');
    if (info.mode === 'disconnect') return handleSiteDisconnect({ request, reply, path, v, now });
    const contract = negotiateContract(info.supportedContracts);
    if (!contract) {
      return sendError(reply, 'CONTRACT_UNSUPPORTED', 'No common contract version', { supported: [...SUPPORTED_CONTRACTS] });
    }

    const project = await store.findProjectBySiteId(v.siteId);
    const cred = await store.getCredential(project.id);
    const rings = credentialToRings(cred, now);
    await store.recordHeartbeat({ projectId: project.id, siteInfo: info, contract, now: new Date(now) });

    // Sign with the inbound key of the generation the site used (current in the normal case).
    const reqKeyId = Number(v.keyId);
    const signKey = resolveKey(rings.inbound, v.keyId, now);
    let rotate = null;
    if (reqKeyId === cred.keyId && cred.pendingKeyId != null) {
      rotate = await store.applyRotation({ projectId: project.id, fromKeyId: cred.keyId, now: new Date(now) });
      if (rotate) request.log.info({ projectId: project.id, keyId: rotate.keyId }, 'EmDash keys rotated');
    } else if (rings.inbound.prev && reqKeyId === rings.inbound.prev.id && reqKeyId < cred.keyId) {
      // The site never installed the last rotation (lost response): deliver the current pair again.
      rotate = { keyId: cred.keyId, inbound: rings.inbound.current.secret, outbound: rings.outbound.current.secret };
    }

    const responseBody = JSON.stringify({
      ok: true,
      contract,
      contractRevision: CONTRACT_REVISION,
      siteId: v.siteId,
      projectId: project.id,
      projectName: String(project.name || '').slice(0, 200),
      serverTime: Math.floor(now / 1000),
      os: { version: OS_VERSION, capabilities: { clientReviewFromOs: false, seoProfiles: false } },
      pms: await store.listPms(project),
      counterFloor: await store.getCounterFloor(project.id),
      ...(rotate ? { rotate } : {}),
    });
    return sendSigned(reply, { secret: signKey, keyId: v.keyId, path, nonce: v.nonce, body: responseBody, now });
  }

  /**
   * v1.0.4 §17(b): site-initiated disconnect, signed with the CURRENT outbound key (a previous key id is
   * 401 UNKNOWN_KEY). Clears the paired state exactly like the OWNER disconnect; the response is signed
   * with the inbound key of the same generation.
   */
  async function handleSiteDisconnect({ request, reply, path, v, now }) {
    const project = await store.findProjectBySiteId(v.siteId);
    const cred = await store.getCredential(project.id);
    if (!cred || Number(v.keyId) !== cred.keyId) {
      return sendError(reply, 'UNKNOWN_KEY', 'Disconnect must be signed with the current key');
    }
    const rings = credentialToRings(cred, now);
    const signKey = resolveKey(rings.inbound, v.keyId, now);
    await store.disconnect(project.id, new Date(now));
    request.log.info({ projectId: project.id, siteId: v.siteId }, 'EmDash site disconnected by the site');
    const body = JSON.stringify({ ok: true, siteId: v.siteId, disconnected: true, serverTime: Math.floor(now / 1000) });
    return sendSigned(reply, { secret: signKey, keyId: v.keyId, path, nonce: v.nonce, body, now });
  }

  function sendSigned(reply, { secret, keyId, path, nonce, body, now }) {
    if (!secret) {
      // Never sign with an empty key (review S7).
      return sendError(reply, 'INTERNAL', 'No signing key available for this response');
    }
    const headers = signResponse({
      secret,
      keyId,
      status: 200,
      path,
      requestNonce: nonce,
      body,
      timestamp: Math.floor(now / 1000),
    });
    reply.header('cache-control', 'no-store');
    for (const [k, val] of Object.entries(headers)) reply.header(k, val);
    return reply.status(200).type('application/json').send(body);
  }

  // ── POST /events ──────────────────────────────────────────────────────────
  app.post('/events', routeOpts, async (request, reply) => {
    const now = nowFn();
    const path = rawPath(request);
    const body = request.body ?? Buffer.alloc(0);
    if (body.length > MAX_EVENTS_BODY_BYTES) {
      return sendError(reply, 'PAYLOAD_TOO_LARGE', `Event batch exceeds ${MAX_EVENTS_BODY_BYTES} bytes; split the batch`);
    }

    let v;
    try {
      v = await verifyRequest({
        method: 'POST',
        path,
        body,
        headers: request.headers,
        now,
        maxSkewSec,
        nonceCache: store.nonceCache,
        resolveSecret: resolveOutbound,
      });
    } catch (err) {
      if (err instanceof CmsKeyConfigError) {
        request.log.error('CMS_KEY_ENCRYPTION_KEY is not set; EmDash events refused');
        return sendError(reply, 'INTERNAL', 'Agency OS is not configured for EmDash sites yet');
      }
      throw err;
    }
    if (!v.ok) return sendError(reply, v.code, v.message, v.details);

    const project = await store.findProjectBySiteId(v.siteId);
    const retryAfter = rateLimit(project.id, now);
    if (retryAfter) {
      reply.header('retry-after', String(retryAfter));
      return sendError(reply, 'RATE_LIMITED', 'Too many event batches for this site', { retryAfterSec: retryAfter });
    }

    const parsed = parseJson(body);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return sendError(reply, 'VALIDATION', 'Body must be a JSON object');
    }
    const batch = parsed.value;
    if (batch.siteId !== v.siteId) return sendError(reply, 'VALIDATION', 'Body siteId must equal X-AOS-Site');
    if (!Number.isInteger(batch.contract) || batch.contract < 1) return sendError(reply, 'VALIDATION', 'contract is required');
    if (!Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > MAX_EVENTS_PER_BATCH) {
      return sendError(reply, 'VALIDATION', `events must hold 1..${MAX_EVENTS_PER_BATCH} items`);
    }

    // v1.0.2 C1: a NEW eventId reusing a stored cursor, a stored (review, seq) of another event, or a
    // known reviewNo/entryNo mapped to another ULID means the site lost its storage. Whole request:
    // 409 COUNTER_REGRESSION, nothing stored, project flagged "re-pair needed".
    const regression = await store.findCounterRegression(
      project.id,
      batch.events.filter(
        (e) =>
          !validateEvent(e) &&
          (e.siteId === undefined || e.siteId === project.cmsSiteId) &&
          (e.review?.siteId === undefined || e.review?.siteId === null || e.review.siteId === project.cmsSiteId)
      ),
      project.cmsSiteId
    );
    if (regression) {
      await store.flagRepairNeeded(project.id, regression, request.log);
      request.log.warn({ projectId: project.id, regression }, 'EmDash counter regression');
      return sendError(reply, 'COUNTER_REGRESSION', `${regression}: re-pair this site as a new siteId`);
    }

    const result = await processEventBatch({ store, project, events: batch.events, log: request.log });
    await store.touchLastSeen(project.id, new Date(now));
    if (result.storedCursor > 0) await store.setLastCursor(project.id, result.storedCursor);

    if (result.heal.length) {
      Promise.resolve()
        .then(() => onHeal(project.id, result.heal, request.log))
        .catch((err) => request.log.warn({ err, projectId: project.id }, 'EmDash seq gap heal failed'));
    }

    return reply.status(200).type('application/json').send(
      JSON.stringify({
        ok: true,
        accepted: result.accepted,
        duplicate: result.duplicate,
        rejected: result.rejected,
        lastCursor: result.lastCursor,
      })
    );
  });

}

/**
 * Classify and apply one batch (contract §6.3; reference classifyEvents in
 * os-bridge-contract/src/idempotency.mjs). Events are processed in ascending cursor order.
 * Idempotency is the receipt claim (DB unique on projectId+eventId), so a batch replayed to
 * a second PM2 instance at the same time cannot be applied twice.
 */
export async function processEventBatch({ store, project, events, log }) {
  const accepted = [];
  const duplicate = [];
  const rejected = [];
  const heal = new Set();
  const seqs = new Map();
  const updated = new Map();
  const seenInBatch = new Set();
  let snapshots = 0;
  let storedCursor = 0;
  let contentApplied = false;

  const sorted = [...events].sort((a, b) => (Number(a?.cursor) || 0) - (Number(b?.cursor) || 0));
  for (const ev of sorted) {
    const invalid = validateEvent(ev);
    if (invalid) {
      const eventId = typeof ev?.eventId === 'string' ? ev.eventId.slice(0, 64) : 'unknown';
      rejected.push({ eventId, code: 'VALIDATION', retryable: false, message: invalid });
      continue;
    }
    // v1.0.4 §17(a): events carry the siteId current when the site created them; one stamped for another
    // siteId (e.g. the site's previous pairing) is never applied. No siteId = older plugin = current site.
    if (ev.siteId !== undefined && ev.siteId !== project.cmsSiteId) {
      rejected.push({ eventId: ev.eventId, code: 'VALIDATION', retryable: false, message: 'Event belongs to another siteId' });
      continue;
    }
    // v1.0.5: the Review inside a pipeline_* envelope carries its own siteId; never mirror a foreign one.
    if (ev.review && ev.review.siteId !== undefined && ev.review.siteId !== null && ev.review.siteId !== project.cmsSiteId) {
      log?.warn?.({ projectId: project.id, eventId: ev.eventId, reviewId: ev.review.reviewId }, 'EmDash event Review for another siteId rejected');
      rejected.push({ eventId: ev.eventId, code: 'VALIDATION', retryable: false, message: 'Review belongs to another siteId' });
      continue;
    }
    if (seenInBatch.has(ev.eventId)) {
      duplicate.push(ev.eventId);
      continue;
    }
    if (typeof ev.snapshotText === 'string') {
      snapshots += 1;
      if (snapshots > 1) {
        rejected.push({ eventId: ev.eventId, code: 'TOO_MANY_SNAPSHOTS', retryable: true, message: 'At most one snapshotText per batch' });
        continue;
      }
    }

    const claim = await store.claimReceipt(project.id, ev, project.cmsSiteId);
    seenInBatch.add(ev.eventId);
    if (claim === 'duplicate') {
      duplicate.push(ev.eventId);
      storedCursor = Math.max(storedCursor, ev.cursor);
      continue;
    }
    if (claim === 'in_flight') {
      // v1.0.2 C4: being processed by another OS instance. Not final: the site re-sends it later.
      seenInBatch.delete(ev.eventId);
      rejected.push({ eventId: ev.eventId, code: 'INTERNAL', retryable: true, message: 'Event is being processed; retry later' });
      continue;
    }

    try {
      let outcome = 'stored';
      if (ev.type.startsWith('pipeline_')) {
        const r = ev.review;
        if (await store.isTombstoned(project.id, r.reviewNo)) {
          outcome = 'tombstoned';
        } else {
          const stored = seqs.has(r.reviewId) ? seqs.get(r.reviewId) : (await store.getReviewSeq(project.id, r.reviewId, r.reviewNo)) || 0;
          if (ev.seq <= stored) {
            outcome = 'stale';
          } else {
            const normalized = normalizeReviewEvent(r, {
              eventType: ev.type,
              seq: ev.seq,
              message: ev.message,
              override: ev.override === true,
              snapshotText: ev.snapshotText,
            });
            const applied = await store.applyPipelineEvent(project, normalized, log);
            if (applied?.skipped === 'stale_seq') {
              // Lost the atomic seq claim to a newer event (another instance): stale, no notification.
              outcome = 'stale';
            } else {
              if (ev.seq > stored + 1) heal.add(r.reviewId);
              seqs.set(r.reviewId, ev.seq);
              outcome = 'applied';
            }
          }
        }
      } else if (ev.type.startsWith('content.')) {
        const e = ev.entry;
        const stored = updated.has(e.entryId) ? updated.get(e.entryId) : await store.getEntryUpdatedAt(project.id, e.entryId, e.entryNo);
        const storedMs = stored ? new Date(stored).getTime() : null;
        if (storedMs != null && Date.parse(e.updatedAt) < storedMs) {
          outcome = 'stale';
        } else {
          await store.applyContentEvent(project, ev);
          updated.set(e.entryId, e.updatedAt);
          contentApplied = true;
          outcome = 'applied';
        }
      }
      await store.finalizeReceipt(project.id, ev.eventId, outcome);
      accepted.push(ev.eventId);
      storedCursor = Math.max(storedCursor, ev.cursor);
    } catch (err) {
      log?.error?.({ err, eventId: ev.eventId, type: ev.type }, 'EmDash event apply failed');
      await store.releaseReceipt(project.id, ev.eventId).catch(() => {});
      seenInBatch.delete(ev.eventId);
      const validation = err?.code === 'VALIDATION';
      rejected.push({
        eventId: ev.eventId,
        code: validation ? 'VALIDATION' : 'INTERNAL',
        retryable: !validation,
        message: validation ? String(err.message || 'Invalid event').slice(0, 300) : 'Could not apply the event; retry later',
      });
    }
  }

  if (contentApplied) store.afterContentBatch?.(project.id, log);
  // Contract errata v1.0.1: lastCursor = highest cursor among accepted + duplicate events.
  const lastCursor = storedCursor;
  return { accepted, duplicate, rejected, heal: [...heal], lastCursor, storedCursor };
}

export { CONTRACT_VERSION };
