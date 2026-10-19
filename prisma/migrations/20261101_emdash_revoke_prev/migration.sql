-- EmDash bridge v1.5.6 §32.1: revoke-now key rotation (rotate.revokePrev). Additive, idempotent.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmscredential' AND COLUMN_NAME = 'pendingRevokePrev');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmscredential` ADD COLUMN `pendingRevokePrev` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmscredential' AND COLUMN_NAME = 'prevRevokedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmscredential` ADD COLUMN `prevRevokedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmscredential' AND COLUMN_NAME = 'revokeConfirmedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmscredential` ADD COLUMN `revokeConfirmedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmscredential' AND COLUMN_NAME = 'revokeConfirmError');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmscredential` ADD COLUMN `revokeConfirmError` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Previous-key ciphertext of pairs that are already expired is not needed any more (v1.5.6 hygiene).
UPDATE `cmscredential` SET `inboundKeyPrevEnc` = NULL, `outboundKeyPrevEnc` = NULL
  WHERE `prevExpiresAt` IS NOT NULL AND `prevExpiresAt` < NOW(3)
    AND (`inboundKeyPrevEnc` IS NOT NULL OR `outboundKeyPrevEnc` IS NOT NULL);
