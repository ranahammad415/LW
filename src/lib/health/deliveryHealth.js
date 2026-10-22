/**
 * Delivery health: the old task-based "health score" formula (formerly POST /api/admin/automation/calculate-health),
 * now computed on read and shown to staff as a separate "Delivery health" chip. It never writes
 * ClientAccount.healthScore (that is the v2 marketing health score).
 *
 *   score = max(0, 100 − 10·overdue − 5·stagnant − (onboarding not COMPLETE ? 15 : 0))
 *   overdue  = tasks not COMPLETED and not CANCELLED with dueDate before today (CANCELLED excluded: new in v2)
 *   stagnant = IN_PROGRESS / NEEDS_REVIEW tasks not updated for 3 days
 *
 * Batched: a fixed number of queries for any number of clients (groupBy), never one query per client.
 */
import { prisma } from '../prisma.js';

export const STAGNANT_DAYS = 3;

export function deliveryScore({ overdue = 0, stagnant = 0, onboardingDone = false }) {
  return Math.max(0, 100 - overdue * 10 - stagnant * 5 - (onboardingDone ? 0 : 15));
}

function thresholds(now) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const stagnant = new Date(now);
  stagnant.setDate(stagnant.getDate() - STAGNANT_DAYS);
  stagnant.setUTCHours(0, 0, 0, 0);
  return { todayStart, stagnant };
}

/** Map clientId → { score, overdue, stagnant, onboardingDone }. */
export async function computeDeliveryHealthMany(clientIds, { now = new Date() } = {}) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const t = thresholds(now);
  const [clients, projects] = await Promise.all([
    prisma.clientAccount.findMany({ where: { id: { in: ids } }, select: { id: true, onboardingStatus: true } }),
    prisma.project.findMany({ where: { clientId: { in: ids } }, select: { id: true, clientId: true } }),
  ]);
  const clientOf = new Map(projects.map((p) => [p.id, p.clientId]));
  const pids = projects.map((p) => p.id);
  const [overdue, stagnant] = pids.length
    ? await Promise.all([
        prisma.task.groupBy({
          by: ['projectId'],
          where: { projectId: { in: pids }, status: { notIn: ['COMPLETED', 'CANCELLED'] }, dueDate: { lt: t.todayStart } },
          _count: { _all: true },
        }),
        prisma.task.groupBy({
          by: ['projectId'],
          where: { projectId: { in: pids }, status: { in: ['IN_PROGRESS', 'NEEDS_REVIEW'] }, updatedAt: { lt: t.stagnant } },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const counts = new Map(ids.map((id) => [id, { overdue: 0, stagnant: 0 }]));
  for (const g of overdue) {
    const c = counts.get(clientOf.get(g.projectId));
    if (c) c.overdue += g._count?._all || 0;
  }
  for (const g of stagnant) {
    const c = counts.get(clientOf.get(g.projectId));
    if (c) c.stagnant += g._count?._all || 0;
  }
  for (const c of clients) {
    const n = counts.get(c.id);
    if (!n) continue;
    const onboardingDone = c.onboardingStatus === 'COMPLETE';
    out.set(c.id, { score: deliveryScore({ ...n, onboardingDone }), overdue: n.overdue, stagnant: n.stagnant, onboardingDone });
  }
  return out;
}

export async function computeDeliveryHealth(clientId, opts) {
  return (await computeDeliveryHealthMany([clientId], opts)).get(clientId) || null;
}
