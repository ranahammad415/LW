-- Content Map: WordPress sync, lifecycle + forecasting fields (idempotent, additive only).

SET @db := DATABASE();

-- ── contentmapnode: additive columns ─────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'source');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT ''PLANNED''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'lifecycle');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `lifecycle` VARCHAR(20) NOT NULL DEFAULT ''PLANNED''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'wpPageId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `wpPageId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'wpContentReviewId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `wpContentReviewId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'url');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `url` VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'pathDepth');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `pathDepth` INT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'plannedPublishDate');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `plannedPublishDate` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'publishedAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `publishedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'workCycleId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `workCycleId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'assigneeId');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `assigneeId` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'keywords');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `keywords` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'metrics');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `metrics` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND COLUMN_NAME = 'metricsAt');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contentmapnode` ADD COLUMN `metricsAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing rows already flagged live keep their meaning under the new lifecycle field.
UPDATE `contentmapnode` SET `lifecycle` = 'LIVE' WHERE `isLive` = 1 AND `lifecycle` = 'PLANNED';

-- ── contentmapnode: indexes ──────────────────────────────────────────────────
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND INDEX_NAME = 'contentmapnode_mapId_lifecycle_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `contentmapnode_mapId_lifecycle_idx` ON `contentmapnode`(`mapId`, `lifecycle`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND INDEX_NAME = 'contentmapnode_mapId_plannedPublishDate_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `contentmapnode_mapId_plannedPublishDate_idx` ON `contentmapnode`(`mapId`, `plannedPublishDate`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'contentmapnode' AND INDEX_NAME = 'contentmapnode_wpPageId_idx');
SET @sql := IF(@idx = 0,
  'CREATE INDEX `contentmapnode_wpPageId_idx` ON `contentmapnode`(`wpPageId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── contentmapnode: new FKs ──────────────────────────────────────────────────
SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_wpPageId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_wpPageId_fkey` FOREIGN KEY (`wpPageId`) REFERENCES `wppage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_wpContentReviewId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_wpContentReviewId_fkey` FOREIGN KEY (`wpContentReviewId`) REFERENCES `wpcontentreview`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_workCycleId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_workCycleId_fkey` FOREIGN KEY (`workCycleId`) REFERENCES `workcycle`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_assigneeId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── contentmapsync ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `contentmapsync` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `lastSyncAt` DATETIME(3) NULL,
  `lastSyncStats` JSON NULL,
  `includePostTypes` JSON NULL,
  `autoAdopt` BOOLEAN NOT NULL DEFAULT false,
  `firstImportAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `contentmapsync_mapId_key`(`mapId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapsync'
    AND CONSTRAINT_NAME = 'contentmapsync_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapsync` ADD CONSTRAINT `contentmapsync_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── contentmapdrift ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `contentmapdrift` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `nodeId` VARCHAR(191) NULL,
  `wpPageId` VARCHAR(191) NULL,
  `driftType` VARCHAR(30) NOT NULL,
  `payload` JSON NULL,
  `confidence` DOUBLE NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `resolvedById` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `contentmapdrift_mapId_status_createdAt_idx`(`mapId`, `status`, `createdAt`),
  INDEX `contentmapdrift_mapId_driftType_idx`(`mapId`, `driftType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapdrift'
    AND CONSTRAINT_NAME = 'contentmapdrift_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapdrift` ADD CONSTRAINT `contentmapdrift_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapdrift'
    AND CONSTRAINT_NAME = 'contentmapdrift_nodeId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapdrift` ADD CONSTRAINT `contentmapdrift_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `contentmapnode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapdrift'
    AND CONSTRAINT_NAME = 'contentmapdrift_wpPageId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapdrift` ADD CONSTRAINT `contentmapdrift_wpPageId_fkey` FOREIGN KEY (`wpPageId`) REFERENCES `wppage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapdrift'
    AND CONSTRAINT_NAME = 'contentmapdrift_resolvedById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapdrift` ADD CONSTRAINT `contentmapdrift_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Notification templates for sync events ───────────────────────────────────
INSERT INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`,
   `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'content_map_node_published', 'Content Map Node Published', 'When a planned content map node goes live on the site', 'content_map',
   '[Published] {{nodeName}} is live — {{projectName}}',
   '<p><strong>{{nodeName}}</strong> is now live on the site for project <strong>{{projectName}}</strong>.</p><p><a href="{{pageUrl}}">{{pageUrl}}</a></p>',
   '{{nodeName}} is now live on the site for project "{{projectName}}": {{pageUrl}}',
   '[{{projectName}}] {{nodeName}} is now live',
   JSON_ARRAY('mapName', 'projectName', 'nodeName', 'pageUrl', 'actionUrl'), 1, 1, 1, 1, 0, NOW(3), NOW(3)),
  (UUID(), 'content_map_site_drift', 'Content Map Site Changes', 'When the site sync finds content changes needing PM review', 'content_map',
   '[Review] {{driftCount}} site changes to review — {{projectName}}',
   '<p>The latest site sync found <strong>{{driftCount}}</strong> change(s) on <strong>{{projectName}}</strong> that are not reflected in the content map.</p>',
   'The latest site sync found {{driftCount}} change(s) on "{{projectName}}" that are not reflected in the content map.',
   '[{{projectName}}] {{driftCount}} site changes to review',
   JSON_ARRAY('mapName', 'projectName', 'driftCount', 'actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'content_map_node_overdue', 'Content Map Node Overdue', 'When a planned content node passes its expected publish date', 'content_map',
   '[Overdue] {{nodeName}} missed its publish date — {{projectName}}',
   '<p><strong>{{nodeName}}</strong> was expected to publish on {{plannedDate}} for <strong>{{projectName}}</strong> and is still not live.</p>',
   '{{nodeName}} was expected to publish on {{plannedDate}} for "{{projectName}}" and is still not live.',
   '[{{projectName}}] {{nodeName}} is overdue',
   JSON_ARRAY('mapName', 'projectName', 'nodeName', 'plannedDate', 'actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `description` = VALUES(`description`),
  `subject` = VALUES(`subject`),
  `bodyHtml` = VALUES(`bodyHtml`),
  `bodyText` = VALUES(`bodyText`),
  `inAppMessage` = VALUES(`inAppMessage`),
  `isActive` = 1,
  `updatedAt` = NOW(3);
