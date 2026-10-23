-- EmDash contract 1.9.1 (§41): restores made in the site admin (docs/ledger/emdash-bridge.md §v1.9.1,
-- features/security-platform.md §Restores). The OS never starts a restore; it stores the backup.restore_* events and
-- backup-status `backups.restore`, marks the data gap and the site entities that disappeared with a database restore.
-- Additive and idempotent: information_schema check + PREPARE per column / index, CREATE TABLE IF NOT EXISTS with an
-- inline FK. Nothing dropped, renamed or retyped. Existing rows get NULL markers.
-- The DDL matches `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <branch schema>`.

SET @db := DATABASE();

-- ── wppage: EmDash entry missing after a database restore (marked instead of status `deleted`) ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'orphanedByRestoreId');
SET @sql := IF(@col = 0, 'ALTER TABLE `wppage` ADD COLUMN `orphanedByRestoreId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'orphanedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `wppage` ADD COLUMN `orphanedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── cmslead: site lead created after the restore's point in time (our copy kept, never deleted) ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'orphanedByRestoreId');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `orphanedByRestoreId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'orphanedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `orphanedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND INDEX_NAME = 'cmslead_projectId_orphanedByRestoreId_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `cmslead_projectId_orphanedByRestoreId_idx` ON `cmslead`(`projectId`, `orphanedByRestoreId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── siterestore (one row per site restore, keyed on the site's restoreId; kept indefinitely) ──
CREATE TABLE IF NOT EXISTS `siterestore` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `restoreId` VARCHAR(64) NOT NULL,
  `scope` VARCHAR(16) NULL,
  `pointInTime` DATETIME(3) NULL,
  `sourceOwner` VARCHAR(8) NULL,
  `sourceDestinationId` VARCHAR(64) NULL,
  `sourceType` VARCHAR(32) NULL,
  `byRole` VARCHAR(8) NULL,
  `rollbackPoint` BOOLEAN NULL,
  `preExport` BOOLEAN NULL,
  `result` VARCHAR(16) NOT NULL,
  `phase` VARCHAR(16) NULL,
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `failedAt` DATETIME(3) NULL,
  `durationMs` INTEGER NULL,
  `counts` JSON NULL,
  `schemaFrom` VARCHAR(128) NULL,
  `schemaTo` VARCHAR(128) NULL,
  `countersRaised` BOOLEAN NULL,
  `eventsLostAfter` DATETIME(3) NULL,
  `errorCode` VARCHAR(16) NULL,
  `retryable` BOOLEAN NULL,
  `rollbackId` VARCHAR(64) NULL,
  `rolledBackAt` DATETIME(3) NULL,
  `rolledBackByRole` VARCHAR(8) NULL,
  `rollbackAvailableUntil` DATETIME(3) NULL,
  `dataGapFrom` DATETIME(3) NULL,
  `dataGapTo` DATETIME(3) NULL,
  `orphanedLeads` INTEGER NOT NULL DEFAULT 0,
  `origin` VARCHAR(8) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `siterestore_projectId_startedAt_idx`(`projectId`, `startedAt`),
  UNIQUE INDEX `siterestore_projectId_restoreId_key`(`projectId`, `restoreId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `siterestore_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
