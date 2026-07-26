/**
 * cleanup-orphan-wilhelmina-tasks.cjs
 *
 * One-time cleanup for Issue 6: non-recursive deletes left step/sub tasks with
 * parentTaskId=null, so they reappeared as root tasks with the same titles.
 *
 * Finds root-level tasks on Wilhelmina projects whose titles match known
 * Wilhelmina sub/step titles (not milestone mains) and deletes them.
 *
 * Usage:
 *   node prisma/cleanup-orphan-wilhelmina-tasks.cjs           # dry-run
 *   node prisma/cleanup-orphan-wilhelmina-tasks.cjs --apply   # delete
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const WILHELMINA_JULY = require('./tasks-july-2026/wilhelmina-july-tasks.cjs');
let WILHELMINA_MAY = [];
try {
  WILHELMINA_MAY = require('./tasks-may-2026/wilhelmina-tasks.cjs');
} catch {
  WILHELMINA_MAY = [];
}

function collectTitles(templates) {
  const mains = new Set();
  const children = new Set();
  for (const t of templates) {
    if (t.milestone) mains.add(String(t.milestone).trim());
    if (t.title) children.add(String(t.title).trim());
    const steps = Array.isArray(t.steps) ? t.steps : [];
    for (const step of steps) {
      const trimmed = String(step || '').trim();
      if (trimmed) children.add(trimmed);
    }
  }
  // Never treat a milestone/main title as an orphan child.
  for (const m of mains) children.delete(m);
  return { mains, children };
}

async function main() {
  const july = collectTitles(WILHELMINA_JULY);
  const may = collectTitles(WILHELMINA_MAY);
  const childTitles = new Set([...july.children, ...may.children]);

  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { name: { contains: 'wilhelmina' } },
        { client: { agencyName: { contains: 'wilhelmina' } } },
      ],
    },
    select: { id: true, name: true },
  });

  if (!projects.length) {
    console.log('No Wilhelmina projects found.');
    return;
  }

  let total = 0;
  for (const project of projects) {
    const orphans = await prisma.task.findMany({
      where: {
        projectId: project.id,
        parentTaskId: null,
        title: { in: [...childTitles] },
      },
      select: { id: true, title: true },
    });

    console.log(`\n${project.name}: ${orphans.length} orphan root task(s)`);
    for (const t of orphans) {
      console.log(`  - ${t.title} (${t.id})`);
    }

    if (APPLY && orphans.length) {
      // Recursive delete: children first (should be none for true orphans).
      async function deleteSubtree(taskId) {
        const kids = await prisma.task.findMany({
          where: { parentTaskId: taskId },
          select: { id: true },
        });
        for (const k of kids) await deleteSubtree(k.id);
        await prisma.task.delete({ where: { id: taskId } });
      }
      for (const t of orphans) {
        await deleteSubtree(t.id);
        total += 1;
      }
    } else {
      total += orphans.length;
    }
  }

  console.log(
    APPLY
      ? `\nDeleted ${total} orphan task(s).`
      : `\nDry-run: ${total} orphan task(s) would be deleted. Re-run with --apply.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
