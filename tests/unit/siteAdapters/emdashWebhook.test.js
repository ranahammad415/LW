/**
 * Route tests for /api/webhooks/emdash/{handshake,events} with an in-memory store
 * (routes/webhooks/emdash.js takes the store by injection; the Prisma store needs MySQL).
 * Covers: pairing (signed response, single use, expiry, 5-attempt burn), heartbeat,
 * rotation (+ re-delivery to a lagging site), bad signature, stale timestamp, replayed
 * nonce, duplicate eventId, per-review seq ordering + gap heal, content ordering,
 * TOO_MANY_SNAPSHOTS, oversized body (413 envelope), unknown site, not paired.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emdashWebhookRoutes } from '../../../src/routes/webhooks/emdash.js';
import {
  createPairingCode,
  pairingSigningKey,
  pairingVerifier,
  signRequest,
  verifyResponse,
  generateKey,
} from '../../../src/lib/siteAdapters/signing.js';
import { encryptCmsSecret, decryptCmsSecret, cmsAad } from '../../../src/lib/cmsKeyCrypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) =>
  JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));

const SITE = 'site_9f3c2a7b41d0';
const PROJECT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const HS = '/api/webhooks/emdash/handshake';
const EV = '/api/webhooks/emdash/events';
const encIn = (v, pid = PROJECT_ID) => encryptCmsSecret(v, cmsAad(pid, 'inbound'));
const encOut = (v, pid = PROJECT_ID) => encryptCmsSecret(v, cmsAad(pid, 'outbound'));
const decIn = (v, pid = PROJECT_ID) => decryptCmsSecret(v, cmsAad(pid, 'inbound'));
const decOut = (v, pid = PROJECT_ID) => decryptCmsSecret(v, cmsAad(pid, 'outbound'));

function createMemoryStore() {
  const s = {
    projects: new Map(),
    creds: new Map(),
    codes: [],
    receipts: new Map(),
    reviewSeq: new Map(),
    entryUpdated: new Map(),
    applied: [],
    contentApplied: [],
    heartbeats: 0,
    nonces: new Map(),
    failApplyFor: null,
    staleFor: null,
    cursors: new Map(),
    lastClaims: new Map(),
    repairNotices: 0,
  };
  Object.assign(s, {
    counterFloor: { reviewNo: 0, entryNo: 0 },
    async getCounterFloor() {
      return s.counterFloor;
    },
    async disconnect(pid, now) {
      s.creds.delete(pid);
      Object.assign(s.projects.get(pid), { cmsPairedAt: null, cmsKeyId: null, cmsDisconnectedAt: now || new Date() });
      s.disconnects = (s.disconnects || 0) + 1;
    },
    async findProjectById(id) {
      return s.projects.get(id) || null;
    },
    async findProjectBySiteId(siteId) {
      return [...s.projects.values()].find((p) => p.cmsSiteId === siteId) || null;
    },
    async getCredential(pid) {
      return s.creds.get(pid) || null;
    },
    async getActivePairingCode(siteId, now) {
      return (
        [...s.codes].reverse().find((c) => c.siteId === siteId && !c.usedAt && !c.burnedAt && c.signingKeyEnc && c.expiresAt > now) || null
      );
    },
    decryptSigningKey(code) {
      return decryptCmsSecret(code.signingKeyEnc, cmsAad(code.projectId, 'pairing'));
    },
    async recordPairingFailure(id) {
      const c = s.codes.find((x) => x.id === id);
      c.failedAttempts += 1;
      if (c.failedAttempts >= 5) {
        c.burnedAt = new Date();
        c.signingKeyEnc = null;
      }
      return { attemptsLeft: Math.max(0, 5 - c.failedAttempts) };
    },
    async consumePairingCode(id, now) {
      const c = s.codes.find((x) => x.id === id);
      if (!c || c.usedAt || c.burnedAt || c.expiresAt <= now) return false;
      c.usedAt = now;
      c.signingKeyEnc = null;
      return true;
    },
    async completePairing({ projectId, siteId, siteUrl, contract, inbound, outbound, now }) {
      const proj = s.projects.get(projectId);
      s.lastPairing = { siteId, siteUrl, cursorBefore: proj.cmsLastCursor };
      if (siteId && proj.cmsSiteId !== siteId) proj.cmsLastCursor = null;
      if (siteId) proj.cmsSiteId = siteId;
      const prevCred = s.creds.get(projectId);
      s.pairedKeyId = prevCred ? prevCred.keyId + 1 : 1;
      if (siteUrl) proj.wpUrl = siteUrl;
      s.creds.set(projectId, {
        projectId,
        keyId: 1,
        inboundKeyEnc: encIn(inbound),
        outboundKeyEnc: encOut(outbound),
        prevKeyId: null,
        pendingKeyId: null,
      });
      Object.assign(s.projects.get(projectId), { cmsPairedAt: now, cmsContractVersion: contract, cmsKeyId: 1 });
      return { keyId: s.pairedKeyId };
    },
    async recordHeartbeat({ projectId }) {
      s.heartbeats += 1;
      s.projects.get(projectId).cmsLastSeenAt = new Date();
    },
    async applyRotation({ projectId, fromKeyId, now }) {
      const c = s.creds.get(projectId);
      if (!c || c.keyId !== fromKeyId || c.pendingKeyId == null) return null;
      const next = {
        keyId: c.pendingKeyId,
        inbound: decIn(c.inboundKeyPendingEnc),
        outbound: decOut(c.outboundKeyPendingEnc),
      };
      s.creds.set(projectId, {
        projectId,
        keyId: c.pendingKeyId,
        inboundKeyEnc: c.inboundKeyPendingEnc,
        outboundKeyEnc: c.outboundKeyPendingEnc,
        prevKeyId: c.keyId,
        inboundKeyPrevEnc: c.inboundKeyEnc,
        outboundKeyPrevEnc: c.outboundKeyEnc,
        prevExpiresAt: new Date(now.getTime() + 86_400_000),
        pendingKeyId: null,
      });
      return next;
    },
    nonceCache: {
      async peek(key) {
        return s.nonces.has(key);
      },
      async checkAndStore(key, exp) {
        if (s.nonces.has(key)) return false;
        s.nonces.set(key, exp);
        return true;
      },
    },
    async claimReceipt(pid, ev) {
      const k = `${pid}:${ev.eventId}`;
      if (s.receipts.has(k)) return s.receipts.get(k) === 'pending' ? 'in_flight' : 'duplicate';
      s.receipts.set(k, 'pending');
      s.lastClaims.set(ev.eventId, ev);
      return 'new';
    },
    async findCounterRegression(pid, events) {
      for (const e of events) {
        if (s.receipts.has(`${pid}:${e.eventId}`)) continue;
        const owner = s.cursors.get(e.cursor);
        if (owner && owner !== e.eventId) return `cursor ${e.cursor} already belongs to another event`;
      }
      return null;
    },
    async flagRepairNeeded(pid, reason) {
      const proj = s.projects.get(pid);
      if (proj.cmsRepairNeededAt) return false;
      proj.cmsRepairNeededAt = new Date();
      proj.cmsRepairReason = reason;
      s.repairNotices += 1;
      return true;
    },
    async finalizeReceipt(pid, eid, outcome) {
      const ev = s.lastClaims.get(eid);
      if (ev) s.cursors.set(ev.cursor, eid);
      s.receipts.set(`${pid}:${eid}`, outcome);
    },
    async releaseReceipt(pid, eid) {
      s.receipts.delete(`${pid}:${eid}`);
    },
    async getReviewSeq(pid, reviewId) {
      return s.reviewSeq.get(reviewId) || 0;
    },
    async getEntryUpdatedAt(pid, entryId) {
      return s.entryUpdated.get(entryId) || null;
    },
    async setLastCursor(pid, c) {
      const p = s.projects.get(pid);
      p.cmsLastCursor = Math.max(p.cmsLastCursor || 0, c);
    },
    async touchLastSeen() {},
    async isTombstoned() {
      return false;
    },
    async listPms() {
      return [{ memberId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM' }];
    },
    async applyPipelineEvent(project, n) {
      if (s.failApplyFor === n.eventType) throw new Error('db down');
      if (s.staleFor === n.eventType) return { skipped: 'stale_seq' };
      s.applied.push(n);
      s.reviewSeq.set(n.cms.reviewId, n.cms.seq);
    },
    async applyContentEvent(project, ev) {
      s.contentApplied.push(ev);
      s.entryUpdated.set(ev.entry.entryId, ev.entry.updatedAt);
    },
    afterContentBatch() {},
  });
  return s;
}

let app;
let store;
let nowMs;
const onHeal = vi.fn(async () => {});

function addProject(overrides = {}) {
  store.projects.set(PROJECT_ID, {
    id: PROJECT_ID,
    name: 'Oasis',
    cmsType: 'EMDASH',
    wpUrl: 'https://oasispoolspas.com',
    cmsSiteId: SITE,
    cmsPairedAt: null,
    cmsLastCursor: null,
    ...overrides,
  });
}

function addCode({ expiresInMs = 900_000 } = {}) {
  const code = createPairingCode(SITE);
  store.codes.push({
    id: `code-${store.codes.length + 1}`,
    projectId: PROJECT_ID,
    siteId: SITE,
    verifier: pairingVerifier(code),
    signingKeyEnc: encryptCmsSecret(pairingSigningKey(code), cmsAad(PROJECT_ID, 'pairing')),
    expiresAt: new Date(nowMs + expiresInMs),
    failedAttempts: 0,
    usedAt: null,
    burnedAt: null,
  });
  return code;
}

function pairKeys() {
  const inbound = generateKey();
  const outbound = generateKey();
  store.creds.set(PROJECT_ID, {
    projectId: PROJECT_ID,
    keyId: 1,
    inboundKeyEnc: encIn(inbound),
    outboundKeyEnc: encOut(outbound),
    prevKeyId: null,
    pendingKeyId: null,
  });
  store.projects.get(PROJECT_ID).cmsPairedAt = new Date(nowMs);
  return { inbound, outbound };
}

function post(url, rawBody, { secret, keyId, siteId = SITE, timestamp, nonce, headers = {} } = {}) {
  const signed = signRequest({
    secret,
    keyId,
    siteId,
    path: url,
    body: rawBody,
    timestamp: timestamp ?? Math.floor(nowMs / 1000),
    ...(nonce ? { nonce } : {}),
  });
  return app.inject({ method: 'POST', url, payload: rawBody, headers: { ...signed, ...headers } });
}

function handshakeBody(mode, extra = {}) {
  const base = ex(mode === 'pair' ? 'handshake.request' : 'handshake.request--heartbeat');
  return JSON.stringify({ ...base, siteId: SITE, ...extra });
}

function eventsBody(events) {
  return JSON.stringify({ contract: 1, siteId: SITE, sentAt: '2026-10-15T12:01:01Z', events });
}

beforeAll(() => {
  process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
});

beforeEach(async () => {
  store = createMemoryStore();
  nowMs = Date.UTC(2026, 9, 15, 12, 0, 0);
  onHeal.mockClear();
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  await app.register(emdashWebhookRoutes, { prefix: '/api/webhooks/emdash', store, now: () => nowMs, onHeal });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('POST /handshake — pairing', () => {
  it('pairs with the pairing signing key and returns keys in a response signed with the same key', async () => {
    addProject();
    const code = addCode();
    const body = handshakeBody('pair');
    const res = await post(HS, body, { secret: pairingSigningKey(code), keyId: 'pairing', nonce: '33333333-4444-4555-8666-777777777777' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({ ok: true, contract: 1, siteId: SITE, projectId: PROJECT_ID, keys: { keyId: 1 } });
    expect(json.keys.inbound).toMatch(/^aosk1_[A-Za-z0-9_-]{43}$/);
    expect(json.contractRevision).toBe('1.0.5');
    expect(json.counterFloor).toEqual({ reviewNo: 0, entryNo: 0 });
    expect(store.lastPairing).toEqual({ siteId: SITE, siteUrl: null, cursorBefore: null });
    expect(json.pms[0].memberId).toBe('8f14e45f-ceea-467a-9575-5f3c1b2a7d90');
    const sig = verifyResponse({
      status: 200,
      path: HS,
      requestNonce: '33333333-4444-4555-8666-777777777777',
      body: res.body,
      headers: res.headers,
      resolveSecret: (kid) => (kid === 'pairing' ? pairingSigningKey(code) : null),
      now: nowMs,
    });
    expect(sig.ok).toBe(true);
    // Stored keys equal the issued ones; the code is used and its signing key deleted.
    const cred = store.creds.get(PROJECT_ID);
    expect(decIn(cred.inboundKeyEnc)).toBe(json.keys.inbound);
    expect(decOut(cred.outboundKeyEnc)).toBe(json.keys.outbound);
    expect(store.codes[0].usedAt).toBeTruthy();
    expect(store.codes[0].signingKeyEnc).toBeNull();
  });

  it('is single use: a second pairing with the same code fails with PAIRING_CODE_INVALID', async () => {
    addProject();
    const code = addCode();
    const first = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(first.statusCode).toBe(200);
    const again = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('rejects an expired code', async () => {
    addProject();
    const code = addCode({ expiresInMs: -1000 });
    const res = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('burns the code after 5 failed attempts (attemptsLeft counts down) and refuses the right signature afterwards', async () => {
    addProject();
    const code = addCode();
    const wrong = pairingSigningKey(createPairingCode(SITE));
    const left = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await post(HS, handshakeBody('pair'), { secret: wrong, keyId: 'pairing' });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('PAIRING_CODE_INVALID');
      left.push(r.json().error.details?.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(store.codes[0].burnedAt).toBeTruthy();
    expect(store.codes[0].signingKeyEnc).toBeNull();
    const right = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(right.statusCode).toBe(401);
    expect(store.creds.size).toBe(0);
  });

  it('does not burn the code for stale, malformed or replayed requests (errata v1.0.1)', async () => {
    addProject();
    const code = addCode();
    const wrong = pairingSigningKey(createPairingCode(SITE));
    // Stale timestamp with the right key: 401, not counted.
    const stale = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing', timestamp: Math.floor(nowMs / 1000) - 600 });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('PAIRING_CODE_INVALID');
    // Malformed signature header: 401, not counted.
    const body = handshakeBody('pair');
    const signed = signRequest({ secret: wrong, keyId: 'pairing', siteId: SITE, path: HS, body, timestamp: Math.floor(nowMs / 1000) });
    const malformed = await app.inject({ method: 'POST', url: HS, payload: body, headers: { ...signed, 'x-aos-signature': 'v1=nothex' } });
    expect(malformed.statusCode).toBe(401);
    // The same forged request sent twice (same nonce): counted once.
    const nonce = 'abababab-cdcd-4efe-8a8a-121212121212';
    const f1 = await post(HS, body, { secret: wrong, keyId: 'pairing', nonce });
    const f2 = await post(HS, body, { secret: wrong, keyId: 'pairing', nonce });
    expect(f1.json().error.details).toEqual({ attemptsLeft: 4 });
    expect(f2.json().error.details).toBeUndefined();
    expect(store.codes[0].failedAttempts).toBe(1);
    // The right key still pairs.
    const ok = await post(HS, body, { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(ok.statusCode).toBe(200);
  });

  it('does not count a bad signature that reuses a nonce of an accepted request', async () => {
    addProject();
    const code = addCode();
    store.nonces.set(`${SITE}:cdcdcdcd-abab-4efe-8a8a-343434343434`, nowMs + 600_000);
    const r = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(createPairingCode(SITE)), keyId: 'pairing', nonce: 'cdcdcdcd-abab-4efe-8a8a-343434343434' });
    expect(r.statusCode).toBe(401);
    expect(store.codes[0].failedAttempts).toBe(0);
  });

  it('refuses mode=heartbeat signed with the pairing key and a body siteId that differs from X-AOS-Site', async () => {
    addProject();
    const code = addCode();
    // v1.0.1 / review S8: every pairing-path failure except 426/413 is PAIRING_CODE_INVALID.
    const r1 = await post(HS, handshakeBody('heartbeat'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(r1.statusCode).toBe(401);
    expect(r1.json().error.code).toBe('PAIRING_CODE_INVALID');
    const code2 = addCode();
    const r2 = await post(HS, handshakeBody('pair', { siteId: 'site_other00000' }), { secret: pairingSigningKey(code2), keyId: 'pairing' });
    expect(r2.json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('answers 426 when there is no common contract', async () => {
    addProject();
    const code = addCode();
    const r = await post(HS, handshakeBody('pair', { supportedContracts: [2] }), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(r.statusCode).toBe(426);
    expect(r.json().error.details.supported).toEqual([1]);
  });
});

describe('POST /handshake — heartbeat and rotation', () => {
  it('records the heartbeat and signs the response with the current inbound key', async () => {
    addProject();
    const { inbound, outbound } = pairKeys();
    const r = await post(HS, handshakeBody('heartbeat'), { secret: outbound, keyId: 1, nonce: '44444444-5555-4666-8777-888888888888' });
    expect(r.statusCode).toBe(200);
    expect(r.json().rotate).toBeUndefined();
    expect(store.heartbeats).toBe(1);
    const sig = verifyResponse({
      status: 200,
      path: HS,
      requestNonce: '44444444-5555-4666-8777-888888888888',
      body: r.body,
      headers: r.headers,
      resolveSecret: (kid) => (kid === '1' ? inbound : null),
      now: nowMs,
    });
    expect(sig.ok).toBe(true);
  });

  it('delivers staged keys, keeps the previous keys valid (24 h overlap) and re-delivers to a lagging site', async () => {
    addProject();
    const { inbound, outbound } = pairKeys();
    const nextIn = generateKey();
    const nextOut = generateKey();
    Object.assign(store.creds.get(PROJECT_ID), {
      pendingKeyId: 2,
      inboundKeyPendingEnc: encIn(nextIn),
      outboundKeyPendingEnc: encOut(nextOut),
    });
    const r = await post(HS, handshakeBody('heartbeat'), { secret: outbound, keyId: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().rotate).toEqual({ keyId: 2, inbound: nextIn, outbound: nextOut });
    // Response signed with the CURRENT (pre-rotation) inbound key 1.
    expect(r.headers['x-aos-response-key-id']).toBe('1');
    expect(store.creds.get(PROJECT_ID).keyId).toBe(2);

    // New outbound key works; old outbound key still works during the overlap…
    const ev = ex('events.request').events[2];
    const ok2 = await post(EV, eventsBody([ev]), { secret: nextOut, keyId: 2 });
    expect(ok2.statusCode).toBe(200);
    // …and a heartbeat still signed with key 1 (response lost) gets the current pair again.
    const lagNonce = '55555555-6666-4777-8888-999999999999';
    const lag = await post(HS, handshakeBody('heartbeat'), { secret: outbound, keyId: 1, nonce: lagNonce });
    expect(lag.statusCode).toBe(200);
    expect(lag.json().rotate).toEqual({ keyId: 2, inbound: nextIn, outbound: nextOut });
    // Signed with the key generation the site still holds (inbound key 1), so it can verify it.
    expect(
      verifyResponse({
        status: 200,
        path: HS,
        requestNonce: lagNonce,
        body: lag.body,
        headers: lag.headers,
        resolveSecret: (kid) => (kid === '1' ? inbound : null),
        now: nowMs,
      }).ok
    ).toBe(true);

    // After 24 h the previous key is refused.
    nowMs += 86_400_000 + 1000;
    const late = await post(HS, handshakeBody('heartbeat'), { secret: outbound, keyId: 1 });
    expect(late.statusCode).toBe(401);
    expect(late.json().error.code).toBe('UNKNOWN_KEY');
  });

  it('answers 503 NOT_PAIRED for a known site without keys and 401 UNKNOWN_SITE for an unknown one', async () => {
    addProject();
    const r = await post(HS, handshakeBody('heartbeat'), { secret: generateKey(), keyId: 1 });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatchObject({ code: 'NOT_PAIRED', retryable: true });
    const u = await post(HS, handshakeBody('heartbeat'), { secret: generateKey(), keyId: 1, siteId: 'site_unknown00001' });
    expect(u.statusCode).toBe(401);
    expect(u.json().error.code).toBe('UNKNOWN_SITE');
  });
});

describe('POST /events', () => {
  let keys;
  beforeEach(() => {
    addProject();
    keys = pairKeys();
  });
  const send = (events, opts = {}) => post(EV, eventsBody(events), { secret: keys.outbound, keyId: 1, ...opts });

  it('accepts the contract example batch in cursor order and reports lastCursor', async () => {
    const events = ex('events.request').events;
    const res = await send([...events].reverse());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accepted: events.map((e) => e.eventId), duplicate: [], rejected: [], lastCursor: 58 });
    expect(store.applied.map((n) => n.eventType)).toEqual(['pipeline_pm_approved', 'pipeline_sent_to_client']);
    expect(store.applied[0]).toMatchObject({ source: 'EMDASH', wpPipelineId: 42, wpPostId: 118, cms: { seq: 3 } });
    expect(store.contentApplied).toHaveLength(1);
    expect(store.projects.get(PROJECT_ID).cmsLastCursor).toBe(58);
    // seq 3 on a review the OS has never seen (stored 0) is a gap → heal via pipeline-get.
    await new Promise((r) => setImmediate(r));
    expect(onHeal).toHaveBeenCalledWith(PROJECT_ID, ['01JAC7Q2HV5M8N3P4R6S9T0W1X'], expect.anything());
  });

  it('is idempotent on eventId: a re-sent batch is all duplicate and nothing is re-applied', async () => {
    const events = ex('events.request').events;
    await send(events);
    const again = await send(events);
    expect(again.json()).toMatchObject({ accepted: [], duplicate: events.map((e) => e.eventId), rejected: [] });
    expect(store.applied).toHaveLength(2);
  });

  it('ignores stale per-review seq (keeps the receipt) and applies seq = stored + 1 without healing', async () => {
    const [e1, e2] = ex('events.request').events;
    store.reviewSeq.set(e1.review.reviewId, 3);
    const res = await send([e1, e2]);
    expect(res.json().accepted).toEqual([e1.eventId, e2.eventId]);
    expect(store.applied.map((n) => n.cms.seq)).toEqual([4]);
    expect(store.receipts.get(`${PROJECT_ID}:${e1.eventId}`)).toBe('stale');
    await new Promise((r) => setImmediate(r));
    expect(onHeal).not.toHaveBeenCalled();
  });

  it('orders content.* by entry.updatedAt (older → stale)', async () => {
    const ev = ex('events.request').events[2];
    store.entryUpdated.set(ev.entry.entryId, '2026-10-15T13:00:00Z');
    const res = await send([ev]);
    expect(res.json().accepted).toEqual([ev.eventId]);
    expect(store.contentApplied).toHaveLength(0);
    expect(store.receipts.get(`${PROJECT_ID}:${ev.eventId}`)).toBe('stale');
  });

  it('rejects a second snapshotText in one batch as TOO_MANY_SNAPSHOTS (retryable) and stores unknown types', async () => {
    const base = ex('events.request').events[2];
    const second = { ...base, eventId: '01JAC8A0B1C2D3E4F5G6H7J8KC', cursor: 59, snapshotText: 'again' };
    const unknown = { eventId: '01JAC8A0B1C2D3E4F5G6H7J8KD', type: 'seo.check_run', at: '2026-10-15T12:02:00Z', cursor: 60, actor: { kind: 'system', source: 'plugin' }, data: {} };
    const res = await send([base, second, unknown]);
    const json = res.json();
    expect(json.accepted).toEqual([base.eventId, unknown.eventId]);
    expect(json.rejected).toEqual([
      { eventId: second.eventId, code: 'TOO_MANY_SNAPSHOTS', retryable: true, message: 'At most one snapshotText per batch' },
    ]);
    expect(store.receipts.get(`${PROJECT_ID}:${unknown.eventId}`)).toBe('stored');
    expect(json.lastCursor).toBe(60);
  });

  it('rejects an invalid event (VALIDATION, not retryable) and an apply failure (INTERNAL, retryable, receipt released)', async () => {
    const [e1] = ex('events.request').events;
    const bad = { ...e1, eventId: '01JAC8A0B1C2D3E4F5G6H7J8ZZ', cursor: 61, seq: undefined };
    store.failApplyFor = 'pipeline_pm_approved';
    const res = await send([e1, bad]);
    const json = res.json();
    expect(json.accepted).toEqual([]);
    expect(json.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: e1.eventId, code: 'INTERNAL', retryable: true }),
        expect.objectContaining({ eventId: bad.eventId, code: 'VALIDATION', retryable: false }),
      ])
    );
    expect(store.receipts.has(`${PROJECT_ID}:${e1.eventId}`)).toBe(false);
    // lastCursor covers accepted + duplicate only (errata v1.0.1): nothing accepted → 0, not 61.
    expect(json.lastCursor).toBe(0);
  });

  it('bad signature → 401 BAD_SIGNATURE envelope', async () => {
    const res = await send(ex('events.request').events, { secret: generateKey() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: { code: 'BAD_SIGNATURE', message: 'Signature mismatch', retryable: false, details: { stage: 'mismatch' } } });
    expect(store.applied).toHaveLength(0);
  });

  it('stale timestamp → 401 STALE_TIMESTAMP with serverTime', async () => {
    const res = await send(ex('events.request').events, { timestamp: Math.floor(nowMs / 1000) - 301 });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'STALE_TIMESTAMP', details: { serverTime: Math.floor(nowMs / 1000) } });
  });

  it('replayed nonce → 409 REPLAY (stored only after a valid signature)', async () => {
    const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const events = [ex('events.request').events[2]];
    const forged = await send(events, { nonce, secret: generateKey() });
    expect(forged.statusCode).toBe(401);
    const first = await send(events, { nonce });
    expect(first.statusCode).toBe(200);
    const replay = await send(events, { nonce });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('REPLAY');
  });

  it('unknown site → 401 UNKNOWN_SITE', async () => {
    const res = await send(ex('events.request').events, { siteId: 'site_unknown00001' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNKNOWN_SITE');
  });

  it('accepts content.deleted with a reduced entryRef and stores token-free link state (v1.0.1 example)', async () => {
    const events = ex('events.request--deleted').events;
    store.reviewSeq.set(events[0].review.reviewId, 4);
    const res = await send(events);
    expect(res.json()).toMatchObject({ accepted: events.map((e) => e.eventId), rejected: [], lastCursor: 61 });
    expect(store.applied[0].cms.links).toEqual(events[0].review.links);
    expect(store.contentApplied[0].type).toBe('content.deleted');
  });

  it('a body over 1 MiB → 413 PAYLOAD_TOO_LARGE (not retryable) in the contract envelope', async () => {
    const big = eventsBody([{ ...ex('events.request').events[2], snapshotText: 'x'.repeat(1024 * 1024) }]);
    const res = await post(EV, big, { secret: keys.outbound, keyId: 1 });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', retryable: false } });
  });

  it('a query string → 400 VALIDATION; body siteId mismatch → 400', async () => {
    const body = eventsBody(ex('events.request').events);
    const signed = signRequest({ secret: keys.outbound, keyId: 1, siteId: SITE, path: EV, body, timestamp: Math.floor(nowMs / 1000) });
    const q = await app.inject({ method: 'POST', url: `${EV}?x=1`, payload: body, headers: signed });
    expect(q.statusCode).toBe(400);
    expect(q.json().error.code).toBe('VALIDATION');
    const mismatch = await post(EV, JSON.stringify({ contract: 1, siteId: 'site_other00000', sentAt: 'x', events: [] }), {
      secret: keys.outbound,
      keyId: 1,
    });
    expect(mismatch.statusCode).toBe(400);
  });
});

describe('review fixes (S3, S4, S5, S8, S9, v1.0.2 C1)', () => {
  let keys;
  beforeEach(() => {
    addProject();
    keys = pairKeys();
  });
  const send = (events, opts = {}) => post(EV, eventsBody(events), { secret: keys.outbound, keyId: 1, ...opts });

  it('S3: the per-IP flood guard answers 429 RATE_LIMITED (retryable) with Retry-After, not VALIDATION', async () => {
    const rateLimit = (await import('@fastify/rate-limit')).default;
    const limited = Fastify();
    limited.setValidatorCompiler(() => (data) => ({ value: data }));
    await limited.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
    await limited.register(emdashWebhookRoutes, {
      prefix: '/api/webhooks/emdash',
      store,
      now: () => nowMs,
      onHeal,
      routeRateLimit: { max: 1, timeWindow: '1 minute' },
    });
    await limited.ready();
    const body = eventsBody([ex('events.request').events[2]]);
    const mk = () =>
      limited.inject({
        method: 'POST',
        url: EV,
        payload: body,
        headers: signRequest({ secret: keys.outbound, keyId: 1, siteId: SITE, path: EV, body, timestamp: Math.floor(nowMs / 1000) }),
      });
    expect((await mk()).statusCode).toBe(200);
    const second = await mk();
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });

  it('S4: an event still pending on another instance is rejected INTERNAL retryable and kept out of lastCursor', async () => {
    const [e1, e2] = ex('events.request').events;
    store.receipts.set(`${PROJECT_ID}:${e2.eventId}`, 'pending');
    store.reviewSeq.set(e1.review.reviewId, 2);
    const res = await send([e1, e2]);
    const json = res.json();
    expect(json.accepted).toEqual([e1.eventId]);
    expect(json.duplicate).toEqual([]);
    expect(json.rejected).toEqual([{ eventId: e2.eventId, code: 'INTERNAL', retryable: true, message: 'Event is being processed; retry later' }]);
    expect(json.lastCursor).toBe(e1.cursor);
  });

  it('S5: losing the atomic seq claim is recorded as stale, without heal', async () => {
    const [e1] = ex('events.request').events;
    store.staleFor = 'pipeline_pm_approved';
    const res = await send([e1]);
    expect(res.json().accepted).toEqual([e1.eventId]);
    expect(store.receipts.get(`${PROJECT_ID}:${e1.eventId}`)).toBe('stale');
    await new Promise((r) => setImmediate(r));
    expect(onHeal).not.toHaveBeenCalled();
  });

  it('S8: a replayed pairing request gets 401 PAIRING_CODE_INVALID, not 409 REPLAY', async () => {
    store.creds.clear();
    store.projects.get(PROJECT_ID).cmsPairedAt = null;
    const code = addCode();
    const body = handshakeBody('pair', { supportedContracts: [2] }); // 426 after a valid signature: nonce is stored
    const nonce = 'efefefef-0101-4232-8a8a-565656565656';
    const first = await post(HS, body, { secret: pairingSigningKey(code), keyId: 'pairing', nonce });
    expect(first.statusCode).toBe(426);
    const replay = await post(HS, body, { secret: pairingSigningKey(code), keyId: 'pairing', nonce });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('S9: CMS_WEBHOOK_MAX_SKEW_SEC is clamped to 300 s', async () => {
    const saved = process.env.CMS_WEBHOOK_MAX_SKEW_SEC;
    process.env.CMS_WEBHOOK_MAX_SKEW_SEC = '900';
    const other = Fastify();
    other.setValidatorCompiler(() => (data) => ({ value: data }));
    await other.register(emdashWebhookRoutes, { prefix: '/api/webhooks/emdash', store, now: () => nowMs, onHeal });
    await other.ready();
    const body = eventsBody([ex('events.request').events[2]]);
    const r = await other.inject({
      method: 'POST',
      url: EV,
      payload: body,
      headers: signRequest({ secret: keys.outbound, keyId: 1, siteId: SITE, path: EV, body, timestamp: Math.floor(nowMs / 1000) - 600 }),
    });
    if (saved === undefined) delete process.env.CMS_WEBHOOK_MAX_SKEW_SEC;
    else process.env.CMS_WEBHOOK_MAX_SKEW_SEC = saved;
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('STALE_TIMESTAMP');
    await other.close();
  });

  it('v1.0.2 C1: a NEW eventId reusing a stored cursor → whole request 409 COUNTER_REGRESSION, nothing stored, flagged once', async () => {
    const events = ex('events.request').events;
    expect((await send(events)).statusCode).toBe(200);
    const appliedBefore = store.applied.length;
    const imposter = { ...events[2], eventId: '01JAC8A0B1C2D3E4F5G6H7J8ZY', snapshotText: undefined };
    delete imposter.snapshotText;
    const fresh = { ...events[2], eventId: '01JAC8A0B1C2D3E4F5G6H7J8ZX', cursor: 99 };
    delete fresh.snapshotText;
    const r = await send([fresh, imposter]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'COUNTER_REGRESSION', retryable: false });
    expect(store.receipts.has(`${PROJECT_ID}:${fresh.eventId}`)).toBe(false);
    expect(store.applied.length).toBe(appliedBefore);
    expect(store.projects.get(PROJECT_ID).cmsRepairNeededAt).toBeTruthy();
    await send([imposter], {});
    expect(store.repairNotices).toBe(1);
  });

  it('v1.0.2 C1: re-sending known events (replay, outbox retry) is duplicate, never a regression', async () => {
    const events = ex('events.request').events;
    await send(events);
    const again = await send(events);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toEqual(events.map((e) => e.eventId));
    expect(store.projects.get(PROJECT_ID).cmsRepairNeededAt).toBeFalsy();
  });
});

describe('contract v1.0.3 counterFloor', () => {
  it('is sent in the signed pairing response (new-site re-pair) and in heartbeat responses', async () => {
    addProject({ cmsSiteId: 'site_oldsite001' });
    store.counterFloor = { reviewNo: 57, entryNo: 212 };
    const code = addCode(); // code for SITE (a new siteId for this project)
    const nonce = '78787878-1212-4343-8565-909090909090';
    const res = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing', nonce });
    expect(res.statusCode).toBe(200);
    expect(res.json().counterFloor).toEqual({ reviewNo: 57, entryNo: 212 });
    expect(
      verifyResponse({ status: 200, path: HS, requestNonce: nonce, body: res.body, headers: res.headers, resolveSecret: () => pairingSigningKey(code), now: nowMs }).ok
    ).toBe(true);
    expect(store.projects.get(PROJECT_ID).cmsSiteId).toBe(SITE);

    const outbound = res.json().keys.outbound;
    const hb = await post(HS, handshakeBody('heartbeat'), { secret: outbound, keyId: 1 });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().counterFloor).toEqual({ reviewNo: 57, entryNo: 212 });
  });
});

describe('contract v1.0.3 §16(b) re-pair', () => {
  it('a same-siteId re-pair continues key ids (current + 1); the old outbound key stops working', async () => {
    addProject();
    const { outbound: oldOut } = pairKeys();
    const code = addCode();
    const res = await post(HS, handshakeBody('pair'), { secret: pairingSigningKey(code), keyId: 'pairing' });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.keyId).toBe(2);
    const stale = await post(HS, handshakeBody('heartbeat'), { secret: oldOut, keyId: 1 });
    expect(stale.statusCode).toBe(401);
  });
});

describe('contract v1.0.4', () => {
  let keys;
  beforeEach(() => {
    addProject();
    keys = pairKeys();
  });

  it('§17(a): an event stamped for another siteId is rejected VALIDATION (not retryable); none = current site', async () => {
    const [e1] = ex('events.request').events;
    const foreign = { ...e1, siteId: 'site_previous01' };
    const mine = { ...ex('events.request').events[2], siteId: SITE };
    const res = await post(EV, eventsBody([foreign, mine]), { secret: keys.outbound, keyId: 1 });
    const json = res.json();
    expect(json.rejected).toEqual([{ eventId: foreign.eventId, code: 'VALIDATION', retryable: false, message: 'Event belongs to another siteId' }]);
    expect(json.accepted).toEqual([mine.eventId]);
    expect(store.applied).toHaveLength(0);
  });

  it('§17(b): site-initiated disconnect (current key) clears the paired state and answers signed; then /events → 401 UNKNOWN_KEY', async () => {
    const nonce = '13131313-2424-4535-8646-575757575757';
    const body = JSON.stringify({ mode: 'disconnect', siteId: SITE, reason: 'admin clicked Disconnect' });
    const r = await post(HS, body, { secret: keys.outbound, keyId: 1, nonce });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, siteId: SITE, disconnected: true, serverTime: Math.floor(nowMs / 1000) });
    expect(
      verifyResponse({ status: 200, path: HS, requestNonce: nonce, body: r.body, headers: r.headers, resolveSecret: (k) => (k === '1' ? keys.inbound : null), now: nowMs }).ok
    ).toBe(true);
    expect(store.disconnects).toBe(1);
    const after = await post(EV, eventsBody([ex('events.request').events[2]]), { secret: keys.outbound, keyId: 1 });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('UNKNOWN_KEY');
  });

  it('§17(b): a disconnect signed with a previous key id is 401 UNKNOWN_KEY', async () => {
    const cred = store.creds.get(PROJECT_ID);
    Object.assign(cred, {
      keyId: 2,
      prevKeyId: 1,
      inboundKeyPrevEnc: cred.inboundKeyEnc,
      outboundKeyPrevEnc: cred.outboundKeyEnc,
      prevExpiresAt: new Date(nowMs + 3600_000),
    });
    const body = JSON.stringify({ mode: 'disconnect', siteId: SITE });
    const r = await post(HS, body, { secret: keys.outbound, keyId: 1 });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNKNOWN_KEY');
    expect(store.disconnects || 0).toBe(0);
  });

  it('§17(b): a site whose first pairing never completed still gets 503 NOT_PAIRED', async () => {
    store.creds.clear();
    const r = await post(EV, eventsBody([ex('events.request').events[2]]), { secret: keys.outbound, keyId: 1 });
    expect(r.statusCode).toBe(503);
  });
});

describe('contract v1.0.5: Review inside an event envelope', () => {
  it('an event whose Review belongs to another siteId is rejected (never applied)', async () => {
    addProject();
    const keys = pairKeys();
    const [e1] = ex('events.request').events;
    const ev = { ...e1, review: { ...e1.review, siteId: 'site_previous01' } };
    const res = await post(EV, eventsBody([ev]), { secret: keys.outbound, keyId: 1 });
    expect(res.json().rejected).toEqual([{ eventId: ev.eventId, code: 'VALIDATION', retryable: false, message: 'Review belongs to another siteId' }]);
    expect(store.applied).toHaveLength(0);
    const ok = { ...e1, review: { ...e1.review, siteId: SITE } };
    expect((await post(EV, eventsBody([ok]), { secret: keys.outbound, keyId: 1 })).json().accepted).toEqual([e1.eventId]);
  });
});
