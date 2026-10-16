-- EmDash bridge Phase 2 stage 2 (contract v1.2.0 + v1.2.1 errata): OS draft push + media import.
-- Additive and idempotent: a guarded ADD COLUMN and CREATE TABLE IF NOT EXISTS. Nothing dropped, renamed or retyped.
-- WordPress projects are unaffected.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsRev');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsRev` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `cmsdraft` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `contentMapNodeId` VARCHAR(191) NULL,
  `taskId` VARCHAR(191) NULL,
  `collection` VARCHAR(64) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `slug` VARCHAR(200) NULL,
  `parent` VARCHAR(100) NULL,
  `contentKind` VARCHAR(16) NOT NULL DEFAULT 'layout',
  `layout` JSON NULL,
  `markdown` LONGTEXT NULL,
  `excerpt` TEXT NULL,
  `seoTitle` VARCHAR(500) NULL,
  `seoDescription` VARCHAR(1000) NULL,
  `bylines` JSON NULL,
  `taxonomies` JSON NULL,
  `aiGenerated` BOOLEAN NOT NULL DEFAULT false,
  `cmsEntryId` VARCHAR(64) NULL,
  `cmsEntryNo` INTEGER NULL,
  `cmsRev` VARCHAR(64) NULL,
  `cmsEditUrl` VARCHAR(1000) NULL,
  `cmsPath` VARCHAR(500) NULL,
  `lastPushStatus` VARCHAR(16) NOT NULL DEFAULT 'never',
  `lastPushAt` DATETIME(3) NULL,
  `lastPushError` JSON NULL,
  `lastPushWarnings` JSON NULL,
  `lastSeoCheck` JSON NULL,
  `createdById` VARCHAR(191) NULL,
  `updatedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `cmsdraft_projectId_idx`(`projectId`),
  INDEX `cmsdraft_contentMapNodeId_idx`(`contentMapNodeId`),
  INDEX `cmsdraft_taskId_idx`(`taskId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsdraft_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `cmsdraft_contentMapNodeId_fkey` FOREIGN KEY (`contentMapNodeId`) REFERENCES `contentmapnode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `cmsdraft_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmsdraftpush` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `draftId` VARCHAR(191) NULL,
  `route` VARCHAR(32) NOT NULL,
  `idempotencyKey` VARCHAR(64) NOT NULL,
  `actorKind` VARCHAR(16) NOT NULL,
  `actorUserId` VARCHAR(191) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `errorCode` VARCHAR(64) NULL,
  `summary` JSON NULL,
  `confirmedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmsdraftpush_idempotencyKey_key`(`idempotencyKey`),
  INDEX `cmsdraftpush_projectId_createdAt_idx`(`projectId`, `createdAt`),
  INDEX `cmsdraftpush_draftId_idx`(`draftId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsdraftpush_draftId_fkey` FOREIGN KEY (`draftId`) REFERENCES `cmsdraft`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmsmediaref` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `siteId` VARCHAR(64) NOT NULL,
  `sha256` VARCHAR(64) NOT NULL,
  `mediaId` VARCHAR(64) NOT NULL,
  `ref` JSON NOT NULL,
  `contentType` VARCHAR(64) NULL,
  `bytes` INTEGER NULL,
  `width` INTEGER NULL,
  `height` INTEGER NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmsmediaref_projectId_siteId_sha256_key`(`projectId`, `siteId`, `sha256`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmsmediaref_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
