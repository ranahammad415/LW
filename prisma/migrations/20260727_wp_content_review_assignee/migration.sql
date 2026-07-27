-- OS-side worker assignee for content review pipelines (idempotent).
-- Columns may already exist from a prior db push.

SET @db := DATABASE();

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'assignedWorkerId'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `assignedWorkerId` VARCHAR(100) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'assignedWorkerName'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `assignedWorkerName` VARCHAR(200) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND INDEX_NAME = 'wpcontentreview_assignedWorkerId_idx'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `wpcontentreview_assignedWorkerId_idx` ON `wpcontentreview`(`assignedWorkerId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: default assignee = submitter when missing.
UPDATE `wpcontentreview`
SET `assignedWorkerId` = `submittedById`,
    `assignedWorkerName` = `submittedByName`
WHERE `assignedWorkerId` IS NULL
  AND `submittedById` IS NOT NULL;
