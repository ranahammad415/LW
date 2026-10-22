/**
 * Health score v2 backfill (docs/ledger/features/health-score.md). Computes past daily rows (yesterday back) from
 * stored GSC/GA4/GMB/lead/security data. CPU and DB only: no Google, AI or paid API call.
 * Days that already have a live (non-backfilled) row are kept. Writes HealthScoreDaily / ClientHealthDaily only.
 *
 *   node scripts/backfill-health.js --days 90 [--project <projectId>]
 *
 * Without --project: every ACTIVE/PAUSED/SETUP project that has a scoring profile. Days are capped by
 * HEALTH_BACKFILL_MAX_DAYS (default 90).
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { backfillProject, profileFor, SCORED_STATUSES, backfillMaxDays } from '../src/lib/health/healthScoreService.js';
import { HEALTH_PROJECT_SELECT } from '../src/lib/health/healthBundle.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const days = Math.min(Number(arg('days')) || backfillMaxDays(), backfillMaxDays());
const only = arg('project');

try {
  const projects = only
    ? await prisma.project.findMany({ where: { id: only }, select: HEALTH_PROJECT_SELECT })
    : await prisma.project.findMany({ where: { status: { in: SCORED_STATUSES } }, select: HEALTH_PROJECT_SELECT });
  const targets = projects.filter((p) => profileFor(p));
  console.log(`[backfill-health] ${targets.length} project(s), ${days} day(s)`);
  let total = 0;
  for (const p of targets) {
    try {
      const out = await backfillProject(p.id, { days });
      total += out.rows;
      console.log(`[backfill-health] ${p.name || p.id}: ${out.rows} row(s), ${out.kept} live day(s) kept`);
    } catch (err) {
      console.error(`[backfill-health] ${p.id} failed: ${err?.message || err}`);
    }
  }
  console.log(`[backfill-health] done: ${total} row(s)`);
} finally {
  await prisma.$disconnect();
}
