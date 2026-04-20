import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import csv from 'csv-parser';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'password123';
const BCRYPT_ROUNDS = 10;
const DEFAULT_TASK_TYPE = 'onboarding-task';

/** Get CSV column value from row; tries multiple possible header names (case/spacing). */
function getCol(row, ...keys) {
  const raw = keys.find((k) => row[k] !== undefined && row[k] !== null);
  return raw != null ? String(row[raw]).trim() : '';
}

/** Resolve path to CSV: backend folder first, then project root. */
function resolveCsvPath() {
  const inBackend = path.resolve(__dirname, '../googleSheetsProjectCsv.csv');
  const inRoot = path.resolve(__dirname, '../../googleSheetsProjectCsv.csv');
  if (fs.existsSync(inBackend)) return inBackend;
  if (fs.existsSync(inRoot)) return inRoot;
  return inBackend; // preferred location when you add the file
}

/** Read CSV file into array of row objects. */
function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }
    createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function todayDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);
  const now = new Date();

  // ─── STEP 1: Clear ALL existing data (reverse dependency order) ─────────
  await prisma.aeoAutomatedRun.deleteMany();
  await prisma.wpContentReviewEvent.deleteMany();
  await prisma.wpContentReview.deleteMany();
  await prisma.clientInputRequest.deleteMany();
  await prisma.taskCommentReaction.deleteMany();
  await prisma.taskComment.deleteMany();
  await prisma.taskAttachment.deleteMany();
  await prisma.taskActivityLog.deleteMany();
  await prisma.issueActivityLog.deleteMany();
  await prisma.issueComment.deleteMany();
  await prisma.clientIssue.deleteMany();
  await prisma.keywordComment.deleteMany();
  await prisma.systemAlert.deleteMany();
  await prisma.notificationLog.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.notificationTemplate.deleteMany();
  await prisma.dailyStandup.deleteMany();
  await prisma.deliverableVersion.deleteMany();
  await prisma.meetingRecord.deleteMany();
  await prisma.keywordTrack.deleteMany();
  await prisma.promptLog.deleteMany();
  await prisma.wpPageSnapshot.deleteMany();
  await prisma.wpPage.deleteMany();
  await prisma.sitemapNode.deleteMany();
  await prisma.clientPMUpdate.deleteMany();
  await prisma.clientROIConfig.deleteMany();
  await prisma.clientMetricSnapshot.deleteMany();
  await prisma.task.deleteMany();
  await prisma.wpAccessPreset.deleteMany();
  await prisma.monthlyReport.deleteMany();
  await prisma.lookerEmbed.deleteMany();
  await prisma.clientAsset.deleteMany();
  await prisma.keywordSuggestion.deleteMany();
  await prisma.businessUpdate.deleteMany();
  await prisma.onboardingChecklist.deleteMany();
  await prisma.intakeSubmission.deleteMany();
  await prisma.contractRecord.deleteMany();
  await prisma.project.deleteMany();
  await prisma.clientUser.deleteMany();
  await prisma.clientAccount.deleteMany();
  await prisma.package.deleteMany();
  await prisma.user.deleteMany();
  console.log('Cleared ALL existing data');

  // ─── STEP 1: Packages ──────────────────────────────────────────────────
  await prisma.package.createMany({
    data: [
      { name: 'STARTER', maxKeywords: 5, keywordsLimit: 50, projectsLimit: 2, teamMembersLimit: 2 },
      { name: 'GROWTH', maxKeywords: 20, keywordsLimit: 200, projectsLimit: 5, teamMembersLimit: 5 },
      { name: 'PRO', maxKeywords: 50, keywordsLimit: 500, projectsLimit: 15, teamMembersLimit: 10 },
      { name: 'ENTERPRISE', maxKeywords: 500, keywordsLimit: null, projectsLimit: null, teamMembersLimit: null },
    ],
  });
  const pkgStarter = await prisma.package.findFirst({ where: { name: 'STARTER' } });
  const pkgGrowth = await prisma.package.findFirst({ where: { name: 'GROWTH' } });
  const pkgPro = await prisma.package.findFirst({ where: { name: 'PRO' } });
  const pkgEnterprise = await prisma.package.findFirst({ where: { name: 'ENTERPRISE' } });
  console.log('Created packages: STARTER, GROWTH, PRO, ENTERPRISE');

  // ─── STEP 2: Owner users ──────────────────────────────────────────────
  const owner1 = await prisma.user.create({
    data: {
      email: 'bradsgardner@gmail.com',
      passwordHash,
      role: 'OWNER',
      name: 'Brad Gardner',
      timezone: 'America/New_York',
      twoFaBackupCodes: null,
    },
  });
  const owner2 = await prisma.user.create({
    data: {
      email: 'ranahammad415@gmail.com',
      passwordHash,
      role: 'OWNER',
      name: 'Hammad Ali',
      timezone: 'America/New_York',
      twoFaBackupCodes: null,
    },
  });
  console.log('Created 2 owners: Brad Gardner, Hammad Ali');

  // ─── STEP 3: WP Access Presets ─────────────────────────────────────────
  await prisma.wpAccessPreset.deleteMany();
  await prisma.wpAccessPreset.createMany({
    data: [
      {
        name: 'Content Writing',
        capabilities: ['edit_posts', 'edit_published_posts', 'publish_posts', 'upload_files', 'delete_posts'],
      },
      {
        name: 'Meta Optimisation',
        capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages'],
      },
      {
        name: 'Technical SEO',
        capabilities: ['edit_posts', 'edit_pages', 'edit_published_pages', 'manage_options', 'edit_theme_options'],
      },
      {
        name: 'Monthly Report (Read-Only)',
        capabilities: ['read'],
      },
      {
        name: 'Strategy Call (Read-Only)',
        capabilities: ['read'],
      },
      {
        name: 'Onboarding / Full Setup',
        capabilities: [
          'edit_posts', 'edit_pages', 'edit_published_posts', 'edit_published_pages',
          'upload_files', 'manage_options', 'edit_theme_options', 'install_plugins', 'activate_plugins',
        ],
      },
      {
        name: 'Crawl Fix',
        capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages', 'manage_options'],
      },
      {
        name: 'Schema Deployment',
        capabilities: ['edit_posts', 'edit_published_posts', 'edit_pages', 'edit_published_pages', 'edit_theme_options'],
      },
    ],
  });
  console.log('Created 8 WP Access Presets');

  console.log('\n========================================');
  console.log('SEED COMPLETE!');
  console.log('========================================');
  console.log('All users have password:', DEFAULT_PASSWORD);
  console.log('\n--- Owner Users ---');
  console.log('  bradsgardner@gmail.com   (Owner - Brad Gardner)');
  console.log('  ranahammad415@gmail.com  (Owner - Hammad Ali)');
  console.log('\n--- Data Summary ---');
  console.log('  4 Packages (STARTER, GROWTH, PRO, ENTERPRISE)');
  console.log('  8 WP Access Presets');
  console.log('  0 Clients (add later)');
  console.log('  0 Team Members (add later)');
  console.log('========================================');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
