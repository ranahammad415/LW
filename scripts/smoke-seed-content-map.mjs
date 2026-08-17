/**
 * Seeds a throwaway database with an owner, a PM, a client, a project, and a
 * small WordPress page inventory so the content-map smoke suite has something
 * realistic to sync against. Safe to re-run: every write is an upsert.
 *
 * Never point DATABASE_URL at a real environment when running this.
 */
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PASSWORD = 'password123';

async function upsertUser(email, role, name) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return prisma.user.upsert({
    where: { email },
    update: { role, name, isActive: true, passwordHash },
    create: { email, role, name, passwordHash, isActive: true },
  });
}

/** Minimal WP-ish markup so enrichPage has headings, links and words to parse. */
function body({ heading, paragraphs, links = [] }) {
  const linkHtml = links
    .map((href) => `<p>See <a href="${href}">this page</a> for details.</p>`)
    .join('\n');
  const filler = Array.from(
    { length: paragraphs },
    (_, i) =>
      `<p>Paragraph ${i + 1}. ${'Local plumbing service coverage details and pricing information for homeowners. '.repeat(6)}</p>`
  ).join('\n');
  return `<h1>${heading}</h1>\n<h2>What we do</h2>\n${filler}\n<h3>Why choose us</h3>\n${linkHtml}\n<img src="https://smoke.localwaves.test/img.jpg" alt="x" />`;
}

async function main() {
  const owner = await upsertUser('smoke-owner@localwaves.test', 'OWNER', 'Smoke Owner');
  const pm = await upsertUser('smoke-pm@localwaves.test', 'PM', 'Smoke PM');
  const clientUser = await upsertUser('smoke-client@localwaves.test', 'CLIENT', 'Smoke Client');

  let account = await prisma.clientAccount.findFirst({
    where: { agencyName: 'Smoke Test Agency' },
  });
  if (!account) {
    account = await prisma.clientAccount.create({
      data: {
        agencyName: 'Smoke Test Agency',
        websiteUrl: 'https://smoke.localwaves.test',
        leadPmId: pm.id,
        isActive: true,
      },
    });
  }

  await prisma.clientUser.upsert({
    where: { clientId_userId: { clientId: account.id, userId: clientUser.id } },
    update: {},
    create: {
      clientId: account.id,
      userId: clientUser.id,
      role: 'MANAGER',
      isPrimaryContact: true,
      addedById: owner.id,
    },
  });

  let project = await prisma.project.findFirst({
    where: { clientId: account.id, name: 'Smoke SEO Project' },
  });
  if (!project) {
    project = await prisma.project.create({
      data: {
        clientId: account.id,
        name: 'Smoke SEO Project',
        projectType: 'SEO_CAMPAIGN',
        status: 'ACTIVE',
        leadPmId: pm.id,
        wpUrl: 'https://smoke.localwaves.test',
        wpApiKey: 'smoke-key',
      },
    });
  }

  const now = new Date();
  await prisma.workCycle.upsert({
    where: { month_year: { month: now.getMonth() + 1, year: now.getFullYear() } },
    update: {},
    create: {
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      status: 'OPEN',
      openedById: owner.id,
    },
  });

  const base = 'https://smoke.localwaves.test';
  const pages = [
    {
      wpPostId: 1,
      title: 'Smoke Plumbing Co',
      slug: 'home',
      url: `${base}/`,
      postType: 'page',
      status: 'publish',
      content: body({
        heading: 'Smoke Plumbing Co',
        paragraphs: 4,
        links: [`${base}/services/`, `${base}/services/drain-cleaning/`, `${base}/contact/`],
      }),
    },
    {
      wpPostId: 2,
      title: 'Our Services',
      slug: 'services',
      url: `${base}/services/`,
      postType: 'page',
      status: 'publish',
      content: body({
        heading: 'Our Services',
        paragraphs: 3,
        links: [`${base}/services/drain-cleaning/`, `${base}/services/water-heaters/`],
      }),
    },
    {
      wpPostId: 3,
      title: 'Drain Cleaning',
      slug: 'drain-cleaning',
      url: `${base}/services/drain-cleaning/`,
      postType: 'page',
      status: 'publish',
      content: body({ heading: 'Drain Cleaning', paragraphs: 5, links: [`${base}/contact/`] }),
      seoTitle: 'Drain Cleaning Services | Smoke Plumbing Co',
      seoDescription:
        'Fast, affordable drain cleaning from licensed local plumbers. Same-day appointments available across the metro area, backed by a workmanship guarantee.',
    },
    {
      wpPostId: 4,
      title: 'Water Heater Repair',
      slug: 'water-heaters',
      url: `${base}/services/water-heaters/`,
      postType: 'page',
      status: 'publish',
      // Deliberately thin + no SEO meta so the health panel has something to flag.
      content: '<h1>Water Heater Repair</h1><p>We repair water heaters.</p>',
    },
    {
      wpPostId: 5,
      title: 'Contact Us',
      slug: 'contact',
      url: `${base}/contact/`,
      postType: 'page',
      status: 'publish',
      content: body({ heading: 'Contact Us', paragraphs: 2 }),
    },
    {
      wpPostId: 6,
      title: 'How To Unclog A Kitchen Sink',
      slug: 'how-to-unclog-a-kitchen-sink',
      url: `${base}/blog/how-to-unclog-a-kitchen-sink/`,
      postType: 'post',
      status: 'publish',
      // No inbound links anywhere -> should surface as an orphan.
      content: body({ heading: 'How To Unclog A Kitchen Sink', paragraphs: 6 }),
    },
    {
      wpPostId: 7,
      title: 'Winter Pipe Maintenance Checklist',
      slug: 'winter-pipe-maintenance-checklist',
      url: `${base}/blog/winter-pipe-maintenance-checklist/`,
      postType: 'post',
      status: 'draft',
      content: body({ heading: 'Winter Pipe Maintenance Checklist', paragraphs: 3 }),
    },
  ];

  for (const page of pages) {
    const data = {
      projectId: project.id,
      wpPostId: page.wpPostId,
      title: page.title,
      slug: page.slug,
      status: page.status,
      postType: page.postType,
      url: page.url,
      content: page.content,
      excerpt: null,
      seoTitle: page.seoTitle ?? null,
      seoDescription: page.seoDescription ?? null,
      contentHash: `smoke-${page.wpPostId}`,
      modifiedAt: new Date(Date.now() - page.wpPostId * 24 * 60 * 60 * 1000),
    };
    await prisma.wpPage.upsert({
      where: { projectId_wpPostId: { projectId: project.id, wpPostId: page.wpPostId } },
      update: data,
      create: data,
    });
  }

  console.log(
    JSON.stringify(
      {
        ownerId: owner.id,
        pmId: pm.id,
        clientUserId: clientUser.id,
        clientAccountId: account.id,
        projectId: project.id,
        wpPages: pages.length,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
