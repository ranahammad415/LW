-- Backlinks Hub: purchasable backlink catalog, client carts and order fulfilment (idempotent).

CREATE TABLE IF NOT EXISTS `backlinksite` (
  `id` VARCHAR(191) NOT NULL,
  `domain` VARCHAR(255) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `da` INT NOT NULL DEFAULT 0,
  `dr` INT NOT NULL DEFAULT 0,
  `monthlyTraffic` INT NOT NULL DEFAULT 0,
  `priceUsd` DECIMAL(10, 2) NOT NULL,
  `valueScore` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `dofollowLinks` INT NOT NULL DEFAULT 1,
  `placementType` ENUM('GUEST_POST', 'PROFILE') NOT NULL DEFAULT 'GUEST_POST',
  `category` VARCHAR(100) NULL,
  `country` VARCHAR(100) NULL,
  `language` VARCHAR(100) NULL,
  `turnaroundDays` INT NULL,
  `sampleUrl` VARCHAR(500) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `isFeatured` BOOLEAN NOT NULL DEFAULT false,
  `tags` JSON NULL,
  `internalNotes` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `backlinksite_domain_key`(`domain`),
  INDEX `backlinksite_isActive_valueScore_idx`(`isActive`, `valueScore`),
  INDEX `backlinksite_isActive_priceUsd_idx`(`isActive`, `priceUsd`),
  INDEX `backlinksite_isActive_da_idx`(`isActive`, `da`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backlinkcartitem` (
  `id` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `backlinkSiteId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `targetType` ENUM('PAGE', 'DOMAIN') NOT NULL DEFAULT 'DOMAIN',
  `wpPageId` VARCHAR(191) NULL,
  `targetUrl` VARCHAR(500) NULL,
  `anchorText` VARCHAR(255) NULL,
  `notes` LONGTEXT NULL,
  `unitPriceUsd` DECIMAL(10, 2) NOT NULL,
  `addedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `backlinkcartitem_clientId_backlinkSiteId_wpPageId_key`(`clientId`, `backlinkSiteId`, `wpPageId`),
  INDEX `backlinkcartitem_clientId_idx`(`clientId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backlinkorder` (
  `id` VARCHAR(191) NOT NULL,
  `orderNumber` VARCHAR(30) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_REVIEW',
  `subtotalUsd` DECIMAL(10, 2) NOT NULL,
  `totalUsd` DECIMAL(10, 2) NOT NULL,
  `itemCount` INT NOT NULL DEFAULT 0,
  `paymentStatus` VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
  `requestedById` VARCHAR(191) NULL,
  `clientNotes` LONGTEXT NULL,
  `adminNotes` LONGTEXT NULL,
  `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `approvedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `backlinkorder_orderNumber_key`(`orderNumber`),
  INDEX `backlinkorder_clientId_status_idx`(`clientId`, `status`),
  INDEX `backlinkorder_status_submittedAt_idx`(`status`, `submittedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backlinkorderitem` (
  `id` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `backlinkSiteId` VARCHAR(191) NULL,
  `domainSnapshot` VARCHAR(255) NOT NULL,
  `daSnapshot` INT NOT NULL DEFAULT 0,
  `drSnapshot` INT NOT NULL DEFAULT 0,
  `trafficSnapshot` INT NOT NULL DEFAULT 0,
  `unitPriceUsd` DECIMAL(10, 2) NOT NULL,
  `dofollowLinks` INT NOT NULL DEFAULT 1,
  `placementType` ENUM('GUEST_POST', 'PROFILE') NOT NULL DEFAULT 'GUEST_POST',
  `projectId` VARCHAR(191) NULL,
  `targetType` ENUM('PAGE', 'DOMAIN') NOT NULL DEFAULT 'DOMAIN',
  `wpPageId` VARCHAR(191) NULL,
  `targetUrl` VARCHAR(500) NULL,
  `anchorText` VARCHAR(255) NULL,
  `notes` LONGTEXT NULL,
  `status` ENUM('PENDING', 'IN_PROGRESS', 'LIVE', 'REPLACED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  `liveUrl` VARCHAR(500) NULL,
  `publishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `backlinkorderitem_orderId_idx`(`orderId`),
  INDEX `backlinkorderitem_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backlinkorderevent` (
  `id` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NULL,
  `eventType` VARCHAR(50) NOT NULL,
  `fromStatus` VARCHAR(30) NULL,
  `toStatus` VARCHAR(30) NULL,
  `note` VARCHAR(1000) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `backlinkorderevent_orderId_createdAt_idx`(`orderId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db := DATABASE();

-- backlinkcartitem FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkcartitem'
    AND CONSTRAINT_NAME = 'backlinkcartitem_clientId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkcartitem` ADD CONSTRAINT `backlinkcartitem_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clientaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkcartitem'
    AND CONSTRAINT_NAME = 'backlinkcartitem_backlinkSiteId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkcartitem` ADD CONSTRAINT `backlinkcartitem_backlinkSiteId_fkey` FOREIGN KEY (`backlinkSiteId`) REFERENCES `backlinksite`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkcartitem'
    AND CONSTRAINT_NAME = 'backlinkcartitem_projectId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkcartitem` ADD CONSTRAINT `backlinkcartitem_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkcartitem'
    AND CONSTRAINT_NAME = 'backlinkcartitem_wpPageId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkcartitem` ADD CONSTRAINT `backlinkcartitem_wpPageId_fkey` FOREIGN KEY (`wpPageId`) REFERENCES `wppage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkcartitem'
    AND CONSTRAINT_NAME = 'backlinkcartitem_addedById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkcartitem` ADD CONSTRAINT `backlinkcartitem_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- backlinkorder FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorder'
    AND CONSTRAINT_NAME = 'backlinkorder_clientId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorder` ADD CONSTRAINT `backlinkorder_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clientaccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorder'
    AND CONSTRAINT_NAME = 'backlinkorder_requestedById_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorder` ADD CONSTRAINT `backlinkorder_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- backlinkorderitem FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderitem'
    AND CONSTRAINT_NAME = 'backlinkorderitem_orderId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderitem` ADD CONSTRAINT `backlinkorderitem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `backlinkorder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderitem'
    AND CONSTRAINT_NAME = 'backlinkorderitem_backlinkSiteId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderitem` ADD CONSTRAINT `backlinkorderitem_backlinkSiteId_fkey` FOREIGN KEY (`backlinkSiteId`) REFERENCES `backlinksite`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderitem'
    AND CONSTRAINT_NAME = 'backlinkorderitem_projectId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderitem` ADD CONSTRAINT `backlinkorderitem_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderitem'
    AND CONSTRAINT_NAME = 'backlinkorderitem_wpPageId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderitem` ADD CONSTRAINT `backlinkorderitem_wpPageId_fkey` FOREIGN KEY (`wpPageId`) REFERENCES `wppage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- backlinkorderevent FKs
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderevent'
    AND CONSTRAINT_NAME = 'backlinkorderevent_orderId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderevent` ADD CONSTRAINT `backlinkorderevent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `backlinkorder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'backlinkorderevent'
    AND CONSTRAINT_NAME = 'backlinkorderevent_actorId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `backlinkorderevent` ADD CONSTRAINT `backlinkorderevent_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Enable the backlinksHub modality for the agency owner and clients only
INSERT INTO `modality_config` (`id`, `featureKey`, `role`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'backlinksHub', 'OWNER', 1, NOW(3), NOW(3)),
  (UUID(), 'backlinksHub', 'PM', 0, NOW(3), NOW(3)),
  (UUID(), 'backlinksHub', 'TEAM_MEMBER', 0, NOW(3), NOW(3)),
  (UUID(), 'backlinksHub', 'CONTRACTOR', 0, NOW(3), NOW(3)),
  (UUID(), 'backlinksHub', 'CLIENT', 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE `updatedAt` = NOW(3);

-- Notification templates for backlink order lifecycle
INSERT INTO `notificationtemplate`
  (`id`, `slug`, `name`, `description`, `category`, `subject`, `bodyHtml`, `bodyText`, `inAppMessage`, `variables`, `isActive`,
   `emailAgencyOwner`, `emailPm`, `emailClientManager`, `emailClientViewer`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'backlink_order_submitted', 'Backlink Order Submitted', 'When a client submits a backlink purchase request', 'backlinks',
   '[New Request] Backlink order {{orderNumber}} — {{clientName}}',
   '<p><strong>{{clientName}}</strong> submitted backlink order <strong>{{orderNumber}}</strong> with {{itemCount}} link(s) totalling {{totalUsd}}.</p>',
   '{{clientName}} submitted backlink order {{orderNumber}} with {{itemCount}} link(s) totalling {{totalUsd}}.',
   'New backlink order {{orderNumber}} from {{clientName}} ({{itemCount}} links, {{totalUsd}})',
   JSON_ARRAY('orderNumber', 'clientName', 'itemCount', 'totalUsd', 'actionUrl'), 1, 1, 1, 0, 0, NOW(3), NOW(3)),
  (UUID(), 'backlink_order_approved', 'Backlink Order Approved', 'When the agency approves a backlink order', 'backlinks',
   '[Approved] Backlink order {{orderNumber}}',
   '<p>Your backlink order <strong>{{orderNumber}}</strong> has been approved and is now being placed. We will update each link as it goes live.</p>',
   'Your backlink order {{orderNumber}} has been approved and is now being placed.',
   'Backlink order {{orderNumber}} approved — placement has started',
   JSON_ARRAY('orderNumber', 'itemCount', 'totalUsd', 'actionUrl'), 1, 1, 1, 1, 1, NOW(3), NOW(3)),
  (UUID(), 'backlink_order_rejected', 'Backlink Order Declined', 'When the agency declines a backlink order', 'backlinks',
   '[Declined] Backlink order {{orderNumber}}',
   '<p>Your backlink order <strong>{{orderNumber}}</strong> could not be processed.</p><p>{{reason}}</p>',
   'Your backlink order {{orderNumber}} could not be processed. {{reason}}',
   'Backlink order {{orderNumber}} was declined',
   JSON_ARRAY('orderNumber', 'reason', 'actionUrl'), 1, 1, 1, 1, 0, NOW(3), NOW(3)),
  (UUID(), 'backlink_item_live', 'Backlink Is Live', 'When an individual backlink goes live', 'backlinks',
   'Backlink live on {{domain}} — order {{orderNumber}}',
   '<p>Your backlink on <strong>{{domain}}</strong> is now live.</p><p><a href="{{liveUrl}}">{{liveUrl}}</a></p>',
   'Your backlink on {{domain}} is now live: {{liveUrl}}',
   'Backlink live on {{domain}}',
   JSON_ARRAY('orderNumber', 'domain', 'liveUrl', 'targetLabel', 'actionUrl'), 1, 0, 0, 1, 1, NOW(3), NOW(3)),
  (UUID(), 'backlink_order_completed', 'Backlink Order Completed', 'When every link in a backlink order is live', 'backlinks',
   '[Completed] Backlink order {{orderNumber}}',
   '<p>All {{itemCount}} link(s) in backlink order <strong>{{orderNumber}}</strong> are now live.</p>',
   'All {{itemCount}} link(s) in backlink order {{orderNumber}} are now live.',
   'Backlink order {{orderNumber}} completed — all {{itemCount}} links live',
   JSON_ARRAY('orderNumber', 'itemCount', 'actionUrl'), 1, 1, 1, 1, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `description` = VALUES(`description`),
  `subject` = VALUES(`subject`),
  `bodyHtml` = VALUES(`bodyHtml`),
  `bodyText` = VALUES(`bodyText`),
  `inAppMessage` = VALUES(`inAppMessage`),
  `isActive` = 1,
  `updatedAt` = NOW(3);
