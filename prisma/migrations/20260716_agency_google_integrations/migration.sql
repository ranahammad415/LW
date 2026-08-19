-- Agency Google connection + per-project analytics bindings + metric tables

CREATE TABLE IF NOT EXISTS `agencygoogleconnection` (
    `id` VARCHAR(191) NOT NULL,
    `googleEmail` VARCHAR(255) NOT NULL,
    `refreshTokenEnc` TEXT NOT NULL,
    `scopes` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `connectedById` VARCHAR(191) NULL,
    `connectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` VARCHAR(500) NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `project` ADD COLUMN `ga4PropertyId` VARCHAR(100) NULL;
ALTER TABLE `project` ADD COLUMN `ga4PropertyName` VARCHAR(255) NULL;
ALTER TABLE `project` ADD COLUMN `ga4LastSyncedAt` DATETIME(3) NULL;
ALTER TABLE `project` ADD COLUMN `gmbAccountId` VARCHAR(100) NULL;
ALTER TABLE `project` ADD COLUMN `gmbLocationId` VARCHAR(200) NULL;
ALTER TABLE `project` ADD COLUMN `gmbLocationName` VARCHAR(255) NULL;
ALTER TABLE `project` ADD COLUMN `gmbLastSyncedAt` DATETIME(3) NULL;
ALTER TABLE `project` ADD COLUMN `dataforseoDomain` VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS `gscquerymetric` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `query` VARCHAR(500) NOT NULL,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `impressions` INTEGER NOT NULL DEFAULT 0,
    `ctr` DOUBLE NOT NULL DEFAULT 0,
    `position` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `gscquerymetric_projectId_date_query_key`(`projectId`, `date`, `query`),
    INDEX `gscquerymetric_projectId_date_idx`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ga4dailymetric` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `sessions` INTEGER NOT NULL DEFAULT 0,
    `totalUsers` INTEGER NOT NULL DEFAULT 0,
    `bounceRate` DOUBLE NOT NULL DEFAULT 0,
    `avgEngagementSec` DOUBLE NOT NULL DEFAULT 0,
    `conversions` INTEGER NOT NULL DEFAULT 0,
    `conversionRate` DOUBLE NOT NULL DEFAULT 0,
    `pageViews` INTEGER NOT NULL DEFAULT 0,
    `breakdowns` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `ga4dailymetric_projectId_date_key`(`projectId`, `date`),
    INDEX `ga4dailymetric_projectId_date_idx`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `gmbdailymetric` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `impressions` INTEGER NOT NULL DEFAULT 0,
    `impressionsSearch` INTEGER NOT NULL DEFAULT 0,
    `impressionsMaps` INTEGER NOT NULL DEFAULT 0,
    `websiteClicks` INTEGER NOT NULL DEFAULT 0,
    `directions` INTEGER NOT NULL DEFAULT 0,
    `calls` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `gmbdailymetric_projectId_date_key`(`projectId`, `date`),
    INDEX `gmbdailymetric_projectId_date_idx`(`projectId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `gmbreview` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(200) NOT NULL,
    `reviewerName` VARCHAR(255) NULL,
    `starRating` INTEGER NOT NULL,
    `comment` LONGTEXT NULL,
    `replyComment` LONGTEXT NULL,
    `createTime` DATETIME(3) NULL,
    `updateTime` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `gmbreview_projectId_reviewId_key`(`projectId`, `reviewId`),
    INDEX `gmbreview_projectId_createTime_idx`(`projectId`, `createTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
