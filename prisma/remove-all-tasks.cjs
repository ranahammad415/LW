/**
 * remove-all-tasks.cjs
 *
 * Hard-deletes every row in the Task table. Prisma FK cascades automatically
 * drop:
 *   - taskcomment           (onDelete: Cascade)
 *   - taskcommentreaction   (via taskcomment cascade)
 *   - taskattachment        (onDelete: Cascade)
 *   - taskactivitylog       (onDelete: Cascade)
 *   - deliverableversion    (onDelete: Cascade)
 *   - clientinputrequest    (onDelete: Cascade)
 *
 * Sub-task relations use onDelete: SetNull, which is irrelevant when the
 * entire table is wiped.
 *
 * Usage:
 *   node prisma/remove-all-tasks.cjs           # shows 5s countdown
 *   node prisma/remove-all-tasks.cjs --yes     # skip countdown
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║            ⚠  DESTRUCTIVE OPERATION — READ CAREFULLY         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Pre-delete audit counts
  const [
    taskCount,
    commentCount,
    reactionCount,
    attachmentCount,
    activityCount,
    deliverableCount,
    inputReqCount,
  ] = await Promise.all([
    prisma.task.count(),
    prisma.taskComment.count(),
    prisma.taskCommentReaction.count(),
    prisma.taskAttachment.count(),
    prisma.taskActivityLog.count(),
    prisma.deliverableVersion.count(),
    prisma.clientInputRequest.count(),
  ]);

  console.log('Current platform totals:');
  console.log(`  • Task                    : ${taskCount}`);
  console.log(`  • TaskComment             : ${commentCount}`);
  console.log(`  • TaskCommentReaction     : ${reactionCount}`);
  console.log(`  • TaskAttachment          : ${attachmentCount}`);
  console.log(`  • TaskActivityLog         : ${activityCount}`);
  console.log(`  • DeliverableVersion      : ${deliverableCount}`);
  console.log(`  • ClientInputRequest      : ${inputReqCount}`);
  console.log('');

  if (taskCount === 0) {
    console.log('No tasks to delete. Exiting.');
    return;
  }

  if (!SKIP_CONFIRM) {
    console.log('ALL of the above will be permanently deleted (hard delete).');
    console.log('Press Ctrl+C NOW to abort. Proceeding in 5 seconds...');
    for (let i = 5; i >= 1; i--) {
      process.stdout.write(`  ${i}... `);
      await sleep(1000);
    }
    console.log('');
  } else {
    console.log('--yes flag detected, skipping countdown.');
  }

  console.log('');
  console.log('Deleting all tasks (cascades handle children)...');

  const result = await prisma.task.deleteMany({});

  console.log(`✓ Deleted ${result.count} task rows.`);

  // Post-delete verification
  const [
    taskAfter,
    commentAfter,
    reactionAfter,
    attachmentAfter,
    activityAfter,
    deliverableAfter,
    inputReqAfter,
  ] = await Promise.all([
    prisma.task.count(),
    prisma.taskComment.count(),
    prisma.taskCommentReaction.count(),
    prisma.taskAttachment.count(),
    prisma.taskActivityLog.count(),
    prisma.deliverableVersion.count(),
    prisma.clientInputRequest.count(),
  ]);

  console.log('');
  console.log('Post-delete verification:');
  console.log(`  • Task                    : ${taskAfter}`);
  console.log(`  • TaskComment             : ${commentAfter}`);
  console.log(`  • TaskCommentReaction     : ${reactionAfter}`);
  console.log(`  • TaskAttachment          : ${attachmentAfter}`);
  console.log(`  • TaskActivityLog         : ${activityAfter}`);
  console.log(`  • DeliverableVersion      : ${deliverableAfter}`);
  console.log(`  • ClientInputRequest      : ${inputReqAfter}`);
  console.log('');
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
