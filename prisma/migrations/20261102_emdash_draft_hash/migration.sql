-- EmDash bridge v1.5.7 / v1.5.8: draftHash + hashBasis on pushes, SEO canonical / noindex on OS drafts. Additive, idempotent.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraftpush' AND COLUMN_NAME = 'rev');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraftpush` ADD COLUMN `rev` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraftpush' AND COLUMN_NAME = 'draftRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraftpush` ADD COLUMN `draftRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraftpush' AND COLUMN_NAME = 'draftHash');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraftpush` ADD COLUMN `draftHash` VARCHAR(80) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraftpush' AND COLUMN_NAME = 'hashBasis');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraftpush` ADD COLUMN `hashBasis` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraft' AND COLUMN_NAME = 'seoCanonical');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraft` ADD COLUMN `seoCanonical` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraft' AND COLUMN_NAME = 'seoNoIndex');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraft` ADD COLUMN `seoNoIndex` BOOLEAN NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmsdraft' AND COLUMN_NAME = 'cmsDraftHash');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmsdraft` ADD COLUMN `cmsDraftHash` VARCHAR(80) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
