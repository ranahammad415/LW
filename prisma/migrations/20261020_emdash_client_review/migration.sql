-- EmDash bridge Phase 2 stage 1 (contract v1.1.0): client review from the OS.
-- Additive and idempotent: guarded ADD COLUMNs, CREATE TABLE IF NOT EXISTS. Nothing dropped, renamed or retyped.
-- WordPress rows are unaffected (all new columns are nullable).

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsRev');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsRev` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsClientDecisionSource');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsClientDecisionSource` VARCHAR(16) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsSuggestionCounts');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsSuggestionCounts` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsClientActor');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsClientActor` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `cmsreviewsuggestion` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `contentReviewId` VARCHAR(191) NOT NULL,
  `cmsSuggestionId` VARCHAR(64) NOT NULL,
  `cmsReviewId` VARCHAR(64) NOT NULL,
  `round` INTEGER NOT NULL,
  `targetField` VARCHAR(32) NOT NULL,
  `targetBlockKey` VARCHAR(64) NULL,
  `quote` TEXT NOT NULL,
  `proposedText` TEXT NOT NULL,
  `note` TEXT NULL,
  `state` VARCHAR(16) NOT NULL DEFAULT 'open',
  `source` VARCHAR(16) NOT NULL,
  `createdByName` VARCHAR(200) NULL,
  `createdByUserId` VARCHAR(64) NULL,
  `onBehalfOfClient` BOOLEAN NOT NULL DEFAULT false,
  `decidedByName` VARCHAR(200) NULL,
  `decidedAt` DATETIME(3) NULL,
  `decisionNote` TEXT NULL,
  `appliedRevisionId` VARCHAR(64) NULL,
  `cmsSeq` INTEGER NULL,
  `siteCreatedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmsreviewsuggestion_projectId_cmsSuggestionId_key`(`projectId`, `cmsSuggestionId`),
  INDEX `cmsreviewsuggestion_contentReviewId_round_idx`(`contentReviewId`, `round`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsreviewsuggestion_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `cmsreviewsuggestion_contentReviewId_fkey` FOREIGN KEY (`contentReviewId`) REFERENCES `wpcontentreview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
