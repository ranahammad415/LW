#!/usr/bin/env node
/**
 * Converts a backlink inventory spreadsheet into backlinks-catalog.json.
 *
 * Usage:
 *   node prisma/data-import/convert-backlinks-xlsx.mjs "<file.xlsx>" [--out file] [--rate 200]
 *
 * The parsing and normalization live in src/lib/dataImport/backlinkXlsx.js; this
 * file is only the command-line wrapper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../../src/lib/dataImport/backlinkXlsx.js';
import { PKR_PER_USD } from '../../src/lib/dataImport/backlinkNormalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { rate: PKR_PER_USD };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--rate') args.rate = Number(argv[++i]) || PKR_PER_USD;
    else positional.push(argv[i]);
  }
  args.input = positional[0];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error(
    'Usage: node prisma/data-import/convert-backlinks-xlsx.mjs "<file.xlsx>" [--out file] [--rate 200]',
  );
  process.exit(1);
}

const outPath = path.resolve(args.out || path.join(__dirname, 'backlinks-catalog.json'));
const reportPath = outPath.replace(/\.json$/, '.report.json');

const { catalog, report } = convert(path.resolve(args.input), { rate: args.rate });

fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const { totals } = report;
console.log(`[convert-backlinks] header row ${report.headerRow}, rate ${args.rate} PKR = $1`);
console.log(`[convert-backlinks] ${totals.dataRows} data rows -> ${totals.uniqueSites} unique sites`);
console.log(
  `[convert-backlinks] merged ${totals.mergedDuplicates} duplicate domains (highest price wins)`,
);
console.log(
  `[convert-backlinks] rejected ${totals.rejected} rows, skipped ${totals.skippedNonDataRows} non-data rows`,
);
for (const row of report.rejectedRows.slice(0, 10)) {
  console.log(`  ! row ${row.rowNumber} ${row.website} -> ${row.reason}`);
}
if (report.rejectedRows.length > 10) {
  console.log(`  ... ${report.rejectedRows.length - 10} more in the report`);
}
const prices = catalog.sites.map((s) => s.priceUsd);
console.log(`[convert-backlinks] price range $${Math.min(...prices)} - $${Math.max(...prices)}`);
console.log(`[convert-backlinks] wrote ${outPath}`);
console.log(`[convert-backlinks] wrote ${reportPath}`);
