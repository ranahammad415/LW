/**
 * seed-july-2026-tasks.cjs
 *
 * Seeds the July 2026 monthly SEO task plan into ALL SEO_CAMPAIGN projects.
 * Source: July Task 2026.xlsx (25 tasks across On-Page / Technical / Off-Page / Local).
 *
 * Hierarchy:
 *   Main Task  = Category (On-Page SEO, Technical SEO, Off-Page SEO, Local SEO)
 *   Sub Task   = each spreadsheet row (title + instructions)
 *
 * Tasks are attached to the July 2026 WorkCycle (created if missing).
 * Assignee defaults to "Haider" when found; otherwise the project lead PM / fallback PM.
 *
 * Usage:
 *   node prisma/seed-july-2026-tasks.cjs
 *   node prisma/seed-july-2026-tasks.cjs --dry-run
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JULY_TASKS = require('./tasks-july-2026/july-tasks.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const CYCLE_MONTH = 7;
const CYCLE_YEAR = 2026;

const TASKTYPE_TO_PRESET = {
  'content-writing': 'Content Writing',
  'content-audit': 'Monthly Report (Read-Only)',
  'on-page-seo': 'Meta Optimisation',
  'technical-seo': 'Technical SEO',
  'local-seo': 'Technical SEO',
  'keyword-research': 'Monthly Report (Read-Only)',
  'link-building': 'Technical SEO',
  'aeo-geo': 'Technical SEO',
  'ux-audit': 'Monthly Report (Read-Only)',
  cro: 'Meta Optimisation',
  reporting: 'Monthly Report (Read-Only)',
  'crawl-fix': 'Crawl Fix',
  schema: 'Schema Deployment',
  'schema-deployment': 'Schema Deployment',
  'meta-optimisation': 'Meta Optimisation',
  'monthly-report': 'Monthly Report (Read-Only)',
  'strategy-call': 'Strategy Call (Read-Only)',
  'onboarding-task': 'Onboarding / Full Setup',
};

function monthLabel(month, year) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const name = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${name} ${year}`;
}

async function findUserByNameKey(key) {
  return prisma.user.findFirst({
    where: { name: { contains: key }, isActive: true },
  });
}

function buildMainDescription(groupTasks) {
  const blocks = [];
  for (const t of groupTasks) {
    const parts = [`### ${t.title}`];
    if (t.section) parts.push(`**Section:** ${t.section}`);
    if (t.description) parts.push(t.description.trim());
    blocks.push(parts.join('\n\n'));
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

async function ensureJulyCycle() {
  const existing = await prisma.workCycle.findUnique({
    where: { month_year: { month: CYCLE_MONTH, year: CYCLE_YEAR } },
  });
  if (existing) return existing;

  if (DRY_RUN) {
    console.log(`  [dry-run] would create WorkCycle ${monthLabel(CYCLE_MONTH, CYCLE_YEAR)}`);
    return { id: 'dry-run-cycle', month: CYCLE_MONTH, year: CYCLE_YEAR, label: monthLabel(CYCLE_MONTH, CYCLE_YEAR) };
  }

  return prisma.workCycle.create({
    data: {
      month: CYCLE_MONTH,
      year: CYCLE_YEAR,
      status: 'OPEN',
      label: monthLabel(CYCLE_MONTH, CYCLE_YEAR),
    },
  });
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              July 2026 Task Plan Seeder                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  MODE: dry-run (no writes)');
  console.log('');

  if (!prisma.workCycle) {
    console.error('✗ prisma.workCycle is undefined.');
    console.error('  Run: npx prisma generate && restart the API process, then re-run this script.');
    process.exitCode = 1;
    return;
  }

  // ─── WP presets ─────────────────────────────────────────────────────────────
  const presets = await prisma.wpAccessPreset.findMany({ select: { id: true, name: true } });
  const presetIdByName = Object.fromEntries(presets.map((p) => [p.name, p.id]));
  const resolvePresetId = (taskType) => {
    const name = TASKTYPE_TO_PRESET[taskType];
    return name ? presetIdByName[name] || null : null;
  };
  console.log(`  ✓ WP presets loaded: ${presets.length}`);

  // ─── July work cycle ────────────────────────────────────────────────────────
  console.log('→ Ensuring July 2026 work cycle...');
  const cycle = await ensureJulyCycle();
  console.log(`  ✓ cycle → ${cycle.label} (${cycle.id})`);
  console.log('');

  // ─── Assignee (Haider) + fallback PM ────────────────────────────────────────
  console.log('→ Resolving assignees...');
  const haider = await findUserByNameKey('haider');
  if (haider) {
    console.log(`  ✓ haider → ${haider.name} <${haider.email}>`);
  } else {
    console.warn('  ⚠ Haider not found — will fall back to each project lead PM / fallback PM.');
  }

  const fallbackPm = await prisma.user.findFirst({
    where: { role: 'PM', isActive: true },
  });
  if (!fallbackPm) {
    console.error('✗ No active PM found for fallback createdById. Aborting.');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ fallbackPM → ${fallbackPm.name} <${fallbackPm.email}>`);
  console.log('');

  // ─── All SEO campaign projects ──────────────────────────────────────────────
  console.log('→ Loading SEO_CAMPAIGN projects...');
  const projects = await prisma.project.findMany({
    where: { projectType: 'SEO_CAMPAIGN' },
    include: { client: true, leadPm: true },
    orderBy: { name: 'asc' },
  });
  console.log(`  ✓ found ${projects.length} project(s)`);
  console.log('');

  if (projects.length === 0) {
    console.error('✗ No SEO_CAMPAIGN projects in DB. Aborting.');
    process.exitCode = 1;
    return;
  }

  // Group flat tasks by Category (milestone) → Main Task
  const groups = new Map();
  for (const t of JULY_TASKS) {
    const key = t.milestone || '(Unspecified)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const summary = [];

  for (const project of projects) {
    const createdById = project.leadPmId || fallbackPm.id;
    const defaultAssignee = haider || project.leadPm || fallbackPm;

    const existing = await prisma.task.findMany({
      where: { projectId: project.id, workCycleId: cycle.id },
      select: { title: true },
    });
    const existingTitles = new Set(existing.map((t) => t.title));

    let mainCreated = 0;
    let subCreated = 0;
    let skipped = 0;

    for (const [mainTitle, groupTasks] of groups) {
      if (existingTitles.has(mainTitle)) {
        skipped++;
        continue;
      }

      const firstSub = groupTasks[0];

      if (DRY_RUN) {
        mainCreated++;
        subCreated += groupTasks.length;
        continue;
      }

      const mainTask = await prisma.task.create({
        data: {
          projectId: project.id,
          title: mainTitle,
          taskType: firstSub.taskType,
          priority: 'HIGH',
          status: 'TO_DO',
          milestone: null,
          description: buildMainDescription(groupTasks),
          clientVisible: true,
          createdById,
          workCycleId: cycle.id,
          wpAccessPresetId: resolvePresetId(firstSub.taskType),
          assignees: { connect: [{ id: defaultAssignee.id }] },
        },
      });
      mainCreated++;

      for (const task of groupTasks) {
        await prisma.task.create({
          data: {
            projectId: project.id,
            parentTaskId: mainTask.id,
            title: task.title,
            taskType: task.taskType,
            priority: task.priority || 'MEDIUM',
            status: 'TO_DO',
            milestone: task.milestone || null,
            description: task.description || null,
            clientVisible: true,
            createdById,
            workCycleId: cycle.id,
            wpAccessPresetId: resolvePresetId(task.taskType),
            assignees: { connect: [{ id: defaultAssignee.id }] },
          },
        });
        subCreated++;
      }
    }

    summary.push({
      project: project.name,
      client: project.client?.agencyName || '—',
      mains: mainCreated,
      subs: subCreated,
      skipped,
    });
    console.log(
      `  ✓ ${project.name.padEnd(36)} — ${mainCreated} mains, ${subCreated} subs${
        skipped ? `, ${skipped} skipped` : ''
      }`,
    );
  }

  console.log('');
  console.log('═══════════════════════ SEED SUMMARY ═══════════════════════');
  let totalMains = 0;
  let totalSubs = 0;
  for (const s of summary) {
    totalMains += s.mains;
    totalSubs += s.subs;
    console.log(
      `  ${s.project.padEnd(36)} mains=${s.mains}  subs=${s.subs}  skipped=${s.skipped}`,
    );
  }
  console.log('─'.repeat(60));
  console.log(`  Projects touched:     ${summary.length}`);
  console.log(`  Main tasks created:   ${totalMains}`);
  console.log(`  Sub tasks created:    ${totalSubs}`);
  console.log(`  Total tasks created:  ${totalMains + totalSubs}`);
  console.log('');
  console.log(DRY_RUN ? 'Dry run complete (no DB writes).' : 'Done.');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
