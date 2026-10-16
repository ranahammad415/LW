-- EmDash bridge contract v1.5.2: the published review's live revision. Additive, idempotent.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsLiveRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsLiveRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
