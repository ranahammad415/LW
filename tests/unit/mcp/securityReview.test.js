/**
 * Regression tests for the mcp-server-p1 security review: H1 (encoded paths, route guard on the matched route,
 * viaMcp defense in depth), M1 (login / preview / code masking), M3 (full preview), M5 (client IP), L2 (auto
 * Idempotency-Key). The end-to-end parts (guard through app.inject, critical approval, batch, caps) are in
 * roundtrip.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!';
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));

const { default: Fastify } = await import('fastify');
const { default: jwt } = await import('jsonwebtoken');
const { validateOsRequest, mintInternalJwt, resolveRoute, checkEncodedSegments } = await import('../../../src/mcp/invoke.js');
const { installMcpRouteGuard, routeGuardDecision, mcpJwtClaims } = await import('../../../src/mcp/routeGuard.js');
const { maskSecretsDeep, previewBody } = await import('../../../src/mcp/redact.js');
const { clientIp } = await import('../../../src/mcp/clientIp.js');
const { autoIdempotencyKey } = await import('../../../src/mcp/tools/generic.js');
const { adminMcpRoutes } = await import('../../../src/routes/admin/mcp.js');
const { RouteCatalog } = await import('../../../src/mcp/catalog.js');

const SECRET = process.env.JWT_ACCESS_SECRET;
const USER = { id: 'u1', role: 'OWNER', tokenVersion: 0 };

describe('H1: encoded / odd paths are rejected before routing', () => {
  it.each([
    '/api/tasks/a%2Fb',
    '/api/tasks/a%5Cb',
    '/api/tasks/a%3Fb',
    '/api/tasks/%2525',
    '/api/tasks/%2E%2E',
    '/api/tasks/%00',
    '/api/tasks/%zz',
    '/api/tasks/%E0%A4%A',
    '/api/tasks/<x>',
    '/api/tasks/a b',
    "/api/tasks/'x'",
    '/api/tasks/x;y',
  ])('%s', (path) => {
    expect(validateOsRequest({ method: 'POST', path })).toMatch(/percent-encod|may only contain/);
  });

  it('encoding is allowed only in a whole :param segment of the resolved pattern', () => {
    const P = '/api/tasks/:taskId/comments/:commentId/reactions/:emoji';
    expect(checkEncodedSegments('/api/tasks/t/comments/c/reactions/%F0%9F%91%8D', P)).toEqual({ classifyPath: '/api/tasks/t/comments/c/reactions/_' });
    expect(checkEncodedSegments('/api/tasks/t/comments/c/reactions/x', P)).toEqual({ classifyPath: '/api/tasks/t/comments/c/reactions/x' });
    expect(checkEncodedSegments('/api/tasks/t/comments/c/r%65actions/x', P).error).toMatch(/route parameter/);
    expect(checkEncodedSegments('/api/admin/%69mpersonate', '/api/admin/impersonate').error).toMatch(/route parameter/);
    expect(checkEncodedSegments('/api/x/%41/y', '/api/x/:a-:b/y').error).toMatch(/route parameter/);
    expect(checkEncodedSegments('/api/x/%41', '/api/x/*').error).toMatch(/route parameter/);
  });

  it('plain paths still pass', () => {
    expect(validateOsRequest({ method: 'GET', path: '/api/tasks/99999999-9999-9999-9999-999999999991/comments' })).toBeNull();
    expect(validateOsRequest({ method: 'GET', path: '/api/pm/okf-review/drafts/a_b.c~d' })).toBeNull();
  });

  it('an encoded param value that decodes to a static sibling is refused even if the router did not decode it', async () => {
    const { executeOsRequest } = await import('../../../src/mcp/invoke.js');
    const catalog = new RouteCatalog([{ method: 'GET', url: '/api/x/:thing' }, { method: 'GET', url: '/api/x/impersonate' }], []);
    const app = { findRoute: () => ({ params: { thing: 'whatever' } }), inject: () => { throw new Error('must not run'); } };
    const ctx = { app, catalog, scope: 'os:read os:write', cfg: { toolTimeoutMs: 1000 }, user: USER, grant: { id: 'g' } };
    const out = await executeOsRequest(ctx, { method: 'GET', path: '/api/x/%69mpersonate' });
    expect(out).toMatchObject({ kind: 'error', code: 'INVALID_REQUEST' });
  });

  it('pagination: no OS route takes a *Token query / body key today, so the suffix rule blocks nothing legitimate', () => {
    // routes/ grep (re-review): only /api/auth/* (blocked area) and /api/realtime (blocked) read `token`; Google
    // pageToken / nextPageToken live inside lib/ and never reach a request. Cursors use `cursor` / `since`.
    expect(validateOsRequest({ method: 'GET', path: '/api/tasks', query: { cursor: 'abc', limit: 5 } })).toBeNull();
  });

  it('a route the catalog cannot name is refused instead of classified on the raw path', () => {
    const app = { findRoute: () => ({ params: {} }) };
    expect(resolveRoute(app, new RouteCatalog([], []), 'POST', '/api/admin/impersonate')).toBeNull();
  });
});

describe('H1: route guard on the matched route', () => {
  async function build() {
    const app = Fastify();
    installMcpRouteGuard(app, { secret: SECRET });
    const ran = [];
    app.post('/api/admin/impersonate', async () => { ran.push('impersonate'); return { ok: true }; });
    app.delete('/api/tasks/:id', async () => { ran.push('delete'); return {}; });
    app.post('/api/tasks', async () => { ran.push('create'); return { id: 't' }; });
    app.get('/api/tasks', async () => { ran.push('list'); return []; });
    app.post('/api/x/marked', { config: { mcp: 'costly' } }, async () => { ran.push('marked'); return {}; });
    app.get('/api/public/thing', async () => { ran.push('public'); return {}; });
    await app.ready();
    return { app, ran };
  }
  const bearer = (claims) => ({ authorization: `Bearer ${mintInternalJwt(USER, 'g1', claims)}` });

  it('the encoded impersonate path that find-my-way decodes is refused (handler never runs)', async () => {
    const { app, ran } = await build();
    for (const rk of ['POST /api/admin/impersonate', 'POST /api/admin/%69mpersonate', null]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/%69mpersonate', headers: bearer({ rk, cf: true }), payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MCP_ROUTE_REFUSED');
    }
    expect(ran).toEqual([]);
    await app.close();
  });

  it('the JWT is bound to one route (rk), and dangerous needs cf', async () => {
    const { app, ran } = await build();
    // a token minted for the harmless list cannot be replayed on another route
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer({ rk: 'GET /api/tasks' }), payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer({ rk: 'GET /api/tasks' }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/t1', headers: bearer({ rk: 'DELETE /api/tasks/:id' }) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/t1', headers: bearer({ rk: 'DELETE /api/tasks/:id', cf: true }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/x/marked', headers: bearer({ rk: 'POST /api/x/marked' }), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/public/thing', headers: bearer({ rk: 'GET /api/public/thing', cf: true }) })).statusCode).toBe(403);
    expect(ran).toEqual(['list', 'delete']);
    await app.close();
  });

  it('requests without an MCP JWT are untouched; a forged via:mcp token (wrong secret) is ignored like any bad JWT', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: {} })).statusCode).toBe(200);
    const normal = jwt.sign({ sub: 'u1', role: 'OWNER', tv: 0 }, SECRET);
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/t1', headers: { authorization: `Bearer ${normal}` } })).statusCode).toBe(200);
    const forged = jwt.sign({ sub: 'u1', via: 'mcp', rk: 'x' }, 'another-secret-another-secret-123');
    expect(mcpJwtClaims({ headers: { authorization: `Bearer ${forged}` } }, SECRET)).toBeNull();
    await app.close();
  });

  it('routeGuardDecision compares patterns without a trailing slash', () => {
    const req = { method: 'GET', routeOptions: { url: '/api/tasks/', config: {} }, query: {}, body: undefined };
    expect(routeGuardDecision(req, { rk: 'GET /api/tasks' }).ok).toBe(true);
  });

  it('defense in depth: /api/admin/mcp/* refuses a viaMcp request even without the guard', async () => {
    const app = Fastify();
    app.decorate('verifyJwt', async (request) => {
      request.user = { id: 'o', role: 'OWNER' };
      request.authMethod = 'jwt';
      request.viaMcp = true;
    });
    app.decorate('requireOwner', async () => {});
    await app.register(adminMcpRoutes, { prefix: '/api/admin', cfg: {} });
    await app.ready();
    for (const [method, url] of [['GET', '/api/admin/mcp/status'], ['POST', '/api/admin/mcp/grants/revoke-all'], ['POST', '/api/admin/mcp/approvals/x/approve']]) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });
});

describe('M1: login links, preview links and one-time codes are masked', () => {
  it('keys and credential-bearing strings', () => {
    const out = maskSecretsDeep({
      loginUrl: 'https://site.test/?agency_token=abc',
      previewUrl: 'https://site.test/p',
      pmPreviewUrl: 'https://site.test/p2',
      url: 'https://site.test/x?token=abc',
      link: 'https://os.test/knowledge-interview/secret-token-123/start',
      note: 'see https://site.test/?agency_token=zzz',
      code: 'A1b2C3d4',
      pairingCode: 'XYZ-123',
      errorCode: { code: 'HUMAN_ONLY' },
      pairingStatus: { pairingCode: { createdAt: '2026', used: false } },
      plain: 'hello',
    });
    expect(out).toEqual({
      loginUrl: '[REDACTED]',
      previewUrl: '[REDACTED]',
      pmPreviewUrl: '[REDACTED]',
      url: '[REDACTED]',
      link: 'https://os.test/knowledge-interview/[redacted]/start',
      note: '[REDACTED]',
      code: '[REDACTED]',
      pairingCode: '[REDACTED]',
      errorCode: { code: 'HUMAN_ONLY' },
      pairingStatus: { pairingCode: { createdAt: '2026', used: false } },
      plain: 'hello',
    });
  });
});

describe('M3: the confirm preview shows what matters', () => {
  it('full non-secret fields (≤ 500 chars), first array items, secrets masked', () => {
    const body = {
      subject: 'Your monthly report',
      html: `<p>${'x'.repeat(600)}</p>`,
      to: Array.from({ length: 12 }, (_, i) => `c${i}@client.test`),
      smtpPassword: 'p',
      nested: { message: 'Hi there', apiKey: 'k' },
    };
    const p = previewBody(body);
    expect(p.subject).toBe('Your monthly report');
    expect(p.html.startsWith('<p>xxx')).toBe(true);
    expect(p.html).toMatch(/… \(607 chars\)$/);
    expect(p.to.slice(0, 10)).toEqual(body.to.slice(0, 10));
    expect(p.to[10]).toBe('… and 2 more (12 total)');
    expect(p.smtpPassword).toBe('[REDACTED]');
    expect(p.nested).toEqual({ message: 'Hi there', apiKey: '[REDACTED]' });
  });
});

describe('M5: client IP prefers CF-Connecting-IP', () => {
  it('header when valid, else request.ip', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' }, ip: '10.0.0.1' })).toBe('203.0.113.7');
    expect(clientIp({ headers: { 'cf-connecting-ip': '2001:db8::1' }, ip: '10.0.0.1' })).toBe('2001:db8::1');
    expect(clientIp({ headers: { 'cf-connecting-ip': 'not an ip; drop table' }, ip: '10.0.0.1' })).toBe('10.0.0.1');
    expect(clientIp({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });
});

describe('L2: auto Idempotency-Key for non-GET os_api_request', () => {
  const ctx = { grant: { id: 'g1' } };
  it('same request in the same 15-minute bucket → same key; GET and explicit keys untouched', () => {
    const args = { method: 'POST', path: '/api/tasks', body: { title: 'x' } };
    const t = 1_800_000_000_000;
    const a = autoIdempotencyKey(ctx, args, t);
    expect(a).toMatch(/^mcp-[0-9a-f]{64}$/);
    expect(autoIdempotencyKey(ctx, args, t + 60_000)).toBe(a);
    expect(autoIdempotencyKey(ctx, { ...args, body: { title: 'y' } }, t)).not.toBe(a);
    expect(autoIdempotencyKey(ctx, args, t + 16 * 60_000)).not.toBe(a);
    expect(autoIdempotencyKey({ grant: { id: 'g2' } }, args, t)).not.toBe(a);
    expect(autoIdempotencyKey(ctx, { method: 'GET', path: '/api/tasks' }, t)).toBeUndefined();
    expect(autoIdempotencyKey(ctx, { ...args, idempotencyKey: 'mine' }, t)).toBe('mine');
  });
});
