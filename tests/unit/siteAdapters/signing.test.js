/**
 * EmDash bridge HMAC (contract agency-os-bridge/v1 §3). Reproduces EVERY vector in
 * tests/fixtures/cms-contract/vectors/signature-vectors.json (copied from oasis-astro
 * packages/os-bridge-contract @ 2748a59) plus the verification order of §3.2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  canonicalString,
  computeSignature,
  createPairingCode,
  generateKey,
  generateSiteId,
  negotiateContract,
  pairingSigningKey,
  pairingVerifier,
  parsePairingCode,
  resolveKey,
  responseCanonicalString,
  sha256Hex,
  signRequest,
  signResponse,
  signedPathFor,
  verifyRequest,
  verifyResponse,
  NOT_PAIRED,
} from '../../../src/lib/siteAdapters/signing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(path.join(here, '../../fixtures/cms-contract/vectors/signature-vectors.json'), 'utf8')
);
const K = vectors.keys;
const SECRET_BY_LABEL = {
  'inbound key 1': K.inbound1,
  'outbound key 1': K.outbound1,
  'inbound key 2': K.inbound2,
  'pairing signing key': K.pairingSigningKey,
};

function memoryNonceCache() {
  const seen = new Map();
  return {
    async checkAndStore(key, exp) {
      // Vector timestamps are fixed in the past: expiry is not modelled here (no wall-clock time bomb).
      if (seen.has(key)) return false;
      seen.set(key, exp);
      return true;
    },
  };
}

describe('contract §3.5 signature vectors', () => {
  it('has the 8 request and 3 response vectors listed in contract.md (v1.0.3 adds counterFloor)', () => {
    // v1.0.4 disconnect, v1.1.0 pipeline-client-review, v1.2.0 media-import, v1.3.0 pipeline-publish,
    // v1.4.0 proposal-create, v1.5.0 migration-map, v1.5.1 entry-get includeLayout (15), v1.5.2 profile-upsert (16)
    expect(vectors.requests).toHaveLength(16);
    expect(vectors.responses).toHaveLength(3);
    expect(vectors.responses.some((r) => r.body.includes('"counterFloor"'))).toBe(true);
  });

  it.each(vectors.requests.map((v) => [v.name, v]))('request vector: %s', (_name, v) => {
    const secret = SECRET_BY_LABEL[v.secret];
    expect(secret).toBeTruthy();
    expect(sha256Hex(v.body)).toBe(v.bodySha256);
    const canonical = canonicalString({
      method: v.method,
      path: v.path,
      timestamp: v.headers['x-aos-timestamp'],
      nonce: v.headers['x-aos-nonce'],
      body: v.body,
    });
    expect(canonical).toBe(v.canonical);
    expect(`v1=${computeSignature(secret, canonical)}`).toBe(v.headers['x-aos-signature']);

    const headers = signRequest({
      secret,
      keyId: v.headers['x-aos-key-id'],
      siteId: v.headers['x-aos-site'],
      method: v.method,
      path: v.path,
      body: v.body,
      timestamp: Number(v.headers['x-aos-timestamp']),
      nonce: v.headers['x-aos-nonce'],
      idempotencyKey: v.headers['x-aos-idempotency-key'],
    });
    for (const [k, val] of Object.entries(v.headers)) expect(headers[k]).toBe(val);
  });

  it('signs the UTF-8 bytes of the body (Café vector) identically for string and Buffer input', () => {
    const v = vectors.requests[1];
    expect(Buffer.from(v.body, 'utf8').includes(Buffer.from([0x43, 0x61, 0x66, 0xc3, 0xa9]))).toBe(true);
    expect(sha256Hex(Buffer.from(v.body, 'utf8'))).toBe(v.bodySha256);
  });

  it('empty body hashes as sha256("")', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it.each(vectors.responses.map((v) => [v.name, v]))('response vector: %s', (_name, v) => {
    const secret = SECRET_BY_LABEL[v.secret];
    expect(sha256Hex(v.body)).toBe(v.bodySha256);
    const ts = v.headers['x-aos-response-timestamp'];
    expect(
      responseCanonicalString({ status: v.status, path: v.requestPath, requestNonce: v.requestNonce, timestamp: ts, body: v.body })
    ).toBe(v.canonical);
    const headers = signResponse({
      secret,
      keyId: v.headers['x-aos-response-key-id'],
      status: v.status,
      path: v.requestPath,
      requestNonce: v.requestNonce,
      body: v.body,
      timestamp: Number(ts),
    });
    expect(headers).toEqual(v.headers);
    const ok = verifyResponse({
      status: v.status,
      path: v.requestPath,
      requestNonce: v.requestNonce,
      body: v.body,
      headers: v.headers,
      resolveSecret: () => secret,
      now: Number(ts) * 1000,
    });
    expect(ok.ok).toBe(true);
    const wrongNonce = verifyResponse({
      status: v.status,
      path: v.requestPath,
      requestNonce: 'ffffffff-4444-4555-8666-777777777777',
      body: v.body,
      headers: v.headers,
      resolveSecret: () => secret,
      now: Number(ts) * 1000,
    });
    expect(wrongNonce.ok).toBe(false);
  });

  it('derives the pairing signing key and verifier from the code (§4.1)', () => {
    expect(pairingSigningKey(K.pairingCode)).toBe(K.pairingSigningKey);
    expect(pairingVerifier(K.pairingCode)).toBe(K.pairingVerifier);
    expect(parsePairingCode(K.pairingCode)).toEqual({ siteId: K.siteId, code: K.pairingCode });
    // Neither value equals or contains the other; the verifier is never an HMAC key.
    expect(K.pairingSigningKey).not.toBe(K.pairingVerifier);
  });
});

describe('key and code generation', () => {
  it('generates aosk1_ keys of 49 chars, OS site ids and parseable pairing codes', () => {
    const key = generateKey();
    expect(key).toMatch(/^aosk1_[A-Za-z0-9_-]{43}$/);
    const siteId = generateSiteId();
    expect(siteId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const code = createPairingCode(siteId);
    expect(parsePairingCode(code)?.siteId).toBe(siteId);
    expect(parsePairingCode('aos1.short.x')).toBeNull();
  });

  it('keeps the request path verbatim (percent-encoding, trailing slash) and refuses queries', () => {
    expect(signedPathFor('https://ex.com/staging%20site/_emdash/api/plugins/agency-os-bridge/site-info')).toBe(
      '/staging%20site/_emdash/api/plugins/agency-os-bridge/site-info'
    );
    expect(() => signedPathFor('https://ex.com/a?b=1')).toThrow();
    expect(() => canonicalString({ method: 'POST', path: '/a?b=1', timestamp: 1, nonce: 'n', body: '' })).toThrow();
  });

  it('negotiates the highest common contract', () => {
    expect(negotiateContract([1])).toBe(1);
    expect(negotiateContract([2, 3])).toBeNull();
    expect(negotiateContract(undefined)).toBeNull();
  });

  it('resolveKey accepts current and an unexpired prev key only', () => {
    const now = 1_000_000;
    const ring = { current: { id: 2, secret: 'b' }, prev: { id: 1, secret: 'a', expiresAt: now + 10 } };
    expect(resolveKey(ring, '2', now)).toBe('b');
    expect(resolveKey(ring, 1, now)).toBe('a');
    expect(resolveKey(ring, 1, now + 11)).toBeNull();
    expect(resolveKey(ring, 3, now)).toBeNull();
  });
});

describe('verifyRequest (contract §3.2 order)', () => {
  const v = vectors.requests[1]; // site → OS events, outbound key 1
  const nowMs = Number(v.headers['x-aos-timestamp']) * 1000;
  const resolveSecret = async (siteId, keyId) => {
    if (siteId !== K.siteId) return undefined;
    return keyId === '1' ? K.outbound1 : null;
  };
  const base = () => ({
    method: 'POST',
    path: v.path,
    body: v.body,
    headers: { ...v.headers },
    resolveSecret,
    nonceCache: memoryNonceCache(),
    now: nowMs,
  });

  it('accepts the vector and returns site, key id and nonce', async () => {
    const r = await verifyRequest(base());
    expect(r).toMatchObject({ ok: true, siteId: K.siteId, keyId: '1', contract: 1 });
  });

  it('missing headers → 401 BAD_SIGNATURE with details.missing', async () => {
    const p = base();
    delete p.headers['x-aos-nonce'];
    const r = await verifyRequest(p);
    expect(r).toMatchObject({ ok: false, status: 401, code: 'BAD_SIGNATURE' });
    expect(r.details.missing).toContain('x-aos-nonce');
  });

  it('query string → 400 VALIDATION', async () => {
    const r = await verifyRequest({ ...base(), path: `${v.path}?x=1` });
    expect(r).toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('unsupported contract → 426 with details.supported', async () => {
    const p = base();
    p.headers['x-aos-contract'] = '2';
    const r = await verifyRequest(p);
    expect(r).toMatchObject({ status: 426, code: 'CONTRACT_UNSUPPORTED', details: { supported: [1] } });
  });

  it('unknown site / unknown key / not paired', async () => {
    const p1 = base();
    p1.headers['x-aos-site'] = 'site_unknown0001';
    expect(await verifyRequest(p1)).toMatchObject({ status: 401, code: 'UNKNOWN_SITE' });
    const p2 = base();
    p2.headers['x-aos-key-id'] = '7';
    expect(await verifyRequest(p2)).toMatchObject({ status: 401, code: 'UNKNOWN_KEY' });
    expect(await verifyRequest({ ...base(), resolveSecret: async () => NOT_PAIRED })).toMatchObject({
      status: 503,
      code: 'NOT_PAIRED',
    });
  });

  it('stale timestamp (> 300 s) → 401 STALE_TIMESTAMP with serverTime', async () => {
    const r = await verifyRequest({ ...base(), now: nowMs + 301_000 });
    expect(r).toMatchObject({ status: 401, code: 'STALE_TIMESTAMP' });
    expect(r.details.serverTime).toBe(Math.floor((nowMs + 301_000) / 1000));
    expect((await verifyRequest({ ...base(), now: nowMs + 299_000 })).ok).toBe(true);
  });

  it('tampered body or path → 401 BAD_SIGNATURE (no normalisation: trailing slash differs)', async () => {
    expect(await verifyRequest({ ...base(), body: v.body.replace('Café', 'Cafe') })).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(await verifyRequest({ ...base(), path: `${v.path}/` })).toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  it('replayed nonce → 409 REPLAY; a forged request does not burn the nonce', async () => {
    const cache = memoryNonceCache();
    const forged = { ...base(), nonceCache: cache, body: `${v.body} ` };
    expect((await verifyRequest(forged)).code).toBe('BAD_SIGNATURE');
    expect((await verifyRequest({ ...base(), nonceCache: cache })).ok).toBe(true);
    expect(await verifyRequest({ ...base(), nonceCache: cache })).toMatchObject({ status: 409, code: 'REPLAY' });
  });
});

describe('v1.5.4: site revision gate', () => {
  it('revisionAtLeast compares numerically per part; missing / malformed is below everything', async () => {
    const { revisionAtLeast, CONTRACT_REVISION } = await import('../../../src/lib/siteAdapters/signing.js');
    expect(CONTRACT_REVISION).toBe('1.9.1');
    expect(revisionAtLeast('1.5.4', '1.5.4')).toBe(true);
    expect(revisionAtLeast('1.5.10', '1.5.4')).toBe(true);
    expect(revisionAtLeast('1.6', '1.5.4')).toBe(true);
    expect(revisionAtLeast('1.5.3', '1.5.4')).toBe(false);
    expect(revisionAtLeast(null, '1.5.4')).toBe(false);
    expect(revisionAtLeast('1.5.x', '1.5.4')).toBe(false);
  });

  it('v1.5.4 error code SERVICE_ROLE_INSUFFICIENT is a contract error (403, not retryable)', async () => {
    const { ERROR_CODES } = await import('../../../src/lib/siteAdapters/signing.js');
    expect(ERROR_CODES.SERVICE_ROLE_INSUFFICIENT).toEqual({ status: 403, retryable: false });
  });
});
