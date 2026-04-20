/**
 * Data Migration Script - Export from PostgreSQL
 * 
 * This script exports all data from the PostgreSQL database to JSON files.
 * Run this BEFORE switching to MySQL.
 * 
 * Usage: node prisma/migrate-export.js
 */

import { PrismaClient } from '@prisma/client';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create export directory
const exportDir = join(__dirname, 'migration-data');
try {
  mkdirSync(exportDir, { recursive: true });
} catch (e) {
  // Directory may already exist
}

// Use PostgreSQL connection - update this with your actual PostgreSQL credentials
const pgDatabaseUrl = process.env.PG_DATABASE_URL || 'postgresql://postgres:Rana@@9988@localhost:5432/agency_portal?schema=public';

// Create Prisma client with PostgreSQL connection
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: pgDatabaseUrl,
    },
  },
});

const models = [
  'User',
  'SystemAlert',
  'DailyStandup',
  'Package',
  'ClientAccount',
  'IntakeSubmission',
  'ContractRecord',
  'OnboardingChecklist',
  'ClientUser',
  'Project',
  'SitemapNode',
  'KeywordTrack',
  'PromptLog',
  'WpAccessPreset',
  'Task',
  'DeliverableVersion',
  'TaskComment',
  'LookerEmbed',
  'MonthlyReport',
  'ClientAsset',
  'KeywordSuggestion',
  'BusinessUpdate',
  'ClientIssue',
  'IssueComment',
  'MeetingRecord',
  'WpPage',
  'WpPageSnapshot',
];

async function exportData() {
  console.log('Starting data export from PostgreSQL...\n');
  
  const exportData = {};
  
  for (const modelName of models) {
    try {
      console.log(`Exporting ${modelName}...`);
      const data = await prisma[modelName.charAt(0).toLowerCase() + modelName.slice(1)].findMany();
      exportData[modelName] = data;
      console.log(`  ✓ Exported ${data.length} records`);
    } catch (error) {
      console.error(`  ✗ Error exporting ${modelName}:`, error.message);
      exportData[modelName] = [];
    }
  }
  
  // Save to file
  const exportFile = join(exportDir, 'export-data.json');
  writeFileSync(exportFile, JSON.stringify(exportData, null, 2));
  
  console.log(`\n✓ Export complete! Data saved to: ${exportFile}`);
  console.log(`\nSummary:`);
  for (const [model, data] of Object.entries(exportData)) {
    console.log(`  ${model}: ${data.length} records`);
  }
}

exportData()
  .catch((error) => {
    console.error('Export failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
