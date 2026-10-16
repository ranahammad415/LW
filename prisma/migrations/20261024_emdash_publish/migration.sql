-- EmDash bridge Phase 2 stage 3 (contract v1.3.0): publish / schedule from the OS (allowOsPublish).
-- Additive and idempotent (guarded ADD COLUMNs). WordPress rows are unaffected (all new columns nullable).

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsScheduledAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsScheduledAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsPublishOrigin');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsPublishOrigin` VARCHAR(16) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsPublishedBy');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsPublishedBy` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsOverride');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsOverride` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsScheduledAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsScheduledAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
