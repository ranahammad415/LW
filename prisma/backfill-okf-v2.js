/**
 * Backfills the OKF v2 folder spec and asset index for every existing client.
 *
 * Safe to re-run: the folder generator skips files that already exist, so v1
 * content written under the old 9-folder layout is never overwritten.
 *
 * Usage:
 *   node prisma/backfill-okf-v2.js            # all active clients
 *   node prisma/backfill-okf-v2.js --all      # include inactive clients
 *   node prisma/backfill-okf-v2.js --client <id>
 */
import '../src/loadEnv.js';
import { prisma } from '../src/lib/prisma.js';
import { initializeClientDirs } from '../src/lib/knowledgeEngine.js';
import { generateOkfSpecStructure, validateOkfSpecCompliance } from '../src/lib/okfFolderGeneratorService.js';
import { reindexOkfAssets } from '../src/lib/okfIndexingService.js';
import { assessOkfIntakeCompleteness, INTAKE_STATUSES } from '../src/lib/businessIntakeService.js';

function parseArgs(argv) {
  const includeInactive = argv.includes('--all');
  const clientFlagIndex = argv.indexOf('--client');
  const clientId = clientFlagIndex !== -1 ? argv[clientFlagIndex + 1] : null;
  return { includeInactive, clientId };
}

async function main() {
  const { includeInactive, clientId } = parseArgs(process.argv.slice(2));

  const clients = await prisma.clientAccount.findMany({
    where: {
      ...(clientId ? { id: clientId } : {}),
      ...(includeInactive || clientId ? {} : { isActive: true }),
    },
    select: { id: true, agencyName: true, intakeStatus: true },
    orderBy: { createdAt: 'asc' },
  });

  if (clients.length === 0) {
    console.log('[backfill-okf-v2] No matching clients found.');
    return;
  }

  console.log(`[backfill-okf-v2] Processing ${clients.length} client(s)...`);

  let succeeded = 0;
  const failures = [];

  for (const client of clients) {
    const label = `${client.agencyName} (${client.id})`;
    try {
      initializeClientDirs(client.id);

      const spec = await generateOkfSpecStructure(client.id, { agencyName: client.agencyName });
      const index = await reindexOkfAssets(client.id);
      if (!index.success) throw new Error(index.message || 'reindex failed');

      const compliance = await validateOkfSpecCompliance(client.id);
      const assessment = assessOkfIntakeCompleteness(client.id);

      // Only seed a status for clients that have never been assessed; never
      // downgrade a client whose intake was already approved.
      if (!client.intakeStatus) {
        await prisma.clientAccount.update({
          where: { id: client.id },
          data: {
            intakeStatus: assessment.geoReady
              ? INTAKE_STATUSES.APPROVED
              : assessment.profileComplete
                ? INTAKE_STATUSES.REVIEW_REQUIRED
                : INTAKE_STATUSES.NOT_STARTED,
          },
        });
      }

      console.log(
        `  ✓ ${label} — ${spec.created.length} created, ${spec.skipped.length} kept, ` +
        `index +${index.createdCount}/~${index.updatedCount}/-${index.deletedCount}, ` +
        `spec ${compliance.compliant ? 'compliant' : `missing ${compliance.missing.length}`}`
      );
      succeeded++;
    } catch (err) {
      console.error(`  ✗ ${label} — ${err.message}`);
      failures.push({ client: label, error: err.message });
    }
  }

  // writeOkfFile records revisions on a fire-and-forget queue; give it a moment
  // to drain before the process disconnects Prisma.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[backfill-okf-v2] Done. ${succeeded} succeeded, ${failures.length} failed.`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[backfill-okf-v2] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
