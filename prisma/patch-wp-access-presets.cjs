/**
 * patch-wp-access-presets.cjs
 *
 * Updates existing WpAccessPreset rows so Agency OS auto-login sessions can
 * actually edit posts/pages authored by other users. Without the `*_others_*`
 * primitives, WordPress (and Elementor) show only "View" on posts the session
 * user doesn't own.
 *
 * Idempotent: re-running overwrites each named preset with the desired
 * capability list. Safe to run any time.
 *
 * Usage:
 *   node prisma/patch-wp-access-presets.cjs
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET = {
  'Content Writing': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'publish_posts',
    'upload_files',
    'delete_posts',
    'delete_others_posts',
    'delete_published_posts',
  ],
  'Meta Optimisation': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'edit_pages',
    'edit_others_pages',
    'edit_published_pages',
  ],
  'Technical SEO': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'edit_pages',
    'edit_others_pages',
    'edit_published_pages',
    'manage_options',
    'edit_theme_options',
  ],
  'Monthly Report (Read-Only)': ['read'],
  'Strategy Call (Read-Only)': ['read'],
  'Onboarding / Full Setup': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'delete_posts',
    'delete_others_posts',
    'delete_published_posts',
    'edit_pages',
    'edit_others_pages',
    'edit_published_pages',
    'delete_pages',
    'delete_others_pages',
    'delete_published_pages',
    'upload_files',
    'manage_options',
    'edit_theme_options',
    'install_plugins',
    'activate_plugins',
  ],
  'Crawl Fix': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'edit_pages',
    'edit_others_pages',
    'edit_published_pages',
    'manage_options',
  ],
  'Schema Deployment': [
    'read',
    'edit_posts',
    'edit_others_posts',
    'edit_published_posts',
    'edit_pages',
    'edit_others_pages',
    'edit_published_pages',
    'edit_theme_options',
  ],
};

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        WP Access Presets — Capability Patcher               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const existing = await prisma.wpAccessPreset.findMany();
  const byName = Object.fromEntries(existing.map((p) => [p.name, p]));

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const [name, caps] of Object.entries(TARGET)) {
    const row = byName[name];
    if (!row) {
      await prisma.wpAccessPreset.create({ data: { name, capabilities: caps } });
      console.log(`  + created  "${name}" (${caps.length} caps)`);
      created++;
      continue;
    }

    const current = Array.isArray(row.capabilities) ? row.capabilities : [];
    if (sameSet(current, caps)) {
      console.log(`  = unchanged "${name}"`);
      skipped++;
      continue;
    }

    await prisma.wpAccessPreset.update({
      where: { id: row.id },
      data: { capabilities: caps },
    });
    const added = caps.filter((c) => !current.includes(c));
    const removed = current.filter((c) => !caps.includes(c));
    console.log(`  ✓ updated  "${name}"`);
    if (added.length)   console.log(`      + ${added.join(', ')}`);
    if (removed.length) console.log(`      - ${removed.join(', ')}`);
    updated++;
  }

  console.log('');
  console.log(`Summary: ${updated} updated, ${created} created, ${skipped} unchanged.`);
  console.log('');
  console.log('Next: in WP, log out of any Agency OS session and re-trigger auto-login');
  console.log('so the fresh capability list is stamped into user meta.');
  console.log('');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
