import { prisma } from './prisma.js';

// Statuses that count as "done" and therefore do NOT carry forward to the next cycle.
const DONE_STATUSES = ['COMPLETED', 'CANCELLED'];

export function monthLabel(month, year) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const name = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${name} ${year}`;
}

function nextMonthYear(month, year) {
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

/**
 * Returns the single OPEN work cycle, bootstrapping one for the current
 * calendar month if none exists. On first bootstrap, existing tasks that have
 * no cycle are backfilled to it so the current session is populated.
 */
export async function ensureCurrentCycle({ userId = null } = {}) {
  const open = await prisma.workCycle.findFirst({
    where: { status: 'OPEN' },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  if (open) return open;

  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();

  const existing = await prisma.workCycle.findUnique({
    where: { month_year: { month, year } },
  });

  const current = existing
    ? await prisma.workCycle.update({
        where: { id: existing.id },
        data: { status: 'OPEN', closedAt: null },
      })
    : await prisma.workCycle.create({
        data: { month, year, status: 'OPEN', openedById: userId, label: monthLabel(month, year) },
      });

  // Backfill any tasks that predate the work-cycle feature into the first cycle.
  await prisma.task.updateMany({ where: { workCycleId: null }, data: { workCycleId: current.id } });

  return current;
}

/**
 * Resolve which cycle a request is asking about.
 * - explicit cycleId, or month+year → that cycle
 * - nothing → the current (OPEN) cycle
 * Returns null only when an explicit reference doesn't match any cycle.
 */
export async function resolveCycle({ cycleId, month, year } = {}) {
  if (cycleId) return prisma.workCycle.findUnique({ where: { id: String(cycleId) } });
  if (month && year) {
    return prisma.workCycle.findUnique({
      where: { month_year: { month: Number(month), year: Number(year) } },
    });
  }
  return ensureCurrentCycle();
}

/**
 * Preview of what opening the next month will do, for the admin confirm dialog.
 */
export async function previewOpenNext() {
  const current = await prisma.workCycle.findFirst({ where: { status: 'OPEN' } });
  const [carryOverCount, activeClientCount] = await Promise.all([
    current
      ? prisma.task.count({
          where: { workCycleId: current.id, status: { notIn: DONE_STATUSES } },
        })
      : Promise.resolve(0),
    prisma.clientAccount.count({ where: { isActive: true } }),
  ]);

  const target = current
    ? nextMonthYear(current.month, current.year)
    : (() => {
        const now = new Date();
        return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
      })();

  return {
    currentCycle: current
      ? { id: current.id, month: current.month, year: current.year, label: current.label }
      : null,
    nextCycle: { month: target.month, year: target.year, label: monthLabel(target.month, target.year) },
    carryOverCount,
    reportsToGenerate: current ? activeClientCount : 0,
  };
}

/**
 * Close the current cycle and open the next one (agency-wide).
 * - carries incomplete tasks forward into the new cycle
 * - triggers per-client report drafts + a frozen analytics snapshot for the
 *   just-closed cycle (best-effort; wired up in later phases)
 */
export async function openNextCycle({ userId = null, log = console } = {}) {
  const current = await prisma.workCycle.findFirst({ where: { status: 'OPEN' } });

  const target = current
    ? nextMonthYear(current.month, current.year)
    : (() => {
        const now = new Date();
        return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
      })();

  const existingTarget = await prisma.workCycle.findUnique({
    where: { month_year: { month: target.month, year: target.year } },
  });

  const result = await prisma.$transaction(async (tx) => {
    let closedCycle = null;
    if (current) {
      closedCycle = await tx.workCycle.update({
        where: { id: current.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    }

    const newCycle = existingTarget
      ? await tx.workCycle.update({
          where: { id: existingTarget.id },
          data: { status: 'OPEN', openedAt: new Date(), closedAt: null, openedById: userId },
        })
      : await tx.workCycle.create({
          data: {
            month: target.month,
            year: target.year,
            status: 'OPEN',
            openedById: userId,
            label: monthLabel(target.month, target.year),
          },
        });

    let carried = 0;
    if (closedCycle) {
      const res = await tx.task.updateMany({
        where: { workCycleId: closedCycle.id, status: { notIn: DONE_STATUSES } },
        data: { workCycleId: newCycle.id },
      });
      carried = res.count;
    }

    return { closedCycle, newCycle, carried };
  });

  // Post-close automation for the month that just ended (best-effort — these
  // modules are added in the reporting/analytics phases). Never block the
  // month roll on a downstream failure.
  if (result.closedCycle) {
    try {
      const { generateReportsForCycle } = await import('./monthlyReport/generateForCycle.js');
      const summary = await generateReportsForCycle(result.closedCycle, { log });
      result.reports = summary;
    } catch (err) {
      log?.error?.({ err }, 'Report generation for closed cycle failed');
    }
    try {
      const { freezeAnalyticsForCycle } = await import('./analytics/freezeSnapshot.js');
      const snap = await freezeAnalyticsForCycle(result.closedCycle, { log });
      result.snapshots = snap;
    } catch (err) {
      log?.error?.({ err }, 'Analytics snapshot for closed cycle failed');
    }
  }

  return result;
}
