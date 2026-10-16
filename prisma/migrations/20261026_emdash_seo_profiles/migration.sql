-- EmDash bridge Phase 2 stage 4 (contract v1.4.0): SEO profile mirror, proposals, node page_id.
-- Additive and idempotent: a guarded ADD COLUMN and CREATE TABLE IF NOT EXISTS. Nothing dropped or retyped.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'cmsPageId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `cmsPageId` VARCHAR(32) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `cmsseoprofile` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `pageId` VARCHAR(32) NOT NULL,
  `entryId` VARCHAR(64) NULL,
  `target` VARCHAR(200) NULL,
  `path` VARCHAR(500) NULL,
  `status` VARCHAR(32) NULL,
  `primaryKeyword` VARCHAR(200) NULL,
  `contract` JSON NULL,
  `checks` JSON NULL,
  `facts` JSON NULL,
  `openProposals` INTEGER NOT NULL DEFAULT 0,
  `nextReviewOn` VARCHAR(10) NULL,
  `profileHash` VARCHAR(64) NULL,
  `siteUpdatedAt` DATETIME(3) NULL,
  `lastCheck` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmsseoprofile_projectId_pageId_key`(`projectId`, `pageId`),
  INDEX `cmsseoprofile_projectId_entryId_idx`(`projectId`, `entryId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsseoprofile_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmsseoproposal` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `proposalId` VARCHAR(64) NOT NULL,
  `pageId` VARCHAR(32) NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `patch` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `createdByName` VARCHAR(200) NULL,
  `createdByUserId` VARCHAR(64) NULL,
  `decidedByName` VARCHAR(200) NULL,
  `decidedAt` DATETIME(3) NULL,
  `decisionNote` TEXT NULL,
  `siteCreatedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmsseoproposal_projectId_proposalId_key`(`projectId`, `proposalId`),
  INDEX `cmsseoproposal_projectId_pageId_idx`(`projectId`, `pageId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsseoproposal_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
