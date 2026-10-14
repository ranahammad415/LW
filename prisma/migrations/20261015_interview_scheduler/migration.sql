-- Interview scheduler, Phase 1 (plan: docs/plans/okf-voice-interview-scheduler.md).
-- Idempotent and additive only: every column/index is guarded by an
-- information_schema check, tables use CREATE TABLE IF NOT EXISTS, and seed
-- rows use INSERT IGNORE so re-running is safe and never overwrites edits.

SET @db := DATABASE();

-- ── knowledgeinterviewinvite: additive columns ──

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'campaignId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `campaignId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'templateKey');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `templateKey` VARCHAR(40) NOT NULL DEFAULT ''CUSTOM''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'agenda');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `agenda` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'mode');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `mode` VARCHAR(10) NOT NULL DEFAULT ''VOICE''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'language');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `language` VARCHAR(10) NOT NULL DEFAULT ''en''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'emailSubject');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `emailSubject` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'emailIntro');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `emailIntro` TEXT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'tokenNonce');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `tokenNonce` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'scheduledSendAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `scheduledSendAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'sentAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `sentAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'sendError');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `sendError` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'reminderDays');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `reminderDays` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'reminderCount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `reminderCount` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'lastReminderAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `lastReminderAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'startedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `startedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'abandonedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `abandonedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'statusReason');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `statusReason` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'consentAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `consentAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'consentVersion');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `consentVersion` VARCHAR(20) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'consentIp');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `consentIp` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'consentUserAgent');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `consentUserAgent` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'minutesBudget');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `minutesBudget` INT NOT NULL DEFAULT 20',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'totalVoiceSeconds');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `totalVoiceSeconds` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'sessionCount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `sessionCount` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'dispatchKey');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `dispatchKey` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'lockedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `lockedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'lockedBy');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `lockedBy` VARCHAR(100) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'autoApproveLowRisk');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `autoApproveLowRisk` BOOLEAN NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'parentInviteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `parentInviteId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'rootInviteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `rootInviteId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'delegationDepth');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `delegationDepth` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'delegatedBySessionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `delegatedBySessionId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'delegationReason');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `delegationReason` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'respondentRole');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `respondentRole` VARCHAR(10) NOT NULL DEFAULT ''CLIENT''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'respondentJobRole');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `respondentJobRole` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'questionCluster');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `questionCluster` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'delegationCount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `delegationCount` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'declinedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `declinedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'summaryStatus');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `summaryStatus` VARCHAR(20) NOT NULL DEFAULT ''NONE''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'rootCompletedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `rootCompletedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND COLUMN_NAME = 'summarySentAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `knowledgeinterviewinvite` ADD COLUMN `summarySentAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── voiceinterviewsession: additive columns ──

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'inviteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `inviteId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'lastHeartbeatAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `lastHeartbeatAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'language');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `language` VARCHAR(10) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'consolidationStatus');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `consolidationStatus` VARCHAR(20) NOT NULL DEFAULT ''NONE''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'consolidatedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `consolidatedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND COLUMN_NAME = 'usage');
SET @sql := IF(@col = 0,
  'ALTER TABLE `voiceinterviewsession` ADD COLUMN `usage` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── okfdraftchange: additive columns ──

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'inviteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `inviteId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'rootInviteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `rootInviteId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'respondentRole');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `respondentRole` VARCHAR(10) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'respondentName');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `respondentName` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'sourceQuote');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `sourceQuote` TEXT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'transcriptRef');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `transcriptRef` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'factType');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `factType` VARCHAR(30) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'changeKind');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `changeKind` VARCHAR(20) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'riskLevel');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `riskLevel` VARCHAR(10) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'changeSummary');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `changeSummary` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'dedupeHash');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `dedupeHash` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'currentBodyHash');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `currentBodyHash` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'autoApproved');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `autoApproved` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'clientCorrected');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `clientCorrected` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND COLUMN_NAME = 'conflictWithDraftId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `okfdraftchange` ADD COLUMN `conflictWithDraftId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── indexes ──

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND INDEX_NAME = 'knowledgeinterviewinvite_dispatchKey_key');
SET @sql := IF(@idx = 0,
  'CREATE UNIQUE INDEX `knowledgeinterviewinvite_dispatchKey_key` ON `knowledgeinterviewinvite` (`dispatchKey`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND INDEX_NAME = 'knowledgeinterviewinvite_status_scheduledSendAt_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `knowledgeinterviewinvite_status_scheduledSendAt_idx` ON `knowledgeinterviewinvite` (`status`, `scheduledSendAt`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND INDEX_NAME = 'knowledgeinterviewinvite_campaignId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `knowledgeinterviewinvite_campaignId_idx` ON `knowledgeinterviewinvite` (`campaignId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND INDEX_NAME = 'knowledgeinterviewinvite_parentInviteId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `knowledgeinterviewinvite_parentInviteId_idx` ON `knowledgeinterviewinvite` (`parentInviteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'knowledgeinterviewinvite' AND INDEX_NAME = 'knowledgeinterviewinvite_rootInviteId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `knowledgeinterviewinvite_rootInviteId_idx` ON `knowledgeinterviewinvite` (`rootInviteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND INDEX_NAME = 'voiceinterviewsession_inviteId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `voiceinterviewsession_inviteId_idx` ON `voiceinterviewsession` (`inviteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'voiceinterviewsession' AND INDEX_NAME = 'voiceinterviewsession_consolidationStatus_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `voiceinterviewsession_consolidationStatus_idx` ON `voiceinterviewsession` (`consolidationStatus`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND INDEX_NAME = 'okfdraftchange_clientId_dedupeHash_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `okfdraftchange_clientId_dedupeHash_idx` ON `okfdraftchange` (`clientId`, `dedupeHash`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND INDEX_NAME = 'okfdraftchange_inviteId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `okfdraftchange_inviteId_idx` ON `okfdraftchange` (`inviteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'okfdraftchange' AND INDEX_NAME = 'okfdraftchange_rootInviteId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `okfdraftchange_rootInviteId_idx` ON `okfdraftchange` (`rootInviteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing invites become their own tree roots.
UPDATE `knowledgeinterviewinvite` SET `rootInviteId` = `id` WHERE `rootInviteId` IS NULL;

-- ── new tables ──

CREATE TABLE IF NOT EXISTS `interviewdispatchlog` (
  `id` VARCHAR(191) NOT NULL,
  `inviteId` VARCHAR(191) NULL,
  `campaignId` VARCHAR(191) NULL,
  `kind` VARCHAR(30) NOT NULL,
  `ok` BOOLEAN NOT NULL DEFAULT true,
  `detail` VARCHAR(1000) NULL,
  `instance` VARCHAR(50) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `interviewdispatchlog_inviteId_createdAt_idx` (`inviteId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `interviewsetting` (
  `id` VARCHAR(191) NOT NULL,
  `scope` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(255) NULL,
  `monthlyMinutesPerClient` INT NULL,
  `agencyMonthlyMinutes` INT NULL,
  `autoApproveLowRisk` BOOLEAN NULL,
  `transcriptRetentionDays` INT NULL,
  `clientCanViewOwnTranscripts` BOOLEAN NULL,
  `clientCanViewWorkerTranscripts` BOOLEAN NULL,
  `updatedById` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `interviewsetting_scope_key` (`scope`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Modality: the Interview Scheduler page is OFF by default (rollout step 1).
-- INSERT IGNORE keeps any value the owner has already set.
INSERT IGNORE INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES (UUID(), 'interviewScheduler', 'OWNER', 0, NOW(3), NOW(3));

-- ── Staff notification templates (unseeded slugs are silently dropped, known-issues B5).
-- Mirrors prisma/seed-notifications.js; INSERT IGNORE never overwrites owner edits.
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'interview_completed_staff', 'Interview Completed', 'A respondent finished a knowledge interview', 'interview',
   'Interview completed: {{clientName}}',
   '<p><strong>{{respondentName}}</strong> finished the knowledge interview for <strong>{{clientName}}</strong>. {{draftCount}} item(s) were captured and are waiting in the review queue.</p>',
   '{{respondentName}} finished the knowledge interview for {{clientName}}. {{draftCount}} item(s) are waiting in the review queue.',
   'Interview completed: {{clientName}} ({{draftCount}} items)',
   JSON_ARRAY('clientName','respondentName','draftCount','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'interview_drafts_ready', 'Interview Drafts Ready', 'Interview captures were consolidated and are ready for review', 'interview',
   'Interview drafts ready for review: {{clientName}}',
   '<p>The interview for <strong>{{clientName}}</strong> has been consolidated: {{draftCount}} draft(s) ({{highCount}} high risk, {{mediumCount}} medium, {{lowCount}} low).</p>',
   'Interview drafts ready for {{clientName}}: {{draftCount}} ({{highCount}} high, {{mediumCount}} medium, {{lowCount}} low).',
   'Interview drafts ready: {{clientName}} ({{draftCount}})',
   JSON_ARRAY('clientName','draftCount','highCount','mediumCount','lowCount','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'interview_send_failed', 'Interview Email Failed', 'An interview invite email could not be sent', 'interview',
   'Interview email failed: {{clientName}}',
   '<p>The interview email to <strong>{{recipient}}</strong> for <strong>{{clientName}}</strong> could not be sent: {{error}}</p>',
   'The interview email to {{recipient}} for {{clientName}} could not be sent: {{error}}',
   'Interview email failed for {{clientName}}',
   JSON_ARRAY('clientName','recipient','error','actionUrl'), 1, 1, 0, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'interview_delegated_staff', 'Interview Delegated', 'A client handed interview questions to a colleague', 'interview',
   'Interview questions delegated: {{clientName}}',
   '<p><strong>{{delegatorName}}</strong> at <strong>{{clientName}}</strong> handed {{questionCount}} question(s) to <strong>{{workerName}}</strong> ({{workerDomain}}). {{domainNote}}</p>',
   '{{delegatorName}} at {{clientName}} handed {{questionCount}} question(s) to {{workerName}} ({{workerDomain}}). {{domainNote}}',
   'Interview delegated to {{workerName}} ({{clientName}})',
   JSON_ARRAY('clientName','delegatorName','workerName','workerDomain','questionCount','domainNote','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'interview_delegation_declined', 'Interview Delegation Declined', 'A colleague declined delegated interview questions', 'interview',
   'Delegated interview declined: {{clientName}}',
   '<p><strong>{{workerName}}</strong> declined the interview questions delegated by {{delegatorName}} for <strong>{{clientName}}</strong>.</p>',
   '{{workerName}} declined the interview questions delegated by {{delegatorName}} for {{clientName}}.',
   'Delegation declined by {{workerName}} ({{clientName}})',
   JSON_ARRAY('clientName','delegatorName','workerName','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));
