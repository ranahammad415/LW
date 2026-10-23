-- Embedded GoHighLevel forms and EmDash contract 1.9.0 (docs/ledger/features/ghl-forms.md, emdash-bridge.md §v1.9.0).
-- Additive and idempotent: information_schema check + PREPARE per column / index, CREATE TABLE IF NOT EXISTS with
-- inline FKs, INSERT IGNORE. Nothing dropped, renamed or retyped. Existing leads keep provider 'emdash' (the default).
-- The DDL matches `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <branch schema>`.

SET @db := DATABASE();

-- ── cmslead ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'provider');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT ''emdash''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'externalId');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `externalId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'externalUrl');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `externalUrl` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'cmsMirrorLeadId');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `cmsMirrorLeadId` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'mirrorState');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `mirrorState` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'mirrorAttempts');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `mirrorAttempts` INTEGER NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'mirrorNextAt');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `mirrorNextAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'mirrorError');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `mirrorError` VARCHAR(40) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND COLUMN_NAME = 'externalErasePending');
SET @sql := IF(@col = 0, 'ALTER TABLE `cmslead` ADD COLUMN `externalErasePending` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND INDEX_NAME = 'cmslead_projectId_provider_externalId_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `cmslead_projectId_provider_externalId_idx` ON `cmslead`(`projectId`, `provider`, `externalId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND INDEX_NAME = 'cmslead_projectId_cmsMirrorLeadId_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `cmslead_projectId_cmsMirrorLeadId_idx` ON `cmslead`(`projectId`, `cmsMirrorLeadId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmslead' AND INDEX_NAME = 'cmslead_mirrorState_mirrorNextAt_idx');
SET @sql := IF(@idx = 0, 'CREATE INDEX `cmslead_mirrorState_mirrorNextAt_idx` ON `cmslead`(`mirrorState`, `mirrorNextAt`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── signalsession (form_submit counter, contract 1.9.0 §40.3) ──
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'signalsession' AND COLUMN_NAME = 'formSubmits');
SET @sql := IF(@col = 0, 'ALTER TABLE `signalsession` ADD COLUMN `formSubmits` INTEGER NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── externalformendpoint ──
CREATE TABLE IF NOT EXISTS `externalformendpoint` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(16) NOT NULL DEFAULT 'ghl',
  `tokenHash` CHAR(64) NOT NULL,
  `tokenPrefix` VARCHAR(12) NOT NULL,
  `headerSecretHash` CHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById` VARCHAR(191) NULL,
  `rotatedAt` DATETIME(3) NULL,
  `prevTokenHash` CHAR(64) NULL,
  `prevValidUntil` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `lastReceivedAt` DATETIME(3) NULL,
  UNIQUE INDEX `externalformendpoint_tokenHash_key`(`tokenHash`),
  INDEX `externalformendpoint_prevTokenHash_idx`(`prevTokenHash`),
  UNIQUE INDEX `externalformendpoint_projectId_provider_key`(`projectId`, `provider`),
  PRIMARY KEY (`id`),
  CONSTRAINT `externalformendpoint_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── externalformreceipt (90 days, purged by the leader job) ──
CREATE TABLE IF NOT EXISTS `externalformreceipt` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(16) NOT NULL DEFAULT 'ghl',
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `status` VARCHAR(16) NOT NULL,
  `reason` VARCHAR(40) NULL,
  `shape` VARCHAR(16) NULL,
  `payloadHash` CHAR(64) NULL,
  `dedupeKey` CHAR(64) NULL,
  `externalId` VARCHAR(64) NULL,
  `formId` VARCHAR(64) NULL,
  `leadId` VARCHAR(64) NULL,
  `duplicateOf` VARCHAR(64) NULL,
  `ipHash` CHAR(16) NULL,
  `bytes` INTEGER NOT NULL DEFAULT 0,
  UNIQUE INDEX `externalformreceipt_dedupeKey_key`(`dedupeKey`),
  INDEX `externalformreceipt_projectId_receivedAt_idx`(`projectId`, `receivedAt`),
  INDEX `externalformreceipt_projectId_externalId_receivedAt_idx`(`projectId`, `externalId`, `receivedAt`),
  INDEX `externalformreceipt_receivedAt_idx`(`receivedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `externalformreceipt_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── notification template: new lead (site form or embedded GoHighLevel form); staff only, no PII ──
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'lead_received', 'New Lead', 'A new quote request reached Agency OS from the website form or the embedded GoHighLevel form (project PMs; staff only; no personal data in the message)', 'client',
   'New lead: {{projectName}}',
   '<p>A new request for <strong>{{projectName}}</strong> arrived from the {{formLabel}}.</p><p>Open the project in Agency OS to see it.</p>',
   'A new request for {{projectName}} arrived from the {{formLabel}}. Open the project in Agency OS to see it.',
   'New lead for {{projectName}} ({{formLabel}})',
   JSON_ARRAY('projectName','formLabel','actionUrl'), 1, 0, 1, 0, 0, NOW(3), NOW(3));
