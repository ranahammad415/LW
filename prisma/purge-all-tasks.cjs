/**
 * One-off: list projects/workers, then remove ALL tasks safely.
 * Mirrors cleanAndDeleteTask() in src/routes/tasks.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function cleanAndDeleteTask(taskId) {
  await prisma.taskCommentReaction.deleteMany({ where: { comment: { taskId } } });
  await prisma.taskComment.deleteMany({ where: { taskId } });
  await prisma.taskAttachment.deleteMany({ where: { taskId } });
  await prisma.deliverableVersion.deleteMany({ where: { taskId } });
  await prisma.clientInputRequest.deleteMany({ where: { taskId } });
  await prisma.taskActivityLog.deleteMany({ where: { taskId } });
  await prisma.task.update({
    where: { id: taskId },
    data: { assignees: { set: [] }, dependsOnTasks: { set: [] }, blockingTasks: { set: [] } },
  });
  await prisma.wpPage.updateMany({ where: { taskId }, data: { taskId: null } });
  await prisma.task.delete({ where: { id: taskId } });
}

async function main() {
  const projects = await prisma.project.findMany({
    orderBy: { name: 'asc' },
    include: {
      client: { select: { agencyName: true } },
      leadPm: { select: { name: true, email: true } },
      _count: { select: { tasks: true } },
    },
  });

  const workers = await prisma.user.findMany({
    where: { role: { in: ['TEAM_MEMBER', 'CONTRACTOR', 'PM'] }, isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      assignedTasks: { select: { id: true, title: true } },
    },
  });

  const taskCount = await prisma.task.count();
  const subtaskCount = await prisma.task.count({ where: { parentTaskId: { not: null } } });
  const rootCount = taskCount - subtaskCount;

  const related = {
    comments: await prisma.taskComment.count(),
    attachments: await prisma.taskAttachment.count(),
    activityLogs: await prisma.taskActivityLog.count(),
    deliverables: await prisma.deliverableVersion.count(),
    clientInputRequests: await prisma.clientInputRequest.count(),
    wpPagesLinked: await prisma.wpPage.count({ where: { taskId: { not: null } } }),
  };

  console.log('\n=== PROJECTS ===');
  for (const p of projects) {
    console.log(`  • ${p.name} (${p.client?.agencyName ?? 'no client'}) — ${p._count.tasks} task(s), PM: ${p.leadPm?.name ?? 'unassigned'}`);
  }
  console.log(`\nTotal projects: ${projects.length}`);

  console.log('\n=== WORKERS (PM / TEAM_MEMBER / CONTRACTOR) ===');
  for (const w of workers) {
    console.log(`  • ${w.name} <${w.email}> [${w.role}] — ${w.assignedTasks.length} assigned task(s)`);
  }
  console.log(`\nTotal workers: ${workers.length}`);

  console.log('\n=== TASK SUMMARY ===');
  console.log(`  Total tasks: ${taskCount} (${rootCount} root, ${subtaskCount} subtasks)`);
  console.log('  Related records:', related);

  if (taskCount === 0) {
    console.log('\nNo tasks to delete. Done.');
    return;
  }

  const arg = process.argv[2];
  if (arg !== '--confirm') {
    console.log('\n⚠️  Dry run only. Re-run with --confirm to delete all tasks.');
    return;
  }

  console.log('\n=== DELETING ALL TASKS ===');

  // Delete subtasks first, then root tasks (same order as API force-delete)
  const subtasks = await prisma.task.findMany({
    where: { parentTaskId: { not: null } },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });
  const roots = await prisma.task.findMany({
    where: { parentTaskId: null },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  let deleted = 0;
  for (const t of [...subtasks, ...roots]) {
    await cleanAndDeleteTask(t.id);
    deleted++;
    if (deleted % 25 === 0 || deleted === taskCount) {
      console.log(`  Deleted ${deleted}/${taskCount}...`);
    }
  }

  const remaining = await prisma.task.count();
  console.log(`\n✅ Deleted ${deleted} task(s). Remaining: ${remaining}`);

  if (remaining > 0) {
    console.error('❌ Some tasks remain — investigate manually.');
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
