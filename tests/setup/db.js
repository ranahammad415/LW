import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const prisma = new PrismaClient()

export async function connectTestDb() {
  await prisma.$connect()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS projecthtmlreport (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      projectId VARCHAR(191) NOT NULL,
      month VARCHAR(7) NOT NULL,
      title VARCHAR(255) NULL,
      fileName VARCHAR(255) NOT NULL,
      storedPath VARCHAR(500) NOT NULL,
      fileSize INT NULL,
      status ENUM('DRAFT','PM_REVIEW','DELIVERED') NOT NULL DEFAULT 'DELIVERED',
      uploadedById VARCHAR(191) NOT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY projecthtmlreport_projectId_month_key (projectId, month),
      KEY projecthtmlreport_month_idx (month)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function seedTestDb() {
  const sql = readFileSync(
    path.join(__dirname, '../seeds/seed.sql'),
    'utf-8'
  )
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt)
  }
}

export async function truncateAllTables() {
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  // Table names match Prisma model names (no @@map in schema)
  const tables = [
    'PasswordResetToken',
    'NotificationLog',
    'NotificationPreference',
    'NotificationTemplate',
    'SystemAlert',
    'TaskActivityLog',
    'TaskComment',
    'TaskCommentReaction',
    'TaskAttachment',
    'DeliverableVersion',
    'ClientInputRequest',
    '_TaskAssignees',
    '_TaskDependencies',
    'Task',
    'KeywordComment',
    'KeywordTrack',
    'KeywordSuggestion',
    'AeoAutomatedRun',
    'PromptLog',
    'WpPageSnapshot',
    'WpPage',
    'WpContentReviewEvent',
    'WpContentReview',
    'WpAccessPreset',
    'SitemapNode',
    'ClientIssue',
    'IssueComment',
    'IssueActivityLog',
    'ChatMessage',
    'ChannelMember',
    'ChatChannel',
    'MeetingRecord',
    'MonthlyReport',
    'projectactivityreport',
    'projecthtmlreport',
    'ClientAsset',
    'BusinessUpdate',
    'OnboardingChecklist',
    'IntakeSubmission',
    'ContractRecord',
    'DailyStandup',
    'LookerEmbed',
    'ClientUser',
    'Project',
    'ClientAccount',
    'Package',
    'User',
  ]
  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``)
    } catch (e) {
      // Table may not exist, skip
    }
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')
}

export async function disconnectTestDb() {
  await prisma.$disconnect()
}

export { prisma }
