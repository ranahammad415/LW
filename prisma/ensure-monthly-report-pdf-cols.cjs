/**
 * Ensure monthlyreport PDF storage columns exist (safe to re-run).
 * Usage: node prisma/ensure-monthly-report-pdf-cols.cjs
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ALTERS = [
  'ALTER TABLE `monthlyreport` ADD COLUMN `pdfStoredPath` VARCHAR(500) NULL',
  'ALTER TABLE `monthlyreport` ADD COLUMN `pdfFileName` VARCHAR(255) NULL',
  'ALTER TABLE `monthlyreport` ADD COLUMN `pdfFileSize` INT NULL',
  'ALTER TABLE `monthlyreport` ADD COLUMN `pdfGeneratedAt` DATETIME(3) NULL',
];

async function main() {
  for (const sql of ALTERS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log('OK:', sql);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/Duplicate column|already exists/i.test(msg)) {
        console.log('SKIP (exists):', sql);
      } else {
        console.error('FAIL:', sql, msg);
        throw err;
      }
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
