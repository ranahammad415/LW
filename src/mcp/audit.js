/**
 * McpAuditLog writer: one row per tool call, OAuth consent / refresh reuse / revoke, and blocked attempt.
 * Never stores a token or a response body. Failures are logged, never thrown (an audit outage must not break a call
 * that already ran, and the per-hour limit counts these rows).
 */
import { redactSensitiveUrl } from '../lib/logRedaction.js';
import { summarizeArgs } from './redact.js';

function cut(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : v ?? null;
}

export function buildAuditRow(entry) {
  return {
    grantId: entry.grantId ?? null,
    userId: String(entry.userId),
    clientId: entry.clientId ?? null,
    tool: cut(entry.tool, 64),
    routeMethod: cut(entry.routeMethod, 8),
    routePattern: cut(entry.routePattern, 200),
    path: entry.path ? cut(redactSensitiveUrl(entry.path), 500) : null,
    argsSummary: entry.args === undefined ? null : summarizeArgs(entry.args),
    danger: entry.danger || 'read',
    confirmed: entry.confirmed === true,
    confirmationId: entry.confirmationId ?? null,
    statusCode: Number.isInteger(entry.statusCode) ? entry.statusCode : null,
    ok: entry.ok === true,
    errorCode: cut(entry.errorCode, 64),
    durationMs: Math.max(0, Math.round(entry.durationMs || 0)),
    resultBytes: Math.max(0, Math.round(entry.resultBytes || 0)),
    truncated: entry.truncated === true,
    ip: cut(entry.ip, 64),
  };
}

export async function writeAudit(db, entry, log) {
  if (!entry?.userId) return null;
  try {
    return await db.mcpAuditLog.create({ data: buildAuditRow(entry), select: { id: true } });
  } catch (err) {
    log?.warn?.({ err: err?.message, tool: entry.tool }, 'mcp audit write failed');
    return null;
  }
}
