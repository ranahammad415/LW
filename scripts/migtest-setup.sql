-- Builds a scratch schema that mirrors production *before* the content-map
-- WordPress sync migration, so 20260817_content_map_wp_sync can be replayed
-- against a table that genuinely lacks the new columns.
CREATE DATABASE IF NOT EXISTS migtest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE migtest;

-- Unchanged tables can be copied structurally from the synced schema.
CREATE TABLE IF NOT EXISTS `user` LIKE `u252567696_localwave2`.`user`;
CREATE TABLE IF NOT EXISTS `contentmap` LIKE `u252567696_localwave2`.`contentmap`;
CREATE TABLE IF NOT EXISTS `wppage` LIKE `u252567696_localwave2`.`wppage`;
CREATE TABLE IF NOT EXISTS `wpcontentreview` LIKE `u252567696_localwave2`.`wpcontentreview`;
CREATE TABLE IF NOT EXISTS `workcycle` LIKE `u252567696_localwave2`.`workcycle`;
CREATE TABLE IF NOT EXISTS `notificationtemplate` LIKE `u252567696_localwave2`.`notificationtemplate`;

-- contentmapnode as it existed before this migration: no source, lifecycle,
-- wpPageId, url, scheduling, assignee, keywords or metrics columns.
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
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `contentmapnode_mapId_parentId_sortOrder_idx`(`mapId`, `parentId`, `sortOrder`),
  INDEX `contentmapnode_mapId_slug_idx`(`mapId`, `slug`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A pre-existing row flagged live: the migration should backfill it to LIVE.
INSERT IGNORE INTO `contentmap` (`id`, `projectId`, `name`, `status`, `clientVisible`, `createdAt`, `updatedAt`)
VALUES ('migtest-map', 'migtest-project', 'Legacy Map', 'DRAFT', 0, NOW(3), NOW(3));
INSERT IGNORE INTO `contentmapnode` (`id`, `mapId`, `kind`, `name`, `isLive`, `createdAt`, `updatedAt`)
VALUES ('migtest-live', 'migtest-map', 'PAGE', 'Legacy Live Page', 1, NOW(3), NOW(3));
INSERT IGNORE INTO `contentmapnode` (`id`, `mapId`, `kind`, `name`, `isLive`, `createdAt`, `updatedAt`)
VALUES ('migtest-draft', 'migtest-map', 'PAGE', 'Legacy Draft Page', 0, NOW(3), NOW(3));
