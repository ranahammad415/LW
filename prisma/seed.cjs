require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'password123';
const BCRYPT_ROUNDS = 10;

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);

  // Optional: clear existing data (reverse dependency order)
  await prisma.task.deleteMany();
  await prisma.wpAccessPreset.deleteMany();
  await prisma.monthlyReport.deleteMany();
  await prisma.lookerEmbed.deleteMany();
  await prisma.project.deleteMany();
  await prisma.clientUser.deleteMany();
  await prisma.clientAccount.deleteMany();
  await prisma.package.deleteMany();
  await prisma.user.deleteMany();

  // 1. Create 4 Base Packages
  const starter = await prisma.package.create({
    data: { name: 'STARTER' },
  });
  const growth = await prisma.package.create({
    data: { name: 'GROWTH' },
  });
  const pro = await prisma.package.create({
    data: { name: 'PRO' },
  });
  const enterprise = await prisma.package.create({
    data: { name: 'ENTERPRISE' },
  });
  console.log('Created packages:', starter.name, growth.name, pro.name, enterprise.name);

  // 2. Create 4 internal Users + 1 client user
  const owner = await prisma.user.create({
    data: {
      email: 'owner@agency.com',
      passwordHash,
      role: 'OWNER',
      name: 'Alex Owner',
      twoFaBackupCodes: [],
    },
  });
  const pm = await prisma.user.create({
    data: {
      email: 'pm@agency.com',
      passwordHash,
      role: 'PM',
      name: 'Sam Project Manager',
      twoFaBackupCodes: [],
    },
  });
  const teamMember = await prisma.user.create({
    data: {
      email: 'teammember@agency.com',
      passwordHash,
      role: 'TEAM_MEMBER',
      name: 'Jordan Team Member',
      twoFaBackupCodes: [],
    },
  });
  const contractor = await prisma.user.create({
    data: {
      email: 'contractor@agency.com',
      passwordHash,
      role: 'CONTRACTOR',
      name: 'Casey Contractor',
      twoFaBackupCodes: [],
    },
  });
  const clientUser = await prisma.user.create({
    data: {
      email: 'client@wayne.com',
      passwordHash,
      role: 'CLIENT',
      name: 'Bruce Wayne',
      twoFaBackupCodes: [],
    },
  });
  console.log('Created users: owner, pm, teammember, contractor, client');

  // 3. Create 1 Client Account: Wayne Enterprises
  const wayne = await prisma.clientAccount.create({
    data: {
      agencyName: 'Wayne Enterprises',
      packageId: growth.id,
      leadPmId: pm.id,
      healthScore: 72,
    },
  });
  console.log('Created client account: Wayne Enterprises');

  // 4. Link client user to Wayne Enterprises (ClientUser)
  await prisma.clientUser.create({
    data: {
      clientId: wayne.id,
      userId: clientUser.id,
      isPrimaryContact: true,
      canApproveDeliverables: true,
      addedById: owner.id,
    },
  });
  console.log('Created ClientUser link (client@wayne.com → Wayne Enterprises)');

  // 5. Create 1 Project: Wayne SEO Campaign
  const project = await prisma.project.create({
    data: {
      clientId: wayne.id,
      name: 'Wayne SEO Campaign',
      projectType: 'SEO_CAMPAIGN',
      status: 'ACTIVE',
      leadPmId: pm.id,
    },
  });
  console.log('Created project: Wayne SEO Campaign');

  // 6. Create 4 Tasks
  await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Technical SEO Audit',
      taskType: 'technical-seo',
      status: 'COMPLETED',
      assignees: { connect: [{ id: teamMember.id }] },
      createdById: pm.id,
    },
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Keyword Research',
      taskType: 'keyword-research',
      status: 'COMPLETED',
      assignees: { connect: [{ id: teamMember.id }] },
      createdById: pm.id,
    },
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Write Blog Post: SEO 2026',
      taskType: 'content-writing',
      status: 'IN_PROGRESS',
      assignees: { connect: [{ id: contractor.id }] },
      createdById: pm.id,
    },
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Fix 404 Errors',
      taskType: 'crawl-fix',
      status: 'TO_DO',
      assignees: { connect: [{ id: teamMember.id }] },
      createdById: pm.id,
    },
  });
  console.log('Created 4 tasks');

  // ─── WP Access Presets (least-privilege per task type) ─────────────────
  const presets = await Promise.all([
    prisma.wpAccessPreset.create({
      data: { name: 'Content Writing', capabilities: ['edit_posts', 'edit_published_posts', 'publish_posts', 'upload_files', 'delete_posts'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Meta Optimisation', capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Technical SEO', capabilities: ['edit_posts', 'edit_pages', 'edit_published_pages', 'manage_options', 'edit_theme_options'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Monthly Report (Read-Only)', capabilities: ['read'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Strategy Call (Read-Only)', capabilities: ['read'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Onboarding / Full Setup', capabilities: ['edit_posts', 'edit_pages', 'edit_published_posts', 'edit_published_pages', 'upload_files', 'manage_options', 'edit_theme_options', 'install_plugins', 'activate_plugins'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Crawl Fix', capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages', 'manage_options'] },
    }),
    prisma.wpAccessPreset.create({
      data: { name: 'Schema Deployment', capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages', 'edit_theme_options'] },
    }),
  ]);
  console.log(`Created ${presets.length} WP Access Presets`);

  // ─── Auto-assign WP presets to tasks based on title/taskType ──────────
  const presetByName = {};
  for (const p of presets) presetByName[p.name] = p.id;

  const presetRules = [
    { patterns: [/content/i, /blog/i, /article/i, /copywriting/i, /write/i], preset: 'Content Writing' },
    { patterns: [/meta\s*(optim|tag|title|desc)/i, /on.?page/i], preset: 'Meta Optimisation' },
    { patterns: [/technical.?seo/i, /seo\s*audit/i, /site\s*speed/i, /core\s*web/i, /robots/i, /sitemap/i, /canonical/i, /redirect/i], preset: 'Technical SEO' },
    { patterns: [/report/i, /analytics/i], preset: 'Monthly Report (Read-Only)' },
    { patterns: [/strategy/i, /kickoff/i, /consultation/i], preset: 'Strategy Call (Read-Only)' },
    { patterns: [/onboard/i, /setup/i, /plugin/i, /theme/i, /develop/i, /migration/i, /staging/i, /dns/i, /hosting/i, /ssl/i, /php/i, /css/i, /code/i], preset: 'Onboarding / Full Setup' },
    { patterns: [/crawl/i, /broken.?link/i, /404/i, /server.?error/i], preset: 'Crawl Fix' },
    { patterns: [/schema/i, /structured.?data/i, /rich.?snippet/i, /json.?ld/i, /markup/i], preset: 'Schema Deployment' },
    // Broad SEO catch-all
    { patterns: [/keyword/i, /backlink/i, /link.?build/i, /competitor/i, /serp/i, /rank/i, /seo/i], preset: 'Technical SEO' },
  ];

  const allTasks = await prisma.task.findMany({
    where: { wpAccessPresetId: null },
    select: { id: true, title: true, description: true, taskType: true },
  });

  let assigned = 0;
  for (const t of allTasks) {
    const text = `${t.title} ${t.taskType} ${t.description || ''}`;
    let matchedId = null;
    for (const rule of presetRules) {
      if (rule.patterns.some((rx) => rx.test(text))) {
        matchedId = presetByName[rule.preset] || null;
        break;
      }
    }
    if (matchedId) {
      await prisma.task.update({ where: { id: t.id }, data: { wpAccessPresetId: matchedId } });
      assigned++;
    }
  }
  console.log(`Auto-assigned WP presets to ${assigned} / ${allTasks.length} tasks`);

  console.log('\nSeed complete. All users have password:', DEFAULT_PASSWORD);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
