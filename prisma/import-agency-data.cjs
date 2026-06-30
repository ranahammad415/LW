#!/usr/bin/env node
/**
 * Import agency-data v1.1 JSON into Localwaves tasks, comments, and updates.
 *
 * Usage:
 *   node prisma/import-agency-data.cjs --file path/to/agency-data.json
 *   node prisma/import-agency-data.cjs --file path/to/agency-data.json --dryRun
 *   node prisma/import-agency-data.cjs --file path/to/agency-data.json --confirm
 */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');

function parseArgs(argv) {
  const args = { file: null, dryRun: false, confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dryRun' || a === '--dry-run') args.dryRun = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: node prisma/import-agency-data.cjs --file <agency-data.json> [--dryRun] [--confirm]');
    process.exitCode = 1;
    return;
  }

  const filePath = path.isAbsolute(args.file) ? args.file : path.resolve(process.cwd(), args.file);
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);

  const dryRun = args.dryRun || !args.confirm;
  if (!args.dryRun && !args.confirm) {
    console.log('Dry run (no DB writes). Pass --confirm to import.');
  }

  const { importAgencyData } = await import('../src/lib/dataImport/importAgencyData.js');
  const { prisma } = await import('../src/lib/prisma.js');

  console.log('');
  console.log('Agency Data Importer');
  console.log('====================');
  console.log(`File:       ${filePath}`);
  console.log(`Plan:       ${data.meta?.planLabel || '—'}`);
  console.log(`Mode:       ${data.meta?.importMode || 'plan_with_progress'}`);
  console.log(`Dry run:    ${dryRun}`);
  console.log('');

  try {
    const summary = await importAgencyData(data, { dryRun });
    for (const p of summary.projects) {
      if (p.status === 'skipped') {
        console.log(`  ⚠ ${p.match}: ${p.reason}`);
      } else {
        console.log(
          `  ✓ ${p.project}: mains=${p.mains} subs=${p.subs} steps=${p.steps} comments=${p.comments} skipped=${p.skipped || 0}`,
        );
      }
    }
    console.log('');
    console.log('Totals:', summary.totals);
    if (dryRun) console.log('\nNo changes written. Re-run with --confirm to import.');
    else console.log('\nImport complete.');
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
