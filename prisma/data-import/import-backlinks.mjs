#!/usr/bin/env node
/**
 * Loads a backlink catalog JSON into the database from the command line.
 *
 * Usage:
 *   node prisma/data-import/import-backlinks.mjs                  # dry run of the default catalog
 *   node prisma/data-import/import-backlinks.mjs --apply          # write to the database
 *   node prisma/data-import/import-backlinks.mjs --file x.json --mode replace
 *
 * Dry run is the default so a mistyped path or a bad file cannot mutate the catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../src/lib/prisma.js';
import { importBacklinkSites } from '../../src/lib/dataImport/importBacklinkSites.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { apply: false, mode: 'merge', file: path.join(__dirname, 'backlinks-catalog.json') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = path.resolve(args.file);

  if (!fs.existsSync(resolved)) {
    console.error(`[import-backlinks] no such file: ${resolved}`);
    console.error('[import-backlinks] run convert-backlinks-xlsx.mjs first');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const dryRun = !args.apply;

  console.log(`[import-backlinks] ${resolved}`);
  console.log(`[import-backlinks] mode=${args.mode} dryRun=${dryRun}`);

  const summary = await importBacklinkSites(data, { dryRun, mode: args.mode });

  console.log(
    `[import-backlinks] received=${summary.received} valid=${summary.valid} unique=${summary.uniqueSites}`,
  );
  console.log(
    `[import-backlinks] created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} deactivated=${summary.deactivated}`,
  );
  console.log(
    `[import-backlinks] mergedDuplicates=${summary.mergedDuplicates} priceChanges=${summary.priceChanges.length} errors=${summary.errorCount}`,
  );

  for (const error of summary.errors.slice(0, 10)) {
    console.log(`  ! ${error.domain ?? `row ${error.index}`}: ${error.reason}`);
  }
  for (const change of summary.priceChanges.slice(0, 10)) {
    console.log(`  ~ ${change.domain}: $${change.fromUsd} -> $${change.toUsd}`);
  }

  if (dryRun) {
    console.log('[import-backlinks] dry run only — re-run with --apply to write these changes');
  } else {
    const total = await prisma.backlinkSite.count();
    const active = await prisma.backlinkSite.count({ where: { isActive: true } });
    console.log(`[import-backlinks] catalog now holds ${total} sites (${active} active)`);
  }
}

main()
  .catch((err) => {
    console.error(`[import-backlinks] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
