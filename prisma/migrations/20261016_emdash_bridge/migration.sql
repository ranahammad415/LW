-- EmDash bridge Phase 1 (contract agency-os-bridge/v1; docs/ledger/emdash-bridge.md).
-- Idempotent and additive only: every column is guarded by an information_schema
-- check, every table uses CREATE TABLE IF NOT EXISTS, every index is guarded by an
-- information_schema.STATISTICS check. Nothing is dropped, renamed or retyped.
-- WordPress projects keep cmsType = 'WORDPRESS' (the default) and are unaffected.

SET @db := DATABASE();

-- ── project: CMS bridge columns ─────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsType');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsType` ENUM(''WORDPRESS'', ''EMDASH'') NOT NULL DEFAULT ''WORDPRESS''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsSiteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsSiteId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsKeyId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsKeyId` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsContractVersion');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsContractVersion` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsPluginVersion');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsPluginVersion` VARCHAR(32) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsCapabilities');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsCapabilities` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsHealth');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsHealth` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsPairedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsPairedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsLastSeenAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsLastSeenAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsLastCursor');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsLastCursor` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsLostNotifiedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsLostNotifiedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsRepairNeededAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsRepairNeededAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsRepairReason');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsRepairReason` VARCHAR(300) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND INDEX_NAME = 'project_cmsSiteId_key');
SET @sql := IF(@idx = 0,
  'CREATE UNIQUE INDEX `project_cmsSiteId_key` ON `project`(`cmsSiteId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── wppage: EmDash entry columns ────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsEntryId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsEntryId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsCollection');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsCollection` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsDraftRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsDraftRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsLiveRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsLiveRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND COLUMN_NAME = 'cmsEditUrl');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppage` ADD COLUMN `cmsEditUrl` VARCHAR(1000) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppage' AND INDEX_NAME = 'wppage_projectId_cmsEntryId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `wppage_projectId_cmsEntryId_idx` ON `wppage`(`projectId`, `cmsEntryId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── wppagesnapshot ──────────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wppagesnapshot' AND COLUMN_NAME = 'cmsRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wppagesnapshot` ADD COLUMN `cmsRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── wpcontentreview: EmDash review columns ──────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsReviewId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsReviewId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsEntryId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsEntryId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsRevisionId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsRevisionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsSeq');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsSeq` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsEditUrl');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsEditUrl` VARCHAR(1000) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsLinks');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsLinks` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND INDEX_NAME = 'wpcontentreview_projectId_cmsReviewId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `wpcontentreview_projectId_cmsReviewId_idx` ON `wpcontentreview`(`projectId`, `cmsReviewId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreview' AND COLUMN_NAME = 'cmsMirrorSeq');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreview` ADD COLUMN `cmsMirrorSeq` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── wpcontentreviewevent ────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'wpcontentreviewevent' AND COLUMN_NAME = 'cmsSeq');
SET @sql := IF(@col = 0,
  'ALTER TABLE `wpcontentreviewevent` ADD COLUMN `cmsSeq` INTEGER NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── New tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cmscredential` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `keyId` INTEGER NOT NULL,
  `inboundKeyEnc` TEXT NOT NULL,
  `outboundKeyEnc` TEXT NOT NULL,
  `prevKeyId` INTEGER NULL,
  `inboundKeyPrevEnc` TEXT NULL,
  `outboundKeyPrevEnc` TEXT NULL,
  `prevExpiresAt` DATETIME(3) NULL,
  `pendingKeyId` INTEGER NULL,
  `inboundKeyPendingEnc` TEXT NULL,
  `outboundKeyPendingEnc` TEXT NULL,
  `pendingCreatedAt` DATETIME(3) NULL,
  `rotatedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmscredential_projectId_key`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmscredential_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmspairingcode` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `siteId` VARCHAR(64) NOT NULL,
  `siteUrl` VARCHAR(500) NULL,
  `verifier` VARCHAR(64) NOT NULL,
  `signingKeyEnc` TEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `failedAttempts` INTEGER NOT NULL DEFAULT 0,
  `usedAt` DATETIME(3) NULL,
  `burnedAt` DATETIME(3) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cmspairingcode_verifier_key`(`verifier`),
  INDEX `cmspairingcode_siteId_idx`(`siteId`),
  INDEX `cmspairingcode_projectId_idx`(`projectId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmspairingcode_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmseventreceipt` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `eventId` VARCHAR(64) NOT NULL,
  `siteId` VARCHAR(64) NULL,
  `type` VARCHAR(64) NOT NULL,
  `cursor` INTEGER NULL,
  `seq` INTEGER NULL,
  `cmsReviewId` VARCHAR(64) NULL,
  `outcome` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `cmseventreceipt_projectId_receivedAt_idx`(`projectId`, `receivedAt`),
  UNIQUE INDEX `cmseventreceipt_projectId_eventId_key`(`projectId`, `eventId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cmseventreceipt_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cmsnonce` (
  `id` VARCHAR(191) NOT NULL,
  `siteId` VARCHAR(64) NOT NULL,
  `nonce` VARCHAR(128) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  INDEX `cmsnonce_expiresAt_idx`(`expiresAt`),
  UNIQUE INDEX `cmsnonce_siteId_nonce_key`(`siteId`, `nonce`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Columns/indexes added after the tables above were first written (keeps re-runs idempotent).
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'project' AND COLUMN_NAME = 'cmsDisconnectedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `project` ADD COLUMN `cmsDisconnectedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmseventreceipt' AND COLUMN_NAME = 'siteId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmseventreceipt` ADD COLUMN `siteId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmspairingcode' AND COLUMN_NAME = 'siteUrl');
SET @sql := IF(@col = 0,
  'ALTER TABLE `cmspairingcode` ADD COLUMN `siteUrl` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmseventreceipt' AND INDEX_NAME = 'cmseventreceipt_projectId_siteId_cursor_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `cmseventreceipt_projectId_siteId_cursor_idx` ON `cmseventreceipt`(`projectId`, `siteId`, `cursor`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'cmseventreceipt' AND INDEX_NAME = 'cmseventreceipt_projectId_cmsReviewId_seq_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `cmseventreceipt_projectId_cmsReviewId_seq_idx` ON `cmseventreceipt`(`projectId`, `cmsReviewId`, `seq`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Notification template: cms_connection_lost (OWNERs; contract §4) ───────
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'cms_connection_lost', 'Site Connection Lost', 'An EmDash site has not checked in with Agency OS for 24 hours', 'pipeline',
   'Site connection lost: {{projectName}}',
   '<p>The EmDash site for <strong>{{projectName}}</strong> has not contacted Agency OS since {{lastSeenAt}}. Content review updates from that site are not arriving. Check that the site is up and that the Agency OS bridge plugin is active and paired.</p>',
   'The EmDash site for {{projectName}} has not contacted Agency OS since {{lastSeenAt}}. Check that the site is up and the Agency OS bridge plugin is active and paired.',
   'Site connection lost: {{projectName}} (last seen {{lastSeenAt}})',
   JSON_ARRAY('projectName','lastSeenAt','actionUrl'), 1, 1, 0, 0, 0, NOW(3), NOW(3));

-- ── Notification template: cms_repair_needed (OWNERs; contract v1.0.2 C1) ──
INSERT IGNORE INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`, `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'cms_repair_needed', 'Site Needs Re-pairing', 'An EmDash site must be paired again (counters went backwards, or it rejected Agency OS keys)', 'pipeline',
   'Re-pair needed: {{projectName}}',
   '<p>The EmDash site for <strong>{{projectName}}</strong> needs to be paired again: {{reason}}. Agency OS stops syncing it until it is re-paired from the Website tab (use "Re-pair as a new site" only when the site lost its plugin data).</p>',
   'The EmDash site for {{projectName}} needs to be paired again: {{reason}}. Re-pair it from the Website tab.',
   'Re-pair needed: {{projectName}}',
   JSON_ARRAY('projectName','reason','actionUrl'), 1, 1, 0, 0, 0, NOW(3), NOW(3));
