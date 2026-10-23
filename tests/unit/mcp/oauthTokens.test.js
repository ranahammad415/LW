/**
 * MCP OAuth token lifecycle and confirmations against the in-memory Prisma stand-in:
 * code exchange (PKCE, expiry, replay, wrong client / redirect / resource), refresh rotation + reuse detection +
 * absolute grant lifetime, RFC 7009 revocation, the verifyMcpBearer matrix, pause, and confirm tokens
 * (single use, TTL, args-hash binding, wrong user / grant). Also the MCP_ENABLED kill switch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!';
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));

const { createFakeMcpDb } = await import('../../helpers/fakeMcpDb.js');
const { loadMcpConfig } = await import('../../../src/mcp/config.js');
const { exchangeCode } = await import('../../../src/mcp/oauth/token.js');
const tokens = await import('../../../src/mcp/oauth/tokens.js');
const { s256Challenge } = await import('../../../src/mcp/oauth/pkce.js');
const { createConfirmation } = await import('../../../src/mcp/invoke.js');
const { claimConfirmation } = await import('../../../src/mcp/tools/confirm.js');
const { canonicalJson } = await import('../../../src/lib/idempotency.js');

const cfg = loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'https://account.localwaves.ai/api/mcp', FRONTEND_URL: 'https://client.localwaves.ai' });
const VERIFIER = 'v'.repeat(50);
const USER = { id: 'u-owner', role: 'OWNER', isActive: true, tokenVersion: 3, isAgent: false, email: 'o@x.test', name: 'O' };

let db;
let client;
let grant;
beforeEach(() => {
  tokens.invalidatePauseCache();
  db = createFakeMcpDb();
  db._tables.user.push({ ...USER });
  db._tables.agencySetting.push({ id: 's', mcpPausedAt: null });
  client = { id: 'c1', clientName: 'Claude', redirectUris: ['https://claude.ai/cb'], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none', disabledAt: null, createdAt: new Date() };
  db._tables.mcpClient.push(client);
  grant = { id: 'g1', userId: USER.id, clientId: 'c1', scope: 'os:read os:write', userTokenVersion: 3, createdAt: new Date(), revokedAt: null, lastUsedAt: null };
  db._tables.mcpGrant.push(grant);
});

function approvedCode(overrides = {}) {
  const code = tokens.generateSecret(tokens.PREFIX.code);
  db._tables.mcpAuthRequest.push({
    id: `ar-${Math.random()}`, clientId: 'c1', redirectUri: 'https://claude.ai/cb', state: 's', scope: 'os:read os:write', resource: cfg.resource,
    codeChallenge: s256Challenge(VERIFIER), codeChallengeMethod: 'S256', status: 'approved', userId: USER.id, grantId: 'g1',
    codeHash: tokens.sha256Hex(code), codeExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 600_000), createdAt: new Date(), ...overrides,
  });
  return code;
}
const body = (code, extra = {}) => ({ code, code_verifier: VERIFIER, redirect_uri: 'https://claude.ai/cb', client_id: 'c1', ...extra });

describe('authorization code exchange', () => {
  it('happy path issues an access + refresh pair, hashes only, same family', async () => {
    const out = await exchangeCode(db, { body: body(approvedCode()), client, cfg });
    expect(out.ok).toBe(true);
    expect(out.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'os:read os:write' });
    const rows = db._tables.mcpToken;
    expect(rows.map((r) => r.kind).sort()).toEqual(['access', 'refresh']);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows.find((r) => r.kind === 'access').tokenHash).toBe(tokens.sha256Hex(out.tokens.access_token));
    expect(rows.every((r) => r.prefix.length === 10 && r.resource === cfg.resource)).toBe(true);
    expect(JSON.stringify(db._tables)).not.toContain(out.tokens.access_token);
  });

  it.each([
    ['wrong verifier', (c) => body(c, { code_verifier: 'w'.repeat(50) }), 'PKCE verification failed'],
    ['wrong redirect_uri', (c) => body(c, { redirect_uri: 'https://claude.ai/other' }), 'redirect_uri does not match'],
    ['wrong resource', (c) => body(c, { resource: 'https://evil.example/api/mcp' }), 'Unknown resource'],
    ['unknown code', () => body(tokens.generateSecret('mcpc_')), 'Unknown authorization code'],
  ])('%s → error', async (_n, make, msg) => {
    const out = await exchangeCode(db, { body: make(approvedCode()), client, cfg });
    expect(out).toMatchObject({ ok: false, description: msg });
  });

  it('expired code and wrong client are refused', async () => {
    expect((await exchangeCode(db, { body: body(approvedCode({ codeExpiresAt: new Date(Date.now() - 1) })), client, cfg })).description).toBe('Authorization code expired');
    expect((await exchangeCode(db, { body: body(approvedCode()), client: { ...client, id: 'other' }, cfg })).description).toBe('Code was not issued to this client');
  });

  it('code replay → invalid_grant and the grant (with its tokens) is revoked', async () => {
    const code = approvedCode();
    const first = await exchangeCode(db, { body: body(code), client, cfg });
    expect(first.ok).toBe(true);
    const replay = await exchangeCode(db, { body: body(code), client, cfg });
    expect(replay).toMatchObject({ ok: false, error: 'invalid_grant' });
    expect(db._tables.mcpGrant[0]).toMatchObject({ revokedReason: 'code_replay' });
    expect(db._tables.mcpToken.every((t) => t.revokedAt)).toBe(true);
  });
});

describe('refresh rotation and revocation', () => {
  async function pair() {
    return (await exchangeCode(db, { body: body(approvedCode()), client, cfg })).tokens;
  }

  it('rotation: old refresh marked used, new pair in the same family with parentId', async () => {
    const t = await pair();
    const r = await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', resource: undefined, cfg });
    expect(r.ok).toBe(true);
    expect(r.tokens.refresh_token).not.toBe(t.refresh_token);
    const old = db._tables.mcpToken.find((x) => x.tokenHash === tokens.sha256Hex(t.refresh_token));
    const neu = db._tables.mcpToken.find((x) => x.tokenHash === tokens.sha256Hex(r.tokens.refresh_token));
    expect(old.usedAt).toBeInstanceOf(Date);
    expect(neu).toMatchObject({ familyId: old.familyId, parentId: old.id });
  });

  it('reuse detection revokes the family and the grant', async () => {
    const t = await pair();
    await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', cfg });
    const again = await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', cfg });
    expect(again).toMatchObject({ ok: false, error: 'invalid_grant', reuse: true, grantId: 'g1', userId: USER.id });
    expect(db._tables.mcpGrant[0].revokedReason).toBe('refresh_reuse');
    expect(db._tables.mcpToken.every((x) => x.revokedAt)).toBe(true);
  });

  it('wrong client, wrong resource, revoked grant, absolute lifetime → invalid_grant', async () => {
    const t = await pair();
    expect((await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'other', cfg })).ok).toBe(false);
    expect((await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', resource: 'https://x.test/api/mcp', cfg })).description).toMatch(/Resource/);
    grant.createdAt = new Date(Date.now() - 91 * 86_400_000);
    expect((await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', cfg })).description).toBe('grant expired');
    grant.createdAt = new Date();
    grant.revokedAt = new Date();
    expect((await tokens.rotateRefreshToken(db, { raw: t.refresh_token, clientId: 'c1', cfg })).description).toBe('grant revoked');
  });

  it('refresh never outlives the grant: expiry capped at createdAt + MCP_GRANT_MAX_DAYS', async () => {
    grant.createdAt = new Date(Date.now() - 80 * 86_400_000);
    await pair();
    const refresh = db._tables.mcpToken.find((x) => x.kind === 'refresh');
    expect(refresh.expiresAt.getTime()).toBeLessThanOrEqual(grant.createdAt.getTime() + 90 * 86_400_000);
  });

  it('RFC 7009: refresh revokes the grant, access only itself, other clients and unknown tokens are ignored', async () => {
    const t = await pair();
    expect(await tokens.revokeTokenByValue(db, { raw: t.access_token, clientId: 'other' })).toEqual({ revoked: false });
    expect(await tokens.revokeTokenByValue(db, { raw: 'mcpa_unknown', clientId: 'c1' })).toEqual({ revoked: false });
    expect((await tokens.revokeTokenByValue(db, { raw: t.access_token, clientId: 'c1' })).kind).toBe('access');
    expect(db._tables.mcpGrant[0].revokedAt).toBeNull();
    expect((await tokens.revokeTokenByValue(db, { raw: t.refresh_token, clientId: 'c1' })).kind).toBe('refresh');
    expect(db._tables.mcpGrant[0].revokedReason).toBe('client_revoked');
  });
});

describe('verifyMcpBearer matrix', () => {
  const req = (raw) => ({ headers: raw === undefined ? {} : { authorization: `Bearer ${raw}` } });
  async function access() {
    return (await exchangeCode(db, { body: body(approvedCode()), client, cfg })).tokens.access_token;
  }

  it('valid token → ctx with grant, user, client, scope', async () => {
    const out = await tokens.verifyMcpBearer(db, req(await access()), cfg);
    expect(out.ok).toBe(true);
    expect(out.ctx).toMatchObject({ scope: 'os:read os:write', user: { id: USER.id, role: 'OWNER' }, client: { id: 'c1' }, grant: { id: 'g1' } });
    expect(out.ctx.grant.user).toBeUndefined();
  });

  it.each([
    ['missing', () => undefined, 401, null],
    ['malformed', () => 'nope', 401, 'invalid_token'],
    ['refresh used as access', async () => (await exchangeCode(db, { body: body(approvedCode()), client, cfg })).tokens.refresh_token, 401, 'invalid_token'],
    ['unknown', () => tokens.generateSecret('mcpa_'), 401, 'invalid_token'],
  ])('%s → %i', async (_n, make, status, error) => {
    const out = await tokens.verifyMcpBearer(db, req(await make()), cfg);
    expect(out).toMatchObject({ ok: false, status, error });
  });

  it.each([
    ['expired token', (t) => { t.expiresAt = new Date(Date.now() - 1); }, 401],
    ['revoked token', (t) => { t.revokedAt = new Date(); }, 401],
    ['wrong resource', (t) => { t.resource = 'https://other.test/api/mcp'; }, 401],
    ['revoked grant', () => { grant.revokedAt = new Date(); }, 401],
    ['disabled client', () => { client.disabledAt = new Date(); }, 401],
    ['inactive user', () => { db._tables.user[0].isActive = false; }, 401],
    ['tokenVersion bump', () => { db._tables.user[0].tokenVersion = 4; }, 401],
    ['role no longer allowed', () => { db._tables.user[0].role = 'PM'; }, 403],
    ['paused', () => { db._tables.agencySetting[0].mcpPausedAt = new Date(); }, 503],
  ])('%s → %i', async (_n, mutate, status) => {
    const raw = await access();
    mutate(db._tables.mcpToken.find((t) => t.tokenHash === tokens.sha256Hex(raw)));
    const out = await tokens.verifyMcpBearer(db, req(raw), cfg);
    expect(out).toMatchObject({ ok: false, status });
    if (status === 503) expect(out.code).toBe('MCP_PAUSED');
    if (status === 403) expect(out.code).toBe('MCP_ROLE_NOT_ALLOWED');
  });

  it('pause state is cached ~10 s per instance; a missing column counts as paused', async () => {
    expect(await tokens.isMcpPaused(db, 1_000)).toBe(false);
    db._tables.agencySetting[0].mcpPausedAt = new Date();
    expect(await tokens.isMcpPaused(db, 5_000)).toBe(false);
    expect(await tokens.isMcpPaused(db, 12_000)).toBe(true);
    tokens.invalidatePauseCache();
    expect(await tokens.isMcpPaused({ agencySetting: { findFirst: async () => { throw new Error('Unknown column'); } } })).toBe(true);
  });
});

describe('confirm tokens', () => {
  const ctx = () => ({ db, cfg, grant: { id: 'g1' }, user: { id: USER.id } });
  const args = { tool: 'os_api_request', request: { method: 'DELETE', path: '/api/tasks/t1', query: null, body: null, idempotencyKey: null }, toolArgs: {} };
  const route = { method: 'DELETE', path: '/api/tasks/t1', pattern: '/api/tasks/:id' };

  it('preview payload + stored row (hash only, argsHash of the stored args, 5 minutes)', async () => {
    const c = await createConfirmation(ctx(), args, { route, reasons: ['delete'] });
    expect(c.payload).toMatchObject({ status: 'confirmation_required', expires_in: 300, preview: { routePattern: '/api/tasks/:id', reasons: ['delete'] } });
    const row = db._tables.mcpConfirmation[0];
    expect(row.tokenHash).toBe(tokens.sha256Hex(c.payload.confirm_token));
    expect(row.argsHash).toBe(tokens.sha256Hex(canonicalJson(args)));
    expect(row.routeKey).toBe('DELETE /api/tasks/:id');
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('single use (CAS)', async () => {
    const c = await createConfirmation(ctx(), args, { route, reasons: ['delete'] });
    const a = claimConfirmation(db, { token: c.payload.confirm_token, userId: USER.id, grantId: 'g1' });
    const b = claimConfirmation(db, { token: c.payload.confirm_token, userId: USER.id, grantId: 'g1' });
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok).code).toBe('CONFIRM_USED');
  });

  it('TTL, wrong user / grant, tampered args, unknown token', async () => {
    const c = await createConfirmation(ctx(), args, { route, reasons: ['delete'] });
    const token = c.payload.confirm_token;
    expect((await claimConfirmation(db, { token, userId: 'someone-else', grantId: 'g1' })).code).toBe('CONFIRM_INVALID');
    expect((await claimConfirmation(db, { token, userId: USER.id, grantId: 'g2' })).code).toBe('CONFIRM_INVALID');
    expect((await claimConfirmation(db, { token, userId: USER.id, grantId: 'g1', now: new Date(Date.now() + 301_000) })).code).toBe('CONFIRM_EXPIRED');
    db._tables.mcpConfirmation[0].args = { ...args, request: { ...args.request, path: '/api/tasks/OTHER' } };
    expect((await claimConfirmation(db, { token, userId: USER.id, grantId: 'g1' })).code).toBe('CONFIRM_INVALID');
    expect((await claimConfirmation(db, { token: 'mcpx_nope', userId: USER.id, grantId: 'g1' })).code).toBe('CONFIRM_INVALID');
    expect(db._tables.mcpConfirmation[0].consumedAt).toBeNull();
  });
});

describe('MCP_ENABLED kill switch', () => {
  it('disabled → nothing registered: /api/mcp and the metadata are 404', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerMcp, installMcpRouteCollector } = await import('../../../src/mcp/index.js');
    const off = loadMcpConfig({});
    const app = Fastify();
    const collector = off.enabled ? installMcpRouteCollector(app) : null;
    if (off.enabled) registerMcp(app, { cfg: off, collector });
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/mcp', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode).toBe(404);
    await app.close();
  });
});
