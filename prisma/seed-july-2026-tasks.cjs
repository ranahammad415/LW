/**
 * seed-july-2026-tasks.cjs
 *
 * Seeds the July 2026 monthly SEO task plan.
 *
 * Templates:
 *   - JULY_TASKS            → all SEO_CAMPAIGN projects except Wilhelmina
 *                             (from July Task 2026.xlsx — 25 monthly tasks)
 *   - WILHELMINA_JULY_TASKS → Wilhelmina only
 *                             (from Wilhelmina Ballons Working Strategy.xlsx)
 *
 * Hierarchy:
 *   Main Task  = milestone / Category
 *   Sub Task   = each template row
 *   Step Task  = each steps[] item (Wilhelmina strategy only)
 *
 * Usage:
 *   node prisma/seed-july-2026-tasks.cjs
 *   node prisma/seed-july-2026-tasks.cjs --dry-run
 *   node prisma/seed-july-2026-tasks.cjs --wilhelmina-only --force-wilhelmina
 *   node prisma/seed-july-2026-tasks.cjs --wilhelmina-only --force-wilhelmina --replace
 *       (--replace deletes existing July-cycle tasks for matched projects first)
 *
 * Wilhelmina is OS-managed: agency import never recreates its tasks. Seeding
 * Wilhelmina requires --force-wilhelmina so accidental runs cannot revive deletes.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JULY_TASKS = require('./tasks-july-2026/july-tasks.cjs');
const WILHELMINA_JULY_TASKS = require('./tasks-july-2026/wilhelmina-july-tasks.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const WILHELMINA_ONLY = process.argv.includes('--wilhelmina-only');
const FORCE_WILHELMINA = process.argv.includes('--force-wilhelmina');
const REPLACE = process.argv.includes('--replace');
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
    if (t.goal) parts.push(`**Goal:** ${t.goal}`);
    if (t.description) parts.push(String(t.description).trim());
    const steps = Array.isArray(t.steps)
      ? t.steps.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    if (steps.length) {
      parts.push('**Steps:**');
      parts.push(steps.map((s) => `- ${s}`).join('\n'));
    }
    blocks.push(parts.join('\n\n'));
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

function buildDescription(task) {
  const goal = (task.goal || '').trim();
  const desc = (task.description || '').trim();
  if (goal && desc) return `**Goal:** ${goal}\n\n${desc}`;
  if (goal) return `**Goal:** ${goal}`;
  if (desc) return desc;
  return null;
}

function isWilhelminaProject(project) {
  const hay = `${project.name || ''} ${project.client?.agencyName || ''}`.toLowerCase();
  return hay.includes('wilhelmina');
}

async function ensureJulyCycle() {
  const existing = await prisma.workCycle.findUnique({
    where: { month_year: { month: CYCLE_MONTH, year: CYCLE_YEAR } },
  });
  if (existing) return existing;

  if (DRY_RUN) {
    console.log(`  [dry-run] would create WorkCycle ${monthLabel(CYCLE_MONTH, CYCLE_YEAR)}`);
    return {
      id: 'dry-run-cycle',
      month: CYCLE_MONTH,
      year: CYCLE_YEAR,
      label: monthLabel(CYCLE_MONTH, CYCLE_YEAR),
    };
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

async function deleteJulyTasksForProject(projectId, cycleId) {
  // Delete children first (steps → subs → mains) to satisfy parentTaskId FKs.
  const tasks = await prisma.task.findMany({
    where: { projectId, workCycleId: cycleId },
    select: { id: true, parentTaskId: true },
  });
  if (!tasks.length) return 0;

  const ids = new Set(tasks.map((t) => t.id));
  const steps = tasks.filter((t) => t.parentTaskId && ids.has(t.parentTaskId));
  // Rough depth: delete deepest first by repeatedly deleting leaves.
  let deleted = 0;
  let remaining = [...tasks];
  while (remaining.length) {
    const remainingIds = new Set(remaining.map((t) => t.id));
    const parentsOfRemaining = new Set(
      remaining.map((t) => t.parentTaskId).filter((id) => id && remainingIds.has(id)),
    );
    const leaves = remaining.filter((t) => !parentsOfRemaining.has(t.id));
    const leafIds = leaves.map((t) => t.id);
    if (!leafIds.length) {
      // Safety: delete whatever is left
      await prisma.task.deleteMany({ where: { id: { in: remaining.map((t) => t.id) } } });
      deleted += remaining.length;
      break;
    }
    await prisma.task.deleteMany({ where: { id: { in: leafIds } } });
    deleted += leafIds.length;
    const leafSet = new Set(leafIds);
    remaining = remaining.filter((t) => !leafSet.has(t.id));
  }
  return deleted;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              July 2026 Task Plan Seeder                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  MODE: dry-run (no writes)');
  if (WILHELMINA_ONLY) console.log('  SCOPE: Wilhelmina only');
  if (REPLACE) console.log('  REPLACE: wipe existing July-cycle tasks before seed');
  console.log('');

  if (WILHELMINA_ONLY && !FORCE_WILHELMINA) {
    console.error('✗ Wilhelmina is OS-managed. Seeding is blocked so deleted tasks stay deleted.');
    console.error('  If you really need a one-time rebuild, pass --force-wilhelmina.');
    process.exitCode = 1;
    return;
  }

  if (!prisma.workCycle) {
    console.error('✗ prisma.workCycle is undefined.');
    console.error('  Run: npx prisma generate && restart the API process, then re-run this script.');
    process.exitCode = 1;
    return;
  }

  const presets = await prisma.wpAccessPreset.findMany({ select: { id: true, name: true } });
  const presetIdByName = Object.fromEntries(presets.map((p) => [p.name, p.id]));
  const resolvePresetId = (taskType) => {
    const name = TASKTYPE_TO_PRESET[taskType];
    return name ? presetIdByName[name] || null : null;
  };
  console.log(`  ✓ WP presets loaded: ${presets.length}`);

  console.log('→ Ensuring July 2026 work cycle...');
  const cycle = await ensureJulyCycle();
  console.log(`  ✓ cycle → ${cycle.label} (${cycle.id})`);
  console.log('');

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

  console.log('→ Loading SEO_CAMPAIGN projects...');
  let projects = await prisma.project.findMany({
    where: { projectType: 'SEO_CAMPAIGN' },
    include: { client: true, leadPm: true },
    orderBy: { name: 'asc' },
  });
  if (WILHELMINA_ONLY) {
    projects = projects.filter(isWilhelminaProject);
  }
  console.log(`  ✓ found ${projects.length} project(s)`);
  console.log('');

  if (projects.length === 0) {
    console.error('✗ No matching SEO_CAMPAIGN projects. Aborting.');
    process.exitCode = 1;
    return;
  }

  const summary = [];

  for (const project of projects) {
    const useWilhelmina = isWilhelminaProject(project);
    // Default July seed never touches Wilhelmina (OS-managed).
    if (useWilhelmina && !FORCE_WILHELMINA) {
      console.log(`  ⊘ skip ${project.name}: Wilhelmina is OS-managed (pass --force-wilhelmina to seed)`);
      continue;
    }
    const tasks = useWilhelmina ? WILHELMINA_JULY_TASKS : JULY_TASKS;
    const templateLabel = useWilhelmina ? 'WILHELMINA' : 'JULY';

    if (WILHELMINA_ONLY && !useWilhelmina) continue;

    const createdById = project.leadPmId || fallbackPm.id;
    const defaultAssignee = haider || project.leadPm || fallbackPm;

    if (REPLACE) {
      if (DRY_RUN) {
        const count = await prisma.task.count({
          where: { projectId: project.id, workCycleId: cycle.id },
        });
        console.log(`  [dry-run] would delete ${count} July tasks for ${project.name}`);
      } else {
        const deleted = await deleteJulyTasksForProject(project.id, cycle.id);
        console.log(`  ✎ replaced: deleted ${deleted} prior July tasks for ${project.name}`);
      }
    }

    const existing = DRY_RUN && REPLACE
      ? []
      : await prisma.task.findMany({
          where: { projectId: project.id, workCycleId: cycle.id },
          select: { title: true },
        });
    const existingTitles = new Set(existing.map((t) => t.title));

    const groups = new Map();
    for (const t of tasks) {
      const key = t.milestone || '(Unspecified)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    let mainCreated = 0;
    let subCreated = 0;
    let stepCreated = 0;
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
        for (const task of groupTasks) {
          stepCreated += Array.isArray(task.steps) ? task.steps.filter(Boolean).length : 0;
        }
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
        const subTask = await prisma.task.create({
          data: {
            projectId: project.id,
            parentTaskId: mainTask.id,
            title: task.title,
            taskType: task.taskType,
            priority: task.priority || 'MEDIUM',
            status: 'TO_DO',
            milestone: task.milestone || null,
            description: buildDescription(task),
            clientVisible: true,
            createdById,
            workCycleId: cycle.id,
            wpAccessPresetId: resolvePresetId(task.taskType),
            assignees: { connect: [{ id: defaultAssignee.id }] },
          },
        });
        subCreated++;

        const steps = Array.isArray(task.steps) ? task.steps : [];
        for (const stepText of steps) {
          const trimmed = String(stepText || '').trim();
          if (!trimmed) continue;
          await prisma.task.create({
            data: {
              projectId: project.id,
              parentTaskId: subTask.id,
              title: trimmed,
              taskType: task.taskType,
              priority: 'MEDIUM',
              status: 'TO_DO',
              milestone: task.milestone || null,
              clientVisible: true,
              createdById,
              workCycleId: cycle.id,
              wpAccessPresetId: resolvePresetId(task.taskType),
              assignees: { connect: [{ id: defaultAssignee.id }] },
            },
          });
          stepCreated++;
        }
      }
    }

    summary.push({
      project: project.name,
      template: templateLabel,
      mains: mainCreated,
      subs: subCreated,
      steps: stepCreated,
      skipped,
    });
    console.log(
      `  ✓ ${project.name.padEnd(36)} [${templateLabel}] — ${mainCreated} mains, ${subCreated} subs, ${stepCreated} steps${
        skipped ? `, ${skipped} skipped` : ''
      }`,
    );
  }

  console.log('');
  console.log('═══════════════════════ SEED SUMMARY ═══════════════════════');
  let totalMains = 0;
  let totalSubs = 0;
  let totalSteps = 0;
  for (const s of summary) {
    totalMains += s.mains;
    totalSubs += s.subs;
    totalSteps += s.steps;
    console.log(
      `  ${s.project.padEnd(36)} [${s.template}]  mains=${s.mains}  subs=${s.subs}  steps=${s.steps}  skipped=${s.skipped}`,
    );
  }
  console.log('─'.repeat(60));
  console.log(`  Projects touched:     ${summary.length}`);
  console.log(`  Main tasks created:   ${totalMains}`);
  console.log(`  Sub tasks created:    ${totalSubs}`);
  console.log(`  Step tasks created:   ${totalSteps}`);
  console.log(`  Total tasks created:  ${totalMains + totalSubs + totalSteps}`);
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
