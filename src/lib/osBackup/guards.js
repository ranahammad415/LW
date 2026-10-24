/**
 * OS Backups guards (plan h). Every /api/admin/os-backups route is HUMAN_ONLY:
 *   - request.viaMcp (set by the MCP server once that branch is merged) → 403 HUMAN_ONLY, always, before anything else;
 *   - requireHumanOwner (after verifyJwt): role OWNER, authMethod 'jwt', no API token, not an agent account;
 *   - requireSameOrigin (state-changing routes): Origin must be one of FRONTEND_URL (dev without FRONTEND_URL: allowed).
 */
export const HUMAN_ONLY_MESSAGE = 'Restore and backup actions are only available to a signed-in owner in the OS';

export function denyViaMcp(request, reply) {
  if (request.viaMcp) {
    reply.status(403).send({ code: 'HUMAN_ONLY', message: HUMAN_ONLY_MESSAGE });
    return true;
  }
  return false;
}

/** onRequest hook that runs before verifyJwt (cheap, no DB). */
export async function humanOnly(request, reply) {
  if (denyViaMcp(request, reply)) return reply;
}

export async function requireHumanOwner(request, reply) {
  if (denyViaMcp(request, reply)) return reply;
  const u = request.user;
  const ok = u && u.role === 'OWNER' && request.authMethod === 'jwt' && !request.apiToken && !request.viaMcp && u.isAgent !== true;
  if (!ok) return reply.status(403).send({ code: 'HUMAN_ONLY', message: HUMAN_ONLY_MESSAGE });
}

export function allowedOrigins(env = process.env) {
  return String(env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export async function requireSameOrigin(request, reply) {
  const allowed = allowedOrigins();
  if (!allowed.length && process.env.NODE_ENV !== 'production') return;
  const origin = String(request.headers.origin || '').replace(/\/$/, '');
  if (!origin || !allowed.includes(origin)) return reply.status(403).send({ code: 'BAD_ORIGIN', message: 'This action must come from the Agency OS app' });
}
