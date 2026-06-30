#!/usr/bin/env node
/**
 * Upload Phinix June 2026 task plans into Agency OS (Localwaves).
 *
 * Steps:
 *   1. Fetch all assignee tabs from Google Sheets → agency-data JSON
 *   2. Dry-run import (preview)
 *   3. Live import with --confirm
 *
 * Usage:
 *   node prisma/upload-phinix-to-agency-os.cjs
 *   node prisma/upload-phinix-to-agency-os.cjs --confirm
 *   node prisma/upload-phinix-to-agency-os.cjs --skipBuild --file data-import/agency-data.phinix-june-2026.json --confirm
 *   node prisma/upload-phinix-to-agency-os.cjs --project "Roman Electric" --confirm
 *   node prisma/upload-phinix-to-agency-os.cjs --sync-comments --confirm   # updates only (tasks already exist)
 */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');

function parseArgs(argv) {
  const args = {
    confirm: false,
    skipBuild: false,
    syncComments: false,
    file: null,
    projects: [],
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--skipBuild' || a === '--skip-build') args.skipBuild = true;
    else if (a === '--sync-comments' || a === '--syncComments') args.syncComments = true;
    else if (a === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--project' && argv[i + 1]) args.projects.push(argv[++i]);
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const defaultOut = path.join(__dirname, 'data-import', 'agency-data.phinix-june-2026.json');
  const outPath = args.file
    ? path.isAbsolute(args.file)
      ? args.file
      : path.resolve(process.cwd(), args.file)
    : args.out
      ? path.isAbsolute(args.out)
        ? args.out
        : path.resolve(process.cwd(), args.out)
      : defaultOut;

  console.log('');
  console.log('Phinix → Agency OS Upload');
  console.log('=========================');
  console.log(`Confirm:    ${args.confirm}`);
  console.log(`Skip build: ${args.skipBuild}`);
  console.log(`File:       ${outPath}`);
  console.log('');

  try {
    if (!args.skipBuild) {
      console.log('Step 1/3 — Building agency-data from Google Sheets...');
      const { buildPhinixAgencyData } = await import('../src/lib/dataImport/buildPhinixAgencyData.js');
      const data = await buildPhinixAgencyData({
        projects: args.projects.length ? args.projects : undefined,
      });
      const { _buildLog, ...exportData } = data;
      for (const p of exportData.projects || []) {
        delete p._importMeta;
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(exportData, null, 2), 'utf8');
      for (const line of _buildLog || []) {
        if (line.tasks) console.log(`  ✓ ${line.project}: ${line.tasks} tasks`);
        else if (line.error) console.log(`  ✗ ${line.project}: ${line.error}`);
      }
      console.log('');
    }

    console.log('Step 2/3 — Dry-run import preview...');
    const raw = await fs.readFile(outPath, 'utf8');
    const data = JSON.parse(raw);

    const { importAgencyData } = await import('../src/lib/dataImport/importAgencyData.js');
    const { prisma } = await import('../src/lib/prisma.js');

    const drySummary = await importAgencyData(data, { dryRun: true });
    for (const p of drySummary.projects) {
      if (p.status === 'skipped') {
        console.log(`  ⚠ SKIP: ${p.match} — ${p.reason}`);
      } else {
        console.log(
          `  ✓ ${p.project}: mains=${p.mains} subs=${p.subs} steps=${p.steps} comments=${p.comments}`,
        );
      }
    }
    console.log('  Totals:', drySummary.totals);

    const noNewTasks =
      (drySummary.totals.mains || 0) +
        (drySummary.totals.subs || 0) +
        (drySummary.totals.steps || 0) ===
      0;
    const willPostComments = (drySummary.totals.comments || 0) > 0;

    if (noNewTasks && willPostComments) {
      console.log('');
      console.log('ℹ Tasks already exist in Agency OS (milestone titles match).');
      console.log('  No new mains/subs/steps will be created on this run.');
      if (!args.syncComments) {
        console.log('');
        console.log('  Re-running would duplicate task comments. To sync status/comments only:');
        console.log(`    node prisma/upload-phinix-to-agency-os.cjs --skipBuild --sync-comments --confirm`);
        console.log('');
        console.log('  To re-create all tasks from scratch, wipe June tasks first:');
        console.log('    node prisma/wipe-may-2026-tasks.cjs');
        if (args.confirm) {
          console.error('\nAborted live import. Pass --sync-comments to update existing tasks only.');
          process.exitCode = 1;
          await prisma.$disconnect();
          return;
        }
      }
    }

    if (args.syncComments) {
      data.meta = { ...data.meta, importMode: 'sync_progress' };
    }

    const skipped = drySummary.projects.filter((p) => p.status === 'skipped');
    if (skipped.length === drySummary.projects.length) {
      console.error('\nAll projects skipped — no matching projects in database.');
      console.error('Ensure Localwaves has projects matching: Roman Electric, Milwaukee Signs, P2EzPay, etc.');
      process.exitCode = 1;
      await prisma.$disconnect();
      return;
    }

    if (!args.confirm) {
      console.log('');
      console.log('Step 3/3 — SKIPPED (dry-run only).');
      console.log('Re-run with --confirm to create tasks, comments, and statuses in Agency OS:');
      console.log(`  node prisma/upload-phinix-to-agency-os.cjs --skipBuild --file "${outPath}" --confirm`);
      await prisma.$disconnect();
      return;
    }

    console.log('');
    console.log('Step 3/3 — Live import into Agency OS...');
    const summary = await importAgencyData(data, { dryRun: false });
    for (const p of summary.projects) {
      if (p.status !== 'skipped') {
        console.log(
          `  ✓ ${p.project}: mains=${p.mains} subs=${p.subs} steps=${p.steps} comments=${p.comments}`,
        );
      }
    }
    console.log('');
    console.log('Import complete.', summary.totals);
    await prisma.$disconnect();
  } catch (err) {
    console.error('Upload failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

main();
