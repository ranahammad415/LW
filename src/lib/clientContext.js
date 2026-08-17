/**
 * Helpers for resolving which client account a request is acting on.
 * Use after requireClient, which populates clientAccountIds / clientUserRoles.
 */
import { prisma } from './prisma.js';

/**
 * Resolves the client id the request should operate on: the primary-contact
 * link when the user has one, otherwise the first linked client. When an
 * X-Client-Id header narrowed the scope, that is the only candidate.
 */
export function resolvePrimaryClientId(request) {
  const clientIds = request.clientAccountIds || [];
  if (clientIds.length === 0) return null;

  const primaryLink = (request.clientUserRoles || []).find((cu) => cu.isPrimaryContact);
  return primaryLink && clientIds.includes(primaryLink.clientId)
    ? primaryLink.clientId
    : clientIds[0];
}

export async function resolvePrimaryClient(request) {
  const clientId = resolvePrimaryClientId(request);
  if (!clientId) return null;
  return prisma.clientAccount.findUnique({ where: { id: clientId } });
}
