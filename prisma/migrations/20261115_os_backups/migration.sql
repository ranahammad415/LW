-- OS Backups (docs/ledger/features/os-backups.md): the four PRESERVED tables of the backup / restore feature.
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, information_schema check + PREPARE for the columns / index added
-- after the first design, INSERT IGNORE for the singleton. Nothing dropped, renamed or retyped. NO foreign keys: a restore
-- drops and recreates every other table, and these rows (catalog, jobs, OTP challenges, lock) must survive it untouched.
-- After restoring an older backup, `prisma migrate deploy` re-runs this file, which is then a no-op.
-- The DDL matches `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <branch schema>`.

SET @db := DATABASE();

-- ── osbackup (catalog mirror of the manifests on disk) ──
CREATE TABLE IF NOT EXISTS `osbackup` (
  `id` VARCHAR(191) NOT NULL,
  `fileName` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `engine` VARCHAR(16) NOT NULL,
  `startedAt` DATETIME(3) NOT NULL,
  `finishedAt` DATETIME(3) NULL,
  `durationMs` INTEGER NULL,
  `sizeBytes` BIGINT NULL,
  `plainBytes` BIGINT NULL,
  `tableCount` INTEGER NULL,
  `totalRows` BIGINT NULL,
  `rowCounts` JSON NULL,
  `sha256File` CHAR(64) NULL,
  `latestMigration` VARCHAR(191) NULL,
  `migrationCount` INTEGER NULL,
  `appVersion` VARCHAR(64) NULL,
  `verifyStatus` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `verifiedAt` DATETIME(3) NULL,
  `verifyError` VARCHAR(500) NULL,
  `error` VARCHAR(500) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdByEmail` VARCHAR(191) NULL,
  `safetyForJobId` VARCHAR(191) NULL,
  `prunedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `osbackup_fileName_key`(`fileName`),
  INDEX `osbackup_status_startedAt_idx`(`status`, `startedAt`),
  INDEX `osbackup_kind_startedAt_idx`(`kind`, `startedAt`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── osbackupjob (backup / restore / rollback runs) ──
CREATE TABLE IF NOT EXISTS `osbackupjob` (
  `id` VARCHAR(191) NOT NULL,
  `type` VARCHAR(16) NOT NULL,
  `trigger` VARCHAR(16) NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `phase` VARCHAR(32) NULL,
  `progress` JSON NULL,
  `backupId` VARCHAR(191) NULL,
  `safetyBackupId` VARCHAR(191) NULL,
  `requestedById` VARCHAR(191) NULL,
  `requestedByEmail` VARCHAR(191) NULL,
  `workerPid` INTEGER NULL,
  `workerHost` VARCHAR(100) NULL,
  `heartbeatAt` DATETIME(3) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `error` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `osbackupjob_type_createdAt_idx`(`type`, `createdAt`),
  INDEX `osbackupjob_status_idx`(`status`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── osbackupchallenge (email OTP + one-time download ticket) ──
CREATE TABLE IF NOT EXISTS `osbackupchallenge` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `backupId` VARCHAR(191) NOT NULL,
  `codeHash` CHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `sendCount` INTEGER NOT NULL DEFAULT 1,
  `lastSentAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `invalidatedAt` DATETIME(3) NULL,
  `ip` VARCHAR(64) NULL,
  `userAgent` VARCHAR(255) NULL,
  `downloadTicketHash` CHAR(64) NULL,
  `ticketExpiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `osbackupchallenge_userId_action_createdAt_idx`(`userId`, `action`, `createdAt`),
  INDEX `osbackupchallenge_downloadTicketHash_idx`(`downloadTicketHash`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── osbackupstate (singleton id = 1: schedule, lock row, failure streak, alert throttles, detection) ──
CREATE TABLE IF NOT EXISTS `osbackupstate` (
  `id` INTEGER NOT NULL,
  `schedulePaused` BOOLEAN NOT NULL DEFAULT false,
  `pausedById` VARCHAR(191) NULL,
  `pausedAt` DATETIME(3) NULL,
  `lockJobId` VARCHAR(191) NULL,
  `lockedAt` DATETIME(3) NULL,
  `heartbeatAt` DATETIME(3) NULL,
  `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
  `lastSuccessAt` DATETIME(3) NULL,
  `lastFailureAt` DATETIME(3) NULL,
  `lastError` VARCHAR(500) NULL,
  `lastFailureAlertAt` DATETIME(3) NULL,
  `lastDiskAlertAt` DATETIME(3) NULL,
  `lastStaleAlertAt` DATETIME(3) NULL,
  `maintenanceJobId` VARCHAR(191) NULL,
  `detectJson` JSON NULL,
  `detectedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Columns / index added after the first design (no-ops on a table created above) ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'osbackupchallenge' AND COLUMN_NAME = 'downloadTicketHash');
SET @sql := IF(@col = 0, 'ALTER TABLE `osbackupchallenge` ADD COLUMN `downloadTicketHash` CHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'osbackupchallenge' AND COLUMN_NAME = 'ticketExpiresAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `osbackupchallenge` ADD COLUMN `ticketExpiresAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'osbackupchallenge' AND INDEX_NAME = 'osbackupchallenge_downloadTicketHash_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `osbackupchallenge_downloadTicketHash_idx` ON `osbackupchallenge`(`downloadTicketHash`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'osbackupstate' AND COLUMN_NAME = 'lastStaleAlertAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `osbackupstate` ADD COLUMN `lastStaleAlertAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Singleton state row (UTC, like every Prisma DateTime) ──
INSERT IGNORE INTO `osbackupstate` (`id`, `schedulePaused`, `consecutiveFailures`, `updatedAt`)
VALUES (1, false, 0, UTC_TIMESTAMP(3));
