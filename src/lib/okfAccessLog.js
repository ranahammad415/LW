/**
 * OKF access / mutation audit trail.
 *
 * The upstream implementation wrote to a dedicated agentOkfAccessLog table tied
 * to agent runs. This portal has no agent-run system, so entries are recorded on
 * ClientActivityLog instead, which already backs the client Activity feed.
 *
 * ClientActivityLog.userId is a required FK, so system-initiated writes with no
 * acting user are skipped rather than logged against a synthetic account.
 */
import { prisma } from './prisma.js';

const ACTION_PREFIX = 'OKF_';

export async function logOkfAccess({
  clientId,
  userId = null,
  action,
  filePath,
  folder = null,
  filename = null,
  schemaType = null,
  okfStatus = null,
  agentName = null,
  reason = null,
}) {
  if (!clientId || !userId || !action || !filePath) return null;

  try {
    return await prisma.clientActivityLog.create({
      data: {
        clientId,
        userId,
        action: `${ACTION_PREFIX}${String(action).toUpperCase()}`.slice(0, 100),
        detail: `${filePath}${reason ? ` — ${reason}` : ''}`.slice(0, 1000),
        metadata: {
          filePath,
          folder,
          filename,
          schemaType,
          okfStatus,
          agentName,
          at: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    console.error('Failed to log OKF access:', err.message);
    return null;
  }
}

export async function listOkfAccessLog(clientId, limit = 100) {
  return prisma.clientActivityLog.findMany({
    where: { clientId, action: { startsWith: ACTION_PREFIX } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}
