/**
 * Builds one McpServer per POST /api/mcp (stateless transport; the tool registry is static). Every tool call is
 * rate limited per grant, timed, size-capped and written to McpAuditLog (features/mcp-server.md).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CURATED_TOOLS, PROJECTIONS } from './tools/curated.js';
import { GENERIC_TOOLS, projectGeneric } from './tools/generic.js';
import { confirmTool } from './tools/confirm.js';
import { checkMcpLimits } from './limits.js';
import { capResult } from './redact.js';
import { writeAudit } from './audit.js';

export const SERVER_INFO = { name: 'localwaves-os', version: '1.0.0' };

export const INSTRUCTIONS = [
  'LocalWaves Agency OS: the agency\'s clients, projects, monthly task cycles, content reviews, SEO and reports.',
  'You act as the signed-in OS user with exactly their web-app permissions.',
  'Read first (os_whoami, os_overview, list/get tools). For anything without a tool, use os_route_search, then os_api_request.',
  'Dangerous actions (deletes, completing/cancelling tasks, sends, publishes, people/plan changes, paid runs) return status',
  '"confirmation_required" with a preview: show it to the user, ask, and only then call confirm_action.',
  'Never guess ids: look them up with a list or search tool.',
].join(' ');

function projectFor(toolName, toolArgs, body, outcome, ctx) {
  const p = PROJECTIONS[toolName];
  if (p) return p(body, toolArgs, ctx);
  return projectGeneric(body, toolArgs, outcome);
}

export const ALL_TOOLS = [...CURATED_TOOLS, ...GENERIC_TOOLS];

function errorResult(payload) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Runs one tool for ctx: limits → run → shape → audit. Exported for tests. */
export async function runTool(ctx, tool, args) {
  const started = Date.now();
  const lim = await checkMcpLimits(ctx.db, ctx.grant.id, ctx.cfg);
  if (!lim.ok) {
    await writeAudit(ctx.db, { grantId: ctx.grant.id, userId: ctx.user.id, clientId: ctx.grant.clientId, tool: tool.name, args, danger: 'read', ok: false, errorCode: 'RATE_LIMITED', statusCode: 429, ip: ctx.ip }, ctx.log);
    return errorResult({ error: lim.message, code: 'RATE_LIMITED', retryAfterSec: lim.retryAfterSec });
  }
  let out;
  try {
    out = await tool.run(ctx, args || {});
  } catch (err) {
    ctx.log?.error?.({ err: err?.message, tool: tool.name }, 'mcp tool failed');
    out = { kind: 'error', code: 'INTERNAL', statusCode: 500, message: 'The MCP tool failed', danger: 'read' };
  }
  let result;
  let bytes = 0;
  let truncated = false;
  if (out.kind === 'error') {
    const payload = { error: out.message, code: out.code, status: out.statusCode ?? null, ...(out.osCode ? { osCode: out.osCode } : {}), ...(out.reasons ? { reasons: out.reasons } : {}) };
    result = errorResult(payload);
    bytes = Buffer.byteLength(result.content[0].text);
  } else {
    const cap = capResult(out.payload, ctx.cfg.maxResultBytes);
    bytes = cap.bytes;
    truncated = cap.truncated;
    result = { content: [{ type: 'text', text: cap.text }] };
    if (!cap.truncated && out.payload && typeof out.payload === 'object' && !Array.isArray(out.payload)) result.structuredContent = out.payload;
  }
  await writeAudit(
    ctx.db,
    {
      grantId: ctx.grant.id,
      userId: ctx.user.id,
      clientId: ctx.grant.clientId,
      tool: tool.name,
      routeMethod: out.route?.method,
      routePattern: out.route?.pattern,
      path: out.route?.path,
      args: out.auditArgs !== undefined ? out.auditArgs : args,
      danger: out.danger || 'read',
      confirmed: out.confirmed === true,
      confirmationId: out.confirmationId ?? null,
      statusCode: out.statusCode ?? (out.kind === 'confirm' ? 202 : null),
      ok: out.kind !== 'error',
      errorCode: out.kind === 'error' ? out.code : out.kind === 'confirm' ? 'CONFIRMATION_REQUIRED' : null,
      durationMs: Date.now() - started,
      resultBytes: bytes,
      truncated,
      ip: ctx.ip,
    },
    ctx.log
  );
  return result;
}

/** A fresh McpServer with every Phase 1 tool bound to ctx (one per request: stateless transport). */
export function buildMcpServer(ctx) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const tools = [...ALL_TOOLS, confirmTool((name, toolArgs, body, outcome) => projectFor(name, toolArgs, body, outcome, ctx))];
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args) => runTool(ctx, tool, args)
    );
  }
  return server;
}
