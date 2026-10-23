/**
 * Generic and meta MCP tools: os_route_search, os_route_describe, os_api_request (features/mcp-server.md §Tools).
 * os_api_request reaches any OS route through the same guards, danger gate and audit as the curated tools.
 */
import { z } from 'zod';
import { executeOsRequest, resolveRoute } from '../invoke.js';
import { applyFieldsLimit } from '../redact.js';

const METHOD = z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function projectGeneric(body, args = {}, meta = {}) {
  return {
    status: meta.statusCode ?? 200,
    ...(meta.idempotentReplayed ? { headers: { 'idempotent-replayed': 'true' } } : {}),
    body: applyFieldsLimit(body, { fields: args.fields, limit: args.limit }),
  };
}

export const GENERIC_TOOLS = [
  {
    name: 'os_route_search',
    title: 'Search OS routes',
    description: 'Find OS API routes by keywords (path + purpose). Returns method, path, guard, purpose and danger level. Use before os_api_request.',
    input: {
      query: z.string().min(1).max(200),
      method: METHOD.optional(),
      area: z.enum(['admin', 'pm', 'client', 'projects', 'tasks', 'staff']).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    },
    annotations: { title: 'Search OS routes', ...RO },
    local: true,
    run: async (ctx, args) => ({ kind: 'result', danger: 'read', payload: { routes: ctx.catalog.search(args.query, args) } }),
  },
  {
    name: 'os_route_describe',
    title: 'Describe an OS route',
    description: 'Details for one route (pattern or concrete path): guard, purpose, danger level and reasons, whether confirm_action is needed, scope required.',
    input: { method: METHOD, path: z.string().min(1).max(500) },
    annotations: { title: 'Describe an OS route', ...RO },
    local: true,
    run: async (ctx, args) => {
      const entry = ctx.catalog.byPattern(args.method, args.path)
        || (() => {
          const r = args.path.startsWith('/api/') ? resolveRoute(ctx.app, ctx.catalog, args.method, args.path) : null;
          return r ? ctx.catalog.byPattern(args.method, r.pattern) : null;
        })();
      if (!entry) return { kind: 'error', code: 'NOT_FOUND', statusCode: 404, message: `No route ${args.method} ${args.path}`, danger: 'read' };
      return { kind: 'result', danger: 'read', payload: ctx.catalog.describe(entry) };
    },
  },
  {
    name: 'os_api_request',
    title: 'Call an OS API route',
    description:
      'Call any OS route as the signed-in user (same permissions as the web app). Prefer the curated tools; use os_route_search first. GET is free; dangerous calls return a preview and confirm_token for confirm_action. fields/limit shrink list results.',
    input: {
      method: METHOD,
      path: z.string().min(5).max(500).describe('Concrete path starting with /api/, e.g. /api/tasks/<id>/comments'),
      query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional(),
      body: z.union([z.record(z.any()), z.array(z.any())]).optional(),
      idempotencyKey: z.string().min(1).max(200).regex(/^[\x21-\x7E]+$/).optional(),
      fields: z.array(z.string().max(64)).max(40).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { title: 'Call an OS API route', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (ctx, args) => {
      const out = await executeOsRequest(
        ctx,
        { method: args.method, path: args.path, query: args.query, body: args.body, idempotencyKey: args.idempotencyKey, toolName: 'os_api_request' },
        { toolArgs: { fields: args.fields, limit: args.limit } }
      );
      if (out.kind !== 'result') return out;
      return { ...out, payload: projectGeneric(out.body, args, out) };
    },
  },
];
