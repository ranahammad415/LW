#!/usr/bin/env node
/**
 * CLI: recursive Google Doc/Sheet/Drive knowledge extraction.
 *
 * Usage:
 *   node prisma/extract-google-knowledge.cjs --rootUrl "https://docs.google.com/document/d/ID/edit"
 *   node prisma/extract-google-knowledge.cjs --rootUrl "..." --out extractions/my-run
 *   node prisma/extract-google-knowledge.cjs --resume --out extractions/my-run
 */
require('dotenv').config();
const path = require('path');

function parseArgs(argv) {
  const args = {
    rootUrl: null,
    out: null,
    maxDepth: null,
    maxFiles: null,
    dryRun: false,
    resume: false,
    month: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dryRun' || a === '--dry-run') args.dryRun = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--rootUrl' && argv[i + 1]) args.rootUrl = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--maxDepth' && argv[i + 1]) args.maxDepth = Number(argv[++i]);
    else if (a === '--maxFiles' && argv[i + 1]) args.maxFiles = Number(argv[++i]);
    else if (a === '--month' && argv[i + 1]) args.month = argv[++i];
    else if (a.startsWith('--rootUrl=')) args.rootUrl = a.slice('--rootUrl='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const { runExtraction } = await import('../src/lib/googleKnowledge/runExtraction.js');
  const { getServiceAccountEmail, isWorkspaceAuthConfigured } = await import(
    '../src/lib/googleKnowledge/auth.js'
  );

  if (!isWorkspaceAuthConfigured()) {
    console.error('Google Workspace auth not configured.');
    console.error('Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_WORKSPACE_REFRESH_TOKEN in .env');
    process.exitCode = 1;
    return;
  }

  const shareWith = await getServiceAccountEmail();
  if (shareWith) {
    console.log(`Service account (share files with Viewer): ${shareWith}`);
  } else {
    console.log('Using OAuth refresh token for Google Workspace access.');
  }

  let outDir = args.out;
  if (outDir && !path.isAbsolute(outDir)) {
    outDir = path.join(__dirname, '..', outDir);
  }

  console.log('');
  console.log('Google Knowledge Extractor');
  console.log('==========================');
  if (args.resume) {
    console.log(`Mode:     RESUME`);
    console.log(`Out dir:  ${outDir}`);
  } else {
    console.log(`Root URL: ${args.rootUrl}`);
    console.log(`Dry run:  ${args.dryRun}`);
    if (args.month) console.log(`Month:    ${args.month}`);
  }
  console.log('');

  try {
    const result = await runExtraction({
      rootUrl: args.rootUrl,
      outDir,
      maxDepth: args.maxDepth ?? undefined,
      maxFiles: args.maxFiles ?? undefined,
      dryRun: args.dryRun,
      resume: args.resume,
      monthFilter: args.month,
      onProgress: (ev) => {
        if (ev.type === 'extracted') {
          console.log(`  ✓ ${ev.title || ev.fileId}`);
        } else if (ev.type === 'error' && ev.accessNeeded) {
          console.log(`  ⚠ access needed: ${ev.fileId}`);
        } else if (ev.type === 'dry_run') {
          console.log(`  · discovered ${ev.fileId}`);
        }
      },
    });

    console.log('');
    console.log('Done.');
    console.log(`  Run ID:          ${result.runId}`);
    console.log(`  Output:          ${result.outDir}`);
    console.log(`  Nodes:           ${result.stats?.nodeCount ?? 0}`);
    console.log(`  Access needed:   ${result.stats?.accessNeededCount ?? 0}`);
    if (result.stats?.truncated) console.log('  ⚠ File limit reached — increase --maxFiles');
    if (result.accessNeeded?.length) {
      console.log('');
      console.log('Share blocked files (see access-needed.json), then:');
      console.log(`  node prisma/extract-google-knowledge.cjs --resume --out ${args.out || result.outDir}`);
    }
    console.log('');
    console.log(`  Report: ${result.reportPath}`);
  } catch (err) {
    console.error('');
    console.error('Extraction failed:', err.message || err);
    process.exitCode = 1;
  }
}

main();
