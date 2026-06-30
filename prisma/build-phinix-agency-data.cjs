#!/usr/bin/env node
/**
 * Build agency-data v1.1 JSON from Phinix Google Sheets (June 2026 task plans).
 *
 * Usage:
 *   node prisma/build-phinix-agency-data.cjs
 *   node prisma/build-phinix-agency-data.cjs --out data-import/agency-data.phinix-june-2026.json
 *   node prisma/build-phinix-agency-data.cjs --project "Roman Electric"
 *   node prisma/build-phinix-agency-data.cjs --fromFile path/to/cached.csv --project Roman
 */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');

function parseArgs(argv) {
  const args = { out: null, projects: [], fromFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--project' && argv[i + 1]) args.projects.push(argv[++i]);
    else if (a === '--fromFile' && argv[i + 1]) args.fromFile = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.resolve(process.cwd(), args.out)
    : path.join(__dirname, 'data-import', 'agency-data.phinix-june-2026.json');

  const { buildPhinixAgencyData } = await import('../src/lib/dataImport/buildPhinixAgencyData.js');

  console.log('');
  console.log('Phinix → Agency Data Builder');
  console.log('============================');
  if (args.projects.length) console.log(`Projects:   ${args.projects.join(', ')}`);
  console.log(`Output:     ${outPath}`);
  console.log('');

  try {
    const data = await buildPhinixAgencyData({
      projects: args.projects.length ? args.projects : undefined,
    });

    const { _buildLog, ...exportData } = data;
      for (const p of exportData.projects || []) {
        delete p._importMeta;
        for (const g of p.taskGroups || []) {
          for (const t of g.tasks || []) {
            delete t._completionDetails;
            delete t._stepsRaw;
            delete t._statusRaw;
            delete t._assigneeTab;
          }
        }
      }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(exportData, null, 2), 'utf8');

    console.log('Build summary:');
    for (const line of _buildLog || []) {
      if (line.error) console.log(`  ✗ ${line.project} / ${line.tab}: ${line.error}`);
      else if (line.warning) console.log(`  ⚠ ${line.project}: ${line.warning}`);
      else
        console.log(
          `  ✓ ${line.project}: ${line.taskGroups} groups, ${line.tasks} tasks, ${line.updates} updates`,
        );
    }

    const totalTasks = (exportData.projects || []).reduce(
      (n, p) => n + (p._importMeta?.taskCount || p.taskGroups?.reduce((s, g) => s + g.tasks.length, 0) || 0),
      0,
    );
    console.log('');
    console.log(`Projects: ${exportData.projects?.length || 0}`);
    console.log(`Tasks:    ${totalTasks}`);
    console.log(`Written:  ${outPath}`);
    console.log('');
    console.log('Next:');
    console.log(`  npm run import:agency -- --file "${outPath}" --dryRun`);
    console.log(`  npm run upload:phinix -- --confirm`);
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exitCode = 1;
  }
}

main();
