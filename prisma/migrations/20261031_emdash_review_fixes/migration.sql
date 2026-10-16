-- EmDash review fixes (M-4, L-10): draft edit markers. Additive, idempotent.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraft' AND COLUMN_NAME = 'bylinesEdited');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraft` ADD COLUMN `bylinesEdited` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraft' AND COLUMN_NAME = 'cmsEditedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraft` ADD COLUMN `cmsEditedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
