-- OS-editable description on content reviews (idempotent).
SET @db := DATABASE();

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'description'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `description` LONGTEXT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
