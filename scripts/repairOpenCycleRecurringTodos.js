/**
 * One-shot repair: fix OPEN-cycle (e.g. August) recurring tasks after an early
 * "Start next month" that left Completed copies / missed fresh To-do clones.
 *
 * - Does NOT modify CLOSED previous-cycle history (July).
 * - Resets OPEN-cycle COMPLETED carry-overs to TO_DO.
 * - Clones any missing non-cancelled previous-cycle roots into OPEN as TO_DO.
 *
 * Prerequisites on VPS (if clonedFromTaskId is missing):
 *   npx prisma db push
 *   npx prisma generate
 *   pm2 restart all
 *
 * Usage (from backend / ~/LW root):
 *   node scripts/repairOpenCycleRecurringTodos.js
 *   node scripts/repairOpenCycleRecurringTodos.js --dry-run
 */
import { PrismaClient } from '@prisma/client';

const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

function prevMonthYear(month, year) {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

async function hasClonedFromColumn() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'task'
         AND COLUMN_NAME = 'clonedFromTaskId'`
    );
    const count = Number(rows?.[0]?.c ?? rows?.[0]?.C ?? 0);
    return count > 0;
  } catch {
    return false;
  }
}

async function main() {
  const open = await prisma.workCycle.findFirst({
    where: { status: 'OPEN' },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  if (!open) {
    console.error('No OPEN work cycle found.');
    process.exit(1);
  }

  const prev = prevMonthYear(open.month, open.year);
  const previous = await prisma.workCycle.findUnique({
    where: { month_year: { month: prev.month, year: prev.year } },
  });

  const lineageReady = await hasClonedFromColumn();

  console.log(
    JSON.stringify(
      {
        dryRun,
        lineageReady,
        openCycle: { id: open.id, label: open.label, month: open.month, year: open.year },
        previousCycle: previous
          ? { id: previous.id, label: previous.label, month: previous.month, year: previous.year }
          : null,
      },
      null,
      2
    )
  );

  if (!lineageReady) {
    console.error(`
MISSING COLUMN: task.clonedFromTaskId

Run these on the server, then re-run this script:

  cd ~/LW
  npx prisma db push
  npx prisma generate
  pm2 restart all
  node scripts/repairOpenCycleRecurringTodos.js --dry-run
  node scripts/repairOpenCycleRecurringTodos.js
`);
    process.exit(1);
  }

  // Prisma client must also know the field (after generate).
  const clientHasField = 'clonedFromTaskId' in (prisma.task?.fields || {}) || true;
  // Runtime check via a safe probe select
  try {
    await prisma.task.findFirst({ select: { id: true, clonedFromTaskId: true } });
  } catch (err) {
    if (String(err?.message || err).includes('clonedFromTaskId')) {
      console.error(`
DB has clonedFromTaskId but Prisma Client is stale.

Run:
  npx prisma generate
  pm2 restart all
  node scripts/repairOpenCycleRecurringTodos.js --dry-run
`);
      process.exit(1);
    }
    throw err;
  }

  const previousCompletedRoots = previous
    ? await prisma.task.findMany({
        where: {
          workCycleId: previous.id,
          parentTaskId: null,
          status: 'COMPLETED',
        },
        select: { id: true, title: true, projectId: true },
      })
    : [];

  const prevCompletedIds = new Set(previousCompletedRoots.map((t) => t.id));
  const prevTitlesByProject = new Map();
  for (const t of previousCompletedRoots) {
    if (!prevTitlesByProject.has(t.projectId)) prevTitlesByProject.set(t.projectId, new Set());
    prevTitlesByProject.get(t.projectId).add(t.title);
  }

  const openCompletedRoots = await prisma.task.findMany({
    where: {
      workCycleId: open.id,
      parentTaskId: null,
      status: 'COMPLETED',
    },
    select: { id: true, title: true, projectId: true, clonedFromTaskId: true },
  });

  const toReset = openCompletedRoots.filter((t) => {
    if (t.clonedFromTaskId && prevCompletedIds.has(t.clonedFromTaskId)) return true;
    const titles = prevTitlesByProject.get(t.projectId);
    return titles ? titles.has(t.title) : false;
  });

  console.log(`OPEN completed roots: ${openCompletedRoots.length}; will reset to TO_DO: ${toReset.length}`);

  if (!dryRun && toReset.length) {
    const ids = toReset.map((t) => t.id);
    const descendants = await prisma.task.findMany({
      where: { parentTaskId: { in: ids }, workCycleId: open.id },
      select: { id: true },
    });
    const allIds = [...ids, ...descendants.map((d) => d.id)];
    const updated = await prisma.task.updateMany({
      where: { id: { in: allIds }, status: 'COMPLETED' },
      data: { status: 'TO_DO' },
    });
    console.log(`Reset ${updated.count} task(s) to TO_DO.`);
  } else if (dryRun) {
    console.log(
      '[dry-run] Would reset:',
      toReset.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId }))
    );
  }

  if (previous) {
    if (dryRun) {
      const roots = await prisma.task.findMany({
        where: {
          workCycleId: previous.id,
          parentTaskId: null,
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      const already = await prisma.task.findMany({
        where: {
          workCycleId: open.id,
          clonedFromTaskId: { in: roots.map((r) => r.id) },
        },
        select: { clonedFromTaskId: true },
      });
      const clonedSet = new Set(already.map((a) => a.clonedFromTaskId));
      const missing = roots.filter((r) => !clonedSet.has(r.id)).length;
      console.log(`[dry-run] Would clone ${missing} missing recurring root(s) from previous cycle.`);
    } else {
      const { cloneMissingRecurringTasks } = await import('../src/lib/taskClone.js');
      const cloneResult = await cloneMissingRecurringTasks(previous.id, open.id);
      console.log(
        `Clone missing recurring: cloned=${cloneResult.cloned} skipped=${cloneResult.skipped} roots=${cloneResult.rootCount}`
      );
    }
  } else {
    console.log('No previous cycle found — skip clone fill.');
  }

  // silence unused
  void clientHasField;
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
