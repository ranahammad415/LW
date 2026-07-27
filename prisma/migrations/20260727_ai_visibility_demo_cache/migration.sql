-- Demo flag + probe fingerprint for 7-day live cache
SET @db := DATABASE();

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND COLUMN_NAME = 'isDemo'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `aivisibilityrun` ADD COLUMN `isDemo` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND COLUMN_NAME = 'probeFingerprint'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `aivisibilityrun` ADD COLUMN `probeFingerprint` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'aivisibilityrun' AND INDEX_NAME = 'aivisibilityrun_projectId_probeFingerprint_idx'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `aivisibilityrun_projectId_probeFingerprint_idx` ON `aivisibilityrun`(`projectId`, `probeFingerprint`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
