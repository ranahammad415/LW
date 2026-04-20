/**
 * Data Migration Script - Import to MySQL
 * 
 * This script imports all data from JSON files to the MySQL database.
 * Run this AFTER creating the MySQL schema and switching DATABASE_URL to MySQL.
 * 
 * Prerequisites:
 * 1. MySQL database must be created
 * 2. Run `npx prisma db push` to create tables
 * 3. DATABASE_URL must point to MySQL
 * 
 * Usage: node prisma/migrate-import.js
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const exportFile = join(__dirname, 'migration-data', 'export-data.json');

if (!existsSync(exportFile)) {
  console.error(`Error: Export file not found at ${exportFile}`);
  console.error('Please run migrate-export.js first to export data from PostgreSQL.');
  process.exit(1);
}

// Load exported data
const exportData = JSON.parse(readFileSync(exportFile, 'utf-8'));

// Create Prisma client (uses DATABASE_URL from environment which should be MySQL)
const prisma = new PrismaClient();

// Define import order based on dependencies (parent tables first)
const importOrder = [
  'User',
  'Package',
  'WpAccessPreset',
  'ClientAccount',
  'SystemAlert',
  'DailyStandup',
  'IntakeSubmission',
  'ContractRecord',
  'OnboardingChecklist',
  'ClientUser',
  'Project',
  'SitemapNode',
  'KeywordTrack',
  'PromptLog',
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

// Fields that need transformation from PostgreSQL arrays to MySQL JSON
const arrayFields = {
  'User': ['twoFaBackupCodes'],
  'WpAccessPreset': ['capabilities'],
};

function transformRecord(modelName, record) {
  const transformed = { ...record };
  
  // Transform array fields to JSON for MySQL
  if (arrayFields[modelName]) {
    for (const field of arrayFields[modelName]) {
      if (transformed[field] !== undefined && transformed[field] !== null) {
        // PostgreSQL arrays come as actual arrays, store as JSON in MySQL
        if (Array.isArray(transformed[field])) {
          transformed[field] = transformed[field];
        }
      }
    }
  }
  
  // Remove any undefined values
  Object.keys(transformed).forEach(key => {
    if (transformed[key] === undefined) {
      delete transformed[key];
    }
  });
  
  return transformed;
}

async function importData() {
  console.log('Starting data import to MySQL...\n');
  
  const results = {};
  
  for (const modelName of importOrder) {
    const data = exportData[modelName] || [];
    
    if (data.length === 0) {
      console.log(`Skipping ${modelName}: No data to import`);
      results[modelName] = { imported: 0, errors: 0 };
      continue;
    }
    
    console.log(`Importing ${modelName} (${data.length} records)...`);
    
    let imported = 0;
    let errors = 0;
    
    for (const record of data) {
      try {
        const transformedRecord = transformRecord(modelName, record);
        
        await prisma[modelName.charAt(0).toLowerCase() + modelName.slice(1)].create({
          data: transformedRecord,
        });
        imported++;
      } catch (error) {
        console.error(`  ✗ Error importing ${modelName} record (id: ${record.id}):`, error.message);
        errors++;
      }
    }
    
    results[modelName] = { imported, errors };
    console.log(`  ✓ Imported ${imported} records${errors > 0 ? `, ${errors} errors` : ''}`);
  }
  
  console.log(`\n✓ Import complete!`);
  console.log(`\nSummary:`);
  for (const [model, result] of Object.entries(results)) {
    if (result.imported > 0 || result.errors > 0) {
      console.log(`  ${model}: ${result.imported} imported${result.errors > 0 ? `, ${result.errors} errors` : ''}`);
    }
  }
}

importData()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
