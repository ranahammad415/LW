/**
 * Agent / API-token policy (SEO Engine OS-09 and "agents author, never approve").
 *
 * - Workers on an API token (TEAM_MEMBER / CONTRACTOR), and worker accounts flagged isAgent, may only move tasks
 *   they are assigned to, and only to IN_PROGRESS or NEEDS_REVIEW.
 * - No agent account and no API token (any role, including the Engine PM service account) may set COMPLETED or
 *   CANCELLED: completion is a human review decision.
 * - No agent account and no API token may approve, reject, review or publish anything (rejectAgentReviewer hook).
 * Human JWT sessions keep their existing rules.
 */
import { isAgentOrToken, isWorkerApiToken } from './apiTokens.js';

export const WORKER_AGENT_STATUSES = ['IN_PROGRESS', 'NEEDS_REVIEW'];
export const HUMAN_ONLY_STATUSES = ['COMPLETED', 'CANCELLED'];

function isWorkerRole(role) {
  return role === 'TEAM_MEMBER' || role === 'CONTRACTOR';
}

/**
 * Extra status-change rules for agents and API tokens. Returns null when allowed, else { status, message }.
 * Call after the route's normal canUpdate check.
 */
export function checkAgentStatusChange(request, { status, isAssignee }) {
  const user = request?.user;
  const workerAgent = isWorkerApiToken(request) || (user?.isAgent === true && isWorkerRole(user?.role));
  if (workerAgent) {
    if (!isAssignee) return { status: 403, message: 'You can only update tasks assigned to you' };
    if (!WORKER_AGENT_STATUSES.includes(status)) {
      return { status: 403, message: `This account can only set ${WORKER_AGENT_STATUSES.join(' or ')}` };
    }
  }
  if (isAgentOrToken(request) && HUMAN_ONLY_STATUSES.includes(status)) {
    return { status: 403, message: `${status} can only be set by a person in the OS` };
  }
  return null;
}

/** onRequest hook (after verifyJwt): approval / review / publish routes are human-only. */
export async function rejectAgentReviewer(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ message: 'Agent accounts and API tokens cannot approve, review or publish' });
  }
}
