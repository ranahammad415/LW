#!/usr/bin/env node
/**
 * Map a Google extraction package to agency-data v1.1 JSON.
 *
 * Usage:
 *   node prisma/map-extraction-package.cjs --extractionDir extractions/run-id --projectMatch "Roman Electric"
 *   node prisma/map-extraction-package.cjs --extractionDir extractions/run-id --projectMatch "Roman" --ai --out mapped.json
 */
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');

function parseArgs(argv) {
  const args = {
    extractionDir: null,
    projectMatch: null,
    clientMatch: null,
    planLabel: null,
    out: null,
    ai: false,
    importMode: 'plan_with_progress',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ai') args.ai = true;
    else if (a === '--extractionDir' && argv[i + 1]) args.extractionDir = argv[++i];
    else if (a === '--projectMatch' && argv[i + 1]) args.projectMatch = argv[++i];
    else if (a === '--clientMatch' && argv[i + 1]) args.clientMatch = argv[++i];
    else if (a === '--planLabel' && argv[i + 1]) args.planLabel = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--importMode' && argv[i + 1]) args.importMode = argv[++i];
    else if (a.startsWith('--extractionDir=')) args.extractionDir = a.slice('--extractionDir='.length);
    else if (a.startsWith('--projectMatch=')) args.projectMatch = a.slice('--projectMatch='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.extractionDir || !args.projectMatch) {
    console.error(
      'Usage: node prisma/map-extraction-package.cjs --extractionDir <dir> --projectMatch <substring> [--ai] [--out file.json]',
    );
    process.exitCode = 1;
    return;
  }

  let extractionDir = args.extractionDir;
  if (!path.isAbsolute(extractionDir)) {
    extractionDir = path.join(__dirname, '..', extractionDir);
  }

  const { mapExtractionPackage } = await import('../src/lib/dataImport/mapExtractionPackage.js');

  console.log('');
  console.log('Extraction → Agency Data Mapper');
  console.log('================================');
  console.log(`Dir:            ${extractionDir}`);
  console.log(`Project match:  ${args.projectMatch}`);
  console.log(`AI:             ${args.ai}`);
  console.log('');

  try {
    const data = await mapExtractionPackage(extractionDir, {
      useAi: args.ai,
      projectNameContains: args.projectMatch,
      clientNameContains: args.clientMatch,
      planLabel: args.planLabel || `Import — ${args.projectMatch}`,
      importMode: args.importMode,
    });

    const outPath = args.out
      ? path.isAbsolute(args.out)
        ? args.out
        : path.resolve(process.cwd(), args.out)
      : path.join(extractionDir, 'agency-data.mapped.json');

    await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');

    const groups = data.projects?.[0]?.taskGroups?.length || 0;
    const tasks = (data.projects?.[0]?.taskGroups || []).reduce((n, g) => n + (g.tasks?.length || 0), 0);
    console.log(`Mapped: ${groups} task groups, ${tasks} tasks`);
    console.log(`Output: ${outPath}`);
    console.log('\nReview the JSON, then:');
    console.log(`  node prisma/import-agency-data.cjs --file "${outPath}" --dryRun`);
    console.log(`  node prisma/import-agency-data.cjs --file "${outPath}" --confirm`);
  } catch (err) {
    console.error('Mapping failed:', err.message);
    process.exitCode = 1;
  }
}

main();
