/**
 * seed-may-2026-tasks.cjs
 *
 * Seeds the May 2026 task plan for 7 SEO campaign projects.
 *
 * Templates (in ./tasks-may-2026/):
 *   - Q2_TASKS         → Roman Electric, Milwaukee Signs, P2EzPay
 *   - Q1_TASKS         → Keyway Broaching (aka Broaching Technologies), Great Lakes Power Vac
 *   - WILHELMINA_TASKS → Wilhelmina Balloon (Q1 Ongoing SEO + Foundation Setup)
 *   - SOUTHGATE_TASKS  → SouthGate Lease (Local SEO only)
 *
 * Each template task carries { title, taskType, priority, milestone,
 * assigneeKey, goal, description, steps[] }. The seeder writes a Markdown
 * description into the parent Task row and creates one child Task per step
 * via parentTaskId (shown as "Subtasks" in the UI).
 *
 * Usage:
 *   node prisma/seed-may-2026-tasks.cjs
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ─── Assignee keys ────────────────────────────────────────────────────────────
// Keys must match case-insensitive substrings of User.name in DB.
// REQUIRED: used by Q1/Q2 templates; missing ones abort the run.
const REQUIRED_TEAM_KEYS = {
  mudassar: 'mudassar',
  hamza: 'hamza',
  bisma: 'bisma',
  sami: 'sami', // matches "M Sami", "Muhammad Sami", etc.
  awais: 'awais',
};
// OPTIONAL: only used by Wilhelmina foundation-setup tasks. If missing in DB,
// the seeder warns and falls back to the project leadPm / fallback PM.
const OPTIONAL_TEAM_KEYS = {
  hammad: 'hammad',
  uzma: 'uzma',
  developer: 'developer',
};

// ─── Task templates ──────────────────────────────────────────────────────────
// Templates live in ./tasks-may-2026/ to keep this file readable. Each item
// shape: { title, taskType, priority, milestone, assigneeKey, goal, description, steps[] }
const Q2_TASKS         = require('./tasks-may-2026/q2-tasks.cjs');
const Q1_TASKS         = require('./tasks-may-2026/q1-tasks.cjs');
const WILHELMINA_TASKS = require('./tasks-may-2026/wilhelmina-tasks.cjs');
const SOUTHGATE_TASKS  = require('./tasks-may-2026/southgate-tasks.cjs');

// ─── taskType → WP Access Preset mapping ─────────────────────────────────────
// Deterministic mapping used at seed time so every task row gets a sensible,
// least-privilege preset. Values on the right MUST match WpAccessPreset.name
// rows seeded in prisma/seed.cjs.
const TASKTYPE_TO_PRESET = {
  // Content
  'content-writing':  'Content Writing',
  'content-audit':    'Monthly Report (Read-Only)', // read-heavy audit
  // SEO — on/off/technical
  'on-page-seo':      'Meta Optimisation',
  'technical-seo':    'Technical SEO',
  'local-seo':        'Technical SEO',
  'keyword-research': 'Monthly Report (Read-Only)', // research/analysis
  'link-building':    'Technical SEO',
  'aeo-geo':          'Technical SEO',
  // UX / CRO
  'ux-audit':         'Monthly Report (Read-Only)', // read-heavy audit
  'cro':              'Meta Optimisation',
  // Reporting / ops
  'reporting':        'Monthly Report (Read-Only)',
  'crawl-fix':        'Crawl Fix',
  // Schema — accept both slugs
  'schema':              'Schema Deployment',
  'schema-deployment':   'Schema Deployment',
  // Other dropdown types (for future parity)
  'meta-optimisation':   'Meta Optimisation',
  'monthly-report':      'Monthly Report (Read-Only)',
  'strategy-call':       'Strategy Call (Read-Only)',
  'onboarding-task':     'Onboarding / Full Setup',
};


const PROJECT_TEMPLATE_MAP = [
  { nameMatch: 'Roman Electric',          template: 'Q2' },
  { nameMatch: 'Milwaukee Signs',         template: 'Q2' },
  { nameMatch: 'P2EzPay',                 template: 'Q2' },
  { nameMatch: 'Broaching',               template: 'Q1' }, // Keyway Broaching / Broaching Technologies
  { nameMatch: 'Great Lakes Power Vac',   template: 'Q1' },
  { nameMatch: 'Wilhelmina Balloon',      template: 'WILHELMINA' },
  { nameMatch: 'SouthGate Lease',         template: 'SOUTHGATE' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function findUserByNameKey(key) {
  return prisma.user.findFirst({
    where: {
      name: { contains: key },
      isActive: true,
    },
  });
}

async function findProjectByName(nameMatch) {
  // Try project name first, then the parent client's agencyName.
  const byProject = await prisma.project.findFirst({
    where: {
      projectType: 'SEO_CAMPAIGN',
      name: { contains: nameMatch },
    },
    include: { client: true, leadPm: true },
  });
  if (byProject) return byProject;

  return prisma.project.findFirst({
    where: {
      projectType: 'SEO_CAMPAIGN',
      client: { agencyName: { contains: nameMatch } },
    },
    include: { client: true, leadPm: true },
  });
}

// Build a Markdown description from the XLSX "Main Goal" and "Task Description"
// columns. Returns null when both are absent so the DB field stays NULL.
function buildDescription(task) {
  const goal = (task.goal || '').trim();
  const desc = (task.description || '').trim();
  if (goal && desc) return `**Goal:** ${goal}\n\n${desc}`;
  if (goal)         return `**Goal:** ${goal}`;
  if (desc)         return desc;
  return null;
}

// Build a Markdown description for the Main Task that aggregates every Sub Task's
// Goal, Task Description, and Steps. Gives the reader a one-shot overview of the
// entire group on the Main Task detail panel.
function buildMainDescription(groupTasks) {
  const blocks = [];
  for (const t of groupTasks) {
    const parts = [];
    parts.push(`### ${t.title}`);

    const goal = (t.goal || '').trim();
    const desc = (t.description || '').trim();
    if (goal) parts.push(`**Goal:** ${goal}`);
    if (desc) parts.push(desc);

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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              May 2026 Task Plan Seeder                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // ─── Resolve WP Access Presets (for per-task assignment) ──────────────────
  const presets = await prisma.wpAccessPreset.findMany({ select: { id: true, name: true } });
  const presetIdByName = Object.fromEntries(presets.map((p) => [p.name, p.id]));
  const resolvePresetId = (taskType) => {
    const name = TASKTYPE_TO_PRESET[taskType];
    return name ? (presetIdByName[name] || null) : null;
  };
  // Audit: warn about any template taskType that has no preset mapping.
  const referencedTypes = new Set();
  for (const list of [Q1_TASKS, Q2_TASKS, WILHELMINA_TASKS, SOUTHGATE_TASKS]) {
    for (const t of list) referencedTypes.add(t.taskType);
  }
  const missingMapping = [...referencedTypes].filter((tt) => !TASKTYPE_TO_PRESET[tt]);
  const missingPreset  = [...referencedTypes]
    .filter((tt) => TASKTYPE_TO_PRESET[tt])
    .filter((tt) => !presetIdByName[TASKTYPE_TO_PRESET[tt]]);
  if (missingMapping.length) {
    console.warn('  ⚠ taskTypes with NO preset mapping (will be stored without a preset):');
    missingMapping.forEach((tt) => console.warn(`     - ${tt}`));
  }
  if (missingPreset.length) {
    console.warn('  ⚠ preset names referenced but not found in DB (run seed.cjs first):');
    missingPreset.forEach((tt) => console.warn(`     - ${tt} → ${TASKTYPE_TO_PRESET[tt]}`));
  }
  console.log(`  ✓ WP presets loaded: ${presets.length}`);
  console.log('');

  // ─── Resolve team members ───────────────────────────────────────────────────
  console.log('→ Resolving team members (required)...');
  const team = {};
  const missingUsers = [];
  for (const [key, nameKey] of Object.entries(REQUIRED_TEAM_KEYS)) {
    const user = await findUserByNameKey(nameKey);
    if (!user) {
      missingUsers.push(`${key} (search: "${nameKey}")`);
    } else {
      team[key] = user;
      console.log(`  ✓ ${key.padEnd(10)} → ${user.name} <${user.email}>`);
    }
  }
  if (missingUsers.length) {
    console.error('');
    console.error('✗ Cannot locate these required users in DB:');
    missingUsers.forEach((u) => console.error(`    - ${u}`));
    console.error('Aborting. Make sure these teammates exist and are active.');
    process.exitCode = 1;
    return;
  }

  console.log('→ Resolving team members (optional — Wilhelmina foundation tasks)...');
  for (const [key, nameKey] of Object.entries(OPTIONAL_TEAM_KEYS)) {
    const user = await findUserByNameKey(nameKey);
    if (!user) {
      console.warn(`  ⚠ optional user not found: ${key} (search: "${nameKey}") — will fall back to PM.`);
    } else {
      team[key] = user;
      console.log(`  ✓ ${key.padEnd(10)} → ${user.name} <${user.email}>`);
    }
  }

  // Fallback PM for createdById when project.leadPmId is null
  const fallbackPm = await prisma.user.findFirst({
    where: { role: 'PM', isActive: true },
  });
  if (!fallbackPm) {
    console.error('✗ No active PM found for fallback createdById. Aborting.');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ fallbackPM  → ${fallbackPm.name} <${fallbackPm.email}>`);
  console.log('');

  // ─── Resolve projects ───────────────────────────────────────────────────────
  console.log('→ Resolving projects...');
  const projectsToSeed = [];
  for (const p of PROJECT_TEMPLATE_MAP) {
    const project = await findProjectByName(p.nameMatch);
    if (!project) {
      console.warn(`  ⚠ NOT FOUND: "${p.nameMatch}" — will skip.`);
      continue;
    }
    projectsToSeed.push({ ...p, project });
    console.log(
      `  ✓ ${project.name.padEnd(32)} [${p.template}]  client=${project.client.agencyName}  leadPm=${project.leadPm?.name ?? '—'}`,
    );
  }
  console.log('');

  if (projectsToSeed.length === 0) {
    console.error('✗ No target projects were found in DB. Aborting.');
    process.exitCode = 1;
    return;
  }

  // ─── Seed tasks ─────────────────────────────────────────────────────────────
  const summary = [];

  for (const entry of projectsToSeed) {
    const { project, template } = entry;
    const tasks =
      template === 'Q2'         ? Q2_TASKS :
      template === 'Q1'         ? Q1_TASKS :
      template === 'WILHELMINA' ? WILHELMINA_TASKS :
      template === 'SOUTHGATE'  ? SOUTHGATE_TASKS :
      [];

    const createdById = project.leadPmId || fallbackPm.id;
    const existing = await prisma.task.findMany({
      where: { projectId: project.id },
      select: { title: true },
    });
    const existingTitles = new Set(existing.map((t) => t.title));

    // ─── Group flat tasks by milestone to form Main Task → Sub Task levels.
    // XLSX hierarchy: Main Task (milestone) → Sub Task (task.title) → Steps.
    const groups = new Map(); // milestoneName -> [task, ...]
    for (const t of tasks) {
      const key = t.milestone || '(Unspecified)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    let mainCreated = 0;
    let subCreated  = 0;
    let stepCreated = 0;
    let skipped = 0;
    let missingAssignee = 0;

    for (const [mainTitle, groupTasks] of groups) {
      if (existingTitles.has(mainTitle)) {
        skipped++;
        continue;
      }

      // Main Task takes the first sub task's assignee/taskType as sensible defaults.
      const firstSub = groupTasks[0];
      const firstAssignee =
        team[firstSub.assigneeKey] ||
        (OPTIONAL_TEAM_KEYS[firstSub.assigneeKey] ? (project.leadPm || fallbackPm) : null);
      if (!firstAssignee) {
        missingAssignee++;
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
          wpAccessPresetId: resolvePresetId(firstSub.taskType),
          assignees: { connect: [{ id: firstAssignee.id }] },
        },
      });
      mainCreated++;

      // Sub Tasks carry the Goal + Description markdown.
      for (const task of groupTasks) {
        const assignee = team[task.assigneeKey];
        const resolvedAssignee =
          assignee ||
          (OPTIONAL_TEAM_KEYS[task.assigneeKey]
            ? (project.leadPm || fallbackPm)
            : null);
        if (!resolvedAssignee) {
          missingAssignee++;
          continue;
        }

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
            wpAccessPresetId: resolvePresetId(task.taskType),
            assignees: { connect: [{ id: resolvedAssignee.id }] },
          },
        });
        subCreated++;

        // Step grandchildren.
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
              wpAccessPresetId: resolvePresetId(task.taskType),
              assignees: { connect: [{ id: resolvedAssignee.id }] },
            },
          });
          stepCreated++;
        }
      }
    }

    summary.push({
      project: project.name,
      template,
      mains: mainCreated,
      subs: subCreated,
      steps: stepCreated,
      skipped,
      missingAssignee,
      total: tasks.length,
    });
    console.log(
      `  ✓ ${project.name.padEnd(32)} — ${mainCreated} mains, ${subCreated} subs, ${stepCreated} steps${
        skipped ? `, ${skipped} skipped` : ''
      }${missingAssignee ? `, ${missingAssignee} missing-assignee` : ''}`,
    );
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════ SEED SUMMARY ═══════════════════════');
  let totalMains = 0;
  let totalSubs  = 0;
  let totalSteps = 0;
  for (const s of summary) {
    totalMains += s.mains;
    totalSubs  += s.subs;
    totalSteps += s.steps;
    console.log(
      `  ${s.project.padEnd(32)} [${s.template}]  mains=${s.mains}  subs=${s.subs}  steps=${s.steps}  skipped=${s.skipped}`,
    );
  }
  console.log('─'.repeat(60));
  console.log(`  Main tasks created:   ${totalMains}`);
  console.log(`  Sub tasks created:    ${totalSubs}`);
  console.log(`  Step tasks created:   ${totalSteps}`);
  console.log(`  Total tasks created:  ${totalMains + totalSubs + totalSteps}`);
  console.log('');
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
