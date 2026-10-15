/**
 * /api/projects/:id/cms/* (pairing code shown once, key rotation staging, health) with a
 * Prisma stand-in, plus the site URL validation used before any OS → site call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, user: null }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'updateMany') return Promise.resolve({ count: 1 });
          if (method === 'findMany') return Promise.resolve([]);
          return Promise.resolve(null);
        };
      },
    });
  const prisma = new Proxy({ $transaction: async (ops) => Promise.all(ops) }, {
    get: (t, n) => (n in t ? t[n] : model(String(n))),
  });
  return { prisma };
});
vi.mock('../../../src/lib/ensureProjectAccess.js', () => ({
  ensureProjectAccess: async (project, user) => user.role === 'OWNER' || project.leadPmId === user.id,
}));

import { projectCmsRoutes, validateSiteUrl } from '../../../src/routes/projectCms.js';
import { parsePairingCode, pairingVerifier, pairingSigningKey } from '../../../src/lib/siteAdapters/signing.js';
import { decryptCmsSecret, cmsAad } from '../../../src/lib/cmsKeyCrypto.js';

let app;
const PID = '7d0c6c55-1111-4222-8333-944444444444';
const project = (o = {}) => ({ id: PID, name: 'Oasis', leadPmId: 'pm-1', clientId: 'c1', cmsType: 'EMDASH', wpUrl: 'https://oasispoolspas.com', cmsSiteId: null, ...o });

beforeAll(async () => {
  process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
  // Route tests use example hosts without real DNS: opt into the dev mode (validated separately below).
  process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true';
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.decorate('verifyJwt', async (request) => {
    request.user = db.user;
  });
  app.decorate('requireOwner', async (request, reply) => {
    if (request.user?.role !== 'OWNER') return reply.status(403).send({ message: 'Owner access required' });
  });
  await app.register(projectCmsRoutes, { prefix: '/api/projects' });
  await app.ready();
});
afterAll(async () => {
  delete process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV;
  await app.close();
});
beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  db.user = { id: 'owner-1', role: 'OWNER', name: 'Owner' };
});

describe('validateSiteUrl', () => {
  it('requires https, allows http://localhost outside production, strips trailing slash', async () => {
    const dev = { NODE_ENV: 'development', EMDASH_BRIDGE_ALLOW_INSECURE_DEV: 'true' };
    const publicDns = async () => [{ address: '93.184.216.34' }];
    expect(await validateSiteUrl('https://ex.com/', { env: {}, lookup: publicDns })).toEqual({ ok: true, url: 'https://ex.com' });
    expect((await validateSiteUrl('http://ex.com', { env: dev })).ok).toBe(false);
    // http://localhost only with the explicit dev opt-in, never in production (even with the flag).
    expect((await validateSiteUrl('http://localhost:4321', { env: dev })).ok).toBe(true);
    expect((await validateSiteUrl('http://localhost:4321', { env: { NODE_ENV: 'development' } })).ok).toBe(false);
    expect((await validateSiteUrl('http://localhost:4321', { env: { NODE_ENV: 'production', EMDASH_BRIDGE_ALLOW_INSECURE_DEV: 'true' } })).ok).toBe(false);
    expect((await validateSiteUrl('https://ex.com/?a=1', { env: dev })).ok).toBe(false);
    expect((await validateSiteUrl('not a url', { env: dev })).ok).toBe(false);
  });

  it('in production refuses hosts that resolve to private addresses', async () => {
    const env = { NODE_ENV: 'production' };
    expect((await validateSiteUrl('https://intranet.ex', { env, lookup: async () => [{ address: '10.0.0.5' }] })).ok).toBe(false);
    expect((await validateSiteUrl('https://ex.com', { env, lookup: async () => [{ address: '93.184.216.34' }] })).ok).toBe(true);
  });
});

describe('POST /:id/cms/pairing-code', () => {
  it('returns the code once and stores only the verifier + the encrypted signing key', async () => {
    db.overrides['project.findUnique'] = async () => project();
    const res = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { code, siteId, expiresAt } = res.json();
    expect(parsePairingCode(code)?.siteId).toBe(siteId);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);

    const created = db.calls.find((c) => c.key === 'cmsPairingCode.create').args.data;
    expect(created.verifier).toBe(pairingVerifier(code));
    expect(JSON.stringify(created)).not.toContain(code);
    expect(decryptCmsSecret(created.signingKeyEnc, cmsAad(PID, 'pairing'))).toBe(pairingSigningKey(code));
    // Earlier unused codes for the project are burned (signing key deleted).
    const burn = db.calls.find((c) => c.key === 'cmsPairingCode.updateMany').args;
    expect(burn).toMatchObject({ where: { projectId: PID, usedAt: null, burnedAt: null }, data: { signingKeyEnc: null } });
    // Review S11: the URL/siteId are stored on the code and applied only when pairing completes.
    expect(db.calls.find((c) => c.key === 'project.update')).toBeUndefined();
    expect(created).toMatchObject({ siteId, siteUrl: 'https://oasispoolspas.com' });
  });

  it('keeps an existing siteId, refuses WordPress projects, other PMs and CLIENTs', async () => {
    db.overrides['project.findUnique'] = async () => project({ cmsSiteId: 'site_existing01' });
    const res = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} });
    expect(res.json()).toMatchObject({ siteId: 'site_existing01', newSite: false });
    // v1.0.2 C1: only an explicit newSite mints a new siteId (site lost its storage).
    const fresh = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: { newSite: true } });
    expect(fresh.json().siteId).not.toBe('site_existing01');
    expect(fresh.json().newSite).toBe(true);

    db.overrides['project.findUnique'] = async () => project({ cmsType: 'WORDPRESS' });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} })).statusCode).toBe(400);

    db.overrides['project.findUnique'] = async () => project();
    db.user = { id: 'pm-2', role: 'PM' };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} })).statusCode).toBe(403);
    db.user = { id: 'cl-1', role: 'CLIENT' };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} })).statusCode).toBe(403);
    db.user = { id: 'pm-1', role: 'PM' };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} })).statusCode).toBe(200);
  });

  it('fails closed without CMS_KEY_ENCRYPTION_KEY and rejects a non-https site URL', async () => {
    db.overrides['project.findUnique'] = async () => project();
    const saved = process.env.CMS_KEY_ENCRYPTION_KEY;
    delete process.env.CMS_KEY_ENCRYPTION_KEY;
    const r = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: {} });
    process.env.CMS_KEY_ENCRYPTION_KEY = saved;
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('CMS_KEY_ENCRYPTION_KEY_MISSING');
    const h = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/pairing-code`, payload: { siteUrl: 'http://oasis.example' } });
    expect(h.statusCode).toBe(400);
  });
});

describe('rotate-keys and health', () => {
  it('stages the next key id with encrypted keys', async () => {
    db.overrides['project.findUnique'] = async () => project({ cmsSiteId: 'site_existing01' });
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 3, pendingKeyId: null });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/rotate-keys` });
    expect(r.json()).toMatchObject({ success: true, currentKeyId: 3, pendingKeyId: 4 });
    const data = db.calls.find((c) => c.key === 'cmsCredential.updateMany').args.data;
    expect(decryptCmsSecret(data.inboundKeyPendingEnc, cmsAad(PID, 'inbound'))).toMatch(/^aosk1_/);
    expect(decryptCmsSecret(data.outboundKeyPendingEnc, cmsAad(PID, 'outbound'))).toMatch(/^aosk1_/);
  });

  it('reports stored health without secrets', async () => {
    db.overrides['project.findUnique'] = async () =>
      project({ cmsSiteId: 'site_existing01', cmsPairedAt: new Date(), cmsLastSeenAt: new Date(Date.now() - 25 * 3600e3), cmsContractVersion: 1, cmsPluginVersion: '1.0.0', cmsHealth: { outbox: { pending: 0, failed: 0 } } });
    db.overrides['cmsCredential.findUnique'] = async () => ({ keyId: 1, pendingKeyId: null, prevKeyId: null, prevExpiresAt: null, rotatedAt: null });
    const r = await app.inject({ method: 'GET', url: `/api/projects/${PID}/cms/health` });
    const body = r.json();
    expect(body).toMatchObject({ paired: true, stale: true, keyId: 1, contractSupported: true, pluginVersion: '1.0.0', encryptionConfigured: true });
    expect(JSON.stringify(body)).not.toMatch(/Enc|aosk1_/);
  });
});

describe('POST /:id/cms/disconnect (e2e OS issue 4)', () => {
  it('is OWNER only, deletes the credential, clears the paired state and burns open codes', async () => {
    db.overrides['project.findUnique'] = async () => ({ id: PID, cmsType: 'EMDASH' });
    db.user = { id: 'pm-1', role: 'PM' };
    expect((await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/disconnect` })).statusCode).toBe(403);
    db.user = { id: 'owner-1', role: 'OWNER' };
    const r = await app.inject({ method: 'POST', url: `/api/projects/${PID}/cms/disconnect` });
    expect(r.statusCode).toBe(200);
    expect(db.calls.find((c) => c.key === 'cmsCredential.deleteMany').args).toEqual({ where: { projectId: PID } });
    const upd = db.calls.find((c) => c.key === 'project.update').args.data;
    expect(upd).toMatchObject({ cmsPairedAt: null, cmsKeyId: null, cmsRepairNeededAt: null });
    expect(upd.cmsDisconnectedAt).toBeInstanceOf(Date);
    expect(upd).not.toHaveProperty('cmsSiteId'); // a later re-pair reuses the siteId
    expect(db.calls.find((c) => c.key === 'cmsPairingCode.updateMany').args.data).toMatchObject({ signingKeyEnc: null });
  });
});
