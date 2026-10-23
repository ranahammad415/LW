/**
 * MCP pure helpers: PKCE, DCR redirect allow-list / registration policy, config, discovery documents, redaction and
 * result shaping, per-minute limits, the route catalog and the ledger parser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { isValidCodeVerifier, s256Challenge, verifyPkceS256 } from '../../../src/mcp/oauth/pkce.js';
import { checkRedirectUri, validateRegistration, registrationResponse, readClientCredentials } from '../../../src/mcp/oauth/clients.js';
import { loadMcpConfig } from '../../../src/mcp/config.js';
import { protectedResourceMetadata, authorizationServerMetadata } from '../../../src/mcp/oauth/metadata.js';
import { maskSecretsDeep, summarizeArgs, applyFieldsLimit, capResult, TRUNCATION_NOTE } from '../../../src/mcp/redact.js';
import { takeMinuteSlot, resetMinuteWindows, checkMcpLimits } from '../../../src/mcp/limits.js';
import { createRouteCollector, RouteCatalog } from '../../../src/mcp/catalog.js';
import { parseLedgerRoutes } from '../../../scripts/build-mcp-catalog.mjs';
import { normalizeScope, validateAuthorizeQuery, buildRedirect } from '../../../src/mcp/oauth/authorize.js';
import { wwwAuthenticate } from '../../../src/mcp/transport.js';

const ENV = { MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'https://account.localwaves.ai/api/mcp', FRONTEND_URL: 'https://client.localwaves.ai' };
const cfg = loadMcpConfig(ENV);

describe('PKCE (S256 only)', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  it('RFC 7636 appendix B vector', () => {
    expect(s256Challenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(verifyPkceS256(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
  });
  it('rejects a wrong verifier, a plain challenge and malformed verifiers', () => {
    expect(verifyPkceS256(`${verifier.slice(0, -1)}x`, s256Challenge(verifier))).toBe(false);
    expect(verifyPkceS256(verifier, verifier)).toBe(false); // "plain" would compare equal strings
    expect(isValidCodeVerifier('short')).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(verifyPkceS256(undefined, 'x')).toBe(false);
  });
});

describe('config', () => {
  it('derives resource, issuer and PRM URL from MCP_PUBLIC_URL; defaults are safe', () => {
    expect(cfg).toMatchObject({
      enabled: true,
      errors: [],
      resource: 'https://account.localwaves.ai/api/mcp',
      issuer: 'https://account.localwaves.ai',
      resourceMetadataUrl: 'https://account.localwaves.ai/.well-known/oauth-protected-resource/api/mcp',
      spaUrl: 'https://client.localwaves.ai',
      allowedRoles: ['OWNER'],
      accessTtlSec: 3600,
      refreshTtlDays: 30,
      grantMaxDays: 90,
      toolTimeoutMs: 45_000,
      maxResultBytes: 200_000,
    });
    expect(cfg.corsOrigins).toEqual(expect.arrayContaining(['https://claude.ai', 'https://claude.com', 'https://client.localwaves.ai']));
  });
  it('kill switch: off by default; enabled with a bad URL reports errors', () => {
    expect(loadMcpConfig({}).enabled).toBe(false);
    expect(loadMcpConfig({}).errors).toEqual([]);
    expect(loadMcpConfig({ MCP_ENABLED: 'true' }).errors[0]).toMatch(/MCP_PUBLIC_URL is required/);
    expect(loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'http://account.localwaves.ai/api/mcp' }).errors[0]).toMatch(/https/);
    expect(loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'https://x.test/mcp' }).errors[0]).toMatch(/path/);
    expect(loadMcpConfig({ ...ENV, MCP_ALLOWED_ROLES: 'NOPE' }).errors[0]).toMatch(/MCP_ALLOWED_ROLES/);
    expect(loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'http://localhost:3000/api/mcp' }).errors).toEqual([]);
  });
});

describe('discovery documents', () => {
  it('PRM and AS metadata use the exact public URLs', () => {
    expect(protectedResourceMetadata(cfg)).toEqual({
      resource: 'https://account.localwaves.ai/api/mcp',
      authorization_servers: ['https://account.localwaves.ai'],
      scopes_supported: ['os:read', 'os:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'LocalWaves Agency OS',
    });
    const as = authorizationServerMetadata(cfg);
    expect(as).toMatchObject({
      issuer: 'https://account.localwaves.ai',
      authorization_endpoint: 'https://account.localwaves.ai/api/mcp/oauth/authorize',
      token_endpoint: 'https://account.localwaves.ai/api/mcp/oauth/token',
      registration_endpoint: 'https://account.localwaves.ai/api/mcp/oauth/register',
      revocation_endpoint: 'https://account.localwaves.ai/api/mcp/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
  it('WWW-Authenticate carries resource_metadata, and the error only when a token was presented', () => {
    expect(wwwAuthenticate(cfg)).toBe('Bearer realm="LocalWaves OS", resource_metadata="https://account.localwaves.ai/.well-known/oauth-protected-resource/api/mcp"');
    expect(wwwAuthenticate(cfg, { error: 'invalid_token', description: 'Access token "expired"' })).toMatch(/error="invalid_token", error_description="Access token 'expired'"$/);
  });
});

describe('DCR redirect allow-list', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', null],
    ['https://claude.com/api/mcp/auth_callback', null],
    ['https://app.claude.ai/cb', null],
    ['https://console.anthropic.com/oauth/cb', null],
    ['http://localhost:33418/callback', null],
    ['http://127.0.0.1:9000/cb', null],
    ['http://claude.ai/cb', 'http redirect_uri is only allowed for localhost'],
    ['https://evil.example/cb', 'redirect host evil.example is not allowed'],
    ['https://claude.ai.evil.example/cb', 'redirect host claude.ai.evil.example is not allowed'],
    ['https://notclaude.ai/cb', 'redirect host notclaude.ai is not allowed'],
    ['https://claude.ai/cb#frag', 'redirect_uri must not have a fragment'],
    ['https://*.claude.ai/cb', 'wildcards are not allowed in redirect_uri'],
    ['/relative/cb', 'redirect_uri must be an absolute URL'],
    ['javascript:alert(1)', 'redirect_uri must use https'],
    ['https://user:pw@claude.ai/cb', 'redirect_uri must not carry credentials'],
  ])('%s', (uri, reason) => {
    expect(checkRedirectUri(uri, cfg)).toBe(reason);
  });

  it('registration policy: > 10 URIs, grant/response types, auth method, scope', () => {
    const base = { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' };
    expect(validateRegistration(base, cfg)).toMatchObject({ ok: true, value: { clientName: 'Claude', tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] } });
    expect(validateRegistration({ ...base, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) }, cfg)).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(validateRegistration({ ...base, redirect_uris: [] }, cfg).ok).toBe(false);
    expect(validateRegistration({ ...base, grant_types: ['client_credentials'] }, cfg).ok).toBe(false);
    expect(validateRegistration({ ...base, response_types: ['token'] }, cfg).ok).toBe(false);
    expect(validateRegistration({ ...base, token_endpoint_auth_method: 'private_key_jwt' }, cfg).ok).toBe(false);
    expect(validateRegistration({ ...base, scope: 'os:read admin' }, cfg).ok).toBe(false);
    expect(validateRegistration({ ...base, client_name: 'x'.repeat(300) }, cfg).value.clientName).toHaveLength(100);
    expect(validateRegistration({ ...base, unknown_field: 1 }, cfg).ok).toBe(true);
  });

  it('a secret is echoed only when issued; Basic credentials are parsed', () => {
    const row = { id: 'c1', createdAt: new Date(0), clientName: 'n', redirectUris: ['https://claude.ai/cb'], grantTypes: ['authorization_code'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' };
    expect(registrationResponse(row)).not.toHaveProperty('client_secret');
    expect(registrationResponse(row, 'mcps_x')).toMatchObject({ client_secret: 'mcps_x', client_secret_expires_at: 0 });
    const basic = Buffer.from('c1:s3cret').toString('base64');
    expect(readClientCredentials({ headers: { authorization: `Basic ${basic}` }, body: {} })).toEqual({ clientId: 'c1', clientSecret: 's3cret', method: 'client_secret_basic' });
    expect(readClientCredentials({ headers: {}, body: { client_id: 'c1' } })).toEqual({ clientId: 'c1', clientSecret: null, method: 'none' });
  });
});

describe('authorize validation', () => {
  const client = { id: 'c1', redirectUris: ['https://claude.ai/cb'], scope: null };
  const good = { response_type: 'code', client_id: 'c1', redirect_uri: 'https://claude.ai/cb', state: 'st', code_challenge: s256Challenge('v'.repeat(43)), code_challenge_method: 'S256' };
  it('unknown client / unregistered redirect → no redirect', () => {
    expect(validateAuthorizeQuery(good, null, cfg)).toMatchObject({ ok: false, redirect: false });
    expect(validateAuthorizeQuery({ ...good, redirect_uri: 'https://claude.ai/other' }, client, cfg)).toMatchObject({ ok: false, redirect: false });
    expect(validateAuthorizeQuery(good, { ...client, disabledAt: new Date() }, cfg)).toMatchObject({ ok: false, redirect: false });
  });
  it('registered redirect + bad params → redirect with error', () => {
    expect(validateAuthorizeQuery({ ...good, code_challenge: undefined }, client, cfg)).toMatchObject({ redirect: true, error: 'invalid_request' });
    expect(validateAuthorizeQuery({ ...good, code_challenge_method: 'plain' }, client, cfg)).toMatchObject({ redirect: true, error: 'invalid_request' });
    expect(validateAuthorizeQuery({ ...good, response_type: 'token' }, client, cfg)).toMatchObject({ redirect: true, error: 'unsupported_response_type' });
    expect(validateAuthorizeQuery({ ...good, scope: 'os:admin' }, client, cfg)).toMatchObject({ redirect: true, error: 'invalid_scope', state: 'st' });
    expect(validateAuthorizeQuery({ ...good, resource: 'https://evil.example/api/mcp' }, client, cfg)).toMatchObject({ redirect: true, error: 'invalid_target' });
  });
  it('valid → stored values (default scope both, resource canonical)', () => {
    expect(validateAuthorizeQuery(good, client, cfg)).toEqual({ ok: true, value: { clientId: 'c1', redirectUri: 'https://claude.ai/cb', state: 'st', scope: 'os:read os:write', resource: cfg.resource, codeChallenge: good.code_challenge } });
    expect(validateAuthorizeQuery({ ...good, scope: 'os:read', resource: cfg.resource }, client, cfg).value.scope).toBe('os:read');
    expect(normalizeScope('os:write')).toBe('os:read os:write');
    expect(buildRedirect('https://claude.ai/cb?x=1', { code: 'c', state: 's', empty: '' })).toBe('https://claude.ai/cb?x=1&code=c&state=s');
  });
});

describe('redaction and result shaping', () => {
  it('maskSecretsDeep masks nested secrets, keeps prefixes and nulls', () => {
    const input = { a: { password: 'p', apiKey: 'k', tokenPrefix: 'lwk_ab', wpApiKey: null, list: [{ refreshToken: 'r', name: 'n' }], client_secret: 's', accessToken: 'x', headerSecret: 'h' } };
    expect(maskSecretsDeep(input)).toEqual({ a: { password: '[REDACTED]', apiKey: '[REDACTED]', tokenPrefix: 'lwk_ab', wpApiKey: null, list: [{ refreshToken: '[REDACTED]', name: 'n' }], client_secret: '[REDACTED]', accessToken: '[REDACTED]', headerSecret: '[REDACTED]' } });
    expect(input.a.password).toBe('p');
  });
  it('summarizeArgs masks free text, contacts and secrets; truncates scalars; counts arrays', () => {
    const s = summarizeArgs({ taskId: 't1', content: 'secret plan', email: 'a@b.c', title: 'x'.repeat(100), assigneeIds: ['a', 'b'], body: { description: 'd', status: 'DONE', deep: { deeper: 1 } }, confirm_token: 'mcpx_abc', path: '/api/public/knowledge-interview/tok123/chat' });
    expect(s).toEqual({ taskId: 't1', content: '[masked]', email: '[masked]', title: `${'x'.repeat(80)}…`, assigneeIds: '[2 items]', body: { description: '[masked]', status: 'DONE', deep: '{…}' }, confirm_token: '[masked]', path: '/api/public/knowledge-interview/[redacted]/chat' });
  });
  it('fields / limit on arrays and list keys', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `n${i}`, secretish: 1 }));
    expect(applyFieldsLimit(rows, {})).toMatchObject({ truncated: true, total: 60 });
    expect(applyFieldsLimit(rows, {}).items).toHaveLength(50);
    expect(applyFieldsLimit(rows, { fields: ['id'], limit: 2 })).toEqual({ items: [{ id: 0 }, { id: 1 }], truncated: true, total: 60 });
    expect(applyFieldsLimit({ data: rows.slice(0, 3), pagination: { page: 1 } }, { fields: ['name'] })).toEqual({ data: [{ name: 'n0' }, { name: 'n1' }, { name: 'n2' }], pagination: { page: 1 } });
    expect(applyFieldsLimit({ id: 1, a: 2, b: 3 }, { fields: ['a'] })).toEqual({ a: 2 });
  });
  it('byte cap cuts and appends the note', () => {
    const big = { text: 'x'.repeat(20_000) };
    const out = capResult(big, 10_000);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(10_000);
    expect(capResult({ a: 1 }, 10_000)).toEqual({ text: '{"a":1}', bytes: 7, truncated: false });
  });
});

describe('rate limits', () => {
  beforeEach(() => resetMinuteWindows());
  it('per-minute sliding window per grant', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(takeMinuteSlot('g1', 3, t0 + i).ok).toBe(true);
    const r = takeMinuteSlot('g1', 3, t0 + 10);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(60);
    expect(takeMinuteSlot('g2', 3, t0 + 10).ok).toBe(true);
    expect(takeMinuteSlot('g1', 3, t0 + 60_001).ok).toBe(true);
  });
  it('per-hour limit counts audit rows of the grant in the last hour', async () => {
    let seen;
    const db = { mcpAuditLog: { count: async (a) => { seen = a; return 600; } } };
    const r = await checkMcpLimits(db, 'g1', { ...cfg, ratePerHour: 600 }, new Date('2026-10-24T12:00:00Z'));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hourly/);
    expect(seen).toEqual({ where: { grantId: 'g1', createdAt: { gte: new Date('2026-10-24T11:00:00Z') } } });
    const ok = await checkMcpLimits({ mcpAuditLog: { count: async () => 5 } }, 'g9', cfg);
    expect(ok.ok).toBe(true);
  });
});

describe('route catalog', () => {
  const collector = createRouteCollector();
  for (const [method, url] of [
    [['GET', 'HEAD'], '/api/tasks'],
    ['GET', '/api/tasks/attachments/all'],
    ['GET', '/api/tasks/:id/comments'],
    ['PATCH', '/api/tasks/:id/status'],
    ['DELETE', '/api/tasks/:id'],
    ['GET', '/api/projects/:id'],
    ['GET', '/api/projects/:id/wp-pages/snapshots/diff'],
    ['GET', '/api/projects/:id/wp-pages/:wpPostId/snapshots'],
    ['GET', '/health'],
  ]) collector.onRoute({ method, url });
  const json = [
    { m: 'GET', p: '/api/tasks', g: 'any authenticated user', pu: 'Role-scoped task list' },
    { m: 'GET', p: '/api/tasks/:id/comments', g: 'any authenticated user', pu: 'Task Comments' },
    { m: 'DELETE', p: '/api/tasks/:id', g: 'PM, OWNER', pu: 'delete a task' },
  ];
  const catalog = new RouteCatalog(collector.routes, json);

  it('collects /api routes only, no HEAD, no duplicates', () => {
    collector.onRoute({ method: 'GET', url: '/api/tasks' });
    expect(collector.routes.map((r) => `${r.method} ${r.url}`)).not.toContain('HEAD /api/tasks');
    expect(collector.routes.filter((r) => r.url === '/api/tasks')).toHaveLength(1);
    expect(collector.routes.some((r) => r.url === '/health')).toBe(false);
  });

  it('matches concrete paths, static beats param', () => {
    expect(catalog.match('GET', '/api/tasks/attachments/all').entry.path).toBe('/api/tasks/attachments/all');
    expect(catalog.match('GET', '/api/tasks/abc/comments')).toMatchObject({ entry: { path: '/api/tasks/:id/comments' }, params: { id: 'abc' } });
    expect(catalog.match('GET', '/api/projects/p1/wp-pages/snapshots/diff').entry.path).toBe('/api/projects/:id/wp-pages/snapshots/diff');
    expect(catalog.match('GET', '/api/projects/p1/wp-pages/55/snapshots', ['id', 'wpPostId']).entry.path).toBe('/api/projects/:id/wp-pages/:wpPostId/snapshots');
    expect(catalog.match('POST', '/api/tasks/abc/comments')).toBeNull();
  });

  it('search ranks by path + purpose and reports danger', () => {
    const hits = catalog.search('task comments');
    expect(hits[0]).toMatchObject({ method: 'GET', path: '/api/tasks/:id/comments', purpose: 'Task Comments', danger: 'read', blocked: false });
    expect(catalog.search('delete task', { method: 'DELETE' })[0]).toMatchObject({ path: '/api/tasks/:id', danger: 'dangerous' });
    expect(catalog.describe(catalog.byPattern('PATCH', '/api/tasks/:id/status'))).toMatchObject({ danger: 'write', confirmRequired: false, scopeRequired: 'os:write', purpose: '' });
  });

  it('ledger parser reads route rows, skips OmniSearch and "(see path)"', () => {
    const md = [
      '| Method | Full path | Guard/roles | Handler file | Purpose |',
      '|---|---|---|---|---|',
      '| GET | `/api/users/me` | any authenticated user | `apps/backend/src/routes/users.js:4` | (see path) |',
      '| POST | `/api/tasks/:id/engine-review/challenges` | same | same | `{snapshotId,operation:task_review|task_reopen}` → challenge |',
      '| GET | `/api/omni-search/x` | omni | f | y |',
      '| GET | `/health` | public | f | y |',
    ].join('\n');
    expect(parseLedgerRoutes(md)).toEqual([
      { m: 'GET', p: '/api/users/me', g: 'any authenticated user', pu: '' },
      { m: 'POST', p: '/api/tasks/:id/engine-review/challenges', g: 'same', pu: '{snapshotId,operation:task_review|task_reopen} → challenge' },
    ]);
  });

  it('the committed catalog.json lists the curated tool routes', async () => {
    const { loadCatalogJson } = await import('../../../src/mcp/catalog.js');
    const keys = new Set(loadCatalogJson().map((r) => `${r.m} ${r.p}`));
    for (const k of ['GET /api/users/me', 'GET /api/admin/dashboard', 'GET /api/admin/clients', 'GET /api/admin/clients/:id', 'GET /api/projects', 'GET /api/projects/:id', 'GET /api/tasks', 'GET /api/tasks/:id/comments', 'POST /api/tasks', 'PATCH /api/tasks/:id', 'PATCH /api/tasks/:id/status', 'POST /api/tasks/:id/comments']) {
      expect(keys.has(k), k).toBe(true);
    }
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});
