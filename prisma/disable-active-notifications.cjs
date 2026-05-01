/**
 * One-off script: disable every currently-active NotificationTemplate.
 *
 * Run with: node prisma/disable-active-notifications.cjs
 *
 * Flips isActive = false on all rows where isActive = true so that notify()
 * short-circuits for every slug. The OWNER can re-enable templates individually
 * from the Notifications admin page (Edit → Active toggle).
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  try {
    const activeBefore = await prisma.notificationTemplate.findMany({
      where: { isActive: true },
      select: { slug: true, name: true },
      orderBy: { name: 'asc' },
    });

    if (activeBefore.length === 0) {
      console.log('No active templates found — nothing to do.');
      return;
    }

    console.log(`Disabling ${activeBefore.length} active template(s):`);
    for (const t of activeBefore) {
      console.log(`  - ${t.name}  (${t.slug})`);
    }

    const result = await prisma.notificationTemplate.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });

    console.log(`\n✔ Disabled ${result.count} template(s). Re-enable individually in the admin UI.`);
  } catch (err) {
    console.error('Failed to disable templates:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
