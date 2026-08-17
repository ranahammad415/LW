-- Open Knowledge Format (OKF) v2 — client business-knowledge modality.
-- Adds the asset index, per-write revision history, project strategy history,
-- and the business intake tracking columns on clientaccount.

SET @db := DATABASE();

-- ── clientaccount intake columns (idempotent; may exist from a prior db push) ──

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'intakeStatus'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `intakeStatus` VARCHAR(50) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'intakeData'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `intakeData` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'clientaccount' AND COLUMN_NAME = 'intakeCompletedAt'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `clientaccount` ADD COLUMN `intakeCompletedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── OKF tables ──

CREATE TABLE IF NOT EXISTS `okfassetindex` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `folder` VARCHAR(255) NOT NULL,
  `relPath` VARCHAR(500) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `type` VARCHAR(100) NOT NULL,
  `sizeBytes` INT NOT NULL,
  `lastModified` DATETIME(3) NOT NULL,
  `indexedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `okfassetindex_clientId_idx` (`clientId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `okfversion` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NOT NULL,
  `folder` VARCHAR(255) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `relPath` VARCHAR(500) NOT NULL,
  `versionNumber` INT NOT NULL DEFAULT 1,
  `contentHash` VARCHAR(64) NOT NULL,
  `metadata` JSON NULL,
  `body` LONGTEXT NOT NULL,
  `authorId` VARCHAR(255) NULL,
  `agentName` VARCHAR(255) NULL,
  `changeSummary` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `okfversion_clientId_relPath_idx` (`clientId`, `relPath`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `strategyversion` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(255) NOT NULL,
  `versionNumber` INT NOT NULL DEFAULT 1,
  `content` LONGTEXT NOT NULL,
  `authorId` VARCHAR(255) NOT NULL,
  `changeSummary` VARCHAR(500) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `strategyversion_projectId_idx` (`projectId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Expose the Business Knowledge page through the modality system ──

INSERT INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'knowledgeEngine', 'CLIENT', 1, NOW(3), NOW(3)),
  (UUID(), 'knowledgeEngine', 'PM', 1, NOW(3), NOW(3)),
  (UUID(), 'knowledgeEngine', 'OWNER', 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `enabled` = 1, `updatedAt` = NOW(3);
