/**
 * End-to-end MCP round trip through Fastify with the real verifyJwt / requireOwner / requirePM guards, the real
 * MCP plugin and an in-memory Prisma stand-in (no MySQL):
 *   discovery → DCR → authorize (302) → consent context (OWNER 200, PM 403) → decision (Origin) → token (form) →
 *   POST /api/mcp initialize → tools/list → tools/call (os_whoami, os_api_request, dangerous DELETE → confirm_action)
 *   → audit rows → pause (503) → refresh rotation + reuse detection (401 after).
 * Also: the transport under app.inject (no hijack), and a real SDK Client over a listening port.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret-32-chars-minimum!!';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakeMcpDb } = await import('../../helpers/fakeMcpDb.js');
  const db = createFakeMcpDb();
  globalThis.__mcpFakeDb = db;
  return { prisma: db };
});

const { default: Fastify } = await import('fastify');
const { default: jwt } = await import('jsonwebtoken');
const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { requireOwner } = await import('../../../src/lib/requireOwner.js');
const { requirePM } = await import('../../../src/lib/requirePM.js');
const { redactResponseSecrets, responseDropKeys } = await import('../../../src/lib/redactSecrets.js');
const { registerApiTokenHooks } = await import('../../../src/lib/apiTokens.js');
const { userRoutes } = await import('../../../src/routes/users.js');
const { adminMcpRoutes } = await import('../../../src/routes/admin/mcp.js');
const { loadMcpConfig, installMcpRouteCollector, registerMcp, purgeMcpRecords } = await import('../../../src/mcp/index.js');
const { executeOsRequest } = await import('../../../src/mcp/invoke.js');
const { s256Challenge } = await import('../../../src/mcp/oauth/pkce.js');
const { resetMinuteWindows } = await import('../../../src/mcp/limits.js');
const { invalidatePauseCache } = await import('../../../src/mcp/oauth/tokens.js');

const db = globalThis.__mcpFakeDb;
const SECRET = process.env.JWT_ACCESS_SECRET;
const OWNER = { id: '11111111-1111-1111-1111-111111111111', email: 'owner@localwaves.test', role: 'OWNER', name: 'Test Owner', isActive: true, tokenVersion: 0, isAgent: false, avatarUrl: null, phone: null, timezone: 'UTC' };
const PM = { id: '22222222-2222-2222-2222-222222222222', email: 'pm@localwaves.test', role: 'PM', name: 'Test PM', isActive: true, tokenVersion: 0, isAgent: false, avatarUrl: null, phone: null, timezone: 'UTC' };
const TASK_ID = '99999999-9999-9999-9999-999999999991';
const SPA = 'http://localhost:5173';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'roundtrip-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const cfg = loadMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'http://localhost:3000/api/mcp', FRONTEND_URL: SPA });

const sessionJwt = (u) => jwt.sign({ sub: u.id, role: u.role, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });
const ACCEPT = 'application/json, text/event-stream';

let app;
let rpcId = 0;
async function rpc(token, method, params, headers = {}) {
  rpcId += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT, 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', ...headers },
    payload: { jsonrpc: '2.0', id: rpcId, method, params },
  });
  return res;
}
async function callTool(token, name, args = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const result = res.json().result;
  return { result, data: JSON.parse(result.content[0].text) };
}

async function authorizeAndToken(user = OWNER, scope = 'os:write') {
  const reg = await app.inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
  const clientId = reg.json().client_id;
  const auth = await app.inject({
    method: 'GET',
    url: `/api/mcp/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${s256Challenge(VERIFIER)}&code_challenge_method=S256&resource=${encodeURIComponent(cfg.resource)}`,
  });
  const rid = new URL(auth.headers.location).searchParams.get('rid');
  const dec = await app.inject({ method: 'POST', url: `/api/mcp/oauth/authorize/${rid}/decision`, headers: { authorization: `Bearer ${sessionJwt(user)}`, origin: SPA }, payload: { decision: 'allow', scope } });
  const code = new URL(dec.json().redirect_to).searchParams.get('code');
  const tok = await app.inject({
    method: 'POST',
    url: '/api/mcp/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: clientId, resource: cfg.resource }).toString(),
  });
  return { clientId, tokens: tok.json(), status: tok.statusCode };
}

beforeAll(async () => {
  db._tables.user.push({ ...OWNER }, { ...PM });
  db._tables.agencySetting.push({ id: 'as1', mcpPausedAt: null, mcpPausedById: null });
  db._tables.task.push({ id: TASK_ID, projectId: 'p1', title: 'Old task' });

  app = Fastify({ logger: false });
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  const collector = installMcpRouteCollector(app);
  app.addHook('preSerialization', async (request, _reply, payload) => redactResponseSecrets(payload, 0, responseDropKeys(request)));
  registerApiTokenHooks(app);
  // Same CORS plugin + settings shape as index.js (FRONTEND_URL origins, credentials).
  const { default: cors } = await import('@fastify/cors');
  await app.register(cors, { origin: [SPA], credentials: true });
  app.decorate('verifyJwt', verifyJwt);
  app.decorate('requireOwner', requireOwner);
  app.decorate('requirePM', requirePM);
  app.register(userRoutes, { prefix: '/api/users' });
  // Stand-ins for OS routes with their real guards.
  app.get('/api/admin/clients', { onRequest: [app.verifyJwt, app.requireOwner] }, async () => [
    { id: 'c1', agencyName: 'Oasis Dental', isActive: true, wpApiKey: 'wp-plugin-key', clientUsers: [{ user: { email: 'dr@oasis.test', password: 'x' } }] },
  ]);
  app.delete('/api/tasks/:id', { onRequest: [app.verifyJwt, app.requirePM] }, async (request, reply) => {
    const before = db._tables.task.length;
    db._tables.task = db._tables.task.filter((t) => t.id !== request.params.id);
    return before === db._tables.task.length ? reply.code(404).send({ message: 'Task not found' }) : reply.send({});
  });
  app.get('/api/test/echo-auth', { onRequest: [app.verifyJwt] }, async (request) => ({ viaMcp: request.viaMcp, mcpGrantId: request.mcpGrantId, authMethod: request.authMethod, tool: request.headers['x-mcp-tool'] }));
  registerMcp(app, { cfg, collector, db });
  app.register(adminMcpRoutes, { prefix: '/api/admin', cfg });
  await app.ready();
});
afterAll(() => app.close());

let owner;
describe('OAuth flow', () => {
  it('unauthenticated MCP call → 401 + WWW-Authenticate resource_metadata', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { accept: ACCEPT }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer realm="LocalWaves OS", resource_metadata="${cfg.resourceMetadataUrl}"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const bad = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer mcpa_nope', accept: ACCEPT }, payload: {} });
    expect(bad.headers['www-authenticate']).toMatch(/error="invalid_token"/);
  });

  it('CORS: /api/mcp preflight answers claude.ai (not only FRONTEND_URL); OAuth JSON is CORS *, no credentials', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/mcp', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://claude.ai');
    expect(pre.headers['access-control-allow-headers']).toMatch(/Authorization/);
    const evil = await app.inject({ method: 'OPTIONS', url: '/api/mcp', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const tokenPre = await app.inject({ method: 'OPTIONS', url: '/api/mcp/oauth/token', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } });
    expect(tokenPre.headers['access-control-allow-origin']).toBe('*');
    expect(tokenPre.headers['access-control-allow-credentials']).toBeUndefined();
    // Routes outside the MCP plugin keep the normal FRONTEND_URL CORS.
    const other = await app.inject({ method: 'OPTIONS', url: '/api/users/me', headers: { origin: SPA, 'access-control-request-method': 'GET' } });
    expect(other.headers['access-control-allow-origin']).toBe(SPA);
    expect(other.headers['access-control-allow-credentials']).toBe('true');
  });

  it('discovery documents are public, no-store, CORS *', async () => {
    const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/mcp' });
    expect(prm.statusCode).toBe(200);
    expect(prm.json().resource).toBe(cfg.resource);
    expect(prm.headers['cache-control']).toBe('no-store');
    expect(prm.headers['access-control-allow-origin']).toBe('*');
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(as.json().token_endpoint).toBe('http://localhost:3000/api/mcp/oauth/token');
  });

  it('register → authorize 302 to the SPA; bad redirect is a 400 page, bad PKCE redirects with error', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).not.toHaveProperty('client_secret');
    const clientId = reg.json().client_id;
    expect((await app.inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { redirect_uris: ['https://evil.example/cb'] } })).json().error).toBe('invalid_redirect_uri');
    const q = `client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1`;
    const noPkce = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize?response_type=code&${q}` });
    expect(noPkce.statusCode).toBe(302);
    expect(noPkce.headers.location).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request/);
    expect(noPkce.headers.location).toContain('state=s1');
    const wrongRedirect = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://claude.ai/other')}` });
    expect(wrongRedirect.statusCode).toBe(400);
    expect(wrongRedirect.headers.location).toBeUndefined();
    const ok = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize?response_type=code&${q}&code_challenge=${s256Challenge(VERIFIER)}&code_challenge_method=S256` });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toMatch(/^http:\/\/localhost:5173\/mcp\/authorize\?rid=/);
    const row = db._tables.mcpAuthRequest.at(-1);
    expect(ok.headers.location).not.toContain(row.codeChallenge);
  });

  it('consent: non-owner refused at context and decision; Origin enforced; deny path', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
    const clientId = reg.json().client_id;
    const auth = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s2&code_challenge=${s256Challenge(VERIFIER)}&code_challenge_method=S256` });
    const rid = new URL(auth.headers.location).searchParams.get('rid');
    const ctxPm = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize/${rid}`, headers: { authorization: `Bearer ${sessionJwt(PM)}` } });
    expect(ctxPm.statusCode).toBe(403);
    expect(ctxPm.json().code).toBe('MCP_ROLE_NOT_ALLOWED');
    const ctxOwner = await app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize/${rid}`, headers: { authorization: `Bearer ${sessionJwt(OWNER)}` } });
    expect(ctxOwner.statusCode).toBe(200);
    expect(ctxOwner.json()).toMatchObject({ client: { name: 'Claude', redirectHost: 'claude.ai' }, requestedScope: 'os:read os:write', user: { role: 'OWNER' }, paused: false });
    expect(JSON.stringify(ctxOwner.json())).not.toMatch(/codeChallenge|state|auth_callback/);
    const pmAllow = await app.inject({ method: 'POST', url: `/api/mcp/oauth/authorize/${rid}/decision`, headers: { authorization: `Bearer ${sessionJwt(PM)}`, origin: SPA }, payload: { decision: 'allow' } });
    expect(pmAllow.statusCode).toBe(403);
    const noOrigin = await app.inject({ method: 'POST', url: `/api/mcp/oauth/authorize/${rid}/decision`, headers: { authorization: `Bearer ${sessionJwt(OWNER)}` }, payload: { decision: 'allow' } });
    expect(noOrigin.json().code).toBe('MCP_BAD_ORIGIN');
    const deny = await app.inject({ method: 'POST', url: `/api/mcp/oauth/authorize/${rid}/decision`, headers: { authorization: `Bearer ${sessionJwt(OWNER)}`, origin: SPA }, payload: { decision: 'deny' } });
    expect(deny.json().redirect_to).toBe(`${REDIRECT}?error=access_denied&error_description=The+user+denied+access&state=s2&iss=http%3A%2F%2Flocalhost%3A3000`);
    expect(db._tables.mcpGrant).toHaveLength(0);
  });

  it('allow → grant + code (hash only) → token exchange (form-encoded)', async () => {
    owner = await authorizeAndToken(OWNER);
    expect(owner.status).toBe(200);
    expect(owner.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'os:read os:write' });
    expect(owner.tokens.access_token).toMatch(/^mcpa_/);
    expect(owner.tokens.refresh_token).toMatch(/^mcpr_/);
    const stored = JSON.stringify(db._tables);
    expect(stored).not.toContain(owner.tokens.access_token);
    expect(stored).not.toContain(owner.tokens.refresh_token);
    expect(db._tables.mcpAuditLog.find((a) => a.tool === 'oauth.consent')).toMatchObject({ danger: 'auth', ok: true, userId: OWNER.id });
  });
});

describe('MCP over Streamable HTTP (stateless JSON, app.inject, no hijack)', () => {
  it('initialize → tools/list', async () => {
    const init = await rpc(owner.tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toMatch(/application\/json/);
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(init.json().result.serverInfo).toEqual({ name: 'localwaves-os', version: '1.0.0' });
    expect(init.json().result.instructions).toMatch(/confirm_action/);
    const list = await rpc(owner.tokens.access_token, 'tools/list', {});
    const names = list.json().result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'confirm_action', 'os_api_request', 'os_client_get', 'os_clients_list', 'os_overview', 'os_project_get', 'os_projects_list',
      'os_route_describe', 'os_route_search', 'os_task_comment', 'os_task_create', 'os_task_get', 'os_task_status', 'os_task_update', 'os_tasks_list', 'os_whoami',
    ]);
    const whoami = list.json().result.tools.find((t) => t.name === 'os_whoami');
    expect(whoami.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(list.json().result.tools.find((t) => t.name === 'confirm_action').annotations.destructiveHint).toBe(true);
    for (const t of list.json().result.tools) expect(t.description.length).toBeLessThanOrEqual(300);
  });

  it('GET/DELETE /api/mcp → 405; notifications → 202', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mcp' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'DELETE', url: '/api/mcp' })).json().error.code).toBe(-32000);
    const note = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${owner.tokens.access_token}`, accept: ACCEPT, 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(note.statusCode).toBe(202);
  });

  it('os_whoami runs GET /api/users/me through the real guard with the internal JWT', async () => {
    const { result, data } = await callTool(owner.tokens.access_token, 'os_whoami');
    expect(result.isError).toBeUndefined();
    expect(data.user).toMatchObject({ id: OWNER.id, role: 'OWNER' });
    expect(data.connection).toMatchObject({ app: 'Claude', scope: 'os:read os:write' });
    expect(result.structuredContent).toEqual(data);
  });

  it('internal requests carry via:mcp + grant id (verifyJwt) and the x-mcp-tool header', async () => {
    const { data } = await callTool(owner.tokens.access_token, 'os_api_request', { method: 'GET', path: '/api/test/echo-auth' });
    expect(data.body).toEqual({ viaMcp: true, mcpGrantId: db._tables.mcpGrant.at(-1).id, authMethod: 'jwt', tool: 'os_api_request' });
  });

  it('os_api_request GET masks secrets twice (global wpApiKey redaction + MCP mask)', async () => {
    const { data } = await callTool(owner.tokens.access_token, 'os_api_request', { method: 'GET', path: '/api/admin/clients' });
    expect(data.status).toBe(200);
    expect(data.body.items[0].wpApiKey).toBe('[REDACTED]');
    expect(data.body.items[0].clientUsers[0].user.password).toBe('[REDACTED]');
  });

  it('blocked routes and unknown routes are tool errors; an mcpa_ token on a normal route is 401', async () => {
    const blocked = await callTool(owner.tokens.access_token, 'os_api_request', { method: 'GET', path: '/api/admin/mcp/status' });
    expect(blocked.result.isError).toBe(true);
    expect(blocked.data).toMatchObject({ code: 'BLOCKED', error: 'This route is not available through MCP' });
    const missing = await callTool(owner.tokens.access_token, 'os_api_request', { method: 'GET', path: '/api/nope' });
    expect(missing.data.code).toBe('NOT_FOUND');
    const direct = await app.inject({ method: 'GET', url: '/api/users/me', headers: { authorization: `Bearer ${owner.tokens.access_token}` } });
    expect(direct.statusCode).toBe(401);
  });

  it('dangerous DELETE → preview + confirm token, not executed; confirm_action executes the stored args once', async () => {
    const first = await callTool(owner.tokens.access_token, 'os_api_request', { method: 'DELETE', path: `/api/tasks/${TASK_ID}` });
    expect(first.data).toMatchObject({ status: 'confirmation_required', expires_in: 300, preview: { method: 'DELETE', routePattern: '/api/tasks/:id', reasons: ['delete'] } });
    expect(db._tables.task.some((t) => t.id === TASK_ID)).toBe(true);
    const token = first.data.confirm_token;
    expect(JSON.stringify(db._tables.mcpConfirmation)).not.toContain(token);
    const done = await callTool(owner.tokens.access_token, 'confirm_action', { confirm_token: token });
    expect(done.result.isError).toBeUndefined();
    expect(done.data).toMatchObject({ confirmed: true, tool: 'os_api_request', result: { status: 200 } });
    expect(db._tables.task.some((t) => t.id === TASK_ID)).toBe(false);
    const again = await callTool(owner.tokens.access_token, 'confirm_action', { confirm_token: token });
    expect(again.data.code).toBe('CONFIRM_USED');
  });

  it('audit rows: one per call, confirmed flag, no token or response body anywhere', async () => {
    const rows = db._tables.mcpAuditLog.filter((r) => r.tool !== 'oauth.consent');
    expect(rows.map((r) => r.tool)).toEqual(expect.arrayContaining(['os_whoami', 'os_api_request', 'confirm_action']));
    const confirmRow = rows.find((r) => r.tool === 'confirm_action' && r.ok);
    expect(confirmRow).toMatchObject({ confirmed: true, danger: 'dangerous', routeMethod: 'DELETE', routePattern: '/api/tasks/:id', statusCode: 200 });
    expect(confirmRow.confirmationId).toBeTruthy();
    const preview = rows.find((r) => r.errorCode === 'CONFIRMATION_REQUIRED');
    expect(preview).toMatchObject({ danger: 'dangerous', ok: true, confirmed: false });
    const blocked = rows.find((r) => r.errorCode === 'BLOCKED');
    expect(blocked).toMatchObject({ danger: 'blocked', ok: false });
    const all = JSON.stringify(db._tables.mcpAuditLog);
    expect(all).not.toMatch(/mcpa_|mcpr_|mcpx_|wp-plugin-key|dr@oasis/);
  });

  it('guards are preserved: a PM context gets the requireOwner 403 as a tool error', async () => {
    const out = await executeOsRequest(
      { app, cfg, db, catalog: { match: () => ({ entry: { path: '/api/admin/clients' }, params: {} }) }, user: PM, grant: { id: 'g-pm' }, scope: 'os:read os:write', ip: '127.0.0.1' },
      { method: 'GET', path: '/api/admin/clients', toolName: 'os_api_request' }
    );
    expect(out).toMatchObject({ kind: 'error', statusCode: 403, code: 'HTTP_403', message: 'Admin access required' });
  });

  it('a real SDK Client negotiates over a listening port (JSON mode, stateless)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'roundtrip', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', address), { requestInit: { headers: { Authorization: `Bearer ${owner.tokens.access_token}` } } });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(16);
    const res = await client.callTool({ name: 'os_whoami', arguments: {} });
    expect(JSON.parse(res.content[0].text).user.role).toBe('OWNER');
    await client.close();
  });
});

describe('kill switches, refresh rotation, revocation', () => {
  it('pause → 503 MCP_PAUSED; resume → works again', async () => {
    const ownerSession = { authorization: `Bearer ${sessionJwt(OWNER)}` };
    expect((await app.inject({ method: 'POST', url: '/api/admin/mcp/pause', headers: ownerSession })).json().paused).toBe(true);
    const paused = await rpc(owner.tokens.access_token, 'tools/list', {});
    expect(paused.statusCode).toBe(503);
    expect(paused.json().code).toBe('MCP_PAUSED');
    const status = await app.inject({ method: 'GET', url: '/api/admin/mcp/status', headers: ownerSession });
    expect(status.json()).toMatchObject({ enabled: true, paused: true, pausedBy: { id: OWNER.id } });
    expect((await app.inject({ method: 'POST', url: '/api/admin/mcp/pause', headers: { authorization: `Bearer ${sessionJwt(PM)}` } })).statusCode).toBe(403);
    await app.inject({ method: 'POST', url: '/api/admin/mcp/resume', headers: ownerSession });
    expect((await rpc(owner.tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
  });

  it('per-minute limit per grant answers a tool error', async () => {
    resetMinuteWindows();
    const tight = { ...cfg, ratePerMin: 1 };
    const { runTool } = await import('../../../src/mcp/server.js');
    const ctx = { app, cfg: tight, db, catalog: null, user: OWNER, grant: { id: 'g-limit', clientId: 'c' }, scope: 'os:read', ip: '1.2.3.4' };
    const tool = { name: 'os_route_search', run: async () => ({ kind: 'result', danger: 'read', payload: { routes: [] } }) };
    expect((await runTool(ctx, tool, { query: 'x' })).isError).toBeUndefined();
    const limited = await runTool(ctx, tool, { query: 'x' });
    expect(limited.isError).toBe(true);
    expect(JSON.parse(limited.content[0].text).code).toBe('RATE_LIMITED');
    resetMinuteWindows();
  });

  it('refresh rotates (same family); reusing the old refresh token revokes the grant', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: owner.tokens.refresh_token, client_id: owner.clientId } });
    expect(r1.statusCode).toBe(200);
    const next = r1.json();
    expect(next.refresh_token).not.toBe(owner.tokens.refresh_token);
    const fam = db._tables.mcpToken.filter((t) => t.kind === 'refresh' && t.grantId === db._tables.mcpGrant.at(-1).id).map((t) => t.familyId);
    expect(new Set(fam).size).toBe(1);
    // old access token was retired with the rotation; the new one works
    expect((await rpc(owner.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
    expect((await rpc(next.access_token, 'tools/list', {})).statusCode).toBe(200);
    const reuse = await app.inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: owner.tokens.refresh_token, client_id: owner.clientId } });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe('invalid_grant');
    expect(db._tables.mcpGrant.at(-1).revokedReason).toBe('refresh_reuse');
    expect((await rpc(next.access_token, 'tools/list', {})).statusCode).toBe(401);
    expect(db._tables.mcpAuditLog.some((a) => a.tool === 'oauth.refresh_reuse')).toBe(true);
  });

  it('code replay revokes the grant; owner revoke-all is immediate; tokenVersion bump kills access', async () => {
    const fresh = await authorizeAndToken(OWNER);
    expect((await rpc(fresh.tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
    // a tokenVersion bump (password reset) invalidates the grant
    db._tables.user.find((u) => u.id === OWNER.id).tokenVersion = 1;
    expect((await rpc(fresh.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
    db._tables.user.find((u) => u.id === OWNER.id).tokenVersion = 0;
    expect((await rpc(fresh.tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
    const all = await app.inject({ method: 'POST', url: '/api/admin/mcp/grants/revoke-all', headers: { authorization: `Bearer ${sessionJwt(OWNER)}` } });
    expect(all.json().revoked).toBeGreaterThanOrEqual(1);
    expect((await rpc(fresh.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
    const grants = await app.inject({ method: 'GET', url: '/api/admin/mcp/grants?state=all', headers: { authorization: `Bearer ${sessionJwt(OWNER)}` } });
    expect(grants.json().every((g) => g.state === 'revoked')).toBe(true);
    expect(JSON.stringify(grants.json())).not.toMatch(/tokenHash|codeHash|clientSecretHash/);
    const audit = await app.inject({ method: 'GET', url: '/api/admin/mcp/audit?danger=dangerous&limit=5', headers: { authorization: `Bearer ${sessionJwt(OWNER)}` } });
    expect(audit.json().items.every((r) => r.danger === 'dangerous')).toBe(true);
    invalidatePauseCache();
  });

  it('retention purge runs plain conditional deletes', async () => {
    const out = await purgeMcpRecords(cfg, { db, now: new Date(Date.now() + 400 * 86_400_000) });
    expect(out.audit).toBeGreaterThan(0);
    expect(db._tables.mcpAuditLog).toHaveLength(0);
  });
});
