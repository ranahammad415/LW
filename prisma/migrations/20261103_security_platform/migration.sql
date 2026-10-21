-- Security platform (EmDash contract v1.6.0 §36 + scaffold for v1.6.1 security config), plan §5.
-- Additive and idempotent: guarded ADD COLUMNs, CREATE TABLE IF NOT EXISTS, INSERT IGNORE. Nothing dropped, renamed or retyped.

SET @db := DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'agency_setting' AND COLUMN_NAME = 'securityOnCallUserIds');
SET @sql := IF(@col = 0,
  'ALTER TABLE `agency_setting` ADD COLUMN `securityOnCallUserIds` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'agency_setting' AND COLUMN_NAME = 'securityRetentionDays');
SET @sql := IF(@col = 0,
  'ALTER TABLE `agency_setting` ADD COLUMN `securityRetentionDays` INTEGER NOT NULL DEFAULT 400',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `securitysitestatus` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `overallState` VARCHAR(16) NULL,
  `score` INTEGER NULL,
  `counts` JSON NULL,
  `overallSince` DATETIME(3) NULL,
  `categories` JSON NULL,
  `catalogueVersion` VARCHAR(16) NULL,
  `sentinelVersion` VARCHAR(32) NULL,
  `workerLastSeenAt` DATETIME(3) NULL,
  `scansLastFullAt` DATETIME(3) NULL,
  `lastBuild` JSON NULL,
  `disabled` JSON NULL,
  `statusAt` DATETIME(3) NULL,
  `lastScan` JSON NULL,
  `backups` JSON NULL,
  `backupsReportedAt` DATETIME(3) NULL,
  `lastRestoreTest` JSON NULL,
  `lastPullAt` DATETIME(3) NULL,
  `lastPullError` VARCHAR(40) NULL,
  `retryAfterUntil` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securitysitestatus_projectId_key`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitysitestatus_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securitycheckstate` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `checkId` VARCHAR(80) NOT NULL,
  `category` VARCHAR(32) NOT NULL,
  `severity` VARCHAR(16) NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `reason` VARCHAR(32) NULL,
  `source` VARCHAR(16) NULL,
  `frequency` VARCHAR(16) NULL,
  `checkedAt` DATETIME(3) NULL,
  `since` DATETIME(3) NULL,
  `firstSeenAt` DATETIME(3) NULL,
  `lastChangedAt` DATETIME(3) NULL,
  `summary` VARCHAR(400) NULL,
  `clientSummary` VARCHAR(400) NULL,
  `remediation` TEXT NULL,
  `evidence` JSON NULL,
  `evidenceAt` DATETIME(3) NULL,
  `refs` JSON NULL,
  `acknowledged` JSON NULL,
  `pmNote` VARCHAR(1000) NULL,
  `pmNoteEta` DATETIME(3) NULL,
  `pmNoteById` VARCHAR(191) NULL,
  `pmNoteAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securitycheckstate_projectId_checkId_key`(`projectId`, `checkId`),
  INDEX `securitycheckstate_projectId_state_idx`(`projectId`, `state`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitycheckstate_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securitytransition` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `checkId` VARCHAR(80) NOT NULL,
  `fromState` VARCHAR(16) NULL,
  `toState` VARCHAR(16) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `severity` VARCHAR(16) NOT NULL,
  `summary` VARCHAR(400) NULL,
  `clientSummary` VARCHAR(400) NULL,
  `origin` VARCHAR(16) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securitytransition_projectId_checkId_toState_at_key`(`projectId`, `checkId`, `toState`, `at`),
  INDEX `securitytransition_projectId_at_idx`(`projectId`, `at`),
  INDEX `securitytransition_at_idx`(`at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitytransition_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securitydailypoint` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `date` VARCHAR(10) NOT NULL,
  `overallState` VARCHAR(16) NOT NULL,
  `score` INTEGER NOT NULL,
  `counts` JSON NULL,
  `checks` JSON NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securitydailypoint_projectId_date_key`(`projectId`, `date`),
  INDEX `securitydailypoint_date_idx`(`date`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitydailypoint_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securitybackuprun` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(160) NOT NULL,
  `kind` VARCHAR(8) NULL,
  `owner` VARCHAR(8) NULL,
  `destinationId` VARCHAR(64) NULL,
  `destinationType` VARCHAR(32) NULL,
  `destinationLabel` VARCHAR(100) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `bytes` BIGINT NULL,
  `sha256` VARCHAR(64) NULL,
  `result` VARCHAR(16) NOT NULL,
  `errorCode` VARCHAR(16) NULL,
  `encrypted` BOOLEAN NULL,
  `verified` BOOLEAN NULL,
  `restoreTest` JSON NULL,
  `origin` VARCHAR(16) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securitybackuprun_projectId_runId_key`(`projectId`, `runId`),
  INDEX `securitybackuprun_projectId_destinationId_createdAt_idx`(`projectId`, `destinationId`, `createdAt`),
  INDEX `securitybackuprun_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitybackuprun_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securityincident` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `incidentId` VARCHAR(64) NOT NULL,
  `phase` VARCHAR(16) NOT NULL,
  `severity` VARCHAR(16) NOT NULL,
  `summary` VARCHAR(600) NOT NULL,
  `openedAt` DATETIME(3) NULL,
  `lastAt` DATETIME(3) NOT NULL,
  `by` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securityincident_projectId_incidentId_key`(`projectId`, `incidentId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securityincident_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securityalertlog` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `alertKey` VARCHAR(191) NOT NULL,
  `sentAt` DATETIME(3) NOT NULL,
  `count` INTEGER NOT NULL DEFAULT 1,
  UNIQUE INDEX `securityalertlog_projectId_alertKey_key`(`projectId`, `alertKey`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securityalertlog_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securitymonthlyreport` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `clientHtml` LONGTEXT NOT NULL,
  `adminHtml` LONGTEXT NOT NULL,
  `overallState` VARCHAR(16) NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `generatedById` VARCHAR(191) NULL,
  UNIQUE INDEX `securitymonthlyreport_projectId_month_key`(`projectId`, `month`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securitymonthlyreport_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securityconfigmirror` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `rev` INTEGER NULL,
  `config` JSON NULL,
  `lastChangedAt` DATETIME(3) NULL,
  `stale` BOOLEAN NOT NULL DEFAULT false,
  `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `securityconfigmirror_projectId_key`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securityconfigmirror_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `securityconfigaction` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `idempotencyKey` VARCHAR(80) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(40) NOT NULL,
  `summary` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `securityconfigaction_projectId_createdAt_idx`(`projectId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `securityconfigaction_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Notification templates (category `security`; seed-notifications.js seeds the same rows) ──
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'security_alert', 'Security Alert', 'A website security check failed (critical/high: on-call + owner) or a backup destination failed twice', 'security',
   'Security alert ({{severity}}): {{projectName}}',
   '<p><strong>{{title}}</strong> on <strong>{{projectName}}</strong>.</p><p>{{details}}</p><p>Open the project Security tab for the evidence and the fix.</p>',
   '{{title}} on {{projectName}}. {{details}} Open the project Security tab for the evidence and the fix.',
   'Security ({{severity}}): {{title}} on {{projectName}}',
   JSON_ARRAY('projectName','title','details','severity','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));

INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'security_digest', 'Security Daily Digest', 'Daily list of medium/low security failures and warnings on the PM''s sites', 'security',
   'Security digest: {{projectName}} ({{count}} items)',
   '<p>Security items that need attention on <strong>{{projectName}}</strong> in the last 24 hours:</p><p>{{items}}</p>',
   'Security items on {{projectName}} in the last 24 hours: {{items}}',
   'Security digest: {{count}} items on {{projectName}}',
   JSON_ARRAY('projectName','count','items','actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3));

INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'security_backup_failed', 'Website Backup Problem', 'A backup to one of your own backup destinations failed 3 times in a row (client notice, plain language)', 'security',
   'Backups to {{destination}} are not working',
   '<p>The last {{failures}} backups of <strong>{{projectName}}</strong> to <strong>{{destination}}</strong> did not complete. Your agency has been told and is looking into it. The agency''s own backups are separate.</p>',
   'The last {{failures}} backups of {{projectName}} to {{destination}} did not complete. Your agency has been told and is looking into it.',
   'Backups of {{projectName}} to {{destination}} are not working',
   JSON_ARRAY('projectName','destination','failures','actionUrl'), 1, 0, 0, 1, 1, NOW(3), NOW(3));
