import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const prisma = new PrismaClient()

export async function connectTestDb() {
  await prisma.$connect()
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
