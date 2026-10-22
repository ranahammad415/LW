-- Local SEO via DataForSEO (docs/ledger/features/local-seo.md).
-- Additive and idempotent: information_schema check + PREPARE per column / index, CREATE TABLE IF NOT EXISTS with the
-- foreign keys inline. Nothing dropped, renamed or retyped. The only data change moves "place_id:<id>" values out of
-- project.gmbCid into the new gmbPlaceId column (copy first; gmbCid is cleared only where the copy matches) and strips
-- the "cid:" prefix from numeric CIDs (normalizeGmbIdentifier reads both forms).

SET @db := DATABASE();

-- project
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbPlaceId');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbPlaceId` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbFeatureId');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbFeatureId` VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbLat');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbLat` DOUBLE NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbLng');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbLng` DOUBLE NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbAddress');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbAddress` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbPhone');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbPhone` VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbCategory');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbCategory` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbWebsite');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbWebsite` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbRating');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbRating` DOUBLE NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbReviewsCount');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbReviewsCount` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbProfileSyncedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbProfileSyncedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbIdentitySource');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbIdentitySource` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbIdentityVerifiedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbIdentityVerifiedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbSyncError');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbSyncError` VARCHAR(300) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbReviewsFullAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbReviewsFullAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbReviewsTaskId');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbReviewsTaskId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbReviewsTaskAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbReviewsTaskAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'gmbReviewsTaskDepth');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `gmbReviewsTaskDepth` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localLocationCode');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localLocationCode` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localLocationName');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localLocationName` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localLanguageCode');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localLanguageCode` VARCHAR(8) NOT NULL DEFAULT ''en''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localGridEnabled');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localGridEnabled` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localGridSize');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localGridSize` INTEGER NOT NULL DEFAULT 5', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'localGridSpacingKm');
SET @sql := IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN `localGridSpacingKm` DOUBLE NOT NULL DEFAULT 1.5', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- keywordtrack
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'keywordtrack' AND COLUMN_NAME = 'trackLocal');
SET @sql := IF(@col = 0, 'ALTER TABLE `keywordtrack` ADD COLUMN `trackLocal` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'keywordtrack' AND COLUMN_NAME = 'rankStatus');
SET @sql := IF(@col = 0, 'ALTER TABLE `keywordtrack` ADD COLUMN `rankStatus` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'keywordtrack' AND COLUMN_NAME = 'rankCheckedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `keywordtrack` ADD COLUMN `rankCheckedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'keywordtrack' AND COLUMN_NAME = 'rankError');
SET @sql := IF(@col = 0, 'ALTER TABLE `keywordtrack` ADD COLUMN `rankError` VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- gmbreview
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'gmbreview' AND COLUMN_NAME = 'source');
SET @sql := IF(@col = 0, 'ALTER TABLE `gmbreview` ADD COLUMN `source` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'gmbreview' AND COLUMN_NAME = 'fingerprint');
SET @sql := IF(@col = 0, 'ALTER TABLE `gmbreview` ADD COLUMN `fingerprint` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'gmbreview' AND COLUMN_NAME = 'lastSeenAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `gmbreview` ADD COLUMN `lastSeenAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'gmbreview' AND COLUMN_NAME = 'removedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `gmbreview` ADD COLUMN `removedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- gmbreview (projectId, fingerprint) index
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'gmbreview' AND INDEX_NAME = 'gmbreview_projectId_fingerprint_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `gmbreview_projectId_fingerprint_idx` ON `gmbreview`(`projectId`, `fingerprint`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Identity data: place_id moves to its own column (re-runnable: only rows still carrying the prefix are touched).
UPDATE `project` SET `gmbPlaceId` = TRIM(SUBSTRING(`gmbCid`, 10))
  WHERE `gmbCid` LIKE 'place\_id:%' AND `gmbPlaceId` IS NULL AND CHAR_LENGTH(TRIM(SUBSTRING(`gmbCid`, 10))) > 0;
UPDATE `project` SET `gmbCid` = NULL
  WHERE `gmbCid` LIKE 'place\_id:%' AND `gmbPlaceId` = TRIM(SUBSTRING(`gmbCid`, 10));
-- "cid:<digits>" becomes the normalised digits-only CID.
UPDATE `project` SET `gmbCid` = TRIM(SUBSTRING(`gmbCid`, 5))
  WHERE `gmbCid` LIKE 'cid:%' AND TRIM(SUBSTRING(`gmbCid`, 5)) REGEXP '^[0-9]+$';
-- Existing bindings get an identity source (never overwrites one already set).
UPDATE `project` SET `gmbIdentitySource` = 'native'
  WHERE `gmbIdentitySource` IS NULL AND `gmbLocationId` IS NOT NULL;
UPDATE `project` SET `gmbIdentitySource` = 'manual'
  WHERE `gmbIdentitySource` IS NULL AND (`gmbCid` IS NOT NULL OR `gmbPlaceId` IS NOT NULL);

CREATE TABLE IF NOT EXISTS `localrankdaily` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `keywordId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `rank` INTEGER NULL,
  `rankAbsolute` INTEGER NULL,
  `inPack` BOOLEAN NOT NULL DEFAULT false,
  `matchedBy` VARCHAR(12) NULL,
  `competitors` JSON NULL,
  `locationMode` VARCHAR(16) NULL,
  `depth` INTEGER NULL,
  `costUsd` DECIMAL(10, 5) NULL,
  `status` VARCHAR(12) NOT NULL,
  `errorCode` VARCHAR(40) NULL,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `localrankdaily_projectId_date_idx`(`projectId`, `date`),
  UNIQUE INDEX `localrankdaily_keywordId_date_key`(`keywordId`, `date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `localrankdaily_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `localrankdaily_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `keywordtrack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `localrankgrid` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `keywordId` VARCHAR(191) NOT NULL,
  `runAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `gridSize` INTEGER NOT NULL,
  `spacingKm` DOUBLE NOT NULL,
  `centerLat` DOUBLE NOT NULL,
  `centerLng` DOUBLE NOT NULL,
  `points` JSON NOT NULL,
  `avgRank` DOUBLE NULL,
  `coverage` DOUBLE NULL,
  `costUsd` DECIMAL(10, 5) NULL,
  `status` VARCHAR(12) NOT NULL,
  `errorCode` VARCHAR(40) NULL,
  INDEX `localrankgrid_projectId_runAt_idx`(`projectId`, `runAt`),
  INDEX `localrankgrid_keywordId_runAt_idx`(`keywordId`, `runAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `localrankgrid_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `localrankgrid_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `keywordtrack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `analyticssyncrun` (
  `id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `status` VARCHAR(12) NOT NULL,
  `requestedById` VARCHAR(191) NULL,
  `summary` JSON NULL,
  `error` VARCHAR(500) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `analyticssyncrun_kind_createdAt_idx`(`kind`, `createdAt`),
  INDEX `analyticssyncrun_projectId_kind_createdAt_idx`(`projectId`, `kind`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
