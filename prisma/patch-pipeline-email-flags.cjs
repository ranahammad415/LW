/**
 * One-shot patch: enable email flags for all pipeline notification slugs.
 *
 * Background: seed-notification-roles.cjs originally seeded four pipeline
 * slugs as "in-app only" (all email flags = 0). That suppresses email
 * delivery silently because notificationService.templateAllowsEmailForUser()
 * returns false. This script flips those flags on for existing rows in the
 * live database without re-running the full seed.
 *
 * Usage:
 *   cd backend
 *   node prisma/patch-pipeline-email-flags.cjs
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// (slug, owner, pm, mgr, viewer) — must match seed-notification-roles.cjs
const PATCHES = [
  { slug: 'content_submitted_for_review',     owner: 1, pm: 1, mgr: 1, viewer: 0 },
  { slug: 'content_pm_approved',              owner: 1, pm: 1, mgr: 0, viewer: 0 },
  { slug: 'content_pm_changes_requested',     owner: 1, pm: 1, mgr: 0, viewer: 0 },
  { slug: 'content_ready_for_client_review',  owner: 1, pm: 1, mgr: 1, viewer: 0 },
  { slug: 'content_client_approved',          owner: 1, pm: 1, mgr: 1, viewer: 0 },
  { slug: 'content_client_changes_requested', owner: 1, pm: 1, mgr: 1, viewer: 0 },
  { slug: 'content_published',                owner: 1, pm: 1, mgr: 1, viewer: 0 },
];

async function main() {
  console.log('[patch] Updating pipeline notification template email flags...');
  let updated = 0;
  let missing = 0;

  for (const p of PATCHES) {
    const existing = await prisma.notificationTemplate.findUnique({
      where: { slug: p.slug },
      select: { id: true, slug: true, emailAgencyOwner: true, emailPm: true, emailClientManager: true, emailClientViewer: true, isActive: true },
    });
    if (!existing) {
      console.log(`[patch] SKIP "${p.slug}" — template row not found (run seed-notifications.js first).`);
      missing++;
      continue;
    }

    const before = {
      owner: existing.emailAgencyOwner ? 1 : 0,
      pm: existing.emailPm ? 1 : 0,
      mgr: existing.emailClientManager ? 1 : 0,
      viewer: existing.emailClientViewer ? 1 : 0,
      active: existing.isActive,
    };

    await prisma.notificationTemplate.update({
      where: { slug: p.slug },
      data: {
        isActive: true,
        emailAgencyOwner: !!p.owner,
        emailPm: !!p.pm,
        emailClientManager: !!p.mgr,
        emailClientViewer: !!p.viewer,
      },
    });

    console.log(
      `[patch] ${p.slug}: ` +
      `before owner=${before.owner} pm=${before.pm} mgr=${before.mgr} viewer=${before.viewer} active=${before.active} ` +
      `=> after owner=${p.owner} pm=${p.pm} mgr=${p.mgr} viewer=${p.viewer} active=true`
    );
    updated++;
  }

  console.log(`[patch] Done. updated=${updated} missing=${missing}`);
}

main()
  .catch((err) => {
    console.error('[patch] Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
