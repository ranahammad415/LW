/**
 * POST /api/mcp: Streamable HTTP, stateless (no session id) and JSON responses (no SSE), so any PM2 instance can
 * answer any request and nothing is buffered behind Cloudflare. Uses the SDK's web-standard transport: the Fastify
 * request becomes a fetch Request, the transport returns a fetch Response, and Fastify sends it normally
 * (no reply.hijack, so the global hooks, rate limit and helmet headers still apply).
 * GET and DELETE answer 405 (no standalone SSE stream, no sessions to end).
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from './server.js';
import { verifyMcpBearer } from './oauth/tokens.js';

const ALLOW_HEADERS = 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID';

/** CORS + cache headers for /api/mcp (claude.ai, claude.com and FRONTEND_URL origins; MCP_CORS_ORIGINS). */
export function mcpCorsHeaders(request, reply, cfg) {
  reply.header('Cache-Control', 'no-store');
  reply.header('Vary', 'Origin');
  const origin = request.headers.origin;
  if (origin && cfg.corsOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    reply.removeHeader('Access-Control-Allow-Credentials');
  }
}

/** WWW-Authenticate for a 401 from /api/mcp (RFC 6750 + RFC 9728 resource_metadata). */
export function wwwAuthenticate(cfg, { error = null, description = null } = {}) {
  let v = `Bearer realm="LocalWaves OS", resource_metadata="${cfg.resourceMetadataUrl}"`;
  if (error) v += `, error="${error}"`;
  if (error && description) v += `, error_description="${String(description).replace(/"/g, "'")}"`;
  return v;
}

function jsonRpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** Runs one JSON-RPC POST through a fresh server + transport. Returns { status, headers, text }. */
export async function handleMcpPost(ctx, request) {
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (k === 'authorization' || k === 'cookie' || v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    const url = new URL(request.url, ctx.cfg.issuer || 'http://localhost').toString();
    const webReq = new Request(url, { method: 'POST', headers });
    const res = await transport.handleRequest(webReq, { parsedBody: request.body });
    const out = { status: res.status, headers: {}, text: res.status === 202 || res.body === null ? '' : await res.text() };
    res.headers.forEach((value, key) => {
      if (key === 'content-type' || key === 'mcp-session-id' || key === 'allow') out.headers[key] = value;
    });
    return out;
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function mcpEndpointRoutes(app, { cfg, db, rootApp, getCatalog }) {
  const preflight = async (request, reply) => {
    mcpCorsHeaders(request, reply, cfg);
    return reply.code(204).send();
  };
  // config.cors false: these routes set their own CORS headers (@fastify/cors would answer the preflight itself with
  // FRONTEND_URL origins only).
  app.options('/api/mcp', { config: { cors: false } }, preflight);

  app.post('/api/mcp', { bodyLimit: 262_144, config: { cors: false, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    mcpCorsHeaders(request, reply, cfg);
    const auth = await verifyMcpBearer(db, request, cfg);
    if (!auth.ok) {
      if (auth.status === 401) reply.header('WWW-Authenticate', wwwAuthenticate(cfg, auth));
      if (auth.status === 403) reply.header('WWW-Authenticate', wwwAuthenticate(cfg, { error: 'insufficient_scope', description: auth.description }));
      return reply.code(auth.status).send({ error: auth.error || (auth.status === 401 ? 'unauthorized' : 'forbidden'), error_description: auth.description, ...(auth.code ? { code: auth.code } : {}) });
    }
    const ctx = { ...auth.ctx, app: rootApp, cfg, db, catalog: getCatalog(), ip: request.ip, log: request.log };
    const out = await handleMcpPost(ctx, request);
    reply.code(out.status);
    for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
    if (!out.text) return reply.send();
    if (!out.headers['content-type']) reply.type('application/json');
    return reply.send(out.text);
  });

  const notAllowed = async (request, reply) => {
    mcpCorsHeaders(request, reply, cfg);
    reply.header('Allow', 'POST');
    return reply.code(405).send(jsonRpcError(-32000, 'Method not allowed: this server is stateless and answers POST only'));
  };
  app.get('/api/mcp', { config: { cors: false } }, notAllowed);
  app.delete('/api/mcp', { config: { cors: false } }, notAllowed);
}
