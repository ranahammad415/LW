-- Content Map / Topical Map planner (idempotent).

CREATE TABLE IF NOT EXISTS `contentmap` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NOT NULL DEFAULT 'Content Map',
  `status` VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  `clientVisible` BOOLEAN NOT NULL DEFAULT false,
  `clientDecision` VARCHAR(50) NULL,
  `clientDecisionAt` DATETIME(3) NULL,
  `clientDecisionById` VARCHAR(191) NULL,
  `sections` JSON NULL,
  `settings` JSON NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `contentmap_projectId_idx`(`projectId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contentmapnode` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `parentId` VARCHAR(191) NULL,
  `kind` VARCHAR(20) NOT NULL,
  `name` VARCHAR(500) NOT NULL,
  `slug` VARCHAR(500) NULL,
  `priority` VARCHAR(10) NULL,
  `contentType` VARCHAR(100) NULL,
  `intent` VARCHAR(100) NULL,
  `accent` VARCHAR(50) NULL,
  `note` LONGTEXT NULL,
  `todo` LONGTEXT NULL,
  `links` JSON NULL,
  `isLive` BOOLEAN NOT NULL DEFAULT false,
  `needsFix` BOOLEAN NOT NULL DEFAULT false,
  `isSupport` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INT NOT NULL DEFAULT 0,
  `posX` DOUBLE NULL,
  `posY` DOUBLE NULL,
  `collapsed` BOOLEAN NOT NULL DEFAULT false,
  `nodeStatus` VARCHAR(50) NULL,
  `pmDecision` VARCHAR(50) NULL,
  `clientDecision` VARCHAR(50) NULL,
  `sitemapNodeId` VARCHAR(191) NULL,
  `taskId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `contentmapnode_mapId_parentId_sortOrder_idx`(`mapId`, `parentId`, `sortOrder`),
  INDEX `contentmapnode_mapId_slug_idx`(`mapId`, `slug`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contentmapcomment` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `nodeId` VARCHAR(191) NULL,
  `userId` VARCHAR(191) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `parentId` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `resolvedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `contentmapcomment_mapId_nodeId_createdAt_idx`(`mapId`, `nodeId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contentmapevent` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `nodeId` VARCHAR(191) NULL,
  `userId` VARCHAR(191) NULL,
  `eventType` VARCHAR(100) NOT NULL,
  `message` VARCHAR(500) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `contentmapevent_mapId_createdAt_idx`(`mapId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contentmapversion` (
  `id` VARCHAR(191) NOT NULL,
  `mapId` VARCHAR(191) NOT NULL,
  `versionNumber` INT NOT NULL DEFAULT 1,
  `snapshot` JSON NOT NULL,
  `authorId` VARCHAR(191) NULL,
  `changeSummary` VARCHAR(500) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `contentmapversion_mapId_versionNumber_idx`(`mapId`, `versionNumber`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db := DATABASE();

-- contentmap FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmap'
    AND CONSTRAINT_NAME = 'contentmap_projectId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmap` ADD CONSTRAINT `contentmap_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmap'
    AND CONSTRAINT_NAME = 'contentmap_createdById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmap` ADD CONSTRAINT `contentmap_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmap'
    AND CONSTRAINT_NAME = 'contentmap_clientDecisionById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmap` ADD CONSTRAINT `contentmap_clientDecisionById_fkey` FOREIGN KEY (`clientDecisionById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- contentmapnode FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_parentId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `contentmapnode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_sitemapNodeId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_sitemapNodeId_fkey` FOREIGN KEY (`sitemapNodeId`) REFERENCES `sitemapnode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapnode'
    AND CONSTRAINT_NAME = 'contentmapnode_taskId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapnode` ADD CONSTRAINT `contentmapnode_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- contentmapcomment FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapcomment'
    AND CONSTRAINT_NAME = 'contentmapcomment_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapcomment` ADD CONSTRAINT `contentmapcomment_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapcomment'
    AND CONSTRAINT_NAME = 'contentmapcomment_nodeId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapcomment` ADD CONSTRAINT `contentmapcomment_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `contentmapnode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapcomment'
    AND CONSTRAINT_NAME = 'contentmapcomment_userId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapcomment` ADD CONSTRAINT `contentmapcomment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapcomment'
    AND CONSTRAINT_NAME = 'contentmapcomment_parentId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapcomment` ADD CONSTRAINT `contentmapcomment_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `contentmapcomment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapcomment'
    AND CONSTRAINT_NAME = 'contentmapcomment_resolvedById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapcomment` ADD CONSTRAINT `contentmapcomment_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- contentmapevent FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapevent'
    AND CONSTRAINT_NAME = 'contentmapevent_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapevent` ADD CONSTRAINT `contentmapevent_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapevent'
    AND CONSTRAINT_NAME = 'contentmapevent_nodeId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapevent` ADD CONSTRAINT `contentmapevent_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `contentmapnode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapevent'
    AND CONSTRAINT_NAME = 'contentmapevent_userId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapevent` ADD CONSTRAINT `contentmapevent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- contentmapversion FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapversion'
    AND CONSTRAINT_NAME = 'contentmapversion_mapId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapversion` ADD CONSTRAINT `contentmapversion_mapId_fkey` FOREIGN KEY (`mapId`) REFERENCES `contentmap`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'contentmapversion'
    AND CONSTRAINT_NAME = 'contentmapversion_authorId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `contentmapversion` ADD CONSTRAINT `contentmapversion_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Enable contentMap modality for all portal roles
INSERT INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'contentMap', 'OWNER', 1, NOW(3), NOW(3)),
  (UUID(), 'contentMap', 'PM', 1, NOW(3), NOW(3)),
  (UUID(), 'contentMap', 'TEAM_MEMBER', 1, NOW(3), NOW(3)),
  (UUID(), 'contentMap', 'CONTRACTOR', 1, NOW(3), NOW(3)),
  (UUID(), 'contentMap', 'CLIENT', 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `enabled` = 1, `updatedAt` = NOW(3);

-- Notification templates for content map
INSERT INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`,
   `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'content_map_submitted', 'Content Map Submitted', 'When a content map is submitted for client review', 'content_map',
   '[Review Needed] Content map ready — {{projectName}}',
   '<p>The content map <strong>{{mapName}}</strong> for project <strong>{{projectName}}</strong> is ready for your review.</p>',
   'The content map "{{mapName}}" for project "{{projectName}}" is ready for your review.',
   '[{{projectName}}] Content map ready for review',
   JSON_ARRAY('mapName', 'projectName', 'actionUrl'), 1, 1, 1, 1, 1, NOW(3), NOW(3)),
  (UUID(), 'content_map_comment_added', 'Content Map Comment', 'When a comment is added on a content map', 'content_map',
   'New comment on content map — {{projectName}}',
   '<p><strong>{{authorName}}</strong> commented on the content map in project <strong>{{projectName}}</strong>.</p><p>{{commentPreview}}</p>',
   '{{authorName}} commented on the content map in project "{{projectName}}": {{commentPreview}}',
   '[{{projectName}}] New content map comment from {{authorName}}',
   JSON_ARRAY('mapName', 'projectName', 'authorName', 'commentPreview', 'nodeName', 'actionUrl'), 1, 1, 1, 1, 0, NOW(3), NOW(3)),
  (UUID(), 'content_map_client_approved', 'Content Map Approved', 'When the client approves the content map', 'content_map',
   '[Approved] Content map — {{projectName}}',
   '<p>The client approved the content map <strong>{{mapName}}</strong> for project <strong>{{projectName}}</strong>.</p>',
   'The client approved the content map "{{mapName}}" for project "{{projectName}}".',
   '[{{projectName}}] Content map approved by client',
   JSON_ARRAY('mapName', 'projectName', 'actionUrl'), 1, 1, 1, 1, 0, NOW(3), NOW(3)),
  (UUID(), 'content_map_changes_requested', 'Content Map Changes Requested', 'When the client requests changes on the content map', 'content_map',
   '[Changes Requested] Content map — {{projectName}}',
   '<p>The client requested changes on the content map <strong>{{mapName}}</strong> for project <strong>{{projectName}}</strong>.</p><p>{{commentPreview}}</p>',
   'The client requested changes on the content map "{{mapName}}" for project "{{projectName}}": {{commentPreview}}',
   '[{{projectName}}] Client requested content map changes',
   JSON_ARRAY('mapName', 'projectName', 'commentPreview', 'nodeName', 'actionUrl'), 1, 1, 1, 1, 0, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `description` = VALUES(`description`),
  `subject` = VALUES(`subject`),
  `bodyHtml` = VALUES(`bodyHtml`),
  `bodyText` = VALUES(`bodyText`),
  `inAppMessage` = VALUES(`inAppMessage`),
  `isActive` = 1,
  `updatedAt` = NOW(3);
