/**
 * confirm_action: executes a dangerous / critical request previously previewed (features/mcp-server.md §Tools).
 * The confirm token is single use (CAS on consumedAt), bound to the same user and grant, and the stored arguments
 * must still hash to argsHash. Only the STORED request runs, never caller-supplied arguments. Blocked and scope
 * checks run again; the pause switch is checked per MCP request before any tool runs.
 * Critical confirmations (level 'critical', MCP_CRITICAL_APPROVAL on) also need `approvedAt`, set only by the owner on
 * /portal/admin/mcp through a normal human session: until then confirm_action answers `approval_pending` with the
 * link and does not consume the token. The stored args are cleared when the confirmation is consumed (review L3).
 */
import { z } from 'zod';
import { canonicalJson } from '../../lib/idempotency.js';
import { approvalUrl, executeOsRequest } from '../invoke.js';
import { looksLikeSecret, PREFIX, sameHash, sha256Hex } from '../oauth/tokens.js';

/**
 * Loads and claims a confirmation. Returns { ok:true, row } | { ok:false, pending:true, row } (owner approval
 * outstanding) | { ok:false, code, message }.
 */
export async function claimConfirmation(db, { token, userId, grantId, requireApproval = true, now = new Date() }) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!looksLikeSecret(token, PREFIX.confirm)) return fail('CONFIRM_INVALID', 'Unknown confirm token');
  const hash = sha256Hex(token);
  const row = await db.mcpConfirmation.findUnique({ where: { tokenHash: hash } });
  if (!row || !sameHash(row.tokenHash, hash)) return fail('CONFIRM_INVALID', 'Unknown confirm token');
  if (row.userId !== userId || row.grantId !== grantId) return fail('CONFIRM_INVALID', 'This confirm token belongs to another connection');
  if (row.consumedAt) return fail('CONFIRM_USED', 'This action was already confirmed or was denied (confirm tokens are single use)');
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return fail('CONFIRM_EXPIRED', 'This confirm token expired; preview the action again');
  if (sha256Hex(canonicalJson(row.args)) !== row.argsHash) return fail('CONFIRM_INVALID', 'Stored action does not match its preview');
  const approvalNeeded = requireApproval && row.level === 'critical';
  if (approvalNeeded && !row.approvedAt) return { ok: false, pending: true, row };
  const claimed = await db.mcpConfirmation.updateMany({
    where: { id: row.id, consumedAt: null, ...(approvalNeeded ? { approvedAt: { not: null } } : {}) },
    data: { consumedAt: now, args: {} },
  });
  if (claimed.count !== 1) return fail('CONFIRM_USED', 'This action was already confirmed or was denied (confirm tokens are single use)');
  return { ok: true, row };
}

/** `project(toolName, toolArgs, body, outcome)` shapes the result like the original tool would. */
export function confirmTool(project) {
  return {
    name: 'confirm_action',
    title: 'Confirm a previewed action',
    description: 'Executes an action previously previewed (status confirmation_required). Show the user the preview and ask first. Critical actions answer approval_pending until the owner approves them in the OS. Single use.',
    input: { confirm_token: z.string().min(10).max(200) },
    annotations: { title: 'Confirm a previewed action', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (ctx, args) => {
      const claim = await claimConfirmation(ctx.db, { token: args.confirm_token, userId: ctx.user.id, grantId: ctx.grant.id, requireApproval: ctx.cfg.criticalApproval !== false });
      if (claim.pending) {
        const r = claim.row;
        return {
          kind: 'result',
          danger: 'critical',
          confirmationId: r.id,
          route: r.routeKey ? { method: r.routeKey.split(' ')[0], pattern: r.routeKey.split(' ')[1], path: r.preview?.path } : undefined,
          auditCode: 'APPROVAL_PENDING',
          payload: {
            status: 'approval_pending',
            approve_url: approvalUrl(ctx.cfg, r.id),
            expires_at: r.expiresAt,
            next: 'This action is critical. Ask the owner to open approve_url, check the action and click Approve in the OS; then call confirm_action again with the same confirm_token. Nothing has run yet.',
          },
        };
      }
      if (!claim.ok) return { kind: 'error', code: claim.code, statusCode: 400, message: claim.message, danger: 'dangerous' };
      const { row } = claim;
      const stored = row.args || {};
      const req = stored.request || {};
      const out = await executeOsRequest(
        ctx,
        { method: req.method, path: req.path, query: req.query ?? undefined, body: req.body ?? undefined, idempotencyKey: req.idempotencyKey ?? undefined, toolName: stored.tool || 'os_api_request' },
        { confirmed: true }
      );
      const audit = { confirmed: true, confirmationId: row.id, auditArgs: req.body ?? null };
      if (out.kind !== 'result') return { ...out, ...audit };
      return { ...out, ...audit, payload: { confirmed: true, tool: stored.tool, result: project(stored.tool, stored.toolArgs || {}, out.body, out) } };
    },
  };
}
