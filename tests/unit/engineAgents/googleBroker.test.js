/**
 * SEO Engine Google routes: binding export (OS-15) and short-lived access-token broker (OS-16).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
          if (method === 'create') return { id: 'r1', ...(args?.data || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/analytics/tokenCrypto.js', () => ({ decryptSecret: () => 'REFRESH-TOKEN-SECRET', encryptSecret: (s) => s }));
vi.mock('../../../src/lib/analytics/googleAuth.js', () => ({ markAgencyGoogleError: vi.fn(async () => {}) }));

const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { registerApiTokenHooks, generateApiToken, hashApiToken } = await import('../../../src/lib/apiTokens.js');
const { engineRoutes } = await import('../../../src/routes/engine.js');
const { mintDownscopedAccessToken, BROKER_PRODUCTS, takeBrokerSlot } = await import('../../../src/lib/googleBroker.js');

const SECRET = process.env.JWT_ACCESS_SECRET;
const ENGINE = { id: 'u-engine', email: 'e@x', role: 'PM', name: 'Engine', isActive: true, tokenVersion: 0, isAgent: true };
const HUMAN_PM = { ...ENGINE, id: 'u-pm', isAgent: false };
const WORKER = { ...ENGINE, id: 'u-worker', role: 'TEAM_MEMBER' };
const USERS = { [ENGINE.id]: ENGINE, [HUMAN_PM.id]: HUMAN_PM, [WORKER.id]: WORKER };
const PROJECT = {
  id: 'p-1', name: 'Milwaukee Signs', clientId: 'c-1', leadPmId: ENGINE.id,
  gscSiteUrl: 'sc-domain:milwaukeesigns.com', gscLastSyncedAt: new Date('2026-10-18T05:00:00Z'),
  ga4PropertyId: 'properties/123', ga4PropertyName: 'MS', ga4LastSyncedAt: null,
  gmbAccountId: null, gmbLocationId: null, gmbLocationName: null, gmbLastSyncedAt: null,
};

const tokens = new Map();
function issue(user, extra = {}) {
  const raw = generateApiToken();
  tokens.set(hashApiToken(raw), { id: `tok-${tokens.size + 1}`, userId: user.id, name: 't', tokenHash: hashApiToken(raw), scopes: null, projectIds: null, userTokenVersion: 0, expiresAt: new Date(Date.now() + 1e8), lastUsedAt: new Date(), revokedAt: null, ...extra });
  return raw;
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

async function buildApp({ enabled = true, mint } = {}) {
  const app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  registerApiTokenHooks(app);
  app.decorate('verifyJwt', verifyJwt);
  app.register(engineRoutes, { env: { ENGINE_GOOGLE_TOKEN_BROKER_ENABLED: enabled ? '1' : '' }, mint: mint || (async (scope) => ({ accessToken: 'ya29.short-lived', expiresAt: new Date(Date.now() + 3599000), scope })) });
  await app.ready();
  return app;
}

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'apiToken.findUnique': async ({ where }) => {
      const row = tokens.get(where.tokenHash);
      return row ? { ...row, user: { ...USERS[row.userId] } } : null;
    },
    'user.findUnique': async ({ where }) => (USERS[where.id] ? { ...USERS[where.id] } : null),
    'project.findUnique': async ({ where }) => (where.id === PROJECT.id ? { ...PROJECT } : null),
    'agencyGoogleConnection.findFirst': async () => ({ id: 'g1', lastError: null, refreshTokenEnc: 'enc' }),
  };
});

describe('binding export (OS-15)', () => {
  it('returns gscSiteUrl, ga4PropertyId, gbpLocationId and link status to the project PM', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/p-1/google-bindings', headers: bearer(jwt.sign({ sub: ENGINE.id, role: 'PM' }, SECRET)) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      projectId: 'p-1', gscSiteUrl: 'sc-domain:milwaukeesigns.com', ga4PropertyId: 'properties/123', gbpLocationId: null,
      linkStatus: { gsc: 'LINKED', ga4: 'LINKED_NOT_SYNCED', gbp: 'NOT_LINKED' }, suggestedTrack: 'running',
      agencyGoogle: { connected: true, hasError: false },
    });
    expect(res.body).not.toContain('refreshTokenEnc');
    await app.close();
  });

  it('API tokens need the explicit bindings:read scope; workers and other PMs are refused', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/projects/p-1/google-bindings', headers: bearer(issue(ENGINE)) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/projects/p-1/google-bindings', headers: bearer(issue(ENGINE, { scopes: ['bindings:read'] })) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/projects/p-1/google-bindings', headers: bearer(issue(WORKER, { scopes: ['bindings:read'] })) })).statusCode).toBe(403);
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: null, secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/projects/p-1/google-bindings', headers: bearer(jwt.sign({ sub: HUMAN_PM.id, role: 'PM' }, SECRET)) })).statusCode).toBe(403);
    await app.close();
  });
});

describe('token broker (OS-16)', () => {
  const engineToken = (extra = {}) => issue(ENGINE, { scopes: ['google:token'], projectIds: ['p-1'], ...extra });

  it('issues a no-store, single-scope token for one bound project and audits it without the token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/engine/google/token', headers: bearer(engineToken()), payload: { projectId: 'p-1', product: 'gsc' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ accessToken: 'ya29.short-lived', tokenType: 'Bearer', scope: BROKER_PRODUCTS.gsc.scope, projectId: 'p-1', property: PROJECT.gscSiteUrl });
    expect(JSON.stringify(body)).not.toContain('REFRESH-TOKEN-SECRET');
    const audit = db.calls.find((c) => c.key === 'googleTokenIssuance.create').args.data;
    expect(audit).toMatchObject({ projectId: 'p-1', product: 'gsc', property: PROJECT.gscSiteUrl, userId: ENGINE.id });
    expect(JSON.stringify(audit)).not.toContain('ya29');
    await app.close();
  });

  it('refuses JWT sessions, tokens without the scope or allowlist, non-agent PMs, other projects and GBP', async () => {
    const app = await buildApp();
    const post = (headers, payload = { projectId: 'p-1', product: 'gsc' }) => app.inject({ method: 'POST', url: '/api/engine/google/token', headers, payload });
    expect((await post(bearer(jwt.sign({ sub: ENGINE.id, role: 'PM' }, SECRET)))).statusCode).toBe(403);
    expect((await post(bearer(issue(ENGINE, { projectIds: ['p-1'] })))).statusCode).toBe(403);
    expect((await post(bearer(issue(ENGINE, { scopes: ['google:token'] })))).statusCode).toBe(403);
    expect((await post(bearer(issue(HUMAN_PM, { scopes: ['google:token'], projectIds: ['p-1'] })))).statusCode).toBe(403);
    expect((await post(bearer(engineToken()), { projectId: 'p-2', product: 'gsc' })).statusCode).toBe(403);
    expect((await post(bearer(engineToken()), { projectId: 'p-1', product: 'gbp' })).statusCode).toBe(400);
    expect(db.calls.some((c) => c.key === 'googleTokenIssuance.create')).toBe(false);
    await app.close();
  });

  it('is off unless enabled, needs a linked property, and rate limits per token', async () => {
    const off = await buildApp({ enabled: false });
    expect((await off.inject({ method: 'POST', url: '/api/engine/google/token', headers: bearer(engineToken()), payload: { projectId: 'p-1', product: 'gsc' } })).statusCode).toBe(503);
    await off.close();
    const app = await buildApp();
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, ga4PropertyId: null });
    const nl = await app.inject({ method: 'POST', url: '/api/engine/google/token', headers: bearer(engineToken()), payload: { projectId: 'p-1', product: 'ga4' } });
    expect(nl.statusCode).toBe(409);
    await app.close();
    expect(takeBrokerSlot('t-x', 1000, 2)).toBe(true);
    expect(takeBrokerSlot('t-x', 1001, 2)).toBe(true);
    expect(takeBrokerSlot('t-x', 1002, 2)).toBe(false);
  });

  it('mints with a refresh grant narrowed to one scope and refuses broader grants', async () => {
    process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'cid';
    process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'csecret';
    let sent;
    const ok = await mintDownscopedAccessToken(BROKER_PRODUCTS.ga4.scope, {
      fetchImpl: async (url, init) => { sent = { url, body: new URLSearchParams(init.body) }; return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.x', expires_in: 3599, scope: BROKER_PRODUCTS.ga4.scope }) }; },
      now: () => 0,
    });
    expect(sent.url).toBe('https://oauth2.googleapis.com/token');
    expect(sent.body.get('scope')).toBe(BROKER_PRODUCTS.ga4.scope);
    expect(sent.body.get('grant_type')).toBe('refresh_token');
    expect(ok.expiresAt.getTime()).toBe(3599000);
    await expect(mintDownscopedAccessToken(BROKER_PRODUCTS.gsc.scope, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'ya29.y', expires_in: 3599, scope: `${BROKER_PRODUCTS.gsc.scope} https://www.googleapis.com/auth/business.manage` }) }),
    })).rejects.toMatchObject({ code: 'GOOGLE_SCOPE_MISMATCH' });
    await expect(mintDownscopedAccessToken(BROKER_PRODUCTS.gsc.scope, {
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'secret detail' }) }),
    })).rejects.toThrow(/invalid_grant/);
  });
});
