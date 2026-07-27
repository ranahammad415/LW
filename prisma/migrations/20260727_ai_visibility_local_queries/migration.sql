-- Project local market for AI Visibility query rewrites + sourceQuery on results
SET @db := DATABASE();

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'targetMarket'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `project` ADD COLUMN `targetMarket` VARCHAR(120) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityresult' AND COLUMN_NAME = 'sourceQuery'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `aivisibilityresult` ADD COLUMN `sourceQuery` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
