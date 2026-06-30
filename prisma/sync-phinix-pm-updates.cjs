#!/usr/bin/env node
/**
 * Sync positive client PM dashboard updates from Phinix task plan data.
 *
 * Usage:
 *   node prisma/sync-phinix-pm-updates.cjs
 *   node prisma/sync-phinix-pm-updates.cjs --confirm
 *   node prisma/sync-phinix-pm-updates.cjs --project "Roman Electric" --confirm
 */
require('dotenv').config();

function parseArgs(argv) {
  const args = { confirm: false, projects: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--project' && argv[i + 1]) args.projects.push(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !args.confirm;

  const { syncPhinixPmUpdates } = await import('../src/lib/dataImport/syncPhinixPmUpdates.js');
  const { prisma } = await import('../src/lib/prisma.js');

  console.log('');
  console.log('Phinix Client PM Updates (positive summaries)');
  console.log('==============================================');
  console.log(`Dry run: ${dryRun}`);
  if (args.projects.length) console.log(`Projects: ${args.projects.join(', ')}`);
  console.log('');

  try {
    const summary = await syncPhinixPmUpdates({
      dryRun,
      projects: args.projects.length ? args.projects : undefined,
    });

    for (const p of summary.projects) {
      if (p.status === 'skipped') {
        console.log(`  ⚠ ${p.project}: ${p.reason}`);
      } else {
        console.log(`  ✓ ${p.project}: ${p.action}`);
        if (dryRun && p.preview) console.log(`    ${p.preview}...`);
      }
    }

    console.log('');
    console.log('Totals:', summary.totals);
    if (dryRun) {
      console.log('\nNo changes written. Re-run with --confirm to publish to client dashboards.');
    } else {
      console.log('\nPM updates synced. Clients will see these under Client Dashboard → PM Updates.');
    }
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
