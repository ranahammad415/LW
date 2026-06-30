require('dotenv').config();

(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const sql = `
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
)`;
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log('projecthtmlreport table ready');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
