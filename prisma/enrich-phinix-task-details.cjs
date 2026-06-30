#!/usr/bin/env node
/**
 * Enrich existing Agency OS tasks with deliverable comments + Google Sheet links.
 *
 * Usage:
 *   node prisma/enrich-phinix-task-details.cjs
 *   node prisma/enrich-phinix-task-details.cjs --confirm
 *   node prisma/enrich-phinix-task-details.cjs --project "Roman Electric" --confirm
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

  const { enrichPhinixTaskDetails, cleanupLegacyPhinixComments } = await import('../src/lib/dataImport/enrichPhinixTaskDetails.js');
  const { prisma } = await import('../src/lib/prisma.js');

  console.log('');
  console.log('Phinix Task Enrichment (comments + sheet links)');
  console.log('================================================');
  console.log(`Dry run: ${dryRun}`);
  if (args.projects.length) console.log(`Projects: ${args.projects.join(', ')}`);
  console.log('');

  try {
    const summary = await enrichPhinixTaskDetails({
      dryRun,
      projects: args.projects.length ? args.projects : undefined,
    });

    const cleanup = await cleanupLegacyPhinixComments({ dryRun });

    for (const p of summary.projects) {
      if (p.status === 'skipped') {
        console.log(`  ⚠ ${p.name}: ${p.reason}`);
      } else {
        console.log(
          `  ✓ ${p.project}: comments=${p.comments} deliverables=${p.deliverables} milestone summaries=${p.milestones} attachments=${p.attachments ?? 0} skipped=${p.skipped}`,
        );
      }
    }
    console.log('');
    console.log('Totals:', summary.totals);
    console.log(`Comment cleanup: ${cleanup.updated} updated (${cleanup.scanned} scanned)`);
    if (dryRun) {
      console.log('\nNo changes written. Re-run with --confirm to apply.');
    } else {
      console.log('\nEnrichment complete. Refresh task detail panels to see comments & attachments.');
    }
  } catch (err) {
    console.error('Enrichment failed:', err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
