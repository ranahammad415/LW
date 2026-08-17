-- AI-led expert interview reuses voiceinterviewsession for text conversations,
-- so the row needs to say which modality it was and what briefing the model was
-- given before it asked anything. Idempotent, additive only.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'mode');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `mode` VARCHAR(20) NOT NULL DEFAULT ''VOICE'' AFTER `userId`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'briefing');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `briefing` JSON NULL AFTER `extractedData`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Resuming an interview looks up the caller's most recent ACTIVE text session.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession'
    AND INDEX_NAME = 'voiceinterviewsession_clientId_mode_status_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `voiceinterviewsession_clientId_mode_status_idx` ON `voiceinterviewsession`(`clientId`, `mode`, `status`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
