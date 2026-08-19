/**
 * Remove August 2026 work cycle + its tasks ONLY, then re-open July 2026
 * so you can run "Start next month" again and verify Option B cloning.
 *
 * SAFE GUARDS:
 * - Never deletes July 2026 tasks or the July work cycle row.
 * - Requires --confirm (and optional --dry-run).
 * - Defaults to month=8 year=2026 / previous month=7 year=2026.
 *
 * Usage on VPS (~/LW):
 *   node scripts/resetOpenMonthForRerun.js --dry-run
 *   node scripts/resetOpenMonthForRerun.js --confirm
 *
 * Optional overrides:
 *   node scripts/resetOpenMonthForRerun.js --confirm --month=8 --year=2026
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

const dryRun = process.argv.includes('--dry-run');
const confirm = process.argv.includes('--confirm');
const targetMonth = Number(argValue('month', '8'));
const targetYear = Number(argValue('year', '2026'));

function prevMonthYear(month, year) {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

async function main() {
  if (!dryRun && !confirm) {
    console.error(`
Refusing to run without --confirm (or use --dry-run first).

  node scripts/resetOpenMonthForRerun.js --dry-run
  node scripts/resetOpenMonthForRerun.js --confirm
`);
    process.exit(1);
  }

  const prev = prevMonthYear(targetMonth, targetYear);

  const [targetCycle, keepCycle] = await Promise.all([
    prisma.workCycle.findUnique({
      where: { month_year: { month: targetMonth, year: targetYear } },
    }),
    prisma.workCycle.findUnique({
      where: { month_year: { month: prev.month, year: prev.year } },
    }),
  ]);

  if (!targetCycle) {
    console.error(`No work cycle found for ${targetMonth}/${targetYear}. Nothing to remove.`);
    process.exit(1);
  }
  if (!keepCycle) {
    console.error(
      `Previous cycle ${prev.month}/${prev.year} not found. Aborting — will not remove ${targetMonth}/${targetYear} without a July to reopen.`
    );
    process.exit(1);
  }

  const [taskCount, snapshotCount, julyTaskCount] = await Promise.all([
    prisma.task.count({ where: { workCycleId: targetCycle.id } }),
    prisma.workCycleAnalyticsSnapshot.count({ where: { workCycleId: targetCycle.id } }),
    prisma.task.count({ where: { workCycleId: keepCycle.id } }),
  ]);

  // Monthly reports / PDFs are PM-owned — never auto-delete them during reset.
  const reportCount = await prisma.monthlyReport.count({ where: { workCycleId: targetCycle.id } });

  console.log(
    JSON.stringify(
      {
        dryRun,
        willDelete: {
          cycle: {
            id: targetCycle.id,
            label: targetCycle.label,
            month: targetCycle.month,
            year: targetCycle.year,
            status: targetCycle.status,
          },
          tasks: taskCount,
          analyticsSnapshots: snapshotCount,
        },
        willKeep: {
          monthlyReports: reportCount,
          note: 'Monthly reports and PDFs are preserved (PM-owned). workCycleId will be cleared when the cycle row is deleted.',
        },
        willKeepAndReopen: {
          cycle: {
            id: keepCycle.id,
            label: keepCycle.label,
            month: keepCycle.month,
            year: keepCycle.year,
            status: keepCycle.status,
          },
          tasks: julyTaskCount,
        },
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('[dry-run] No changes made.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Break self-FK among target-cycle tasks, then delete all of them.
    await tx.task.updateMany({
      where: { workCycleId: targetCycle.id },
      data: { clonedFromTaskId: null },
    });

    // Also clear any non-target task that somehow clonedFrom an August task
    // (should be rare; protects July from FK issues).
    const targetTaskIds = (
      await tx.task.findMany({
        where: { workCycleId: targetCycle.id },
        select: { id: true },
      })
    ).map((t) => t.id);

    if (targetTaskIds.length) {
      await tx.task.updateMany({
        where: { clonedFromTaskId: { in: targetTaskIds } },
        data: { clonedFromTaskId: null },
      });

      // Delete deepest tasks first isn't required if we delete by cycle id in one go
      // and parent FKs are among the same set — use raw delete for reliability.
      await tx.$executeRawUnsafe(`DELETE FROM \`task\` WHERE \`workCycleId\` = ?`, targetCycle.id);
    }

    // Detach monthly reports from the cycle before deleting it (preserve reports/PDFs).
    await tx.monthlyReport.updateMany({
      where: { workCycleId: targetCycle.id },
      data: { workCycleId: null },
    });
    // snapshots cascade on workcycle delete, but delete explicitly for clarity
    await tx.workCycleAnalyticsSnapshot.deleteMany({ where: { workCycleId: targetCycle.id } });

    await tx.workCycle.delete({ where: { id: targetCycle.id } });

    // Re-open July so Start next month can run again.
    await tx.workCycle.update({
      where: { id: keepCycle.id },
      data: {
        status: 'OPEN',
        closedAt: null,
        openedAt: keepCycle.openedAt ?? new Date(),
      },
    });

    // Ensure no other cycle is OPEN.
    await tx.workCycle.updateMany({
      where: { id: { not: keepCycle.id }, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  });

  const julyAfter = await prisma.workCycle.findUnique({ where: { id: keepCycle.id } });
  const augustGone = await prisma.workCycle.findUnique({
    where: { month_year: { month: targetMonth, year: targetYear } },
  });
  const julyTasksAfter = await prisma.task.count({ where: { workCycleId: keepCycle.id } });

  console.log(
    JSON.stringify(
      {
        ok: true,
        augustRemoved: !augustGone,
        julyNow: {
          id: julyAfter.id,
          label: julyAfter.label,
          status: julyAfter.status,
          taskCount: julyTasksAfter,
        },
        nextStep:
          'In Admin → Master Task List, click "Start next month". August should reopen with fresh TO_DO clones of July recurring tasks.',
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
