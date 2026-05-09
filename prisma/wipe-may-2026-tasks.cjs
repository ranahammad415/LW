/**
 * wipe-may-2026-tasks.cjs
 *
 * Deletes ALL tasks from the 7 May-2026 target projects so the seeder can
 * repopulate them with the new description + subtask structure.
 *
 * Safe: only touches projects matched by PROJECT_NAMES below.
 *
 * Run:
 *   node prisma/wipe-may-2026-tasks.cjs
 */

const { PrismaClient } = require('@prisma/client');

const PROJECT_NAMES = [
  'Roman Electric',
  'Milwaukee Signs',
  'P2EzPay',
  'Broaching',            // matches Keyway Broaching / Broaching Technologies
  'Great Lakes Power Vac',
  'Wilhelmina Balloon',
  'SouthGate Lease',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('→ Resolving target projects...');
    const projects = await prisma.project.findMany({
      where: { OR: PROJECT_NAMES.map((n) => ({ name: { contains: n } })) },
      select: { id: true, name: true },
    });

    if (projects.length === 0) {
      console.warn('⚠ No matching projects found. Nothing to delete.');
      return;
    }

    for (const p of projects) {
      console.log(`  ✓ ${p.name}  (id=${p.id})`);
    }

    const projectIds = projects.map((p) => p.id);

    // Count first so the user sees the impact.
    const count = await prisma.task.count({
      where: { projectId: { in: projectIds } },
    });
    console.log(`\n→ Will delete ${count} tasks across ${projects.length} projects.`);

    // Delete subtasks first (rows where parentTaskId is not null),
    // then parent tasks. This avoids FK constraint issues on self-relation.
    const subDel = await prisma.task.deleteMany({
      where: {
        projectId: { in: projectIds },
        parentTaskId: { not: null },
      },
    });
    console.log(`  ✓ Deleted ${subDel.count} subtasks.`);

    const parentDel = await prisma.task.deleteMany({
      where: {
        projectId: { in: projectIds },
        parentTaskId: null,
      },
    });
    console.log(`  ✓ Deleted ${parentDel.count} parent tasks.`);

    console.log(`\n✓ Total deleted: ${subDel.count + parentDel.count}`);
    console.log('Done. You can now run: node prisma/seed-may-2026-tasks.cjs');
  } catch (err) {
    console.error('✗ Error:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
