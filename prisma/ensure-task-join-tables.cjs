/**
 * Create Prisma implicit many-to-many join tables if missing.
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 *
 * Usage on server: node prisma/ensure-task-join-tables.cjs
 */
require('dotenv').config();

(async () => {
  const { prisma } = await import('../src/lib/prisma.js');

  const statements = [
    `CREATE TABLE IF NOT EXISTS \`_TaskAssignees\` (
      \`A\` VARCHAR(191) NOT NULL,
      \`B\` VARCHAR(191) NOT NULL,
      UNIQUE INDEX \`_TaskAssignees_AB_unique\`(\`A\`, \`B\`),
      INDEX \`_TaskAssignees_B_index\`(\`B\`)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`_TaskDependencies\` (
      \`A\` VARCHAR(191) NOT NULL,
      \`B\` VARCHAR(191) NOT NULL,
      UNIQUE INDEX \`_TaskDependencies_AB_unique\`(\`A\`, \`B\`),
      INDEX \`_TaskDependencies_B_index\`(\`B\`)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log('Task join tables ready (_TaskAssignees, _TaskDependencies)');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
