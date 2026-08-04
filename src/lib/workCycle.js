import { prisma } from './prisma.js';
import { cloneMissingRecurringTasks, DONE_STATUSES } from './taskClone.js';

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
 * Ensure the calendar month *after* the current OPEN cycle exists as a row
 * without opening it (stays CLOSED until agency Start next month). Used by
 * per-project next-month prepare so tasks can be staged early.
 */
export async function ensureNextCycle({ userId = null } = {}) {
  const current = await ensureCurrentCycle({ userId });
  const target = nextMonthYear(current.month, current.year);

  const existing = await prisma.workCycle.findUnique({
    where: { month_year: { month: target.month, year: target.year } },
  });

  if (existing) {
    return { current, next: existing };
  }

  const next = await prisma.workCycle.create({
    data: {
      month: target.month,
      year: target.year,
      status: 'CLOSED',
      closedAt: null,
      openedById: userId,
      label: monthLabel(target.month, target.year),
    },
  });

  return { current, next };
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
 * carryOverCount = non-cancelled roots on current cycle that still need cloning
 * (includes COMPLETED so recurring work seeds the new month as To-do).
 */
export async function previewOpenNext() {
  const current = await prisma.workCycle.findFirst({ where: { status: 'OPEN' } });
  const target = current
    ? nextMonthYear(current.month, current.year)
    : (() => {
        const now = new Date();
        return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
      })();

  const existingTarget = current
    ? await prisma.workCycle.findUnique({
        where: { month_year: { month: target.month, year: target.year } },
      })
    : null;

  let carryOverCount = 0;
  if (current) {
    const recurringRoots = await prisma.task.findMany({
      where: {
        workCycleId: current.id,
        parentTaskId: null,
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    });
    if (existingTarget && recurringRoots.length) {
      const alreadyCloned = await prisma.task.findMany({
        where: {
          workCycleId: existingTarget.id,
          clonedFromTaskId: { in: recurringRoots.map((t) => t.id) },
        },
        select: { clonedFromTaskId: true },
      });
      const clonedSet = new Set(alreadyCloned.map((t) => t.clonedFromTaskId));
      carryOverCount = recurringRoots.filter((t) => !clonedSet.has(t.id)).length;
    } else {
      carryOverCount = recurringRoots.length;
    }
  }

  // Reports are created only by PMs — Start next month never auto-generates them.
  const reportsToGenerate = 0;

  return {
    currentCycle: current
      ? { id: current.id, month: current.month, year: current.year, label: current.label }
      : null,
    nextCycle: { month: target.month, year: target.year, label: monthLabel(target.month, target.year) },
    carryOverCount,
    reportsToGenerate,
  };
}

/**
 * Close the current cycle and open the next one (agency-wide).
 * Closed-cycle tasks stay as history. Non-cancelled roots without a clone in
 * the new cycle are cloned as fresh TO_DO (including COMPLETED recurring work).
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
      const cloneResult = await cloneMissingRecurringTasks(closedCycle.id, newCycle.id, {
        tx,
        createdById: userId,
      });
      carried = cloneResult.cloned;
    }

    return { closedCycle, newCycle, carried };
  });

  // Post-close automation for the month that just ended (best-effort).
  // Monthly reports are PM-owned: never auto-create or overwrite drafts here.
  if (result.closedCycle) {
    result.reports = null;
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

export { DONE_STATUSES };
