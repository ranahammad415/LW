/**
 * Diagnostic script to check notification setup.
 * Run on production: node prisma/diagnose-notifications.cjs
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('\n=== NOTIFICATION DIAGNOSTIC ===\n');

  // 1. Check pipeline notification templates
  console.log('1. Pipeline notification templates:');
  const pipelineSlugs = [
    'content_submitted_for_review',
    'content_pm_approved',
    'content_pm_changes_requested',
    'content_client_approved',
    'content_client_changes_requested',
    'content_ready_for_client_review',
    'content_published',
  ];
  for (const slug of pipelineSlugs) {
    const t = await prisma.notificationTemplate.findUnique({ where: { slug } });
    if (!t) {
      console.log(`   ❌ MISSING: ${slug}`);
    } else {
      console.log(`   ${t.isActive ? '✅' : '⚠️ INACTIVE'} ${slug} | emailOwner=${t.emailAgencyOwner} emailPm=${t.emailPm} emailClient=${t.emailClientManager}`);
    }
  }

  // 2. Check OWNER users
  console.log('\n2. Active OWNER users:');
  const owners = await prisma.user.findMany({
    where: { role: 'OWNER', isActive: true },
    select: { id: true, email: true, name: true },
  });
  if (owners.length === 0) {
    console.log('   ❌ NO active owners found!');
  } else {
    owners.forEach(o => console.log(`   ✅ ${o.name} (${o.email}) id=${o.id}`));
  }

  // 3. Check projects with wpApiKey
  console.log('\n3. Projects with WP API key:');
  const projects = await prisma.project.findMany({
    where: { wpApiKey: { not: null } },
    select: { id: true, name: true, wpApiKey: true, leadPmId: true, clientId: true },
  });
  if (projects.length === 0) {
    console.log('   ❌ No projects with wpApiKey!');
  } else {
    for (const p of projects) {
      console.log(`   📁 ${p.name} | leadPm=${p.leadPmId || 'NONE'} | client=${p.clientId || 'NONE'}`);
    }
  }

  // 4. Check recent WpContentReview entries
  console.log('\n4. Recent WpContentReview entries (last 5):');
  const reviews = await prisma.wpContentReview.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, postTitle: true, status: true, lastEventType: true, projectId: true, createdAt: true },
  });
  if (reviews.length === 0) {
    console.log('   ❌ No content reviews found!');
  } else {
    reviews.forEach(r => console.log(`   📄 "${r.postTitle}" status=${r.status} event=${r.lastEventType} project=${r.projectId}`));
  }

  // 5. Check recent NotificationLog entries
  console.log('\n5. Recent NotificationLog entries (last 5):');
  const logs = await prisma.notificationLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, templateSlug: true, channel: true, emailSentAt: true, emailError: true, createdAt: true },
  });
  if (logs.length === 0) {
    console.log('   ❌ No notification logs found!');
  } else {
    logs.forEach(l => console.log(`   📨 ${l.templateSlug} | channel=${l.channel} | emailSent=${!!l.emailSentAt} | error=${l.emailError || 'none'} | ${l.createdAt}`));
  }

  // 6. Try calling notify directly (dry run check)
  console.log('\n6. Testing notify() prerequisites for content_submitted_for_review:');
  const template = await prisma.notificationTemplate.findUnique({ where: { slug: 'content_submitted_for_review' } });
  if (!template) {
    console.log('   ❌ Template does NOT exist — seed-notifications.js did NOT run successfully!');
  } else if (!template.isActive) {
    console.log('   ⚠️  Template exists but isActive=false');
  } else {
    console.log('   ✅ Template exists and is active');
    console.log(`   Subject: "${template.subject}"`);
    console.log(`   emailAgencyOwner=${template.emailAgencyOwner} emailPm=${template.emailPm}`);
  }

  console.log('\n=== DONE ===\n');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
