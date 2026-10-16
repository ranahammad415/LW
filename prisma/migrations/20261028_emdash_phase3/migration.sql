-- EmDash bridge Phase 3 (contract v1.5.0): leads, site reports, WordPress → EmDash migration.
-- Additive and idempotent: guarded ADD COLUMNs and CREATE TABLE IF NOT EXISTS. Nothing dropped, renamed or retyped.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsMigration');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsMigration` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsLeadRetentionMonths');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsLeadRetentionMonths` INTEGER NOT NULL DEFAULT 24',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmspairingcode' AND COLUMN_NAME = 'mode');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmspairingcode` ADD COLUMN `mode` VARCHAR(16) NOT NULL DEFAULT ''pair''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsMigration');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsMigration` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `cmslead` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `leadId` VARCHAR(64) NOT NULL,
  `siteId` VARCHAR(64) NULL,
  `formId` VARCHAR(64) NULL,
  `formName` VARCHAR(200) NULL,
  `sourcePath` VARCHAR(500) NULL,
  `utm` JSON NULL,
  `fields` JSON NULL,
  `consentMarketing` BOOLEAN NOT NULL DEFAULT false,
  `consent` JSON NULL,
  `spamVerdict` VARCHAR(16) NULL,
  `spamScore` DOUBLE NULL,
  `siteCreatedAt` DATETIME(3) NULL,
  `siteRetentionDays` INTEGER NULL,
  `erasedAt` DATETIME(3) NULL,
  `erasedReason` VARCHAR(32) NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmslead_projectId_leadId_key`(`projectId`, `leadId`),
  INDEX `cmslead_projectId_receivedAt_idx`(`projectId`, `receivedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmslead_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmsleadphoto` (
  `id` VARCHAR(191) NOT NULL,
  `leadRowId` VARCHAR(191) NOT NULL,
  `mediaId` VARCHAR(64) NOT NULL,
  `sourceUrl` VARCHAR(2000) NULL,
  `sourceExpiresAt` DATETIME(3) NULL,
  `storageName` VARCHAR(100) NULL,
  `contentType` VARCHAR(64) NULL,
  `bytes` INTEGER NULL,
  `copiedAt` DATETIME(3) NULL,
  `error` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `cmsleadphoto_leadRowId_idx`(`leadRowId`),
  INDEX `cmsleadphoto_copiedAt_sourceExpiresAt_idx`(`copiedAt`, `sourceExpiresAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsleadphoto_leadRowId_fkey` FOREIGN KEY (`leadRowId`) REFERENCES `cmslead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmssitereport` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `data` JSON NOT NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmssitereport_projectId_kind_key`(`projectId`, `kind`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmssitereport_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
