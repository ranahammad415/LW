-- Release 3 e2e fixes (docs/ledger/features/signals-attribution.md, O-R3B-1 / O-R3B-3).
-- Additive and idempotent: information_schema check + PREPARE per column. Nothing dropped or rewritten.
--   signalsession.leadCount     distinct leads of the session (several quotes in one visit); leadId stays = first lead
--   signalerasure.siteConfirmedAt  when the site's signals.erased confirmed an OS-initiated erasure

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'signalsession' AND COLUMN_NAME = 'leadCount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `signalsession` ADD COLUMN `leadCount` INTEGER NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing sessions with a lead held at least one (idempotent: only rows still at 0).
UPDATE `signalsession` SET `leadCount` = 1 WHERE `leadId` IS NOT NULL AND `leadCount` = 0;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'signalerasure' AND COLUMN_NAME = 'siteConfirmedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `signalerasure` ADD COLUMN `siteConfirmedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
