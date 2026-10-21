/**
 * Review S2/S7 + contract v1.0.2 C2: private-address guard, connect-time lookup refusal,
 * no redirect following, no signing with an empty key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { isPrivateIp, guardedLookup, guardedFetch, validateSiteUrl, ipLiteralOf, blockedIpLiteral } from '../../../src/lib/siteAdapters/netGuard.js';
import { siteRequest } from '../../../src/lib/siteAdapters/emdash.js';
import { computeSignature, signResponse, errorBody } from '../../../src/lib/siteAdapters/signing.js';

const ORIGINAL_ENV = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
  delete process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV;
});

describe('isPrivateIp', () => {
  it.each([
    '0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.8', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:A9FE:A9FE', '64:ff9b::a9fe:a9fe', 'fec0::1', 'fd12::1',
    'fe80::1', 'ff02::1', '[::1]', 'localhost', '',
  ])('blocks %s', (a) => {
    expect(isPrivateIp(a)).toBe(true);
  });
  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888'])('allows public %s', (a) => {
    expect(isPrivateIp(a)).toBe(false);
  });
});

describe('validateSiteUrl (pairing + cmsType switch)', () => {
  it('refuses private resolutions and IP literals in production', async () => {
    const env = { NODE_ENV: 'production' };
    expect((await validateSiteUrl('https://rebind.example', { env, lookup: async () => [{ address: '::ffff:10.0.0.1' }] })).ok).toBe(false);
    expect((await validateSiteUrl('https://169.254.169.254', { env, lookup: async () => [{ address: '169.254.169.254' }] })).ok).toBe(false);
    expect((await validateSiteUrl('https://ex.com', { env, lookup: async () => [{ address: '93.184.216.34' }] })).ok).toBe(true);
  });
});

describe('guardedLookup (connect time, DNS rebinding)', () => {
  const lookupErr = () => new Promise((resolve) => guardedLookup('localhost', {}, (e) => resolve(e || null)));
  it('dev without EMDASH_BRIDGE_ALLOW_INSECURE_DEV behaves like production: private refused', async () => {
    process.env.NODE_ENV = 'development';
    expect((await lookupErr())?.code).toBe('EAI_BLOCKED');
  });
  it('dev with the flag allows loopback', async () => {
    process.env.NODE_ENV = 'development';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true';
    expect(await lookupErr()).toBeNull();
  });
  it('production ignores the flag', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true';
    expect((await lookupErr())?.code).toBe('EAI_BLOCKED');
    await expect(guardedFetch('http://localhost:1/x', { method: 'POST', body: '{}' })).rejects.toThrow(/https/);
  });
});

describe('IP-literal hosts (Node skips lookup for them)', () => {
  it('the URL parser normalizes decimal / hex / octal / short IPv4 forms to dotted', () => {
    for (const s of ['https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://127.1/']) {
      expect(ipLiteralOf(new URL(s).hostname)).toBe('127.0.0.1');
    }
    expect(ipLiteralOf(new URL('https://[::1]/').hostname)).toBe('::1');
    expect(ipLiteralOf('example.com')).toBeNull();
  });

  it.each([
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.1.2.3/x',
    'https://0x7f000001/x', 'https://2130706433/x', 'https://[::ffff:127.0.0.1]/x', 'https://192.168.1.1:8443/x',
  ])('guardedFetch refuses %s before connecting', async (url) => {
    process.env.NODE_ENV = 'production';
    await expect(guardedFetch(url, { method: 'GET' })).rejects.toMatchObject({ code: 'EAI_BLOCKED' });
  });

  it('a public IP literal passes the check; the dev opt-in still allows loopback', () => {
    process.env.NODE_ENV = 'production';
    expect(blockedIpLiteral(new URL('https://93.184.216.34/x'))).toBeNull();
    expect(blockedIpLiteral(new URL('https://[2606:4700::1111]/x'))).toBeNull();
    expect(blockedIpLiteral(new URL('https://example.com/x'))).toBeNull(); // host names go through guardedLookup
    expect(blockedIpLiteral(new URL('https://127.0.0.1/x'))).toMatchObject({ code: 'EAI_BLOCKED' });
    process.env.NODE_ENV = 'test';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true';
    expect(blockedIpLiteral(new URL('https://127.0.0.1/x'))).toBeNull();
  });
});

describe('no redirects (v1.0.2 C2)', () => {
  it('guardedFetch returns the 3xx instead of following it, and siteRequest turns it into UPSTREAM_UNAVAILABLE (final)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true'; // local http test server
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const res = await guardedFetch(`http://localhost:${port}/x`, { method: 'POST', body: '{}', headers: {} });
      expect(res.status).toBe(302);
      const conn = { siteUrl: `http://localhost:${port}`, siteId: 'site_abcdefgh', inbound: { current: { id: 1, secret: 'aosk1_test' }, prev: null } };
      await expect(siteRequest(conn, 'health', {}, { retryDelays: [1, 1], sleep: async () => {} })).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: false,
        details: { redirect: true },
      });
      expect(hits).toBe(2); // one guardedFetch above + one siteRequest attempt, no retries
    } finally {
      server.close();
    }
  });
});

describe('signing hardening', () => {
  it('S7: refuses to sign with a missing or empty key', () => {
    expect(() => computeSignature('', 'x')).toThrow(/empty key/);
    expect(() => computeSignature(undefined, 'x')).toThrow(/empty key/);
    expect(() => signResponse({ secret: '', keyId: 1, status: 200, path: '/a', requestNonce: 'n', body: '' })).toThrow();
  });
  it('v1.0.2: COUNTER_REGRESSION is 409 and not retryable', () => {
    expect(errorBody('COUNTER_REGRESSION', 'x')).toEqual({
      status: 409,
      body: { ok: false, error: { code: 'COUNTER_REGRESSION', message: 'x', retryable: false } },
    });
  });
});

describe('response size cap (review MEDIUM-5)', () => {
  it('guardedFetch caps at 8 MiB by default and at init.maxBytes when given (RESPONSE_TOO_LARGE)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true'; // local http test server
    const nine = Buffer.alloc(9 * 1024 * 1024, 1);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(nine);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      await expect(guardedFetch(`http://localhost:${port}/x`)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      const res = await guardedFetch(`http://localhost:${port}/x`, { maxBytes: 10 * 1024 * 1024 + 1 });
      expect(Buffer.from(await res.arrayBuffer()).length).toBe(nine.length);
      await expect(guardedFetch(`http://localhost:${port}/x`, { maxBytes: 1024 })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    } finally {
      server.close();
    }
  });
});
